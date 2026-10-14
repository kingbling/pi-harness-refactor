import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { durableFor } from "../src/pi/extension.ts";
import { ensureLedgerIndexes } from "../src/ledger/indexes.ts";

/**
 * The Pi footer's totals are read in a worker thread: the first call answers at once without reading the ledger on
 * Pi's thread, and the totals arrive a moment later through the callback.
 */
const here = resolve(import.meta.dirname, "..");

describe("footer totals off Pi's thread", () => {
	it("answers from the cache at once and fills it from a worker", async () => {
		const ws = join(here, ".sim", "durable-worker");
		rmSync(ws, { recursive: true, force: true });
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		writeFileSync(join(ws, "bigrefactor.config.json"), JSON.stringify(ConfigSchema.parse({ source: { path: ws, stack: "php" }, target: { path: ws, stacks: ["nestjs"] }, models: {} })));
		const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
		ledger.createUnit({ id: "u1", tier: "T1", deps: [], meta: {}, symbolIds: [] });
		ledger.close();
		const fresh = new Promise<void>((r) => expect(durableFor(ws, 0, r)).toBeUndefined());
		await fresh;
		const d = durableFor(ws, 60_000);
		expect(d?.forecast.units.total).toBe(1);
		expect(d?.questions).toBe(0);
	}, 30_000);

	it("the big-table indexes are built in a worker, not when the ledger opens", async () => {
		const ws = join(here, ".sim", "ledger-indexes");
		rmSync(ws, { recursive: true, force: true });
		mkdirSync(ws, { recursive: true });
		const path = join(ws, "ledger.sqlite");
		const names = () => {
			const l = new Ledger(path);
			try {
				return (l.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('attempts_unit_cost','attempts_model_cost','attempts_time','attempts_open','decisions_unit_cost')").all() as Array<{ name: string }>).length;
			} finally {
				l.close();
			}
		};
		expect(names()).toBe(0);
		await ensureLedgerIndexes(path);
		expect(names()).toBe(5);
	}, 30_000);
});
