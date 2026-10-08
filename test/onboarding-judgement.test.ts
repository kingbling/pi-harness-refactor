import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { exampleProfileJson, phpAdapter } from "../src/adapters/source/php.ts";
import { ConfigSchema } from "../src/config.ts";
import { confirmDeadCode } from "../src/init/dead.ts";
import { inventory } from "../src/inventory/run.ts";
import { Ledger } from "../src/ledger/db.ts";
import { FakeModelClient } from "../src/models/fake.ts";

/**
 * Judgement moved from fixed lists to models: Jev confirms dead code before it stays dropped, the profile model
 * picks legacy file kinds, and a symbol name alone no longer makes a file "cross-cutting" (T3).
 */
const here = resolve(import.meta.dirname, "..");

describe("dead code: Jev confirms before a file stays dropped", () => {
	it("a cron script a shell script calls is kept; a confident 'no' stays dead; judged files are not asked again", async () => {
		const ws = join(here, ".sim", "dead-confirm");
		rmSync(ws, { recursive: true, force: true });
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		cpSync(join(here, "fixtures", "mini-app"), join(ws, "legacy"), { recursive: true });
		mkdirSync(join(ws, "legacy", "cron"), { recursive: true });
		mkdirSync(join(ws, "legacy", "scripts"), { recursive: true });
		writeFileSync(join(ws, "legacy", "cron", "nightly.php"), "<?php\nfunction nightly_report() { return 1; }\n");
		writeFileSync(join(ws, "legacy", "scripts", "cron.sh"), "#!/bin/sh\nphp cron/nightly.php\n");
		process.env["BR_WORKSPACE"] = ws;
		const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, models: {} });
		const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
		const first = await inventory(config, ws, ledger);
		expect(first.dead).toEqual(expect.arrayContaining(["cron/nightly.php", "legacy/old_export.php"]));

		const seen: Array<Record<string, { path: string; mentionedIn: string[] }>> = [];
		const client = new FakeModelClient({
			decide: (req) => {
				const files = (req.state as { files: Record<string, { path: string; mentionedIn: string[] }> }).files;
				seen.push(files);
				return Object.fromEntries(Object.entries(files).map(([k, f]) => [k, f.path === "cron/nightly.php"]));
			},
		});
		const r = await confirmDeadCode(config, ws, ledger, client);
		expect(r.asked).toBe(first.dead.length);
		expect(r.alive).toEqual(["cron/nightly.php"]);
		expect(client.calls.filter((c) => c.kind === "decide")).toHaveLength(1); // one batched call for all files
		// the fact code adds: which other files mention the file's name
		expect(Object.values(seen[0]!).find((f) => f.path === "cron/nightly.php")!.mentionedIn).toEqual(["scripts/cron.sh"]);

		const liveness = JSON.parse(readFileSync(join(ws, ".bigrefactor", "decisions.json"), "utf8")).liveness;
		expect(liveness["cron/nightly.php"].alive).toBe(true);
		expect(liveness["legacy/old_export.php"].alive).toBe(false);

		const second = await inventory(config, ws, ledger);
		expect(second.dead).not.toContain("cron/nightly.php");
		expect(second.dead).toContain("legacy/old_export.php");
		expect(ledger.listUnits().some((u) => (JSON.parse(u.meta).files as string[]).includes("cron/nightly.php"))).toBe(true);

		expect((await confirmDeadCode(config, ws, ledger, client)).asked).toBe(0);
	});

	it("an unsure answer keeps the file (dropping is the risky side)", async () => {
		const ws = join(here, ".sim", "dead-unsure");
		rmSync(ws, { recursive: true, force: true });
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		cpSync(join(here, "fixtures", "mini-app"), join(ws, "legacy"), { recursive: true });
		process.env["BR_WORKSPACE"] = ws;
		const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, models: {} });
		const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
		await inventory(config, ws, ledger);
		const r = await confirmDeadCode(config, ws, ledger, new FakeModelClient({ decide: () => ({ f0: 0.35 }) }));
		expect(r.alive).toEqual(["legacy/old_export.php"]);
	});
});

describe("framework profile: the model's picks", () => {
	it("legacy file kinds come from the profile; none without one", () => {
		const ws = join(here, ".sim", "profile-words");
		rmSync(ws, { recursive: true, force: true });
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		process.env["BR_WORKSPACE"] = ws;
		phpAdapter.reloadProfile?.();
		expect(phpAdapter.legacyWords).toBeUndefined();
		writeFileSync(join(ws, ".bigrefactor", "framework-profile.json"), JSON.stringify({ ...exampleProfileJson(), legacyWords: ["tpl", "cmd"] }));
		phpAdapter.reloadProfile?.();
		expect(phpAdapter.legacyWords).toEqual(["tpl", "cmd"]);
	});

	it("an app without a separate framework is a valid profile; legacyWords must be single words", () => {
		expect(phpAdapter.validateProfile!({ id: "plain", frameworkDirs: [], loaders: [], concerns: [], entryPoint: "(^|/)bin/[^/]+\\.php$" })).toEqual([]);
		expect(phpAdapter.validateProfile!({ ...exampleProfileJson(), legacyWords: ["x.tpl"] })).toContainEqual(expect.stringMatching(/legacyWords/));
		expect(phpAdapter.validateProfile!({ ...exampleProfileJson(), loaders: [] })).toContainEqual(expect.stringMatching(/loaders/));
	});
});

describe("tiers: no name-based cross-cutting tier", () => {
	it("a method named isCommandInQueue does not make its file T3", () => {
		const ws = join(here, ".sim", "tier-names");
		rmSync(ws, { recursive: true, force: true });
		mkdirSync(join(ws, "app", "reportqueue"), { recursive: true });
		writeFileSync(join(ws, "app", "reportqueue", "report.php"), "<?php\nclass Report { function isCommandInQueue() { return 1; } }\n");
		process.env["BR_SOURCE_ROOT"] = ws;
		const file = { path: "app/reportqueue/report.php", lang: "php", loc: 2, hash: "", symbols: [], deps: [], routes: [], queries: [], literalRefs: [], dynamicMarkers: [] };
		expect(phpAdapter.classifyTier!({ id: "s", path: file.path, kind: "method", name: "Report::isCommandInQueue", line: 2, exported: true }, file as never)).toBeUndefined();
	});
});
