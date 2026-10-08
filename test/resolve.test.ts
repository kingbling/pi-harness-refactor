import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { RESOLVER, resolveOpenQuestions, type Resolver } from "../src/jev/resolve.ts";

/**
 * A model tries every open question before the owner sees it: it answers what the code settles, hands the rest on
 * with its reason (context.forOwner, what the Pi cards show), tries each question once and never twice for the
 * same unit and point.
 */
describe("resolver model before the owner", () => {
	it("answers what it can, hands the rest to the owner with a reason, tries once", async () => {
		const ledger = new Ledger(":memory:");
		const config = ConfigSchema.parse({ source: { path: "/l", stack: "php" }, target: { path: "/t", stacks: ["nestjs"] }, models: {} });
		ledger.createUnit({ id: "u1", tier: "T1", deps: [], meta: {}, symbolIds: [] });
		const a = ledger.askQuestion({ unitId: "u1", point: "quarantine", question: "u1 keeps failing", options: ["retry — try again", "leave — leave it"], askedBy: "orchestrator" });
		const b = ledger.askQuestion({ point: "budget", question: "daily cap reached", options: ["raise — raise it", "tomorrow — wait"], askedBy: "orchestrator" });
		let calls = 0;
		const resolver: Resolver = async ({ q }) => (calls++, q.point === "quarantine" ? { answer: "retry", why: "the mock path is wrong" } : { owner: "money is the owner's call" });
		expect(await resolveOpenQuestions({ ledger, config, root: "/r", resolver })).toEqual({ answered: 1, forOwner: 1 });
		expect(ledger.getQuestion(a)).toMatchObject({ status: "answered", answer: "retry — try again", answered_by: RESOLVER });
		expect(JSON.parse(ledger.getQuestion(b)!.context!).forOwner).toBe("money is the owner's call");
		// once per question
		await resolveOpenQuestions({ ledger, config, root: "/r", resolver });
		expect(calls).toBe(2);
		// the same unit asks the same thing again after the resolver's answer: the owner decides
		const c = ledger.askQuestion({ unitId: "u1", point: "quarantine", question: "u1 keeps failing", options: ["retry — try again", "leave — leave it"], askedBy: "orchestrator" });
		await resolveOpenQuestions({ ledger, config, root: "/r", resolver });
		expect(calls).toBe(2);
		expect(JSON.parse(ledger.getQuestion(c)!.context!).forOwner).toMatch(/came back/);
	});
});
