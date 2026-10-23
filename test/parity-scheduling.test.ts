import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger/db.ts";
import { paritySliceReady } from "../src/run/parity-check.ts";
import { parityOnAccept } from "../src/run/run.ts";

describe("scheduling parity checks beyond HTTP routes", () => {
	let root: string;
	let ledger: Ledger;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "br-parityschedule-"));
		ledger = new Ledger(":memory:");
		for (const id of ["U1", "U2"]) {
			const path = `${id}.php`;
			ledger.upsertFile({ path, hash: "h", lang: "php", loc: 1 });
			ledger.upsertSymbol({ id: `${path}::run`, path, kind: "function", name: "run" });
			ledger.createUnit({ id, tier: "T0", symbolIds: [`${path}::run`], meta: { files: [path], slice: "jobs" } });
		}
	});
	afterEach(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
	const accept = (id: string) => ledger.db.prepare("UPDATE units SET state='accepted' WHERE id=?").run(id);
	const checks = () => {
		const dir = join(root, ".bigrefactor/parity/slices/jobs");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "steps.json"), JSON.stringify({ steps: [], checks: [{ id: "job-results", kind: "command", covers: [], why: "Observe the real job output", command: { cmd: "node", args: ["job-check.mjs"] }, inputs: ["job-check.mjs"] }] }));
	};
	it("queues prepared non-HTTP checks only when every slice unit is accepted", () => {
		checks();
		expect(paritySliceReady(ledger, "jobs")).toBe(false);
		accept("U1");
		expect(paritySliceReady(ledger, "jobs")).toBe(false);
		accept("U2");
		expect(paritySliceReady(ledger, "jobs")).toBe(true);
		ledger.db.prepare("UPDATE units SET state='quarantined' WHERE id='U2'").run();
		expect(paritySliceReady(ledger, "jobs")).toBe(false);
	});
	it("reruns non-HTTP checks after reacceptance even if the last comparison matched", () => {
		checks(); accept("U1"); accept("U2");
		ledger.db.prepare("INSERT INTO parity_runs(slice,outcome,started_at) VALUES ('jobs','same',datetime('now'))").run();
		expect(parityOnAccept(ledger, "jobs", "U2")).toBe(true);
		expect(paritySliceReady(ledger, "jobs")).toBe(true);
	});
	it("is ready once complete even without checks (the run prepares them), and needs actual slice members", () => {
		accept("U1"); accept("U2");
		expect(paritySliceReady(ledger, "jobs")).toBe(true);
		checks();
		ledger.db.prepare("DELETE FROM units").run();
		expect(paritySliceReady(ledger, "jobs")).toBe(false);
	});
	it("retains early comparisons for accepted HTTP owners without waiting for unrelated units", () => {
		ledger.db.prepare("INSERT INTO index_routes(id,side,method,path,handler_symbol) VALUES ('job','source','GET','/jobs','U1.php::run')").run();
		accept("U2");
		expect(paritySliceReady(ledger, "jobs")).toBe(false);
		accept("U1");
		ledger.db.prepare("UPDATE units SET state='planned' WHERE id='U2'").run();
		expect(paritySliceReady(ledger, "jobs")).toBe(true);
		ledger.db.prepare("INSERT INTO parity_runs(slice,outcome,started_at) VALUES ('jobs','same',datetime('now'))").run();
		expect(parityOnAccept(ledger, "jobs", "U1")).toBe(true);
		expect(parityOnAccept(ledger, "jobs", "U2")).toBe(false);
	});
});
