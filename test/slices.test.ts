import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { inventory } from "../src/inventory/run.ts";
import { applySlicePlan, authWord, planSlices } from "../src/inventory/slices.ts";
import { Ledger } from "../src/ledger/db.ts";

const FIXTURE = resolve(import.meta.dirname, "../fixtures/mini-app");

describe("vertical slices over the dependency DAG", () => {
	it("foundation = shared leaves, one feature from the routes, deep units first, deterministic", async () => {
		const ledger = new Ledger(":memory:");
		const config = ConfigSchema.parse({ source: { path: FIXTURE, stack: "php" }, target: { path: "/tmp/x", stacks: ["nestjs"] }, models: {} });
		await inventory(config, FIXTURE, ledger);

		const plan = planSlices(ledger);
		const byName = Object.fromEntries(plan.slices.map((s) => [s.name, s]));
		expect(byName["foundation"]!.units.sort()).toEqual(["U001_src_Config", "U002_src_Money"]);
		expect(byName["invoices"]).toBeDefined();
		expect(byName["invoices"]!.entryPoints).toEqual(["GET /invoices", "GET /invoices/{id}", "POST /invoices"]);
		expect(byName["invoices"]!.rank).toBe(2); // 0 foundation, 1 auth (empty → absent), 2 first feature
		expect(byName["dynamic"]).toBeUndefined(); // every unit is reachable from a route
		// depth = longest path to a leaf; readiness already enforces leaves-first, depth only breaks ties among ready units
		expect(plan.depth.get("U006_controllers_InvoiceController")).toBe(2);
		expect(plan.depth.get("U003_src_InvoiceRepo")).toBe(1);

		const again = planSlices(ledger);
		expect(again.slices).toEqual(plan.slices);

		applySlicePlan(ledger, plan);
		const u = JSON.parse(ledger.getUnit("U004_src_Pricing")!.meta);
		expect(u.slice).toBe("invoices");
		expect(u.sliceRank).toBe(2);
	});

	it("overrides pin units to slices", async () => {
		const ledger = new Ledger(":memory:");
		const config = ConfigSchema.parse({ source: { path: FIXTURE, stack: "php" }, target: { path: "/tmp/x", stacks: ["nestjs"] }, models: {} });
		await inventory(config, FIXTURE, ledger);
		const plan = planSlices(ledger, { overrides: { "src/Pricing.php": "foundation" } });
		expect(plan.unitSlice.get("U004_src_Pricing")).toBe("foundation");
	});

	it("auth goes first only when Jev says so; a name match stands in only without Jev's advice", async () => {
		const ledger = new Ledger(":memory:");
		const config = ConfigSchema.parse({ source: { path: FIXTURE, stack: "php" }, target: { path: "/tmp/x", stacks: ["nestjs"] }, models: {} });
		await inventory(config, FIXTURE, ledger);
		const authors = { "src/controllers/InvoiceController.php": "authors" }; // a books app: "authors" contains "auth"
		expect(authWord("authors", [])).toBe("auth");
		const kind = (ov: Parameters<typeof planSlices>[1]) => planSlices(ledger, ov).slices.find((s) => s.name === "authors")!.kind;
		expect(kind({ overrides: authors })).toBe("auth"); // no model ran
		expect(kind({ overrides: authors, advised: { auth: [] } })).toBe("feature"); // Jev said no: the word match does not override it
		expect(kind({ overrides: authors, advised: { auth: ["authors"] } })).toBe("auth");
	});
});

describe("dynamic units by directory", () => {
	it("foundation owns folders too: a helper next to shared code goes to foundation, not the feature one folder up", async () => {
		const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { applyDecision } = await import("../src/inventory/decisions.ts");
		const root = mkdtempSync(join(tmpdir(), "br-dyn-"));
		mkdirSync(join(root, ".bigrefactor"), { recursive: true });
		const raw = { version: 1, source: { path: join(root, "legacy"), stack: "php" }, target: { path: join(root, "new"), stacks: ["nestjs"] }, models: {} };
		writeFileSync(join(root, "bigrefactor.config.json"), JSON.stringify(raw));
		const config = ConfigSchema.parse(raw);
		const ledger = new Ledger(":memory:");
		const mk = (id: string, file: string, slice: string) => {
			ledger.upsertFile({ path: file, hash: "h", lang: "php", loc: 1 });
			ledger.upsertSymbol({ id: `${file}::f`, path: file, kind: "function", name: "f" });
			ledger.createUnit({ id, tier: "T0", symbolIds: [`${file}::f`], meta: { files: [file], slice } });
		};
		mk("F1", "app/lib/strings.php", "foundation");
		mk("F2", "app/lib/dates.php", "foundation");
		mk("B1", "app/billing/invoice.php", "billing");
		mk("B2", "app/billing/pay.php", "billing");
		mk("D1", "app/lib/helper.php", "dynamic");
		mk("D2", "app/billing/extra/x.php", "dynamic");
		applyDecision(ledger, config, root, "dynamic-slice", "by-directory");
		const ov = JSON.parse(readFileSync(join(root, ".bigrefactor", "slices.json"), "utf8"));
		expect(ov.overrides).toEqual({ D1: "foundation", D2: "billing" });
	});
});
