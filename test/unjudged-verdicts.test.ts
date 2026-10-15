import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TargetAdapter } from "../src/adapters/types.ts";
import { ConfigSchema } from "../src/config.ts";
import { commitAll, ensureRepo } from "../src/git.ts";
import { Ledger } from "../src/ledger/db.ts";
import { buildParkedKey, buildRedKey, createBuilder } from "../src/run/builder.ts";
import { judgeBeforeAccept } from "../src/run/accept-judged.ts";
import { judgedAtMerge, scopedCheck, verdictsAtMerge } from "../src/run/gate.ts";
import { reopenUnit, reopenUnjudgedWiring } from "../src/run/recheck.ts";

/**
 * A skipped verdict is no pass: a build the gate deferred to the whole-project check, or a wiring nobody reviewed,
 * keeps the unit from being accepted until it is judged (at the merge, by the builder on a green main, by the reviewer).
 * A red main gets the builder's repair before the next unit merges on top.
 */
const STEPS = ["symbolproof_ok", "build_ok", "lint_ok", "rules_ok", "antigaming_ok", "structure_ok", "wired_ok", "ported_tests_green"] as const;

function unitWith(l: Ledger, id: string, notJudged: Array<(typeof STEPS)[number]>) {
	l.upsertFile({ path: `src/${id}.php`, hash: "h", lang: "php", loc: 3 });
	l.upsertSymbol({ id: `src/${id}.php::f`, path: `src/${id}.php`, kind: "function", name: "f" });
	l.createUnit({ id, tier: "T1", symbolIds: [`src/${id}.php::f`], meta: { place: { stack: "fake", area: "x" } } });
	l.prove({ unitId: id, srcSymbol: `src/${id}.php::f`, op: "dropped", why: "nothing to port" });
	for (const t of STEPS) l.addEvidence(id, t, notJudged.includes(t) ? { judged: false, note: `${t} skipped` } : {});
}

describe("an unjudged verdict is no pass", () => {
	it("the ledger refuses to accept a unit whose build or wiring was not judged; the merge check's verdict lets it in", () => {
		const l = new Ledger(":memory:");
		unitWith(l, "U1", ["build_ok", "wired_ok"]);
		expect(() => l.transitionUnit("U1", "accepted")).toThrow(/not judged: build_ok \(build_ok skipped\), wired_ok/);
		expect(judgedAtMerge(l, "U1", "no whole-project error")).toEqual(["build_ok"]);
		// the merge check judges build and lint, never the wiring
		expect(() => l.transitionUnit("U1", "accepted")).toThrow(/not judged: wired_ok/);
		l.addEvidence("U1", "wired_ok", { ms: 1 });
		l.transitionUnit("U1", "accepted");
		expect(l.getUnit("U1")!.state).toBe("accepted");
	});

	it("a whole-project build is deferred (judged later), no file to build is a verdict of its own", () => {
		const adapter = { build: (_d: string, files: string[]) => ({ cmd: "tsc", args: ["--noEmit"].concat(files.length ? [] : []) }), lint: (_d: string, files: string[]) => ({ cmd: "eslint", args: files }) } as unknown as TargetAdapter;
		expect(scopedCheck(adapter, "/x", "build", ["a.ts"])).toMatchObject({ deferred: true });
		expect(scopedCheck(adapter, "/x", "lint", [])).toEqual({ skip: "no files to lint" });
	});

	it("accepted units nobody reviewed go back to planned for the reviewer, code kept; reviewed ones stay", () => {
		const l = new Ledger(":memory:");
		unitWith(l, "U1", ["wired_ok"]);
		unitWith(l, "U2", []);
		// accepted under the old rule (before the ledger checked verdicts)
		l.db.prepare("UPDATE units SET state = 'accepted' WHERE id IN ('U1', 'U2')").run();
		expect(reopenUnjudgedWiring(l)).toEqual(["U1"]);
		expect(l.getUnit("U1")!.state).toBe("planned");
		expect(JSON.parse(l.getUnit("U1")!.meta).retryNote).toMatch(/without a wiring verdict/);
		expect(l.getUnit("U2")!.state).toBe("accepted");
	});

	it("at the merge: the merge check judges the deferred build; anything still not judged stops the unit before main changes", () => {
		const l = new Ledger(":memory:");
		unitWith(l, "U1", ["build_ok", "lint_ok"]);
		unitWith(l, "U2", ["build_ok"]);
		unitWith(l, "U3", ["wired_ok"]);
		expect(verdictsAtMerge(l, "U1", true, true)).toBeUndefined();
		expect(l.evidenceOf("U1").filter((e) => e.type === "build_ok").at(-1)!.payload).toMatch(/main already fails/);
		// no merge check ran (spawned test runs): the deferred build stays unjudged
		expect(verdictsAtMerge(l, "U2", false, false)).toMatch(/^not judged: build_ok .*does not land on main/);
		// the merge check never judges the wiring
		expect(verdictsAtMerge(l, "U3", true, false)).toMatch(/^not judged: wired_ok/);
	});

	it("a recheck's wrong re-open is undone with the builder's build verdict still owed, never with an unjudged wiring", () => {
		const l = new Ledger(":memory:");
		unitWith(l, "U1", ["build_ok"]);
		unitWith(l, "U2", ["wired_ok"]);
		l.db.prepare("UPDATE units SET state = 'accepted' WHERE id IN ('U1', 'U2')").run();
		for (const id of ["U1", "U2"]) reopenUnit(l, id, "recheck found something", "recheck: x");
		l.undoReopen("U1", "recheck: clean when judged again");
		expect(l.getUnit("U1")!.state).toBe("accepted");
		expect(() => l.undoReopen("U2", "recheck: clean when judged again")).toThrow(/not judged: wired_ok/);
		expect(l.getUnit("U2")!.state).toBe("planned");
	});
});

describe("a red main: the builder repairs it on the side", () => {
	const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
	async function setup() {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "br-unjudged-")));
		const target = join(root, "new");
		mkdirSync(join(target, "src"), { recursive: true });
		writeFileSync(join(target, "src", "a.txt"), "bad\n");
		await ensureRepo(target, "migration/main", []);
		await commitAll(target, "init");
		const config = ConfigSchema.parse({ source: { path: root, stack: "php" }, target: { path: target, stacks: ["fake"], git: { branch: "migration/main" } }, models: {} });
		const adapter = {
			id: "fake",
			protectedGlobs: [],
			toolchain: { ignoredPaths: [] },
			generatedFiles: [],
			layout: { moduleDir: (x: string) => `src/features/${x}`, sharedDirs: ["src/shared/"], ignoreDirs: [], isTestFile: (p: string) => p.includes(".test."), sourceExtensions: [".txt"], wiringFiles: [] },
			build: () => ({ cmd: "sh", args: ["-c", "grep -q ok src/a.txt"] }),
			lint: (_r: string, files: string[]) => ({ cmd: "true", args: files }),
			test: () => ({ cmd: "true", args: [] }),
		} as unknown as TargetAdapter;
		const ledger = new Ledger(":memory:");
		const jobs: string[] = [];
		// the code job fixes main
		const codeJob = async (_s: string, what: string): Promise<string | undefined> => {
			jobs.push(what);
			writeFileSync(join(target, "src", "a.txt"), "ok\n");
			await commitAll(target, "fixed by the code job");
			return "fixed a.txt";
		};
		const b = createBuilder({ config, root, ledger, adapters: new Map([["fake", adapter]]), log: () => {}, linkAll: () => {}, mergeFix: async () => undefined, repair: false, codeJob: (st, what) => (job ?? codeJob)(st, what), every: { units: 100, minutes: 600 } });
		// a test swaps the code job
		let job: typeof codeJob | undefined;
		return { root, target, ledger, b, jobs, adapter, setJob: (j: typeof codeJob) => (job = j) };
	}

	it("the builder repairs a red main on the side; green again judges the deferred builds of accepted units", async () => {
		const s = await setup();
		unitWith(s.ledger, "U1", ["build_ok"]);
		s.ledger.db.prepare("UPDATE units SET state = 'accepted', updated_at = '2000-01-01T00:00:00.000Z' WHERE id = 'U1'").run();
		s.ledger.setMeta(buildRedKey("fake"), "2026-10-15 a.txt fails");
		s.b.afterMerge("fake");
		await s.b.finish();
		expect(s.jobs).toHaveLength(1);
		expect(s.ledger.getMeta(buildRedKey("fake"))).toBe("");
		expect(s.ledger.unjudged("U1")).toEqual([]);
		expect(git(s.target, ["log", "-1", "--format=%s"])).toBe("fixed by the code job");
	});

	it("a main no code job can fix is parked after MAX_BUILD_CODE_JOBS jobs; it stays red", async () => {
		const s = await setup();
		let calls = 0;
		s.setJob(async () => (calls++, undefined));
		for (let i = 0; i < 4; i++) s.b.afterMerge("fake"), await s.b.finish();
		expect(calls).toBe(3);
		expect(s.ledger.getMeta(buildParkedKey("fake"))).toMatch(/parked|stops/);
		expect(s.ledger.getMeta(buildRedKey("fake"))).not.toBe("");
	});

	it("a hand accept runs the deferred whole-project build first: red refuses before any commit, green judges it", async () => {
		const s = await setup();
		unitWith(s.ledger, "U1", ["build_ok"]);
		expect(await judgeBeforeAccept(s.ledger, s.adapter, s.target, "U1")).toMatch(/whole-project check fails .*grep -q ok/s);
		expect(s.ledger.unjudged("U1").map((u) => u.type)).toEqual(["build_ok"]);
		writeFileSync(join(s.target, "src", "a.txt"), "ok\n");
		expect(await judgeBeforeAccept(s.ledger, s.adapter, s.target, "U1")).toBeUndefined();
		expect(s.ledger.unjudged("U1")).toEqual([]);
		unitWith(s.ledger, "U2", ["wired_ok"]);
		expect(await judgeBeforeAccept(s.ledger, s.adapter, s.target, "U2")).toMatch(/^not judged: wired_ok/);
	});
});
