import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger/db.ts";
import { assessChanges, changeDecisionProblems, changeShapeProblems, type BehaviorChange } from "../src/run/parity-changes.ts";
import { compareRuns, type SliceEvidence, type StepsFile } from "../src/run/parity-check.ts";
import { contractDiffs, retainedScenarioProblems } from "../src/run/parity-contracts.ts";

let ledger: Ledger;
beforeEach(() => {
	ledger = new Ledger(":memory:");
	ledger.createUnit({ id: "u", tier: "T1", symbolIds: [] });
	ledger.db.prepare("UPDATE units SET state='accepted' WHERE id='u'").run();
	ledger.db.prepare("INSERT INTO quirks(id,unit_id,symbol_id,kind,behaviour,opinion,why,status,decided_by,created_at) VALUES (1,'u','approvals','suspected_bug','returns no waiting rows','drop','show waiting approvals','dropped','human','t0')").run();
});
afterEach(() => ledger.close());

const declared = (): BehaviorChange => ({ id: "waiting-approvals", quirkId: 1, why: "The recorded decision fixes the empty waiting list", expected: [{ step: "rows", kind: "body", legacy: { rows: [] }, target: { rows: [{ id: 42 }] } }] });
const fixture = () => {
	const suite: StepsFile = { steps: [{ id: "rows", route: "GET /waiting", method: "GET", path: "/waiting", compare: "data" }], changes: [declared()] };
	const evidence: SliceEvidence = { version: 1, suiteHash: "hash", inputs: {}, recipesHash: "hash", steps: suite.steps, suite, legacy: [[{ status: 200, body: { rows: [] } }], [{ status: 200, body: { rows: [] } }]], target: [{ status: 200, body: { rows: [{ id: 42 }] } }], checks: { legacy: [[], []], target: [] }, problems: [] };
	return { suite, evidence };
};
const assess = (o: ReturnType<typeof fixture>) => assessChanges(o.suite, ledger, o.evidence, compareRuns(o.suite.steps, ...o.evidence.legacy, o.evidence.target, false, true).diffs);

describe("explicitly verified behavior changes", () => {
	it("requires the whole specified old observation twice and target observation once, retaining the decision", () => {
		const r = assess(fixture());
		expect(r.problems).toEqual([]);
		expect(r.unexplained).toEqual([]);
		expect(r.verified).toEqual([{ ...declared(), decision: { unit_id: "u", symbol_id: "approvals", behaviour: "returns no waiting rows", decided_by: "human", question_id: null } }]);
	});
	it("does not suppress a fresh difference without an explicit expectation", () => {
		const o = fixture(); o.suite.changes = [];
		const r = assess(o);
		expect(r.verified).toEqual([]);
		expect(r.unexplained).toHaveLength(1);
	});
	it.each(["target", "old1", "old2"])("rejects a changed or extra field in %s, including fields both apps happen to agree on", (side) => {
		const o = fixture();
		const rows = side === "target" ? o.evidence.target : o.evidence.legacy[side === "old1" ? 0 : 1];
		rows[0]!.body = { ...(rows[0]!.body as object), unexpected: true };
		const r = assess(o);
		expect(r.problems.join("\n")).toContain("did not reproduce both specified legacy results and the intended target result");
		expect(r.verified).toEqual([]);
		expect(r.unexplained.length).toBeGreaterThan(0);
	});
	it("rejects a stale expectation when the target reverted to the legacy bug", () => {
		const o = fixture(); o.evidence.target = structuredClone(o.evidence.legacy[0]);
		expect(assess(o).problems).toHaveLength(1);
		expect(assess(o).verified).toEqual([]);
	});
	it("cannot cover an unrelated status regression with a body expectation", () => {
		const o = fixture(); o.evidence.target[0]!.status = 401;
		const r = assess(o);
		expect(r.verified).toHaveLength(1);
		expect(r.unexplained).toMatchObject([{ kind: "status", legacy: 200, target: 401 }]);
	});
	it("never authorizes execution errors", () => {
		const o = fixture(); o.evidence.target[0]!.error = "database unavailable";
		const r = assess(o);
		expect(r.verified).toEqual([]);
		expect(r.unexplained).toMatchObject([{ kind: "error" }]);
	});
	it("rejects missing, pending, kept, unattributed and unaccepted decisions", () => {
		const { suite } = fixture();
		for (const status of ["pending", "asked", "kept"]) {
			ledger.db.prepare("UPDATE quirks SET status=? WHERE id=1").run(status);
			expect(changeDecisionProblems(suite, ledger).join("\n")).toContain("needs a recorded DROP decision");
		}
		ledger.db.prepare("UPDATE quirks SET status='dropped',decided_by=NULL WHERE id=1").run();
		expect(changeDecisionProblems(suite, ledger)).toHaveLength(1);
		ledger.db.prepare("UPDATE quirks SET decided_by='human' WHERE id=1").run();
		ledger.db.prepare("UPDATE units SET state='quarantined' WHERE id='u'").run();
		expect(changeDecisionProblems(suite, ledger)).toHaveLength(1);
		suite.changes![0]!.quirkId = 999;
		expect(changeDecisionProblems(suite, ledger)).toHaveLength(1);
	});
	it("positively verifies executable observations, including array entries absent from the legacy result", () => {
		const o = fixture();
		o.suite.steps = []; o.evidence.steps = [];
		o.suite.checks = [{ id: "browser", kind: "browser", covers: [], why: "real waiting list", command: { cmd: "node", args: ["check.cjs"] }, inputs: ["check.cjs"] }];
		o.suite.changes![0]!.expected[0]!.step = "check:browser";
		o.evidence.checks = { legacy: [[{ id: "browser", observations: { rows: [] } }], [{ id: "browser", observations: { rows: [] } }]], target: [{ id: "browser", observations: { rows: [{ id: 42 }] } }] };
		const diffs = contractDiffs(o.suite.checks, [], ...o.evidence.checks.legacy, o.evidence.checks.target);
		expect(assessChanges(o.suite, ledger, o.evidence, diffs)).toMatchObject({ problems: [], unexplained: [], verified: [{ id: "waiting-approvals" }] });
		o.evidence.checks.target[0]!.observations = { rows: [{ id: 43 }] };
		expect(assessChanges(o.suite, ledger, o.evidence, diffs).verified).toEqual([]);
	});
	it("requires every observation of a change to succeed before accepting any of its differences", () => {
		const o = fixture();
		o.suite.changes![0]!.expected.push({ step: "rows", kind: "status", legacy: 200, target: 201 });
		const r = assess(o);
		expect(r.verified).toEqual([]);
		expect(r.unexplained).toHaveLength(1);
	});
	it("rejects malformed, ambiguous and wildcard expectations", () => {
		const o = fixture();
		const invalid = [null, {}, { ...declared(), quirkId: "1" }, { ...declared(), expected: [] }, { ...declared(), expected: [{ step: "*", kind: "body", legacy: 1, target: 2 }] }, { ...declared(), expected: [{ step: "rows", kind: "error", legacy: "old", target: "new" }] }, { ...declared(), expected: [{ step: "rows", kind: "body", legacy: {} }] }, { ...declared(), expected: [{ step: "rows", kind: "body", legacy: 1, target: 1 }] }, { ...declared(), expected: [{ step: "rows", kind: "status", legacy: 200, target: 503 }] }];
		for (const c of invalid) expect(changeShapeProblems({ ...o.suite, changes: [c] } as StepsFile).length).toBeGreaterThan(0);
		expect(changeShapeProblems({ ...o.suite, changes: [declared(), { ...declared(), id: "another" }] }).join("\n")).toContain("duplicate expectation");
	});
	it("preparation cannot remove or rewrite a retained expectation", () => {
		const { suite } = fixture();
		expect(retainedScenarioProblems(suite, { ...suite, changes: [] })).toContain("preparation must retain declared behavior change waiting-approvals");
		const after = structuredClone(suite); after.changes![0]!.expected[0]!.target = { rows: [] };
		expect(retainedScenarioProblems(suite, after)).toContain("preparation must retain declared behavior change waiting-approvals");
	});
});
