import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { inventory } from "../src/inventory/run.ts";
import { applySlicePlan, planSlices } from "../src/inventory/slices.ts";
import { Ledger } from "../src/ledger/db.ts";
import { checkSlice, routeOwners, type Step } from "../src/run/parity-check.ts";
import { holdBack, waitingRoutes } from "../src/run/parity-partial.ts";

/** A slice is compared before it is finished: only the steps of routes whose unit is accepted are compared. */
const FIXTURE = resolve(import.meta.dirname, "../fixtures/mini-app");

describe("comparing a slice before it is finished", () => {
	it("steps of routes whose unit is not accepted are sent but not compared; a slice with none ready is not run and not recorded", async () => {
		const root = mkdtempSync(join(tmpdir(), "br-paritypartial-"));
		const legacy = join(root, "legacy");
		cpSync(FIXTURE, legacy, { recursive: true });
		const config = ConfigSchema.parse({ source: { path: legacy, stack: "php" }, target: { path: join(root, "new"), stacks: ["nestjs"] }, models: {}, db: { strategy: "none" } });
		const ledger = new Ledger(":memory:");
		await inventory(config, legacy, ledger);
		applySlicePlan(ledger, planSlices(ledger));
		const [owner] = routeOwners(ledger, "invoices");
		expect(owner?.state).toBe("planned");

		const waiting = waitingRoutes(ledger, "invoices");
		expect([...waiting.keys()].sort()).toEqual(["invoices", "invoices/{id}"]);
		const steps: Step[] = [
			{ id: "login", route: "setup", compare: "none", method: "GET", path: "/login" },
			{ id: "list", route: "GET /invoices", compare: "data", method: "GET", path: "/invoices", save: { n: "(\\d+)" } },
			{ id: "one", route: "/invoices/{id}", compare: "data", method: "GET", path: "/invoices/{{n}}" },
		];
		const held = holdBack(steps, waiting);
		expect(held.steps.map((s) => s.compare)).toEqual(["none", "none", "none"]);
		expect(held.steps[1]!.save).toEqual({ n: "(\\d+)" }); // still sent: a later step may need what it saves
		expect(held.held).toEqual([`list (${owner!.id})`, `one (${owner!.id})`]);

		// the run's check: nothing ready → no app is started, nothing recorded (no error counted against the slice)
		mkdirSync(join(root, ".bigrefactor", "parity", "slices", "invoices"), { recursive: true });
		const recipe = { dir: ".", start: { cmd: "false", args: [] }, ready: "http://localhost:1/" };
		writeFileSync(join(root, ".bigrefactor", "parity", "apps.json"), JSON.stringify({ legacy: { up: true, recipe }, nestjs: { up: true, recipe } }));
		writeFileSync(join(root, ".bigrefactor", "parity", "slices", "invoices", "steps.json"), JSON.stringify({ steps, skipped: { "POST /invoices": "t" } }));
		const r = await checkSlice({ ledger, config, root, slice: "invoices", linkAll: () => {}, serverStack: "nestjs", onlyAccepted: true, writer: async () => { throw new Error("steps are kept"); }, log: () => {} });
		expect(r).toMatchObject({ outcome: "error", compared: 0 });
		expect(r.runId).toBeUndefined();
		expect(r.note).toMatch(/not compared yet/);
		expect(ledger.db.prepare("SELECT COUNT(*) n FROM parity_runs").get()).toEqual({ n: 0 });

		// once the route's unit lands, its steps are compared
		ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = ?").run(owner!.id);
		expect(waitingRoutes(ledger, "invoices").size).toBe(0);
		expect(holdBack(steps, waitingRoutes(ledger, "invoices")).steps).toEqual(steps);
	});
});

describe("a slice with one route owner accepted and one not", () => {
	it("the step writer is asked only for the ready routes, only their steps are compared, and the run is recorded", async () => {
		const root = mkdtempSync(join(tmpdir(), "br-paritypartial2-"));
		const legacy = join(root, "legacy");
		cpSync(FIXTURE, legacy, { recursive: true });
		writeFileSync(join(legacy, "src/controllers/ReportController.php"), "<?php\nclass ReportController\n{\n    public function totals(): string\n    {\n        return json_encode(['total' => 1]);\n    }\n}\n");
		writeFileSync(join(legacy, "routes.php"), "<?php\nrequire_once __DIR__ . '/src/controllers/InvoiceController.php';\nrequire_once __DIR__ . '/src/controllers/ReportController.php';\nreturn [\n    ['GET', '/invoices/{id}', [InvoiceController::class, 'show']],\n    ['POST', '/invoices', [InvoiceController::class, 'create']],\n    ['GET', '/invoices', [InvoiceController::class, 'recent']],\n    ['GET', '/reports/totals', [ReportController::class, 'totals']],\n];\n");
		const config = ConfigSchema.parse({ source: { path: legacy, stack: "php" }, target: { path: join(root, "new"), stacks: ["nestjs"] }, models: {}, db: { strategy: "none" } });
		const ledger = new Ledger(":memory:");
		await inventory(config, legacy, ledger);
		applySlicePlan(ledger, planSlices(ledger));
		// both controllers' units in one slice; the invoices one is accepted, the reports one is not
		const unitOf = (file: string) => ledger.listUnits().find((u) => (JSON.parse(u.meta).files ?? []).includes(file))!;
		const inv = unitOf("src/controllers/InvoiceController.php");
		const rep = unitOf("src/controllers/ReportController.php");
		expect(inv.id).not.toBe(rep.id);
		ledger.db.prepare("UPDATE units SET meta = json_set(meta, '$.slice', 'invoices') WHERE id IN (?, ?)").run(inv.id, rep.id);
		ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = ?").run(inv.id);
		expect(routeOwners(ledger, "invoices").map((u) => u.state).sort()).toEqual(["accepted", "planned"]);
		const waiting = waitingRoutes(ledger, "invoices");
		expect([...waiting]).toEqual([["reports/totals", rep.id]]);

		// a step that uses a value only the waiting route saves waits too: the new app's unfinished route does not give it
		const steps: Step[] = [
			{ id: "login", route: "setup", compare: "none", method: "GET", path: "/login", save: { csrf: "t=(\\w+)" } },
			{ id: "list", route: "GET /invoices", compare: "data", method: "GET", path: "/invoices", save: { n: "(\\d+)" } },
			{ id: "totals", route: "GET /reports/totals", compare: "data", method: "GET", path: "/reports/totals", save: { total: "(\\d+)" } },
			{ id: "one", route: "GET /invoices/{id}", compare: "data", method: "GET", path: "/invoices/{{n}}?t={{csrf}}" },
			{ id: "byTotal", route: "GET /invoices", compare: "data", method: "GET", path: "/invoices?min={{total}}" },
		];
		const h = holdBack(steps, waiting);
		expect(h.steps.map((s) => s.compare)).toEqual(["none", "data", "none", "data", "none"]);
		expect(h.held).toEqual([`totals (${rep.id})`, `byTotal (${rep.id})`]);

		// the run's check: the writer sees only the ready routes, and the slice's run is recorded
		mkdirSync(join(root, ".bigrefactor", "parity", "slices", "invoices"), { recursive: true });
		const recipe = { dir: ".", start: { cmd: "false", args: [] }, ready: "http://localhost:1/" };
		writeFileSync(join(root, ".bigrefactor", "parity", "apps.json"), JSON.stringify({ legacy: { up: true, recipe }, nestjs: { up: true, recipe } }));
		const asked: string[] = [];
		const writer = async (w: { problem: string }) => {
			asked.push(w.problem);
			writeFileSync(join(root, ".bigrefactor", "parity", "slices", "invoices", "steps.json"), JSON.stringify({ steps: steps.filter((s) => s.id !== "totals" && s.id !== "byTotal"), skipped: { "POST /invoices": "t" } }));
		};
		const r = await checkSlice({ ledger, config, root, slice: "invoices", linkAll: () => {}, serverStack: "nestjs", onlyAccepted: true, writer, log: () => {} });
		expect(asked).toHaveLength(1);
		expect(asked[0]).toMatch(/GET \/invoices/);
		expect(asked[0]).not.toMatch(/reports\/totals/);
		expect(asked[0]).toMatch(/other routes get their steps later/);
		expect(r.runId).toBeDefined(); // the old app here does not start: still a recorded run, not "not compared yet"
		expect(ledger.db.prepare("SELECT COUNT(*) n FROM parity_runs WHERE slice = 'invoices'").get()).toEqual({ n: 1 });

		// once the reports unit lands, the kept steps miss its route: the writer is asked for it then
		ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = ?").run(rep.id);
		await checkSlice({ ledger, config, root, slice: "invoices", linkAll: () => {}, serverStack: "nestjs", onlyAccepted: true, writer, log: () => {} });
		expect(asked[1]).toMatch(/no compared step and no reason in skipped: GET \/reports\/totals/);
	});
});
