import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TargetAdapter } from "../src/adapters/types.ts";
import { ConfigSchema } from "../src/config.ts";
import { commitAll, ensureRepo } from "../src/git.ts";
import { Ledger } from "../src/ledger/db.ts";
import { runCodeJob } from "../src/run/code-job.ts";

/** The code job's check: a model may not make it green by deleting the test that was red. */
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

describe("the code job", () => {
	async function job(worker: (dir: string) => string | Promise<string>, protectedGlobs: string[] = [], checkTree?: (dir: string, only?: string[]) => string[], wiringFiles: string[] = [], o: { main?: Record<string, string>; build?: { cmd: string; args: string[] }; boot?: { cmd: string; args: string[] }; ledger?: Ledger; whole?: boolean; checkConfigGlobs?: string[]; test?: (dir: string, files: string[]) => { cmd: string; args: string[] }; probeTest?: { path: string; content: string; failing?: string }; unitWork?: { unitId: string; apply: (wt: string) => Promise<boolean> }; forUnit?: string; waiting?: string[] } = {}) {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "br-code-job-")));
		const target = join(root, "new");
		mkdirSync(join(target, "src"), { recursive: true });
		writeFileSync(join(target, "src", "a.test.txt"), "expects ok\n");
		writeFileSync(join(target, "tsconfig.json"), "{}\n");
		for (const [f, text] of Object.entries(o.main ?? {})) mkdirSync(join(target, f, ".."), { recursive: true }), writeFileSync(join(target, f), text);
		await ensureRepo(target, "migration/main", []);
		await commitAll(target, "init");
		const config = ConfigSchema.parse({ source: { path: root, stack: "php" }, target: { path: target, stacks: ["fake"], git: { branch: "migration/main" } }, models: {} });
		const adapter = {
			id: "fake",
			protectedGlobs,
			...(o.checkConfigGlobs ? { checkConfigGlobs: o.checkConfigGlobs } : {}),
			...(o.probeTest ? { probeTest: () => o.probeTest } : {}),
			toolchain: { ignoredPaths: [] },
			generatedFiles: [],
			layout: { moduleDir: (a: string) => `src/features/${a}`, sharedDirs: ["src/shared/"], ignoreDirs: [], isTestFile: (p: string) => p.includes(".test."), sourceExtensions: [".txt"], checkTree, wiringFiles },
			build: () => o.build ?? { cmd: "true", args: [] },
			...(o.boot ? { boot: () => o.boot } : {}),
			test: (dir: string, files: string[]) => o.test?.(dir, files) ?? { cmd: "true", args: [] },
		} as unknown as TargetAdapter;
		let merged = false;
		let refused: string | undefined;
		let diff: string | undefined;
		let locked: { files: string[]; diff: string } | undefined;
		// what main gets: the worktree as the job leaves it
		let onMain: Record<string, string> = {};
		const said = await runCodeJob({
			config,
			root,
			ledger: o.ledger ?? new Ledger(":memory:"),
			adapter,
			what: "make the test pass",
			label: o.whole ? "build-fake-1" : "q1",
			whole: o.whole,
			forUnit: o.forUnit,
			waiting: o.waiting,
			linkAll: () => {},
			mergeFix: async (wt) => {
				merged = true;
				onMain = Object.fromEntries(git(wt, ["ls-files", "-mo", "--exclude-standard"]).split("\n").filter(Boolean).map((f) => [f, readFileSync(join(wt, f), "utf8")]));
				return undefined;
			},
			log: () => {},
			worker: async ({ dir }) => worker(dir),
			onRefused: (p, d) => ((refused = p), (diff = d)),
			onLocked: (l) => (locked = l),
			unitWork: o.unitWork,
		});
		return { said, merged, target, refused, diff, locked, onMain };
	}

	it("a deleted test fails the check: nothing is merged", async () => {
		const { said, merged, target } = await job((dir) => (rmSync(join(dir, "src", "a.test.txt")), "removed the failing test"));
		expect(said).toBeUndefined();
		expect(merged).toBe(false);
		expect(existsSync(join(target, "src", "a.test.txt"))).toBe(true);
		expect(git(target, ["status", "--porcelain"])).toBe("");
	});

	const code = (dir: string) => (writeFileSync(join(dir, "src", "b.txt"), "code\n"), writeFileSync(join(dir, "src", "b.test.txt"), "test\n"));
	it("a changed file that decides how the checks run is put back, the rest of the job is judged and merged; the caller gets the change", async () => {
		const r = await job((dir) => (code(dir), writeFileSync(join(dir, "tsconfig.json"), '{"strict":false}\n'), "added b"), ["**/tsconfig*.json"]);
		expect(r.merged).toBe(true);
		expect(r.onMain["src/b.txt"]).toBe("code\n");
		expect(r.onMain["tsconfig.json"]).toBeUndefined(); // put back: main keeps {}
		expect(r.locked?.files).toEqual(["tsconfig.json"]);
		expect(r.locked?.diff).toMatch(/strict":false/);
	});
	it("a job that changed only such files is refused, with the diff for the setup model", async () => {
		const r = await job((dir) => (writeFileSync(join(dir, "tsconfig.json"), '{"strict":false}\n'), "loosened tsconfig"), ["**/tsconfig*.json"]);
		expect(r.merged).toBe(false);
		expect(r.refused).toMatch(/^only files that decide how the checks run were changed/);
		expect(r.diff).toMatch(/strict":false/);
		expect(r.locked?.files).toEqual(["tsconfig.json"]);
	});
	it("a protected wiring file (bundle list, route table) may change: a new feature folder is registered there", async () => {
		const wire = (dir: string) => (code(dir), mkdirSync(join(dir, "config"), { recursive: true }), writeFileSync(join(dir, "config", "bundles.txt"), "B\n"), "added b");
		expect((await job(wire, ["config/**"], undefined, ["config/bundles.txt"])).onMain["config/bundles.txt"]).toBe("B\n");
		// an older manifest (no checkConfigGlobs): every protected file is locked, it is put back
		const r = await job(wire, ["config/**"]);
		expect(r.onMain["config/bundles.txt"]).toBeUndefined();
		expect(r.locked?.files).toEqual(["config/bundles.txt"]);
	});
	describe("app config (protected, but not what decides how the checks run)", () => {
		// the test command fails a file with WRONG in it, unless config/skip exists (an app config that turns the checks off)
		const test = (_dir: string, files: string[]) => ({ cmd: "sh", args: ["-c", 'test -f config/skip || ! grep -q WRONG "$0" "$@"', ...files] });
		const o = { checkConfigGlobs: ["tsconfig.json"], test, probeTest: { path: "src/probe.test.txt", content: "fine\n", failing: "WRONG\n" } };
		const app = (file: string) => (dir: string) => (code(dir), mkdirSync(join(dir, "config"), { recursive: true }), writeFileSync(join(dir, "config", file), "on\n"), "added b and its login wiring");
		it("may change: the login wiring a code job writes lands", async () => {
			const r = await job(app("security.yaml"), ["config/**", "tsconfig.json"], undefined, [], o);
			expect(r.merged).toBe(true);
			expect(r.onMain["config/security.yaml"]).toBe("on\n");
			expect(r.locked).toBeUndefined();
		});
		it("that turns the checks off is refused: the test command must still fail a failing test", async () => {
			const r = await job(app("skip"), ["config/**", "tsconfig.json"], undefined, [], o);
			expect(r.merged).toBe(false);
			expect(r.refused).toMatch(/with the changed app config \(config\/skip\) the checks no longer work/);
		});
	});
	it("a job for a waiting unit starts from main plus that unit's work, may replace that unit's stubs, and merges both", async () => {
		const ledger = new Ledger(":memory:");
		ledger.createUnit({ id: "u179", tier: "T1", symbolIds: [] });
		let seen = "";
		const unitWork = { unitId: "u179", apply: async (wt: string) => (writeFileSync(join(wt, "src", "renderer.txt"), "class StatusMailRenderer\n"), true) };
		const r = await job((dir) => ((seen = readFileSync(join(dir, "src", "renderer.txt"), "utf8")), code(dir), writeFileSync(join(dir, "src", "stub.txt"), "real\n"), "added b"), [], undefined, [], { main: { "src/stub.txt": "// TODO(br:u179) stand-in\n" }, ledger, unitWork });
		expect(seen).toBe("class StatusMailRenderer\n");
		expect(r.merged).toBe(true);
		expect(r.onMain["src/renderer.txt"]).toBe("class StatusMailRenderer\n");
		expect(r.onMain["src/b.txt"]).toBe("code\n");
	});
	it("no code at all fails the check: the job was to write code", async () => {
		const r = await job((dir) => (writeFileSync(join(dir, "notes.md"), "todo\n"), "wrote notes"));
		expect(r.merged).toBe(false);
	});
	it("a file the layout check flags fails the check, like a unit's gate: a note for other units stays off main", async () => {
		const flag = (_dir: string, only?: string[]) => (only ?? []).filter((f) => f.endsWith(".md")).map((f) => `${f}: not an allowed file in the feature folder`);
		const r = await job((dir) => (code(dir), mkdirSync(join(dir, "src", "features", "b"), { recursive: true }), writeFileSync(join(dir, "src", "features", "b", "README.md"), "contract for the frontend\n"), "added b"), [], flag);
		expect(r.merged).toBe(false);
		const ok = await job((dir) => (code(dir), "added b"), [], flag);
		expect(ok.merged).toBe(true);
	});
	it("a new file in a folder outside the layout (src/api/ next to the feature root) fails the check: the gate's own folder check does not run here", async () => {
		const r = await job((dir) => (code(dir), mkdirSync(join(dir, "src", "api"), { recursive: true }), writeFileSync(join(dir, "src", "api", "client.txt"), "client\n"), "added b"), [], () => []);
		expect(r.merged).toBe(false);
	});
	it("the model's whole last paragraph is the answer, so the waiting unit's hint carries the contract", async () => {
		const r = await job((dir) => (code(dir), "Ran the tests.\n\nAdded GET /api/b.\nIt returns {id, name}."));
		expect(r.said).toBe("Added GET /api/b.\nIt returns {id, name}.");
	});
	it("code with its test is merged", async () => {
		const r = await job((dir) => (code(dir), "added b"), ["**/tsconfig*.json"]);
		expect(r.merged).toBe(true);
	});
	it("main's existing build error is not the job's: its own tests pass, it merges; a new error is refused", async () => {
		// a build that ignores its file list (a full tsc): every BROKEN line is an error
		const red = { main: { "src/old.txt": "BROKEN\n" }, build: { cmd: "sh", args: ["-c", "! grep -rn BROKEN src"] } };
		expect((await job((dir) => (code(dir), "added b"), [], undefined, [], red)).merged).toBe(true);
		const worse = (dir: string) => (code(dir), writeFileSync(join(dir, "src", "c.txt"), "BROKEN\n"), "added b and c");
		expect((await job(worse, [], undefined, [], red)).merged).toBe(false);
	});
	it("a new source file runs the app's boot check too: an app that no longer starts is refused", async () => {
		// the app loads every source file its config lists (a service folder scan)
		const boot = { cmd: "sh", args: ["-c", 'for f in $(find src -name "*.txt" ! -name "*.test.txt"); do grep -qx "$f" app.txt || { echo "app cannot load $f"; exit 1; }; done'] };
		const r = await job((dir) => (code(dir), "added b"), [], undefined, [], { boot, main: { "app.txt": "\n" } });
		expect(r.merged).toBe(false);
		expect(r.refused).toMatch(/\(boot\)\napp cannot load src\/b\.txt/);
		const ok = await job((dir) => (code(dir), writeFileSync(join(dir, "app.txt"), "src/b.txt\n"), "added b"), [], undefined, [], { boot, main: { "app.txt": "\n" } });
		expect(ok.merged).toBe(true);
	});
	it("a build red here and green on main is refused", async () => {
		const r = await job((dir) => (code(dir), writeFileSync(join(dir, "src", "b.txt"), "BROKEN\n"), "added b"), [], undefined, [], { build: { cmd: "sh", args: ["-c", "! grep -rn BROKEN src"] } });
		expect(r.merged).toBe(false);
	});
	it("a refused job keeps the start of a long error (the boot error's message), not only its last stack frames", async () => {
		const boom = 'if grep -rq BROKEN src; then echo "In Kernel.php line 99: Class NxrMediaFileManager not found"; i=0; while [ $i -lt 3000 ]; do echo "#$i /vendor/twig/src/Compiler.php(99): frame"; i=$((i+1)); done; exit 1; fi';
		const r = await job((dir) => (code(dir), writeFileSync(join(dir, "src", "b.txt"), "BROKEN\n"), "added b"), [], undefined, [], { build: { cmd: "sh", args: ["-c", boom] } });
		expect(r.merged).toBe(false);
		expect(r.refused).toMatch(/Class NxrMediaFileManager not found/);
		expect(r.refused!.length).toBeLessThan(10_000);
	});
	it("a question's job may not remove the stub mark of a unit not accepted yet: that unit replaces its stub", async () => {
		const ledger = new Ledger(":memory:");
		ledger.createUnit({ id: "billing", tier: "T1", symbolIds: [] });
		const main = { main: { "src/stub.txt": "// TODO(br:billing) stand-in\n", "src/other.txt": "// TODO(br:billing) stand-in\n" }, ledger };
		const unmark = (dir: string) => (code(dir), writeFileSync(join(dir, "src", "stub.txt"), "real\n"), "replaced the stub");
		const r = await job(unmark, [], undefined, [], main);
		expect(r.merged).toBe(false);
		expect(r.refused).toMatch(/^stub marks of units not accepted yet were removed: TODO\(br:billing\)/);
		// adding code next to the stubs is fine
		expect((await job((dir) => (code(dir), "added b"), [], undefined, [], main)).merged).toBe(true);
		// a job for billing's own question, or one billing waits on, replaces billing's stub: its marks are the job's to remove
		expect((await job(unmark, [], undefined, [], { ...main, forUnit: "billing" })).merged).toBe(true);
		expect((await job(unmark, [], undefined, [], { ...main, forUnit: "other", waiting: ["billing"] })).merged).toBe(true);
		// the unit is accepted: its marks are anyone's to remove
		ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = 'billing'").run();
		expect((await job(unmark, [], undefined, [], main)).merged).toBe(true);
	});
	it("a loose mark of a unit not accepted yet is that unit's too; a new mark must name a unit still to come; files with only comments and tests on a mark are refused", async () => {
		const ledger = new Ledger(":memory:");
		ledger.createUnit({ id: "U5_sales_controller", tier: "T1", symbolIds: [] });
		ledger.setMeta("stub_owner_names", JSON.stringify({ "sales.controller": "U5_sales_controller" }));
		const main = { main: { "src/stub.txt": "// TODO(br:sales.controller) stand-in\n" }, ledger };
		const unmark = await job((dir) => (code(dir), writeFileSync(join(dir, "src", "stub.txt"), "real\n"), "replaced the stub"), [], undefined, [], main);
		expect(unmark.refused).toMatch(/^stub marks of units not accepted yet were removed: TODO\(br:sales\.controller\)/);
		const invented = await job((dir) => (code(dir), writeFileSync(join(dir, "src", "c.txt"), "// TODO(br:campaign editor owner)\nx\n"), "stubbed c"), [], undefined, [], main);
		expect(invented.refused).toMatch(/^new stub marks no unit will replace: TODO\(br:campaign editor owner\) names no unit/);
		const empty = await job((dir) => (code(dir), writeFileSync(join(dir, "src", "Deferral.txt"), "// owner-dependent: U5\n"), "deferred"), [], undefined, [], main);
		expect(empty.refused).toMatch(/^files with only comments, no code: src\/Deferral\.txt/);
		const onMark = await job((dir) => (code(dir), writeFileSync(join(dir, "src", "c.test.txt"), "expect(text).toContain('TODO(br:U5_sales_controller)')\n"), "tested"), [], undefined, [], main);
		expect(onMark.refused).toMatch(/^tests check a stub mark/);
	});
	it("a removed SQL comment stub mark (-- TODO(br:u)) counts as removed, though its diff line starts with ---", async () => {
		const ledger = new Ledger(":memory:");
		ledger.createUnit({ id: "u", tier: "T1", symbolIds: [] });
		const main = { main: { "src/stub.sql": "select 1;\n-- TODO(br:u) stand-in\n" }, ledger };
		const r = await job((dir) => (code(dir), writeFileSync(join(dir, "src", "stub.sql"), "select 1;\n"), "replaced the stub"), [], undefined, [], main);
		expect(r.merged).toBe(false);
		expect(r.refused).toMatch(/^stub marks of units not accepted yet were removed: TODO\(br:u\)/);
	});
	it("the builder's job has its own turn: a question's job does not wait behind it", async () => {
		let release = () => {};
		const builderHolds = new Promise<void>((r) => (release = r));
		const order: string[] = [];
		const builder = job(async () => (await builderHolds, order.push("builder"), "nothing"), [], undefined, [], { whole: true });
		await new Promise((r) => setTimeout(r, 50));
		await job((dir) => (code(dir), order.push("question"), "added b"));
		release();
		await builder;
		expect(order).toEqual(["question", "builder"]);
	});
});
