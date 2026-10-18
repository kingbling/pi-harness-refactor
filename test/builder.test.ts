import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveCommandOverride, withCommandOverrides } from "../src/adapters/command-overrides.ts";
import type { TargetAdapter } from "../src/adapters/types.ts";
import { ConfigSchema } from "../src/config.ts";
import { commitAll, ensureRepo } from "../src/git.ts";
import { Ledger } from "../src/ledger/db.ts";
import { buildParkedKey, builderLogPath, createBuilder, keepBuilderLine, type Repairer } from "../src/run/builder.ts";
import { wholeProjectSteps } from "../src/run/gate.ts";

/**
 * Whole-project checks are not run per unit: the builder runs them now and then after merges, in its own worktree;
 * the big model fixes what fails (never the tests), code re-checks, the fix is merged like a unit.
 */
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function setup() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "br-builder-")));
	const target = join(root, "new");
	mkdirSync(join(target, "src"), { recursive: true });
	writeFileSync(join(target, "src", "a.txt"), "bad\n");
	writeFileSync(join(target, "src", "a.test.txt"), "expects ok\n");
	await ensureRepo(target, "migration/main", []);
	await commitAll(target, "init");
	const config = ConfigSchema.parse({ source: { path: root, stack: "php" }, target: { path: target, stacks: ["fake"], git: { branch: "migration/main" } }, models: {} });
	const adapter = {
		id: "fake",
		protectedGlobs: [],
		layout: { isTestFile: (p: string) => p.includes(".test."), sourceExtensions: [".txt"] },
		// the "type check" of everything: it cannot take files
		build: () => ({ cmd: "grep", args: ["-q", "ok", "src/a.txt"] }),
		lint: (_r: string, files: string[]) => ({ cmd: "true", args: files }),
		// the accepted units' tests: a.test.txt expects a.txt to say ok
		test: () => ({ cmd: "grep", args: ["-q", "ok", "src/a.txt"] }),
	} as unknown as TargetAdapter;
	const ledger = new Ledger(":memory:");
	const mergeFix = async (wt: string, branch: string, what: string) => {
		await commitAll(wt, what);
		git(target, ["merge", "-q", "--ff-only", branch]);
		return git(target, ["rev-parse", "HEAD"]);
	};
	return { root, target, config, adapter, ledger, mergeFix };
}

describe("the builder", () => {
	it("knows which commands check the whole project", async () => {
		const { adapter, target } = (await setup());
		expect(wholeProjectSteps(adapter, target).map((s) => s.step)).toEqual(["build"]);
	});

	it("waits for enough merges, fixes the code with the model, throws test edits away, merges the fix", async () => {
		const { root, target, config, adapter, ledger, mergeFix } = (await setup());
		let calls = 0;
		const repair: Repairer = async (o) => {
			calls++;
			writeFileSync(join(o.dir, "src", "a.txt"), "ok\n");
			writeFileSync(join(o.dir, "src", "a.test.txt"), "expects anything\n"); // not allowed
			return "fixed a.txt";
		};
		const logs: string[] = [];
		const b = createBuilder({ config, root, ledger, adapters: new Map([["fake", adapter]]), log: (l) => logs.push(l), linkAll: () => {}, mergeFix, repair, every: { units: 3, minutes: 60 } });
		b.afterMerge("fake");
		b.afterMerge("fake");
		await new Promise((r) => setTimeout(r, 50));
		expect(calls).toBe(0); // not every merge
		b.afterMerge("fake");
		await b.finish();
		expect(logs.join("\n")).toMatch(/fixed and merged/);
		expect(calls).toBe(1);
		expect(readFileSync(join(target, "src", "a.txt"), "utf8")).toBe("ok\n");
		expect(readFileSync(join(target, "src", "a.test.txt"), "utf8")).toBe("expects ok\n");
		expect(git(target, ["log", "-1", "--format=%s"])).toMatch(/whole-project check/);
		expect(ledger.openQuestions()).toEqual([]);
	});

	it("runs every accepted unit's tests too: a later change that broke one is fixed in the code", async () => {
		const { root, target, config, adapter, ledger, mergeFix } = (await setup());
		const buildOk = { ...adapter, build: () => ({ cmd: "true", args: [] }) } as TargetAdapter;
		const logs: string[] = [];
		let problem = "";
		const repair: Repairer = async (o) => {
			problem = o.problem;
			writeFileSync(join(o.dir, "src", "a.txt"), "ok\n");
			return "restored a.txt";
		};
		const b = createBuilder({ config, root, ledger, adapters: new Map([["fake", buildOk]]), log: (l) => logs.push(l), linkAll: () => {}, mergeFix, repair, every: { units: 1, minutes: 60 } });
		b.afterMerge("fake");
		await b.finish();
		expect(problem).toMatch(/\(test\)/);
		expect(readFileSync(join(target, "src", "a.txt"), "utf8")).toBe("ok\n");
	});

	it("with a code job a red main goes straight to it with the failing commands, no repair, no question", async () => {
		const { root, config, adapter, ledger, mergeFix } = (await setup());
		let calls = 0;
		const repair: Repairer = async () => {
			calls++;
			return "tried";
		};
		const jobs: string[] = [];
		const b = createBuilder({ config, root, ledger, adapters: new Map([["fake", adapter]]), log: () => {}, linkAll: () => {}, mergeFix, repair, codeJob: async (_s, what) => (jobs.push(what), undefined), every: { units: 1, minutes: 60 } });
		b.afterMerge("fake");
		await b.finish();
		b.afterMerge("fake");
		await b.finish();
		expect(ledger.openQuestions()).toEqual([]);
		expect(calls).toBe(0); // the repair may not touch tests; the code job may
		expect(jobs).toHaveLength(2); // one per cycle: a job that merged nothing ends the cycle
		expect(jobs[0]).toMatch(/grep -q ok src\/a\.txt[\s\S]*run these commands yourself/i);
		// what the builder did stays readable after the live log scrolled away
		const kept = readFileSync(builderLogPath(root), "utf8");
		expect(kept).toMatch(/^\d{4}-\d\d-\d\dT\S+ builder fake: whole-project check fails: \d+ error line\(s\)/m);
		expect(kept).toMatch(/builder fake: code job 1\/3 merged nothing/);
		expect(kept).not.toMatch(/\x1b\[/);
	});

	it("the builder's record stays small: past its cap only the newer half is kept, whole lines", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "br-builderlog-")));
		mkdirSync(join(root, ".bigrefactor"));
		for (let i = 0; i < 6000; i++) keepBuilderLine(root, `builder fake: line ${i} ${"x".repeat(100)}`);
		const kept = readFileSync(builderLogPath(root), "utf8");
		expect(kept.length).toBeLessThanOrEqual(512 * 1024);
		expect(kept).toMatch(/^\d{4}-/);
		expect(kept).toMatch(/line 5999 x+\n$/);
		expect(kept).not.toMatch(/line 0 /);
	});

	it("a code job that made progress is followed by the next one in the same cycle, until main is green or one makes none", async () => {
		const { root, target, config, adapter, ledger } = (await setup());
		// the "type check" prints one line per error left in src/errors.txt
		writeFileSync(join(target, "src", "errors.txt"), "src/a.txt(1,1): error one\nsrc/a.txt(2,1): error two\n");
		await commitAll(target, "errors");
		const typed = { ...adapter, build: () => ({ cmd: "sh", args: ["-c", "cat src/errors.txt; test ! -s src/errors.txt"] }), test: () => ({ cmd: "true", args: [] }) } as TargetAdapter;
		const jobs: string[] = [];
		const fixTo = async (left: string) => (writeFileSync(join(target, "src", "errors.txt"), left), await commitAll(target, "fix"));
		const codeJob = async () => {
			jobs.push("job");
			// the first job fixes one of the two errors (merged, main still red); the second fixes the other
			await fixTo(jobs.length === 1 ? "src/a.txt(2,1): error two\n" : "");
			return jobs.length === 1 ? "fixed one error" : "fixed the rest";
		};
		const logs: string[] = [];
		const b = createBuilder({ config, root, ledger, adapters: new Map([["fake", typed]]), log: (l) => logs.push(l), linkAll: () => {}, mergeFix: async () => undefined, codeJob, every: { units: 1, minutes: 60 } });
		b.afterMerge("fake");
		await b.finish();
		expect(jobs).toHaveLength(2);
		expect(logs.join("\n")).toMatch(/whole project ok/);
		// a job that says it helped but leaves main as it was: no second job in that cycle
		await fixTo("src/a.txt(1,1): error one\n");
		const said: string[] = [];
		const b2 = createBuilder({ config, root, ledger, adapters: new Map([["fake", typed]]), log: () => {}, linkAll: () => {}, mergeFix: async () => undefined, codeJob: async () => (said.push("job"), "fewer errors"), every: { units: 1, minutes: 60 } });
		b2.afterMerge("fake");
		await b2.finish();
		expect(said).toHaveLength(1);
	});

	it("a test file the repair adds is deleted, not checked out, and the fix is merged", async () => {
		const { root, target, config, adapter, ledger, mergeFix } = (await setup());
		const repair: Repairer = async (o) => {
			writeFileSync(join(o.dir, "src", "a.txt"), "ok\n");
			mkdirSync(join(o.dir, "src", "new"));
			writeFileSync(join(o.dir, "src", "new", "b.test.txt"), "a new test\n");
			return "fixed a.txt";
		};
		const logs: string[] = [];
		const b = createBuilder({ config, root, ledger, adapters: new Map([["fake", adapter]]), log: (l) => logs.push(l), linkAll: () => {}, mergeFix, repair, every: { units: 1, minutes: 60 } });
		b.afterMerge("fake");
		await b.finish();
		expect(logs.join("\n")).toMatch(/fixed and merged/);
		expect(readFileSync(join(target, "src", "a.txt"), "utf8")).toBe("ok\n");
		expect(existsSync(join(target, "src", "new", "b.test.txt"))).toBe(false);
	});

	it("a repair that changes protected config through bash has it undone", async () => {
		const { root, target, config, adapter, ledger, mergeFix } = (await setup());
		writeFileSync(join(target, "lint.cfg"), "strict\n");
		await commitAll(target, "cfg");
		const guarded = { ...adapter, protectedGlobs: ["lint.cfg", "*.ignore"] } as TargetAdapter;
		const logs: string[] = [];
		const repair: Repairer = async (o) => {
			writeFileSync(join(o.dir, "src", "a.txt"), "ok\n");
			writeFileSync(join(o.dir, "lint.cfg"), "loose\n"); // weakens the checks
			writeFileSync(join(o.dir, "src.ignore"), "src\n"); // a new file that hides errors
			return "fixed";
		};
		const b = createBuilder({ config, root, ledger, adapters: new Map([["fake", guarded]]), log: (l) => logs.push(l), linkAll: () => {}, mergeFix, repair, every: { units: 1, minutes: 60 } });
		b.afterMerge("fake");
		await b.finish();
		expect(logs.join("\n")).toMatch(/protected config; undone: .*lint\.cfg/);
		expect(readFileSync(join(target, "lint.cfg"), "utf8")).toBe("strict\n");
		expect(git(target, ["ls-files", "src.ignore"])).toBe("");
		expect(readFileSync(join(target, "src", "a.txt"), "utf8")).toBe("ok\n");
	});

	it("an accepted unit whose own test fails on main goes back to work instead of a question, at most twice", async () => {
		const { root, config, adapter, ledger, mergeFix } = (await setup());
		const failing = { ...adapter, build: () => ({ cmd: "true", args: [] }), test: () => ({ cmd: "sh", args: ["-c", "echo 'FAIL invoices u1#2 total'; exit 1"] }) } as TargetAdapter;
		ledger.createUnit({ id: "u1", tier: "leaf", symbolIds: [] });
		ledger.createUnit({ id: "u2", tier: "leaf", symbolIds: [] });
		ledger.db.prepare("UPDATE units SET state = 'accepted'").run();
		const ins = ledger.db.prepare("INSERT INTO truth_cases(id, unit_id, symbol_id, inputs, expected, verified_on_old, created_at) VALUES (?, ?, 's', '[]', '1', 1, '')");
		ins.run("u1#2", "u1");
		ins.run("u2#1", "u2");
		const b = createBuilder({ config, root, ledger, adapters: new Map([["fake", failing]]), log: () => {}, linkAll: () => {}, mergeFix, repair: false, every: { units: 1, minutes: 60 } });
		for (let i = 0; i < 3; i++) {
			ledger.db.prepare("UPDATE units SET state = 'accepted'").run();
			b.afterMerge("fake");
			await b.finish();
			expect(ledger.getUnit("u2")!.state).toBe("accepted");
		}
		expect(JSON.parse(ledger.getUnit("u1")!.meta).buildReopens).toBe(2);
		expect(JSON.parse(ledger.getUnit("u1")!.meta).retryNote).toMatch(/u1#2/);
		// after the cap: no question; with no code job to hand it to, main is parked red (br status)
		expect(ledger.openQuestions()).toEqual([]);
		expect(ledger.getMeta(buildParkedKey("fake"))).toMatch(/no code job/);
	});

	it("the stack's boot check (set per workspace like the other commands) is a whole-project step: an app that does not start is a red main", async () => {
		const { root, config, adapter, ledger, mergeFix } = (await setup());
		// build and lint take the unit's files: only the boot check runs on the whole project
		const perUnit = { ...adapter, build: (_r: string, files: string[] = []) => ({ cmd: "true", args: files }), test: () => ({ cmd: "true", args: [] }) } as TargetAdapter;
		expect(wholeProjectSteps(perUnit, root).map((s) => s.step)).toEqual([]);
		saveCommandOverride(root, "fake", "boot", { cmd: "grep", args: ["-q", "ok", "src/a.txt"] }, "the app's own container check");
		const booting = withCommandOverrides(perUnit, root);
		expect(wholeProjectSteps(booting, root)).toEqual([{ step: "boot", cmd: "grep", args: ["-q", "ok", "src/a.txt"] }]);
		const jobs: string[] = [];
		const b = createBuilder({ config, root, ledger, adapters: new Map([["fake", booting]]), log: () => {}, linkAll: () => {}, mergeFix, codeJob: async (_s, what) => (jobs.push(what), undefined), every: { units: 1, minutes: 60 } });
		b.afterMerge("fake");
		await b.finish();
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatch(/grep -q ok src\/a\.txt\s+\(boot\)/);
	});

	it("a new app that did not start in the parity check goes to a code job as a main problem, once per main tree", async () => {
		const { root, target, config, adapter, ledger, mergeFix } = (await setup());
		const green = { ...adapter, build: () => ({ cmd: "true", args: [] }), test: () => ({ cmd: "true", args: [] }) } as TargetAdapter;
		const jobs: string[] = [];
		const b = createBuilder({ config, root, ledger, adapters: new Map([["fake", green]]), log: () => {}, linkAll: () => {}, mergeFix, codeJob: async (_s, what) => (jobs.push(what), undefined), every: { units: 5, minutes: 60 } });
		await b.appDown("fake", 'Specified non-existing directory "src/Players/Entity" as Doctrine mapping source');
		await b.finish();
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatch(/the new fake app, started for the parity check[\s\S]*non-existing directory/);
		// the same main again: not handed over twice
		await b.appDown("fake", "still down");
		await b.finish();
		expect(jobs).toHaveLength(1);
		writeFileSync(join(target, "src", "b.txt"), "later\n");
		await commitAll(target, "a later merge");
		await b.appDown("fake", "down on the new main");
		await b.finish();
		expect(jobs).toHaveLength(2);
		expect(jobs[1]).toMatch(/down on the new main/);
	});
	it("a stop kills the running check, starts no repair or code job, and leaves no worktree", async () => {
		const { root, config, adapter, ledger, mergeFix } = await setup();
		// the whole-project check takes a minute
		const slow = { ...adapter, build: () => ({ cmd: "sleep", args: ["60"] }) } as unknown as TargetAdapter;
		let repairs = 0;
		let jobs = 0;
		const b = createBuilder({ config, root, ledger, adapters: new Map([["fake", slow]]), log: () => {}, linkAll: () => {}, mergeFix, repair: async () => (repairs++, ""), codeJob: async () => (jobs++, undefined), every: { units: 1, minutes: 60 } });
		b.afterMerge("fake");
		await new Promise((r) => setTimeout(r, 300));
		const t0 = Date.now();
		await b.stop();
		expect(Date.now() - t0).toBeLessThan(10_000);
		expect(repairs + jobs).toBe(0);
		expect(existsSync(join(root, ".bigrefactor", "worktrees", "__builder__fake"))).toBe(false);
		b.afterMerge("fake"); // nothing new starts after a stop
		await b.finish();
		expect(repairs + jobs).toBe(0);
	});
});
