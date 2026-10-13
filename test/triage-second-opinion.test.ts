import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { FakeModelClient } from "../src/models/fake.ts";
import { triageGate } from "../src/run/triage.ts";

/** Jev unsure, the stronger model disagrees: triage acts on the stronger model's cause, not Jev's guess. */
describe("triage with a disagreeing second opinion", () => {
	it("does not retest when the stronger model says impl_bug", async () => {
		const root = mkdtempSync(join(tmpdir(), "br-tso-"));
		const config = ConfigSchema.parse({ source: { path: join(root, "legacy"), stack: "php" }, target: { path: join(root, "new"), stacks: ["nestjs"] }, models: {} });
		const ledger = new Ledger(":memory:");
		ledger.createUnit({ id: "U1", tier: "T0", symbolIds: [], meta: {} });
		// test_bug at a low confidence: below the act line, so the stronger model is asked
		const unsure = { type: "choice" as const, choice: "test_bug", probabilities: { test_bug: 0.45, impl_bug: 0.35 }, confidence: 0.2 };
		const client = new FakeModelClient({ decide: () => ({ cause: unsure }), chat: () => ({ json: { cause: "impl_bug" } }) });
		const gate = { ok: false, failedStep: "tests_ok", steps: [{ name: "tests_ok", ok: false, output: "FAIL src/a.test.ts\n  expected 2, got 3" }], changedFiles: ["src/a.ts"], testFiles: ["src/a.test.ts"] } as never;
		const t = await triageGate({ ledger, config, client }, "U1", gate, undefined, 1);
		expect(client.calls.some((c) => c.kind === "chat")).toBe(true);
		expect(t.cause).toBe("impl_bug");
		expect(t.action).toBe("retry");
		ledger.close();
	});
});
