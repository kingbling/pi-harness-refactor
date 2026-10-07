import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decide } from "../src/jev/decide.ts";
import { JEV_ACT, type Battery } from "../src/jev/questions.ts";
import { Ledger } from "../src/ledger/db.ts";
import { FakeModelClient } from "../src/models/fake.ts";

/** One line for every Jev call: below JEV_ACT a stronger model answers blind; only agreement lets Jev's answer stand. */
const battery: Battery = {
	area: { type: "choice", instructions: "Which area?", criteria: { billing: "invoices", flights: "flight booking", other: null } },
	ui: { type: "noul", instructions: "Does it render UI?" },
};
const unsure = { area: { type: "choice" as const, choice: "billing", probabilities: { billing: 0.45, flights: 0.35, other: 0.2 }, confidence: 0.3 }, ui: { type: "noul" as const, noul: 0.7 } };

function run(second: Record<string, unknown> | undefined, jev = unsure) {
	const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "br-so-")), "l.sqlite"));
	const client = new FakeModelClient({ decide: () => jev, chat: () => (second ? { json: second } : undefined) });
	return { ledger, client, go: () => decide({ client, ledger, model: "jev", second: "openai/gpt-6.1-sol" }, "place_unit", { path: "src/invoice.php" }, battery, ["area", "ui"]) };
}

describe("second opinion below the act line", () => {
	it("an agreeing second opinion lifts the answers to the act line", async () => {
		const { go, client } = run({ area: "billing", ui: 0.9 });
		const d = await go();
		expect(d.secondOpinion).toBe("agreed");
		expect(d.confidence).toBe(JEV_ACT);
		expect((d.answers["area"] as { confidence: number }).confidence).toBe(JEV_ACT);
		expect(client.calls.map((c) => c.kind)).toEqual(["decide", "chat"]);
	});

	it("a disagreeing one leaves Jev unsure, so the caller falls back or asks", async () => {
		const d = await run({ area: "flights", ui: 0.9 }).go();
		expect(d.secondOpinion).toBe("disagreed");
		expect(d.confidence).toBeLessThan(JEV_ACT);
		// a yes/no on the same side but barely (0.55) is no agreement either
		expect((await run({ area: "billing", ui: 0.55 }).go()).secondOpinion).toBe("disagreed");
	});

	it("is not asked when Jev is sure, and says unavailable when the model gives nothing", async () => {
		const sure = { area: { ...unsure.area, confidence: 0.9 }, ui: { type: "noul" as const, noul: 0.95 } };
		const a = run({ area: "flights", ui: 0.1 }, sure);
		expect((await a.go()).secondOpinion).toBeUndefined();
		expect(a.client.calls.map((c) => c.kind)).toEqual(["decide"]);
		expect((await run(undefined).go()).secondOpinion).toBe("unavailable");
	});
});
