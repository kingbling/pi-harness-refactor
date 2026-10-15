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
import { judgedAtMerge, scopedCheck } from "../src/run/gate.ts";
import { reopenUnjudgedWiring } from "../src/run/recheck.ts";

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
});

describe("a red main: the builder's repair comes first", () => {
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
		const codeJob = async (_s: string, what: string) => {
			jobs.push(what);
			writeFileSync(join(target, "src", "a.txt"), "ok\n");
			await commitAll(target, "fixed by the code job");
			return "fixed a.txt";
		};
		const b = createBuilder({ config, root, ledger, adapters: new Map([["fake", adapter]]), log: () => {}, linkAll: () => {}, mergeFix: async () => undefined, repair: false, codeJob, every: { units: 100, minutes: 600 } });
		return { root, target, ledger, b, jobs };
	}

	it("a merge on a red main waits for the builder's cycle; green again judges the deferred builds of accepted units", async () => {
		const s = await setup();
		unitWith(s.ledger, "U1", ["build_ok"]);
		s.ledger.db.prepare("UPDATE units SET state = 'accepted', updated_at = '2000-01-01T00:00:00.000Z' WHERE id = 'U1'").run();
		// main not known red: nothing to wait for
		expect(await s.b.repairFirst("fake")).toBe(false);
		expect(s.jobs).toEqual([]);
		// the builder found main red earlier (a check after merges)
		s.ledger.setMeta(buildRedKey("fake"), "2026-10-15 a.txt fails");
		expect(await s.b.repairFirst("fake")).toBe(true);
		expect(s.jobs).toHaveLength(1);
		expect(s.ledger.getMeta(buildRedKey("fake"))).toBe("");
		expect(s.ledger.unjudged("U1")).toEqual([]);
		expect(git(s.target, ["log", "-1", "--format=%s"])).toBe("fixed by the code job");
	});

	it("a parked red main does not hold merges (nothing is working on it)", async () => {
		const s = await setup();
		s.ledger.setMeta(buildRedKey("fake"), "red");
		s.ledger.setMeta(buildParkedKey("fake"), "parked");
		expect(await s.b.repairFirst("fake")).toBe(false);
		expect(s.jobs).toEqual([]);
	});
});
