import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import type { GateInput, GateReport } from "../src/run/gate.ts";
import { runUnit } from "../src/run/unit.ts";
import type { LeafSession, SpawnOptions } from "../src/sessions/spawn.ts";

/**
 * One model tells another to fix things after it handed its work in: the implementer disputes a test (the tester
 * re-checks it, its answer reaches the implementer), the reviewer finds tests weak (they go to the tester, not the
 * implementer), a later unit finds a bug in accepted code (that unit re-opens, this one waits for it).
 */
const here = resolve(import.meta.dirname, "..");
let ws: string;
let config: Config;
let ledger: Ledger;
const write = (p: string, s = "x\n") => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, s));
const SPEC = "src/features/agency/agency.service.spec.ts";

beforeEach(() => {
	ws = join(here, ".sim", "feedback-loops");
	rmSync(ws, { recursive: true, force: true });
	write(join(ws, "legacy", "app", "agency", "create.cmd.php"), "<?php\n");
	config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, models: {} });
	write(join(ws, "migrated", "package.json"), "{}");
	write(join(ws, "migrated", SPEC), "it('u1#1 creates', () => {});\n");
	mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
	ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
	ledger.createUnit({ id: "u1", tier: "T1", deps: [], meta: { files: ["app/agency/create.cmd.php"], place: { stack: "nestjs", area: "agency", shared: false, source: "code" } }, symbolIds: [] });
	write(join(ws, ".bigrefactor", "truth", "u1", "interface.md"), "src/features/agency/agency.service.ts exports AgencyService\n");
	ledger.addEvidence("u1", "truth_green_on_old", {});
	ledger.db.prepare("INSERT INTO truth_cases(id, unit_id, symbol_id, inputs, expected, verified_on_old, created_at) VALUES ('u1#1','u1','s','[]','1',1,'t')").run();
});

type Call = { role: string; task: string };
/** Sessions that log what they were asked and, as implementer, call the given tool once. */
const sessions = (calls: Call[], implementerTool?: { name: string; args: object }) =>
	(async (opts: SpawnOptions): Promise<LeafSession> =>
		({
			run: async (task: string) => {
				calls.push({ role: opts.role, task });
				if (opts.role === "test") write(join(ws, "migrated", SPEC), "it('u1#1 creates an agency with its id', () => {});\n");
				const tool = implementerTool && opts.role !== "test" && calls.filter((c) => c.role !== "test").length === 1 ? opts.customTools!.find((t) => t.name === implementerTool.name) : undefined;
				if (tool) await (tool as unknown as { execute: (i: string, p: object) => Promise<unknown> }).execute("x", implementerTool!.args);
				return { text: opts.role === "test" ? "u1#1: fixed — the legacy code returns the new id, not true\nTESTER DONE 1 cases" : "IMPLEMENTER DONE", toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } };
			},
			dispose() {},
		}) as unknown as LeafSession) as never;
const red = (g: GateInput, step: GateReport["failedStep"], output = "1 failing"): GateReport => ({ ok: false, steps: [{ name: step!, ok: false, ms: 1, output }], changedFiles: [], failedStep: step, testFiles: g.testFiles.map((t) => t.path) });
const green = (g: GateInput): GateReport => ({ ok: true, steps: [], changedFiles: [], testFiles: g.testFiles.map((t) => t.path) });

describe("models fix each other's work", () => {
	it("a disputed test goes to the tester; the tester's answer reaches the implementer's next attempt", async () => {
		const calls: Call[] = [];
		let n = 0;
		const gate = async (g: GateInput) => (++n === 1 ? red(g, "ported_tests_green") : green(g));
		await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: sessions(calls, { name: "dispute_test", args: { test: "u1#1", why: "expects true", evidence: "create.cmd.php returns the new id" } }), gate, log: () => {} });
		expect(calls.map((c) => c.role)).toEqual(["implement", "test", "implement"]);
		expect(calls[1]!.task).toMatch(/The implementer disputes these tests:[\s\S]*u1#1: expects true[\s\S]*returns the new id/);
		expect(calls[2]!.task).toMatch(/The tester re-checked the questioned tests[\s\S]*u1#1: fixed/);
		expect(ledger.hasEvidence("u1", "test_disputed")).toBe(true);
	});

	it("weak tests the reviewer finds go to the tester, not to the implementer as code findings", async () => {
		const calls: Call[] = [];
		let reviews = 0;
		const reviewer = async () => (++reviews === 1 ? { ok: false, judged: true, output: "weak tests (the tester rewrites them):\n- agency.service.spec.ts: only checks it renders", weakTests: "- agency.service.spec.ts: only checks it renders" } : { ok: true, judged: true, output: "fine" });
		const gate = async (g: GateInput): Promise<GateReport> => {
			const r = await g.review!([]);
			return r.ok ? green(g) : red(g, "wired_ok", r.output);
		};
		await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: sessions(calls), gate, reviewer, log: () => {} });
		expect(calls.map((c) => c.role)).toEqual(["implement", "test", "implement"]);
		expect(calls[1]!.task).toMatch(/The reviewer finds these tests too weak[\s\S]*only checks it renders/);
	});

	it("a bug in another unit's accepted code re-opens that unit; this unit waits for it as a dependency", async () => {
		ledger.db.prepare("INSERT INTO files(path, hash, lang, updated_at) VALUES ('app/money.php', 'h', 'php', 't')").run();
		ledger.db.prepare("INSERT INTO symbols(id, path, kind, name, state, updated_at) VALUES ('app/money.php::net', 'app/money.php', 'function', 'net', 'accepted', 't')").run();
		ledger.createUnit({ id: "d1", tier: "T0", deps: [], meta: {}, symbolIds: ["app/money.php::net"] });
		ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = 'd1'").run();
		ledger.db.prepare("UPDATE symbols SET state = 'accepted' WHERE id = 'app/money.php::net'").run();
		ledger.db.prepare("INSERT INTO moves(unit_id, src_symbol, op, target_symbols, why, created_at) VALUES ('d1', 'app/money.php::net', 'moved', '[\"src/shared/money/price.ts::netPrice\"]', 'x', 't')").run();
		const calls: Call[] = [];
		let gates = 0;
		const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: sessions(calls, { name: "report_migrated_bug", args: { target: "src/shared/money/price.ts::netPrice", problem: "ignores the agency discount", evidence: "money.php line 12 subtracts it" } }), gate: async (g) => (gates++, green(g)), log: () => {} });
		expect(r.state).toBe("planned");
		expect(gates).toBe(0);
		expect(ledger.getUnit("d1")!.state).toBe("planned");
		expect(JSON.parse(ledger.getUnit("d1")!.meta).retryNote).toMatch(/u1 uses your accepted code[\s\S]*ignores the agency discount/);
		expect(ledger.getSymbol("app/money.php::net")!.state).toBe("clustered");
		expect(JSON.parse(ledger.getUnit("u1")!.deps)).toContain("d1");
		expect(ledger.hasEvidence("d1", "bug_reported")).toBe(true);
	});
});
