import { describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger/db.ts";
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
});
