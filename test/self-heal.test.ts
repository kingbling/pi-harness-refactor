import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { FakeModelClient } from "../src/models/fake.ts";
import { askPendingQuirks, quirksOf, recordQuirk } from "../src/run/quirks.ts";
import { applyParkedAnswer, requeueUnits, resubmitParkedUnits } from "../src/run/run.ts";
import { curateAreas, currentAreas, syncTaxonomyAnswers } from "../src/run/taxonomy.ts";
import { triageGate } from "../src/run/triage.ts";
import { STUB_LEFT } from "../src/run/gate.ts";

/**
 * Self-heal and questions: an answer does what its option says, nothing strands a unit, a crashed decision
 * model does not stop the playbook, quirk volume stays low, curation never rewrites migrated code.
 */
function workspace() {
	const root = mkdtempSync(join(tmpdir(), "br-heal-"));
	mkdirSync(join(root, "legacy"), { recursive: true });
	mkdirSync(join(root, ".bigrefactor"), { recursive: true });
	const raw = { version: 1, source: { path: join(root, "legacy"), stack: "php" }, target: { path: join(root, "new"), stacks: ["nestjs"] }, models: {} };
	writeFileSync(join(root, "bigrefactor.config.json"), JSON.stringify(raw));
	const config = ConfigSchema.parse(raw);
	const ledger = new Ledger(join(root, ".bigrefactor", "ledger.sqlite"));
	const mk = (id: string, area = "billing", state?: "implementing" | "accepted") => {
		const file = `src/${id}.php`;
		ledger.upsertFile({ path: file, hash: "h", lang: "php", loc: 10 });
		ledger.upsertSymbol({ id: `${file}::f`, path: file, kind: "function", name: "f" });
		ledger.createUnit({ id, tier: "T0", symbolIds: [`${file}::f`], meta: { files: [file], place: { stack: "nestjs", area, shared: false, source: "code" } } });
		if (state) {
			ledger.transitionUnit(id, "truth", "t");
			ledger.transitionUnit(id, "implementing", "t");
		}
		if (state === "accepted") {
			ledger.transitionUnit(id, "gating", "t");
			ledger.transitionUnit(id, "review", "t");
			ledger.transitionUnit(id, "accepted", "t");
		}
	};
	return { root, config, ledger, mk };
}
const noManifests = new Map([["nestjs", { toolchain: { manifestFiles: [] as string[] } }]]);

describe("answers are applied per option", () => {
	it("maps stop words, wait, options and free text", () => {
		const opts = ["fixed — the environment is fixed", "retry — run again", "quarantine — stop"];
		expect(applyParkedAnswer("quarantine — stop", opts)).toEqual({ action: "quarantine" });
		expect(applyParkedAnswer("leave", ["raise", "leave"])).toEqual({ action: "quarantine" });
		expect(applyParkedAnswer("wait", ["retry", "wait"])).toEqual({ action: "hold" });
		expect(applyParkedAnswer("fixed — the environment is fixed", opts)).toEqual({ action: "requeue", hint: undefined });
		expect(applyParkedAnswer("use the fixtures in tests/data, the DB is not needed", opts)).toEqual({ action: "requeue", hint: "use the fixtures in tests/data, the DB is not needed" });
		expect(applyParkedAnswer("auto: the environment changed", opts)).toEqual({ action: "requeue" });
	});

	it("retry runs the unit again, leave parks it; old ledgers' fixed/quarantine answers still mean the same", () => {
		const opts = ["retry — run it again", "leave — leave the unit parked for a human"];
		expect(applyParkedAnswer("retry — run it again", opts)).toEqual({ action: "requeue", hint: undefined });
		expect(applyParkedAnswer("leave — leave the unit parked for a human", opts)).toEqual({ action: "quarantine" });
		const old = ["fixed — the environment is fixed", "quarantine — leave the unit quarantined"];
		expect(applyParkedAnswer("fixed — the environment is fixed", old)).toEqual({ action: "requeue", hint: undefined });
		expect(applyParkedAnswer("quarantine — leave the unit quarantined", old)).toEqual({ action: "quarantine" });
		expect(applyParkedAnswer("the DB runs on port 5433 now", opts)).toEqual({ action: "requeue", hint: "the DB runs on port 5433 now" });
	});

	it("quarantined units go back after a fix or, an hour later, with a new failure, 5 times; then one question per kind of failure, and the answer is applied", async () => {
		const { root, config, ledger, mk } = await workspace();
		const { askStuckUnits, healQuarantined } = await import("../src/run/run.ts");
		for (const id of ["U1", "U2"]) {
			mk(id, "billing", "implementing");
			ledger.transitionUnit(id, "quarantined", "gate still red after 5 attempts (lint_ok)");
		}
		const hour = 60 * 60_000;
		const heal = (o: { since?: number; now?: number }) => healQuarantined(ledger, config, root, new Set(), () => {}, noManifests, { since: Date.now() - hour, ...o });
		expect(await heal({})).toEqual([]); // just failed, nothing changed
		expect((await heal({ since: Date.now() + 1000 })).sort()).toEqual(["U1", "U2"]); // a fix landed since
		for (let i = 2; i <= config.run.maxAutoHeals + 1; i++) {
			for (const id of ["U1", "U2"]) {
				ledger.transitionUnit(id, "truth", "t");
				ledger.transitionUnit(id, "quarantined", `gate still red after 5 attempts (${["lint_ok", "build_ok", "test_ok", "wired_ok", "rules_ok", "structure_ok"][i - 1]})`); // a new kind of failure each time
			}
			expect((await heal({ now: Date.now() + hour + 1000 })).length).toBe(i <= config.run.maxAutoHeals ? 2 : 0); // an hour later
		}
		expect(JSON.parse(ledger.getUnit("U1")!.meta)).toMatchObject({ autoHeals: 5, retryNote: expect.stringMatching(/try 5 of 5/) });
		// out of tries: the owner is asked once for both (same failure)
		expect(await askStuckUnits({ ledger, config, root })).toBe(1);
		expect(await askStuckUnits({ ledger, config, root })).toBe(0);
		const q = ledger.openQuestions();
		expect(q).toHaveLength(1);
		expect(q[0]!.point).toBe("quarantine");
		expect(await heal({ now: Date.now() + 9 * hour })).toEqual([]); // waits for the answer now
		ledger.answerQuestion(q[0]!.id, "the lint config was wrong, I fixed it");
		expect((await heal({})).sort()).toEqual(["U1", "U2"]);
		expect(JSON.parse(ledger.getUnit("U2")!.meta)).toMatchObject({ autoHeals: 0, retryNote: expect.stringMatching(/hint: the lint config was wrong/) });
	});

	it("the resolver model's retry counts against the automatic tries: past them the unit stays parked and nobody is asked", async () => {
		const { root, config, ledger, mk } = await workspace();
		const { askStuckUnits, healQuarantined } = await import("../src/run/run.ts");
		const { RESOLVER } = await import("../src/jev/resolve.ts");
		mk("U1", "billing", "implementing");
		ledger.transitionUnit("U1", "quarantined", "gate still red after 5 attempts (antigaming_ok)");
		ledger.updateUnit("U1", { meta: { autoHeals: config.run.maxAutoHeals - 1, stuck: true } });
		const at = ledger.startAttempt("U1", "implement");
		ledger.endAttempt(at, { outcome: "gate_red:antigaming_ok", gateReport: { ok: false, failedStep: "antigaming_ok", steps: [{ name: "antigaming_ok", ok: false, output: "src/a.spec.ts: the test asserts nothing" }], changedFiles: [] } });
		const heal = () => healQuarantined(ledger, config, root, new Set(), () => {}, noManifests, { now: Date.now() + 9 * 60 * 60_000 });
		expect(await askStuckUnits({ ledger, config, root })).toBe(1);
		ledger.answerQuestion(ledger.openQuestions()[0]!.id, "retry\nhint: keep the fixture ids", RESOLVER);
		expect(await heal()).toEqual(["U1"]);
		// the note carries the hint and the last red report (the worktree is gone, this is all the next run has); the kind of failure is kept
		expect(JSON.parse(ledger.getUnit("U1")!.meta)).toMatchObject({ autoHeals: config.run.maxAutoHeals, retriedOn: ["antigaming_ok: <path> the test asserts nothing in a.spec.ts"], retryNote: expect.stringMatching(/the resolver model said to try again\. The model's hint: keep the fixture ids\nIts last failure \(antigaming_ok\):\nsrc\/a\.spec\.ts: the test asserts nothing/) });
		// it fails again: no automatic try is left, it is asked about, and the question says a retry is no answer now
		ledger.transitionUnit("U1", "truth", "t");
		ledger.transitionUnit("U1", "quarantined", "gate still red after 5 attempts (antigaming_ok)");
		expect(await heal()).toEqual([]);
		expect(await askStuckUnits({ ledger, config, root })).toBe(1);
		const q = ledger.openQuestions()[0]!;
		expect(JSON.parse(q.context!)).toMatchObject({ retry: "none" });
		// the resolver's retry anyway: it stays parked, nobody is asked again, br status lists it
		ledger.answerQuestion(q.id, "retry\nhint: keep the fixture ids", RESOLVER);
		expect(await heal()).toEqual([]);
		expect(JSON.parse(ledger.getUnit("U1")!.meta)).toMatchObject({ healQuestion: 0, parkedWhy: expect.stringMatching(/automatic tries are used up/) });
		expect(await askStuckUnits({ ledger, config, root })).toBe(0);
		const { renderStatus } = await import("../src/dashboard/status.ts");
		expect(renderStatus(ledger, { color: false })).toMatch(/parked, no question .*U1/);
	});

	it("a job's retry counts against the automatic tries too: past them the unit parks, and only a change since its failure brings it back", async () => {
		const { root, config, ledger, mk } = await workspace();
		const { healQuarantined } = await import("../src/run/run.ts");
		const { FIX_JOB } = await import("../src/jev/resolve.ts");
		mk("U1", "billing", "implementing");
		ledger.transitionUnit("U1", "quarantined", "truth cases without a ported test after 2 retests: U1#1");
		const q = ledger.askQuestion({ unitId: "U1", point: "quarantine", question: "U1 keeps failing", options: ["retry — try again", "leave — leave it"], askedBy: "orchestrator" });
		ledger.updateUnit("U1", { meta: { autoHeals: config.run.maxAutoHeals, stuck: true, healQuestion: q } });
		ledger.answerQuestion(q, "retry — try again\nhint: what the fix job changed on main: the autoload mapping", FIX_JOB);
		const heal = (since: number) => healQuarantined(ledger, config, root, new Set(), () => {}, noManifests, { since });
		expect(await heal(Date.now() - 60 * 60_000)).toEqual([]);
		expect(JSON.parse(ledger.getUnit("U1")!.meta)).toMatchObject({ autoHeals: config.run.maxAutoHeals, healQuestion: 0, parkedWhy: expect.stringMatching(/fix job\) said to try again, but its 5 automatic tries are used up/) });
		// the job's change on main is weighed like any other change (here without a decide model: any change counts)
		expect(await heal(Date.now() + 1000)).toEqual(["U1"]);
	});

	it("the same error in new words is the same failure: stuck, and a plain retry is no answer; a new error at the same step is not", async () => {
		const { root, config, ledger, mk } = await workspace();
		const { askStuckUnits, healQuarantined } = await import("../src/run/run.ts");
		const hour = 60 * 60_000;
		const heal = () => healQuarantined(ledger, config, root, new Set(), () => {}, noManifests, { since: Date.now() - hour, now: Date.now() + hour + 1000 });
		const fail = (id: string, reason: string, output: string) => {
			if (ledger.getUnit(id)!.state === "quarantined") ledger.transitionUnit(id, "truth", "t");
			const at = ledger.startAttempt(id, "implement");
			ledger.endAttempt(at, { outcome: "gate_red:wired_ok", gateReport: { ok: false, failedStep: "wired_ok", steps: [{ name: "wired_ok", ok: false, output }], changedFiles: [] } });
			ledger.transitionUnit(id, "quarantined", reason);
		};
		for (const id of ["U1", "U2"]) {
			mk(id, "billing", "implementing");
			fail(id, "gate still red after 5 attempts (wired_ok); attempt cap 5 reached", "Error: route GET /api/totals/12 not found in src/routes.ts");
		}
		expect((await heal()).sort()).toEqual(["U1", "U2"]);
		// U1: the same error, other words (another id, another file); U2: a new error at the same step
		fail("U1", "gate still red after 4 attempts (wired_ok); decision model unsure: 0.35", "Error: route GET /api/totals/57 not found in src/app.routes.ts");
		fail("U2", "gate still red after 4 attempts (wired_ok); decision model unsure: 0.35", "Error: BillingService.total returns the wrong type");
		expect(await heal()).toEqual(["U2"]);
		expect(JSON.parse(ledger.getUnit("U1")!.meta)).toMatchObject({ stuck: true });
		expect(await askStuckUnits({ ledger, config, root })).toBe(1);
		expect(JSON.parse(ledger.openQuestions()[0]!.context!)).toMatchObject({ retry: "with a hint", failureKind: "wired_ok: Error: route GET <path> not found in <path>" });
	});

	it("a job's retry past the cap parks the unit; its change on main brings it back, and what it changed goes to the next attempt", async () => {
		const { root, config, ledger, mk } = await workspace();
		const { askStuckUnits, healQuarantined } = await import("../src/run/run.ts");
		const { resolveOpenQuestions, CODE_JOB } = await import("../src/jev/resolve.ts");
		mk("U1", "billing", "implementing");
		ledger.transitionUnit("U1", "quarantined", "gate still red after 5 attempts (build_ok)");
		ledger.updateUnit("U1", { meta: { autoHeals: config.run.maxAutoHeals } });
		expect(await askStuckUnits({ ledger, config, root })).toBe(1);
		const q = ledger.openQuestions()[0]!;
		expect(JSON.parse(q.context!)).toMatchObject({ retry: "none", failureKind: expect.any(String) });
		await resolveOpenQuestions({ ledger, config, root, resolver: async () => ({ code: "add the DspHourlyStats class", then: "retry" }), codeJob: async () => "added src/Stats/DspHourlyStats.php with tests" });
		expect(ledger.getQuestion(q.id)!.answered_by).toBe(CODE_JOB);
		const heal = () => healQuarantined(ledger, config, root, new Set(), () => {}, noManifests, {});
		expect(await heal()).toEqual([]);
		const { noteFix } = await import("../src/adapters/command-overrides.ts");
		noteFix(root, "nestjs", "abc1234", "code job: added src/Stats/DspHourlyStats.php with tests");
		expect(await heal()).toEqual(["U1"]);
		expect(JSON.parse(ledger.getUnit("U1")!.meta)).toMatchObject({ autoHeals: config.run.maxAutoHeals + 1, retryNote: expect.stringMatching(/It was parked: the code model \(code job\) said to try again, but its 5 automatic tries are used up\. Its hint: what the code job changed on main: added src\/Stats\/DspHourlyStats\.php/) });
	});

	it("a unit a model parked comes back when main changes after the park; the owner's leave stands", async () => {
		const { root, config, ledger, mk } = await workspace();
		const { healQuarantined } = await import("../src/run/run.ts");
		const { RESOLVER } = await import("../src/jev/resolve.ts");
		for (const id of ["U1", "U2"]) {
			mk(id, "billing", "implementing");
			ledger.transitionUnit(id, "quarantined", "gate still red after 5 attempts (build_ok)");
		}
		const q1 = ledger.askQuestion({ unitId: "U1", point: "quarantine", question: "U1 keeps failing", options: ["retry — try again", "leave — leave it"], askedBy: "orchestrator" });
		const q2 = ledger.askQuestion({ unitId: "U2", point: "quarantine", question: "U2 keeps failing", options: ["retry — try again", "leave — leave it"], askedBy: "orchestrator" });
		ledger.updateUnit("U1", { meta: { autoHeals: config.run.maxAutoHeals, healQuestion: q1 } });
		ledger.updateUnit("U2", { meta: { autoHeals: config.run.maxAutoHeals, healQuestion: q2 } });
		ledger.answerQuestion(q1, "leave — leave it\nhint: a class outside the unit is missing", RESOLVER);
		ledger.answerQuestion(q2, "leave — leave it");
		const heal = (since?: number) => healQuarantined(ledger, config, root, new Set(), () => {}, noManifests, { since });
		expect(await heal(Date.now() - 60_000)).toEqual([]);
		expect(JSON.parse(ledger.getUnit("U1")!.meta)).toMatchObject({ healQuestion: 0, parkedWhy: "a class outside the unit is missing" });
		expect(await heal(Date.now() - 60_000)).toEqual([]); // nothing changed since the park
		expect(await heal(Date.now() + 1000)).toEqual(["U1"]); // a change landed after it: worth a try
		expect(JSON.parse(ledger.getUnit("U1")!.meta).parkedWhy).toBeUndefined();
	});

	it("a unit a model parked gets one more try when the plugin changed after the park in a way that touches it", async () => {
		const { root, config, ledger, mk } = await workspace();
		const { healQuarantined } = await import("../src/run/run.ts");
		mk("U1", "billing", "implementing");
		ledger.transitionUnit("U1", "quarantined", "a code job wrote it but was not merged: protected config was changed");
		const parkedAt = Date.now() - 60_000;
		ledger.updateUnit("U1", { meta: { healQuestion: 0, parkedWhy: "protected config was changed", parkedAt, autoHeals: 1 } });
		const asked: string[] = [];
		const heal = (pluginChangedAt: number, pluginChanges: string, touches?: boolean) =>
			healQuarantined(ledger, config, root, new Set(), () => {}, noManifests, {
				since: 0,
				pluginChangedAt,
				pluginChanges: async () => pluginChanges,
				client: touches === undefined ? undefined : new FakeModelClient({ decide: (req) => (asked.push(String((req.state as { changes: string }).changes)), { touches: touches ? 0.9 : 0.1 }) }),
			});
		expect(await heal(parkedAt - 1000, "abc1 code jobs may change app config")).toEqual([]); // the plugin is older than the park
		expect(await heal(parkedAt + 1000, "")).toEqual([]); // newer files but no commit since the park: nothing changed
		// the plugin's changes do not touch what parked it (the decide model reads them): it stays, and is not asked again for that plugin
		expect(await heal(parkedAt + 2000, "abc2 the stop reaches running units", false)).toEqual([]);
		expect(asked).toEqual([expect.stringMatching(/abc2 the stop reaches running units/)]);
		expect(await heal(parkedAt + 2000, "abc2 the stop reaches running units", true)).toEqual([]);
		expect(asked).toHaveLength(1);
		// a later change that touches it: one more try, counted
		expect(await heal(parkedAt + 3000, "abc3 code jobs may change app config", true)).toEqual(["U1"]);
		expect(JSON.parse(ledger.getUnit("U1")!.meta)).toMatchObject({ autoHeals: 2, retryNote: expect.stringMatching(/^This unit was parked \(protected config was changed\); the migration tool changed since in a way that may fix it, so it runs again \(automatic try 2 of/) });
		// parked again after that try: the same plugin does not bring it back
		ledger.transitionUnit("U1", "implementing", "x");
		ledger.transitionUnit("U1", "quarantined", "still red");
		ledger.updateUnit("U1", { meta: { healQuestion: 0, parkedWhy: "still red", parkedAt: Date.now() } });
		expect(await heal(parkedAt + 3000, "abc3 code jobs may change app config")).toEqual([]);
		// its automatic tries used up: a plugin change does not bring it back either
		ledger.updateUnit("U1", { meta: { autoHeals: config.run.maxAutoHeals } });
		expect(await heal(Date.now() + 1000, "abc4 code jobs may change app config")).toEqual([]);
	});

	it("the plugin's changes come from its own git history: each commit's subject and files", async () => {
		const { pluginChangesSince } = await import("../src/run/run.ts");
		expect(await pluginChangesSince(0)).toMatch(/^[0-9a-f]{7,} \S[\s\S]*\| +\d+/);
	});

	it("a model's leave on a waiting unit's question parks it with the model's reason; the owner's leave does not", async () => {
		const { root, config, ledger, mk } = await workspace();
		const { RESOLVER } = await import("../src/jev/resolve.ts");
		for (const id of ["U1", "U2"]) mk(id, "billing", "implementing");
		const ask = (unitId: string) => ledger.askQuestion({ unitId, point: "gate_env", question: "lint fails", options: ["retry — run it again", "leave — leave it parked"], askedBy: "orchestrator" });
		ledger.answerQuestion(ask("U1"), "leave — leave it parked\nhint: a fix job was tried and changed nothing: add the lint config", RESOLVER);
		ledger.answerQuestion(ask("U2"), "leave — leave it parked");
		await resubmitParkedUnits(ledger, config, root, new Set(), () => {}, noManifests);
		expect(ledger.getUnit("U1")!.state).toBe("quarantined");
		expect(JSON.parse(ledger.getUnit("U1")!.meta)).toMatchObject({ healQuestion: 0, parkedWhy: "a fix job was tried and changed nothing: add the lint config" });
		expect(JSON.parse(ledger.getUnit("U2")!.meta).parkedWhy).toBeUndefined();
	});

	it("the same failure again with nothing changed is not retried: the unit is asked about, and a later fix still brings it back", async () => {
		const { root, config, ledger, mk } = await workspace();
		const { askStuckUnits, healQuarantined } = await import("../src/run/run.ts");
		mk("U1", "billing", "implementing");
		ledger.transitionUnit("U1", "quarantined", "truth cases without a ported test after 2 retests: U1#1");
		const hour = 60 * 60_000;
		const heal = (o: { since?: number; now?: number }) => healQuarantined(ledger, config, root, new Set(), () => {}, noManifests, { since: Date.now() - hour, ...o });
		expect(await heal({ now: Date.now() + hour + 1000 })).toEqual(["U1"]); // first failure: one try an hour later
		ledger.transitionUnit("U1", "truth", "t");
		ledger.transitionUnit("U1", "quarantined", "truth cases without a ported test after 2 retests: U1#1");
		expect(await heal({ now: Date.now() + 9 * hour })).toEqual([]); // the same failure, nothing changed: no more tries
		expect(JSON.parse(ledger.getUnit("U1")!.meta)).toMatchObject({ autoHeals: 1, stuck: true });
		expect(await askStuckUnits({ ledger, config, root })).toBe(1);
		expect(ledger.openQuestions()[0]!.question).toMatch(/failed the same way as the one before/);
		expect(await heal({ since: Date.now() + 1000 })).toEqual(["U1"]); // the plugin or setup changed since: worth a try, question open or not
		expect(JSON.parse(ledger.getUnit("U1")!.meta)).toMatchObject({ autoHeals: 2 });
		expect(JSON.parse(ledger.getUnit("U1")!.meta).stuck).toBeUndefined();
	});

	it("a fix job that lands (the resolver's code job, a widened layout, a builder repair) re-checks quarantined units at once", async () => {
		const { root, config, ledger, mk } = await workspace();
		const { healQuarantined } = await import("../src/run/run.ts");
		const { noteFix } = await import("../src/adapters/command-overrides.ts");
		mk("U1", "billing", "implementing");
		ledger.transitionUnit("U1", "quarantined", "gate still red after 5 attempts (build_ok): Cannot find module '../shared/money'");
		const heal = () => healQuarantined(ledger, config, root, new Set(), () => {}, noManifests, {});
		expect(await heal()).toEqual([]); // nothing changed, and the hour is not over
		noteFix(root, "nestjs", "abc1234", "code job q7: added shared/money with tests");
		expect(await heal()).toEqual(["U1"]);
	});

	it("units hitting the same problem share one question: no new question, all wait, one answer releases them all", async () => {
		const { root, config, ledger, mk } = await workspace();
		for (const id of ["U1", "U2", "U3"]) mk(id, "billing", "implementing");
		const { askViaModel } = await import("../src/jev/ask.ts");
		const req = (unitId: string, sameAs: string) => askViaModel({ ledger, config, root }, { unitId, point: "gate_env", facts: "phpstan: Allowed memory size exhausted", options: [{ value: "fixed" }, { value: "quarantine" }], sameAs, askedBy: "test" });
		const first = await req("U1", "lint_ok: Allowed memory size of N bytes exhausted");
		const second = await req("U2", "lint_ok: Allowed memory size of N bytes exhausted");
		const other = await req("U3", "build_ok: something else");
		expect(second).toMatchObject({ id: first.id, shared: true });
		expect(other.id).not.toBe(first.id);
		expect(ledger.openQuestions()).toHaveLength(2);
		expect([...ledger.blockedUnits().entries()].filter(([, q]) => q.includes(first.id)).map(([u]) => u).sort()).toEqual(["U1", "U2"]);
		const go = async () => await resubmitParkedUnits(ledger, config, root, new Set(), () => {}, noManifests);
		expect(await go()).toEqual([]);
		ledger.answerQuestion(first.id, "fixed");
		expect((await go()).sort()).toEqual(["U1", "U2"]);
		expect(ledger.getUnit("U3")!.state).toBe("implementing");
	});

	it("a different key with the same cause joins the open question only when the decision model is sure; the join is remembered", async () => {
		const { root, config, ledger, mk } = await workspace();
		for (const id of ["U1", "U2", "U3", "U4"]) mk(id, "billing", "implementing");
		const { askViaModel } = await import("../src/jev/ask.ts");
		let pick: { choice: string; confidence: number } = { choice: "none", confidence: 0.9 };
		const client = new FakeModelClient({ decide: (req) => ("same" in req.questions ? { same: { type: "choice", choice: pick.choice, probabilities: {}, confidence: pick.confidence } } : {}) });
		const req = (unitId: string, sameAs: string, facts: string, c?: FakeModelClient) => askViaModel({ ledger, config, root, client: c }, { unitId, point: "gate_env", facts, options: [{ value: "fixed" }, { value: "quarantine" }], sameAs, askedBy: "test" });
		const first = await req("U1", "build_ok: memory exhausted in phpstan", "PHPStan ran out of memory (128M)", client);
		const sameCalls = () => client.calls.filter((c) => c.kind === "decide" && "same" in (c.req as any).questions).length;
		expect(sameCalls()).toBe(0); // nothing open to compare with yet
		// the model says the same cause, but not surely enough: a question of its own
		pick = { choice: `q${first.id}`, confidence: 0.5 };
		const unsure = await req("U2", "lint_ok: memory exhausted", "php-cs-fixer ran out of memory", client);
		expect(unsure.id).not.toBe(first.id);
		ledger.withdrawQuestion(unsure.id, "test");
		// sure: U3 waits on U1's question; the decision is recorded and the key remembered
		pick = { choice: `q${first.id}`, confidence: 0.9 };
		const joined = await req("U3", "build_ok: PHP memory limit reached", "PHPStan crashed at the 128M memory limit", client);
		expect(joined).toMatchObject({ id: first.id, shared: true });
		const dec = ledger.db.prepare("SELECT action FROM decisions WHERE point = 'same_cause' ORDER BY id DESC LIMIT 1").get() as { action: string };
		expect(dec.action).toBe(`join #${first.id}`);
		const calls = sameCalls();
		// U4 with the joined key matches by code, without a model and without asking the model again
		expect(await req("U4", "build_ok: PHP memory limit reached", "same")).toMatchObject({ id: first.id, shared: true });
		expect(sameCalls()).toBe(calls);
		expect([...ledger.blockedUnits().entries()].filter(([, q]) => q.includes(first.id)).map(([u]) => u).sort()).toEqual(["U1", "U3", "U4"]);
	});

	it("quarantine quarantines, free text becomes the next attempt's note, wait holds, a non-blocking question never strands", async () => {
		const { root, config, ledger, mk } = await workspace();
		for (const id of ["U1", "U2", "U3", "U4"]) mk(id, "billing", "implementing");
		const ask = (unitId: string, blocks: "unit" | "none" = "unit") => ledger.askQuestion({ unitId, point: "triage_gate", question: "?", options: ["fixed", "retry", "quarantine"], blocks, askedBy: "test" });
		const q1 = ask("U1");
		const q2 = ask("U2");
		ledger.updateUnit("U2", { meta: { parked: { question: q2, diagnosis: { summary: "the DB container is down" } } } });
		const q3 = ask("U3");
		ask("U4", "none"); // an old calibration-style question: must not keep U4 waiting forever
		const logs: string[] = [];
		const go = async () => await resubmitParkedUnits(ledger, config, root, new Set(), (l) => logs.push(l), noManifests);

		expect((await go()).sort()).toEqual(["U4"]);
		ledger.answerQuestion(q1, "quarantine");
		ledger.answerQuestion(q2, "start the db with docker compose up db first");
		ledger.answerQuestion(q3, "wait");
		expect((await go()).sort()).toEqual(["U2"]);
		expect(ledger.getUnit("U1")!.state).toBe("quarantined");
		const meta2 = JSON.parse(ledger.getUnit("U2")!.meta);
		expect(meta2.retryNote).toMatch(/DB container is down.*docker compose up db/);
		expect(meta2.parked).toBeUndefined();
		// wait: stays put on every later pass, until a requeue
		expect(await go()).toEqual([]);
		expect(ledger.getUnit("U3")!.state).toBe("implementing");
		expect(await requeueUnits(ledger, config, root, ["U3"], "test")).toEqual(["U3: requeued"]);
		expect(ledger.getUnit("U3")!.state).toBe("planned");
		expect(JSON.parse(ledger.getUnit("U3")!.meta).hold).toBeUndefined();
		ledger.close();
	});
});

describe("triage", () => {
	const gate = (output: string) => ({ ok: false, failedStep: "ported_tests_green", steps: [{ name: "ported_tests_green", ok: false, output, exitCode: 1 }], changedFiles: ["src/a.ts"], testFiles: ["test/a.spec.ts"] }) as never;
	it("asks only for the cause and whether the failure repeats; escalation comes from code", async () => {
		const { config, ledger, mk } = await workspace();
		mk("U1", "billing", "implementing");
		const client = new FakeModelClient({ decide: () => ({ cause: "impl_bug", same_as_previous: true }) });
		const t1 = await triageGate({ ledger, config, client }, "U1", gate("FAIL test/a.spec.ts\nexpected 2, got 3"), undefined, 1);
		const req = client.calls[0]!.req as { questions: Record<string, unknown>; state: { failing_tests: string[] } };
		expect(Object.keys(req.questions).sort()).toEqual(["cause", "same_as_previous"]);
		expect(req.state.failing_tests).toContain("test/a.spec.ts");
		expect(t1.action).toBe("retry");
		// the same failure class twice (Jev says so), not the same finding → a stronger model
		const t2 = await triageGate({ ledger, config, client }, "U1", gate("FAIL test/b.spec.ts\nTypeError: name of undefined"), gate("FAIL test/a.spec.ts\nexpected 2, got 3"), 2);
		expect(t2.action).toBe("escalate");
		// the very same finding again is a fact Jev reads, not a code rule: the owner is not asked
		const t3 = await triageGate({ ledger, config, client }, "U1", gate("FAIL test/a.spec.ts\nexpected 2, got 4"), gate("FAIL test/a.spec.ts\nexpected 2, got 3"), 2);
		expect((client.calls.at(-1)!.req as { state: { same_finding_as_previous: boolean } }).state.same_finding_as_previous).toBe(true);
		expect(t3.action).toBe("escalate");
		expect(ledger.openQuestions()).toEqual([]);
		ledger.close();
	});

	it("an unsure test-or-code cause acts on the best guess; nobody is asked", async () => {
		const { config, ledger, mk } = await workspace();
		mk("U1", "billing", "implementing");
		const unsure = { cause: { type: "choice", choice: "test_bug", probabilities: { test_bug: 0.52, impl_bug: 0.32, env: 0, other: 0.16 }, confidence: 0.44 } };
		// no second opinion comes back, so the answer stays unsure (a disagreeing one would decide the cause instead)
		const client = new FakeModelClient({ decide: () => unsure as never, chat: () => ({}) });
		const build = { ok: false, failedStep: "build_ok", steps: [{ name: "build_ok", ok: false, output: "tests/BillingTest.x:12 static call to instance method total()", exitCode: 1 }], changedFiles: [], testFiles: [] } as never;
		const t = await triageGate({ ledger, config, client }, "U1", build, undefined, 1);
		expect(t.sure).toBe(false);
		expect(t.action).toBe("retest");
		ledger.close();
	});

	it("the same finding after a retest, or a retest that changed nothing, never goes to the tester again: escalate", async () => {
		const { config, ledger, mk } = await workspace();
		mk("U1", "billing", "implementing");
		const client = new FakeModelClient({ decide: () => ({ cause: "interface_mismatch" }) });
		const wired = (output: string) => ({ ok: false, failedStep: "wired_ok", steps: [{ name: "wired_ok", ok: false, output, exitCode: 1 }], changedFiles: ["src/Billing/Invoice.php"], testFiles: [] }) as never;
		const finding = "- src/Billing/Invoice.php: total() is never called from the controller";
		const t1 = await triageGate({ ledger, config, client }, "U1", wired(finding), undefined, 1);
		expect(t1.action).toBe("retest");
		// the retest changed tests, but the same finding came back
		const t2 = await triageGate({ ledger, config, client }, "U1", wired(`${finding} (still)`), wired(finding), 2, { progress: true });
		expect(t2.action).toBe("escalate");
		// a new finding, but the retest before it changed nothing
		const t3 = await triageGate({ ledger, config, client }, "U1", wired("- src/Billing/Other.php: x"), wired(finding), 2, { progress: false });
		expect(t3.action).toBe("escalate");
		// a new finding after a retest that did something: the tester may try again
		const t4 = await triageGate({ ledger, config, client }, "U1", wired("- src/Billing/Other.php: x"), wired(finding), 2, { progress: true });
		expect(t4.action).toBe("retest");
		expect(ledger.openQuestions()).toEqual([]);
		ledger.close();
	});

	it("errors only in the ported tests are a fact Jev reads, whichever side of the path is longer; the command line is not an error", async () => {
		const { config, ledger, mk } = await workspace();
		mk("U1", "billing", "implementing");
		const client = new FakeModelClient({ decide: (req) => ({ cause: (req.state as { errors_in_protected_tests_only: boolean }).errors_in_protected_tests_only ? "test_bug" : "impl_bug" }) });
		const step = (name: string, output: string, testFiles: string[]) => ({ ok: false, failedStep: name, steps: [{ name, ok: false, output, exitCode: 1 }], changedFiles: ["src/Billing/Invoice.php", "tests/Billing/InvoiceTest.php"], testFiles }) as never;
		const cmd = "$ vendor/bin/phpstan analyse src/Billing/Invoice.php tests/Billing/InvoiceTest.php\n";
		// the tool prints project-relative paths, the test list is repo-relative
		const t1 = await triageGate({ ledger, config, client }, "U1", step("build_ok", `${cmd} tests/Billing/InvoiceTest.php:12 Call to an undefined method`, ["api/tests/Billing/InvoiceTest.php"]), undefined, 1);
		expect(t1).toMatchObject({ action: "retest", cause: "test_bug" });
		// the other way round
		const t2 = await triageGate({ ledger, config, client }, "U1", step("build_ok", `${cmd}/work/api/tests/Billing/InvoiceTest.php(3,1): error`, ["tests/Billing/InvoiceTest.php"]), undefined, 1);
		expect(t2.action).toBe("retest");
		// an error in production code too: not the tester's alone
		const t3 = await triageGate({ ledger, config, client }, "U1", step("build_ok", `${cmd}tests/Billing/InvoiceTest.php:12 x\nsrc/Billing/Invoice.php:3 y`, ["tests/Billing/InvoiceTest.php"]), undefined, 1);
		expect(t3.action).toBe("retry");
		expect((client.calls.at(-1)!.req as { state: { error_files: string[] } }).state.error_files).toEqual(["tests/Billing/InvoiceTest.php", "src/Billing/Invoice.php"]);
		ledger.close();
	});

	it("lint errors only in the ported tests go to the tester by code; build errors there are still the decision model's", async () => {
		const { config, ledger, mk } = await workspace();
		mk("U1", "billing", "implementing");
		const client = new FakeModelClient({ decide: () => ({ cause: "impl_bug" }) });
		const step = (name: string, output: string) => ({ ok: false, failedStep: name, steps: [{ name, ok: false, output, exitCode: 1 }], changedFiles: ["src/Billing/Invoice.php", "tests/Billing/InvoiceTest.php"], testFiles: ["tests/Billing/InvoiceTest.php"] }) as never;
		// php-cs-fixer names the file at the end of the line
		const fixer = "$ vendor/bin/php-cs-fixer fix --dry-run src/Billing/Invoice.php tests/Billing/InvoiceTest.php\n   1) tests/Billing/InvoiceTest.php\n";
		const t1 = await triageGate({ ledger, config, client }, "U1", step("lint_ok", fixer), undefined, 1);
		expect(t1).toMatchObject({ action: "retest", cause: "test_bug" });
		expect(client.calls).toHaveLength(0);
		// a retest that did not help goes the usual way
		const t2 = await triageGate({ ledger, config, client }, "U1", step("lint_ok", fixer), step("lint_ok", fixer), 2, { progress: true });
		expect(t2.action).not.toBe("retest");
		expect(client.calls).toHaveLength(1);
		// a build error in the test alone may mean the code it calls is missing: the model is asked
		const t3 = await triageGate({ ledger, config, client }, "U1", step("build_ok", "tests/Billing/InvoiceTest.php:12 Call to an undefined method total()"), undefined, 1);
		expect(t3.action).toBe("retry");
		expect((client.calls.at(-1)!.req as { state: { errors_in_protected_tests_only: boolean } }).state.errors_in_protected_tests_only).toBe(true);
		ledger.close();
	});

	it("an attempt that wrote nothing is retried with that message, twice or not; other identical anti-gaming failures are an environment cause, asked later", async () => {
		const { config, ledger, mk } = await workspace();
		mk("U1", "billing", "implementing");
		const client = new FakeModelClient({});
		const ag = (output: string) => ({ ok: false, failedStep: "antigaming_ok", steps: [{ name: "antigaming_ok", ok: false, output, exitCode: 1 }], changedFiles: [] }) as never;
		const none = await triageGate({ ledger, config, client }, "U1", ag("no production files were written"), ag("no production files were written"), 2);
		expect(none).toMatchObject({ action: "retry" });
		// stubs left for this unit are its own to replace: retried, never an environment cause
		const left = `src/a.ts:3: ${STUB_LEFT}\nsrc/b.ts:9: ${STUB_LEFT}`;
		expect(await triageGate({ ledger, config, client }, "U1", ag(left), ag(left), 2)).toMatchObject({ action: "retry", cause: "scope" });
		const out = await triageGate({ ledger, config, client }, "U1", ag("write outside unit scope: composer.json"), ag("write outside unit scope: composer.json"), 2);
		expect(out).toMatchObject({ action: "ask_human", cause: "env" });
		// triage asks nobody: unit.ts lets the doctor and the setup model try first
		expect(ledger.openQuestions()).toEqual([]);
		ledger.close();
	});

	it("an environment cause returns ask_human without asking anyone: the doctor looks first", async () => {
		const { config, ledger, mk } = await workspace();
		mk("U1", "billing", "implementing");
		const client = new FakeModelClient({ decide: () => ({ cause: "env" }) });
		const t = await triageGate({ ledger, config, client }, "U1", gate("connect ECONNREFUSED 127.0.0.1:5432"), undefined, 1);
		expect(t).toMatchObject({ action: "ask_human", cause: "env" });
		expect(ledger.openQuestions()).toEqual([]);
		ledger.close();
	});
});

describe("triage without a decision model", () => {
	it("falls back to the playbook by attempt count instead of throwing", async () => {
		const { config, ledger, mk } = await workspace();
		mk("U1", "billing", "implementing");
		const client = new FakeModelClient({ decide: () => { throw new Error("model gone"); } });
		const gate = { ok: false, failedStep: "ported_tests_green", steps: [{ name: "ported_tests_green", ok: false, output: "1 failed", exitCode: 1 }], changedFiles: ["src/a.ts"] } as never;
		const t1 = await triageGate({ ledger, config, client }, "U1", gate, undefined, 1);
		expect(t1).toMatchObject({ action: "retry", confidence: 1 });
		expect(t1.reason).toMatch(/decision model unavailable/);
		const max = config.run.maxImplementAttempts + config.run.maxEscalateAttempts;
		expect((await triageGate({ ledger, config, client }, "U1", gate, undefined, config.run.maxImplementAttempts)).action).toBe("escalate");
		expect((await triageGate({ ledger, config, client }, "U1", gate, undefined, max)).action).toBe("quarantine");
		expect(ledger.openQuestions()).toEqual([]);
		ledger.close();
	});
});

describe("quirks stay few", () => {
	it("drops of artifacts and edge cases are the tester's call; the owner's earlier answers go to the phrasing model", async () => {
		const { root, config, ledger, mk } = await workspace();
		mk("U1");
		mk("U2");
		mk("U3");
		const sym = "src/U1.php::f";
		expect(recordQuirk({ ledger, root }, { unitId: "U1", symbolId: sym, kind: "edge_case", behaviour: "empty list returns '0'", opinion: "drop", why: "callers cast" }).status).toBe("dropped");
		recordQuirk({ ledger, root }, { unitId: "U1", symbolId: sym, kind: "suspected_bug", behaviour: "VAT rounds half down on totals", opinion: "drop", why: "looks like a bug" });
		recordQuirk({ ledger, root }, { unitId: "U3", symbolId: "src/U3.php::f", kind: "intentional", behaviour: "dates print in US order", opinion: "keep", why: "reports" });
		// no phrasing (plain text back): the questions reach the owner
		const prompts: string[] = [];
		const client = new FakeModelClient({ chat: (req) => (prompts.push(req.messages.map((m) => m.content).join("\n")), undefined) });
		const d = { ledger, config, root, client };
		expect((await askPendingQuirks(d, "U1")).asked).toBe(1);
		expect(prompts[0]).not.toContain("Owner's earlier answers");
		expect((await askPendingQuirks(d, "U3")).asked).toBe(1);
		const [q1, q3] = ledger.openQuestions();
		ledger.answerQuestion(q1!.id, "keep");
		// a bulk "accepted the summary" answer only repeats a recommendation: not shown as the owner's view
		ledger.answerQuestion(q3!.id, "keep", "human (pi, accepted the summary)");
		recordQuirk({ ledger, root }, { unitId: "U2", symbolId: "src/U2.php::f", kind: "suspected_bug", behaviour: "VAT on invoice lines rounds half down", opinion: "drop", why: "same rounding" });
		expect((await askPendingQuirks(d, "U2")).asked).toBe(1);
		const last = prompts.at(-1)!;
		expect(last).toContain("Owner's earlier answers:\n- suspected_bug in src/U1.php::f: VAT rounds half down on totals → keep");
		expect(last).not.toContain("dates print in US order");
		// nothing decided behind the owner's back: the new quirk waits for its own answer
		expect(quirksOf({ ledger }, "U2")[0]).toMatchObject({ status: "asked" });
		ledger.close();
	});
});

describe("phrasing a question", () => {
	it("mentions another pick only when one was passed", async () => {
		const { config, ledger } = await workspace();
		const systems: string[] = [];
		const client = new FakeModelClient({ chat: (req) => (systems.push(req.messages[0]!.content as string), undefined) });
		const { askViaModel } = await import("../src/jev/ask.ts");
		const d = { ledger, config, client };
		await askViaModel(d, { point: "gate_env", facts: "the database is down", options: [{ value: "fixed" }, { value: "quarantine" }], askedBy: "doctor" });
		expect(systems[0]).not.toMatch(/agent|current pick/);
		expect(systems[0]).toContain("your own pick");
		await askViaModel(d, { point: "gate_env", facts: "the database is down", options: [{ value: "fixed" }, { value: "quarantine" }], recommended: "fixed", askedBy: "doctor" });
		expect(systems[1]).toContain("agree or disagree with the current pick");
		expect(systems[1]).not.toMatch(/agent/);
		await askViaModel(d, { point: "quirk", facts: "x", options: [{ value: "drop" }, { value: "keep" }], recommended: "drop", agentOpinion: "a bug", askedBy: "tester" });
		expect(systems[2]).toContain("agent's opinion");
		ledger.close();
	});
});

describe("area curation never touches migrated code", () => {
	it("areas with started units are fixed, only planned units move, keep is remembered", async () => {
		const { root, config, ledger, mk } = await workspace();
		mk("A1", "metadataids", "implementing");
		mk("A2", "metadataids");
		mk("B1", "clock");
		mk("C1", "invoice-utils");
		const areas = currentAreas(ledger);
		expect(areas.find((a) => a.area === "metadataids")!.fixed).toMatch(/migrated or running/);
		const client = new FakeModelClient({
			chat: () => ({
				json: {
					stacks: [{ stack: "nestjs", areas: [{ name: "billing", purpose: "invoices" }] }],
					rules: [
						{ prefix: "src/A2", to: "area", stack: "nestjs", area: "billing", confidence: 0.99, why: "ids belong to billing" },
						{ prefix: "src/B1", to: "exclude", stack: "nestjs", area: "none", confidence: 0.9, why: "tooling" },
						{ prefix: "src/C1", to: "area", stack: "nestjs", area: "billing", confidence: 0.5, why: "maybe billing" },
					],
				},
			}),
		});
		const d = { ledger, config, root, client };
		const r = await curateAreas(d);
		// metadataids has an accepted unit: not relabelled, not asked
		expect(JSON.parse(ledger.getUnit("A2")!.meta).place.area).toBe("metadataids");
		// a rule below the confidence to act is not applied and not asked: Jev places what no rule covers
		expect(JSON.parse(ledger.getUnit("C1")!.meta).place.area).toBe("invoice-utils");
		expect(r.asked).toBe(1);
		const qs = ledger.openQuestions();
		ledger.answerQuestion(qs.find((q) => JSON.parse(q.context ?? "{}").mapping?.from === "src/B1")!.id, "keep");
		syncTaxonomyAnswers(d);
		// keep is remembered: a second curation pass asks nothing about these areas
		expect(currentAreas(ledger).find((a) => a.area === "clock")!.fixed).toMatch(/owner kept/);
		const again = await curateAreas(d);
		expect(again.asked).toBe(0);
		expect(existsSync(join(root, ".bigrefactor", "areas.json"))).toBe(true);
		expect(readFileSync(join(root, ".bigrefactor", "areas.json"), "utf8")).toContain("billing");
		ledger.close();
	});
});

describe("an owner's quarantine answer stands", () => {
	it("leave on a waiting unit quarantines it; the auto-heal neither puts it back nor asks again", async () => {
		const { root, config, ledger, mk } = await workspace();
		const { askStuckUnits, healQuarantined } = await import("../src/run/run.ts");
		mk("U1", "billing", "implementing");
		const q = ledger.askQuestion({ unitId: "U1", point: "gate_env", question: "the gate needs redis", options: ["retry", "leave"], askedBy: "orchestrator" });
		ledger.answerQuestion(q, "leave");
		await resubmitParkedUnits(ledger, config, root, new Set(), () => {}, noManifests);
		expect(ledger.getUnit("U1")!.state).toBe("quarantined");
		expect(await healQuarantined(ledger, config, root, new Set(), () => {}, noManifests, { since: Date.now() + 1000, now: Date.now() + 9 * 60 * 60_000 })).toEqual([]);
		expect(await askStuckUnits({ ledger, config, root })).toBe(0);
		// a person's requeue still brings it back
		expect(await requeueUnits(ledger, config, root, ["U1"], "owner", { human: true })).toEqual(["U1: requeued"]);
		ledger.close();
	});
});

describe("circuit breaker", () => {
	it("every failure kind brings its text and a key; the same merge error in 3 units heals by code", async () => {
		const { ledger, mk } = await workspace();
		const { breakerEntry, breakerPick } = await import("../src/run/run.ts");
		const recent = ["U2415_a_cmd", "U0007_b", "U0100_c"].map((id) => {
			mk(id, "billing", "implementing");
			ledger.transitionUnit(id, "quarantined", `could not merge: could not rebase unit/${id} onto main: error: could not apply 1a2b3c4... ${id}\nfatal: no rebase in progress`);
			return breakerEntry(ledger, id, "quarantined", undefined);
		});
		expect(recent[0]!.text).toMatch(/no rebase in progress/);
		expect(new Set(recent.map((r) => r.sig)).size).toBe(1);
		const pick = breakerPick(recent, new Set())!;
		expect(pick).toMatchObject({ same: true, key: recent[0]!.sig });
		expect(pick.failed).toHaveLength(3);
		// a crash brings its message; the same crash in another file has the same key
		const crash = (id: string, f: string) => breakerEntry(ledger, id, "implementing", undefined, `ENOENT: no such file or directory, open '/w/worktrees/${id}/src/${f}'`);
		expect(crash("U0007_b", "a/A.test.tsx").text).toMatch(/ENOENT/);
		expect(crash("U0007_b", "a/A.test.tsx").sig).toBe(crash("U0100_c", "b/B.php").sig);
		ledger.close();
	});

	it("tried is per key: a healed error is not healed again, a later storm with another error still is", async () => {
		const { breakerPick } = await import("../src/run/run.ts");
		const f = (unit: string, sig: string) => ({ unit, ok: false, sig, text: sig });
		const tried = new Set<string>();
		const first = [f("U1", "a"), f("U2", "a"), f("U3", "a")];
		tried.add(breakerPick(first, tried)!.key);
		// the same error again: no code heal; the model sees it once more as a set
		const again = breakerPick(first, tried)!;
		expect(again.same).toBe(false);
		tried.add(again.key);
		expect(breakerPick(first, tried)).toBeUndefined();
		// a new storm later in the run is still caught
		expect(breakerPick([f("U4", "b"), f("U5", "b"), f("U6", "b")], tried)).toMatchObject({ same: true, key: "b" });
		// mixed failures go to the model; a set it already healed is not asked again, a new one is
		const mixed = [f("U7", "x"), f("U8", "y"), f("U9", "z")];
		const ask = breakerPick(mixed, tried)!;
		expect(ask.same).toBe(false);
		tried.add(ask.key);
		expect(breakerPick(mixed, tried)).toBeUndefined();
		expect(breakerPick([f("U7", "x"), f("U8", "y"), f("U10", "w")], tried)).toMatchObject({ same: false });
		// mostly green: nothing to do
		expect(breakerPick([...mixed, ...["A", "B", "C", "D"].map((unit) => ({ unit, ok: true }))], new Set())).toBeUndefined();
	});
	it("a unit waiting only on quirk questions is no failure; one waiting on an environment question still is", async () => {
		const { ledger, mk } = await workspace();
		const { breakerEntry } = await import("../src/run/run.ts");
		const res = (id: string) => ({ unitId: id, state: "truth", attempts: 0, costUsd: 0 });
		for (const id of ["U1", "U2"]) mk(id, "billing", "implementing");
		ledger.askQuestion({ unitId: "U1", point: "quirk", question: "keep the trailing space?", askedBy: "tester" });
		ledger.askQuestion({ unitId: "U2", point: "truth_env", question: "the old code needs a DB", askedBy: "tester" });
		expect(breakerEntry(ledger, "U1", "implementing", res("U1")).ok).toBe(true);
		expect(breakerEntry(ledger, "U2", "implementing", res("U2")).ok).toBe(false);
		ledger.close();
	});
});
