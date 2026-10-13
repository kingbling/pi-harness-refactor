import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TargetAdapter } from "../src/adapters/types.ts";
import { ConfigSchema } from "../src/config.ts";
import { commitAll, ensureRepo } from "../src/git.ts";
import { Ledger } from "../src/ledger/db.ts";
import { buildParkedKey, createBuilder, type Repairer } from "../src/run/builder.ts";
import { wholeProjectSteps } from "../src/run/gate.ts";

/**
 * Whole-project checks are not run per unit: the builder runs them now and then after merges, in its own worktree;
 * the big model fixes what fails (never the tests), code re-checks, the fix is merged like a unit.
 */
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function setup() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "br-builder-")));
	const target = join(root, "new");
	mkdirSync(join(target, "src"), { recursive: true });
	writeFileSync(join(target, "src", "a.txt"), "bad\n");
	writeFileSync(join(target, "src", "a.test.txt"), "expects ok\n");
	ensureRepo(target, "migration/main", []);
	commitAll(target, "init");
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
		commitAll(wt, what);
		git(target, ["merge", "-q", "--ff-only", branch]);
		return git(target, ["rev-parse", "HEAD"]);
	};
	return { root, target, config, adapter, ledger, mergeFix };
}

describe("the builder", () => {
	it("knows which commands check the whole project", () => {
		const { adapter, target } = setup();
		expect(wholeProjectSteps(adapter, target).map((s) => s.step)).toEqual(["build"]);
	});

	it("waits for enough merges, fixes the code with the model, throws test edits away, merges the fix", async () => {
		const { root, target, config, adapter, ledger, mergeFix } = setup();
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
		const { root, target, config, adapter, ledger, mergeFix } = setup();
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

	it("what the model cannot fix goes to a code job with the errors, no question, and is not repaired again", async () => {
		const { root, config, adapter, ledger, mergeFix } = setup();
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
		expect(calls).toBe(2); // the first cycle's two tries only
		expect(jobs).toHaveLength(2);
		expect(jobs[0]).toMatch(/grep -q ok src\/a\.txt/);
	});

	it("a test file the repair adds is deleted, not checked out, and the fix is merged", async () => {
		const { root, target, config, adapter, ledger, mergeFix } = setup();
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
		const { root, target, config, adapter, ledger, mergeFix } = setup();
		writeFileSync(join(target, "lint.cfg"), "strict\n");
		commitAll(target, "cfg");
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
		const { root, config, adapter, ledger, mergeFix } = setup();
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
});
