import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { returnTidyTries } from "../src/run/stopped-tries.ts";

/**
 * Before 0.4.59 a unit's card said "Tidy tasks for this area (do these too)" while the tidy job was to do them. U702
 * renamed CampaignEditPage (T5599) and broke 203 tests; U3050 did half of T5597 (U2fFormat). Parked so, they get a try back once.
 */
const config = ConfigSchema.parse({ source: { path: "/tmp/src", stack: "php" }, target: { path: "/tmp/new", stacks: ["fake"], git: { branch: "migration/main" } }, models: {} });
const maxTotal = config.run.maxImplementAttempts + config.run.maxEscalateAttempts;
const areaOf = (meta: string) => ({ stackId: "react", area: (JSON.parse(meta) as { area: string }).area });

function parked(ledger: Ledger, id: string, area: string, output: string) {
	ledger.createUnit({ id, tier: "T1", deps: [], meta: { area }, symbolIds: [] });
	const a = ledger.startAttempt(id, "escalate");
	ledger.endAttempt(a, { outcome: "gate_red:ported_tests_green", gateReport: { ok: false, steps: [{ name: "ported_tests_green", ok: false, output }] } });
	ledger.transitionUnit(id, "quarantined", `gate still red after ${maxTotal} attempts (ported_tests_green); attempt cap ${maxTotal} reached`);
	return ledger.askQuestion({ point: "quarantine", unitId: id, question: "parked", blocks: "unit", askedBy: "orchestrator" });
}

describe("units parked for a tidy task the tidy job does", () => {
	it("get one try back with a note to keep its files as on main; others and an owner's leave stay", () => {
		const ledger = new Ledger(":memory:");
		ledger.setMeta("tidy_tasks", JSON.stringify([{ id: "T5599", stack: "react", area: "campaigns", op: "rename", from: ["src/features/campaigns/components/CampaignEditPage.tsx"], to: ["src/features/campaigns/components/CampaignDeliverySettings.tsx"], why: "names", questionId: 5599, status: "approved" }]));
		const q = parked(ledger, "U702", "campaigns", 'Error: Failed to resolve import "./CampaignEditPage" from "src/features/campaigns/components/CampaignWidget.test.tsx".');
		parked(ledger, "other", "campaigns", "expected 2, got 3");
		parked(ledger, "elsewhere", "users", 'Failed to resolve import "./CampaignEditPage"');
		const kept = parked(ledger, "kept", "campaigns", 'Failed to resolve import "./CampaignEditPage"');
		ledger.answerQuestion(kept, "leave — Leave it parked", "human (pi)");
		expect(returnTidyTries(ledger, config, areaOf)).toEqual(["U702 (T5599)"]);
		expect(ledger.getUnit("U702")!.state).toBe("planned");
		const meta = JSON.parse(ledger.getUnit("U702")!.meta);
		expect(meta).toMatchObject({ triesUsed: maxTotal - 1, tidyTryReturned: "T5599" });
		expect(meta.retryNote).toMatch(/T5599 .* is done by the orchestrator, not by you/);
		expect(ledger.getQuestion(q)!.status).toBe("withdrawn");
		// once
		ledger.transitionUnit("U702", "quarantined", `attempt cap ${maxTotal} reached`);
		expect(returnTidyTries(ledger, config, areaOf)).toEqual([]);
	});
});
