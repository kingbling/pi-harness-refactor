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

	it("quarantined units go back every hour or after a fix, 5 times; then one question per kind of failure, and the answer is applied", async () => {
		const { root, config, ledger, mk } = workspace();
		const { askStuckUnits, healQuarantined } = await import("../src/run/run.ts");
		for (const id of ["U1", "U2"]) {
			mk(id, "billing", "implementing");
			ledger.transitionUnit(id, "quarantined", "gate still red after 5 attempts (lint_ok)");
		}
		const hour = 60 * 60_000;
		const heal = (o: { since?: number; now?: number }) => healQuarantined(ledger, config, root, new Set(), () => {}, noManifests, { since: Date.now() - hour, ...o });
		expect(heal({})).toEqual([]); // just failed, nothing changed
		expect(heal({ since: Date.now() + 1000 }).sort()).toEqual(["U1", "U2"]); // a fix landed since
		for (let i = 2; i <= config.run.maxAutoHeals + 1; i++) {
			for (const id of ["U1", "U2"]) {
				ledger.transitionUnit(id, "truth", "t");
				ledger.transitionUnit(id, "quarantined", "gate still red after 5 attempts (lint_ok)");
			}
			expect(heal({ now: Date.now() + hour + 1000 }).length).toBe(i <= config.run.maxAutoHeals ? 2 : 0); // an hour later
		}
		expect(JSON.parse(ledger.getUnit("U1")!.meta)).toMatchObject({ autoHeals: 5, retryNote: expect.stringMatching(/try 5 of 5/) });
		// out of tries: the owner is asked once for both (same failure)
		expect(await askStuckUnits({ ledger, config, root })).toBe(1);
		expect(await askStuckUnits({ ledger, config, root })).toBe(0);
		const q = ledger.openQuestions();
		expect(q).toHaveLength(1);
		expect(q[0]!.point).toBe("quarantine");
		expect(heal({ now: Date.now() + 9 * hour })).toEqual([]); // waits for the answer now
		ledger.answerQuestion(q[0]!.id, "the lint config was wrong, I fixed it");
		expect(heal({}).sort()).toEqual(["U1", "U2"]);
		expect(JSON.parse(ledger.getUnit("U2")!.meta)).toMatchObject({ autoHeals: 0, retryNote: expect.stringMatching(/hint: the lint config was wrong/) });
	});

	it("units hitting the same problem share one question: no new question, all wait, one answer releases them all", async () => {
		const { root, config, ledger, mk } = workspace();
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
		const go = () => resubmitParkedUnits(ledger, config, root, new Set(), () => {}, noManifests);
		expect(go()).toEqual([]);
		ledger.answerQuestion(first.id, "fixed");
		expect(go().sort()).toEqual(["U1", "U2"]);
		expect(ledger.getUnit("U3")!.state).toBe("implementing");
	});

	it("a different key with the same cause joins the open question only when the decision model is sure; the join is remembered", async () => {
		const { root, config, ledger, mk } = workspace();
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

	it("quarantine quarantines, free text becomes the next attempt's note, wait holds, a non-blocking question never strands", () => {
		const { root, config, ledger, mk } = workspace();
		for (const id of ["U1", "U2", "U3", "U4"]) mk(id, "billing", "implementing");
		const ask = (unitId: string, blocks: "unit" | "none" = "unit") => ledger.askQuestion({ unitId, point: "triage_gate", question: "?", options: ["fixed", "retry", "quarantine"], blocks, askedBy: "test" });
		const q1 = ask("U1");
		const q2 = ask("U2");
		ledger.updateUnit("U2", { meta: { parked: { question: q2, diagnosis: { summary: "the DB container is down" } } } });
		const q3 = ask("U3");
		ask("U4", "none"); // an old calibration-style question: must not keep U4 waiting forever
		const logs: string[] = [];
		const go = () => resubmitParkedUnits(ledger, config, root, new Set(), (l) => logs.push(l), noManifests);

		expect(go().sort()).toEqual(["U4"]);
		ledger.answerQuestion(q1, "quarantine");
		ledger.answerQuestion(q2, "start the db with docker compose up db first");
		ledger.answerQuestion(q3, "wait");
		expect(go().sort()).toEqual(["U2"]);
		expect(ledger.getUnit("U1")!.state).toBe("quarantined");
		const meta2 = JSON.parse(ledger.getUnit("U2")!.meta);
		expect(meta2.retryNote).toMatch(/DB container is down.*docker compose up db/);
		expect(meta2.parked).toBeUndefined();
		// wait: stays put on every later pass, until a requeue
		expect(go()).toEqual([]);
		expect(ledger.getUnit("U3")!.state).toBe("implementing");
		expect(requeueUnits(ledger, config, root, ["U3"], "test")).toEqual(["U3: requeued"]);
		expect(ledger.getUnit("U3")!.state).toBe("planned");
		expect(JSON.parse(ledger.getUnit("U3")!.meta).hold).toBeUndefined();
		ledger.close();
	});
});

describe("triage without a decision model", () => {
	it("falls back to the playbook by attempt count instead of throwing", async () => {
		const { config, ledger, mk } = workspace();
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
	it("drops of artifacts and edge cases are the tester's call; a precedent answers a matching quirk", async () => {
		const { root, config, ledger, mk } = workspace();
		mk("U1");
		mk("U2");
		const sym = "src/U1.php::f";
		expect(recordQuirk({ ledger, root }, { unitId: "U1", symbolId: sym, kind: "edge_case", behaviour: "empty list returns '0'", opinion: "drop", why: "callers cast" }).status).toBe("dropped");
		recordQuirk({ ledger, root }, { unitId: "U1", symbolId: sym, kind: "suspected_bug", behaviour: "VAT rounds half down on totals", opinion: "drop", why: "looks like a bug" });
		// the decision model matches the second rounding quirk to the owner's first decision
		const client = new FakeModelClient({
			decide: (req) => (req.questions["precedent"] ? { precedent: { type: "choice", choice: `p${(ledger.db.prepare("SELECT id FROM quirks WHERE behaviour LIKE 'VAT rounds%'").get() as { id: number }).id}`, probabilities: {}, confidence: 0.95 } } : undefined),
		});
		const d = { ledger, config, root, client };
		expect((await askPendingQuirks(d, "U1")).asked).toBe(1);
		const q = ledger.openQuestions()[0]!;
		ledger.answerQuestion(q.id, "keep");
		recordQuirk({ ledger, root }, { unitId: "U2", symbolId: "src/U2.php::f", kind: "suspected_bug", behaviour: "VAT on invoice lines rounds half down", opinion: "drop", why: "same rounding" });
		expect((await askPendingQuirks(d, "U2")).asked).toBe(0);
		expect(quirksOf({ ledger }, "U2")[0]).toMatchObject({ status: "kept", decided_by: expect.stringMatching(/^precedent #/) });
		ledger.close();
	});
});

describe("area curation never touches migrated code", () => {
	it("areas with started units are fixed, only planned units move, keep is remembered", async () => {
		const { root, config, ledger, mk } = workspace();
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
					mappings: [
						{ from: "nestjs:metadataids", to: "area", stack: "nestjs", area: "billing", confidence: 0.99, why: "ids belong to billing" },
						{ from: "nestjs:clock", to: "exclude", stack: "nestjs", area: "none", confidence: 0.9, why: "tooling" },
						{ from: "nestjs:invoice-utils", to: "area", stack: "nestjs", area: "billing", confidence: 0.5, why: "maybe billing" },
					],
				},
			}),
		});
		const d = { ledger, config, root, client };
		const r = await curateAreas(d);
		// metadataids has an accepted unit: not relabelled, not asked
		expect(JSON.parse(ledger.getUnit("A2")!.meta).place.area).toBe("metadataids");
		expect(r.asked).toBe(2);
		const qs = ledger.openQuestions();
		ledger.answerQuestion(qs.find((q) => q.question.includes("clock") || JSON.parse(q.context ?? "{}").mapping?.from === "nestjs:clock")!.id, "keep");
		ledger.answerQuestion(qs.find((q) => JSON.parse(q.context ?? "{}").mapping?.from === "nestjs:invoice-utils")!.id, "keep");
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
