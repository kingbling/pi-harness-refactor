import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { NOT_JUDGED_STOPPING, returnStoppedTries, unjudgedByStop } from "../src/run/stopped-tries.ts";

/**
 * A stop cuts off the tries in their gates: the review is not run ("not judged: the run is stopping"). Such a try is
 * no used try; units parked at the attempt cap with one get it back at the next start.
 */
const config = ConfigSchema.parse({ source: { path: "/tmp/src", stack: "php" }, target: { path: "/tmp/new", stacks: ["fake"], git: { branch: "migration/main" } }, models: {} });
const maxTotal = config.run.maxImplementAttempts + config.run.maxEscalateAttempts;
const notJudged = { ok: false, steps: [{ name: "build_ok", ok: true, output: "" }, { name: "wired_ok", ok: false, output: NOT_JUDGED_STOPPING }] };
const judged = { ok: false, steps: [{ name: "wired_ok", ok: false, output: "reviewer findings:\n- a.tsx:1: wrong" }] };

function parked(ledger: Ledger, id: string, report: unknown, why = `gate still red after ${maxTotal} attempts (wired_ok); attempt cap ${maxTotal} reached`) {
	ledger.createUnit({ id, tier: "T1", deps: [], meta: {}, symbolIds: [] });
	const a = ledger.startAttempt(id, "escalate");
	ledger.endAttempt(a, { outcome: "stopped", gateReport: report });
	ledger.transitionUnit(id, "quarantined", why);
	return ledger.askQuestion({ point: "quarantine", unitId: id, question: "parked", blocks: "unit", askedBy: "orchestrator" });
}

describe("tries a stop cut off before they were judged", () => {
	it("are no used tries", () => {
		expect(unjudgedByStop(notJudged)).toBe(true);
		expect(unjudgedByStop(judged)).toBe(false);
		expect(unjudgedByStop(undefined)).toBe(false);
	});

	it("a unit parked at the cap with one gets it back once: planned, one try left, its park question withdrawn", () => {
		const ledger = new Ledger(":memory:");
		const q = parked(ledger, "u1", notJudged);
		expect(returnStoppedTries(ledger, config)).toEqual(["u1 (1)"]);
		expect(ledger.getUnit("u1")!.state).toBe("planned");
		expect(JSON.parse(ledger.getUnit("u1")!.meta)).toMatchObject({ triesUsed: maxTotal - 1, stopTriesReturned: 1 });
		expect(ledger.getQuestion(q)!.status).toBe("withdrawn");
		// parked at the cap again later: the tries were given back already
		ledger.transitionUnit("u1", "quarantined", `attempt cap ${maxTotal} reached`);
		expect(returnStoppedTries(ledger, config)).toEqual([]);
	});

	it("leaves alone a try the review judged, a park not at the cap, and a park the owner chose to keep", () => {
		const ledger = new Ledger(":memory:");
		parked(ledger, "judged", judged);
		parked(ledger, "other", notJudged, "its migration fails on an empty database");
		const q = parked(ledger, "kept", notJudged);
		ledger.answerQuestion(q, "leave — Leave it parked", "human (pi)");
		expect(returnStoppedTries(ledger, config)).toEqual([]);
		expect(ledger.getUnit("judged")!.state).toBe("quarantined");
	});
});
