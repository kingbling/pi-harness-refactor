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
