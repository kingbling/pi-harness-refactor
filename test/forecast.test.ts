import { describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger/db.ts";
import { BIG_TABLE_INDEXES } from "../src/ledger/schema.ts";
import { forecast } from "../src/run/forecast.ts";

describe("forecast", () => {
	it("a unit waiting on another unit's question counts as waiting, not in flight", () => {
		const l = new Ledger(":memory:");
		for (const id of ["U1", "U2", "U3"]) {
			l.upsertFile({ path: `src/${id}.php`, hash: "h", lang: "php", loc: 5 });
			l.upsertSymbol({ id: `src/${id}.php::f`, path: `src/${id}.php`, kind: "function", name: "f" });
			l.createUnit({ id, tier: "T0", symbolIds: [`src/${id}.php::f`] });
			l.transitionUnit(id, "implementing");
		}
		const q = l.askQuestion({ point: "gate_env", unitId: "U1", question: "The database is down. What now?", options: ["retry"], blocks: "unit", askedBy: "t" });
		l.addWaiter(q, "U2");
		expect(forecast(l).units).toMatchObject({ waiting: 2, inFlight: 1 });
		l.close();
	});

	it("active hours are the union of attempt intervals, and its sums read small indexes, never the big attempts and decisions tables", () => {
		const l = new Ledger(":memory:");
		// what ensureLedgerIndexes builds in its worker
		l.db.exec(BIG_TABLE_INDEXES);
		l.createUnit({ id: "U1", tier: "T0", symbolIds: [] });
		const add = (s: string, e: string | null, usd: number) => l.db.prepare("INSERT INTO attempts(unit_id, role, cost_usd, started_at, ended_at) VALUES ('U1', 'implement', ?, ?, ?)").run(usd, s, e);
		add("2026-10-01T10:00:00.000Z", "2026-10-01T11:00:00.000Z", 1);
		add("2026-10-01T10:30:00.000Z", "2026-10-01T11:30:00.000Z", 2); // overlaps the first
		add("2026-10-01T13:00:00.000Z", "2026-10-01T13:15:00.000Z", 0.5);
		add("2026-10-01T14:00:00.000Z", null, 0); // still open: no length yet
		const f = forecast(l);
		expect(f.activeHours).toBeCloseTo(1.75, 6);
		expect(f.spentUsd).toBe(3.5);
		const plan = (sql: string) => (l.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail).join("; ");
		expect(plan("SELECT unit_id, SUM(cost_usd) c FROM attempts GROUP BY unit_id")).toMatch(/COVERING INDEX/);
		expect(plan("SELECT COALESCE(SUM(cost_usd),0) c FROM decisions WHERE unit_id IS NOT NULL")).toMatch(/COVERING INDEX/);
		expect(plan("SELECT started_at, ended_at FROM attempts ORDER BY started_at")).toMatch(/COVERING INDEX/);
		expect(plan("SELECT id, unit_id FROM attempts WHERE ended_at IS NULL")).toMatch(/INDEX attempts_open/);
		l.close();
	});
});
