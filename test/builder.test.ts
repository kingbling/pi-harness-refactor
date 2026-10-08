import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TargetAdapter } from "../src/adapters/types.ts";
import { ConfigSchema } from "../src/config.ts";
import { commitAll, ensureRepo } from "../src/git.ts";
import { Ledger } from "../src/ledger/db.ts";
import { createBuilder, type Repairer } from "../src/run/builder.ts";
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
		layout: { isTestFile: (p: string) => p.includes(".test.") },
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

	it("what the model cannot fix becomes one question that blocks nothing", async () => {
		const { root, config, adapter, ledger, mergeFix } = setup();
		const b = createBuilder({ config, root, ledger, adapters: new Map([["fake", adapter]]), log: () => {}, linkAll: () => {}, mergeFix, repair: async () => "tried", every: { units: 1, minutes: 60 } });
		b.afterMerge("fake");
		await b.finish();
		b.afterMerge("fake");
		await b.finish();
		const qs = ledger.openQuestions();
		expect(qs).toHaveLength(1);
		expect(qs[0]).toMatchObject({ point: "build", blocks: "none" });
	});
});
