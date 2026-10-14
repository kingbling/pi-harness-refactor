import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TargetAdapter } from "../src/adapters/types.ts";
import { ConfigSchema } from "../src/config.ts";
import { renderStatus } from "../src/dashboard/status.ts";
import { commitAll, ensureRepo } from "../src/git.ts";
import { Ledger } from "../src/ledger/db.ts";
import { buildParkedKey, createBuilder, createMergeCheck, MAX_BUILD_CODE_JOBS } from "../src/run/builder.ts";
import { runCodeJob } from "../src/run/code-job.ts";

/**
 * Main stays green: a unit's merge that turns its stack's whole-project check red does not land, and a red main goes
 * to a code job with the errors, never to the owner as "fix or ignore"; after a few jobs it is parked quietly.
 */
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function setup(a = "ok\n") {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "br-red-main-")));
	const target = join(root, "new");
	mkdirSync(join(target, "src"), { recursive: true });
	writeFileSync(join(target, "src", "a.txt"), a);
	await ensureRepo(target, "migration/main", []);
	await commitAll(target, "init");
	const config = ConfigSchema.parse({ source: { path: root, stack: "php" }, target: { path: target, stacks: ["fake"], git: { branch: "migration/main" } }, models: {} });
	const runs = join(root, "runs");
	writeFileSync(runs, "");
	const adapter = {
		id: "fake",
		protectedGlobs: [],
		toolchain: { ignoredPaths: [] },
		generatedFiles: [],
		layout: { moduleDir: (x: string) => `src/features/${x}`, sharedDirs: ["src/shared/"], ignoreDirs: [], isTestFile: (p: string) => p.includes(".test."), sourceExtensions: [".txt"], wiringFiles: [] },
		// the type check of everything: it cannot take files (each run is counted)
		build: () => ({ cmd: "sh", args: ["-c", `echo . >> ${runs}; grep -q ok src/a.txt`] }),
		lint: (_r: string, files: string[]) => ({ cmd: "true", args: files }),
		test: () => ({ cmd: "true", args: [] }),
	} as unknown as TargetAdapter;
	const unit = async (name: string, content: string) => {
		const wt = join(root, "wt", name);
		git(target, ["worktree", "add", "-q", "-b", `unit/${name}`, wt]);
		writeFileSync(join(wt, "src", "a.txt"), content);
		await commitAll(wt, name);
		return wt;
	};
	return { root, target, config, adapter, unit, checks: () => readFileSync(runs, "utf8").split("\n").filter(Boolean).length };
}

describe("a merge that turns the whole-project check red", () => {
	it("does not land when main was green; the errors come back", async () => {
		const s = await setup();
		const check = createMergeCheck({ config: s.config, adapters: new Map([["fake", s.adapter]]) });
		const out = await check("fake", (await s.unit("u1", "bad\n")));
		expect(out).toMatch(/whole-project build/);
		expect(out).toMatch(/grep -q ok src\/a\.txt/);
		expect(await check("fake", (await s.unit("u2", "still ok\n")))).toBeUndefined();
	});

	it("lands when main was red already (the builder deals with that)", async () => {
		const s = await setup("bad\n");
		const check = createMergeCheck({ config: s.config, adapters: new Map([["fake", s.adapter]]) });
		expect(await check("fake", (await s.unit("u1", "worse\n")))).toBeUndefined();
	});

	it("is not run when the merge changes nothing of the stack, and main is checked only when the unit fails", async () => {
		const s = await setup();
		const check = createMergeCheck({ config: s.config, adapters: new Map([["fake", s.adapter]]) });
		const wt = join(s.root, "wt", "same");
		git(s.target, ["worktree", "add", "-q", "-b", "unit/same", wt]);
		const before = s.checks();
		expect(await check("fake", wt)).toBeUndefined();
		expect(s.checks()).toBe(before); // nothing ran
		await check("fake", (await s.unit("u1", "ok too\n")));
		expect(s.checks() - before).toBe(1); // the worktree only
	});
});

describe("a red main", () => {
	async function builder(codeJob?: (stack: string, what: string) => Promise<string | undefined>) {
		const s = await setup("bad\n");
		const ledger = new Ledger(":memory:");
		const b = createBuilder({ config: s.config, root: s.root, ledger, adapters: new Map([["fake", s.adapter]]), log: () => {}, linkAll: () => {}, mergeFix: async () => undefined, repair: false, codeJob, every: { units: 1, minutes: 60 } });
		return { ...s, ledger, b };
	}

	it("goes to a code job with the errors, no question; after the jobs fail it is parked quietly (br status)", async () => {
		const asked: string[] = [];
		const { b, ledger } = (await builder(async (_s, what) => (asked.push(what), undefined)));
		for (let i = 0; i < MAX_BUILD_CODE_JOBS + 2; i++) {
			b.afterMerge("fake");
			await b.finish();
		}
		expect(asked).toHaveLength(MAX_BUILD_CODE_JOBS); // parked: no more jobs
		expect(asked[0]).toMatch(/grep -q ok src\/a\.txt/);
		expect(ledger.openQuestions()).toEqual([]);
		expect(ledger.getMeta(buildParkedKey("fake"))).toMatch(/whole-project checks/);
		expect(renderStatus(ledger, { color: false })).toMatch(/main of fake parked red, no question/);
	});

	it("green again clears the parked line", async () => {
		const { b, ledger, target } = (await builder(async () => undefined));
		for (let i = 0; i < MAX_BUILD_CODE_JOBS; i++) {
			b.afterMerge("fake");
			await b.finish();
		}
		expect(ledger.getMeta(buildParkedKey("fake"))).toBeTruthy();
		writeFileSync(join(target, "src", "a.txt"), "ok\n");
		await commitAll(target, "fixed by hand");
		b.afterMerge("fake");
		await b.finish();
		expect(ledger.getMeta(buildParkedKey("fake"))).toBe("");
		expect(renderStatus(ledger, { color: false })).not.toMatch(/parked red/);
	});
});

describe("a red main the builder cannot hand to a code job", () => {
	// the check names the file its error is in, like a type checker does
	async function red(file: string, o: { codeJob?: (s: string, w: string) => Promise<string | undefined>; fixSetup?: (s: string, p: string) => Promise<string | undefined>; ledger?: Ledger } = {}) {
		const s = await setup("bad\n");
		writeFileSync(join(s.target, "src", "Kernel.txt"), "kernel\n");
		mkdirSync(join(s.target, "config"), { recursive: true });
		writeFileSync(join(s.target, "config", "lint.txt"), "rules\n");
		await commitAll(s.target, "kernel and lint config");
		const adapter = { ...s.adapter, protectedGlobs: ["config/**", "src/Kernel.txt"], checkConfigGlobs: ["config/lint.txt"], build: () => ({ cmd: "sh", args: ["-c", `grep -q ok src/a.txt || { echo "${file}:12 error: $(cat src/a.txt)"; exit 1; }`] }) } as unknown as TargetAdapter;
		const ledger = o.ledger ?? new Ledger(":memory:");
		const mk = () => createBuilder({ config: s.config, root: s.root, ledger, adapters: new Map([["fake", adapter]]), log: () => {}, linkAll: () => {}, mergeFix: async () => undefined, repair: false, codeJob: o.codeJob, fixSetup: o.fixSetup, every: { units: 1, minutes: 60 } });
		return { ...s, ledger, mk };
	}

	it("errors only in files that decide how the checks run go to the setup model, not to a code job", async () => {
		const jobs: string[] = [];
		const setups: string[] = [];
		const { mk } = await red("config/lint.txt", { codeJob: async (_s, w) => (jobs.push(w), undefined), fixSetup: async (_s, p) => (setups.push(p), undefined) });
		const b = mk();
		b.afterMerge("fake");
		await b.finish();
		expect(jobs).toEqual([]);
		expect(setups).toHaveLength(1);
		expect(setups[0]).toMatch(/config\/lint\.txt:12 error/);
		// the setup model changed nothing: parked, no paid job on the next cycle either
		b.afterMerge("fake");
		await b.finish();
		expect(jobs).toEqual([]);
		expect(setups).toHaveLength(1);
	});

	it("errors in app files a code job may change (the kernel) still go to a code job", async () => {
		const jobs: string[] = [];
		const { mk } = await red("src/Kernel.txt", { codeJob: async (_s, w) => (jobs.push(w), undefined), fixSetup: async () => undefined });
		const b = mk();
		b.afterMerge("fake");
		await b.finish();
		expect(jobs).toHaveLength(1);
	});

	it("the job count is in the ledger: a restart (a new builder) keeps the park while main fails the same way", async () => {
		const jobs: string[] = [];
		const { mk, ledger, target } = await red("src/Kernel.txt", { codeJob: async (_s, w) => (jobs.push(w), undefined) });
		const first = mk();
		for (let i = 0; i < MAX_BUILD_CODE_JOBS + 1; i++) {
			first.afterMerge("fake");
			await first.finish();
		}
		expect(jobs).toHaveLength(MAX_BUILD_CODE_JOBS);
		expect(ledger.getMeta(buildParkedKey("fake"))).toBeTruthy();
		const restarted = mk();
		restarted.afterMerge("fake");
		await restarted.finish();
		expect(jobs).toHaveLength(MAX_BUILD_CODE_JOBS); // still parked
		// main changed, but it fails the same way: still parked
		writeFileSync(join(target, "src", "Kernel.txt"), "kernel 2\n");
		await commitAll(target, "unrelated change");
		restarted.afterMerge("fake");
		await restarted.finish();
		expect(jobs).toHaveLength(MAX_BUILD_CODE_JOBS);
		// main changed where it matters (it now fails with other errors): the park is lifted, a code job tries again
		writeFileSync(join(target, "src", "a.txt"), "worse\n");
		await commitAll(target, "other change");
		restarted.afterMerge("fake");
		await restarted.finish();
		expect(jobs).toHaveLength(MAX_BUILD_CODE_JOBS + 1);
		expect(ledger.getMeta(buildParkedKey("fake"))).toBe("");
	});
});

describe("the builder's code job", () => {
	async function job(fix: string) {
		const s = await setup("bad\n");
		let merged = false;
		const said = await runCodeJob({
			config: s.config,
			root: s.root,
			ledger: new Ledger(":memory:"),
			adapter: s.adapter,
			what: "make the whole project pass",
			label: "build-fake-1",
			linkAll: () => {},
			mergeFix: async () => ((merged = true), undefined),
			log: () => {},
			whole: true,
			worker: async ({ dir }) => (writeFileSync(join(dir, "src", "a.txt"), fix), "fixed a.txt"),
		});
		return { said, merged, s };
	}

	it("merges a fix without a new test when the whole-project check passes", async () => {
		const r = await job("ok\n");
		expect(r.merged).toBe(true);
		expect(r.said).toMatch(/fixed a\.txt/);
	});

	it("merges nothing while the whole-project check still fails", async () => {
		const r = await job("still bad\n");
		expect(r.merged).toBe(false);
		expect(readFileSync(join(r.s.target, "src", "a.txt"), "utf8")).toBe("bad\n");
	});
});
