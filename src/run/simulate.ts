import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pc from "picocolors";
import { ConfigSchema, type Config } from "../config.ts";
import { ensureRepo, commitAll } from "../git.ts";
import { inventory } from "../inventory/run.ts";
import { Ledger } from "../ledger/db.ts";
import { FakeModelClient } from "../models/fake.ts";
import type { LeafSession, SpawnOptions } from "../sessions/spawn.ts";
import { makeWriteGate } from "../sessions/spawn.ts";
import { renderStatus } from "../dashboard/status.ts";
import type { GateInput, GateReport } from "./gate.ts";
import { runGate } from "./gate.ts";
import { lastRun, runScheduler } from "./run.ts";
import { lanes } from "./lanes.ts";
import { execFileSync } from "node:child_process";

/**
 * Simulation levels gate `br run`:
 *  L1  zero spend, seconds: scripted sessions + scripted build/lint/test outcomes on fixtures/mini-app in a
 *      throwaway workspace. Proves: ledger invariants, symbolproof, write gate, anti-gaming, triage branches
 *      (retry / escalate / retest / quarantine / ask_human), truth verification by code, commits, `br why`.
 *  L2  live models on the fixture (≤ $1): run every fixture unit through the real pipeline.
 *  L3  live models on a sample of real units in isolated worktrees, never merges; writes simulate-report.md
 *      and sets config.simulatedAt.
 */
export async function simulate(opts: { level: 1 | 2 | 3; sample: number }): Promise<void> {
	if (opts.level === 1) return simulateL1();
	throw new Error(`simulate --level ${opts.level} is not implemented yet (sample=${opts.sample}); run --level 1 first`);
}

type Script = Record<string, { implement?: "ok" | "unproven_once" | "build_fail_once" | "always_fail" | "outside_scope_once"; truth?: "ok" | "broken_once" }>;

const SCRIPT: Script = {
	U001_src_Config: { implement: "ok" },
	U002_src_Money: { implement: "build_fail_once" }, // → triage impl_bug → retry → green
	U003_src_InvoiceRepo: { implement: "unproven_once" }, // → symbolproof fails deterministically → retry → green
	U004_src_Pricing: { implement: "outside_scope_once" }, // → write gate blocks, anti-gaming clean, green
	U006_controllers_InvoiceController: { implement: "always_fail" }, // → escalate → quarantine at the cap
	U005_templates_invoice: { implement: "ok", truth: "broken_once" }, // tester's cases.php broken first → truth_red → rerun
};

export async function simulateL1(): Promise<void> {
	const t0 = Date.now();
	const here = resolve(import.meta.dirname, "../..");
	const ws = join(here, ".sim", "l1");
	rmSync(ws, { recursive: true, force: true });
	mkdirSync(join(ws, "legacy"), { recursive: true });
	cpSync(join(here, "fixtures", "mini-app"), join(ws, "legacy"), { recursive: true });
	const target = join(ws, "migrated");
	mkdirSync(join(target, "src"), { recursive: true });
	writeFileSync(join(target, "package.json"), JSON.stringify({ name: "sim", private: true, scripts: {}, devDependencies: { vitest: "x" } }, null, 2));
	// a real node_modules (as after `pnpm install`): worktrees symlink it; it must never be committed or flagged by the gate
	mkdirSync(join(target, "node_modules", "fake-dep"), { recursive: true });
	writeFileSync(join(target, "node_modules", "fake-dep", "index.js"), "module.exports = 1;\n");
	writeFileSync(join(target, ".gitignore"), "node_modules/\ndist/\n");
	ensureRepo(target, "migration/main");
	commitAll(target, "chore: bootstrap (simulated)");

	const config: Config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: target, stacks: ["nestjs"] }, models: {}, run: { maxImplementAttempts: 2, maxEscalateAttempts: 1, agentConcurrency: 4, gateConcurrency: 1 } });
	writeFileSync(join(ws, "bigrefactor.config.json"), JSON.stringify(config, null, 2));
	mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
	const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
	const inv = await inventory(config, ws, ledger);
	if (!inv.invariantsOk || (ledger.status().symbols["discovered"] ?? 0) !== 0) throw new Error("inventory invariants violated in simulation");

	// Jev stand-in: deterministic triage answers. Scripted per failing step so every branch is exercised.
	const client = new FakeModelClient({
		decide: (req) => {
			const state = req.state as { stage: string; attempt: number };
			const cause = state.stage === "build_ok" ? "impl_bug" : state.stage === "ported_tests_green" ? (state.attempt >= 2 ? "interface_mismatch" : "impl_bug") : "other";
			return { cause, retry_likely_to_help: state.attempt < 2 ? 0.9 : 0.3, same_as_previous: state.attempt >= 2 ? 0.9 : 0.1, escalate: state.attempt >= 2 ? 0.8 : 0.1 };
		},
	});

	// The real scheduler drives the run: agent pool (4) + gate pool (1), worktree per unit, rebase + ff-merge per accepted unit.
	const attemptsSeen = new Map<string, number>();
	const planFor = (unitId: string) => SCRIPT[unitId] ?? { implement: "ok" };
	const problems: string[] = [];
	// Run 1 is stopped (/br stop) as soon as the first lanes are running: they must finish, nothing new may
	// start, and the stop must be written down. Run 2 continues and completes the rest.
	let spawned = 0;
	const stopped = await runScheduler({
		ledger,
		config,
		root: ws,
		client,
		shouldStop: () => spawned > 0,
		handleSigint: false,
		spawn: (o) => (spawned++, fakeSpawn(ledger, planFor(unitIdOf(o)), attemptsSeen)(o)),
		gate: (g) => fakeGate(planFor(g.unitId), attemptsSeen)(g),
	});
	const rec = lastRun(ledger);
	if (rec?.outcome !== "stopped" || !rec.stop) problems.push(`stop: run record should say stopped, got ${rec?.outcome}`);
	else {
		const extra = (ledger.db.prepare("SELECT DISTINCT entity_id u FROM transitions WHERE entity = 'unit' AND from_state = 'planned' AND created_at > ? AND created_at <= ?").all(rec.stop.at, rec.endedAt) as Array<{ u: string }>).map((r) => r.u).filter((u) => !rec.stop!.finishing.includes(u));
		if (extra.length) problems.push(`stop: units started after the stop: ${extra.join(", ")}`);
		const unfinished = rec.stop.lanes.filter((l) => ["truth", "implementing", "gating"].includes(l.state) && !ledger.openQuestions().some((q) => q.unit_id === l.unit));
		if (unfinished.length) problems.push(`stop: lanes left mid-flight: ${unfinished.map((l) => `${l.unit}=${l.state}`).join(", ")}`);
		if (!rec.stop.finishing.length) problems.push("stop: no lanes were running when the stop came");
		if (!existsSync(join(ws, ".bigrefactor", "runs.jsonl"))) problems.push("stop: runs.jsonl not written");
		if (ledger.listUnits({ state: "planned" }).length === 0) problems.push("stop: everything ran despite the stop");
	}
	// Run 2 also resizes lanes mid-flight (`br lanes 2 --gates 1` while units run): the scheduler must apply it.
	let resized = false;
	const run2Log: string[] = [];
	const sched = await runScheduler({
		ledger,
		config,
		root: ws,
		client,
		handleSigint: false,
		log: (l) => (run2Log.push(l), console.log(l)),
		spawn: (o) => {
			if (!resized) {
				resized = true;
				lanes(join(ws, "bigrefactor.config.json"), { lanes: 2, gates: 1 });
			}
			return fakeSpawn(ledger, planFor(unitIdOf(o)), attemptsSeen)(o);
		},
		gate: (g) => fakeGate(planFor(g.unitId), attemptsSeen)(g),
	});
	const results = [...stopped.ran, ...sched.ran];
	if (resized && !run2Log.some((l) => /lanes \d+ → 2, gate slots \d+ → 1/.test(l))) problems.push("lanes: a mid-run change of run.agentConcurrency was not applied");

	// ---- assertions: what L1 must prove
	const states = Object.fromEntries(results.map((r) => [r.unitId, ledger.getUnit(r.unitId)!.state]));
	const expect = (id: string, st: string) => states[id] !== st && problems.push(`${id}: expected ${st}, got ${states[id]}`);
	expect("U001_src_Config", "accepted");
	expect("U002_src_Money", "accepted");
	expect("U003_src_InvoiceRepo", "accepted");
	expect("U004_src_Pricing", "accepted");
	expect("U005_templates_invoice", "accepted");
	expect("U006_controllers_InvoiceController", "quarantined");
	if (ledger.fileState("routes.php") !== "regenerated") problems.push("routes.php should be regenerated, not a unit");
	const inv2 = ledger.checkInvariants();
	if (!inv2.ok) problems.push(`invariants: ${inv2.problems.join("; ")}`);
	const unaccounted = ledger.unaccounted().filter((s) => !s.unit_id?.startsWith("U006"));
	if (unaccounted.length) problems.push(`${unaccounted.length} symbols unaccounted outside the quarantined unit`);
	const decisions = (ledger.db.prepare("SELECT action, COUNT(*) n FROM decisions GROUP BY action").all() as Array<{ action: string; n: number }>).map((d) => `${d.action}×${d.n}`);
	const commits = (ledger.db.prepare("SELECT COUNT(*) n FROM units WHERE json_extract(meta,'$.commit') IS NOT NULL").get() as { n: number }).n;
	const worktrees = existsSync(join(ws, ".bigrefactor", "worktrees")) ? readdirSync(join(ws, ".bigrefactor", "worktrees")).length : 0;
	if (worktrees) problems.push(`${worktrees} worktree(s) left behind`);
	const mainLog = execFileSync("git", ["-C", target, "log", "--oneline"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n");
	if (execFileSync("git", ["-C", target, "ls-files", "node_modules"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()) problems.push("node_modules got committed");
	if (!statSync(join(target, "node_modules")).isDirectory() || lstatSync(join(target, "node_modules")).isSymbolicLink()) problems.push("node_modules in the main checkout is no longer a real directory");
	if (mainLog.length < 6) problems.push(`expected ≥6 commits on migration/main, got ${mainLog.length}`);
	if (commits < 5) problems.push(`expected ≥5 commits, got ${commits}`);
	// truth-ahead: idle lanes captured truth for units still waiting on deps; those units must not re-run the tester
	const ahead = ledger.db.prepare("SELECT unit_id u, created_at at FROM evidence WHERE type = 'truth_ahead'").all() as Array<{ u: string; at: string }>;
	if (!ahead.length) problems.push("truth-ahead: no idle lane captured truth ahead (lanes should stay full while units wait on deps)");
	for (const a of ahead) {
		const firstImpl = (ledger.db.prepare("SELECT MIN(started_at) t FROM attempts WHERE unit_id = ? AND role = 'implement'").get(a.u) as { t: string | null }).t;
		const retested = (ledger.db.prepare("SELECT COUNT(*) n FROM attempts WHERE unit_id = ? AND role = 'test' AND started_at > ? AND started_at < COALESCE(?, '9999')").get(a.u, a.at, firstImpl) as { n: number }).n;
		if (retested) problems.push(`truth-ahead: ${a.u} ran the tester again before implementing (${retested}x)`);
		if (!firstImpl) problems.push(`truth-ahead: ${a.u} never got implemented`);
	}
	const blockedWrites = (ledger.db.prepare("SELECT COUNT(*) n FROM attempts WHERE json_extract(gate_report,'$.blockedWrites') > 0").get() as { n: number }).n;

	console.log("\n" + renderStatus(ledger));
	console.log(pc.dim(`decisions: ${decisions.join(", ")}  commits: ${commits}  attempts with blocked writes: ${blockedWrites}  ${Math.round((Date.now() - t0) / 1000)}s`));
	if (problems.length) {
		console.log(pc.red(`\nL1 FAILED\n- ${problems.join("\n- ")}`));
		process.exitCode = 1;
	} else {
		console.log(pc.green("\nL1 GREEN: ledger invariants, symbolproof, write gate, anti-gaming, triage retry/escalate/retest/quarantine, truth verification, commits"));
		ledger.setMeta("simulated_l1_at", new Date().toISOString());
	}
	ledger.close();
}

/** The scheduler spawns sessions per unit; the script is keyed by unit id, which the system prompt carries ("Unit <id>"). */
function unitIdOf(o: SpawnOptions): string {
	const m = /\b(U\d{3}_[A-Za-z0-9_]+)\b/.exec(o.systemPrompt) ?? /\b(U\d{3}_[A-Za-z0-9_]+)\b/.exec(o.transcriptPath ?? "");
	if (!m) throw new Error("fake spawn: cannot determine unit id");
	return m[1]!;
}

// ---- scripted leaf sessions ------------------------------------------------------------------------

function fakeSpawn(ledger: Ledger, plan: Script[string], attemptsSeen: Map<string, number>) {
	return async (o: SpawnOptions): Promise<LeafSession> => {
		const gate = makeWriteGate({ cwd: o.cwd, sourceRoot: o.config.source.path, writeGlobs: o.writeGlobs, protectedGlobs: o.protectedGlobs ?? [] });
		let blocked = 0;
		let toolCalls = 0;
		const write = (rel: string, content: string) => {
			toolCalls++;
			const reason = gate(rel);
			if (reason) {
				blocked++;
				return false;
			}
			mkdirSync(join(o.cwd, rel, ".."), { recursive: true });
			writeFileSync(join(o.cwd, rel), content);
			return true;
		};
		return {
			async run(prompt) {
				const unitId = /^# Unit (\S+)/m.exec(prompt)![1]!;
				const symbols = [...prompt.matchAll(/^- (\S+)  \[/gm)].map((m) => m[1]!);
				// every unit of an area extends the area's one service file (`<area>.service.ts`), as structure_ok demands
				const moduleOf = (glob: string) => glob.replace(/\/\*\*.*$/, "");
				const fileIn = (dir: string) => `${dir.split("/").pop()}.service`;
				const specOf = (dir: string) => `${dir.split("/").pop()}-${unitId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.service`;
				const key = `${unitId}:${o.role}`;
				const n = (attemptsSeen.get(key) ?? 0) + 1;
				attemptsSeen.set(key, n);
				const usage = { input: 1000, output: 300, cost: 0 };

				if (o.role === "test") {
					const truthDir = o.writeGlobs[0]!.replace(/\/\*\*$/, "");
					const targetDir = moduleOf(o.writeGlobs[1]!);
					const file = fileIn(targetDir);
					const broken = plan.truth === "broken_once" && n === 1;
					const cases = symbols.map((s) => ({ symbol: s, inputs: null, expected: `value-of-${s.split("::").pop()}` }));
					write(`${truthDir}/cases.php`, broken ? "<?php\nthrow new RuntimeException('simulated broken truth script');\n" : `<?php\necho <<<'JSON'\n${JSON.stringify(cases)}\nJSON;\n`);
					write(`${truthDir}/interface.md`, `${targetDir}/${file}.ts exports: ${symbols.map((s) => s.split("::").pop()).join(", ")}`);
					write(`${targetDir}/${specOf(targetDir)}.spec.ts`, `import { describe, it, expect } from "vitest";\nimport * as m from "./${file}";\ndescribe("${unitId}", () => { it("exists", () => expect(m).toBeTruthy()); });\n`);
					write(o.config.source.path + "/src/Hack.php", "<?php // must be blocked"); // read-only source
					return { text: `TESTER DONE ${cases.length} cases`, toolCalls, blocked, usage };
				}

				// implementer / escalate
				const outsideScope = plan.implement === "outside_scope_once" && n === 1;
				if (outsideScope) write("src/other/leak.ts", "export const leak = 1;"); // blocked by the write gate
				const moduleDir = moduleOf(o.writeGlobs[0]!);
				const file = fileIn(moduleDir);
				const existing = existsSync(join(o.cwd, moduleDir, `${file}.ts`)) ? readFileSync(join(o.cwd, moduleDir, `${file}.ts`), "utf8").replace(/\/\/ simulated port of \S+ attempt \d+\n/g, "") : "";
				const own = symbols.map((s) => `export const ${s.split("::").pop()!.replace(/\W/g, "_")} = "value-of-${s.split("::").pop()}";`).filter((l) => !existing.includes(l));
				write(`${moduleDir}/${file}.ts`, `// simulated port of ${unitId} attempt ${n}\n${existing}${own.join("\n")}\n`);
				write("package.json", "{}"); // protected → blocked
				const prove = o.customTools?.find((t) => t.name === "ledger_prove")!;
				const skipOne = plan.implement === "unproven_once" && n === 1;
				for (const [i, s] of symbols.entries()) {
					if (skipOne && i === 0) continue;
					toolCalls++;
					await prove.execute(`sim-${i}`, { srcSymbol: s, op: "moved", targetSymbols: [`${moduleDir}/${file}.ts::${s.split("::").pop()}`], why: `simulated 1:1 port (attempt ${n})` }, undefined, undefined, {} as any);
				}
				return { text: "IMPLEMENTER DONE", toolCalls, blocked, usage };
			},
			dispose() {},
		};
	};
}

/** Real symbolproof + anti-gaming (pure code); scripted build/lint/tests so L1 needs no toolchain. */
function fakeGate(plan: Script[string], attemptsSeen: Map<string, number>) {
	return async (g: GateInput): Promise<GateReport> => {
		const real = await runGate({ ...g, adapter: { ...g.adapter, build: () => ({ cmd: "true", args: [] }), lint: () => ({ cmd: "true", args: [] }), test: () => ({ cmd: "true", args: [] }) } });
		if (!real.ok) return real;
		const n = attemptsSeen.get(`${g.unitId}:implement`) ?? 0;
		const esc = attemptsSeen.get(`${g.unitId}:escalate`) ?? 0;
		const fail = (name: GateReport["steps"][number]["name"], output: string): GateReport => {
			const steps = real.steps.filter((s) => !["build_ok", "lint_ok", "rules_ok", "ported_tests_green"].includes(s.name) || s.name < name);
			// remove evidence the real gate recorded for scripted-failed steps and later ones
			g.ledger.db.prepare("DELETE FROM evidence WHERE unit_id = ? AND type IN ('build_ok','lint_ok','rules_ok','ported_tests_green')").run(g.unitId);
			for (const s of steps) if (s.ok && ["build_ok", "lint_ok", "rules_ok"].includes(s.name) && s.name !== name) g.ledger.addEvidence(g.unitId, s.name, { simulated: true });
			return { ok: false, steps: [...steps.filter((s) => s.name !== name), { name, ok: false, ms: 1, output }], changedFiles: real.changedFiles, failedStep: name };
		};
		if (plan.implement === "build_fail_once" && n === 1) return fail("build_ok", "src/money/money.ts(3,5): error TS2322: simulated type error");
		if (plan.implement === "always_fail") return fail("ported_tests_green", `FAIL simulated: expected 1 to be 2 (implement attempt ${n}, escalate ${esc})`);
		return real;
	};
}
