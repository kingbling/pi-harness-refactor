import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tsDiagnose, tsProjectNotes, tsTestRunner, tsVerifyChoices } from "../src/adapters/target/ts-index.ts";
import { getTargetAdapter } from "../src/adapters/registry.ts";
import { errorSignature } from "../src/run/run.ts";

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
		const unit = ledger.listUnits()[0]!.id;
		ledger.transitionUnit(unit, "truth", "test");
		ledger.transitionUnit(unit, "implementing", "test");
		const q = ledger.askQuestion({ unitId: unit, point: "triage_gate", question: "env", askedBy: "test" });
		ledger.updateUnit(unit, { meta: { parked: { question: q, env: envFingerprint(config, api) } } });
		const logs: string[] = [];

		expect(resubmitParkedUnits(ledger, config, ws, new Set(), (l) => logs.push(l))).toEqual([]); // nothing changed: stays parked
		expect(ledger.getUnit(unit)!.state).toBe("implementing");

		writeFileSync(join(api, "package.json"), JSON.stringify({ dependencies: { "drizzle-orm": "^1" }, devDependencies: { vitest: "^3" } })); // e.g. `pnpm add drizzle-orm`
		expect(resubmitParkedUnits(ledger, config, ws, new Set(), (l) => logs.push(l))).toEqual([unit]);
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
		// onboarding spend that is not in the ledger: backfill + this call = 0.5 + 0.25
		recordSpend(0.25, "api: chat", "m", ws);
		expect(totalSpend(ws).usd).toBeCloseTo(0.75);

		const footer = statusLine(ledger, ws);
		expect(footer).toMatch(/✓ 1\/\d+ accepted · ■ 1 quarantined · spent \$0\.75 total/);

		// a new run that has accepted nothing yet still shows the durable totals
		const snap = { plan: [], about: {}, running: true, stopping: false, startedAt: Date.now(), steps: [], activity: [], agents: [], costByLabel: {}, costUsd: 0, job: "migration run" } as any;
		const panel = renderProgress(snap, 140, durable(ledger, ws)).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		expect(panel).toMatch(/✓ 1 accepted\s+■ 1 quarantined/);
		expect(panel).toMatch(/spent \$0\.75 total/);
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
});
