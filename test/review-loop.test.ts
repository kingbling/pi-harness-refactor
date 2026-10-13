import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { saveCommandOverride } from "../src/adapters/command-overrides.ts";
import { nestjsAdapter } from "../src/adapters/target/nestjs.ts";
import { ConfigSchema, type Config } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import type { GateInput, GateReport } from "../src/run/gate.ts";
import { reviewWithModel, type ReviewInput } from "../src/run/review.ts";
import { runUnit } from "../src/run/unit.ts";
import type { LeafSession, SpawnOptions } from "../src/sessions/spawn.ts";

/**
 * Fewer wasted tries between implementer, tester and reviewer: DONE after a red check_my_code gets one more turn
 * (red tests it disputes go straight to the tester), the implementer answers the reviewer (its final message,
 * dispute_finding), unchanged code keeps the last verdict, and weak-tests-only reviews are not implementer failures.
 */
const here = resolve(import.meta.dirname, "..");
let ws: string;
let config: Config;
let ledger: Ledger;
const write = (p: string, s = "x\n") => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, s));
const SPEC = "src/features/agency/agency.service.spec.ts";
const CODE = "src/features/agency/agency.service.ts";
const exec = (opts: SpawnOptions, name: string, args: object = {}) => (opts.customTools!.find((t) => t.name === name) as unknown as { execute: (i: string, p: object) => Promise<unknown> }).execute("x", args);
const usage = { input: 0, output: 0, cost: 0 };
type Session = (opts: SpawnOptions, task: string, n: number) => Promise<string>;
/** Fake sessions: `impl` / `tester` act and return the final text; n counts that role's runs. */
const sessions = (calls: Array<{ role: string; task: string }>, impl: Session, tester: Session = async () => "TESTER DONE 1 cases") => {
	const runs: Record<string, number> = {};
	return (async (opts: SpawnOptions): Promise<LeafSession> =>
		({
			run: async (task: string) => {
				calls.push({ role: opts.role, task });
				const n = (runs[opts.role === "test" ? "test" : "impl"] = (runs[opts.role === "test" ? "test" : "impl"] ?? 0) + 1);
				return { text: await (opts.role === "test" ? tester : impl)(opts, task, n), toolCalls: 1, blocked: 0, usage };
			},
			dispose() {},
		}) as unknown as LeafSession) as never;
};
const reviewGate = async (g: GateInput): Promise<GateReport> => {
	const r = await g.review!([CODE]);
	return { ok: r.ok, steps: [{ name: "wired_ok", ok: r.ok, ms: 1, output: r.output }], changedFiles: [CODE], failedStep: r.ok ? undefined : "wired_ok", testFiles: g.testFiles.map((t) => t.path) };
};

beforeEach(() => {
	ws = join(here, ".sim", "review-loop");
	rmSync(ws, { recursive: true, force: true });
	write(join(ws, "legacy", "app", "agency", "create.cmd.php"), "<?php\n");
	config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, models: {} });
	write(join(ws, "migrated", "package.json"), "{}");
	write(join(ws, "migrated", SPEC), "it('u1#1 creates', () => {});\n");
	execFileSync("git", ["init", "-q"], { cwd: join(ws, "migrated") });
	mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
	ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
	ledger.createUnit({ id: "u1", tier: "T1", deps: [], meta: { files: ["app/agency/create.cmd.php"], place: { stack: "nestjs", area: "agency", shared: false, source: "code" } }, symbolIds: [] });
	write(join(ws, ".bigrefactor", "truth", "u1", "interface.md"), `${CODE} exports AgencyService\n`);
	ledger.addEvidence("u1", "truth_green_on_old", {});
	ledger.db.prepare("INSERT INTO truth_cases(id, unit_id, symbol_id, inputs, expected, verified_on_old, created_at) VALUES ('u1#1','u1','s','[]','1',1,'t')").run();
});

describe("DONE after a red check_my_code", () => {
	it("gets one more turn; red tests it disputes there go straight to the tester, without a gate run", async () => {
		saveCommandOverride(ws, "nestjs", "build", { cmd: "true", args: [] }, "fixture");
		saveCommandOverride(ws, "nestjs", "lint", { cmd: "true", args: [] }, "fixture");
		saveCommandOverride(ws, "nestjs", "test", { cmd: "sh", args: ["-c", "echo 'u1#1 creates: expected 2, got 3'; exit 1"] }, "fixture");
		const calls: Array<{ role: string; task: string }> = [];
		const spawn = sessions(calls, async (opts, _task, n) => {
			if (n === 1) write(join(ws, "migrated", CODE), "export class AgencyService {}\n");
			if (n === 2) await exec(opts, "dispute_test", { test: "u1#1 creates", why: "expects 2", evidence: "create.cmd.php returns 3" });
			if (n <= 2) await exec(opts, "check_my_code");
			return "IMPLEMENTER DONE";
		});
		let gates = 0;
		const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn, gate: async (g) => (gates++, { ok: true, steps: [], changedFiles: [], testFiles: g.testFiles.map((t) => t.path) }), log: () => {} });
		expect(calls.map((c) => c.role)).toEqual(["implement", "implement", "test", "implement"]);
		expect(calls[1]!.task).toMatch(/last check_my_code was red \(tests\)[\s\S]*dispute_test[\s\S]*expected 2, got 3/);
		expect(calls[2]!.task).toMatch(/The implementer disputes these tests:[\s\S]*u1#1 creates: expects 2/);
		// the straight route ran no gate; the second attempt's gate is green
		expect(gates).toBe(1);
		expect(r).toMatchObject({ state: "review", attempts: 2 });
		expect(ledger.db.prepare("SELECT outcome FROM attempts WHERE unit_id = 'u1' AND role = 'implement' ORDER BY id").all()).toEqual([{ outcome: "gate_red:ported_tests_green" }, { outcome: "gate_green" }]);
	});

	it("code changed after the red check: the gate runs (no straight route on a stale check)", async () => {
		saveCommandOverride(ws, "nestjs", "build", { cmd: "true", args: [] }, "fixture");
		saveCommandOverride(ws, "nestjs", "lint", { cmd: "true", args: [] }, "fixture");
		saveCommandOverride(ws, "nestjs", "test", { cmd: "sh", args: ["-c", "echo 'u1#1 creates: expected 2, got 3'; exit 1"] }, "fixture");
		const calls: Array<{ role: string; task: string }> = [];
		const spawn = sessions(calls, async (opts, _task, n) => {
			if (n === 1) write(join(ws, "migrated", CODE), "export class AgencyService {}\n");
			if (n === 1) await exec(opts, "check_my_code");
			// the extra turn: disputes one test, then fixes the code and says DONE without checking again
			if (n === 2) (await exec(opts, "dispute_test", { test: "u1#1 creates", why: "expects 2", evidence: "x" }), write(join(ws, "migrated", CODE), "export class AgencyService { fee = 3; }\n"));
			return "IMPLEMENTER DONE";
		});
		let gates = 0;
		await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn, gate: async (g) => (gates++, { ok: true, steps: [], changedFiles: [], testFiles: g.testFiles.map((t) => t.path) }), log: () => {} });
		expect(calls.map((c) => c.role)).toEqual(["implement", "implement"]);
		expect(gates).toBe(1);
		expect(ledger.db.prepare("SELECT outcome FROM attempts WHERE unit_id = 'u1' AND role = 'implement' ORDER BY id").all()).toEqual([{ outcome: "gate_green" }]);
	});

	it("a check stopped by its short timeout gets no extra turn (the gate runs it again with more time)", async () => {
		saveCommandOverride(ws, "nestjs", "build", { cmd: "true", args: [] }, "fixture");
		saveCommandOverride(ws, "nestjs", "lint", { cmd: "true", args: [] }, "fixture");
		saveCommandOverride(ws, "nestjs", "test", { cmd: "sh", args: ["-c", "echo 'slow'; echo '[timed out]'; exit 1"] }, "fixture");
		const calls: Array<{ role: string; task: string }> = [];
		const spawn = sessions(calls, async (opts) => (write(join(ws, "migrated", CODE), "export class AgencyService {}\n"), await exec(opts, "check_my_code"), "IMPLEMENTER DONE"));
		await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn, gate: async (g) => ({ ok: true, steps: [], changedFiles: [], testFiles: g.testFiles.map((t) => t.path) }), log: () => {} });
		expect(calls.map((c) => c.role)).toEqual(["implement"]);
	});

	it("the extra turn shows the head of the red check (the failures), not its tail", async () => {
		saveCommandOverride(ws, "nestjs", "build", { cmd: "true", args: [] }, "fixture");
		saveCommandOverride(ws, "nestjs", "lint", { cmd: "true", args: [] }, "fixture");
		saveCommandOverride(ws, "nestjs", "test", { cmd: "sh", args: ["-c", "echo 'FAIL u1#1 creates: expected 2, got 3'; for i in $(seq 1 400); do echo \"padding line $i of the run\"; done; exit 1"] }, "fixture");
		const calls: Array<{ role: string; task: string }> = [];
		const spawn = sessions(calls, async (opts, _task, n) => {
			if (n === 1) (write(join(ws, "migrated", CODE), "export class AgencyService {}\n"), await exec(opts, "check_my_code"));
			return "IMPLEMENTER DONE";
		});
		await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn, gate: async (g) => ({ ok: true, steps: [], changedFiles: [], testFiles: g.testFiles.map((t) => t.path) }), log: () => {} });
		expect(calls[1]!.task).toMatch(/failures:\n[^\n]*\nFAIL u1#1 creates: expected 2, got 3/);
	});

	it("a green check gets no extra turn", async () => {
		const calls: Array<{ role: string; task: string }> = [];
		const spawn = sessions(calls, async () => "IMPLEMENTER DONE");
		await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn, gate: async (g) => ({ ok: true, steps: [], changedFiles: [], testFiles: g.testFiles.map((t) => t.path) }), log: () => {} });
		expect(calls.map((c) => c.role)).toEqual(["implement"]);
	});
});

describe("the implementer answers the reviewer", () => {
	it("its final message and disputed findings reach the reviewer; unchanged code keeps the last verdict without a new review", async () => {
		const calls: Array<{ role: string; task: string }> = [];
		const finding = "- src/features/agency/agency.service.ts:1: no fee → port the fee";
		const spawn = sessions(calls, async (opts, _task, n) => {
			if (n === 1) write(join(ws, "migrated", CODE), "export class AgencyService {}\n");
			// attempt 2 changes nothing; attempt 3 disputes the finding (still no code change)
			if (n === 3) await exec(opts, "dispute_finding", { finding, why: "the legacy code has no fee", evidence: "create.cmd.php has no fee at all" });
			return `IMPLEMENTER DONE: attempt ${n}, the legacy code computes no fee`;
		});
		const inputs: ReviewInput[] = [];
		const reviewer = async (i: ReviewInput) => (inputs.push(i), inputs.length === 1 ? { ok: false, judged: true, output: `reviewer findings:\n${finding}`, findings: [finding] } : { ok: true, judged: true, output: "fine", findings: [] });
		const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn, gate: reviewGate, reviewer, setupFixer: false, log: () => {} });
		expect(calls.map((c) => c.role)).toEqual(["implement", "implement", "implement"]);
		expect(calls[1]!.task).toMatch(/dispute_finding/);
		// attempt 2 changed no code: the verdict of review 1 stood, no reviewer session
		expect(inputs).toHaveLength(2);
		expect(ledger.db.prepare("SELECT COUNT(*) n FROM attempts WHERE unit_id = 'u1' AND role = 'review'").get()).toEqual({ n: 2 });
		expect(inputs[0]!.implementerNote).toMatch(/attempt 1/);
		expect(inputs[1]!.implementerNote).toMatch(/attempt 3, the legacy code computes no fee/);
		expect(inputs[1]!.findingDisputes).toEqual([{ finding, why: "the legacy code has no fee", evidence: "create.cmd.php has no fee at all" }]);
		expect(r.state).toBe("review");
	});

	it("the reviewer must answer each disputed finding: kept with a reason or dropped", async () => {
		const dir = join(ws, "migrated");
		write(join(dir, CODE), "export class AgencyService {}\n");
		const finding = "- a.ts:1: no fee → port the fee";
		const results: string[] = [];
		const spawn = (async (opts: SpawnOptions): Promise<LeafSession> =>
			({
				run: async (task: string) => {
					expect(task).toMatch(/The implementer disputes these findings[\s\S]*port the fee: the legacy code has none[\s\S]*The implementer's final message[\s\S]*no fee in the legacy code/);
					const verdict = (p: object) => (opts.customTools!.find((t) => t.name === "review_verdict") as unknown as { execute: (i: string, p: object) => Promise<{ content: Array<{ text: string }> }> }).execute("x", p);
					results.push((await verdict({ ok: true, findings: [] })).content[0]!.text);
					results.push((await verdict({ ok: true, findings: [], disputeAnswers: [{ finding, kept: false, reason: "create.cmd.php indeed has no fee" }] })).content[0]!.text);
					return { text: "done", toolCalls: 2, blocked: 0, usage };
				},
				dispose() {},
			}) as unknown as LeafSession) as never;
		const r = await reviewWithModel({ ledger, config, root: ws, unitId: "u1", adapter: nestjsAdapter, targetProjectDir: dir, moduleDir: "src/features/agency", legacyFiles: ["app/agency/create.cmd.php"], changedFiles: [CODE], implementerNote: "IMPLEMENTER DONE: no fee in the legacy code", findingDisputes: [{ finding, why: "the legacy code has none", evidence: "create.cmd.php" }], spawn });
		expect(results[0]).toMatch(/not recorded: the implementer disputes 1 finding/);
		expect(results[1]).toMatch(/verdict recorded/);
		expect(r).toMatchObject({ ok: true, judged: true });
	});
});

describe("weak-tests-only reviews", () => {
	const weak = "- agency.service.spec.ts: only checks it renders";

	it("are not implementer failures; the tester's kept answers reach the next review", async () => {
		const calls: Array<{ role: string; task: string }> = [];
		const spawn = sessions(
			calls,
			async () => (write(join(ws, "migrated", CODE), "export class AgencyService {}\n"), "IMPLEMENTER DONE"),
			async () => (write(join(ws, "migrated", SPEC), "it('u1#1 creates an agency', () => {});\n"), "agency.service.spec.ts: kept — the legacy code only renders the form\nTESTER DONE 1 cases"),
		);
		const inputs: ReviewInput[] = [];
		const reviewer = async (i: ReviewInput) => (inputs.push(i), inputs.length === 1 ? { ok: false, judged: true, output: `weak tests:\n${weak}`, weakTests: weak, findings: [] } : { ok: true, judged: true, output: "fine", findings: [] });
		const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn, gate: reviewGate, reviewer, log: () => {} });
		expect(r).toMatchObject({ state: "review", attempts: 1 });
		expect(inputs[1]!.testerKept).toBe("agency.service.spec.ts: kept — the legacy code only renders the form");
		expect(ledger.db.prepare("SELECT role, outcome FROM attempts WHERE unit_id = 'u1' AND role IN ('implement', 'review') ORDER BY id").all()).toEqual([
			{ role: "implement", outcome: "gate_tests_weak" },
			{ role: "review", outcome: "review_weak_tests" },
			{ role: "review", outcome: "review_ok" },
		]);
		// the unit passed: its weak-tests count starts again for a later round
		expect(JSON.parse(ledger.getUnit("u1")!.meta)).toMatchObject({ weakRounds: 0 });
	});

	it("a tester that keeps every test unchanged and only answers still gets a fresh review that reads its answers", async () => {
		const calls: Array<{ role: string; task: string }> = [];
		const spawn = sessions(
			calls,
			async () => (write(join(ws, "migrated", CODE), "export class AgencyService {}\n"), "IMPLEMENTER DONE"),
			async () => "agency.service.spec.ts: kept — the legacy code only renders the form\nTESTER DONE 1 cases",
		);
		const inputs: ReviewInput[] = [];
		const reviewer = async (i: ReviewInput) => (inputs.push(i), inputs.length === 1 ? { ok: false, judged: true, output: `weak tests:\n${weak}`, weakTests: weak, findings: [] } : { ok: true, judged: true, output: "fine", findings: [] });
		const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn, gate: reviewGate, reviewer, log: () => {} });
		expect(inputs).toHaveLength(2);
		expect(inputs[1]!.testerKept).toMatch(/kept — the legacy code only renders the form/);
		expect(calls.filter((c) => c.role === "test")).toHaveLength(1);
		expect(r.state).toBe("review");
		expect(JSON.parse(ledger.getUnit("u1")!.meta).weakTestsNote).toBeUndefined();
	});

	it("count across runs of the unit: tester rounds of an earlier run count toward the waiver", async () => {
		ledger.updateUnit("u1", { meta: { weakRounds: 2 } });
		const calls: Array<{ role: string; task: string }> = [];
		const spawn = sessions(calls, async () => (write(join(ws, "migrated", CODE), "export class AgencyService {}\n"), "IMPLEMENTER DONE"));
		const reviewer = async () => ({ ok: false, judged: true, output: `weak tests:\n${weak}`, weakTests: weak, findings: [] });
		const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn, gate: reviewGate, reviewer, log: () => {} });
		expect(calls.map((c) => c.role)).toEqual(["implement"]);
		expect(r.state).toBe("review");
		expect(JSON.parse(ledger.getUnit("u1")!.meta).weakTestsNote).toMatch(/after 2 tester rounds/);
	});
});
