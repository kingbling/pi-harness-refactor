import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { RESOLVER, resolveOpenQuestions, type Resolver } from "../src/jev/resolve.ts";

/**
 * A model tries every open question before the owner sees it: it answers what the code settles, hands the rest on
 * with its reason (context.forOwner, what the Pi cards show), tries each question once; a question that comes back
 * is the model's call again (with its earlier answers) up to a cap, and a setup cause runs a fix job first.
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
		// the same unit asks the same thing again after the resolver's answer: the model tries again, knowing it came back
		ledger.askQuestion({ unitId: "u1", point: "quarantine", question: "u1 keeps failing", options: ["retry — try again", "leave — leave it"], askedBy: "orchestrator" });
		await resolveOpenQuestions({ ledger, config, root: "/r", resolver });
		expect(calls).toBe(3);
	});

	it("a question that comes back is the model's call (it sees its earlier answers), up to a cap", async () => {
		const { MAX_RESOLVER_TRIES } = await import("../src/jev/resolve.ts");
		const ledger = new Ledger(":memory:");
		const config = ConfigSchema.parse({ source: { path: "/l", stack: "php" }, target: { path: "/t", stacks: ["nestjs"] }, models: {} });
		ledger.createUnit({ id: "u1", tier: "T1", deps: [], meta: {}, symbolIds: [] });
		const seen: number[] = [];
		const resolver: Resolver = async ({ earlier }) => (seen.push(earlier?.length ?? 0), { answer: "retry", why: "the cause changed" });
		for (let i = 0; i <= MAX_RESOLVER_TRIES; i++) {
			const q = ledger.askQuestion({ unitId: "u1", point: "gate_env", question: "lint fails", options: ["retry — retry", "leave — leave"], askedBy: "orchestrator" });
			await resolveOpenQuestions({ ledger, config, root: "/r", resolver });
			if (i === MAX_RESOLVER_TRIES) expect(JSON.parse(ledger.getQuestion(q)!.context!).forOwner).toMatch(/came back/);
		}
		expect(seen).toEqual([...Array(MAX_RESOLVER_TRIES).keys()]);
	});

	it("a setup cause runs a fix job first: fixed → answered with the resolver's option; nothing changed → the owner", async () => {
		const { FIX_JOB } = await import("../src/jev/resolve.ts");
		const ledger = new Ledger(":memory:");
		const config = ConfigSchema.parse({ source: { path: "/l", stack: "php" }, target: { path: "/t", stacks: ["nestjs"] }, models: {} });
		ledger.createUnit({ id: "u1", tier: "T1", deps: [], meta: {}, symbolIds: [] });
		const ask = () => ledger.askQuestion({ unitId: "u1", point: "gate_env", question: "the lint config loads a missing bootstrap file", options: ["retry — retry after fixing the setup", "leave — leave it parked"], askedBy: "orchestrator" });
		const resolver: Resolver = async () => ({ fix: "create the bootstrap file the lint config loads", then: "retry" });
		const a = ask();
		const jobs: string[] = [];
		await resolveOpenQuestions({ ledger, config, root: "/r", resolver, fixJob: async (_q, what) => (jobs.push(what), "created the bootstrap file") });
		expect(jobs).toEqual(["create the bootstrap file the lint config loads"]);
		expect(ledger.getQuestion(a)).toMatchObject({ status: "answered", answer: "retry — retry after fixing the setup", answered_by: FIX_JOB });
		const b = ask();
		await resolveOpenQuestions({ ledger, config, root: "/r", resolver, fixJob: async () => undefined });
		expect(JSON.parse(ledger.getQuestion(b)!.context!).forOwner).toMatch(/fix job was tried and changed nothing/);
	});
});
