import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { inventory } from "../src/inventory/run.ts";
import { Ledger } from "../src/ledger/db.ts";

/** Re-running inventory (as `br onboard` does after profile/decisions) must be stable and never touch started units. */
const here = resolve(import.meta.dirname, "..");

describe("re-inventory", () => {
	it("keeps unit ids, keeps started units' symbols, leaves no stale units, revives files that come alive", async () => {
		const ws = join(here, ".sim", "reinv");
		rmSync(ws, { recursive: true, force: true });
		mkdirSync(join(ws, "legacy"), { recursive: true });
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		cpSync(join(here, "fixtures", "mini-app"), join(ws, "legacy"), { recursive: true });
		const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, models: {} });
		const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
		await inventory(config, ws, ledger);
		const first = ledger.listUnits().map((u) => u.id).sort();
		const dead = (ledger.db.prepare("SELECT path FROM files WHERE dead_code = 1").all() as Array<{ path: string }>).map((r) => r.path);
		expect(dead.length).toBeGreaterThan(0);

		// simulate a started unit
		const started = first[0]!;
		ledger.db.prepare("UPDATE units SET state = 'implementing' WHERE id = ?").run(started);
		const startedSymbols = (ledger.db.prepare("SELECT COUNT(*) n FROM symbols WHERE unit_id = ?").get(started) as { n: number }).n;

		// make a dead file alive: reference it from a live file by string literal of its basename
		const deadFile = dead[0]!;
		const name = deadFile.split("/").pop()!.replace(/\.[A-Za-z0-9]+$/, "");
		// mentioned from a live file (routes.php is a registration root); a mention from an unreferenced file would not count
		const routesFile = join(ws, "legacy", "routes.php");
		writeFileSync(routesFile, readFileSync(routesFile, "utf8") + `\n// keepalive: '${name}'\n$keepalive = '${name}';\n`);

		await inventory(config, ws, ledger);
		const second = ledger.listUnits().map((u) => u.id);
		expect(second).toContain(started);
		for (const id of first) if (id !== started) expect(second, `unit id ${id} reused`).toContain(id);
		expect(new Set(second).size).toBe(second.length);
		expect((ledger.db.prepare("SELECT COUNT(*) n FROM symbols WHERE unit_id = ?").get(started) as { n: number }).n).toBe(startedSymbols);
		expect((ledger.db.prepare("SELECT dead_code FROM files WHERE path = ?").get(deadFile) as { dead_code: number }).dead_code).toBe(0);
		expect(ledger.checkInvariants().ok).toBe(true);

		// a file mentioned only from a dead file stays dead (transitive dead code)
		writeFileSync(join(ws, "legacy", "orphan.php"), `<?php\nfunction orphan_caller() { return 'orphan_target'; }\n`);
		writeFileSync(join(ws, "legacy", "orphan_target.php"), `<?php\nfunction orphan_target() { return 1; }\n`);
		await inventory(config, ws, ledger);
		const deadOf = (p: string) => (ledger.db.prepare("SELECT dead_code, dead_code_reason r FROM files WHERE path = ?").get(p) as { dead_code: number; r: string });
		expect(deadOf("orphan.php").dead_code).toBe(1);
		expect(deadOf("orphan_target.php").dead_code).toBe(1);
		expect(deadOf("orphan_target.php").r).toMatch(/only referenced from dead code \(orphan\.php\)/);
		const after = ledger.listUnits().map((u) => u.id);

		// third run: nothing changes
		await inventory(config, ws, ledger);
		expect(ledger.listUnits().map((u) => u.id).sort()).toEqual([...after].sort());
		expect(ledger.checkInvariants().ok).toBe(true);
		ledger.close();
	}, 60_000);
});
