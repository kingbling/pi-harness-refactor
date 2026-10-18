import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getTargetAdapter } from "../src/adapters/registry.ts";
import { ConfigSchema } from "../src/config.ts";
import { FOR_TESTER } from "../src/jev/ask.ts";
import { Ledger } from "../src/ledger/db.ts";
import type { GateInput, GateReport } from "../src/run/gate.ts";
import { truthBrokenKey } from "../src/run/legacy-env.ts";
import { keepPortedTests, requeueUnits } from "../src/run/run.ts";
import { runUnit } from "../src/run/unit.ts";
import type { LeafSession, SpawnOptions } from "../src/sessions/spawn.ts";

/**
 * A quarantined unit that runs again keeps its truth: its ported tests are kept when its worktree goes, and the
 * next run puts them back instead of having the tester write the truth and the tests again.
 */
const here = resolve(import.meta.dirname, "..");
const write = (p: string, s = "x\n") => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, s));
const SPEC = "src/features/agency/agency.service.spec.ts";
const hasPhp = (() => {
	try {
		execFileSync("php", ["-v"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

describe("a requeue keeps the truth", () => {
	it("the quarantined worktree's tests are kept; the next run uses them and the truth cases, without a tester session", async () => {
		const ws = join(here, ".sim", "requeue-truth");
		rmSync(ws, { recursive: true, force: true });
		write(join(ws, "legacy", "app", "agency", "create.cmd.php"), "<?php\n");
		const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, models: {} });
		write(join(ws, "migrated", "package.json"), "{}");
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
		ledger.createUnit({ id: "u1", tier: "T1", deps: [], meta: { files: ["app/agency/create.cmd.php"], place: { stack: "nestjs", area: "agency", shared: false, source: "code" } }, symbolIds: [] });
		write(join(ws, ".bigrefactor", "truth", "u1", "interface.md"), "src/features/agency/agency.service.ts exports AgencyService\n");
		ledger.addEvidence("u1", "truth_green_on_old", {});
		ledger.db.prepare("INSERT INTO truth_cases(id, unit_id, symbol_id, inputs, expected, verified_on_old, created_at) VALUES ('u1#1','u1','s','[]','1',1,'t')").run();
		ledger.transitionUnit("u1", "truth", "t");
		ledger.transitionUnit("u1", "implementing", "t");
		ledger.transitionUnit("u1", "quarantined", "gate still red after 5 attempts (wired_ok)");

		// the quarantined unit's worktree has the tests its tester wrote; they are kept before it goes
		const old = join(ws, "worktrees", "u1-old");
		write(join(old, SPEC), "it('u1#1 creates an agency with its id', () => {});\n");
		const layout = (await getTargetAdapter("nestjs")).layout;
		expect(keepPortedTests(config, ws, "u1", ledger.getUnit("u1")!.meta, old, layout)).toEqual([SPEC]);
		rmSync(old, { recursive: true, force: true });
		expect(await requeueUnits(ledger, config, ws, ["u1"], "self-heal")).toEqual(["u1: requeued"]);

		// the next run starts from a fresh worktree without the tests
		const fresh = join(ws, "worktrees", "u1");
		write(join(fresh, "package.json"), "{}");
		const roles: string[] = [];
		const spawn = (async (opts: SpawnOptions): Promise<LeafSession> =>
			({
				run: async () => (roles.push(opts.role), { text: "IMPLEMENTER DONE", toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } }),
				dispose() {},
			}) as unknown as LeafSession) as never;
		const gate = async (g: GateInput): Promise<GateReport> => ({ ok: true, steps: [], changedFiles: [], testFiles: g.testFiles.map((t) => t.path) });
		await runUnit({ ledger, config, root: ws, unitId: "u1", workDir: fresh, reuseTruth: true, spawn, gate, log: () => {} });
		expect(roles).toEqual(["implement"]);
		expect(readFileSync(join(fresh, SPEC), "utf8")).toContain("u1#1 creates an agency");
		expect(ledger.db.prepare("SELECT id FROM truth_cases WHERE unit_id = 'u1'").all()).toEqual([{ id: "u1#1" }]);
		expect(existsSync(join(ws, ".bigrefactor", "truth", "u1", "ported", SPEC))).toBe(true);
		ledger.close();
	});

	it.skipIf(!hasPhp)("a truth script a setup fix broke is not reused: the tester gets the error and the start-up check, and green again clears the mark", async () => {
		const ws = join(here, ".sim", "requeue-truth-broken");
		rmSync(ws, { recursive: true, force: true });
		write(join(ws, "legacy", "app", "agency", "create.cmd.php"), "<?php\nfunction agency_code($n) { return strtoupper($n); }\n");
		const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, models: {} });
		write(join(ws, "migrated", "package.json"), "{}");
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
		ledger.createUnit({ id: "u1", tier: "T1", deps: [], meta: { files: ["app/agency/create.cmd.php"], place: { stack: "nestjs", area: "agency", shared: false, source: "code" } }, symbolIds: [] });
		const truthDir = join(ws, ".bigrefactor", "truth", "u1");
		write(join(truthDir, "interface.md"), "src/features/agency/agency.service.ts exports AgencyService\n");
		ledger.addEvidence("u1", "truth_green_on_old", {});
		ledger.setMeta(truthBrokenKey("u1"), "PHP Fatal error: Cannot declare class Kernel, because the name is already in use");
		const fresh = join(ws, "worktrees", "u1");
		write(join(fresh, "package.json"), "{}");
		const seen: Array<{ role: string; prompt: string; tools: string[] }> = [];
		const spawn = (async (opts: SpawnOptions): Promise<LeafSession> =>
			({
				run: async (prompt: string) => {
					seen.push({ role: opts.role, prompt, tools: (opts.customTools ?? []).map((t) => t.name) });
					if (opts.role === "test") {
						write(join(truthDir, "cases.php"), "<?php\nif (!function_exists('agency_code')) require_once 'app/agency/create.cmd.php';\necho json_encode([['symbol' => 'agency_code', 'inputs' => ['ab'], 'expected' => agency_code('ab')]]);\n");
						write(join(fresh, SPEC), "it('u1#1 codes an agency', () => {});\n");
					}
					return { text: opts.role === "test" ? "TESTER DONE" : "IMPLEMENTER DONE", toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } };
				},
				dispose() {},
			}) as unknown as LeafSession) as never;
		const gate = async (g: GateInput): Promise<GateReport> => ({ ok: true, steps: [], changedFiles: [], testFiles: g.testFiles.map((t) => t.path) });
		await runUnit({ ledger, config, root: ws, unitId: "u1", workDir: fresh, reuseTruth: true, spawn, gate, legacyFixer: false, log: () => {} });
		expect(seen[0]!.role).toBe("test");
		expect(seen[0]!.prompt).toMatch(/a setup fix changed what it runs on[\s\S]*Cannot declare class Kernel/);
		expect(seen[0]!.tools).toContain("legacy_declared");
		expect(ledger.getMeta(truthBrokenKey("u1"))).toBe("");
		expect(ledger.db.prepare("SELECT expected FROM truth_cases WHERE unit_id = 'u1'").all()).toEqual([{ expected: '"AB"' }]);
		ledger.close();
	});

	it("--fresh: the interface and the kept tests go, so the tester drafts them again; the truth cases stay", async () => {
		const ws = join(here, ".sim", "requeue-fresh");
		rmSync(ws, { recursive: true, force: true });
		const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, models: {} });
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
		for (const id of ["u1", "u2"]) {
			ledger.createUnit({ id, tier: "T1", deps: [], meta: {}, symbolIds: [] });
			write(join(ws, ".bigrefactor", "truth", id, "interface.md"), "# Deferred target interface\n");
			write(join(ws, ".bigrefactor", "truth", id, "cases.json"), "[]");
			write(join(ws, ".bigrefactor", "truth", id, "ported", SPEC));
		}
		ledger.transitionUnit("u1", "truth", "t");
		ledger.transitionUnit("u1", "quarantined", "gate still red after 5 attempts (antigaming_ok)");
		// u1 is quarantined, u2 still waits in the queue: both lose their draft
		expect(await requeueUnits(ledger, config, ws, ["u1", "u2"], "owner", { fresh: true })).toEqual(["u1: requeued", "u2: requeued"]);
		for (const id of ["u1", "u2"]) {
			expect(ledger.getUnit(id)!.state).toBe("planned");
			expect(existsSync(join(ws, ".bigrefactor", "truth", id, "interface.md"))).toBe(false);
			expect(existsSync(join(ws, ".bigrefactor", "truth", id, "ported"))).toBe(false);
			expect(existsSync(join(ws, ".bigrefactor", "truth", id, "cases.json"))).toBe(true);
		}
		ledger.close();
	});
});

describe("a requeue with a hint for the tester", () => {
	it("runs the tester first (once) although the truth was kept; a stray saved file outside the test paths is dropped, not put back", async () => {
		const ws = join(here, ".sim", "requeue-tester-hint");
		rmSync(ws, { recursive: true, force: true });
		write(join(ws, "legacy", "app", "agency", "create.cmd.php"), "<?php\n");
		const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, models: {} });
		write(join(ws, "migrated", "package.json"), "{}");
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
		ledger.createUnit({ id: "u1", tier: "T1", deps: [], meta: { files: ["app/agency/create.cmd.php"], place: { stack: "nestjs", area: "agency", shared: false, source: "code" } }, symbolIds: [] });
		const truthDir = join(ws, ".bigrefactor", "truth", "u1");
		write(join(truthDir, "interface.md"), "src/features/agency/agency.service.ts exports AgencyService\n");
		ledger.addEvidence("u1", "truth_green_on_old", {});
		ledger.db.prepare("INSERT INTO truth_cases(id, unit_id, symbol_id, inputs, expected, verified_on_old, created_at) VALUES ('u1#1','u1','s','[]','1',1,'t')").run();
		// the saved tests: the unit's own, and a file a tester wrote straight into the saved folder at the project root
		write(join(truthDir, "ported", SPEC), "it('u1#1 creates an agency', () => {});\n");
		write(join(truthDir, "ported", "agency.spec.ts"), "it.skip('u1#1', () => {});\n");
		ledger.transitionUnit("u1", "truth", "t");
		ledger.transitionUnit("u1", "planned", "resubmitted");
		const fresh = join(ws, "worktrees", "u1");
		write(join(fresh, "package.json"), "{}");
		const seen: Array<{ role: string; prompt: string; protectedGlobs: string[] }> = [];
		const spawn = (async (opts: SpawnOptions): Promise<LeafSession> =>
			({
				run: async (prompt: string) => (seen.push({ role: opts.role, prompt, protectedGlobs: opts.protectedGlobs ?? [] }), { text: opts.role === "test" ? "TESTER DONE" : "IMPLEMENTER DONE", toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } }),
				dispose() {},
			}) as unknown as LeafSession) as never;
		const gate = async (g: GateInput): Promise<GateReport> => ({ ok: true, steps: [], changedFiles: [], testFiles: g.testFiles.map((t) => t.path) });
		const retryNote = `A model's hint (not the owner's): ${FOR_TESTER}case u1#1 expects 2, not 1 (the legacy code adds one).`;
		await runUnit({ ledger, config, root: ws, unitId: "u1", workDir: fresh, reuseTruth: true, retryNote, spawn, gate, legacyFixer: false, log: () => {} });
		expect(seen.map((s) => s.role)).toEqual(["test", "implement"]);
		expect(seen[0]!.prompt).toMatch(/saved tests or truth cases are wrong[\s\S]*expects 2, not 1/);
		// the tester never writes into the saved folder itself
		expect(seen[0]!.protectedGlobs).toContain(".bigrefactor/truth/u1/ported/**");
		expect(existsSync(join(fresh, SPEC))).toBe(true);
		expect(existsSync(join(fresh, "agency.spec.ts"))).toBe(false);
		expect(existsSync(join(truthDir, "ported", "agency.spec.ts"))).toBe(false);
		// a second round of the same run (a merge conflict) does not pay for the tester again
		seen.length = 0;
		await runUnit({ ledger, config, root: ws, unitId: "u1", workDir: fresh, reuseTruth: true, retryNote, spawn, gate, legacyFixer: false, log: () => {} });
		expect(seen.map((s) => s.role)).not.toContain("test");
		ledger.close();
	});
});
