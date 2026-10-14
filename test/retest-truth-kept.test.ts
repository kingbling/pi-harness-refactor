import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { saveCommandOverride } from "../src/adapters/command-overrides.ts";
import { ConfigSchema, type Config } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import type { GateInput, GateReport } from "../src/run/gate.ts";
import { runUnit } from "../src/run/unit.ts";
import type { LeafSession, SpawnOptions } from "../src/sessions/spawn.ts";

/**
 * A retest from the implement loop on a unit whose truth is already recorded: reused read truth is loaded from
 * cases.json (not from a script that never ran green), and a truth change that does not load is put back, so the
 * recorded cases stand and the attempt is no red truth.
 */
const here = resolve(import.meta.dirname, "..");
let ws: string;
let config: Config;
let ledger: Ledger;
const write = (p: string, s = "x\n") => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, s));
const SPEC = "src/features/agency/agency.service.spec.ts";
const CASES = JSON.stringify([{ symbol: "s", inputs: [], expected: 1 }]);
const truthDir = () => join(ws, ".bigrefactor", "truth", "u1");

beforeEach(() => {
	ws = join(here, ".sim", "retest-truth-kept");
	rmSync(ws, { recursive: true, force: true });
	write(join(ws, "legacy", "app", "agency", "create.cmd.php"), "<?php\n");
	config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, models: {} });
	write(join(ws, "migrated", "package.json"), "{}");
	write(join(ws, "migrated", SPEC), "it('u1#1 creates', () => {});\n");
	mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
	ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
	ledger.createUnit({ id: "u1", tier: "T1", deps: [], meta: { files: ["app/agency/create.cmd.php"], place: { stack: "nestjs", area: "agency", shared: false, source: "code" } }, symbolIds: [] });
	write(join(truthDir(), "interface.md"), "src/features/agency/agency.service.ts exports AgencyService\n");
	// read truth: the script did not run green on the old code (the workspace itself runs the old code)
	write(join(truthDir(), "cases.json"), CASES);
	ledger.addEvidence("u1", "truth_read", { cases: 1, why: "the script did not run green on the old code" });
	ledger.db.prepare("INSERT INTO truth_cases(id, unit_id, symbol_id, inputs, expected, verified_on_old, created_at) VALUES ('u1#1','u1','s','[]','1',0,'t')").run();
	// fixture lint and test commands: the stack's own (npx eslint / npx jest) reach the npm registry when nothing is installed here
	saveCommandOverride(ws, "nestjs", "lint", { cmd: "sh", args: ["-c", "exit 0", "sh", "{files}"] }, "fixture lint");
	saveCommandOverride(ws, "nestjs", "test", { cmd: "sh", args: ["-c", "echo '1 failing'; exit 1", "sh", "{files}"] }, "fixture runner");
});

type Exec = { execute: (i: string, p: object) => Promise<{ content: Array<{ text: string }> }> };
/** The implementer disputes a test once (a retest follows); the tester runs `tester` and then check_ported_tests. */
const sessions = (tester: () => void, checks: string[]) =>
	(async (opts: SpawnOptions): Promise<LeafSession> =>
		({
			run: async () => {
				const tool = (n: string) => opts.customTools!.find((t) => t.name === n) as unknown as Exec;
				if (opts.role === "test") {
					tester();
					checks.push((await tool("check_ported_tests").execute("x", {})).content[0]!.text);
				} else if (!checks.length) await tool("dispute_test").execute("x", { test: "u1#1", why: "expects true", evidence: "returns the id" });
				return { text: opts.role === "test" ? "TESTER DONE 1 cases" : "IMPLEMENTER DONE", toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } };
			},
			dispose() {},
		}) as unknown as LeafSession) as never;
const red = (g: GateInput): GateReport => ({ ok: false, steps: [{ name: "ported_tests_green", ok: false, ms: 1, output: "1 failing" }], changedFiles: [], failedStep: "ported_tests_green", testFiles: g.testFiles.map((t) => t.path) });
const green = (g: GateInput): GateReport => ({ ok: true, steps: [], changedFiles: [], testFiles: g.testFiles.map((t) => t.path) });
const testOutcomes = () => (ledger.db.prepare("SELECT outcome, gate_report FROM attempts WHERE unit_id = 'u1' AND role = 'test' ORDER BY id").all() as Array<{ outcome: string; gate_report: string }>);

describe("a retest keeps the recorded truth", () => {
	it("reused read truth is loaded from cases.json in a retest: no 'cases do not load', no red truth", async () => {
		const checks: string[] = [];
		let n = 0;
		await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: sessions(() => {}, checks), gate: async (g) => (++n === 1 ? red(g) : green(g)), log: () => {} });
		expect(checks.length).toBeGreaterThan(0);
		for (const c of checks) expect(c).not.toMatch(/do not load/);
		expect(checks[0]).toMatch(/All 1 case id\(s\) found/);
		expect(testOutcomes().map((a) => a.outcome)).toEqual(["truth_green"]);
		expect(JSON.parse(testOutcomes()[0]!.gate_report)).toMatchObject({ mode: "read", cases: 1 });
	});

	it("a truth change in a retest that does not load is put back; the recorded cases stand and the attempt is not red", async () => {
		const checks: string[] = [];
		let n = 0;
		const logs: string[] = [];
		await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: sessions(() => write(join(truthDir(), "cases.json"), "[]"), checks), gate: async (g) => (++n === 1 ? red(g) : green(g)), log: (l) => logs.push(l) });
		expect(readFileSync(join(truthDir(), "cases.json"), "utf8")).toBe(CASES);
		const [a] = testOutcomes();
		expect(a!.outcome).toBe("tests_only");
		expect(JSON.parse(a!.gate_report)).toMatchObject({ truthKept: true, restored: ["cases.json"] });
		expect(ledger.db.prepare("SELECT id FROM truth_cases WHERE unit_id = 'u1'").all()).toEqual([{ id: "u1#1" }]);
		expect(logs.join("\n")).toMatch(/does not load after the retest[\s\S]*put back cases\.json/);
	});
});
