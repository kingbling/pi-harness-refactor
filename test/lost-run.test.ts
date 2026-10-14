import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger/db.ts";
import { lastRun, recordLostRun, renderLastRun } from "../src/run/run.ts";

/** A run that never reached its end (Pi closed, the run process killed) is written down by the next run's start. */
describe("a run without a record", () => {
	it("gets one from the ledger at the next start, once", () => {
		const root = mkdtempSync(join(tmpdir(), "br-lost-run-"));
		const ledger = new Ledger(":memory:");
		ledger.createUnit({ id: "u1", tier: "leaf", symbolIds: [] });
		ledger.createUnit({ id: "u2", tier: "leaf", symbolIds: [] });
		const startedAt = new Date(Date.now() - 60_000).toISOString();
		// accepted during the lost run (the gate's evidence is not what this test is about)
		ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = 'u1'").run();
		ledger.db.prepare("INSERT INTO transitions(entity, entity_id, from_state, to_state, reason, created_at) VALUES ('unit', 'u1', 'review', 'accepted', 'merged', ?)").run(new Date().toISOString());
		ledger.setMeta("open_run", JSON.stringify({ startedAt, stop: { at: startedAt, reason: "/br stop", finishing: ["u1"] } }));

		const r = recordLostRun(ledger, root)!;
		expect(r).toMatchObject({ startedAt, outcome: "ended", accepted: 1, quarantined: 0, planned: 1, stop: { reason: "/br stop", lanes: [{ unit: "u1", state: "accepted" }] } });
		expect(r.endedAt >= startedAt).toBe(true);
		expect(JSON.parse(readFileSync(join(root, ".bigrefactor", "runs.jsonl"), "utf8").trim())).toMatchObject({ outcome: "ended", accepted: 1 });
		expect(lastRun(ledger)?.outcome).toBe("ended");
		expect(renderLastRun(r)).toMatch(/ended .* without finishing .*after \/br stop: 1 accepted/);
		// written once: the next start finds nothing open
		expect(recordLostRun(ledger, root)).toBeUndefined();
	});
});
