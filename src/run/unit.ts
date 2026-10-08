import { createHash } from "node:crypto";
import { diagnoseFailure } from "./doctor.ts";
import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import pc from "picocolors";
import { overridesPath, setupLogPath } from "../adapters/command-overrides.ts";
import { getSourceAdapter, getTargetAdapter } from "../adapters/registry.ts";
import type { SourceAdapter, TargetAdapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import { commitAll, mainBranch } from "../git.ts";
import { projectDir } from "../init/init.ts";
import { syntaxErrors } from "../inventory/treesitter.ts";
import { describeCapabilities } from "../inventory/capabilities.ts";
import { indexTarget } from "../inventory/target.ts";
import { askViaModel } from "../jev/ask.ts";
import { sameQuestion } from "../jev/same.ts";
import type { Ledger } from "../ledger/db.ts";
import type { ModelClient } from "../models/types.ts";
import { globToRegExp, spawnLeaf } from "../sessions/spawn.ts";
import { buildTaskCard, renderTaskCard } from "../sessions/taskcard.ts";
import { implementerTools, testerTools } from "../sessions/tools.ts";
import { errorSignature, othersTestsChanged, renderGate, runGate, sha1, type GateReport } from "./gate.ts";
export { errorSignature };
import { recordDrift } from "./layout-check.ts";
import { placementDir, placeUnit, unplacedReason } from "./placement.ts";
import { isDbUnitKind } from "../inventory/db.ts";
import { reviewWithModel, type Reviewer } from "./review.ts";
import { reopenUnit } from "./recheck.ts";
import { implementerSystemPrompt, rulesText, testerSystemPrompt } from "./prompts.ts";
import { askPendingQuirks, quirkRetestNote, quirkSummary } from "./quirks.ts";
import { completeTidyTasks, tidyTasks, type TidyTask } from "./tidy.ts";
import { triageGate, type Triage } from "./triage.ts";
import { fixRunSetup, fixSetupWithModel, type SetupFixer } from "../init/setup-fixer.ts";
import { describeTruthRun, fixLegacyEnv, fixLegacyEnvWithModel, loadLegacyEnv, loadReadTruth, READ_CASES_FILE, verifyTruthOnOld, type LegacyFixer, type TruthCase, type TruthMode } from "./legacy-env.ts";

/**
 * The unit's own small orchestrator. Deterministic playbook ("go instructions"):
 *
 *   truth ──► implement ──► gate ──┬─ green ──► review ──► accept (commit)
 *      ▲          ▲               │
 *      │          └── retry/escalate ◄── Jev triage (cause, retry helps?, same failure?, escalate?)
 *      └──────────── retest (test_bug / interface_mismatch)
 *                                  └── ask_human (ledger question; only this unit waits) / quarantine (cap)
 *
 * Code decides whenever it can (symbolproof, anti-gaming, caps); Jev picks the next step on gate failures;
 * LLM sessions only generate. Every step leaves evidence/attempts/decisions in the ledger.
 */
export interface UnitRunOptions {
	ledger: Ledger;
	config: Config;
	root: string;
	unitId: string;
	/** Jev client for triage; without it gate failures fall back to plain retries. */
	client?: ModelClient;
	reuseTruth?: boolean;
	/**
	 * Truth-ahead: run only the tester phase (characterization on the old code + ported tests) for a unit whose
	 * deps are not migrated yet, so an idle lane does useful work. Ported tests are saved next to the truth and
	 * restored into the unit's worktree when it runs for real; the unit stays planned.
	 */
	truthOnly?: boolean;
	accept?: boolean;
	/** Re-run a quarantined unit. */
	retry?: boolean;
	/** Gate pool slot: wraps the CPU-bound gate so at most K run at once. */
	gateSlot?: <T>(fn: () => Promise<T>) => Promise<T>;
	/** The run's merge lock: a setup fix commits to main under it. */
	mergeLock?: <T>(fn: () => Promise<T>) => Promise<T>;
	log?: (line: string) => void;
	/** Git worktree of the target repo to work in (scheduler); default = the target repo itself. */
	workDir?: string;
	/** Extra instruction for the first implement pass (e.g. after a merge conflict). */
	retryNote?: string;
	/** Injection points for simulation level 1 (scripted sessions, scripted build/test outcomes). */
	spawn?: typeof spawnLeaf;
	gate?: typeof runGate;
	/** Fixes setup problems of the new project during the run; default: the setup model (none when `spawn` is faked). */
	setupFixer?: SetupFixer | false;
	/** Sets up the old code's environment when truth stays red; default: the setup model (none when `spawn` is faked). */
	legacyFixer?: LegacyFixer | false;
	/** Judges wired_ok (real, connected, on the chosen stack); default: the reviewer model (none when `spawn` is faked). */
	reviewer?: Reviewer | false;
}

export interface UnitRunResult {
	unitId: string;
	state: string;
	attempts: number;
	gate?: GateReport;
	triage?: Triage;
	costUsd: number;
}

export async function runUnit(o: UnitRunOptions): Promise<UnitRunResult> {
	const log = o.log ?? ((l: string) => console.log(l));
	const unit = o.ledger.getUnit(o.unitId);
	if (!unit) throw new Error(`unit ${o.unitId} not found; run br inventory`);
	if (unit.state === "accepted") return { unitId: o.unitId, state: "accepted", attempts: 0, costUsd: 0 };
	if (unit.state === "quarantined") {
		if (!o.retry) throw new Error(`unit ${o.unitId} is quarantined; pass --retry to run it again`);
		o.ledger.transitionUnit(o.unitId, "implementing", "manual retry");
	}
	const blocked = o.ledger.blockedUnits().get(o.unitId);
	if (blocked?.length) throw new Error(`unit ${o.unitId} waits for human question(s) #${blocked.join(", #")} (br questions)`);

	// the DB lane: schema / design / data units run their own loop (no legacy symbols, the schema is the truth)
	if (isDbUnitKind(unit.kind)) {
		if (o.truthOnly) return { unitId: o.unitId, state: unit.state, attempts: 0, costUsd: 0 };
		const { runDbUnit } = await import("./db-unit.ts");
		return runDbUnit(o, placeUnit(o.config, unit.meta, o.root));
	}
	// never on code's unsure guess: an unplaced unit waits for Jev or its placement question (br place)
	const unplaced = unplacedReason(o.config, unit.meta, o.root);
	if (unplaced) throw new Error(`unit ${o.unitId} has no placement yet (code unsure: ${unplaced}); br place`);
	const place = placeUnit(o.config, unit.meta, o.root);
	const { stackId, area } = place;
	process.env["BR_WORKSPACE"] = o.root; // the stack's layout.json lives in this workspace
	const adapter = await getTargetAdapter(stackId);
	const targetProjectDir = o.workDir ? join(o.workDir, relative(o.config.target.path, projectDir(o.config, stackId))) : projectDir(o.config, stackId);
	if (!adapter.toolchain.isProjectReady(targetProjectDir)) throw new Error(`target project missing at ${targetProjectDir}; run br setup`);
	const sourceAdapter = getSourceAdapter(o.config.source.stack);
	// one legacy area = one feature module (or, for code ≥ 2 areas use, the shared dir + area)
	const moduleDir = placementDir(adapter.layout, place);
	// approved tidy tasks of the area: their files are in scope (existing shared ones too); 1:1 moves are done by code
	const tidy = tidyTasks(o.ledger, stackId, area).filter((t) => t.status === "approved");
	const tidyMoved = tidyMoves(targetProjectDir, tidy, adapter.layout.isTestFile);
	if (tidyMoved.length) log(pc.dim(`  tidy: moved ${tidyMoved.join(", ")} (imports are the implementer's job)`));
	const tidyPaths = [...new Set(tidy.flatMap((t) => [...t.from, ...t.to]))];
	const writeGlobs = [`${moduleDir}/**`, ...tidyPaths];
	const appendOnlyGlobs = adapter.layout.sharedDirs.map((d) => `${d.replace(/\/$/, "")}/**`); // cross-cutting helpers: add new files, never edit
	const truthDirAbs = join(o.root, ".bigrefactor", "truth", o.unitId);
	mkdirSync(truthDirAbs, { recursive: true });
	const truthDirRel = relative(o.root, truthDirAbs);
	const targetRel = relative(o.root, targetProjectDir);
	const rules = rulesText(o.root, stackId, moduleDir);
	const placeOpts = { area, stackId, moduleDir, structureDoc: adapter.layout.structureDoc };
	const gateSlot = o.gateSlot ?? (<T>(fn: () => Promise<T>) => fn());
	const spawn = o.spawn ?? spawnLeaf;
	const gateFn = o.gate ?? runGate;
	let cost = 0;
	let providerErrors = 0;
	const askDeps = { ledger: o.ledger, config: o.config, root: o.root, client: o.client };
	const ask = async (q: Pick<Parameters<typeof askViaModel>[1], "point" | "facts" | "options" | "context" | "sameAs">): Promise<number> => {
		const r = await askViaModel(askDeps, { unitId: o.unitId, askedBy: "orchestrator", blocks: "unit", ...q });
		cost += r.costUsd;
		return r.id;
	};

	const deps = { ledger: o.ledger, config: o.config, unitId: o.unitId, root: o.root, targetProjectDir, adapter, moduleDir };
	const card = buildTaskCard(o.ledger, o.config, o.unitId, { targetProjectDir, writeGlobs, adapter, place, moduleDir, root: o.root });
	if (card.unresolvedDeps.length) log(pc.yellow(`note: ${card.unresolvedDeps.length} dependencies not migrated yet: ${card.unresolvedDeps.join(", ")}`));

	// ---- truth ----------------------------------------------------------------------------------
	// run: expected values come from running the old code; read: it cannot run here (decided once per workspace,
	// or for this unit after running failed), so the tester writes them from reading it — marked in the ledger
	let lastTesterText = "";
	const envMode: TruthMode = loadLegacyEnv(o.root, o.config).mode ?? "run";
	let truthMode: TruthMode = envMode;
	const runTruth = async (extra?: string): Promise<boolean> => {
		if (!o.truthOnly && o.ledger.getUnit(o.unitId)!.state === "planned") o.ledger.transitionUnit(o.unitId, "truth", "tester session started");
		const attempt = o.ledger.startAttempt(o.unitId, "test", o.config.models.test.id);
		const t0 = Date.now();
		const tester = await spawn({
			role: "test",
			cwd: o.root,
			config: o.config,
			writeGlobs: [`${truthDirRel}/**`, ...adapter.layout.testFileGlobs(moduleDir).map((g) => `${targetRel}/${g}`)],
			protectedGlobs: [],
			systemPrompt: testerSystemPrompt(o.config, { ...placeOpts, unitId: o.unitId, truthMode, truthRun: describeTruthRun(o.root, o.config, sourceAdapter, join(truthDirAbs, sourceAdapter.truth.scriptName)), truthDir: truthDirRel, targetProjectDir: targetRel, rules, source: sourceAdapter, target: adapter, projectNotes: adapter.projectNotes?.(targetProjectDir) ?? [] }),
			customTools: testerTools({ ...deps, attemptId: attempt }),
			transcriptPath: transcriptPath(o.root, o.unitId, "test", attempt),
			onToolCall: (e) => e.blocked && log(pc.dim(`  tester blocked: ${e.blocked}`)),
		});
		let res;
		try {
			// the orchestrator's note (owner hint, earlier diagnosis) reaches the first tester too, not only the implementer
			const note = o.retryNote && !extra ? `\n\n## Note from the orchestrator\n${o.retryNote}` : "";
			res = await tester.run(renderTaskCard(card, o.config) + (extra ? `\n\n## Re-port requested\n${extra}` : "") + note);
		} finally {
			tester.dispose();
		}
		cost += res.usage.cost;
		lastTesterText = res.text;
		// tests of earlier units prove accepted behaviour: the tester may not rewrite them (undone, and it is told)
		const others = othersTestsChanged(targetProjectDir, o.unitId, (f) => adapter.layout.isTestFile(f), tidyPaths);
		if (others.length) {
			execFileSync("git", ["checkout", "HEAD", "--", ...others], { cwd: targetProjectDir, stdio: "pipe" });
			log(pc.yellow(`  tester changed ${others.length} test(s) of earlier units; undone: ${others.slice(0, 5).join(", ")}`));
			res = { ...res, text: `${res.text}\n(Your changes to tests of earlier units were undone: ${others.join(", ")}. If one is wrong, say which and why in your final answer.)` };
			lastTesterText = res.text;
		}
		log(pc.dim(`  tester: ${res.toolCalls} tool calls, ${res.blocked} blocked, ${Math.round((Date.now() - t0) / 1000)}s, $${res.usage.cost.toFixed(4)} — ${res.text.split("\n").at(-1)}${res.error ? pc.red(` ERROR: ${res.error}`) : ""}`));

		// Code verifies the truth: re-run the cases script ourselves (it must load the unit's legacy files and not
		// type the results in) and load the cases; read-not-run cases are only checked for shape.
		const verified = truthMode === "run" ? verifyTruthOnOld(truthDirAbs, o.config, sourceAdapter, o.root, card.files) : loadReadTruth(truthDirAbs);
		o.ledger.endAttempt(attempt, { outcome: verified.ok ? "truth_green" : "truth_red", costUsd: res.usage.cost, tokensIn: res.usage.input, tokensOut: res.usage.output, gateReport: { mode: truthMode, cases: verified.cases.length, error: verified.error } });
		if (!verified.ok) {
			log(pc.red(`  truth (${truthMode}) failed: ${verified.error}`));
			return false;
		}
		recordTruth(verified.cases, truthMode);
		return true;
	};
	// cases go to the ledger with how they were made; each one must be a ported test (coverTruth checks)
	const recordTruth = (cases: TruthCase[], mode: TruthMode) => {
		o.ledger.db.prepare("DELETE FROM truth_cases WHERE unit_id = ?").run(o.unitId);
		const ins = o.ledger.db.prepare("INSERT INTO truth_cases(id, unit_id, symbol_id, inputs, expected, verified_on_old, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
		cases.forEach((c, i) => ins.run(`${o.unitId}#${i + 1}`, o.unitId, c.symbol, JSON.stringify(c.inputs), JSON.stringify(c.expected), mode === "run" ? 1 : 0, new Date().toISOString()));
		if (mode === "run") {
			o.ledger.addEvidence(o.unitId, "truth_green_on_old", { cases: cases.length, script: `${truthDirRel}/${sourceAdapter.truth.scriptName}` });
			log(pc.green(`  truth: ${cases.length} cases green on old code`));
		} else {
			o.ledger.addEvidence(o.unitId, "truth_read", { cases: cases.length, file: `${truthDirRel}/${READ_CASES_FILE}`, why: envMode === "read" ? "the old code does not run here" : "the script did not run green on the old code" });
			log(pc.yellow(`  truth: ${cases.length} cases read from the old code, not run`));
		}
	};

	const portedDir = join(truthDirAbs, "ported");
	const ahead = !o.truthOnly && o.ledger.hasEvidence(o.unitId, "truth_ahead") && existsSync(portedDir);
	const hasTruth = (o.reuseTruth || ahead) && (o.ledger.hasEvidence(o.unitId, "truth_green_on_old") || o.ledger.hasEvidence(o.unitId, "truth_read")) && existsSync(join(truthDirAbs, "interface.md"));
	if (!hasTruth) {
		// Playbook: a red truth script gets one more tester pass with the exact error; then a human question (only this unit waits).
		let truthOk = false;
		let lastErr: string | undefined;
		const truthFile = () => (truthMode === "run" ? sourceAdapter.truth.scriptName : READ_CASES_FILE);
		for (let t = 1; t <= 2 && !truthOk; t++) {
			truthOk = await runTruth(lastErr ? `Your previous ${truthFile()} was rejected by the orchestrator${truthMode === "run" ? " (run from the legacy root)" : ""}. Fix it:\n${lastErr}` : undefined);
			if (!truthOk) lastErr = (o.ledger.db.prepare("SELECT gate_report FROM attempts WHERE unit_id = ? AND role = 'test' ORDER BY id DESC LIMIT 1").get(o.unitId) as { gate_report: string } | undefined)?.gate_report ?? "";
		}
		// still red: maybe the old code cannot run here (packages never installed, a runtime only in docker). The
		// setup model prepares its environment once for all units; code re-runs this script to decide it worked.
		const legacyFixer = o.legacyFixer === false ? undefined : (o.legacyFixer ?? (o.spawn ? undefined : fixLegacyEnvWithModel));
		if (!truthOk && truthMode === "run" && legacyFixer && lastErr) {
			const fixed = await fixLegacyEnv({ config: o.config, root: o.root, source: sourceAdapter, problem: lastErr, truthDir: truthDirAbs, signature: errorSignature("truth", truthError(lastErr)), fixer: legacyFixer }).catch((e) => (log(pc.yellow(`  legacy setup failed: ${e?.message ?? e}`)), undefined));
			const verified = fixed ? verifyTruthOnOld(truthDirAbs, o.config, sourceAdapter, o.root, card.files) : undefined;
			if (fixed && verified?.ok) {
				log(pc.cyan(`  the old code's environment was set up: ${fixed}`));
				recordTruth(verified.cases, "run");
				truthOk = true;
				// units that asked the owner about the same thing run again in the new environment
				for (const q of o.ledger.openQuestions().filter((x) => x.point === "truth_env")) o.ledger.answerQuestion(q.id, `auto: the old code's environment was set up (${fixed})`, "setup model");
			}
		}
		// running it still fails for this unit: truth from reading the old code instead, marked as not run
		const runErr = truthMode === "run" ? lastErr : undefined;
		if (!truthOk && truthMode === "run") {
			truthMode = "read";
			log(pc.yellow(`  truth does not run green on the old code; the tester writes it from reading the code (marked: read, not run)`));
			for (let t = 1; t <= 2 && !truthOk; t++) {
				truthOk = await runTruth(`Running ${sourceAdapter.truth.scriptName} on the old code failed${runErr ? `:\n${runErr.slice(-1500)}` : ""}\nWrite ${truthDirRel}/${READ_CASES_FILE} instead (see step 3).${t > 1 && lastErr ? `\nYour previous ${READ_CASES_FILE} was rejected:\n${lastErr}` : ""}`);
				if (!truthOk) lastErr = (o.ledger.db.prepare("SELECT gate_report FROM attempts WHERE unit_id = ? AND role = 'test' ORDER BY id DESC LIMIT 1").get(o.unitId) as { gate_report: string } | undefined)?.gate_report ?? "";
			}
		}
		if (!truthOk) {
			const q = await ask({
				point: "truth_env",
				// units whose old code fails the same way share one question: one answer releases them all
				sameAs: errorSignature("truth", truthError(runErr ?? lastErr ?? "")),
				facts: `The tester ran twice for ${o.unitId} (legacy files ${card.files.join(", ")}); the characterization script did not run green on the old code either time.${runErr && runErr !== lastErr ? ` Running it failed with:\n${truthError(runErr).slice(-1000)}\nWriting the cases from reading the code failed too.` : ""} Last error:\n${lastErr?.slice(-1500) ?? "(none)"}`,
				options: [
					{ value: "fixed", facts: "the legacy environment (dependencies, module loading, DB) is fixed now: the tester runs again" },
					{ value: "quarantine", facts: "the code cannot run here: leave the unit for a human (type a hint instead to steer the tester)" },
				],
				context: { error: lastErr?.slice(-1500) },
			});
			log(pc.yellow(`  truth still red; asked question #${q} — only this unit waits`));
			return { unitId: o.unitId, state: o.ledger.getUnit(o.unitId)!.state, attempts: 2, costUsd: cost };
		}
	}

	// The drafted interface must stay inside the unit's placement (code checks, the tester fixes): never a
	// folder per legacy file, never another area's module.
	const allowedDirs = place.shared ? adapter.layout.sharedDirs : [`${moduleDir}/`];
	const outside = () => draftedOutside(existsSync(join(truthDirAbs, "interface.md")) ? readFileSync(join(truthDirAbs, "interface.md"), "utf8") : "", allowedDirs, targetRel, [targetProjectDir, o.config.source.path, o.root]);
	for (let i = 0, bad = outside(); bad.length; i++, bad = outside()) {
		if (i === 2) {
			// two retests did not fix it: never implement against an interface outside the placement
			o.ledger.transitionUnit(o.unitId, "quarantined", `interface.md still drafts files outside ${moduleDir}/ after 2 retests: ${bad.join(", ")}`);
			log(pc.red(`  interface.md still outside the placement after 2 retests; quarantined`));
			return { unitId: o.unitId, state: "quarantined", attempts: 0, costUsd: cost };
		}
		log(pc.yellow(`  interface.md drafts files outside ${moduleDir}/: ${bad.join(", ")} — retest`));
		await runTruth(`interface.md drafts files outside this unit's placement: ${bad.join(", ")}. Every file this unit creates lives under ${moduleDir}/ (area "${area}"), shaped as below; extend the files already there instead of creating parallel ones. Fix interface.md and the ported tests' imports.\n${adapter.layout.structureDoc}`);
	}

	// Every truth case is a ported test the gate runs: its id (u1#3) is in a test's name. Code checks and links
	// each case to its test file; the tester adds what is missing (twice), then the unit stops.
	const uncoveredCases = (): string[] => {
		const cases = o.ledger.db.prepare("SELECT id FROM truth_cases WHERE unit_id = ? ORDER BY rowid").all(o.unitId) as Array<{ id: string }>;
		const tests = findTests(targetProjectDir, moduleDir, adapter.layout).map((p) => [p, readFileSync(join(targetProjectDir, p), "utf8")] as const);
		const link = o.ledger.db.prepare("UPDATE truth_cases SET ported_test_path = ? WHERE id = ?");
		const missing: string[] = [];
		for (const c of cases) {
			const hit = tests.find(([, text]) => mentionsCase(text, c.id));
			link.run(hit?.[0] ?? null, c.id);
			if (!hit) missing.push(c.id);
		}
		return missing;
	};
	const coverTruth = async (): Promise<boolean> => {
		for (let i = 0; ; i++) {
			const missing = uncoveredCases();
			if (!missing.length) return true;
			if (i === 2) {
				log(pc.red(`  ${missing.length} truth case(s) still without a ported test after 2 retests: ${missing.slice(0, 10).join(", ")}`));
				if (!o.truthOnly) o.ledger.transitionUnit(o.unitId, "quarantined", `truth cases without a ported test after 2 retests: ${missing.slice(0, 10).join(", ")}`);
				return false;
			}
			log(pc.yellow(`  ${missing.length} truth case(s) have no ported test — retest`));
			await runTruth(`These truth cases have no ported test yet: ${missing.join(", ")}. Every case gets its own test whose name contains the case id (e.g. "${missing[0]} …"), asserting the case's expected value.`);
		}
	};

	// keep the ported tests: the worktree is thrown away until the unit runs again (deps landed, question answered)
	const savePorted = () => {
		const files = findTests(targetProjectDir, moduleDir, adapter.layout);
		for (const f of files) {
			mkdirSync(dirname(join(portedDir, f)), { recursive: true });
			copyFileSync(join(targetProjectDir, f), join(portedDir, f));
		}
		o.ledger.addEvidence(o.unitId, "truth_ahead", { files });
		return files;
	};
	// quirks the tester recorded become questions (phrased by a model); only this unit waits for them
	cost += (await askPendingQuirks({ ...askDeps, root: o.root }, o.unitId)).costUsd;
	if (o.ledger.blockedUnits().has(o.unitId)) {
		const files = savePorted();
		log(pc.yellow(`  quirk question(s) #${o.ledger.blockedUnits().get(o.unitId)!.join(", #")} open; ${files.length} ported test file(s) saved — only this unit waits`));
		return { unitId: o.unitId, state: o.ledger.getUnit(o.unitId)!.state, attempts: 0, costUsd: cost };
	}
	if (o.truthOnly) {
		if (!(await coverTruth())) return { unitId: o.unitId, state: o.ledger.getUnit(o.unitId)!.state, attempts: 0, costUsd: cost };
		const files = savePorted();
		log(pc.dim(`  truth ahead: ${files.length} ported test file(s) saved; implementing starts once the deps are accepted`));
		return { unitId: o.unitId, state: o.ledger.getUnit(o.unitId)!.state, attempts: 0, costUsd: cost };
	}
	if (hasTruth && existsSync(portedDir)) {
		// truth was captured ahead: put its ported tests into this worktree (never over newer files)
		const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
		for (const abs of walk(portedDir)) {
			const dest = join(targetProjectDir, relative(portedDir, abs));
			if (existsSync(dest)) continue;
			mkdirSync(dirname(dest), { recursive: true });
			copyFileSync(abs, dest);
		}
		if (ahead) log(pc.dim("  using truth captured ahead (tester skipped)"));
	}
	if (!(await coverTruth())) return { unitId: o.unitId, state: o.ledger.getUnit(o.unitId)!.state, attempts: 0, costUsd: cost };

	const loadTests = () => findTests(targetProjectDir, moduleDir, adapter.layout).map((p) => ({ path: p, sha1: sha1(readFileSync(join(targetProjectDir, p))) }));
	// answered quirks the tests do not follow yet: the tester rewrites them first
	const quirkNote = quirkRetestNote({ ledger: o.ledger, root: o.root }, o.unitId);
	if (quirkNote) {
		log(pc.dim("  quirk answers differ from the ported tests: retest"));
		await runTruth(quirkNote);
	}
	let testFiles = loadTests();
	if (!testFiles.length) log(pc.yellow("  no ported test files found — the gate cannot prove behaviour"));
	// the implementer may not edit tests: tests that fail the stack's lint/format check would fail every attempt,
	// so the tester fixes them now (once). Only with the real gate (simulations fake it).
	if (testFiles.length && !o.gate) {
		const c = adapter.lint(targetProjectDir, testFiles.map((t) => t.path));
		const lintErr = await new Promise<string | undefined>((res) =>
			execFile(c.cmd, c.args, { cwd: targetProjectDir, env: { ...process.env, CI: "1", FORCE_COLOR: "0" }, maxBuffer: 20 * 1024 * 1024, timeout: 5 * 60_000 }, (e, out, err) => res(e ? `${String(err)}\n${String(out)}`.trim().slice(-2500) : undefined)),
		);
		if (lintErr) {
			log(pc.dim("  ported tests fail the lint check: the tester fixes them before implementing"));
			if (await runTruth(`The ported tests fail the stack's lint/format check (${[c.cmd, ...c.args].join(" ")}). The implementer may not edit tests, so fix them now: formatting and lint only, in the TEST files (the linter's fix mode is fine), behaviour unchanged.\n${lintErr}`)) testFiles = loadTests();
		}
	}
	const loadIface = () => (existsSync(join(truthDirAbs, "interface.md")) ? readFileSync(join(truthDirAbs, "interface.md"), "utf8") : "(tester did not write interface.md)");

	// ---- implement → gate → triage loop ----------------------------------------------------------
	if (o.ledger.getUnit(o.unitId)!.state === "truth") o.ledger.transitionUnit(o.unitId, "implementing", "truth ready");
	const maxImpl = o.config.run.maxImplementAttempts;
	const maxTotal = maxImpl + o.config.run.maxEscalateAttempts;
	let gate: GateReport | undefined;
	let previousGate: GateReport | undefined;
	let triage: Triage | undefined;
	let attemptNo = 0;
	// Jev routing (br label): a unit rated hard with confidence starts on the escalate model
	const route = (JSON.parse(o.ledger.getUnit(o.unitId)!.meta) as { route?: { difficulty?: string; difficultyConfidence?: number } }).route;
	let doctorActions = 0;
	const diagnosed = new Set<string>();
	let forceEscalate = route?.difficulty === "hard" && (route.difficultyConfidence ?? 0) >= 0.75;
	if (forceEscalate) log(pc.dim(`  routed to ${o.config.models.escalate.id}: Jev rates this unit hard (${Math.round((route!.difficultyConfidence ?? 0) * 100)}%)`));
	let lastGateText = "";
	// what other models said about the TESTS during an attempt: the implementer disputes one, the reviewer finds some weak
	let disputes: Array<{ test: string; why: string; evidence: string }> = [];
	let reviewWeak: string | undefined;
	let testRounds = 0;
	const reports: Array<{ owner: string; target: string; problem: string; evidence: string }> = [];
	while (attemptNo < maxTotal) {
		attemptNo++;
		// the tests as they are on disk now: the tester (it has a shell) may have renamed or removed one since they
		// were listed; the implementer cannot write tests, so the gate still catches any change during this attempt
		testFiles = loadTests();
		const role = forceEscalate || attemptNo > maxImpl ? "escalate" : "implement";
		const modelRole = o.config.models[role];
		const attempt = o.ledger.startAttempt(o.unitId, role, modelRole.id);
		const t0 = Date.now();
		const impl = await spawn({
			role,
			cwd: targetProjectDir,
			config: o.config,
			writeGlobs,
			appendOnlyGlobs,
			protectedGlobs: adapter.protectedGlobs,
			systemPrompt: implementerSystemPrompt(o.config, { ...placeOpts, sharedDirs: adapter.layout.sharedDirs, rules, attempt: attemptNo, quirks: quirkSummary({ ledger: o.ledger }, o.unitId) || undefined, writeGlobs, source: sourceAdapter, target: adapter }),
			customTools: implementerTools({ ...deps, attemptId: attempt, onDispute: (d) => disputes.push(d), onReport: (r) => reports.push(r) }),
			transcriptPath: transcriptPath(o.root, o.unitId, role, attempt),
			validateWrite: async (path, content) => {
				const lang = adapter.layout.lang(path);
				if (!lang) return undefined;
				const errs = await syntaxErrors(lang, content);
				return errs.length ? `syntax error at line ${errs[0]!.line}: ${errs[0]!.text}` : undefined;
			},
			onToolCall: (e) => e.blocked && log(pc.dim(`  implementer blocked: ${e.blocked}`)),
		});
		const prompt = [
			renderTaskCard(card, o.config),
			"",
			"## Target interface drafted by the tester (satisfy it)",
			loadIface(),
			"",
			`## Ported tests (read-only): ${testFiles.map((t) => t.path).join(", ") || "none"}`,
			...testFiles.filter((t) => existsSync(join(targetProjectDir, t.path))).map((t) => `### ${t.path}\n\`\`\`${adapter.layout.lang(t.path) ?? ""}\n${readFileSync(join(targetProjectDir, t.path), "utf8")}\n\`\`\``),
			lastGateText ? `\n## Previous attempt failed the gate\n${lastGateText}` : "",
			o.retryNote && attemptNo === 1 ? `\n## Note from the orchestrator\n${o.retryNote}` : "",
			tidyMoved.length ? `\n## Tidy moves already done by the orchestrator\n${tidyMoved.join("\n")}\nUpdate every import of the moved files; keep behaviour identical.` : "",
		].join("\n");
		let res;
		try {
			res = await impl.run(prompt);
		} finally {
			impl.dispose();
		}
		cost += res.usage.cost;
		log(pc.dim(`  ${role} #${attemptNo}: ${res.toolCalls} tool calls, ${res.blocked} blocked, ${Math.round((Date.now() - t0) / 1000)}s, $${res.usage.cost.toFixed(4)} — ${res.text.split("\n").at(-1)}${res.error ? pc.red(` ERROR: ${res.error}`) : ""}`));
		// the implementer found a bug in another unit's accepted code: that unit is re-opened with the report, this one
		// waits for it (the owner becomes a dependency) and continues from its worktree's tests afterwards
		if (reports.length) {
			const owners = [...new Set(reports.map((r) => r.owner))];
			for (const owner of owners) {
				const mine = reports.filter((r) => r.owner === owner);
				reopenUnit(o.ledger, owner, `Unit ${o.unitId} uses your accepted code and found a problem in it. Your code stays on the branch; fix this in it, keep what works:\n${mine.map((r) => `- ${r.target}: ${r.problem}\n  evidence: ${r.evidence}`).join("\n")}`, `bug reported by ${o.unitId}: ${mine[0]!.problem}`);
				const meta = JSON.parse(o.ledger.getUnit(owner)!.meta) as { reportReopens?: number };
				o.ledger.updateUnit(owner, { meta: { reportReopens: (meta.reportReopens ?? 0) + 1 } });
				o.ledger.addEvidence(owner, "bug_reported", { by: o.unitId, reports: mine });
			}
			const unitDeps = JSON.parse(o.ledger.getUnit(o.unitId)!.deps) as string[];
			o.ledger.db.prepare("UPDATE units SET deps = ? WHERE id = ?").run(JSON.stringify([...new Set([...unitDeps, ...owners])]), o.unitId);
			o.ledger.endAttempt(attempt, { outcome: "waits_on_fix", costUsd: res.usage.cost, tokensIn: res.usage.input, tokensOut: res.usage.output, gateReport: { reports } });
			savePorted();
			o.ledger.updateUnit(o.unitId, { meta: { retryNote: `This unit waited for ${owners.join(", ")} to fix what it reported (${reports.map((r) => r.target).join(", ")}). That code is fixed now: use it.` } });
			o.ledger.transitionUnit(o.unitId, "planned", `waits for ${owners.join(", ")} to fix a reported bug`);
			log(pc.yellow(`  reported a bug in ${owners.join(", ")}: re-opened; this unit waits for the fix`));
			return { unitId: o.unitId, state: "planned", attempts: attemptNo, costUsd: cost };
		}
		if (res.error && res.toolCalls === 0) {
			// The session never ran (provider error even after tier fallback). Not the code's fault: no attempt burned.
			o.ledger.endAttempt(attempt, { outcome: "session_error", costUsd: res.usage.cost, gateReport: { error: res.error } });
			attemptNo--;
			if (++providerErrors >= 3) {
				const q = await ask({
					point: "env",
					facts: `Model sessions for ${o.unitId} failed ${providerErrors} times in a row before doing any work (provider error after tier fallback, model ${modelRole.id}): ${res.error}`,
					options: [
						{ value: "retry", facts: "the provider works again: run the unit again" },
						{ value: "wait", facts: "keep the unit waiting; the rest of the run goes on" },
					],
				});
				log(pc.red(`  provider failing repeatedly; asked question #${q} (only this unit waits)`));
				break;
			}
			continue;
		}

		// merged tidy sources go once every target exists (a missed move breaks the build, the gate says so)
		for (const f of tidyLeftovers(targetProjectDir, tidy, tidyMoved)) rmSync(join(targetProjectDir, f));
		if (o.ledger.getUnit(o.unitId)!.state === "implementing") o.ledger.transitionUnit(o.unitId, "gating", `attempt ${attemptNo}`);
		const reviewer = o.reviewer === false ? undefined : (o.reviewer ?? (o.spawn ? undefined : reviewWithModel));
		const review = reviewer
			? async (changedFiles: string[], nearDuplicates?: string[]) => {
					const ra = o.ledger.startAttempt(o.unitId, "review", o.config.models.escalate.id);
					const r = await reviewer({ ledger: o.ledger, config: o.config, root: o.root, unitId: o.unitId, adapter, targetProjectDir, moduleDir, legacyFiles: card.files, changedFiles, nearDuplicates, testFiles: testFiles.map((t) => t.path), transcriptPath: transcriptPath(o.root, o.unitId, "review", ra) });
					cost += r.costUsd ?? 0;
					reviewWeak = r.weakTests;
					o.ledger.endAttempt(ra, { outcome: !r.judged ? "not_judged" : r.ok ? "review_ok" : "review_red", costUsd: r.costUsd ?? 0, gateReport: { output: r.output } });
					return r;
				}
			: undefined;
		// the gate takes a CPU slot only for its commands: the review (a model session) never holds one
		gate = await gateFn({ ledger: o.ledger, unitId: o.unitId, adapter, targetProjectDir, writeGlobs, appendOnlyGlobs, testFiles, moduleDir, area, root: o.root, stackId, sanctioned: tidyPaths, legacyWords: legacyWordsFor(sourceAdapter.legacyWords, adapter), review, slot: gateSlot });
		o.ledger.endAttempt(attempt, { outcome: gate.ok ? "gate_green" : `gate_red:${gate.failedStep}`, costUsd: res.usage.cost, tokensIn: res.usage.input, tokensOut: res.usage.output, gateReport: gate });
		log(renderGate(gate));
		if (gate.ok) break;

		lastGateText = `failed step: ${gate.failedStep}\n${gate.steps.find((s) => !s.ok)?.output ?? ""}`;
		o.ledger.transitionUnit(o.unitId, "implementing", `gate failed: ${gate.failedStep}`);

		// another model says the TESTS are wrong: the tester re-checks them against the legacy code first, and its
		// answer goes into the implementer's next prompt (twice per unit; then triage decides as usual)
		const testsNote = [
			disputes.length && gate.failedStep === "ported_tests_green" ? `The implementer disputes these tests:\n${disputes.map((d) => `- ${d.test}: ${d.why}\n  evidence: ${d.evidence}`).join("\n")}` : "",
			reviewWeak ? `The reviewer finds these tests too weak (they do not really check the legacy behaviour):\n${reviewWeak}` : "",
		].filter(Boolean).join("\n\n");
		disputes = [];
		reviewWeak = undefined;
		if (testsNote && testRounds < 2) {
			testRounds++;
			o.ledger.addEvidence(o.unitId, "test_disputed", { note: testsNote.slice(0, 2000) });
			log(pc.yellow(`  the tests are questioned by another model: the tester re-checks them against the legacy code`));
			if (await runTruth(`${testsNote}\n\nRe-check each against the legacy code (source_symbol_body, read_function, run it on the old code). Where the other model is right, fix the test and its truth case; where it is wrong, keep the test. End with one line per test: "<test>: fixed — …" or "<test>: kept — <why>". The implementer reads your answer.`)) testFiles = loadTests();
			lastGateText += `\n\n## The tester re-checked the questioned tests\n${lastTesterText.slice(-2000)}`;
			previousGate = gate;
			continue;
		}

		// the same error is already asked about for another unit: wait on that question (no triage, no doctor, no new question)
		const signature = errorSignature(gate.failedStep ?? "", gate.steps.find((s) => !s.ok)?.output ?? "");
		const same = await sameQuestion(askDeps, ["gate_env", "triage_gate"], signature, `Gate step ${gate.failedStep} failed:\n${gate.steps.find((s) => !s.ok)?.output ?? ""}`, o.unitId);
		cost += same.costUsd;
		const sharedQ = same.id;
		if (sharedQ !== undefined) {
			o.ledger.addWaiter(sharedQ, o.unitId);
			o.ledger.updateUnit(o.unitId, { meta: { parked: { question: sharedQ, env: envFingerprint(o.config, projectDir(o.config, stackId), adapter.toolchain.manifestFiles, setupFiles(o.root, stackId)) } } });
			log(pc.yellow(`  same failure as question #${sharedQ} (another unit${same.by === "model" ? "; same cause, says the decision model" : ""}): waits on that answer — other units keep running`));
			return { unitId: o.unitId, state: o.ledger.getUnit(o.unitId)!.state, attempts: attemptNo, gate, costUsd: cost };
		}

		// Jev picks the next step; code enforces caps and acts.
		if (o.client) {
			triage = await triageGate({ ledger: o.ledger, config: o.config, client: o.client, root: o.root }, o.unitId, gate, previousGate, attemptNo);
			log(pc.dim(`  triage: ${triage.cause} → ${triage.action} (${triage.reason}; conf ${triage.confidence.toFixed(2)} ${triage.band})`));
			if (triage.action === "quarantine") break;
			// the same step failed again: another blind attempt rarely helps — find out why first (once per step)
			const stuck = triage.action !== "ask_human" && previousGate?.failedStep === gate.failedStep && !diagnosed.has(gate.failedStep ?? "");
			if (stuck) diagnosed.add(gate.failedStep ?? "");
			if (triage.action === "ask_human" || stuck) {
				// Before bothering a human: find out why. Certain/plausible code- or test-side causes are retried
				// automatically (capped); setup gaps become one exact command the human is told about.
				const failedOut = gate.steps.find((x) => !x.ok)?.output ?? "";
				const dx = await diagnoseFailure({ config: o.config, adapter, projectDir: targetProjectDir, failedStep: gate.failedStep ?? "", output: failedOut, client: o.client });
				log(pc.dim(`  doctor (${dx.by}): ${dx.action} — ${dx.summary}`));
				let qid = triage.questionId;
				// a question shared with other units is theirs too: only the unit's own question is answered or withdrawn here
				const ownQ = (id: number | undefined) => id !== undefined && o.ledger.getQuestion(id)?.unit_id === o.unitId;
				if ((dx.action === "retest" || dx.action === "reimplement") && doctorActions < 2) {
					doctorActions++;
					if (ownQ(qid)) o.ledger.answerQuestion(qid!, `auto: ${dx.action} (${dx.summary})`, "doctor");
					if (dx.action === "retest") {
						const ok = await runTruth(`The gate failed with ${gate.failedStep}: ${dx.summary}. ${dx.note ?? ""} Fix the TESTS, not production code.\n${lastGateText}`);
						if (ok) testFiles = loadTests();
					} else lastGateText += `\n\nDiagnosis: ${dx.summary}. ${dx.note ?? ""}`;
					previousGate = gate;
					continue;
				}
				// a setup problem of the new project: the setup model fixes it first; the owner only when it cannot
				let setupTried = "";
				const setupFixer = o.setupFixer === false ? undefined : (o.setupFixer ?? (o.spawn ? undefined : fixSetupWithModel));
				if (setupFixer && (dx.action === "fix" || triage.cause === "env")) {
					const fixed = await fixRunSetup({ config: o.config, root: o.root, adapter, projectDir: projectDir(o.config, stackId), fixer: setupFixer, ledger: o.ledger, lock: o.mergeLock, signature: errorSignature(gate.failedStep ?? "", failedOut), problem: `Gate step ${gate.failedStep} failed for unit ${o.unitId} (code in ${moduleDir}/). Diagnosis: ${dx.summary}${dx.command ? ` (suggested: ${dx.command})` : ""}. Fix the project setup, not the unit's code.\nThe unit works in its own git worktree (${targetProjectDir}); these dependency dirs are linked into it from the main project: ${adapter.toolchain.worktreeLinks.join(", ") || "none"}. Tools that resolve real paths (autoloaders, module resolution) then see the main project's code, not the worktree's: set_worktree_copy gives every later worktree a copy instead.\nGate output tail:\n${failedOut.slice(-3000)}` }).catch((e) => (log(pc.yellow(`  setup fix failed: ${e?.message ?? e}`)), undefined));
					if (fixed) {
						// the fix serves every unit that waits on this problem
						if (qid) o.ledger.answerQuestion(qid, `auto: the setup model fixed it (${fixed})`, "setup model");
						// parked without a question: the scheduler resubmits it on the fixed main (fresh worktree)
						o.ledger.updateUnit(o.unitId, { meta: { parked: { diagnosis: { summary: `the project setup was fixed (${fixed})`, note: dx.summary } } } });
						log(pc.cyan(`  setup fixed by the model: ${fixed} — the unit runs again`));
						return { unitId: o.unitId, state: o.ledger.getUnit(o.unitId)!.state, attempts: attemptNo, gate, triage, costUsd: cost };
					}
					setupTried = " The setup model tried and could not fix it.";
				}
				if (!qid && triage.action !== "ask_human") {
					// stuck, but nothing to heal here and nobody to ask: go on as triage said (the attempt cap still holds)
					lastGateText += `\n\nDiagnosis: ${dx.summary}. ${dx.note ?? ""}`;
					if (triage.action === "escalate") forceEscalate = true;
					previousGate = gate;
					continue;
				}
				if (qid) {
					// the doctor knows more than triage did: the question is asked again with the diagnosis (phrased by a model)
					if (ownQ(qid)) o.ledger.withdrawQuestion(qid, `diagnosed: ${dx.summary}`);
					qid = await ask({
						point: "gate_env",
						sameAs: signature,
						facts: `Gate step ${gate.failedStep} of ${o.unitId} failed on attempt ${attemptNo}. Diagnosis (${dx.by}): ${dx.summary}.${setupTried}${dx.command ? ` Fix command: \`${dx.command}\` in ${targetRel || "."}.` : ""} The unit resubmits itself when the target project or the config changes.\nGate output tail:\n${failedOut.slice(-1200)}`,
						options: [
							{ value: "fixed", facts: dx.command ? `ran ${dx.command}; the unit runs again` : "the environment is fixed; the unit runs again" },
							{ value: "quarantine", facts: "leave the unit quarantined for a human" },
						],
						context: { diagnosis: dx, failedStep: gate.failedStep },
					});
				}
				// remember the environment the failure happened in: a change (package.json/config) resubmits the unit
				o.ledger.updateUnit(o.unitId, { meta: { parked: { question: qid, env: envFingerprint(o.config, projectDir(o.config, stackId), adapter.toolchain.manifestFiles, setupFiles(o.root, stackId)), diagnosis: dx } } });
				log(pc.yellow(`  waiting for human question #${qid} — other units keep running`));
				return { unitId: o.unitId, state: o.ledger.getUnit(o.unitId)!.state, attempts: attemptNo, gate, triage, costUsd: cost };
			}
			if (triage.action === "escalate") forceEscalate = true;
			if (triage.action === "retest") {
				const ok = await runTruth(`The gate failed with ${gate.failedStep}; Jev judged the cause as ${triage.cause}. Re-check interface.md and the ported tests against the legacy behaviour and the implementation at ${targetRel}/${moduleDir}/; fix the TESTS/INTERFACE, not production code.\n${lastGateText}`);
				if (ok) testFiles = loadTests();
			}
		}
		previousGate = gate;
	}

	if (gate?.ok) {
		// The new code is now part of what later units can reuse: index it (exports, helpers, docs).
		const indexed = await indexTarget(o.ledger, adapter, targetProjectDir, gate.changedFiles).catch((e) => (log(pc.yellow(`  target index failed: ${e?.message ?? e}`)), 0));
		log(pc.dim(`  indexed ${indexed} target symbols`));
		// reusable logic becomes findable by meaning (capability cards; no-op without a client)
		const caps = await describeCapabilities(askDeps, { unitId: o.unitId, stack: stackId, area, files: gate.changedFiles, projectDir: targetProjectDir }).catch((e) => (log(pc.yellow(`  capability cards failed: ${e?.message ?? e}`)), { cards: 0, costUsd: 0 }));
		cost += caps.costUsd;
		if (caps.cards) log(pc.dim(`  ${caps.cards} capability card(s)`));
		o.ledger.transitionUnit(o.unitId, "review", "gate green");
		if (o.accept) {
			acceptUnit(o, targetProjectDir, area);
			afterAccept(o.ledger, adapter, targetProjectDir, stackId, area, log);
		}
	} else if (attemptNo >= maxTotal || triage?.action === "quarantine") {
		o.ledger.transitionUnit(o.unitId, "quarantined", `gate still red after ${attemptNo} attempts (${gate?.failedStep}); ${triage?.reason ?? ""}`.trim());
	}
	const final = o.ledger.getUnit(o.unitId)!;
	return { unitId: o.unitId, state: final.state, attempts: attemptNo, gate, triage, costUsd: cost };
}

export function acceptUnit(o: { ledger: Ledger; config: Config; unitId: string }, targetProjectDir: string, area: string): string | undefined {
	const sha = commitAll(o.config.target.path, `feat(${area}): migrate ${o.unitId}\n\n${o.ledger.symbolsOfUnit(o.unitId).map((s) => `- ${s.id} → ${s.state}`).join("\n")}\n\nbigrefactor: unit ${o.unitId}, target ${relative(o.config.target.path, targetProjectDir) || "."}`);
	o.ledger.transitionUnit(o.unitId, "accepted", sha ? `committed ${sha.slice(0, 7)}` : "accepted (nothing new to commit)");
	if (sha) o.ledger.updateUnit(o.unitId, { branch: mainBranch(o.config.target.path, o.config.target.git.branch), meta: { ...JSON.parse(o.ledger.getUnit(o.unitId)!.meta), commit: sha } });
	return sha;
}

/** After a unit landed in `projectDir`: close tidy tasks the tree shows done, record the stack's drift report. */
export function afterAccept(ledger: Ledger, adapter: TargetAdapter, projectDirAbs: string, stackId: string, area: string, log: (l: string) => void): void {
	const done = completeTidyTasks(ledger, projectDirAbs, stackId, area);
	if (done.length) log(pc.dim(`  tidy done: ${done.join(", ")}`));
	const drift = recordDrift(ledger, adapter, projectDirAbs);
	if (drift.length) log(pc.dim(`  drift ${stackId}: ${drift.length} finding(s) (br layout)`));
}

/** 1:1 moves/renames of approved tidy tasks, done by code before the sessions (source present, target free). */
export function tidyMoves(dir: string, tasks: TidyTask[], isTest: (p: string) => boolean): string[] {
	const out: string[] = [];
	for (const t of tasks) {
		if ((t.op !== "move" && t.op !== "rename") || t.from.length !== t.to.length) continue;
		t.from.forEach((f, i) => {
			const to = t.to[i]!;
			if (f === to || isTest(f) || !existsSync(join(dir, f)) || existsSync(join(dir, to))) return;
			mkdirSync(dirname(join(dir, to)), { recursive: true });
			renameSync(join(dir, f), join(dir, to));
			out.push(`${f} → ${to}`);
		});
	}
	return out;
}

/** Sources of approved merges (and n:m moves) still present although every target exists. */
export function tidyLeftovers(dir: string, tasks: TidyTask[], moved: string[]): string[] {
	return tasks
		.filter((t) => t.op !== "split" && t.to.every((f) => existsSync(join(dir, f))) && !t.from.every((f) => moved.some((m) => m.startsWith(`${f} → `))))
		.flatMap((t) => t.from.filter((f) => !t.to.includes(f) && existsSync(join(dir, f))));
}

/** The workspace files a setup fix changes: the stack's command overrides and its fixes log. */
export function setupFiles(root: string, stackId: string): string[] {
	return [overridesPath(root, stackId), setupLogPath(root, stackId)];
}

/** What a parked environment failure depends on: the target's dependency manifests (adapter-declared), the workspace config and the setup fixes made since. */
export function envFingerprint(config: Config, projectDir: string, manifestFiles: string[], setup: string[] = []): string {
	const read = (p: string) => {
		try {
			return readFileSync(p, "utf8");
		} catch {
			return "";
		}
	};
	const h = createHash("sha1");
	for (const f of manifestFiles) h.update(read(join(projectDir, f)));
	for (const f of setup) h.update(read(f));
	return h.update(JSON.stringify(config.target.choices)).update(JSON.stringify(config.target.stacks)).digest("hex").slice(0, 12);
}


/** The error of a tester attempt's report (stored as {mode, cases, error}), or the text as it is. */
function truthError(report: string): string {
	try {
		return String(JSON.parse(report).error ?? report);
	} catch {
		return report;
	}
}

function transcriptPath(root: string, unitId: string, role: string, attemptId: number): string {
	const dir = join(root, ".bigrefactor", "sessions");
	mkdirSync(dir, { recursive: true });
	return join(dir, `${unitId}.${role}.${attemptId}.jsonl`);
}

/**
 * Paths drafted in interface.md that are neither inside the allowed dirs nor existing files (an existing file is
 * something to import or a legacy/workspace reference, not something to create). Paths may carry any prefix
 * before the project-relative part (workspace, worktree).
 */
export function draftedOutside(md: string, allowedDirs: string[], targetRel: string, existingRoots: string[]): string[] {
	const out = new Set<string>();
	for (const m of md.matchAll(/(?:^|[\s`'"(\[])((?:\.\/)?(?:[\w@.-]+\/)+[\w.-]+\.[A-Za-z]{1,5})(?=$|[\s`'"),:\]#])/gm)) {
		let p = m[1]!.replace(/^\.\//, "");
		if (targetRel && p.startsWith(`${targetRel}/`)) p = p.slice(targetRel.length + 1);
		if (p.startsWith("..") || allowedDirs.some((d) => p.startsWith(d) || p.includes(`/${d}`)) || existingRoots.some((r) => existsSync(join(r, p)) || existsSync(join(r, m[1]!)))) continue;
		out.add(p);
	}
	return [...out];
}


/** A test text names truth case `id` (u1#3, not u1#30). */
export function mentionsCase(text: string, id: string): boolean {
	return new RegExp(`${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\d)`).test(text);
}

/** The unit's test files: wherever the stack keeps an area's tests (its testFileGlobs), not only inside the module. */
function findTests(targetProjectDir: string, rel: string, layout: TargetAdapter["layout"]): string[] {
	const globs = layout.testFileGlobs(rel);
	const res = globs.map(globToRegExp);
	const out = new Set<string>();
	const visit = (d: string) => {
		for (const n of readdirSync(d)) {
			const p = join(d, n);
			const r = relative(targetProjectDir, p);
			if (statSync(p).isDirectory()) visit(p);
			else if (layout.isTestFile(n) && res.some((re) => re.test(r))) out.add(r);
		}
	};
	// walk only the fixed part of each glob (src/Billing/tests/**/*Test.php → src/Billing/tests)
	for (const g of globs) {
		const base = g.split("/").filter((_, i, a) => !a.slice(0, i + 1).some((s) => /[*?{[]/.test(s))).join("/");
		if (existsSync(join(targetProjectDir, base))) visit(join(targetProjectDir, base));
	}
	return [...out].sort();
}

/** The old code's file kinds a new name must not carry, minus the new stack's own file types (php in a PHP → Symfony migration). */
export function legacyWordsFor(words: string[] | undefined, target: TargetAdapter): string[] | undefined {
	const own = new Set(target.layout.sourceExtensions.map((e) => e.replace(/^\./, "").toLowerCase()));
	return words?.filter((w) => !own.has(w));
}
