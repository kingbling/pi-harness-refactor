import { describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger/db.ts";
import { ConfigSchema } from "../src/config.ts";
import { stubOwnerProblem, stubOwnersAcceptedSince } from "../src/run/gate.ts";
import { returnLateStubTries } from "../src/run/stopped-tries.ts";

/**
 * A stub TODO(br:<owner>) is right while its owner is still to come. When the owner is accepted while a try runs,
 * the scope step refuses the stub at that try's gate: the try could not know, so it uses none (unit.ts).
 */
describe("stubs whose owner was accepted while the try ran", () => {
	const ledger = new Ledger(":memory:");
	for (const id of ["u1", "early", "late"]) ledger.createUnit({ id, tier: "T1", deps: [], meta: {}, symbolIds: [] });
	const accept = (id: string, at: string) => {
		ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = ?").run(id);
		ledger.db.prepare("INSERT INTO transitions(entity, entity_id, from_state, to_state, reason, created_at) VALUES ('unit', ?, 'review', 'accepted', 'merged', ?)").run(id, at);
	};
	accept("early", "2026-10-20T10:00:00.000Z");
	accept("late", "2026-10-20T11:14:00.000Z");
	const line = (owner: string) => `src/a.tsx:10: TODO(br:${owner}) ${stubOwnerProblem(ledger, "u1", owner)}`;
	const since = "2026-10-20T11:00:00.000Z";

	it("names the owners accepted since the try started, when they are all the step refused", () => {
		expect(stubOwnersAcceptedSince(ledger, line("late"), since)).toEqual(["late"]);
		expect(stubOwnersAcceptedSince(ledger, `${line("late")}\n${line("late")}`, since)).toEqual(["late"]);
	});

	it("nothing when an owner was accepted before the try, or the step refused anything else", () => {
		expect(stubOwnersAcceptedSince(ledger, line("early"), since)).toBeUndefined();
		expect(stubOwnersAcceptedSince(ledger, `${line("late")}\nchanged a test of an earlier unit: src/b.test.tsx`, since)).toBeUndefined();
		expect(stubOwnersAcceptedSince(ledger, "", since)).toBeUndefined();
	});

	it("a unit parked at the cap for such stubs gets its try back once at run start", () => {
		const config = ConfigSchema.parse({ source: { path: "/tmp/src", stack: "php" }, target: { path: "/tmp/new", stacks: ["fake"], git: { branch: "migration/main" } }, models: {} });
		const a = ledger.startAttempt("u1", "escalate");
		ledger.db.prepare("UPDATE attempts SET started_at = ? WHERE id = ?").run(since, a);
		ledger.endAttempt(a, { outcome: "gate_red:antigaming_ok", gateReport: { ok: false, failedStep: "antigaming_ok", steps: [{ name: "antigaming_ok", ok: false, output: line("late") }] } });
		ledger.transitionUnit("u1", "quarantined", "gate still red after 5 attempts (antigaming_ok); scope/test tampering caught by code");
		expect(returnLateStubTries(ledger, config)).toEqual(["u1"]);
		expect(ledger.getUnit("u1")!.state).toBe("planned");
		expect(JSON.parse(ledger.getUnit("u1")!.meta)).toMatchObject({ triesUsed: config.run.maxImplementAttempts + config.run.maxEscalateAttempts - 1 });
		ledger.transitionUnit("u1", "quarantined", "again");
		expect(returnLateStubTries(ledger, config)).toEqual([]);
	});
});

