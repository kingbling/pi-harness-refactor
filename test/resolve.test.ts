import { describe, expect, it, vi } from "vitest";
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
		// what the model found goes with the answer (a bare retry would run the unit again blind)
		expect(ledger.getQuestion(a)).toMatchObject({ status: "answered", answer: "retry — try again\nhint: what the resolver found: the mock path is wrong", answered_by: RESOLVER });
		expect(JSON.parse(ledger.getQuestion(b)!.context!).forOwner).toBe("money is the owner's call");
		// once per question
		await resolveOpenQuestions({ ledger, config, root: "/r", resolver });
		expect(calls).toBe(2);
		// the same unit asks the same thing again after the resolver's answer: the model tries again, knowing it came back
		ledger.askQuestion({ unitId: "u1", point: "quarantine", question: "u1 keeps failing", options: ["retry — try again", "leave — leave it"], askedBy: "orchestrator" });
		await resolveOpenQuestions({ ledger, config, root: "/r", resolver });
		expect(calls).toBe(3);
	});

	it("the resolver's hint and why stay with its retry, and a hint typed after the value is kept too", async () => {
		const { applyParkedAnswer } = await import("../src/run/run.ts");
		const { optionFor } = await import("../src/jev/ask.ts");
		const ledger = new Ledger(":memory:");
		const config = ConfigSchema.parse({ source: { path: "/l", stack: "php" }, target: { path: "/t", stacks: ["nestjs"] }, models: {} });
		ledger.createUnit({ id: "u1", tier: "T1", deps: [], meta: {}, symbolIds: [] });
		const options = ["retry — Retry with a hint (recommended)", "leave — leave it"];
		const a = ledger.askQuestion({ unitId: "u1", point: "quarantine", question: "u1 keeps failing", options, askedBy: "orchestrator" });
		const resolver: Resolver = async () => ({ answer: "retry", why: "the reviewer flags the eager load in services.php", hint: "load the TTD lazily in services.php" });
		await resolveOpenQuestions({ ledger, config, root: "/r", resolver });
		const answer = ledger.getQuestion(a)!.answer!;
		expect(applyParkedAnswer(answer, options)).toEqual({ action: "requeue", hint: "load the TTD lazily in services.php\nwhat the resolver found: the reviewer flags the eager load in services.php" });
		// "retry: <text>" keeps its text; the bare option has no hint; leave stays leave with a hint on it
		const q = ledger.getQuestion(a)!;
		expect(applyParkedAnswer(optionFor(q, "retry: move the class to Service/"), options)).toEqual({ action: "requeue", hint: "move the class to Service/" });
		expect(applyParkedAnswer(optionFor(q, "retry — Try again"), options)).toEqual({ action: "requeue", hint: undefined });
		expect(applyParkedAnswer(optionFor(q, "leave", "nothing a model can do"), options)).toEqual({ action: "quarantine" });
		expect(applyParkedAnswer("retry: the DB runs on 5433", options)).toEqual({ action: "requeue", hint: "the DB runs on 5433" });
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

	it("missing app code outside the unit runs a code job in the stack the resolver names; merged → answered", async () => {
		const { CODE_JOB } = await import("../src/jev/resolve.ts");
		const ledger = new Ledger(":memory:");
		const config = ConfigSchema.parse({ source: { path: "/l", stack: "php" }, target: { path: "/t", stacks: ["nestjs"] }, models: {} });
		ledger.createUnit({ id: "u1", tier: "T1", deps: [], meta: {}, symbolIds: [] });
		const a = ledger.askQuestion({ unitId: "u1", point: "quarantine", question: "the screen calls an endpoint that does not exist", options: ["retry — try again", "leave — leave parked"], askedBy: "orchestrator" });
		const resolver: Resolver = async () => ({ code: "add GET /api/x returning the formatted totals", then: "retry", stack: "backend" });
		const jobs: Array<[string, string | undefined]> = [];
		await resolveOpenQuestions({ ledger, config, root: "/r", resolver, fixJob: async () => "wrong job", codeJob: async (_q, what, stack) => (jobs.push([what, stack]), "added the endpoint with tests") });
		expect(jobs).toEqual([["add GET /api/x returning the formatted totals", "backend"]]);
		expect(ledger.getQuestion(a)).toMatchObject({ status: "answered", answer: "retry — try again", answered_by: CODE_JOB });
	});

	it("a path the layout has no slot for runs a layout job: applied → answered; it would break code on main → the owner", async () => {
		const { LAYOUT_JOB } = await import("../src/jev/resolve.ts");
		const ledger = new Ledger(":memory:");
		const config = ConfigSchema.parse({ source: { path: "/l", stack: "php" }, target: { path: "/t", stacks: ["symfony"] }, models: {} });
		ledger.createUnit({ id: "u1", tier: "T1", deps: [], meta: {}, symbolIds: [] });
		const ask = () => ledger.askQuestion({ unitId: "u1", point: "quarantine", question: "Security/WebAuthn/WebAuthnException.php is not an allowed file", options: ["retry — try again", "leave — leave quarantined"], askedBy: "orchestrator" });
		const resolver: Resolver = async () => ({ layout: "allow Security/{sub}/{Name}.php: the WebAuthn library is already there", then: "retry", stack: "symfony" });
		const a = ask();
		const jobs: Array<[string, string | undefined]> = [];
		await resolveOpenQuestions({ ledger, config, root: "/r", resolver, layoutJob: async (_q, what, stack) => (jobs.push([what, stack]), { applied: "Security/<sub>/<Name>.php allowed" }) });
		expect(jobs).toEqual([["allow Security/{sub}/{Name}.php: the WebAuthn library is already there", "symfony"]]);
		expect(ledger.getQuestion(a)).toMatchObject({ status: "answered", answer: "retry — try again", answered_by: LAYOUT_JOB });
		const b = ask();
		await resolveOpenQuestions({ ledger, config, root: "/r", resolver, layoutJob: async () => ({ owner: "it would make code already on main wrong" }) });
		expect(JSON.parse(ledger.getQuestion(b)!.context!).forOwner).toMatch(/already on main wrong/);
	});

	it("a question handed to the owner gets one more try after the plugin changed, once per change", async () => {
		const ledger = new Ledger(":memory:");
		const config = ConfigSchema.parse({ source: { path: "/l", stack: "php" }, target: { path: "/t", stacks: ["nestjs"] }, models: {} });
		ledger.createUnit({ id: "u1", tier: "T1", deps: [], meta: {}, symbolIds: [] });
		const q = ledger.askQuestion({ unitId: "u1", point: "quarantine", question: "u1 keeps failing", options: ["retry — try again", "leave — leave parked"], askedBy: "orchestrator" });
		ledger.markForOwner(q, "the resolver model answered this 3 times and it came back");
		let calls = 0;
		const resolver: Resolver = async () => (calls++, { owner: "still nothing a model can do" });
		await resolveOpenQuestions({ ledger, config, root: "/r", resolver, pluginChangedAt: 1 });
		expect(calls).toBe(0); // handed on after that change
		await new Promise((r) => setTimeout(r, 5));
		const later = Date.now(); // the plugin changed after the question was handed on
		await new Promise((r) => setTimeout(r, 5));
		await resolveOpenQuestions({ ledger, config, root: "/r", resolver, pluginChangedAt: later });
		await resolveOpenQuestions({ ledger, config, root: "/r", resolver, pluginChangedAt: later });
		expect(calls).toBe(1);
	});
});

describe("resolver failures and shared problems", () => {
	const config = ConfigSchema.parse({ source: { path: "/l", stack: "php" }, target: { path: "/t", stacks: ["nestjs"] }, models: {} });

	it("a failed resolver call leaves the question open and tries again later; the owner gets it only after a few failures", async () => {
		const { MAX_RESOLVER_FAILURES } = await import("../src/jev/resolve.ts");
		const ledger = new Ledger(":memory:");
		const q = ledger.askQuestion({ point: "budget", question: "cap", options: ["retry — retry"], askedBy: "orchestrator" });
		let calls = 0;
		const resolver: Resolver = async () => (calls++, Promise.reject(new Error("429 rate limited")));
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			for (let i = 1; i <= MAX_RESOLVER_FAILURES; i++) {
				await resolveOpenQuestions({ ledger, config, root: "/r", resolver });
				await resolveOpenQuestions({ ledger, config, root: "/r", resolver }); // waits: no second call right away
				expect(calls).toBe(i);
				vi.setSystemTime(Date.now() + i * 5 * 60_000 + 1);
			}
		} finally {
			vi.useRealTimers();
		}
		const ctx = JSON.parse(ledger.getQuestion(q)!.context!);
		expect(ctx.forOwner).toMatch(/429 rate limited \(3 times\)/);
	});

	it("tries on a problem several units share are counted per problem, not per unit", async () => {
		const { MAX_RESOLVER_TRIES } = await import("../src/jev/resolve.ts");
		const ledger = new Ledger(":memory:");
		const resolver: Resolver = async () => ({ answer: "retry", why: "w" });
		let last = 0;
		for (let i = 0; i <= MAX_RESOLVER_TRIES; i++) {
			ledger.createUnit({ id: `u${i}`, tier: "T1", deps: [], meta: {}, symbolIds: [] });
			last = ledger.askQuestion({ unitId: `u${i}`, point: "gate_env", question: "lint fails", options: ["retry — retry"], context: { sameAs: "lint:missing-config" }, askedBy: "orchestrator" });
			await resolveOpenQuestions({ ledger, config, root: "/r", resolver });
		}
		expect(JSON.parse(ledger.getQuestion(last)!.context!).forOwner).toMatch(/came back/);
	});

	it("a key that names its own unit never joins another unit's question", async () => {
		const { sameQuestion } = await import("../src/jev/same.ts");
		const ledger = new Ledger(":memory:");
		ledger.createUnit({ id: "u1", tier: "T1", deps: [], meta: {}, symbolIds: [] });
		ledger.askQuestion({ unitId: "u1", point: "parity", question: "differs", context: { sameAs: "parity:u1" }, askedBy: "parity" });
		const client = { chat: async () => { throw new Error("no model call expected"); } } as never;
		expect(await sameQuestion({ ledger, config, client }, ["parity"], "parity:u2", "differs", "u2")).toEqual({ costUsd: 0 });
	});
});

describe("the owner's question count", () => {
	it("during a run counts only questions the resolver handed on; without a run every open question", async () => {
		const { forOwnerCount } = await import("../src/pi/extension.ts");
		const ledger = new Ledger(":memory:");
		ledger.askQuestion({ point: "gate_env", question: "still with the models", askedBy: "orchestrator" });
		const b = ledger.askQuestion({ point: "budget", question: "money", askedBy: "orchestrator" });
		ledger.markForOwner(b, "money is the owner's call");
		expect(forOwnerCount(ledger, true)).toBe(1);
		expect(forOwnerCount(ledger, false)).toBe(2);
	});
});

describe("a parked unit's question", () => {
	it("a parked unit never goes to the owner as retry-or-leave: out of tries, nothing left or a retry that changes nothing → it stays parked", async () => {
		const ledger = new Ledger(":memory:");
		const config = ConfigSchema.parse({ source: { path: "/l", stack: "php" }, target: { path: "/t", stacks: ["nestjs"] }, models: {} });
		for (const id of ["u1", "u2", "u3"]) ledger.createUnit({ id, tier: "T1", deps: [], meta: {}, symbolIds: [] });
		const options = ["retry — try again", "leave — leave it"];
		const ask = (context?: Record<string, unknown>, unitId = "u1") => ledger.askQuestion({ unitId, point: "quarantine", question: "u1 keeps failing", options, askedBy: "orchestrator", context });
		const run = (r: Awaited<ReturnType<Resolver>>) => resolveOpenQuestions({ ledger, config, root: "/r", resolver: async () => r });
		const parked = (id: number) => expect(ledger.getQuestion(id)).toMatchObject({ status: "answered", answer: expect.stringMatching(/^leave — leave it\nhint: /), answered_by: RESOLVER });
		// retried on this kind of failure before: a plain retry is no answer, one with a hint is
		const sameKind = { retry: "with a hint", failureKind: "wired_ok: gate still red" };
		const a = ask(sameKind);
		expect(await run({ answer: "retry", why: "looks flaky" })).toEqual({ answered: 1, forOwner: 0 });
		parked(a);
		const b = ask(sameKind);
		await run({ answer: "retry", why: "the reviewer wants the lazy load", hint: "load the TTD lazily in services.php" });
		expect(ledger.getQuestion(b)!.answer).toMatch(/^retry — try again\nhint: load the TTD lazily/);
		// automatic tries used up: even a hint does not bring it back, only a job
		const c = ask({ retry: "none" });
		await run({ answer: "retry", why: "x", hint: "y" });
		parked(c);
		// nothing a model can do is left: parked, the owner is not asked
		const d = ask();
		await run({ park: "the legacy screen is dead code" });
		parked(d);
		expect(ledger.getQuestion(d)!.context).toBeNull(); // no forOwner
		// only what a person must do reaches the owner, in those words
		const e = ask(undefined, "u3");
		expect(await run({ owner: "the TTD account id is a credential only you have" })).toEqual({ answered: 0, forOwner: 1 });
		expect(ledger.getQuestion(e)).toMatchObject({ status: "open", question: "u3 is parked until you do this: the TTD account id is a credential only you have", options: JSON.stringify(["retry — done, run it again", "leave — leave it parked"]) });
		ledger.answerQuestion(e, "leave");
		// the resolver answered it MAX_RESOLVER_TRIES times or more: parked, not handed to the owner
		const f = ask();
		let called = false;
		await resolveOpenQuestions({ ledger, config, root: "/r", resolver: async () => ((called = true), { answer: "retry", why: "again" }) });
		expect(called).toBe(false);
		parked(f);
		expect(ledger.getQuestion(f)!.answer).toMatch(/answered this \d+ times and it came back/);
		// another point keeps its leave for the owner: parity's "leave it as it is" is not parking
		const g = ledger.askQuestion({ unitId: "u2", point: "parity", question: "differs", options: ["retry — re-open", "leave — leave it as it is"], askedBy: "parity" });
		await run({ park: "nothing left" });
		expect(JSON.parse(ledger.getQuestion(g)!.context!).forOwner).toBe("nothing left");
	});
});
