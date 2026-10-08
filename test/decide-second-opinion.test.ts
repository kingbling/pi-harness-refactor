import { describe, expect, it } from "vitest";
import { decide } from "../src/jev/decide.ts";
import { Ledger } from "../src/ledger/db.ts";
import { FakeModelClient } from "../src/models/fake.ts";
import type { Battery } from "../src/jev/questions.ts";

/**
 * Every decision keeps what Jev saw (state) and, when a stronger model was asked, its answer even when it
 * disagreed. The second opinion is only asked when the caller says an unsure answer would change what it does.
 */
const battery: Battery = { area: { type: "choice", instructions: "which area", criteria: { a: "area a", b: "area b", other: null } } };
// a choice at 0.4 probability over 3 options: below the act line
const unsure = (choice: string) => ({ area: { type: "choice" as const, choice, probabilities: { a: 0.4, b: 0.3, other: 0.3 }, confidence: 0.1 } });

describe("decide: state and second opinion kept", () => {
	it("stores the state and a disagreeing second opinion", async () => {
		const ledger = new Ledger(":memory:");
		const client = new FakeModelClient({ decide: () => unsure("a"), chat: () => ({ json: { area: "b" } }) });
		const r = await decide({ client, ledger, model: "jev", second: "big" }, "placement", { path: "x.php" }, battery, ["area"]);
		expect(r.secondOpinion).toBe("disagreed");
		const row = ledger.db.prepare("SELECT state, answers FROM decisions WHERE id = ?").get(r.decisionId) as { state: string; answers: string };
		expect(JSON.parse(row.state)).toEqual({ path: "x.php" });
		const a = JSON.parse(row.answers);
		expect(a._second_opinion).toMatchObject({ verdict: "disagreed", answers: { area: "b" } });
		expect(a._jev.area.choice).toBe("a");
	});
	it("skips the second opinion when the caller says it cannot change the action", async () => {
		const ledger = new Ledger(":memory:");
		const client = new FakeModelClient({ decide: () => unsure("other"), chat: () => ({ json: { area: "other" } }) });
		const r = await decide({ client, ledger, model: "jev", second: "big", secondWhen: (a) => a["area"]?.type === "choice" && a["area"].choice !== "other" }, "placement", {}, battery, ["area"]);
		expect(r.secondOpinion).toBeUndefined();
		expect(client.calls.filter((c) => c.kind === "chat")).toHaveLength(0);
	});
});
