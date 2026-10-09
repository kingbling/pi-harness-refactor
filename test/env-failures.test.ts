import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tsDiagnose, tsProjectNotes, tsTestRunner, tsVerifyChoices } from "../src/adapters/target/ts-index.ts";
import { getTargetAdapter } from "../src/adapters/registry.ts";
import { errorSignature } from "../src/run/run.ts";
import { findingKey } from "../src/run/gate.ts";

const isTest = (p: string) => /\.spec\.ts$/.test(p);
function vitestProject(): string {
	const dir = mkdtempSync(join(tmpdir(), "br-env-"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { vitest: "^3", typescript: "^5" } }));
	return dir;
}
const TS2307 = (file: string, mod: string) => `\x1b[96m${file}\x1b[0m:\x1b[93m1\x1b[0m:\x1b[93m38\x1b[0m - \x1b[91merror\x1b[0m\x1b[90m TS2307: \x1b[0mCannot find module '${mod}' or its corresponding type declarations.`;

describe("environment failures (the @jest/globals incident)", () => {
	it("an option setup cannot produce is never offered", async () => {
		const nest = await getTargetAdapter("nestjs");
		const tests = nest.stackChoices!.find((c) => c.key === "tests")!;
		expect(tests.options.map((o) => o.id)).toEqual(["vitest"]);
	});

	it("the project's real runner is a fact agents and rules get", () => {
		const dir = vitestProject();
		expect(tsTestRunner(dir)).toBe("vitest");
		expect(tsProjectNotes(dir).join(" ")).toMatch(/Vitest.*never import "@jest\/globals"/);
	});

	it("setup verification catches a choice the project does not match", () => {
		const dir = vitestProject();
		expect(tsVerifyChoices(dir, [{ key: "tests", id: "jest" }])).toEqual([{ text: "tests=jest but the project runs vitest", everyUnit: true }]);
		expect(tsVerifyChoices(dir, [{ key: "orm", id: "drizzle", packages: ["drizzle-orm"] }])[0]).toMatchObject({ everyUnit: false, fix: "pnpm add drizzle-orm" });
		expect(tsVerifyChoices(dir, [{ key: "tests", id: "vitest" }])).toEqual([]);
	});

	it("the doctor turns a wrong-runner import into an automatic retest, not a human question", () => {
		const dx = tsDiagnose(vitestProject(), "build_ok", `$ npx tsc\n${TS2307("src/a/a.spec.ts", "@jest/globals")}`, isTest);
		expect(dx).toMatchObject({ action: "retest", by: "rule" });
		expect(dx!.note).toMatch(/"vitest"/);
	});

	it("a chosen package setup missed is easily fixable with one command", () => {
		const dx = tsDiagnose(vitestProject(), "build_ok", TS2307("src/a/a.service.ts", "drizzle-orm/pg-core"), isTest, ["drizzle-orm"]);
		expect(dx).toMatchObject({ action: "fix", command: "pnpm add drizzle-orm" });
	});

	it("code importing an uninstalled package is sent back to the implementer", () => {
		expect(tsDiagnose(vitestProject(), "build_ok", TS2307("src/a/a.service.ts", "lodash"), isTest)).toMatchObject({ action: "reimplement" });
	});

	it("the same error in different units has one signature (circuit breaker)", () => {
		const a = errorSignature("build_ok", `$ npx tsc\n${TS2307("src/radio.basecls/radio-base-class.spec.ts", "@jest/globals")}`);
		const b = errorSignature("build_ok", `$ npx tsc\n${TS2307("src/iactionwithicon.cls/x.spec.ts", "@jest/globals")}`);
		expect(a).toBe(b);
		expect(a).toMatch(/@jest\/globals/);
	});

	it("the key never carries the unit (worktree paths with '+', file names) but keeps the cause", () => {
		const wt = (u: string) => `/w/.bigrefactor/worktrees/${u}/symfony`;
		const oom = (u: string) => `$ vendor/bin/phpstan analyse src\nPHP Fatal error:  Allowed memory size of 134217728 bytes exhausted (tried to allocate 20480 bytes) in phar://${wt(u)}/vendor/phpstan/phpstan/phpstan.phar/src/X.php on line 98\n#13 phar://${wt(u)}/vendor/bin/phpstan(116): run()`;
		expect(errorSignature("build_ok", oom("U2515_classes_a_facade+1"))).toBe(errorSignature("build_ok", oom("U0007_b_cls")));
		expect(errorSignature("build_ok", oom("U2515_classes_a_facade+1"))).not.toMatch(/U2515|facade/);
		// stdout and stderr say the same thing with and without "PHP "
		expect(errorSignature("truth", `Fatal error: Uncaught Error: Class "Load" not found in /l/a.php:3`)).toBe(errorSignature("truth", `PHP Fatal error:  Uncaught Error: Class "Load" not found in /l/b/c.php:9`));
		expect(errorSignature("truth", `Fatal error: Uncaught Error: Class "Load" not found in /l/a.php:3`)).not.toBe(errorSignature("truth", `Fatal error: Uncaught Error: Class "Other" not found in /l/a.php:3`));
		// an area's bundle name is a file name, not the cause
		const layout = (area: string) => `src/${area}/Repository/XRepositoryInterface.php: not an allowed file in the feature folder; allowed: ${area}Bundle.php | Controller/<Name>Controller.php`;
		expect(errorSignature("structure_ok", layout("Customers"))).toBe(errorSignature("structure_ok", layout("Media")));
	});

	it("a reviewer finding in new words at the same place is the same finding; another place is not", () => {
		const r = (...f: string[]) => `reviewer findings:\n${f.join("\n")}`;
		const a = r("- src/Shared/file-storage/DocumentOwner.php:5: The namespace is not autoloadable. → Add a PSR-4 mapping.");
		const b = r("- src/Shared/file-storage/DocumentOwner.php:5: App\\Shared\\FileStorage does not match the file's path. → Move the file.");
		expect(findingKey("wired_ok", a)).toBe(findingKey("wired_ok", b));
		expect(findingKey("wired_ok", a)).not.toBe(findingKey("wired_ok", r("- src/Shared/file-storage/DocumentOwner.php:5: same", "- src/Shared/file-storage/tests/DocumentOwnerTest.php: weak test")));
		expect(findingKey("wired_ok", a)).not.toBe(findingKey("review_ok", a));
		expect(findingKey("build_ok", "error TS2307: Cannot find module 'x'")).toBe(errorSignature("build_ok", "error TS2307: Cannot find module 'x'"));
	});

	it("a line that names no cause is not a shared key: summaries are skipped, assertions keep their test file", () => {
		const phpunit = (u: string, cls: string) => `$ vendor/bin/phpunit src/R/tests/${cls}Test.php\nThere were 2 errors:\n\n1) App\\R\\Tests\\${cls}Test::testA\nError: Class "App\\R\\${cls}" not found\n\n/w/worktrees/${u}/symfony/src/R/tests/${cls}Test.php:14\nERRORS!\nTests: 2, Assertions: 0, Errors: 2.`;
		expect(errorSignature("ported_tests_green", phpunit("U1", "Radio"))).toMatch(/Class "App\\R\\Radio" not found/);
		expect(errorSignature("ported_tests_green", phpunit("U1", "Radio"))).not.toBe(errorSignature("ported_tests_green", phpunit("U2", "Agency")));
		const failed = (u: string, test: string) => `$ vendor/bin/phpunit src/C/tests/${test}.php\nThere was 1 failure:\n\n1) App\\C\\${test}::testX\nFailed asserting that false is true.\n\n/w/worktrees/${u}/symfony/src/C/tests/${test}.php:13\nFAILURES!`;
		expect(errorSignature("ported_tests_green", failed("U1", "PdfDocumentTest"))).not.toBe(errorSignature("ported_tests_green", failed("U2", "ClientUpdateTest")));
		// PHPStan: the real messages carry no error word; the footer after its summary is never the key
		const stan = (f: string) => `$ vendor/bin/phpstan analyse src\n ------ ---\n  Line   ${f}\n ------ ---\n  15     Call to function method_exists() will always evaluate to true.\n\n [ERROR] Found 1 error\n\nInstructions for interpreting errors\nEach error has an associated identifier, like \`argument.type\``;
		expect(errorSignature("build_ok", stan("A/One.php"))).not.toBe(errorSignature("build_ok", stan("B/Two.php")));
		expect(errorSignature("build_ok", stan("A/One.php"))).not.toMatch(/identifier/);
	});

	it("the same crash or merge error in different units has one key, whatever file or branch it names", () => {
		const enoent = (u: string, f: string) => `ENOENT: no such file or directory, open '/w/.bigrefactor/worktrees/${u}/web/src/${f}:12'`;
		expect(errorSignature("exception", enoent("U1", "a/ArangodbCommandBaseTest.php"))).toBe(errorSignature("exception", enoent("U2", "b/NetworkCpmFields.test.tsx")));
		expect(errorSignature("exception", enoent("U1", "a/X.php"))).not.toMatch(/ in /);
		const merge = (u: string, sha: string) => `could not merge: could not rebase unit/${u} onto main: error: could not apply ${sha}... migrate\nhint: rebase --abort\nfatal: no rebase in progress`;
		expect(errorSignature("quarantined", merge("U2415_campaign_mailchanges_cmd", "1a2b3c4"))).toBe(errorSignature("quarantined", merge("U0007_b", "9f8e7d6c")));
		expect(errorSignature("quarantined", merge("U2415_campaign_mailchanges_cmd", "1a2b3c4"))).not.toMatch(/U2415/);
	});
});

describe("parked units resubmit themselves", () => {
	it("an environment failure resubmits when the project changes, and not before", async () => {
		const { cpSync, mkdirSync, rmSync } = await import("node:fs");
		const { ConfigSchema } = await import("../src/config.ts");
		const { inventory } = await import("../src/inventory/run.ts");
		const { Ledger } = await import("../src/ledger/db.ts");
		const { resubmitParkedUnits } = await import("../src/run/run.ts");
		const { envFingerprint } = await import("../src/run/unit.ts");
		const { projectDir } = await import("../src/init/init.ts");
		const ws = join(import.meta.dirname, "..", ".sim", "env-resubmit");
		rmSync(ws, { recursive: true, force: true });
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		cpSync(join(import.meta.dirname, "..", "fixtures", "mini-app"), join(ws, "legacy"), { recursive: true });
		const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, models: {} });
		writeFileSync(join(ws, "bigrefactor.config.json"), JSON.stringify(config, null, 2));
		const api = projectDir(config, "nestjs");
		mkdirSync(api, { recursive: true });
		writeFileSync(join(api, "package.json"), JSON.stringify({ devDependencies: { vitest: "^3" } }));
		const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
		await inventory(config, ws, ledger);
		const nest = await getTargetAdapter("nestjs");
		const unit = ledger.listUnits()[0]!.id;
		ledger.transitionUnit(unit, "truth", "test");
		ledger.transitionUnit(unit, "implementing", "test");
		const q = ledger.askQuestion({ unitId: unit, point: "triage_gate", question: "env", askedBy: "test" });
		ledger.updateUnit(unit, { meta: { parked: { question: q, env: envFingerprint(config, api, nest.toolchain.manifestFiles) } } });
		const logs: string[] = [];
		const adapters = new Map([["nestjs", nest]]);

		expect(resubmitParkedUnits(ledger, config, ws, new Set(), (l) => logs.push(l), adapters)).toEqual([]); // nothing changed: stays parked
		expect(ledger.getUnit(unit)!.state).toBe("implementing");

		writeFileSync(join(api, "package.json"), JSON.stringify({ dependencies: { "drizzle-orm": "^1" }, devDependencies: { vitest: "^3" } })); // e.g. `pnpm add drizzle-orm`
		expect(resubmitParkedUnits(ledger, config, ws, new Set(), (l) => logs.push(l), adapters)).toEqual([unit]);
		expect(ledger.getUnit(unit)!.state).toBe("planned");
		expect(ledger.openQuestions().some((x) => x.id === q)).toBe(false);
		expect(JSON.parse(ledger.getUnit(unit)!.meta).parked).toBeUndefined();
		expect(logs.join("\n")).toMatch(/resubmitted 1 unit/);
	});
});

describe("durable totals in the TUI", () => {
	it("the footer and the run panel show ledger totals, total spend and the forecast — not this run's counters", async () => {
		const { cpSync, mkdirSync, rmSync } = await import("node:fs");
		const { ConfigSchema } = await import("../src/config.ts");
		const { inventory } = await import("../src/inventory/run.ts");
		const { Ledger } = await import("../src/ledger/db.ts");
		const { recordSpend, totalSpend } = await import("../src/spend.ts");
		const { durable, renderProgress, statusLine } = await import("../src/pi/extension.ts");
		const ws = join(import.meta.dirname, "..", ".sim", "durable-tui");
		rmSync(ws, { recursive: true, force: true });
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		cpSync(join(import.meta.dirname, "..", "fixtures", "mini-app"), join(ws, "legacy"), { recursive: true });
		const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, models: {} });
		writeFileSync(join(ws, "bigrefactor.config.json"), JSON.stringify(config, null, 2));
		const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
		await inventory(config, ws, ledger);
		// an earlier run: one unit accepted (with a recorded attempt), one quarantined
		const [a, b] = ledger.listUnits();
		ledger.db.prepare("UPDATE units SET state='accepted' WHERE id=?").run(a!.id);
		ledger.db.prepare("UPDATE units SET state='quarantined' WHERE id=?").run(b!.id);
		ledger.db.prepare("INSERT INTO attempts(unit_id, role, model, cost_usd, started_at, ended_at, outcome) VALUES (?, 'implement', 'm', 0.5, '2026-10-01T10:00:00Z', '2026-10-01T10:10:00Z', 'gate_green')").run(a!.id);
		// every paid call is in the spend log (the attempt above and an onboarding chat): 0.5 + 0.25
		recordSpend(0.5, "session: implement", "m", { root: ws });
		recordSpend(0.25, "api: chat", "m", { root: ws });
		// a subscription (Codex) call counts with its OpenRouter value in the totals, but is no money paid (the budget cap)
		recordSpend(0.25, "session: test", "openai-codex/m", { root: ws, subscription: true });
		expect(totalSpend(ws).usd).toBeCloseTo(1.0);
		const { paidSince } = await import("../src/spend.ts");
		expect(paidSince(ws, "2000-01-01")).toBeCloseTo(0.75);
		const { priceAt } = await import("../src/models/codex.ts");
		expect(priceAt({ input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 }, { input: 1_000_000, output: 500_000 })).toBeCloseTo(6);

		const footer = statusLine(ledger, ws);
		expect(footer).toMatch(/✓ 1\/\d+ accepted · ■ 1 quarantined · spent \$1\.00 total/);

		// a new run that has accepted nothing yet still shows the durable totals
		const snap = { plan: [], about: {}, running: true, stopping: false, startedAt: Date.now(), steps: [], activity: [], agents: [], costByLabel: {}, costUsd: 0, job: "migration run" } as any;
		const panel = renderProgress(snap, 140, durable(ledger, ws)).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		expect(panel).toMatch(/✓ 1 accepted\s+■ 1 quarantined/);
		expect(panel).toMatch(/spent \$1\.00 total/);
		ledger.close();
	});
});

describe("br lanes", () => {
	it("parses every form, and a bare number sets lanes (the /br lanes 24 bug)", async () => {
		const { parseLanesArgs } = await import("../src/run/lanes.ts");
		expect(parseLanesArgs(["24"])).toEqual({ lanes: 24, gates: undefined });
		expect(parseLanesArgs(["24", "gates", "3"])).toEqual({ lanes: 24, gates: 3 });
		expect(parseLanesArgs(["24", "--gates", "3"])).toEqual({ lanes: 24, gates: 3 });
		expect(parseLanesArgs(["gates", "3"])).toEqual({ lanes: undefined, gates: 3 });
		expect(parseLanesArgs([])).toEqual({ lanes: undefined, gates: undefined });
	});
	it("writes the config", async () => {
		const { mkdtempSync } = await import("node:fs");
		const { ConfigSchema, loadConfig } = await import("../src/config.ts");
		const { lanes } = await import("../src/run/lanes.ts");
		const dir = mkdtempSync(join(tmpdir(), "br-lanes-"));
		const f = join(dir, "bigrefactor.config.json");
		writeFileSync(f, JSON.stringify(ConfigSchema.parse({ source: { path: dir, stack: "php" }, target: { path: dir, stacks: ["nestjs"] }, models: {} })));
		expect(lanes(f, { lanes: 24 })).toMatch(/lanes 8 → 24/);
		expect(loadConfig(f).config.run.agentConcurrency).toBe(24);
	});

	it("a setup fix for another problem leaves parked units waiting; a changed gate command wakes them", async () => {
		const { cpSync, mkdirSync, rmSync, appendFileSync } = await import("node:fs");
		const { ConfigSchema } = await import("../src/config.ts");
		const { inventory } = await import("../src/inventory/run.ts");
		const { Ledger } = await import("../src/ledger/db.ts");
		const { resubmitParkedUnits } = await import("../src/run/run.ts");
		const { envFingerprint, setupFiles } = await import("../src/run/unit.ts");
		const { overridesPath, setupLogPath } = await import("../src/adapters/command-overrides.ts");
		const { projectDir } = await import("../src/init/init.ts");
		const ws = join(import.meta.dirname, "..", ".sim", "env-setupfix");
		rmSync(ws, { recursive: true, force: true });
		mkdirSync(join(ws, ".bigrefactor", "commands"), { recursive: true });
		cpSync(join(import.meta.dirname, "..", "fixtures", "mini-app"), join(ws, "legacy"), { recursive: true });
		const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, models: {} });
		writeFileSync(join(ws, "bigrefactor.config.json"), JSON.stringify(config, null, 2));
		const api = projectDir(config, "nestjs");
		mkdirSync(api, { recursive: true });
		writeFileSync(join(api, "package.json"), "{}");
		const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
		await inventory(config, ws, ledger);
		const nest = await getTargetAdapter("nestjs");
		const unit = ledger.listUnits()[0]!.id;
		ledger.transitionUnit(unit, "truth", "test");
		ledger.transitionUnit(unit, "implementing", "test");
		const q = ledger.askQuestion({ unitId: unit, point: "gate_env", question: "lint runs out of memory", askedBy: "test" });
		appendFileSync(setupLogPath(ws, "nestjs"), "earlier fix\n");
		ledger.updateUnit(unit, { meta: { parked: { question: q, env: envFingerprint(config, api, nest.toolchain.manifestFiles, setupFiles(ws, "nestjs")) } } });
		const adapters = new Map([["nestjs", nest]]);
		expect(resubmitParkedUnits(ledger, config, ws, new Set(), () => {}, adapters)).toEqual([]);
		appendFileSync(setupLogPath(ws, "nestjs"), "lint gets more memory\n"); // what fixRunSetup writes after a fix
		expect(resubmitParkedUnits(ledger, config, ws, new Set(), () => {}, adapters)).toEqual([]);
		expect(ledger.getQuestion(q)!.status).toBe("open");
		writeFileSync(overridesPath(ws, "nestjs"), JSON.stringify({ lint: { cmd: "npx", args: ["eslint", "{files}"] } })); // a gate command the setup model changed
		expect(resubmitParkedUnits(ledger, config, ws, new Set(), () => {}, adapters)).toEqual([unit]);
	});
});
