import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { FakeModelClient } from "../src/models/fake.ts";
import { askAboutParked, askStuckUnits, healQuarantined, resubmitParkedUnits } from "../src/run/run.ts";
import { RESOLVER, resolveOpenQuestions } from "../src/jev/resolve.ts";
import { cannotJoin, sameQuestion } from "../src/jev/same.ts";
import { shareKey } from "../src/run/unit.ts";

/**
 * Parked units reach the owner when a person is needed (others wait on them, accepted units are built on them, or
 * nothing else is left to run); a unit is never parked on another unit's answer; "same cause" joins only what agrees.
 */
function workspace() {
	const root = mkdtempSync(join(tmpdir(), "br-parked-"));
	mkdirSync(join(root, "legacy"), { recursive: true });
	mkdirSync(join(root, ".bigrefactor"), { recursive: true });
	const raw = { version: 1, source: { path: join(root, "legacy"), stack: "php" }, target: { path: join(root, "new"), stacks: ["nestjs"] }, models: {} };
	writeFileSync(join(root, "bigrefactor.config.json"), JSON.stringify(raw));
	const config = ConfigSchema.parse(raw);
	const ledger = new Ledger(join(root, ".bigrefactor", "ledger.sqlite"));
	const mk = (id: string, deps: string[] = [], state?: "implementing" | "accepted") => {
		const file = `src/${id}.php`;
		ledger.upsertFile({ path: file, hash: "h", lang: "php", loc: 10 });
		ledger.upsertSymbol({ id: `${file}::f`, path: file, kind: "function", name: "f" });
		ledger.createUnit({ id, tier: "T0", deps, symbolIds: [`${file}::f`], meta: { files: [file], place: { stack: "nestjs", area: "billing", shared: false, source: "code" } } });
		if (state) {
			ledger.transitionUnit(id, "truth", "t");
			ledger.transitionUnit(id, "implementing", "t");
		}
		if (state === "accepted") ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = ?").run(id);
	};
	// a unit a model left parked: nothing a model can do is left
	const park = (id: string, why: string) => {
		ledger.transitionUnit(id, "quarantined", "gate still red after 5 attempts (build_ok)");
		ledger.updateUnit(id, { meta: { autoHeals: 5, healQuestion: 0, parkedWhy: why, parkedAt: Date.now() } });
	};
	return { root, config, ledger, mk, park };
}
const noManifests = new Map([["nestjs", { toolchain: { manifestFiles: [] as string[] } }]]);

describe("a parked unit reaches the owner when a person is needed", () => {
	it("asks once about a parked unit others wait on, with what waits and why it was parked; one nobody waits on stays quiet", async () => {
		const { root, config, ledger, mk, park } = workspace();
		mk("S1", [], "implementing");
		mk("S2", [], "implementing");
		mk("D1", ["S1"]);
		mk("D2", ["D1"]);
		mk("Other");
		park("S1", "the resolver model: the saved test expects a wrong base64 value");
		park("S2", "nothing left to try");
		expect(askAboutParked(ledger)).toBe(1);
		const q = ledger.openQuestions()[0]!;
		expect(q).toMatchObject({ unit_id: "S1", point: "parked" });
		expect(q.question).toMatch(/2 unit\(s\) cannot start until it is done \((D1, D2|D2, D1)\)/);
		expect(q.question).toMatch(/Why it was parked: the resolver model: the saved test expects a wrong base64 value/);
		expect(JSON.parse(q.context!).forOwner).toBeTruthy();
		expect(askAboutParked(ledger)).toBe(0); // once
		// br status no longer calls it "no question"
		const { renderStatus } = await import("../src/dashboard/status.ts");
		const status = renderStatus(ledger, { color: false });
		expect(status).toMatch(/parked, no question .*S2/);
		expect(status).not.toMatch(/parked, no question .*S1/);
		// the resolver leaves the owner's question alone, even after a plugin change
		let called = 0;
		await resolveOpenQuestions({ ledger, config, root, resolver: async () => (called++, { answer: "leave", why: "x" }), pluginChangedAt: Date.now() + 1000 });
		expect(called).toBe(0);
		// the owner's retry: a fresh set of tries, with their hint
		ledger.answerQuestion(q.id, "retry — give it a fresh set of tries\nhint: fix the saved test's expected value");
		expect(await healQuarantined(ledger, config, root, new Set(), () => {}, noManifests, { since: 0 })).toEqual(["S1"]);
		expect(JSON.parse(ledger.getUnit("S1")!.meta)).toMatchObject({ autoHeals: 0, retryNote: expect.stringMatching(/fix the saved test's expected value/) });
		expect(JSON.parse(ledger.getUnit("S1")!.meta).parkAsked).toBeUndefined();
	});

	it("the owner's leave stands: not asked again for that park", async () => {
		const { root, config, ledger, mk, park } = workspace();
		mk("S1", [], "implementing");
		mk("D1", ["S1"]);
		park("S1", "nothing left to try");
		expect(askAboutParked(ledger)).toBe(1);
		ledger.answerQuestion(ledger.openQuestions()[0]!.id, "leave — leave it parked");
		expect(await healQuarantined(ledger, config, root, new Set(), () => {}, noManifests, { since: 0 })).toEqual([]);
		expect(JSON.parse(ledger.getUnit("S1")!.meta)).toMatchObject({ healQuestion: 0 });
		expect(askAboutParked(ledger)).toBe(0);
		expect(await askStuckUnits({ ledger, config, root })).toBe(0);
	});

	it("asks about a parked unit accepted units are built on, and about every parked unit once nothing else is left to run", () => {
		const { ledger, mk, park } = workspace();
		mk("Schema", [], "implementing");
		mk("Built", ["Schema"], "accepted");
		mk("Lone", [], "implementing");
		mk("Busy");
		park("Schema", "re-opened for a newer check; the reviewer wants byte-level tests");
		park("Lone", "nothing left to try");
		expect(askAboutParked(ledger)).toBe(1);
		expect(ledger.openQuestions()[0]!.question).toMatch(/accepted units are built on it \(Built\)/);
		// the last other unit is done: nothing else is left, the lone parked unit is asked about too
		ledger.transitionUnit("Busy", "quarantined", "x");
		ledger.updateUnit("Busy", { meta: { healQuestion: 0 } }); // the owner left it (no parkedWhy): not asked
		expect(askAboutParked(ledger)).toBe(1);
		expect(ledger.openQuestions().map((q) => q.unit_id).sort()).toEqual(["Lone", "Schema"]);
		expect(ledger.openQuestions().find((q) => q.unit_id === "Lone")!.question).toMatch(/nothing else is left to run/);
	});

	it("while the owner is asked, a change on main that touches the failure still brings the unit back (the question is withdrawn)", async () => {
		const { root, config, ledger, mk, park } = workspace();
		mk("S1", [], "implementing");
		mk("D1", ["S1"]);
		park("S1", "a class outside the unit is missing");
		ledger.updateUnit("S1", { meta: { parkedAt: Date.now() - 60_000 } });
		askAboutParked(ledger);
		const q = ledger.openQuestions()[0]!;
		expect(await healQuarantined(ledger, config, root, new Set(), () => {}, noManifests, { since: Date.now() })).toEqual(["S1"]);
		expect(ledger.getQuestion(q.id)!.status).toBe("withdrawn");
	});
});

describe("a unit is never parked on another unit's answer", () => {
	it("a model's leave on another unit's question sends a waiter back to run on its own, once", async () => {
		const { root, config, ledger, mk } = workspace();
		mk("A", [], "implementing");
		mk("W", [], "implementing");
		const ask = (unitId: string) => ledger.askQuestion({ unitId, point: "gate_env", question: "App never passes the loader", options: ["retry — retry", "leave — leave the unit parked"], askedBy: "orchestrator" });
		const q = ask("A");
		ledger.addWaiter(q, "W");
		ledger.updateUnit("W", { meta: { parked: { question: q } } });
		ledger.answerQuestion(q, "leave — leave the unit parked\nhint: the campaign-review loader is A's", RESOLVER);
		const go = () => resubmitParkedUnits(ledger, config, root, new Set(), () => {}, noManifests);
		expect(await go()).toEqual(["W"]);
		expect(ledger.getUnit("A")!.state).toBe("quarantined");
		expect(ledger.getUnit("W")!.state).toBe("planned");
		expect(JSON.parse(ledger.getUnit("W")!.meta).retryNote).toMatch(/waited on question #\d+ about A[\s\S]*says nothing about this unit's own failure/);
		expect(JSON.parse(ledger.getUnit("W")!.meta).retryNote).not.toMatch(/campaign-review loader/);
		// it joins another unit's question again and a model leaves that one too: now it parks
		ledger.transitionUnit("W", "truth", "t");
		ledger.transitionUnit("W", "implementing", "t");
		const q2 = ask("A");
		ledger.addWaiter(q2, "W");
		ledger.answerQuestion(q2, "leave — leave the unit parked", RESOLVER);
		await go();
		expect(ledger.getUnit("W")!.state).toBe("quarantined");
	});

	it("an old ledger: a unit already parked on another unit's question gets one run on its own", async () => {
		const { root, config, ledger, mk, park } = workspace();
		mk("A", [], "implementing");
		mk("W", [], "implementing");
		const q = ledger.askQuestion({ unitId: "A", point: "gate_env", question: "?", options: ["retry — retry", "leave — leave"], askedBy: "orchestrator" });
		ledger.answerQuestion(q, "leave — leave", RESOLVER);
		park("W", "a code job wrote it but was not merged: stub marks of A were removed");
		ledger.updateUnit("W", { meta: { parked: { question: q }, autoHeals: undefined } });
		expect(await healQuarantined(ledger, config, root, new Set(), () => {}, noManifests, { since: 0 })).toEqual(["W"]);
		expect(JSON.parse(ledger.getUnit("W")!.meta)).toMatchObject({ ownLook: true, retryNote: expect.stringMatching(/parked on question #\d+ about A/) });
		expect(JSON.parse(ledger.getUnit("W")!.meta).parked).toBeUndefined();
	});
});

describe("same cause", () => {
	it("refuses a join when the step, the retry left or the out-of-scope part differ", () => {
		expect(cannotJoin({ failedStep: "wired_ok" }, { failureKind: "build_ok: x" })).toMatch(/another step/);
		expect(cannotJoin({ retry: "with a hint" }, { retry: "none" })).toMatch(/another retry/);
		expect(cannotJoin({ failedStep: "wired_ok" }, { failedStep: "wired_ok", outOfScope: "main.tsx" })).toMatch(/outside the unit's files/);
		expect(cannotJoin({ failedStep: "wired_ok", outOfScope: "a" }, { failedStep: "wired_ok", outOfScope: "b" })).toBeUndefined();
	});

	it("the model never sees a question that cannot be joined, and needs 0.85 to join", async () => {
		const { config, ledger, mk } = workspace();
		mk("A");
		mk("B");
		const none = ledger.askQuestion({ unitId: "A", point: "quarantine", question: "?", context: { sameAs: "quarantine: TODO names no unit | retry none", retry: "none" }, askedBy: "orchestrator" });
		const hint = ledger.askQuestion({ unitId: "A", point: "quarantine", question: "?", context: { sameAs: "quarantine: other | retry with a hint", retry: "with a hint" }, askedBy: "orchestrator" });
		let seen: string[] = [];
		let confidence = 0.76;
		const client = new FakeModelClient({ decide: (req) => ((seen = Object.keys((req.questions as any).same.criteria)), { same: { type: "choice", choice: `q${hint}`, probabilities: {}, confidence } }) });
		const d = { ledger, config, client };
		expect((await sameQuestion(d, ["quarantine"], "quarantine: stub left | retry with a hint", "stub left", "B", { retry: "with a hint" })).id).toBeUndefined();
		expect(seen).toEqual(["none", `q${hint}`]);
		expect(seen).not.toContain(`q${none}`);
		confidence = 0.9;
		expect(await sameQuestion(d, ["quarantine"], "quarantine: stub left | retry with a hint", "stub left", "B", { retry: "with a hint" })).toMatchObject({ id: hint, by: "model" });
	});

	it("a reviewer's findings share a key only when they point at the same places; without places they stay the unit's own", () => {
		const a = shareKey("U997", "wired_ok", "reviewer findings:\n- src/App.tsx:1113: never passes loadInventorySubnetView");
		const b = shareKey("U1473", "wired_ok", "reviewer findings:\n- src/App.tsx:1082: never passes loadInventorySearch");
		expect(a).not.toBe(b);
		expect(shareKey("U5", "wired_ok", "reviewer findings:\n- src/App.tsx:1113: never passes it")).toBe(a);
		expect(shareKey("U997", "wired_ok", "reviewer findings:\n- web/src/main.tsx mounts App without the loader")).toMatch(/U997/);
		expect(shareKey("U997", "build_ok", "Error: Class Foo not found")).not.toMatch(/U997/);
	});
});

describe("the self-heal check", () => {
	it("shows the decide model the failure's error messages, not the noisy start of the raw step output", async () => {
		const { root, config, ledger, mk } = workspace();
		mk("U1", [], "implementing");
		const noise = Array.from({ length: 400 }, (_, i) => `Generating autoload files ${i}: OK`).join("\n");
		const at = ledger.startAttempt("U1", "implement");
		ledger.endAttempt(at, { outcome: "gate_red:ported_tests_green", gateReport: { ok: false, failedStep: "ported_tests_green", steps: [{ name: "ported_tests_green", ok: false, output: `${noise}\n1) LegacyPostgresDataMigrationTest::testCounts\nFailed asserting that 12 is less than 10.\n${noise}\nFAILURES! Tests: 5, Failures: 1.` }], changedFiles: [] } });
		ledger.transitionUnit("U1", "quarantined", "db lane: gate still red after 5 attempts (ported_tests_green)");
		ledger.updateUnit("U1", { meta: { autoHeals: 1 } });
		let failure = "";
		const client = new FakeModelClient({ decide: (req) => ((failure = String((req.state as { failure: string }).failure)), { touches: 0.1 }) });
		await healQuarantined(ledger, config, root, new Set(), () => {}, noManifests, { since: Date.now() + 1000, client });
		expect(failure).toMatch(/Kind of failure: ported_tests_green/);
		expect(failure.slice(0, 1500)).toMatch(/Failed asserting that 12 is less than 10/);
	});
});
