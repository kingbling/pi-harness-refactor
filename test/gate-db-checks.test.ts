import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { addWhy, loadCommandOverrides, saveCommandOverride, saveWorktreeCopy, withCommandOverrides } from "../src/adapters/command-overrides.ts";
import type { TargetAdapter } from "../src/adapters/types.ts";
import { ConfigSchema } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { ENGINE_SEMANTICS, engineSemantics, migrateFreshStep, unitNameStep } from "../src/run/db-unit.ts";
import { antigamingCheck, builderSteps, sha1, SKIPPED_TEST, type GateReport } from "../src/run/gate.ts";
import { askEngineSemantics, checkMigrationsOnMain, reopenSkippedTests } from "../src/run/stack-heal.ts";

/**
 * Gate checks and run-start heals of the database work: skipped tests, the whole-project build, migrations on an
 * empty database, files named after the unit, and the project's one rule on engine differences.
 */
const here = resolve(import.meta.dirname, "..");
const write = (p: string, s = "x\n") => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, s));
const git = (dir: string, args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" });
const repo = (name: string, files: Record<string, string>) => {
	const dir = join(here, ".sim", name);
	rmSync(dir, { recursive: true, force: true });
	for (const [f, s] of Object.entries(files)) write(join(dir, f), s);
	git(dir, ["init", "-q"]);
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-qm", "init"]);
	return dir;
};
const adapter = (over: Partial<TargetAdapter> = {}, layout: Record<string, unknown> = {}) =>
	({
		id: "fake",
		toolchain: { ignoredPaths: [] },
		build: (_r: string, files: string[] = []) => ({ cmd: "phpstan", args: ["analyse", ...files] }),
		lint: (_r: string, files: string[]) => ({ cmd: "cs", args: files }),
		test: () => ({ cmd: "true", args: [] }),
		layout: {
			isTestFile: (p: string) => p.endsWith("Test.php"),
			skipMarker: /markTest(Skipped|Incomplete)\(/,
			moduleDir: (a: string) => `src/${a}`,
			sharedDirs: ["src/Shared/"],
			testFileGlobs: (d: string) => [`tests/${d.split("/").pop()}/**/*Test.php`],
			lang: (f: string) => (f.endsWith(".php") ? "php" : undefined),
			sourceExtensions: [".php"],
			...layout,
		},
		...over,
	}) as unknown as TargetAdapter;

describe("gate checks", () => {
	it("one reason per command setting: saved again, the newer reason replaces the older", () => {
		expect(addWhy("build: a; worktree copy of vendor: b", "worktree copy of vendor: c")).toBe("build: a; worktree copy of vendor: c");
		const root = join(here, ".sim", "why-dedupe");
		rmSync(root, { recursive: true, force: true });
		mkdirSync(root, { recursive: true });
		saveCommandOverride(root, "fake", "build", { cmd: "phpstan", args: ["{files}"] }, "memory");
		saveWorktreeCopy(root, "fake", "vendor", "autoload real path");
		saveCommandOverride(root, "fake", "build", { cmd: "phpstan", args: ["{files}", "-l5"] }, "level 5");
		expect(loadCommandOverrides(root, "fake").why).toBe("worktree copy of vendor: autoload real path; build: level 5");
		// the migrate-on-empty-database command is set per workspace like the others
		saveCommandOverride(root, "fake", "migrateFresh", { cmd: "php", args: ["tools/migrate-fresh.php"] }, "no built-in command");
		expect(withCommandOverrides(adapter(), root).migrateFresh!("/p")).toEqual({ cmd: "php", args: ["tools/migrate-fresh.php"] });
		expect(withCommandOverrides(adapter(), join(root, "none")).migrateFresh!("/p")).toBeUndefined();
	});

	it("a skipped or incomplete test fails the unit's own tests only: an earlier unit's are not this unit's", async () => {
		const dir = repo("skip-own", {
			"tests/Billing/InvoiceTest.php": "<?php\nfunction test_total() { self::markTestIncomplete('pending'); }\n",
			"tests/Billing/OlderTest.php": "<?php\nfunction test_old() { self::markTestSkipped('later'); }\n",
		});
		const ledger = new Ledger(":memory:");
		ledger.createUnit({ id: "u1", tier: "leaf", symbolIds: [] });
		ledger.db.prepare("INSERT INTO truth_cases(id, unit_id, symbol_id, inputs, expected, verified_on_old, created_at, ported_test_path) VALUES ('u1#1', 'u1', 's', '[]', '1', 1, '', 'tests/Billing/InvoiceTest.php')").run();
		const testFiles = ["tests/Billing/InvoiceTest.php", "tests/Billing/OlderTest.php"].map((path) => ({ path, sha1: sha1(readFileSync(join(dir, path))) }));
		const r = await antigamingCheck({ ledger, unitId: "u1", adapter: adapter(), targetProjectDir: dir, writeGlobs: [], testFiles }, { changed: [], tracked: new Set(), prodFiles: [] }, true);
		expect(r.ok).toBe(false);
		expect(r.output).toBe(`${SKIPPED_TEST} in tests/Billing/InvoiceTest.php`);
	});

	it("a build that takes files still type-checks the whole project in the builder: every code, test and database file, not config or tools", async () => {
		const dir = repo("builder-steps", { "src/Billing/Invoice.php": "<?php\n", "tests/Billing/InvoiceTest.php": "<?php\n", "migrations/Version1.php": "<?php\n", "config/bundles.php": "<?php\n", "tools/run.php": "<?php\n", "src/readme.md": "x\n" });
		const steps = await builderSteps(adapter(), dir);
		expect(steps[0]).toMatchObject({ step: "build", cmd: "phpstan", args: ["analyse", "migrations/Version1.php", "src/Billing/Invoice.php", "tests/Billing/InvoiceTest.php"], shown: "phpstan analyse migrations src tests" });
		// a build that already checks the whole project is not doubled
		const whole = await builderSteps(adapter({ build: () => ({ cmd: "phpstan", args: ["analyse", "src"] }) }), dir);
		expect(whole.filter((s) => s.step === "build")).toEqual([{ step: "build", cmd: "phpstan", args: ["analyse", "src"] }]);
	});
});

describe("database work", () => {
	const green: GateReport = { ok: true, steps: [], changedFiles: [] };
	const failing = (dir: string) => write(join(dir, "migrate.sh"), "echo 'Version20260623000000: relation users does not exist'; exit 1\n");

	it("files named after the unit, not the tables, fail the structure check", async () => {
		const dir = repo("db-unit-name", { "migrations/OldDbSchemaDspReportsTest.php": "<?php\n" });
		write(join(dir, "tests/Migrations/DbSchemaDspReportsSchemaTest.php"), "<?php\n");
		write(join(dir, "tests/Migrations/DspReportsSchemaTest.php"), "<?php\n");
		const changed = { ...green, changedFiles: ["tests/Migrations/DbSchemaDspReportsSchemaTest.php", "tests/Migrations/DspReportsSchemaTest.php", "migrations/OldDbSchemaDspReportsTest.php"] };
		const r = await unitNameStep(changed, "DB_schema_dsp_reports", dir);
		expect(r).toMatchObject({ ok: false, failedStep: "structure_ok" });
		expect(r.steps.at(-1)!.output).toContain("DbSchemaDspReportsSchemaTest.php");
		expect(r.steps.at(-1)!.output).not.toContain("migrations/Old"); // already there before: not this attempt's
		expect(await unitNameStep({ ...green, changedFiles: ["tests/Migrations/DspReportsSchemaTest.php"] }, "DB_schema_dsp_reports", dir)).toMatchObject({ ok: true });
	});

	it("migrations that fail on main too, with the same error, are not this unit's; unless the error names its own migration", async () => {
		const wt = join(here, ".sim", "db-fresh-wt");
		const main = join(here, ".sim", "db-fresh-main");
		for (const d of [wt, main]) (rmSync(d, { recursive: true, force: true }), failing(d));
		const ledger = new Ledger(":memory:");
		ledger.createUnit({ id: "DB_schema_ads", tier: "T0", kind: "db_schema", symbolIds: [] });
		const a = adapter({ migrateFresh: () => ({ cmd: "sh", args: ["migrate.sh"] }) });
		const r = await migrateFreshStep(green, { ledger, unitId: "DB_schema_ads", adapter: a, dir: wt, mainDir: main });
		expect(r.ok).toBe(true);
		expect(r.steps.at(-1)!.output).toMatch(/fail on main too/);
		expect(ledger.hasEvidence("DB_schema_ads", "migrate_ok")).toBe(false);
		const own = await migrateFreshStep({ ...green, changedFiles: ["migrations/Version20260623000000.php"] }, { ledger, unitId: "DB_schema_ads", adapter: a, dir: wt, mainDir: main });
		expect(own).toMatchObject({ ok: false, failedStep: "migrate_ok" });
	});

	it("run start: migrations that fail on main send back the accepted unit whose migration the error names; green gives the others the check", async () => {
		const root = join(here, ".sim", "db-main-check");
		rmSync(root, { recursive: true, force: true });
		const config = ConfigSchema.parse({ source: { path: join(root, "legacy"), stack: "php" }, target: { path: join(root, "migrated"), stacks: ["fake"] }, models: {} });
		mkdirSync(join(root, "migrated"), { recursive: true });
		const ledger = new Ledger(":memory:");
		const place = { place: { stack: "fake", area: "db" }, lane: "db" };
		for (const id of ["DB_schema_users", "DB_schema_ads"]) {
			ledger.createUnit({ id, tier: "T0", kind: "db_schema", meta: place, symbolIds: [] });
			ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = ?").run(id);
		}
		const at = ledger.startAttempt("DB_schema_ads", "implement");
		ledger.endAttempt(at, { outcome: "gate_green", gateReport: { changedFiles: ["migrations/Version20260623000000.php", "tests/Migrations/AdsSchemaTest.php"] } });
		const adapterOf = async () => adapter({ migrateFresh: () => ({ cmd: "migrate", args: [] }) });
		const log: string[] = [];
		await checkMigrationsOnMain({ ledger, config, root, log: (l) => log.push(l), adapterOf, run: async () => ({ ok: false, output: "In Version20260623000000.php line 12: relation users does not exist" }) });
		expect(ledger.getUnit("DB_schema_ads")!.state).toBe("planned");
		expect(JSON.parse(ledger.getUnit("DB_schema_ads")!.meta).retryNote).toMatch(/relation users does not exist/);
		expect(ledger.getUnit("DB_schema_users")!.state).toBe("accepted");
		await checkMigrationsOnMain({ ledger, config, root, log: (l) => log.push(l), adapterOf, run: async () => ({ ok: true, output: "" }) });
		expect(ledger.hasEvidence("DB_schema_users", "migrate_ok")).toBe(true);
	});

	it("run start: accepted units whose own tests skip or leave tests incomplete go back for the tester", async () => {
		const root = join(here, ".sim", "skip-reopen");
		rmSync(root, { recursive: true, force: true });
		const config = ConfigSchema.parse({ source: { path: join(root, "legacy"), stack: "php" }, target: { path: join(root, "migrated"), stacks: ["fake"] }, models: {} });
		write(join(root, "migrated", "tests", "Billing", "InvoiceTest.php"), "<?php\nself::markTestIncomplete('Workflow implementation pending.');\n");
		write(join(root, "migrated", "tests", "Billing", "TaxTest.php"), "<?php\nassertSame(1, 1);\n");
		const ledger = new Ledger(":memory:");
		for (const [id, file] of [["u1", "InvoiceTest"], ["u2", "TaxTest"]] as const) {
			ledger.createUnit({ id, tier: "leaf", meta: { place: { stack: "fake", area: "billing" } }, symbolIds: [] });
			ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = ?").run(id);
			ledger.db.prepare("INSERT INTO truth_cases(id, unit_id, symbol_id, inputs, expected, verified_on_old, created_at, ported_test_path) VALUES (?, ?, 's', '[]', '1', 1, '', ?)").run(`${id}#1`, id, `tests/Billing/${file}.php`);
		}
		expect(await reopenSkippedTests({ ledger, config, root, stackId: "fake", adapterOf: async () => adapter() })).toEqual(["u1"]);
		expect(ledger.getUnit("u1")!.state).toBe("planned");
		expect(ledger.getUnit("u2")!.state).toBe("accepted");
	});

	it("how database behaviour the new engine cannot copy is treated is asked once for the project, and the database work follows it", async () => {
		const root = join(here, ".sim", "engine-semantics");
		rmSync(root, { recursive: true, force: true });
		mkdirSync(root, { recursive: true });
		const config = ConfigSchema.parse({ source: { path: join(root, "legacy"), stack: "php" }, target: { path: join(root, "migrated"), stacks: ["fake"] }, models: {} });
		const ledger = new Ledger(":memory:");
		ledger.createUnit({ id: "DB_schema_ads", tier: "T0", kind: "db_schema", meta: { lane: "db", tables: ["ads"], strategy: "keep-schema", from: ["mariadb"], to: "postgresql" }, symbolIds: [] });
		expect(engineSemantics(ledger)).toMatch(/not decided yet; until it is, write the differences down as comments/);
		await askEngineSemantics({ ledger, config, root, log: () => {} });
		await askEngineSemantics({ ledger, config, root, log: () => {} });
		const qs = ledger.db.prepare("SELECT id, blocks, options FROM questions WHERE point = ?").all(ENGINE_SEMANTICS) as Array<{ id: number; blocks: string; options: string }>;
		expect(qs).toHaveLength(1);
		expect(qs[0]!.blocks).toBe("none");
		expect(qs[0]!.options).toMatch(/emulate/);
		ledger.answerQuestion(qs[0]!.id, "emulate — copy the legacy behaviour");
		expect(engineSemantics(ledger)).toMatch(/: emulate: copy the legacy behaviour in the new database/);
	});
});
