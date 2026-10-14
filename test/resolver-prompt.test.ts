import { describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import type { SpawnOptions } from "../src/sessions/spawn.ts";

/** The resolver's prompt: a unit writing outside its scope is the unit's retry, never a code job (the code would land on main). */
const seen: SpawnOptions[] = [];
vi.mock("../src/sessions/spawn.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/sessions/spawn.ts")>()),
	spawnLeaf: async (o: SpawnOptions) => (seen.push(o), { run: async () => ({ text: "" }), dispose: () => {} }),
}));

describe("the resolver's prompt", () => {
	it("says a 'write outside unit scope' red is never a code job", async () => {
		const { resolveWithModel } = await import("../src/jev/resolve.ts");
		const config = ConfigSchema.parse({ source: { path: "/l", stack: "php" }, target: { path: "/t", stacks: ["nestjs"] }, models: {} });
		const ledger = new Ledger(":memory:");
		ledger.createUnit({ id: "u1", tier: "T1", deps: [], meta: {}, symbolIds: [] });
		const id = ledger.askQuestion({ unitId: "u1", point: "quarantine", question: "write outside unit scope", options: ["retry — try again"], askedBy: "orchestrator" });
		await resolveWithModel({ config, root: "/nowhere", q: ledger.getQuestion(id)!, ledger } as unknown as Parameters<typeof resolveWithModel>[0]);
		expect(seen[0]!.systemPrompt).toContain(`- A "write outside unit scope" red is never a code_job: the unit's own files (its stubs too) are its to write; answer_question with retry and a hint fixes it.`);
	});
});
