import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { commitAll, ensureRepo } from "../src/git.ts";
import { inventory } from "../src/inventory/run.ts";
import { Ledger } from "../src/ledger/db.ts";
import { FakeModelClient } from "../src/models/fake.ts";
import { runScheduler } from "../src/run/run.ts";

/**
 * One unit per target module at a time: units of one area write the same files, so side by side they clash on merge.
 * With many free lanes (every run start) all ready units of one area used to start in the same scheduling pass.
 */
const here = resolve(import.meta.dirname, "..");

describe("one unit per area at a time", () => {
	it.each([1, 2])("a scheduling pass with free lanes starts run.unitsPerModule (%i) units of an area, not all of them", async (limit) => {
		const ws = join(here, ".sim", `one-unit-per-area-${limit}`);
		rmSync(ws, { recursive: true, force: true });
		cpSync(join(here, "fixtures", "mini-app"), join(ws, "legacy"), { recursive: true });
		const target = join(ws, "migrated");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "package.json"), JSON.stringify({ name: "sim", private: true }, null, 2));
		await ensureRepo(target, "migration/main");
		await commitAll(target, "chore: bootstrap");
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: target, stacks: ["nestjs"] }, models: {}, run: { agentConcurrency: 4, gateConcurrency: 1, minFreeDiskGb: 0, unitsPerModule: limit } });
		writeFileSync(join(ws, "bigrefactor.config.json"), JSON.stringify(config, null, 2));
		process.env["BR_WORKSPACE"] = ws;
		const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
		await inventory(config, ws, ledger);
		// every unit ready and in one area
		for (const u of ledger.listUnits()) ledger.updateUnit(u.id, { meta: { place: { stack: "nestjs", area: "app", shared: false, source: "answer" } } });
		ledger.db.prepare("UPDATE units SET deps = '[]'").run();
		expect(ledger.listUnits().length).toBeGreaterThan(1);

		const started = new Set<string>();
		await runScheduler({
			ledger,
			config,
			root: ws,
			client: new FakeModelClient({}),
			handleSigint: false,
			truthAhead: false,
			log: () => {},
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
		expect(left.map((r) => r.entity_id)).toHaveLength(limit);
		ledger.close();
	}, 60_000);
});
