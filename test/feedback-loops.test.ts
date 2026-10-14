import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../src/config.ts";
import { renderStatus } from "../src/dashboard/status.ts";
import { Ledger } from "../src/ledger/db.ts";
import { FakeModelClient } from "../src/models/fake.ts";
import type { GateInput, GateReport } from "../src/run/gate.ts";
import { runUnit } from "../src/run/unit.ts";
import type { LeafSession, SpawnOptions } from "../src/sessions/spawn.ts";
import { nestjsAdapter } from "../src/adapters/target/nestjs.ts";
import { disputeTestTool, MAX_REPORTS_PER_RUN, reportMigratedBugTool, type ToolDeps } from "../src/sessions/tools.ts";

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
/** The calls without the tester's follow-up turn: these fakes never call check_ported_tests, so each retest gets one (the same session). */
const asked = (calls: Call[]) => calls.filter((c) => !c.task.startsWith("You did not run check_ported_tests"));
const red = (g: GateInput, step: GateReport["failedStep"], output = "1 failing"): GateReport => ({ ok: false, steps: [{ name: step!, ok: false, ms: 1, output }], changedFiles: [], failedStep: step, testFiles: g.testFiles.map((t) => t.path) });
const green = (g: GateInput): GateReport => ({ ok: true, steps: [], changedFiles: [], testFiles: g.testFiles.map((t) => t.path) });

describe("models fix each other's work", () => {
	it("a disputed test goes to the tester; the tester's answer reaches the implementer's next attempt", async () => {
		const calls: Call[] = [];
		let n = 0;
		const gate = async (g: GateInput) => (++n === 1 ? red(g, "ported_tests_green") : green(g));
		await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: sessions(calls, { name: "dispute_test", args: { test: "u1#1", why: "expects true", evidence: "create.cmd.php returns the new id" } }), gate, log: () => {} });
		expect(asked(calls).map((c) => c.role)).toEqual(["implement", "test", "implement"]);
		expect(asked(calls)[1]!.task).toMatch(/The implementer disputes these tests:[\s\S]*u1#1: expects true[\s\S]*returns the new id/);
		expect(asked(calls)[2]!.task).toMatch(/The tester re-checked the questioned tests[\s\S]*u1#1: fixed/);
		expect(ledger.hasEvidence("u1", "test_disputed")).toBe(true);
		// the code is in place: a tester that never ran its tests against it gets one more turn to do so
		expect(calls[2]).toMatchObject({ role: "test", task: expect.stringMatching(/^You did not run check_ported_tests\. The implementer's code is in place/) });
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
		expect(asked(calls).map((c) => c.role)).toEqual(["implement", "test"]);
		expect(asked(calls)[1]!.task).toMatch(/The reviewer finds these tests too weak[\s\S]*only checks it renders/);
		expect(reviews).toBe(2);
		expect(r).toMatchObject({ state: "review", attempts: 1 });
		expect(ledger.db.prepare("SELECT role FROM attempts WHERE unit_id = 'u1' AND role != 'review' ORDER BY id").all()).toEqual([{ role: "implement" }, { role: "test" }, { role: "gate" }]);
	});

	it("a retest that changes an expected value read from the old code after the code exists is recorded and shown to the next review", async () => {
		writeFileSync(join(ws, ".bigrefactor", "legacy-env.json"), JSON.stringify({ root: config.source.path, mode: "read" }));
		ledger.db.prepare("DELETE FROM evidence").run();
		ledger.addEvidence("u1", "truth_read", {});
		ledger.db.prepare("UPDATE truth_cases SET symbol_id = 's', inputs = '[]', expected = '1', verified_on_old = 0").run();
		write(join(ws, ".bigrefactor", "truth", "u1", "cases.json"), '[{"symbol":"s","inputs":[],"expected":1}]');
		const calls: Call[] = [];
		const spawn = (async (opts: SpawnOptions): Promise<LeafSession> => {
			const inner = await (sessions(calls) as unknown as (o: SpawnOptions) => Promise<LeafSession>)(opts);
			return { ...inner, run: async (task: string) => (opts.role === "test" && write(join(ws, ".bigrefactor", "truth", "u1", "cases.json"), '[{"symbol":"s","inputs":[],"expected":2}]'), inner.run(task)) } as LeafSession;
		}) as never;
		const seen: Array<string[] | undefined> = [];
		let reviews = 0;
		const reviewer = async (i: { truthChanged?: string[] }) => (seen.push(i.truthChanged), ++reviews === 1 ? { ok: false, judged: true, output: "weak tests:\n- spec: weak", weakTests: "- spec: weak" } : { ok: true, judged: true, output: "fine" });
		const gate = async (g: GateInput): Promise<GateReport> => {
			const r = await g.review!([]);
			return r.ok ? green(g) : red(g, "wired_ok", r.output);
		};
		await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn, gate, reviewer: reviewer as never, log: () => {} });
		expect(seen[0]).toEqual([]);
		expect(seen[1]).toEqual([expect.stringMatching(/^u1#1 \(s, inputs \[\]\): was 1, the tester made it 2/)]);
		expect(ledger.hasEvidence("u1", "truth_changed_after_code")).toBe(true);
		// a weak-tests round is counted as such, not as a dispute
		expect(ledger.hasEvidence("u1", "tests_weak")).toBe(true);
		expect(ledger.hasEvidence("u1", "test_disputed")).toBe(false);
	});

	it("a review round with fewer open findings than the one before uses no try; one with as many does", async () => {
		const calls: Call[] = [];
		const open = [4, 3, 2, 1, 1, 1, 1, 1, 1, 1];
		let reviews = 0;
		const reviewer = async () => {
			const n = open[reviews++] ?? 1;
			const findings = Array.from({ length: n }, (_, i) => `- src/features/agency/agency.service.ts:${i + 1}: still missing → port it`);
			return { ok: false, judged: true, output: `reviewer findings:\n${findings.join("\n")}`, findings };
		};
		const gate = async (g: GateInput): Promise<GateReport> => {
			const r = await g.review!(["src/features/agency/agency.service.ts"]);
			return r.ok ? green(g) : red(g, "wired_ok", r.output);
		};
		// each try changes the code (an unchanged tree would reuse the last review)
		let edits = 0;
		const spawn = (async (opts: SpawnOptions): Promise<LeafSession> => {
			const inner = await (sessions(calls) as unknown as (o: SpawnOptions) => Promise<LeafSession>)(opts);
			return { ...inner, run: async (task: string) => (opts.role !== "test" && write(join(ws, "migrated", "src/features/agency/agency.service.ts"), `export const v = ${++edits};\n`), inner.run(task)) } as LeafSession;
		}) as never;
		const lines: string[] = [];
		const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn, gate, reviewer, log: (l) => lines.push(l) });
		// 5 tries, plus the 3 rounds that went 4 → 3 → 2 → 1; then 1 → 1 counts again
		expect(asked(calls).filter((c) => c.role !== "test")).toHaveLength(8);
		expect(r).toMatchObject({ state: "quarantined", attempts: 5 });
		expect(lines.join("\n")).toMatch(/open findings went from 4 to 3: getting there, this round uses no try \(1\/5\)/);
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
		expect(asked(calls).map((c) => c.role)).toEqual(["implement", "test", "test"]);
		expect(r).toMatchObject({ state: "review", attempts: 1 });
		expect(JSON.parse(ledger.getUnit("u1")!.meta).weakTestsNote).toMatch(/after 2 tester rounds[\s\S]*only checks it renders/);
		// the owner sees it in br status once the unit is accepted
		ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = 'u1'").run();
		expect(renderStatus(ledger, { color: false })).toMatch(/accepted with tests the reviewer still finds weak \(1\):\n\s+u1: - agency\.service\.spec\.ts: only checks it renders/);
		expect(ledger.db.prepare("SELECT COUNT(*) n FROM questions").get()).toEqual({ n: 0 });
	});

	// disputes and weak tests have their own 2 tester rounds each: the waiver comes only after 2 weak-tests rounds
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
		const testerTasks = asked(calls).filter((c) => c.role === "test").map((c) => c.task);
		expect(testerTasks.filter((t) => /The implementer disputes these tests/.test(t))).toHaveLength(2);
		expect(testerTasks.filter((t) => /The reviewer finds these tests too weak/.test(t))).toHaveLength(2);
		expect(r.state).toBe("review");
		expect(JSON.parse(ledger.getUnit("u1")!.meta).weakTestsNote).toMatch(/after 2 tester rounds/);
	});

	it("a dispute after 2 weak-tests rounds still reaches the tester (its own budget)", async () => {
		const calls: Call[] = [];
		let impls = 0;
		const spawn = (async (opts: SpawnOptions): Promise<LeafSession> =>
			({
				run: async (task: string) => {
					calls.push({ role: opts.role, task });
					if (opts.role !== "test" && ++impls === 3) await (opts.customTools!.find((t) => t.name === "dispute_test") as unknown as { execute: (i: string, p: object) => Promise<unknown> }).execute("x", { test: "u1#1", why: "pins the invented label", evidence: "the legacy label is 'Location ID'" });
					return { text: opts.role === "test" ? "u1#1: fixed — the legacy label\nTESTER DONE 1 cases" : "IMPLEMENTER DONE", toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } };
				},
				dispose() {},
			}) as unknown as LeafSession) as never;
		// two reviews with a code finding and weak tests (an attempt each), then red tests the implementer disputes
		let gates = 0;
		const reviewer = async () => ({ ok: false, judged: true, output: "findings and weak tests", findings: ["- a.ts:1: stub → port it"], weakTests: "- spec: weak" });
		const gate = async (g: GateInput): Promise<GateReport> => {
			const n = ++gates;
			if (n <= 2) return red(g, "wired_ok", (await g.review!([])).output);
			return n === 3 ? red(g, "ported_tests_green") : green(g);
		};
		const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn, gate, reviewer, log: () => {} });
		const testerTasks = asked(calls).filter((c) => c.role === "test").map((c) => c.task);
		expect(testerTasks).toHaveLength(3);
		expect(testerTasks[2]).toMatch(/The implementer disputes these tests:[\s\S]*pins the invented label/);
		expect(r).toMatchObject({ state: "review", attempts: 4 });
	});

	it("on the last attempt a tester fix of a disputed test gets one more gate run on the same code, not a quarantine", async () => {
		config.run.maxImplementAttempts = 1;
		config.run.maxEscalateAttempts = 0;
		const calls: Call[] = [];
		let n = 0;
		const gate = async (g: GateInput) => (++n === 1 ? red(g, "ported_tests_green") : green(g));
		const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: sessions(calls, { name: "dispute_test", args: { test: "u1#1", why: "expects true", evidence: "create.cmd.php returns the new id" } }), gate, log: () => {} });
		expect(asked(calls).map((c) => c.role)).toEqual(["implement", "test"]);
		expect(r).toMatchObject({ state: "review", attempts: 1 });
		expect(ledger.db.prepare("SELECT role, outcome FROM attempts WHERE unit_id = 'u1' AND role != 'review' ORDER BY id").all()).toMatchObject([{ role: "implement", outcome: "gate_red:ported_tests_green" }, { role: "test" }, { role: "gate", outcome: "gate_green" }]);
	});

	it("dispute_test promises a re-check only while the tester has one left", async () => {
		const run = async (disputeRecheck?: boolean) => {
			const r = (await (disputeTestTool({ disputeRecheck } as ToolDeps) as unknown as { execute: (i: string, p: object) => Promise<{ content: Array<{ text: string }> }> }).execute("x", { test: "u1#1", why: "w", evidence: "e" })) as { content: Array<{ text: string }> };
			return r.content[0]!.text;
		};
		expect(await run()).toMatch(/the tester re-checks it/);
		expect(await run(false)).not.toMatch(/the tester re-checks it/);
		expect(await run(false)).toMatch(/re-checks for this unit are used up/);
	});

	it("weak tests only after the tester rounds: triage's retest re-runs the gate on the same code (no implementer with nothing to fix)", async () => {
		// no behaviour: never waved through, so weak-only reviews reach triage once the 2 rounds are spent
		rmSync(join(ws, "migrated", SPEC));
		ledger.db.prepare("DELETE FROM truth_cases").run();
		ledger.addEvidence("u1", "truth_none", { reason: "only constants" });
		const roles: string[] = [];
		let retests = 0;
		const spawn = (async (opts: SpawnOptions): Promise<LeafSession> =>
			({
				run: async () => {
					roles.push(opts.role);
					// each tester run changes its test: a retest that made progress (and a fresh review)
					if (opts.role === "test") write(join(ws, "migrated", SPEC), `it('pins the fee ${++retests}', () => {});\n`);
					return { text: opts.role === "test" ? "TESTER DONE 0 cases" : "IMPLEMENTER DONE", toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } };
				},
				dispose() {},
			}) as unknown as LeafSession) as never;
		let reviews = 0;
		// a different weak test each time: never the same finding twice
		const reviewer = async () => {
			const weak = `- src/features/agency/weak${++reviews}.spec.ts: nothing pins the fee`;
			return { ok: false, judged: true, output: `weak tests:\n${weak}`, weakTests: weak, findings: [] };
		};
		let gates = 0;
		const gate = async (g: GateInput): Promise<GateReport> => {
			if (++gates >= 5) return green(g);
			const r = await g.review!([]);
			return red(g, "wired_ok", r.output);
		};
		const client = new FakeModelClient({ decide: (req) => (req.questions["cause"] ? { cause: "test_bug" } : undefined), chat: () => ({ json: { action: "reimplement", summary: "the tests pin nothing", command: "", note: "" } }) });
		const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn, gate, reviewer, client, log: () => {} });
		// 2 weak-tests rounds (regates), then triage retests: after the second one (a real attempt's gate) the gate re-runs
		expect(roles.filter((x) => x !== "test")).toEqual(["implement", "implement"]);
		expect(r).toMatchObject({ state: "review", attempts: 2 });
		expect(ledger.db.prepare("SELECT role FROM attempts WHERE unit_id = 'u1' AND role NOT IN ('review', 'test') ORDER BY id").all()).toEqual([{ role: "implement" }, { role: "gate" }, { role: "gate" }, { role: "implement" }, { role: "gate" }]);
	});

	it("weak tests only after the tester rounds: triage's retry or escalation goes to the tester, never to an implementer with nothing to fix", async () => {
		rmSync(join(ws, "migrated", SPEC));
		ledger.db.prepare("DELETE FROM truth_cases").run();
		ledger.addEvidence("u1", "truth_none", { reason: "only constants" });
		const roles: string[] = [];
		const tasks: string[] = [];
		let retests = 0;
		const spawn = (async (opts: SpawnOptions): Promise<LeafSession> =>
			({
				run: async (task: string) => {
					roles.push(opts.role);
					tasks.push(task);
					if (opts.role === "test") write(join(ws, "migrated", SPEC), `it('pins the fee ${++retests}', () => {});\n`);
					return { text: opts.role === "test" ? "TESTER DONE 0 cases" : "IMPLEMENTER DONE", toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } };
				},
				dispose() {},
			}) as unknown as LeafSession) as never;
		let reviews = 0;
		const reviewer = async () => {
			const weak = `- src/features/agency/weak${++reviews}.spec.ts: nothing pins the fee`;
			return { ok: false, judged: true, output: `weak tests:\n${weak}`, weakTests: weak, findings: [] };
		};
		let gates = 0;
		const gate = async (g: GateInput): Promise<GateReport> => {
			if (++gates >= 5) return green(g);
			return red(g, "wired_ok", (await g.review!([])).output);
		};
		// the decision model blames the code: its playbook says retry (then escalate)
		const client = new FakeModelClient({ decide: (req) => (req.questions["cause"] ? { cause: "impl_bug" } : undefined) });
		const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn, gate, reviewer, client, log: () => {} });
		expect(roles.filter((x) => x !== "test")).toEqual(["implement", "implement"]);
		expect(roles.filter((x) => x === "test").length).toBeGreaterThanOrEqual(4);
		expect(r).toMatchObject({ state: "review", attempts: 2 });
		// the tester is told only the tests were called weak, never the code's cause
		const forced = tasks.filter((t) => t.includes("Jev judged the cause"));
		expect(forced.length).toBeGreaterThan(0);
		expect(forced.every((t) => t.includes("cause as test_bug") && !t.includes("impl_bug"))).toBe(true);
	});

	it("weak tests only, and the tester changes nothing: no retest after one that did not help, triage's choice stands (no endless tester loop)", async () => {
		rmSync(join(ws, "migrated", SPEC));
		ledger.db.prepare("DELETE FROM truth_cases").run();
		ledger.addEvidence("u1", "truth_none", { reason: "only constants" });
		const roles: string[] = [];
		const spawn = (async (opts: SpawnOptions): Promise<LeafSession> =>
			({
				run: async () => (roles.push(opts.role), { text: opts.role === "test" ? "TESTER DONE 0 cases" : "IMPLEMENTER DONE", toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } }),
				dispose() {},
			}) as unknown as LeafSession) as never;
		const weak = "- src/features/agency/agency.service.spec.ts: nothing pins the fee";
		const reviewer = async () => ({ ok: false, judged: true, output: `weak tests:\n${weak}`, weakTests: weak, findings: [] });
		const gate = async (g: GateInput): Promise<GateReport> => red(g, "wired_ok", (await g.review!([])).output);
		const client = new FakeModelClient({ decide: (req) => (req.questions["cause"] ? { cause: "impl_bug" } : undefined) });
		const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn, gate, reviewer, client, log: () => {} });
		// the 2 weak-tests rounds (regates), then triage's own retries and escalations (as before): the attempt cap ends it
		expect(roles).toEqual(["implement", "test", "test", "implement", "implement", "escalate", "escalate"]);
		expect(r).toMatchObject({ state: "quarantined", attempts: 5 });
	});

	it("the reviewer judges only the unit's own tests; the area's others it gets by path only", async () => {
		const OTHER = "src/features/agency/other.service.spec.ts";
		write(join(ws, "migrated", OTHER), "it('u9#1 lists', () => {});\n");
		const git = (...a: string[]) => execFileSync("git", a, { cwd: join(ws, "migrated"), stdio: "pipe" });
		git("init", "-q");
		git("add", "-A");
		git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
		ledger.db.prepare("UPDATE truth_cases SET ported_test_path = ? WHERE id = 'u1#1'").run(SPEC);
		const seen: Array<{ testFiles?: string[]; otherTests?: string[] }> = [];
		const reviewer = async (i: { testFiles?: string[]; otherTests?: string[] }) => (seen.push({ testFiles: i.testFiles, otherTests: i.otherTests }), { ok: true, judged: true, output: "fine" });
		const gate = async (g: GateInput): Promise<GateReport> => ((await g.review!([])).ok ? green(g) : red(g, "wired_ok"));
		await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: sessions([]), gate, reviewer, log: () => {} });
		expect(seen[0]).toEqual({ testFiles: [SPEC], otherTests: [OTHER] });
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
		expect(asked(calls).map((c) => c.role)).toEqual(["implement", "test"]);
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
		expect(asked(calls).map((c) => c.role)).toEqual(["implement", "test", "implement"]);
		expect(r.attempts).toBe(2);
		// the tester sees what the review told the implementer, so it does not pin the opposite
		expect(asked(calls).find((c) => c.role === "test")!.task).toMatch(/too weak[\s\S]*do not pin the opposite in a test:\n- a\.ts:1: stub → port it/);
	});

	it("on the last attempt weak tests next to a code finding get the tester round, but no extra gate run on the rejected code", async () => {
		config.run.maxImplementAttempts = 1;
		config.run.maxEscalateAttempts = 0;
		const calls: Call[] = [];
		const reviewer = async () => ({ ok: false, judged: true, output: "findings and weak tests", findings: ["- a.ts:1: stub → port it"], weakTests: "- spec: weak" });
		const gate = async (g: GateInput): Promise<GateReport> => {
			const r = await g.review!([]);
			return r.ok ? green(g) : red(g, "wired_ok", r.output);
		};
		const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: sessions(calls), gate, reviewer, log: () => {} });
		expect(asked(calls).map((c) => c.role)).toEqual(["implement", "test"]);
		expect(r.attempts).toBe(1);
		expect(r.state).not.toBe("review");
		expect(ledger.db.prepare("SELECT count(*) AS n FROM attempts WHERE unit_id = 'u1' AND role = 'gate'").get()).toEqual({ n: 0 });
	});

	it("a bug in another unit's accepted code re-opens that unit; this unit waits for it as a dependency", async () => {
		acceptedOwner();
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
		// the wait is no fresh set of tries: the reporter's next run goes on counting
		expect(JSON.parse(ledger.getUnit("u1")!.meta).triesUsed).toBe(1);
	});

	it("a report on a file the reporter changed itself is refused; so is a third report round in one run", async () => {
		acceptedOwner();
		const dir = join(ws, "migrated");
		write(join(dir, "src/shared/money/price.ts"), "export const netPrice = (p: number) => p;\n");
		execFileSync("git", ["init", "-q"], { cwd: dir });
		execFileSync("git", ["add", "-A"], { cwd: dir });
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "main"], { cwd: dir });
		const reports: string[] = [];
		const runStartedAt = new Date(Date.now() - 60_000).toISOString();
		const tool = reportMigratedBugTool({ ledger, config, unitId: "u1", root: ws, targetProjectDir: dir, adapter: nestjsAdapter, runStartedAt, onReport: (r) => reports.push(r.owner) } as ToolDeps) as unknown as { execute: (i: string, p: object) => Promise<{ content: Array<{ text: string }> }> };
		const report = async () => (await tool.execute("x", { target: "src/shared/money/price.ts::netPrice", problem: "ignores the discount", evidence: "money.php line 12" })).content[0]!.text;
		write(join(dir, "src/shared/money/price.ts"), "export const netPrice = (p: number) => p * 2;\n");
		expect(await report()).toMatch(/changed in this unit's own worktree[\s\S]*git diff -- src\/shared\/money\/price\.ts/);
		expect(reports).toEqual([]);
		execFileSync("git", ["checkout", "-q", "--", "."], { cwd: dir });
		// this unit already waited on its reports twice in this run (an earlier run's waits do not count)
		const wait = (at: string) => ledger.db.prepare("INSERT INTO attempts(unit_id, role, started_at, ended_at, outcome) VALUES ('u1', 'implement', ?, ?, 'waits_on_fix')").run(at, at);
		wait(new Date(Date.now() - 3_600_000).toISOString());
		for (let i = 1; i < MAX_REPORTS_PER_RUN; i++) wait(new Date().toISOString());
		expect(await report()).toMatch(/^reported to d1/);
		wait(new Date().toISOString());
		expect(await report()).toMatch(/already waited 2 times this run/);
		expect(reports).toEqual(["d1"]);
	});
});

/** d1 is accepted and wrote src/shared/money/price.ts::netPrice */
function acceptedOwner() {
	ledger.db.prepare("INSERT INTO files(path, hash, lang, updated_at) VALUES ('app/money.php', 'h', 'php', 't')").run();
	ledger.db.prepare("INSERT INTO symbols(id, path, kind, name, state, updated_at) VALUES ('app/money.php::net', 'app/money.php', 'function', 'net', 'accepted', 't')").run();
	ledger.createUnit({ id: "d1", tier: "T0", deps: [], meta: {}, symbolIds: ["app/money.php::net"] });
	ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = 'd1'").run();
	ledger.db.prepare("UPDATE symbols SET state = 'accepted' WHERE id = 'app/money.php::net'").run();
	ledger.db.prepare("INSERT INTO moves(unit_id, src_symbol, op, target_symbols, why, created_at) VALUES ('d1', 'app/money.php::net', 'moved', '[\"src/shared/money/price.ts::netPrice\"]', 'x', 't')").run();
}
