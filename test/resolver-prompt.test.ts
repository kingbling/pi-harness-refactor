import { describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import type { SpawnOptions } from "../src/sessions/spawn.ts";

/** The resolver's prompt: a unit writing outside its scope is the unit's retry, never a code job (the code would land on main). */
const seen: SpawnOptions[] = [];
vi.mock("../src/sessions/spawn.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/sessions/spawn.ts")>()),
	spawnLeaf: async (o: SpawnOptions) => (seen.push(o), { run: async () => (await act?.(o), { text: "" }), dispose: () => {} }),
}));
// what the model does in its session (calls a tool); none by default
let act: ((o: SpawnOptions) => Promise<unknown>) | undefined;
const call = (name: string, p: unknown) => (o: SpawnOptions) => (o.customTools!.find((t) => t.name === name)! as unknown as { execute: (id: string, p: unknown) => Promise<{ content: Array<{ text: string }> }> }).execute("1", p);

describe("a hint for the tester", () => {
	it("for_tester marks the hint, so the unit's next run starts the tester with it; without a hint it is refused", async () => {
		const { resolveWithModel } = await import("../src/jev/resolve.ts");
		const { FOR_TESTER } = await import("../src/jev/ask.ts");
		const config = ConfigSchema.parse({ source: { path: "/l", stack: "php" }, target: { path: "/t", stacks: ["nestjs"] }, models: {} });
		const ledger = new Ledger(":memory:");
		ledger.createUnit({ id: "u1", tier: "T1", deps: [], meta: {}, symbolIds: [] });
		const id = ledger.askQuestion({ unitId: "u1", point: "gate_env", question: "skipped/only test in src/a.spec.ts", options: ["retry — run it again"], askedBy: "orchestrator" });
		const said: string[] = [];
		act = async (o) => {
			said.push((await call("answer_question", { answer: "retry", why: "w", for_tester: true })(o)).content[0]!.text);
			said.push((await call("answer_question", { answer: "retry", why: "w", hint: "drop the it.todo in src/a.spec.ts", for_tester: true })(o)).content[0]!.text);
		};
		const r = await resolveWithModel({ config, root: "/nowhere", q: ledger.getQuestion(id)! });
		act = undefined;
		expect(said[0]).toMatch(/not recorded: for_tester needs a hint/);
		expect(r).toMatchObject({ answer: "retry", hint: `${FOR_TESTER}drop the it.todo in src/a.spec.ts` });
		expect(seen.at(-1)!.systemPrompt).toMatch(/retry, for_tester true and a hint naming the test/);
	});
});

describe("the resolver's prompt", () => {
	it("says a 'write outside unit scope' red is never a code job", async () => {
		const { resolveWithModel } = await import("../src/jev/resolve.ts");
		const config = ConfigSchema.parse({ source: { path: "/l", stack: "php" }, target: { path: "/t", stacks: ["nestjs"] }, models: {} });
		const ledger = new Ledger(":memory:");
		ledger.createUnit({ id: "u1", tier: "T1", deps: [], meta: {}, symbolIds: [] });
		const id = ledger.askQuestion({ unitId: "u1", point: "quarantine", question: "write outside unit scope", options: ["retry — try again"], askedBy: "orchestrator" });
		await resolveWithModel({ config, root: "/nowhere", q: ledger.getQuestion(id)!, ledger } as unknown as Parameters<typeof resolveWithModel>[0]);
		expect(seen[0]!.systemPrompt).toContain(`- The gate's "write outside unit scope" red (the unit wrote a file outside its own list) is never a code_job`);
	});

	it("says a reviewer's finding outside the unit's files is not fixed by a retry or a hint, but by a code or fix job", async () => {
		const { resolveWithModel } = await import("../src/jev/resolve.ts");
		const config = ConfigSchema.parse({ source: { path: "/l", stack: "php" }, target: { path: "/t", stacks: ["nestjs"] }, models: {} });
		const ledger = new Ledger(":memory:");
		ledger.createUnit({ id: "u1", tier: "T1", deps: [], meta: {}, symbolIds: [] });
		const id = ledger.askQuestion({ unitId: "u1", point: "gate_env", question: "the reviewer asks for a change outside the unit's files", options: ["retry — run it again"], askedBy: "orchestrator", context: { failedStep: "wired_ok", outOfScope: "DeliveryWidget.tsx must render the chart" } });
		seen.length = 0;
		await resolveWithModel({ config, root: "/nowhere", q: ledger.getQuestion(id)! });
		const prompt = seen[0]!.systemPrompt!;
		expect(prompt).not.toContain("answer_question with retry and a hint fixes it");
		expect(prompt).toMatch(/outOfScope\) is the opposite case[\s\S]*A retry or a hint never lets the unit write a file outside the list[\s\S]*call code_job \(app code\) or fix_job \(setup\)/);
	});
});
