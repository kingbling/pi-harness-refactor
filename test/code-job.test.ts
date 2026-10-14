import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
	async function job(worker: (dir: string) => string | Promise<string>, protectedGlobs: string[] = [], checkTree?: (dir: string, only?: string[]) => string[], wiringFiles: string[] = [], o: { main?: Record<string, string>; build?: { cmd: string; args: string[] }; ledger?: Ledger; whole?: boolean } = {}) {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "br-code-job-")));
		const target = join(root, "new");
		mkdirSync(join(target, "src"), { recursive: true });
		writeFileSync(join(target, "src", "a.test.txt"), "expects ok\n");
		writeFileSync(join(target, "tsconfig.json"), "{}\n");
		for (const [f, text] of Object.entries(o.main ?? {})) writeFileSync(join(target, f), text);
		await ensureRepo(target, "migration/main", []);
		await commitAll(target, "init");
		const config = ConfigSchema.parse({ source: { path: root, stack: "php" }, target: { path: target, stacks: ["fake"], git: { branch: "migration/main" } }, models: {} });
		const adapter = {
			id: "fake",
			protectedGlobs,
			toolchain: { ignoredPaths: [] },
			generatedFiles: [],
			layout: { moduleDir: (a: string) => `src/features/${a}`, sharedDirs: ["src/shared/"], ignoreDirs: [], isTestFile: (p: string) => p.includes(".test."), sourceExtensions: [".txt"], checkTree, wiringFiles },
			build: () => o.build ?? { cmd: "true", args: [] },
			test: () => ({ cmd: "true", args: [] }),
		} as unknown as TargetAdapter;
		let merged = false;
		let refused: string | undefined;
		const said = await runCodeJob({
			config,
			root,
			ledger: o.ledger ?? new Ledger(":memory:"),
			adapter,
			what: "make the test pass",
			label: o.whole ? "build-fake-1" : "q1",
			whole: o.whole,
			linkAll: () => {},
			mergeFix: async () => ((merged = true), undefined),
			log: () => {},
			worker: async ({ dir }) => worker(dir),
			onRefused: (p) => (refused = p),
		});
		return { said, merged, target, refused };
	}

	it("a deleted test fails the check: nothing is merged", async () => {
		const { said, merged, target } = await job((dir) => (rmSync(join(dir, "src", "a.test.txt")), "removed the failing test"));
		expect(said).toBeUndefined();
		expect(merged).toBe(false);
		expect(existsSync(join(target, "src", "a.test.txt"))).toBe(true);
		expect(git(target, ["status", "--porcelain"])).toBe("");
	});

	const code = (dir: string) => (writeFileSync(join(dir, "src", "b.txt"), "code\n"), writeFileSync(join(dir, "src", "b.test.txt"), "test\n"));
	it("changed protected config fails the check: it holds the checks", async () => {
		const r = await job((dir) => (code(dir), writeFileSync(join(dir, "tsconfig.json"), '{"strict":false}\n'), "added b"), ["**/tsconfig*.json"]);
		expect(r.merged).toBe(false);
	});
	it("a protected wiring file (bundle list, route table) may change: a new feature folder is registered there", async () => {
		const wire = (dir: string) => (code(dir), mkdirSync(join(dir, "config"), { recursive: true }), writeFileSync(join(dir, "config", "bundles.txt"), "B\n"), "added b");
		expect((await job(wire, ["config/**"], undefined, ["config/bundles.txt"])).merged).toBe(true);
		const r = await job(wire, ["config/**"]);
		expect(r.merged).toBe(false);
		// the caller learns why: the resolver says "wrote it but was not merged", not "changed nothing"
		expect(r.refused).toBe("protected config was changed: config/bundles.txt");
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
	it("a build red here and green on main is refused", async () => {
		const r = await job((dir) => (code(dir), writeFileSync(join(dir, "src", "b.txt"), "BROKEN\n"), "added b"), [], undefined, [], { build: { cmd: "sh", args: ["-c", "! grep -rn BROKEN src"] } });
		expect(r.merged).toBe(false);
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
		// the unit is accepted: its marks are anyone's to remove
		ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = 'billing'").run();
		expect((await job(unmark, [], undefined, [], main)).merged).toBe(true);
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
