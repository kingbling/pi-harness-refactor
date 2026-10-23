import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger/db.ts";
import { sliceComplete, suiteGaps } from "../src/run/parity-check.ts";
import { MAX_PARITY_ERRORS, notePrepare, paritySlices, prepareTries, unpreparedSlices } from "../src/run/run.ts";
import { lastRun, renderLastRun, writeRunRecord } from "../src/run/run.ts";

describe("br run prepares missing parity checks", () => {
	let root: string;
	let ledger: Ledger;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "br-parityphase-"));
		ledger = new Ledger(":memory:");
		for (const [id, slice] of [["U1", "jobs"], ["U2", "jobs"], ["U3", "web"]] as const) {
			const path = `${id}.php`;
			ledger.upsertFile({ path, hash: "h", lang: "php", loc: 1 });
			ledger.upsertSymbol({ id: `${path}::run`, path, kind: "function", name: "run" });
			ledger.createUnit({ id, tier: "T0", symbolIds: [`${path}::run`], meta: { files: [path], slice } });
		}
		ledger.db.prepare("INSERT INTO index_routes(id,side,method,path,handler_symbol) VALUES ('r','source','GET','/web','U3.php::run')").run();
	});
	afterEach(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
	const accept = (...ids: string[]) => { for (const id of ids) ledger.db.prepare("UPDATE units SET state='accepted' WHERE id=?").run(id); };
	const suite = (slice: string, s: unknown) => {
		const dir = join(root, ".bigrefactor/parity/slices", slice);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "steps.json"), JSON.stringify(s));
	};

	it("finds the gaps of finished slices only: no suite, a route without a step, a page without a browser check", () => {
		expect(paritySlices(ledger).sort()).toEqual(["jobs", "web"]);
		expect(suiteGaps(ledger, root, "jobs")).toEqual([]);
		accept("U1", "U2", "U3");
		expect(sliceComplete(ledger, "jobs")).toBe(true);
		// route-less and without checks: data, dynamic and foundation were never compared for this
		expect(suiteGaps(ledger, root, "jobs")).toEqual(["no steps.json"]);
		suite("web", { steps: [] });
		expect(suiteGaps(ledger, root, "web").join("\n")).toMatch(/no compared scenario for GET \/?web/);
		suite("web", { steps: [{ id: "s1", route: "GET /web", compare: "page", method: "GET", path: "/web" }] });
		expect(suiteGaps(ledger, root, "web").join("\n")).toMatch(/page s1: needs a browser check/);
	});

	it("counts failed preparations per plugin version and forgets them once the checks are written", () => {
		expect(prepareTries(ledger, "jobs", "0.4.73")).toBe(0);
		for (let i = 0; i < MAX_PARITY_ERRORS; i++) notePrepare(ledger, "jobs", "0.4.73", "steps.json needs a non-empty steps array");
		expect(prepareTries(ledger, "jobs", "0.4.73")).toBe(MAX_PARITY_ERRORS);
		expect(unpreparedSlices(ledger, "0.4.73")).toEqual([{ slice: "jobs", why: "steps.json needs a non-empty steps array" }]);
		// a new plugin version may write them: fresh tries
		expect(prepareTries(ledger, "jobs", "0.4.74")).toBe(0);
		expect(unpreparedSlices(ledger, "0.4.74")).toEqual([]);
		notePrepare(ledger, "jobs", "0.4.73", undefined);
		expect(prepareTries(ledger, "jobs", "0.4.73")).toBe(0);
		expect(unpreparedSlices(ledger, "0.4.73")).toEqual([]);
	});

	it("says a run finished only when its strict replay passed", () => {
		const base = { startedAt: "2026-10-23T10:00:00Z", endedAt: "2026-10-23T12:00:00Z", outcome: "finished" as const, accepted: 5, quarantined: 0, planned: 0, openQuestions: 0, costUsd: 1, units: [] };
		writeRunRecord(ledger, root, { ...base, parity: { status: "blocked", problems: 12, first: "112 units are not accepted" } });
		expect(renderLastRun(lastRun(ledger)!)).toMatch(/^last run ended .*parity blocked \(12 problem\(s\), first: 112 units are not accepted\)/);
		writeRunRecord(ledger, root, { ...base, parity: { status: "passed", problems: 0 } });
		expect(renderLastRun(lastRun(ledger)!)).toMatch(/^last run finished .*parity verified$/);
		writeRunRecord(ledger, root, base);
		expect(renderLastRun(lastRun(ledger)!)).toMatch(/parity not checked$/);
	});
});
