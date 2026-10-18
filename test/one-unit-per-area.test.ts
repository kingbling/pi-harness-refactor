import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { commitAll, ensureRepo } from "../src/git.ts";
import { inventory } from "../src/inventory/run.ts";
import { Ledger } from "../src/ledger/db.ts";
import { FakeModelClient } from "../src/models/fake.ts";
import { MODULE_BOOST, moduleWaitNote, runScheduler } from "../src/run/run.ts";

/**
 * A few units per target module at a time: units of one area write the same files, so side by side they clash on merge.
 * With many free lanes (every run start) all ready units of one area used to start in the same scheduling pass. But when
 * the module limit is all that holds ready units back (the end of a migration), lanes stayed idle all night: then a pass
 * starts up to MODULE_BOOST times as many, and the lanes line says why the rest wait.
 */
const here = resolve(import.meta.dirname, "..");

describe("one unit per area at a time", () => {
	it.each([
		[1, 4],
		[1, 8],
		[2, 4],
	])("run.unitsPerModule %i, %i lanes: a pass starts the module limit's units, more while lanes are free and only the limit holds the rest, never all at once", async (limit, lanes) => {
		const ws = join(here, ".sim", `one-unit-per-area-${limit}-${lanes}`);
		rmSync(ws, { recursive: true, force: true });
		cpSync(join(here, "fixtures", "mini-app"), join(ws, "legacy"), { recursive: true });
		const target = join(ws, "migrated");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "package.json"), JSON.stringify({ name: "sim", private: true }, null, 2));
		await ensureRepo(target, "migration/main");
		await commitAll(target, "chore: bootstrap");
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: target, stacks: ["nestjs"] }, models: {}, run: { agentConcurrency: lanes, gateConcurrency: 1, minFreeDiskGb: 0, unitsPerModule: limit } });
		writeFileSync(join(ws, "bigrefactor.config.json"), JSON.stringify(config, null, 2));
		process.env["BR_WORKSPACE"] = ws;
		const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
		await inventory(config, ws, ledger);
		// every unit ready and in one area
		for (const u of ledger.listUnits()) ledger.updateUnit(u.id, { meta: { place: { stack: "nestjs", area: "app", shared: false, source: "answer" } } });
		ledger.db.prepare("UPDATE units SET deps = '[]'").run();
		const total = ledger.listUnits().length;
		expect(total).toBeGreaterThan(MODULE_BOOST);

		const started = new Set<string>();
		const reasons: string[] = [];
		await runScheduler({
			ledger,
			config,
			root: ws,
			client: new FakeModelClient({}),
			handleSigint: false,
			truthAhead: false,
			log: () => {},
			onLanes: (l) => l.reason && reasons.push(l.reason),
			// the run stops once a lane reached its first session; nothing is migrated
			shouldStop: () => started.size > 0,
			spawn: async (o) => {
				started.add(/\b(U\d{3}_[A-Za-z0-9_]+)\b/.exec(o.systemPrompt)?.[1] ?? o.systemPrompt);
				throw new Error("test: no session");
			},
			gate: async () => {
				throw new Error("test: no gate");
			},
		});
		const left = ledger.db.prepare("SELECT DISTINCT entity_id FROM transitions WHERE entity = 'unit' AND from_state = 'planned'").all() as Array<{ entity_id: string }>;
		const boosted = Math.min(total, lanes, limit * MODULE_BOOST);
		expect(left.map((r) => r.entity_id)).toHaveLength(boosted);
		// lanes left free: the line names the module limit, not dependencies
		if (boosted < lanes && boosted < total) expect(reasons[0]).toMatch(new RegExp(`^${total - boosted} ready units wait for a free place in nestjs:app`));
		ledger.close();
	}, 60_000);

	it("the lanes line names the modules that hold ready units, the fullest first", () => {
		const note = moduleWaitNote(new Map([["react:offers", 2], ["react:campaigns", 30]]), 3);
		expect(note).toBe(`32 ready units wait for a free place in react:campaigns (30), react:offers (2): at most ${3 * MODULE_BOOST} per module while lanes are free (run.unitsPerModule 3; a DB or shared module runs 1)`);
	});
});
