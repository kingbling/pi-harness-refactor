import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getSourceAdapter, getTargetAdapter } from "../src/adapters/registry.ts";
import { ConfigSchema } from "../src/config.ts";
import { openDecisions } from "../src/inventory/decisions.ts";
import { planFrameworks } from "../src/inventory/frameworks.ts";
import { inventory } from "../src/inventory/run.ts";
import { exampleProfileJson } from "../src/adapters/source/php.ts";
import { Ledger } from "../src/ledger/db.ts";

/**
 * Regression: a fresh process (Pi's /br run) computed decisions without the framework profile loaded,
 * so every framework class looked unmapped → 40 phantom "fw:*" decisions that `br decide` never showed.
 */
const here = resolve(import.meta.dirname, "..");

describe("framework profile is loaded wherever decisions are computed", () => {
	it("openDecisions in a fresh state sees the profile's concerns (no phantom fw:* decisions)", async () => {
		const ws = join(here, ".sim", "profile-activation");
		rmSync(ws, { recursive: true, force: true });
		mkdirSync(join(ws, "legacy", "gyro-php", "gyro", "core"), { recursive: true });
		cpSync(join(here, "fixtures", "mini-app"), join(ws, "legacy"), { recursive: true });
		writeFileSync(join(ws, "legacy", "gyro-php", "gyro", "core", "load.cls.php"), "<?php\nclass Load { public static function models($n) {} }\n");
		const calls = Array.from({ length: 60 }, (_, i) => `Load::models('m${i}');`).join("\n");
		writeFileSync(join(ws, "legacy", "src", "boot.php"), `<?php\nfunction boot() {\n${calls}\n}\n`);
		writeFileSync(join(ws, "legacy", "index.php"), `<?php\nrequire 'src/boot.php';\nboot();\n`); // live entry point
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		// the profile `br profile` writes (here: the worked example); without one no framework conventions are known
		writeFileSync(join(ws, ".bigrefactor", "framework-profile.json"), JSON.stringify(exampleProfileJson()));
		process.env["BR_WORKSPACE"] = ws;
		const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, models: {} });
		writeFileSync(join(ws, "bigrefactor.config.json"), JSON.stringify(config));
		const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
		await inventory(config, ws, ledger);
		const source = getSourceAdapter("php");
		const targets = [await getTargetAdapter("nestjs")];

		// simulate a fresh process: profile cache dropped, nobody calls frameworkDirs() first
		source.reloadProfile?.();
		const ids = openDecisions(ledger, config, source, targets, ws).map((d) => d.id);
		expect(ids).not.toContain("fw:Load");
		source.reloadProfile?.();
		const plan = planFrameworks(ledger, source, targets, config.source.path);
		expect(plan.concerns.some((c) => c.concern === "loading" && c.appRefs > 0)).toBe(true);
		ledger.close();
		delete process.env["BR_WORKSPACE"];
	});
});
