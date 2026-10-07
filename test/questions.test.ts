import { describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger/db.ts";

function seed() {
	const l = new Ledger(":memory:");
	for (const f of ["src/Config.php", "src/Pricing.php", "src/controllers/InvoiceController.php", "src/controllers/UserController.php"]) {
		l.upsertFile({ path: f, hash: "h", lang: "php", loc: 1 });
		l.upsertSymbol({ id: `${f}::X`, path: f, kind: "class", name: "X" });
	}
	l.createUnit({ id: "U1", tier: "T0", symbolIds: ["src/Config.php::X"], meta: { files: ["src/Config.php"] } });
	l.createUnit({ id: "U2", tier: "T1", symbolIds: ["src/Pricing.php::X"], deps: ["U1"], meta: { files: ["src/Pricing.php"] } });
	l.createUnit({ id: "U3", tier: "T2", symbolIds: ["src/controllers/InvoiceController.php::X"], deps: ["U2"], meta: { files: ["src/controllers/InvoiceController.php"] } });
	l.createUnit({ id: "U4", tier: "T2", symbolIds: ["src/controllers/UserController.php::X"], deps: ["U1"], meta: { files: ["src/controllers/UserController.php"] } });
	return l;
}

describe("human questions in the ledger", () => {
	it("informational questions block nothing", () => {
		const l = seed();
		l.askQuestion({ unitId: "U2", point: "naming", question: "Prefer PricingService or PriceCalculator?", options: ["PricingService", "PriceCalculator"], blocks: "none", askedBy: "orchestrator" });
		expect(l.blockedUnits().size).toBe(0);
	});
	it("unit-scoped questions block only that unit; dependents-scoped block downstream too", () => {
		const l = seed();
		const q = l.askQuestion({ unitId: "U2", point: "truth_triage", question: "Is lineTotal(…, -1) == 0 intended?", blocks: "dependents", askedBy: "tester" });
		const b = l.blockedUnits();
		expect([...b.keys()].sort()).toEqual(["U2", "U3"]); // U1 (dep) and U4 (sibling) keep running
		expect(b.get("U3")).toEqual([q]);
		l.answerQuestion(q, "yes, legacy quirk; keep");
		expect(l.blockedUnits().size).toBe(0);
		expect(l.getQuestion(q)!.status).toBe("answered");
	});
	it("module-scoped questions block every unit in the same directory", () => {
		const l = seed();
		l.askQuestion({ unitId: "U3", point: "contract", question: "Keep HTML rendering or JSON-only API?", blocks: "module", askedBy: "orchestrator" });
		expect([...l.blockedUnits().keys()].sort()).toEqual(["U3", "U4"]);
	});
	it("a human answer labels the mirrored Jev decision", () => {
		const l = seed();
		const d = l.recordDecision({ unitId: "U2", point: "triage", model: "typesafe/jev-1.13", stateHash: "abc", answers: { cause: "impl_bug" }, confidence: 0.55 });
		const q = l.askQuestion({ unitId: "U2", point: "triage", question: "Gate failed; cause?", options: ["impl_bug", "test_bug"], askedBy: "orchestrator", decisionId: d });
		l.answerQuestion(q, "test_bug");
		const row = l.db.prepare("SELECT label FROM decisions WHERE id = ?").get(d) as { label: string };
		expect(row.label).toBe("test_bug");
		expect(() => l.answerQuestion(q, "again")).toThrow(/already answered/);
	});
});
