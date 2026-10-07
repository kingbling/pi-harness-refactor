import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getSourceAdapter, getTargetAdapter } from "../src/adapters/registry.ts";
import { ConfigSchema } from "../src/config.ts";
import { applyDecision } from "../src/inventory/decisions.ts";
import { inventory } from "../src/inventory/run.ts";
import { Ledger } from "../src/ledger/db.ts";
import { decisionGate, liveBlocks } from "../src/run/decisions-gate.ts";
import { runScheduler } from "../src/run/run.ts";

/**
 * Decisions during a run: an open framework-class decision blocks only the units that call that class;
 * the run takes everything else; answering releases the blocked units without a restart.
 */
const here = resolve(import.meta.dirname, "..");

describe("decisions during a run", () => {
	it("scopes a decision to the units it affects and releases them when answered", async () => {
		const ws = join(here, ".sim", "decisions-during-run");
		rmSync(ws, { recursive: true, force: true });
		mkdirSync(join(ws, "legacy", "myfw"), { recursive: true });
		cpSync(join(here, "fixtures", "mini-app"), join(ws, "legacy"), { recursive: true });
		writeFileSync(join(ws, "legacy", "myfw", "registry.php"), "<?php\nclass Registry { public static function get($k) { return null; } }\n");
		const calls = Array.from({ length: 60 }, (_, i) => `Registry::get('k${i}');`).join("\n");
		writeFileSync(join(ws, "legacy", "src", "uses_registry.php"), `<?php\nfunction uses_registry() {\n${calls}\n}\n`);
		// live: called from a page script (entry point), otherwise it would be dead and block nothing
		writeFileSync(join(ws, "legacy", "index.php"), `<?php\nrequire 'src/uses_registry.php';\nuses_registry();\n`);
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		// a generated profile that declares the framework dir but maps nothing → Registry is an unmapped class
		writeFileSync(join(ws, ".bigrefactor", "framework-profile.json"), JSON.stringify({ id: "myfw", frameworkDirs: ["myfw/"], loaders: [], concerns: [] }));
		const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, models: {} });
		writeFileSync(join(ws, "bigrefactor.config.json"), JSON.stringify(config, null, 2));
		process.env["BR_WORKSPACE"] = ws;
		const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
		await inventory(config, ws, ledger);
		const source = getSourceAdapter("php");
		const targets = [await getTargetAdapter("nestjs")];
		// stack/targets/db are whole-target decisions: answer them as onboarding would
		for (const d of decisionGate(ledger, config, source, targets, ws).global) applyDecision(ledger, config, ws, d.id, d.recommended!, "test");

		const g = decisionGate(ledger, config, source, targets, ws);
		expect(g.global).toEqual([]);
		const fw = g.scoped.find((x) => x.decision.id === "fw:Registry");
		expect(fw, JSON.stringify(g.scoped.map((x) => x.decision.id))).toBeTruthy();
		const caller = ledger.listUnits().find((u) => JSON.parse(u.meta).files.includes("src/uses_registry.php"))!.id;
		expect(fw!.units).toEqual([caller]); // only the unit that calls Registry

		// the scheduler's ready list leaves exactly that unit out
		const readyNow = async (hook?: () => Map<string, string[]>) => {
			const logs: string[] = [];
			await runScheduler({ ledger, config, root: ws, dry: true, blocked: hook, log: (l) => logs.push(l), handleSigint: false });
			return logs.find((l) => l.includes("ready now"))!;
		};
		expect(await readyNow()).toContain(caller); // ready when nothing blocks it
		const blocked = liveBlocks(ledger, config, source, targets, ws);
		const withBlocks = await readyNow(blocked);
		expect(withBlocks).not.toContain(caller); // the decision holds back only this unit
		expect(withBlocks).toMatch(/ready now \([1-9]/); // everything else still runs

		// answering releases it (decisions.json changes → blocks recomputed)
		await new Promise((r) => setTimeout(r, 20));
		applyDecision(ledger, config, ws, "fw:Registry", "port", "test");
		const after = blocked();
		expect(after.get(caller) ?? []).not.toContain("fw:Registry");
		ledger.close();
	});
});
