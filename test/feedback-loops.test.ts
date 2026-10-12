import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../src/config.ts";
import { renderStatus } from "../src/dashboard/status.ts";
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
		const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: sessions(calls), gate, reviewer, log: () => {} });
		// the code was fine: after the retest the gate runs again on it, no new implementer session, no attempt counted
		expect(calls.map((c) => c.role)).toEqual(["implement", "test"]);
		expect(calls[1]!.task).toMatch(/The reviewer finds these tests too weak[\s\S]*only checks it renders/);
		expect(reviews).toBe(2);
		expect(r).toMatchObject({ state: "review", attempts: 1 });
		expect(ledger.db.prepare("SELECT role FROM attempts WHERE unit_id = 'u1' AND role != 'review' ORDER BY id").all()).toEqual([{ role: "implement" }, { role: "test" }, { role: "gate" }]);
	});

	it("tests still called weak after 2 tester rounds: the code passes with a note on the unit, no owner question", async () => {
		const calls: Call[] = [];
		const weak = "- agency.service.spec.ts: only checks it renders";
		const reviewer = async () => ({ ok: false, judged: true, output: `weak tests (the tester rewrites them):\n${weak}`, weakTests: weak, findings: [] });
		const gate = async (g: GateInput): Promise<GateReport> => {
			const r = await g.review!([]);
			return r.ok ? green(g) : red(g, "wired_ok", r.output);
		};
		const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: sessions(calls), gate, reviewer, log: () => {} });
		expect(calls.map((c) => c.role)).toEqual(["implement", "test", "test"]);
		expect(r).toMatchObject({ state: "review", attempts: 1 });
		expect(JSON.parse(ledger.getUnit("u1")!.meta).weakTestsNote).toMatch(/after 2 tester rounds[\s\S]*only checks it renders/);
		// the owner sees it in br status once the unit is accepted
		ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = 'u1'").run();
		expect(renderStatus(ledger, { color: false })).toMatch(/accepted with tests the reviewer still finds weak \(1\):\n\s+u1: - agency\.service\.spec\.ts: only checks it renders/);
		expect(ledger.db.prepare("SELECT COUNT(*) n FROM questions").get()).toEqual({ n: 0 });
	});

	it("tester rounds spent on disputes do not count toward the weak-tests pass: weak tests are never waved through untried", async () => {
		const calls: Call[] = [];
		const weak = "- agency.service.spec.ts: only checks it renders";
		// the implementer disputes a test in every attempt; the first two gates fail on the tests, then only the review is red
		const spawn = (async (opts: SpawnOptions): Promise<LeafSession> =>
			({
				run: async (task: string) => {
					calls.push({ role: opts.role, task });
					if (opts.role !== "test") await (opts.customTools!.find((t) => t.name === "dispute_test") as unknown as { execute: (i: string, p: object) => Promise<unknown> }).execute("x", { test: "u1#1", why: "expects true", evidence: "returns the id" });
					return { text: opts.role === "test" ? "u1#1: kept — the legacy code returns true\nTESTER DONE 1 cases" : "IMPLEMENTER DONE", toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } };
				},
				dispose() {},
			}) as unknown as LeafSession) as never;
		let gates = 0;
		const reviewer = async () => ({ ok: false, judged: true, output: `weak tests (the tester rewrites them):\n${weak}`, weakTests: weak, findings: [] });
		const gate = async (g: GateInput): Promise<GateReport> => {
			if (++gates <= 2) return red(g, "ported_tests_green");
			const r = await g.review!([]);
			return r.ok ? green(g) : red(g, "wired_ok", r.output);
		};
		const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn, gate, reviewer, log: () => {} });
		expect(r.state).not.toBe("review");
		expect(JSON.parse(ledger.getUnit("u1")!.meta).weakTestsNote).toBeUndefined();
	});

	it("a unit with no behaviour to pin and no tests is never passed on weak tests: the reviewer says it computes something", async () => {
		rmSync(join(ws, "migrated", SPEC));
		ledger.db.prepare("DELETE FROM truth_cases").run();
		ledger.addEvidence("u1", "truth_none", { reason: "only constants" });
		const calls: Call[] = [];
		// the tester writes no test (it says again there is nothing to pin)
		const spawn = (async (opts: SpawnOptions): Promise<LeafSession> =>
			({
				run: async (task: string) => (calls.push({ role: opts.role, task }), { text: opts.role === "test" ? "TESTER DONE 0 cases" : "IMPLEMENTER DONE", toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } }),
				dispose() {},
			}) as unknown as LeafSession) as never;
		const weak = "- the unit computes the agency fee: nothing pins it";
		const reviewer = async () => ({ ok: false, judged: true, output: `weak tests:\n${weak}`, weakTests: weak, findings: [] });
		const gate = async (g: GateInput): Promise<GateReport> => {
			const r = await g.review!([]);
			return r.ok ? green(g) : red(g, "wired_ok", r.output);
		};
		const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn, gate, reviewer, log: () => {} });
		expect(calls.filter((c) => c.role === "test")).toHaveLength(2);
		expect(r.state).not.toBe("review");
		expect(JSON.parse(ledger.getUnit("u1")!.meta).weakTestsNote).toBeUndefined();
	});

	it("the reviewer cannot judge a re-gate: the review runs again on the same code, no implementer session, no attempt given back", async () => {
		const calls: Call[] = [];
		let reviews = 0;
		const weak = "- agency.service.spec.ts: only checks it renders";
		const reviewer = async () => {
			const n = ++reviews;
			if (n === 1) return { ok: false, judged: true, output: `weak tests:\n${weak}`, weakTests: weak, findings: [] };
			if (n === 2) return { ok: false, judged: false, output: "not judged: the reviewer model is down" };
			return { ok: true, judged: true, output: "fine" };
		};
		const gate = async (g: GateInput): Promise<GateReport> => {
			const r = await g.review!([]);
			return r.ok ? green(g) : red(g, "wired_ok", r.output);
		};
		const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: sessions(calls), gate, reviewer, log: () => {} });
		expect(calls.map((c) => c.role)).toEqual(["implement", "test"]);
		expect(reviews).toBe(3);
		expect(r).toMatchObject({ state: "review", attempts: 1 });
	});

	it("weak tests next to a code finding still cost the implementer an attempt", async () => {
		const calls: Call[] = [];
		let reviews = 0;
		const reviewer = async () => (++reviews === 1 ? { ok: false, judged: true, output: "findings and weak tests", findings: ["- a.ts:1: stub → port it"], weakTests: "- spec: weak" } : { ok: true, judged: true, output: "fine" });
		const gate = async (g: GateInput): Promise<GateReport> => {
			const r = await g.review!([]);
			return r.ok ? green(g) : red(g, "wired_ok", r.output);
		};
		const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: sessions(calls), gate, reviewer, log: () => {} });
		expect(calls.map((c) => c.role)).toEqual(["implement", "test", "implement"]);
		expect(r.attempts).toBe(2);
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
