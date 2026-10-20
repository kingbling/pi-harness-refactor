import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { nestjsAdapter } from "../src/adapters/target/nestjs.ts";
import { ConfigSchema, type Config } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { othersTestsChanged, type GateInput, type GateReport } from "../src/run/gate.ts";
import { ownTests } from "../src/run/ported.ts";
import { runUnit } from "../src/run/unit.ts";
import type { LeafSession, SpawnOptions } from "../src/sessions/spawn.ts";
import { checkPortedTestsTool } from "../src/sessions/tools.ts";

/**
 * The tester sees what decides its tests' fate while it works: build and lint on its own tests only (neighbours'
 * errors are not its to fix), earlier units' test files it changed (undone at the end), and after the implementer
 * worked, its tests run against the code. A neighbour test the implementer disputed is fixed by the tester and kept.
 */
const here = resolve(import.meta.dirname, "..");
let ws: string;
let target: string;
let config: Config;
let ledger: Ledger;
const write = (p: string, s = "x\n") => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, s));
const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: target, stdio: "pipe" });
const SPEC = "src/features/agency/agency.service.spec.ts";
const LIST = "src/features/agency/agency.list.spec.ts"; // an earlier unit's
const OTHER = "src/features/agency/agency.other.spec.ts"; // another earlier unit's
const truth = () => ({ ok: true, cases: [{ symbol: "s", inputs: [], expected: 1 }] });
const exec = async (t: unknown) => (await (t as { execute: (i: string, p: object) => Promise<{ content: Array<{ text: string }> }> }).execute("x", {})).content[0]!.text;
const ok = { toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } };

beforeEach(() => {
	ws = join(here, ".sim", "tester-neighbour-tests");
	rmSync(ws, { recursive: true, force: true });
	target = join(ws, "migrated");
	write(join(ws, "legacy", "app", "agency", "create.cmd.php"), "<?php\n");
	config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: target, stacks: ["nestjs"] }, models: {} });
	write(join(target, "package.json"), "{}");
	write(join(target, LIST), "it('u0#1 lists', () => {});\n");
	write(join(target, OTHER), "it('u9#1 other', () => {});\n");
	git("init", "-q");
	git("add", "-A");
	git("commit", "-qm", "base");
	mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
	ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
	ledger.createUnit({ id: "u1", tier: "T1", deps: [], meta: { files: ["app/agency/create.cmd.php"], place: { stack: "nestjs", area: "agency", shared: false, source: "code" } }, symbolIds: [] });
	write(join(ws, ".bigrefactor", "truth", "u1", "interface.md"), "src/features/agency/agency.service.ts exports AgencyService\n");
});

describe("check_ported_tests", () => {
	const lintEcho = { ...nestjsAdapter, lint: (_d: string, files: string[]) => ({ cmd: "sh", args: ["-c", 'echo "linted: $*" >&2; exit 1', "sh", ...files] }) };
	const tool = (more: object = {}, adapter: typeof nestjsAdapter = lintEcho) => checkPortedTestsTool({ ledger, config, unitId: "u1", root: ws, targetProjectDir: target, adapter, moduleDir: "src/features/agency", currentTruth: truth, ...more });

	it("builds and lints only the unit's own tests, not an earlier unit's file next to them", async () => {
		write(join(target, SPEC), "it('u1#1 creates', () => {});\n");
		const out = await exec(tool());
		expect(out).toMatch(/LINT FAILED[\s\S]*linted: src\/features\/agency\/agency\.service\.spec\.ts/);
		expect(out).not.toMatch(/linted: .*agency\.list\.spec\.ts/);
		// coverage still searches all of them
		expect(out).toContain(LIST);
	});

	it("names an earlier unit's test file the tester changed, unless the run sanctioned it", async () => {
		write(join(target, LIST), "it('u0#1 lists', () => {}); it('u1#1 creates', () => {});\n");
		const out = await exec(tool());
		expect(out).toContain(`${LIST} holds tests of earlier units; you changed or removed lines there, and that is undone when you finish`);
		expect(out).toMatch(/Adding new tests or fixtures to it is fine[^\n]*call dispute_test/);
		// only added lines: nothing to undo, nothing named
		write(join(target, LIST), "it('u0#1 lists', () => {});\nit('u1#1 creates', () => {});\n");
		expect(await exec(tool())).not.toContain(`${LIST} holds tests of earlier units`);
		write(join(target, LIST), "it('u0#1 lists', () => {}); it('u1#1 creates', () => {});\n");
		expect(out).toMatch(/new test file next to it that the layout allows/);
		expect(await exec(tool({ sanctioned: [LIST] }))).not.toContain(`${LIST} holds tests of earlier units`);
	});

	it("runs the tests only once the implementer's code is in place, and says what a failure there means", async () => {
		write(join(target, SPEC), "it('u1#1 creates', () => {});\n");
		const adapter = { ...nestjsAdapter, lint: () => ({ cmd: "true", args: [] }), test: (_d: string, files: string[]) => ({ cmd: "sh", args: ["-c", 'echo "FAIL $1 u1#1"; exit 1', "sh", ...files] }) };
		expect(await exec(tool({}, adapter))).not.toMatch(/TESTS/);
		const out = await exec(tool({ codeWritten: true }, adapter));
		expect(out).toMatch(/TESTS FAILED: the implementer's code is in place: a test that fails here is either wrong[\s\S]*FAIL src\/features\/agency\/agency\.service\.spec\.ts u1#1/);
	});

	it("outside a git checkout every test counts as the unit's own", async () => {
		const dir = mkdtempSync(join(tmpdir(), "br-nogit-"));
		expect(await ownTests(ledger, "u1", dir, [SPEC, LIST])).toEqual([SPEC, LIST]);
	});
});

describe("tests of earlier units in a retest", () => {
	const red = (g: GateInput): GateReport => ({ ok: false, steps: [{ name: "ported_tests_green", ok: false, ms: 1, output: `FAIL ${LIST} #1` }], changedFiles: [], failedStep: "ported_tests_green", testFiles: g.testFiles.map((t) => t.path) });
	const green = (g: GateInput): GateReport => ({ ok: true, steps: [], changedFiles: [], testFiles: g.testFiles.map((t) => t.path) });

	it("a disputed one the tester fixes is kept and the gate allows it; one not disputed is still undone", async () => {
		write(join(target, SPEC), "it('u1#1 creates', () => {});\n");
		git("add", "-A");
		git("commit", "-qm", "own");
		ledger.addEvidence("u1", "truth_green_on_old", {});
		ledger.db.prepare("INSERT INTO truth_cases(id, unit_id, symbol_id, inputs, expected, verified_on_old, created_at) VALUES ('u1#1','u1','s','[]','1',1,'t')").run();
		let implementer = 0;
		const spawn = async (opts: SpawnOptions): Promise<LeafSession> =>
			({
				run: async () => {
					if (opts.role === "test") {
						write(join(target, LIST), "it('u0#1 lists every day', () => {});\n");
						write(join(target, OTHER), "it('u9#1 rewritten', () => {});\n");
					} else if (++implementer === 1) {
						const t = opts.customTools!.find((x) => x.name === "dispute_test") as unknown as { execute: (i: string, p: object) => Promise<unknown> };
						await t.execute("x", { test: "agency.list.spec.ts #1", why: "expects one row", evidence: "openhours.vue.tpl.php renders 7 rows" });
					}
					return { text: opts.role === "test" ? "agency.list.spec.ts #1: fixed — 7 rows\nTESTER DONE" : "IMPLEMENTER DONE", ...ok };
				},
				dispose() {},
			}) as unknown as LeafSession;
		let n = 0;
		let flagged: string[] | undefined;
		let sanctioned: string[] = [];
		const gate = async (g: GateInput) => {
			if (++n === 1) return red(g);
			sanctioned = g.sanctioned ?? [];
			flagged = await othersTestsChanged(target, "u1", (f) => nestjsAdapter.layout.isTestFile(f), g.sanctioned);
			return green(g);
		};
		await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: spawn as never, gate, log: () => {} });
		expect(readFileSync(join(target, LIST), "utf8")).toContain("every day");
		expect(readFileSync(join(target, OTHER), "utf8")).toContain("u9#1 other");
		expect(sanctioned).toContain(LIST);
		expect(flagged).toEqual([]);
	});

	it("lines only added to an earlier unit's file are kept; a changed line the tester disputes with evidence is kept too; one it does not is undone", async () => {
		write(join(target, SPEC), "it('u1#1 creates', () => {});\n");
		git("add", "-A");
		git("commit", "-qm", "own");
		const third = "src/features/agency/agency.third.spec.ts";
		write(join(target, third), "it('u7#1 third', () => {});\n");
		git("add", "-A");
		git("commit", "-qm", "third");
		ledger.addEvidence("u1", "truth_green_on_old", {});
		ledger.db.prepare("INSERT INTO truth_cases(id, unit_id, symbol_id, inputs, expected, verified_on_old, created_at) VALUES ('u1#1','u1','s','[]','1',1,'t')").run();
		let implementer = 0;
		let testerRounds = 0;
		const dispute = (opts: SpawnOptions) => opts.customTools!.find((x) => x.name === "dispute_test") as unknown as { execute: (i: string, p: object) => Promise<unknown> };
		const spawn = async (opts: SpawnOptions): Promise<LeafSession> =>
			({
				run: async () => {
					if (opts.role === "test") {
						testerRounds++;
						write(join(target, LIST), "it('u0#1 lists', () => {});\nit('u1#1 lists with the new partner', () => {});\n");
						write(join(target, OTHER), "it('u9#1 other, fixture builds a concrete partner', () => {});\n");
						write(join(target, third), "it('u7#1 rewritten', () => {});\n");
						await dispute(opts).execute("x", { test: OTHER, why: "its fixture is an anonymous class the new final partner cannot be", evidence: "LocationPartner.php:12 is a concrete class" });
					} else if (++implementer === 1) {
						// the implementer disputes its own unit's test: that sends the tester in (it names no earlier unit's file)
						await dispute(opts).execute("x", { test: "agency.service.spec.ts #1", why: "expects 1", evidence: "create.cmd.php returns 2" });
					}
					return { text: opts.role === "test" ? "TESTER DONE" : "IMPLEMENTER DONE", ...ok };
				},
				dispose() {},
			}) as unknown as LeafSession;
		let flagged: string[] | undefined;
		let n = 0;
		const log: string[] = [];
		// the first gate is red on the tests, so the tester gets a round
		const gate = async (g: GateInput) => (++n === 1 ? red(g) : ((flagged = await othersTestsChanged(target, "u1", (f) => nestjsAdapter.layout.isTestFile(f), g.sanctioned)), green(g)));
		await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: spawn as never, gate, log: (l) => log.push(l) });
		expect(testerRounds).toBeGreaterThan(0);
		expect(readFileSync(join(target, LIST), "utf8")).toContain("with the new partner");
		expect(readFileSync(join(target, OTHER), "utf8")).toContain("concrete partner");
		expect(readFileSync(join(target, third), "utf8")).toContain("u7#1 third");
		expect(flagged).toEqual([]);
		expect(log.join("\n")).toMatch(/tester disputes an earlier unit's test, change kept: src\/features\/agency\/agency\.other\.spec\.ts/);
		// a restart keeps it allowed
		expect(JSON.parse(ledger.getMeta("tests_disputed:u1")!)).toEqual([OTHER]);
	});

	it("the unit's own test merged in a folder it moved away from is its tester's to fix, move or delete", async () => {
		const STRAY = "src/shared/common/agency.old.spec.ts";
		write(join(target, STRAY), "it('u1#2 old place', () => {});\n");
		git("add", "-A");
		git("commit", "-qm", "u1 before it moved");
		ledger.endAttempt(ledger.startAttempt("u1", "implement"), { outcome: "gate_green", gateReport: { changedFiles: [STRAY] } });
		ledger.addEvidence("u1", "truth_green_on_old", {});
		ledger.db.prepare("INSERT INTO truth_cases(id, unit_id, symbol_id, inputs, expected, verified_on_old, created_at) VALUES ('u1#1','u1','s','[]','1',1,'t')").run();
		const globs: string[][] = [];
		const spawn = async (opts: SpawnOptions): Promise<LeafSession> =>
			({
				run: async () => (opts.role === "test" && globs.push(opts.writeGlobs), { text: opts.role === "test" ? "TESTER DONE" : "IMPLEMENTER DONE", ...ok }),
				dispose() {},
			}) as unknown as LeafSession;
		// no test in its folder yet: the tester runs, and may write the old one
		let sanctioned: string[] = [];
		const gate = async (g: GateInput) => ((sanctioned = g.sanctioned ?? []), green(g));
		await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: spawn as never, gate, log: () => {} });
		expect(globs[0]).toContain(`migrated/${STRAY}`);
		// with its test in place the gate runs and does not take a change there for an earlier unit's
		write(join(target, SPEC), "it('u1#1 creates', () => {});\n");
		git("add", "-A");
		git("commit", "-qm", "own");
		ledger.db.prepare("UPDATE units SET state = 'planned' WHERE id = 'u1'").run();
		await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: spawn as never, gate, log: () => {} });
		expect(sanctioned).toContain(STRAY);
	});

	it("a coverage retest is told the ids it wrote into an earlier unit's file were undone", async () => {
		ledger.addEvidence("u1", "truth_green_on_old", {});
		ledger.db.prepare("INSERT INTO truth_cases(id, unit_id, symbol_id, inputs, expected, verified_on_old, created_at) VALUES ('u1#1','u1','s','[]','1',1,'t')").run();
		const tasks: string[] = [];
		const spawn = async (opts: SpawnOptions): Promise<LeafSession> =>
			({
				run: async (task: string) => {
					if (opts.role === "test") {
						tasks.push(task);
						write(join(target, LIST), "it('u1#1 creates', () => {});\n");
					}
					return { text: "TESTER DONE", ...ok };
				},
				dispose() {},
			}) as unknown as LeafSession;
		await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: spawn as never, gate: async (g) => ({ ok: true, steps: [], changedFiles: [], testFiles: g.testFiles.map((t) => t.path) }), log: () => {} });
		expect(tasks).toHaveLength(2);
		expect(tasks[0]).not.toContain("were undone");
		expect(tasks[1]).toContain(`(Your changes to tests of earlier units were undone: ${LIST}.`);
	});
});
