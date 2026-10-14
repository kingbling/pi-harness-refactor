import { createHash } from "node:crypto";
import { diagnoseFailure } from "./doctor.ts";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import pc from "picocolors";
import { keepOverrides, linkedDirs, overridesPath, setupLogPath } from "../adapters/command-overrides.ts";
import { getSourceAdapter, getTargetAdapter } from "../adapters/registry.ts";
// static on purpose: Pi loads plugins without a module cache, and units starting together that each import a
// module the first time get half-loaded copies of what it imports ("Cannot read properties of undefined")
import { runDbUnit } from "./db-unit.ts";
import type { SourceAdapter, TargetAdapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import { commitAll, mainBranch } from "../git.ts";
import { projectDir } from "../init/init.ts";
import { addedSyntaxErrors } from "../inventory/treesitter.ts";
import { describeCapabilities } from "../inventory/capabilities.ts";
import { indexTarget } from "../inventory/target.ts";
import { askViaModel } from "../jev/ask.ts";
import { sameQuestion } from "../jev/same.ts";
import type { Ledger } from "../ledger/db.ts";
import type { ModelClient } from "../models/types.ts";
import { spawnLeaf, type LeafSession } from "../sessions/spawn.ts";
import { buildTaskCard, renderTaskCard } from "../sessions/taskcard.ts";
import { implementerTools, portedLayout, testerTools, type ToolDeps } from "../sessions/tools.ts";
import { changedFiles, errorSignature, noBehaviour, othersTestsChanged, renderGate, reusableCheck, runGate, sha1, trackedFiles, type GateReport } from "./gate.ts";
export { errorSignature };
import { recordDrift } from "./layout-check.ts";
import { isWiringFile } from "../rules/layout-rules.ts";
import { placementDir, placeUnit, unplacedReason } from "./placement.ts";
import { isDbUnitKind } from "../inventory/db.ts";
import { reviewWithModel, type Reviewer } from "./review.ts";
import { reopenUnit } from "./recheck.ts";
import { implementerSystemPrompt, rulesText, testerSystemPrompt } from "./prompts.ts";
import { askPendingQuirks, markQuirksApplied, quirkList, quirkRetestNote, quirkSummary } from "./quirks.ts";
import { completeTidyTasks, tidyTasks } from "./tidy.ts";
import { sameFinding, samePath, triageGate, type LastRetest, type Triage } from "./triage.ts";
import { fixRunSetup, fixSetupWithModel, type SetupFixer } from "../init/setup-fixer.ts";
import { caseIds, describeTruthRun, fixLegacyEnv, fixLegacyEnvWithModel, legacyDeclaredTool, legacyEnvOutage, loadLegacyEnv, loadReadTruth, NO_BEHAVIOUR_FILE, noBehaviourReason, READ_CASES_FILE, truthBrokenKey, verifyTruthOnOld, type LegacyFixer, type TruthCase, type TruthMode } from "./legacy-env.ts";
import { filesNamed } from "./builder.ts";
import { setStep } from "./watchdog.ts";
import { catchUpWithMain, caseCoverage, checkTests, findTests, onlyOwnTests, ownTests, scopeGuard, testsPass } from "./ported.ts";
import { exec } from "../proc.ts";
export { mentionsCase } from "./ported.ts";

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
	/** The last pass was not merged for errors in the unit's own test files: the tester fixes them first (tests only). */
	testsNote?: string;
	/** The last pass was not merged for whole-project errors: check_my_code and check_ported_tests run that check (only errors main does not have). */
	wholeCheck?: () => Promise<string | undefined>;
	/** Injection points for simulation level 1 (scripted sessions, scripted build/test outcomes). */
	spawn?: typeof spawnLeaf;
	gate?: typeof runGate;
	/** Fixes setup problems of the new project during the run; default: the setup model (none when `spawn` is faked). */
	setupFixer?: SetupFixer | false;
	/** Sets up the old code's environment when truth stays red; default: the setup model (none when `spawn` is faked). */
	legacyFixer?: LegacyFixer | false;
	/** Judges wired_ok (real, connected, on the chosen stack); default: the reviewer model (none when `spawn` is faked). */
	reviewer?: Reviewer | false;
	/**
	 * Kept by the scheduler across merge rounds: the last approved review (set here) and the files that clashed with
	 * main since (repo-relative). A later round reuses that approval when only those files and wiring files changed.
	 */
	approved?: { review?: ApprovedReview; clash: string[] };
	/**
	 * The run is stopping: the unit gives its lane back at the next safe point (before an implement try, a review or a
	 * tester round) instead of using all its tries. It goes back to planned; the scheduler keeps its code (keepUnitWork).
	 */
	stopped?: () => boolean;
	/** When this run of the orchestrator started (ISO): report_migrated_bug counts this unit's reports since then. */
	runStartedAt?: string;
}

/** What an approved review saw: each changed file's hash, and the tests with the tester's answers as one hash. */
export interface ApprovedReview {
	files: Record<string, string>;
	tests: string;
	r: Awaited<ReturnType<Reviewer>>;
}

/** An approval still holds when the tests are the same and every file that changed since may change (clash, wiring). */
export function approvalStands(a: ApprovedReview, now: { files: Record<string, string>; tests: string }, mayChange: (f: string) => boolean): boolean {
	if (a.tests !== now.tests) return false;
	return [...new Set([...Object.keys(a.files), ...Object.keys(now.files)])].every((f) => a.files[f] === now.files[f] || mayChange(f));
}

export interface UnitRunResult {
	unitId: string;
	state: string;
	attempts: number;
	gate?: GateReport;
	triage?: Triage;
	costUsd: number;
	/** It went back to planned because the run is stopping: its code is to be kept for its next run. */
	stopped?: boolean;
}

/**
 * Ported tests that pass before any code for the unit exists do not call its code (an `expect(true)` with the case id
 * in its name): the tester gets one go at them (`retest`). Still green, the returned note goes to the reviewer; behaviour
 * an earlier unit of the area already wrote can make them legitimately green, so it never fails the unit by itself.
 */
export async function testsGreenBefore(o: { files: () => string[] | Promise<string[]>; pass: (files: string[]) => Promise<boolean>; retest: (why: string) => Promise<void> }): Promise<string | undefined> {
	const why = async () => `These ported test files pass before any code for this unit exists, so they do not call the code in interface.md: ${(await o.files()).join(", ")}.`;
	if (!(await o.pass(await o.files()))) return undefined;
	await o.retest(`${await why()} Make each test call the code in interface.md and assert the case's expected value, so it fails until that code exists.`);
	if (!(await o.pass(await o.files()))) return undefined;
	return `${await why()} The tester was asked once to fix them and they still pass: check in weakTests that each one really calls this unit's code.`;
}

/** One check_my_code result (see ToolDeps.onCheck). */
type CheckResult = Parameters<NonNullable<ToolDeps["onCheck"]>>[0];

/** Review rounds per run that give their try back because fewer findings are open than at the review before. */
export const MAX_PROGRESS_ROUNDS = 5;
/** Tests-only retests for build/lint errors only in the unit's own test files: each gives its try back. */
export const MAX_TESTS_ONLY_ROUNDS = 2;

/** Why read truth was written while the legacy env mode was "read" (the old code could not run anywhere here). */
const NOT_RUN_HERE = "the old code does not run here";

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
	// main's checkout: an area test of another unit that fails in the worktree counts against this unit only if it passes there
	const mainDir = o.workDir ? projectDir(o.config, stackId) : undefined;
	if (!adapter.toolchain.isProjectReady(targetProjectDir)) throw new Error(`target project missing at ${targetProjectDir}; run br setup`);
	const sourceAdapter = getSourceAdapter(o.config.source.stack);
	// one legacy area = one feature module (or, for code ≥ 2 areas use, the shared dir + area)
	const moduleDir = placementDir(adapter.layout, place);
	// approved tidy tasks of the area: their files are in scope (existing shared ones too). The tidy job does the
	// work and the scheduler holds units back meanwhile; a unit sees one only when no tidy job runs (tests, simulation)
	const tidy = tidyTasks(o.ledger, stackId, area).filter((t) => t.status === "approved");
	const tidyPaths = [...new Set(tidy.flatMap((t) => [...t.from, ...t.to]))];
	// wiring files the stack names (route table, main module) when no code regenerates them: the unit registers itself
	const wiring = adapter.generateRegistration ? [] : (adapter.layout.wiringFiles ?? []);
	const writeGlobs = [...new Set([`${moduleDir}/**`, ...tidyPaths, ...wiring])];
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
	// reviews in a row that could not judge (the reviewer's model is down): not the implementer's fault
	let reviewErrors = 0;
	const askDeps = { ledger: o.ledger, config: o.config, root: o.root, client: o.client };
	const ask = async (q: Pick<Parameters<typeof askViaModel>[1], "point" | "facts" | "options" | "context" | "sameAs">): Promise<number> => {
		const r = await askViaModel(askDeps, { unitId: o.unitId, askedBy: "orchestrator", blocks: "unit", ...q });
		cost += r.costUsd;
		return r.id;
	};

	const deps = { ledger: o.ledger, config: o.config, unitId: o.unitId, root: o.root, targetProjectDir, adapter, moduleDir, client: o.client, wholeCheck: o.wholeCheck, mainDir, runStartedAt: o.runStartedAt };
	const card = await buildTaskCard(o.ledger, o.config, o.unitId, { targetProjectDir, writeGlobs, adapter, place, moduleDir, root: o.root });
	if (card.unresolvedDeps.length) log(pc.yellow(`note: ${card.unresolvedDeps.length} dependencies not migrated yet: ${card.unresolvedDeps.join(", ")}`));
	// stubs earlier units left for this unit's code: it replaces them where they are (the card names them)
	for (const f of card.waitingStubs) if (!writeGlobs.includes(f)) writeGlobs.push(f);

	// ---- truth ----------------------------------------------------------------------------------
	// run: expected values come from running the old code; read: it cannot run here (decided once per workspace,
	// or for this unit after running failed), so the tester writes them from reading it — marked in the ledger
	let lastTesterText = "";
	// the writes the last tester session was refused (a quarantine's red attempt carries them)
	let lastTesterBlocked: string[] = [];
	// earlier units' tests the implementer disputed and the tester then fixed, or the tester disputed itself with
	// evidence: kept, and the gate allows them. Saved, so a restart that keeps the unit's work keeps them allowed too.
	const disputedKey = `tests_disputed:${o.unitId}`;
	const disputedOthers: string[] = (() => {
		try {
			return JSON.parse(o.ledger.getMeta(disputedKey) ?? "[]") as string[];
		} catch {
			return [];
		}
	})();
	const allowDisputed = (files: string[]) => {
		const add = files.filter((f) => !disputedOthers.includes(f));
		if (!add.length) return;
		disputedOthers.push(...add);
		o.ledger.setMeta(disputedKey, JSON.stringify(disputedOthers));
	};
	const envMode: TruthMode = loadLegacyEnv(o.root, o.config).mode ?? "run";
	let truthMode: TruthMode = envMode;
	// the tester runs in the workspace (truth dir + the target's test folders); it is told these exact globs, absolute
	const testerTestGlobs = adapter.layout.testFileGlobs(moduleDir).map((g) => `${targetRel}/${g}`);
	const testerWriteGlobs = [`${truthDirRel}/**`, ...testerTestGlobs];
	const absGlob = (g: string) => join(o.root, g);
	// the truth as code loads it now (the tester's check_ported_tests and the verification after its session)
	// in read mode a small per-unit script the tester got running still counts as run when it is green on the old code
	const currentTruth = async () => {
		if (truthMode === "run") return { ...(await verifyTruthOnOld(truthDirAbs, o.config, sourceAdapter, o.root, card.files)), madeBy: "run" as TruthMode };
		const ran = existsSync(join(truthDirAbs, sourceAdapter.truth.scriptName)) ? await verifyTruthOnOld(truthDirAbs, o.config, sourceAdapter, o.root, card.files) : undefined;
		// why the script did not run green is kept: it is what the old code's environment needs
		return ran?.ok ? { ...ran, madeBy: "run" as TruthMode } : { ...loadReadTruth(truthDirAbs), madeBy: "read" as TruthMode, runError: ran?.error };
	};
	// the gate's structure_ok on the tester's test files and the code paths they import (check_ported_tests): a test
	// whose own path or import the layout does not allow fails every implementer attempt
	const checkLayout = async (files: string[]) =>
		(await adapter.layout.checkStructure?.(files, moduleDir, area, targetProjectDir, { isNew: (f) => !existsSync(join(targetProjectDir, f)), sanctioned: [...tidyPaths, ...card.waitingStubs], legacyWords: legacyWordsFor(sourceAdapter.legacyWords, adapter) })) ?? [];
	const truthFiles = [sourceAdapter.truth.scriptName, READ_CASES_FILE, NO_BEHAVIOUR_FILE];
	const readTruthFiles = () => truthFiles.map((f) => (existsSync(join(truthDirAbs, f)) ? readFileSync(join(truthDirAbs, f), "utf8") : undefined));
	/**
	 * `testsOnly`: a retest for coverage, lint or placement. The truth cases stay as they are (no re-run, no
	 * re-numbering): the tester only adds or fixes tests (and interface.md); a changed truth file is put back.
	 * `codeWritten`: a retest from the implement loop (check_ported_tests runs the tests against the code).
	 * `disputeText`: the implementer's dispute; an earlier unit's test file it names may be fixed by the tester.
	 * `stronger`: the tester runs on the escalate model (the cheap one changed nothing in the last weak-tests round).
	 */
	const runTruth = async (extra?: string, testsOnly = false, more: { codeWritten?: boolean; disputeText?: string; stronger?: boolean } = {}): Promise<boolean> => {
		if (!o.truthOnly && o.ledger.getUnit(o.unitId)!.state === "planned") o.ledger.transitionUnit(o.unitId, "truth", "tester session started");
		setStep(`tester ${o.unitId}`);
		const testModel = more.stronger ? o.config.models.escalate : o.config.models.test;
		const attempt = o.ledger.startAttempt(o.unitId, "test", testModel.id);
		const t0 = Date.now();
		const before = testsOnly ? readTruthFiles() : undefined;
		// its test paths and the approved tidy paths; the plugin's own folder (ledger, truth) when it sits in the project is not the tester's write
		const ownDir = relative(targetProjectDir, join(o.root, ".bigrefactor"));
		const putBack = await scopeGuard(targetProjectDir, [...adapter.layout.testFileGlobs(moduleDir), ...tidyPaths], [...adapter.toolchain.ignoredPaths, ...(ownDir.startsWith("..") ? [] : [ownDir])]);
		const overrides = keepOverrides(o.root, stackId); // the gate's commands are the setup fixer's, never the tester's
		let overridesChanged = false;
		const disputed = (f: string) => !!more.disputeText && (more.disputeText.includes(f) || more.disputeText.includes(basename(f)));
		const sanctioned = [...tidyPaths, ...disputedOthers, ...(more.disputeText ? (await trackedFiles(targetProjectDir)).filter((f) => adapter.layout.isTestFile(f) && disputed(f)) : [])];
		lastTesterBlocked = [];
		// the tester called no_behaviour_to_pin (the decision model checked it against the legacy code)
		let declaredNone = false;
		// with the code in place: the tester's last check_ported_tests and its tests as they were then (see TESTER DONE below)
		const testsKey = () => sha1(JSON.stringify(findTests(targetProjectDir, moduleDir, adapter.layout).map((f) => [f, readFileSync(join(targetProjectDir, f), "utf8")])));
		let testerCheck: { c: CheckResult; key: string } | undefined;
		const tester = await spawn({
			role: "test",
			...(more.stronger ? { modelOverride: testModel } : {}),
			// the shell and relative paths start in the project (reviewer findings and test paths are project paths);
			// the write globs stay relative to the workspace, where the truth folder lives
			cwd: targetProjectDir,
			globRoot: o.root,
			config: o.config,
			writeGlobs: testerWriteGlobs,
			protectedGlobs: testsOnly ? truthFiles.map((f) => `${truthDirRel}/${f}`) : [],
			systemPrompt: testerSystemPrompt(o.config, { ...placeOpts, unitId: o.unitId, truthMode, tryScript: envMode === "read", truthRun: describeTruthRun(o.root, o.config, sourceAdapter, join(truthDirAbs, sourceAdapter.truth.scriptName)), truthDir: truthDirAbs, targetProjectDir, workDir: o.root, writeGlobs: testerWriteGlobs.map(absGlob), testWriteGlobs: testerTestGlobs.map(absGlob), rules, source: sourceAdapter, target: adapter, projectNotes: adapter.projectNotes?.(targetProjectDir) ?? [] }),
			customTools: [
				...testerTools({ ...deps, attemptId: attempt, truthDir: truthDirAbs, currentTruth, checkLayout, sanctioned, codeWritten: more.codeWritten, slot: gateSlot, onDispute: (dsp) => {
					// an earlier unit's test the tester had to change, with its evidence: kept instead of undone
					if (!sanctioned.includes(dsp.test)) sanctioned.push(dsp.test);
					allowDisputed([dsp.test]);
					log(pc.yellow(`  tester disputes an earlier unit's test, change kept: ${dsp.test}: ${dsp.why} (evidence: ${dsp.evidence})`));
				}, onCheck: more.codeWritten ? (c) => void (testerCheck = { c, key: testsKey() }) : undefined }),
				// what the old code's start-up already declares, so the truth script loads or stubs only what is missing
				...[legacyDeclaredTool(o.root, o.config, sourceAdapter, truthDirAbs)].filter((t) => t !== undefined),
			],
			transcriptPath: transcriptPath(o.root, o.unitId, "test", attempt),
			onToolCall: (e) => {
				if (e.toolName === "no_behaviour_to_pin" && !e.blocked) declaredNone = true;
				if (e.blocked) {
					lastTesterBlocked.push(e.blocked);
					log(pc.dim(`  tester blocked: ${e.blocked}`));
				}
			},
		});
		let res;
		try {
			// the orchestrator's note (owner hint, earlier diagnosis) reaches every tester run too, not only the implementer
			const note = o.retryNote ? `\n\n## Note from the orchestrator\n${o.retryNote}` : "";
			const quirks = quirkList({ ledger: o.ledger }, o.unitId);
			const keep = testsOnly ? `\nThe truth cases stay exactly as they are (${truthFiles.filter((_, i) => before![i] !== undefined).join(", ") || "recorded in the ledger"}; truth_lookup lists them): do not change them, only add or fix the tests (each recorded case gets its test, even one you would not pin now)${extra?.includes("interface.md") ? " and interface.md" : ""}.` : "";
			res = await tester.run(
				renderTaskCard({ ...card, writeGlobs: testerWriteGlobs.map(absGlob) }, o.config) +
					(quirks ? `\n\n## Quirks already recorded for this unit (do not record them again)\n${quirks}` : "") +
					(extra ? `\n\n## Re-port requested\n${extra}${keep}` : "") +
					note,
			);
			// TESTER DONE with the code in place, but its last check ran the tests red, tests changed after it, or it never
			// checked (and has tests): the implementer would get tests nobody ran against its code, so one more turn
			const last = testerCheck as { c: CheckResult; key: string } | undefined; // set by the tool during run()
			const why = !more.codeWritten || res.error ? "" : !last ? (findTests(targetProjectDir, moduleDir, adapter.layout).length ? "You did not run check_ported_tests" : "") : last.key !== testsKey() ? "You changed tests after your last check_ported_tests" : !last.c.ok && !last.c.timedOut ? "Your last check_ported_tests ran the tests red" : "";
			if (why) {
				log(pc.dim(`  tester said DONE (${why}): one more turn`));
				const again = await tester.run(`${why}. The implementer's code is in place: re-run check_ported_tests; fix each red test that is wrong (check it against the legacy code), or keep it and name the code bug it catches in your final line. Then end with your final lines as before.${last && !last.c.ok ? `\n\nThe red check:\n${last.c.text.slice(-5000)}` : ""}`);
				res = { ...again, toolCalls: res.toolCalls + again.toolCalls, blocked: res.blocked + again.blocked, usage: { input: res.usage.input + again.usage.input, output: res.usage.output + again.usage.output, cost: res.usage.cost + again.usage.cost } };
			}
		} finally {
			tester.dispose();
			overridesChanged = overrides.restore();
		}
		cost += res.usage.cost;
		lastTesterText = res.text;
		// tests of earlier units prove accepted behaviour: the tester may add to them, but a changed or removed line it
		// did not dispute with evidence is undone (and it is told)
		const changedOthers = await othersTestsChanged(targetProjectDir, o.unitId, (f) => adapter.layout.isTestFile(f), [...tidyPaths, ...disputedOthers]);
		// one the implementer disputed is kept: the tester re-checked it against the legacy code
		const kept = changedOthers.filter(disputed);
		if (kept.length) log(pc.yellow(`  tester fixed ${kept.length} disputed test(s) of earlier units; kept: ${kept.join(", ")}`));
		allowDisputed(kept);
		const others = changedOthers.filter((f) => !kept.includes(f));
		if (others.length) {
			await exec("git", ["checkout", "HEAD", "--", ...others], { cwd: targetProjectDir });
			log(pc.yellow(`  tester changed ${others.length} test(s) of earlier units; undone: ${others.slice(0, 5).join(", ")}`));
			res = { ...res, text: `${res.text}\n(Your changes to tests of earlier units were undone: ${others.join(", ")}. Adding new tests or fixtures to them is fine; to change or remove an existing line there, call dispute_test with the file and evidence from the legacy code first.)` };
			lastTesterText = res.text;
		}
		if (overridesChanged) {
			log(pc.yellow(`  tester changed the gate commands file; put back`));
			res = { ...res, text: `${res.text}\n(Your change to the gate commands file was put back: the gate's commands are not yours to change. A command that does not fit goes in your final answer.)` };
			lastTesterText = res.text;
		}
		// the tester writes tests only: anything else it changed (a formatter run over the project) is put back
		const outside = await putBack();
		if (outside.length) {
			log(pc.yellow(`  tester changed ${outside.length} file(s) outside its test paths; put back: ${outside.slice(0, 5).join(", ")}`));
			res = { ...res, text: `${res.text}\n(Your changes outside your test paths were put back: ${outside.join(", ")}. Run fix modes on your test files only.)` };
			lastTesterText = res.text;
		}
		log(pc.dim(`  tester: ${res.toolCalls} tool calls, ${res.blocked} blocked, ${Math.round((Date.now() - t0) / 1000)}s, $${res.usage.cost.toFixed(4)} — ${res.text.split("\n").at(-1)}${res.error ? pc.red(` ERROR: ${res.error}`) : ""}`));

		// tests only, but the tester declared a checked "no behaviour": that replaces the recorded cases (verified below
		// like any truth pass); putting it back would leave cases no test can pin and loop the unit through quarantine
		const noneNow = !!before && declaredNone && !!noBehaviourReason(truthDirAbs);
		if (noneNow) log(pc.yellow(`  tester declared no runtime behaviour in a tests-only retest; the truth is checked again`));
		if (before && !noneNow) {
			// tests only: the recorded truth stands; a truth file the tester changed anyway is put back
			const changed = readTruthFiles().flatMap((now, i) => (now === before[i] ? [] : [truthFiles[i]!]));
			for (const f of changed) {
				const i = truthFiles.indexOf(f);
				if (before[i] === undefined) rmSync(join(truthDirAbs, f), { force: true });
				else writeFileSync(join(truthDirAbs, f), before[i]!);
			}
			if (changed.length) log(pc.yellow(`  tester changed ${changed.join(", ")} in a tests-only retest; put back (the recorded truth cases stand)`));
			o.ledger.endAttempt(attempt, { outcome: "tests_only", costUsd: res.usage.cost, tokensIn: res.usage.input, tokensOut: res.usage.output, gateReport: { mode: truthMode, testsOnly: true, restored: changed } });
			return true;
		}
		// Code verifies the truth: re-run the cases script ourselves (it must load the unit's legacy files and not
		// type the results in) and load the cases; read-not-run cases are only checked for shape.
		let verified = await currentTruth();
		// the script did not run: when the probe that ran green before does not run either, the old code's runtime is
		// down, not this script. It is waited for; back up, the same script is checked again; still down, no truth is
		// decided from it (no read truth, no question): the unit is tested again later
		if ((!verified.ok && verified.madeBy === "run") || ("runError" in verified && verified.runError)) {
			const outage = await legacyEnvOutage(o.root, o.config, sourceAdapter);
			if (outage === "over") verified = await currentTruth();
			if (outage === "down") {
				legacyDown = true;
				o.ledger.endAttempt(attempt, { outcome: "truth_red", costUsd: res.usage.cost, tokensIn: res.usage.input, tokensOut: res.usage.output, gateReport: { mode: verified.madeBy, legacyDown: true, error: ("runError" in verified && verified.runError) || verified.error } });
				log(pc.yellow(`  the old code's runtime is down (the probe does not run either); this unit is tested again later`));
				return false;
			}
		}
		const runError = "runError" in verified ? verified.runError : undefined;
		if (runError) lastRunError = runError;
		o.ledger.endAttempt(attempt, { outcome: verified.ok ? "truth_green" : "truth_red", costUsd: res.usage.cost, tokensIn: res.usage.input, tokensOut: res.usage.output, gateReport: { mode: verified.madeBy, cases: verified.cases.length, error: verified.error, ...(runError ? { runError } : {}) } });
		if (!verified.ok) {
			log(pc.red(`  truth (${truthMode}) failed: ${verified.error}`));
			return false;
		}
		recordTruth(verified.cases, verified.madeBy, "none" in verified ? verified.none : undefined, more.codeWritten);
		// once the cases were linked to their tests, every later truth run links them again: a new case gets its test now
		if (linkedOnce) await coverTruth(false);
		return true;
	};
	let linkedOnce = false;
	// the last truth run found the old code's runtime down (legacyEnvOutage)
	let legacyDown = false;
	// in read mode: why the tester's script did not run green on the old code (the last time it was tried)
	let lastRunError: string | undefined;
	// cases go to the ledger with how they were made; each one must be a ported test (coverTruth checks).
	// The same cases as recorded stay untouched (ids, links to their tests): a retest never makes them drift.
	const recordTruth = (cases: TruthCase[], mode: TruthMode, none?: string, codeWritten = false) => {
		if (none !== undefined && !cases.length) {
			o.ledger.db.prepare("DELETE FROM truth_cases WHERE unit_id = ?").run(o.unitId);
			if (noBehaviour(o.ledger, o.unitId) !== none) o.ledger.addEvidence(o.unitId, "truth_none", { reason: none, file: `${truthDirRel}/${NO_BEHAVIOUR_FILE}` });
			log(pc.yellow(`  truth: no runtime behaviour to pin (${none})`));
			return;
		}
		// real cases replace an earlier "no behaviour" declaration
		o.ledger.db.prepare("DELETE FROM evidence WHERE unit_id = ? AND type = 'truth_none'").run(o.unitId);
		rmSync(join(truthDirAbs, NO_BEHAVIOUR_FILE), { force: true });
		const old = o.ledger.db.prepare("SELECT id, symbol_id, inputs, expected, verified_on_old, ported_test_path FROM truth_cases WHERE unit_id = ? ORDER BY rowid").all(o.unitId) as Array<{ id: string; symbol_id: string; inputs: string; expected: string; verified_on_old: number; ported_test_path: string | null }>;
		const same = old.length === cases.length && cases.every((c, i) => old[i]!.symbol_id === c.symbol && old[i]!.inputs === JSON.stringify(c.inputs) && old[i]!.expected === JSON.stringify(c.expected) && old[i]!.verified_on_old === (mode === "run" ? 1 : 0));
		if (same && o.ledger.hasEvidence(o.unitId, mode === "run" ? "truth_green_on_old" : "truth_read")) {
			// read truth from when the old code could not run here, read again now that it can: record why it was read,
			// so the next pass reuses it instead of asking the tester again
			if (mode === "read" && envMode === "run" && !readTruthOk())
				o.ledger.addEvidence(o.unitId, "truth_read", { cases: cases.length, file: `${truthDirRel}/${READ_CASES_FILE}`, why: "the script did not run green on the old code", ...(lastRunError ? { runError: lastRunError.slice(-800) } : {}) });
			log(pc.dim(`  truth: the same ${cases.length} cases as recorded; kept`));
			return;
		}
		// a case already recorded keeps its id and its link to its test; a new one gets the next free number
		const ids = caseIds(o.unitId, old, cases);
		// read truth whose expected value a retest changed once the code existed: nobody but the tester checked it, so the
		// reviewer confirms it against the legacy code (new cases stay allowed)
		if (codeWritten && mode === "read") {
			const was = new Map(old.map((c) => [c.id, c]));
			cases.forEach((c, i) => {
				const before = was.get(ids[i]!);
				if (before && before.verified_on_old === 0 && before.expected !== JSON.stringify(c.expected)) o.ledger.addEvidence(o.unitId, "truth_changed_after_code", { case: ids[i], symbol: c.symbol, inputs: before.inputs.slice(0, 300), old: before.expected.slice(0, 500), new: JSON.stringify(c.expected).slice(0, 500), why: lastTesterText.slice(-600) });
			});
		}
		const linked = new Map(old.map((c) => [c.id, c.ported_test_path]));
		o.ledger.db.prepare("DELETE FROM truth_cases WHERE unit_id = ?").run(o.unitId);
		const ins = o.ledger.db.prepare("INSERT INTO truth_cases(id, unit_id, symbol_id, inputs, expected, verified_on_old, ported_test_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
		cases.forEach((c, i) => ins.run(ids[i]!, o.unitId, c.symbol, JSON.stringify(c.inputs), JSON.stringify(c.expected), mode === "run" ? 1 : 0, linked.get(ids[i]!) ?? null, new Date().toISOString()));
		if (mode === "run") {
			o.ledger.addEvidence(o.unitId, "truth_green_on_old", { cases: cases.length, script: `${truthDirRel}/${sourceAdapter.truth.scriptName}` });
			log(pc.green(`  truth: ${cases.length} cases green on old code`));
		} else {
			o.ledger.addEvidence(o.unitId, "truth_read", { cases: cases.length, file: `${truthDirRel}/${READ_CASES_FILE}`, why: envMode === "read" ? NOT_RUN_HERE : "the script did not run green on the old code", ...(lastRunError ? { runError: lastRunError.slice(-800) } : {}) });
			log(pc.yellow(`  truth: ${cases.length} cases read from the old code, not run`));
		}
	};

	const portedDir = join(truthDirAbs, "ported");
	const ahead = !o.truthOnly && o.ledger.hasEvidence(o.unitId, "truth_ahead") && existsSync(portedDir);
	// read truth from when the old code could not run here is not reused once it can: the tester runs it now
	const readTruthOk = () => o.ledger.evidenceOf(o.unitId).some((e) => e.type === "truth_read" && (envMode !== "run" || JSON.parse(e.payload).why !== NOT_RUN_HERE));
	// a setup fix for the old code made this unit's truth script, green before, fail (rerunTruthScripts): the
	// tester fixes it with that error instead of the broken script being reused
	const brokenBySetup = o.ledger.getMeta(truthBrokenKey(o.unitId)) || undefined;
	if (brokenBySetup) log(pc.yellow(`  a setup fix for the old code broke this unit's truth script; the tester fixes it`));
	const hasTruth = !brokenBySetup && (o.reuseTruth || ahead) && (o.ledger.hasEvidence(o.unitId, "truth_green_on_old") || readTruthOk() || o.ledger.hasEvidence(o.unitId, "truth_none")) && existsSync(join(truthDirAbs, "interface.md"));
	if (!hasTruth) {
		// Playbook: a red truth script gets one more tester pass with the exact error; then a human question (only this unit waits).
		let truthOk = false;
		let lastErr: string | undefined;
		const truthFile = () => (truthMode === "run" ? sourceAdapter.truth.scriptName : READ_CASES_FILE);
		// the last try found the old code's runtime down: no tester session is paid for until it runs again
		const lastTest = o.ledger.db.prepare("SELECT gate_report FROM attempts WHERE unit_id = ? AND role = 'test' ORDER BY id DESC LIMIT 1").get(o.unitId) as { gate_report: string | null } | undefined;
		if (lastTest?.gate_report && (JSON.parse(lastTest.gate_report) as { legacyDown?: boolean }).legacyDown && (await legacyEnvOutage(o.root, o.config, sourceAdapter)) === "down") {
			log(pc.yellow(`  the old code's runtime is still down; this unit is tested again later`));
			return { unitId: o.unitId, state: o.ledger.getUnit(o.unitId)!.state, attempts: 0, costUsd: cost };
		}
		for (let t = 1; t <= 2 && !truthOk && !legacyDown; t++) {
			truthOk = await runTruth(lastErr ? `Your previous ${truthFile()} was rejected by the orchestrator${truthMode === "run" ? " (run from the legacy root)" : ""}. Fix it:\n${lastErr}` : brokenBySetup && truthMode === "run" ? `${sourceAdapter.truth.scriptName} ran green on the old code before, but a setup fix changed what it runs on (the start-up the run command loads first, or the run command itself), and now it fails:\n${brokenBySetup.slice(-1500)}\nFix it: load or stub only what the start-up does not already declare.` : undefined);
			if (!truthOk) lastErr = (o.ledger.db.prepare("SELECT gate_report FROM attempts WHERE unit_id = ? AND role = 'test' ORDER BY id DESC LIMIT 1").get(o.unitId) as { gate_report: string } | undefined)?.gate_report ?? "";
		}
		// the old code's runtime is down: no setup fix, no read truth, no question; the unit is picked up again
		if (legacyDown) return { unitId: o.unitId, state: o.ledger.getUnit(o.unitId)!.state, attempts: 1, costUsd: cost };
		// still red: maybe the old code cannot run here (packages never installed, a runtime only in docker). The
		// setup model prepares its environment once for all units; code re-runs this script to decide it worked.
		const legacyFixer = o.legacyFixer === false ? undefined : (o.legacyFixer ?? (o.spawn ? undefined : fixLegacyEnvWithModel));
		if (!truthOk && truthMode === "run" && legacyFixer && lastErr) {
			const fixed = await fixLegacyEnv({ config: o.config, root: o.root, source: sourceAdapter, problem: lastErr, truthDir: truthDirAbs, signature: errorSignature("truth", truthError(lastErr)), fixer: legacyFixer, ledger: o.ledger, log }).catch((e) => (log(pc.yellow(`  legacy setup failed: ${e?.message ?? e}`)), undefined));
			const verified = fixed ? await verifyTruthOnOld(truthDirAbs, o.config, sourceAdapter, o.root, card.files) : undefined;
			if (fixed && verified?.ok) {
				log(pc.cyan(`  the old code's environment was set up: ${fixed}`));
				recordTruth(verified.cases, "run", verified.none);
				truthOk = true;
				// units that asked the owner about the same thing run again in the new environment
				for (const q of o.ledger.openQuestions().filter((x) => x.point === "truth_env")) o.ledger.answerQuestion(q.id, `auto: the old code's environment was set up (${fixed})`, "setup model");
			}
		}
		// read mode, and the tester's script ran red while its cases.json passed: the setup model fixes the old code's
		// environment with that error (once for all units, capped); green → the cases come from running it after all
		if (truthOk && envMode === "read" && legacyFixer && lastRunError && !o.ledger.hasEvidence(o.unitId, "truth_green_on_old")) {
			const err = lastRunError;
			const fixed = await fixLegacyEnv({ config: o.config, root: o.root, source: sourceAdapter, problem: err, truthDir: truthDirAbs, signature: errorSignature("truth", truthError(err)), fixer: legacyFixer, ledger: o.ledger, log }).catch((e) => (log(pc.yellow(`  legacy setup failed: ${e?.message ?? e}`)), undefined));
			const verified = fixed ? await verifyTruthOnOld(truthDirAbs, o.config, sourceAdapter, o.root, card.files) : undefined;
			if (fixed && verified?.ok) {
				log(pc.cyan(`  the old code's environment was set up: ${fixed}`));
				recordTruth(verified.cases, "run", verified.none);
			}
		}
		// running it still fails for this unit: truth from reading the old code instead, marked as not run
		const runErr = truthMode === "run" ? lastErr : undefined;
		if (!truthOk && truthMode === "run") {
			truthMode = "read";
			log(pc.yellow(`  truth does not run green on the old code; the tester writes it from reading the code (marked: read, not run)`));
			for (let t = 1; t <= 2 && !truthOk && !legacyDown; t++) {
				truthOk = await runTruth(`Running ${sourceAdapter.truth.scriptName} on the old code failed${runErr ? `:\n${runErr.slice(-1500)}` : ""}\nWrite ${join(truthDirAbs, READ_CASES_FILE)} instead (see step 3).${t > 1 && lastErr ? `\nYour previous ${READ_CASES_FILE} was rejected:\n${lastErr}` : ""}`);
				if (!truthOk) lastErr = (o.ledger.db.prepare("SELECT gate_report FROM attempts WHERE unit_id = ? AND role = 'test' ORDER BY id DESC LIMIT 1").get(o.unitId) as { gate_report: string } | undefined)?.gate_report ?? "";
			}
		}
		if (legacyDown) return { unitId: o.unitId, state: o.ledger.getUnit(o.unitId)!.state, attempts: 1, costUsd: cost };
		if (truthOk && brokenBySetup) o.ledger.setMeta(truthBrokenKey(o.unitId), "");
		if (!truthOk) {
			const q = await ask({
				point: "truth_env",
				// units whose old code fails the same way share one question: one answer releases them all
				sameAs: errorSignature("truth", truthError(runErr ?? lastErr ?? "")),
				facts: `The tester ran twice for ${o.unitId} (legacy files ${card.files.join(", ")}); the characterization script did not run green on the old code either time.${runErr && runErr !== lastErr ? ` Running it failed with:\n${truthError(runErr).slice(-1000)}\nWriting the cases from reading the code failed too.` : ""} Last error:\n${lastErr?.slice(-1500) ?? "(none)"}`,
				options: [
					{ value: "retry", facts: "run it again: the legacy environment (dependencies, module loading, DB) is fixed now (type a hint instead to steer the tester)" },
					{ value: "leave", facts: "the code cannot run here: leave the unit parked for a human" },
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
			// two retests did not fix it: never implement against an interface outside the placement.
			// Truth ahead implements nothing: it just stops, and the unit's real run tests again
			if (o.truthOnly) {
				log(pc.yellow(`  interface.md still outside the placement after 2 retests; truth ahead stops`));
				return { unitId: o.unitId, state: o.ledger.getUnit(o.unitId)!.state, attempts: 0, costUsd: cost };
			}
			o.ledger.transitionUnit(o.unitId, "quarantined", `interface.md still drafts files outside ${moduleDir}/ after 2 retests: ${bad.join(", ")}`);
			log(pc.red(`  interface.md still outside the placement after 2 retests; quarantined`));
			return { unitId: o.unitId, state: "quarantined", attempts: 0, costUsd: cost };
		}
		log(pc.yellow(`  interface.md drafts files outside ${moduleDir}/: ${bad.join(", ")} — retest`));
		await runTruth(`interface.md drafts files outside this unit's placement: ${bad.join(", ")}. Every file this unit creates lives under ${moduleDir}/ (area "${area}"), shaped as below; extend the files already there instead of creating parallel ones. Fix interface.md and the ported tests' imports.\n${adapter.layout.structureDoc}`, true);
	}

	// Every truth case is a ported test the gate runs: its id (u1#3) is in a test's name. Code checks and links
	// each case to its test file; the tester adds what is missing (twice), then the unit stops.
	const uncoveredCases = (): string[] => {
		const ids = (o.ledger.db.prepare("SELECT id FROM truth_cases WHERE unit_id = ? ORDER BY rowid").all(o.unitId) as Array<{ id: string }>).map((c) => c.id);
		const cov = caseCoverage(targetProjectDir, moduleDir, adapter.layout, ids);
		const link = o.ledger.db.prepare("UPDATE truth_cases SET ported_test_path = ? WHERE id = ?");
		for (const id of ids) link.run(cov.found.get(id) ?? null, id);
		return cov.missing;
	};
	// `quarantine` false: a re-run inside the implement loop, which goes on with the tests it has
	const coverTruth = async (quarantine = true): Promise<boolean> => {
		for (let i = 0; ; i++) {
			const missing = uncoveredCases();
			if (!missing.length) return (linkedOnce = true);
			if (i === 2) {
				log(pc.red(`  ${missing.length} truth case(s) still without a ported test after 2 retests: ${missing.slice(0, 10).join(", ")}`));
				if (quarantine && !o.truthOnly) {
					// the last tester attempt carries the real failure: self-heal and the resolver read the last attempt, not an older
					// gate report (no extra zero-length tester attempt: br lanes averages their time)
					const blocked = lastTesterBlocked.length ? `\nIts blocked writes:\n${[...new Set(lastTesterBlocked)].join("\n").slice(-1500)}` : "";
					const report = { mode: truthMode, missing, error: `${missing.length} truth case(s) without a ported test after 2 retests: ${missing.slice(0, 10).join(", ")}${blocked}\nThe tester's last answer:\n${lastTesterText.slice(-1500)}` };
					o.ledger.db.prepare("UPDATE attempts SET outcome = 'truth_red', gate_report = ? WHERE id = (SELECT MAX(id) FROM attempts WHERE unit_id = ? AND role = 'test')").run(JSON.stringify(report), o.unitId);
					o.ledger.transitionUnit(o.unitId, "quarantined", `truth cases without a ported test after 2 retests: ${missing.slice(0, 10).join(", ")}`);
				}
				return false;
			}
			log(pc.yellow(`  ${missing.length} truth case(s) have no ported test — retest`));
			const seen = findTests(targetProjectDir, moduleDir, adapter.layout);
			const globs = adapter.layout.testFileGlobs(moduleDir).map((g) => join(targetProjectDir, g)).join(", ");
			// why ids written into an earlier unit's test file are gone
			const undone = lastTesterText.split("\n").find((l) => l.startsWith("(Your changes to tests of earlier units were undone"));
			await runTruth(`These truth cases have no ported test yet: ${missing.join(", ")}. The orchestrator searches the test files matching ${globs} for each case id as exact text, "#" included (e.g. "${missing[0]}"); a changed spelling does not count. ${seen.length ? `It searched ${seen.join(", ")} and did not find these ids.` : "It found no test files there."} Every case gets its own test asserting the case's expected value, with the exact id in its name, or next to it in a comment or test description where a name cannot hold it. check_ported_tests shows what is still missing.${undone ? `\n${undone}` : ""}`, true);
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
		const saved = walk(portedDir).map((abs) => relative(portedDir, abs));
		// a path main ever had is not this unit's unmerged test: another unit's, or one tidy moved or removed since
		const onMainOnce = await everOnMain(targetProjectDir, saved);
		for (const f of saved) {
			const abs = join(portedDir, f);
			const dest = join(targetProjectDir, f);
			if (existsSync(dest) || onMainOnce.has(f)) continue;
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
		// only a retest that went through counts: a failed or stopped one leaves the note for the next run
		if (await runTruth(quirkNote)) markQuirksApplied({ ledger: o.ledger }, o.unitId);
	}
	// the merge was refused for errors in this unit's test files: the implementer may not edit them, the tester fixes them
	if (o.testsNote) {
		log(pc.dim("  the merge was refused for errors in the ported tests: the tester fixes them first"));
		await runTruth(o.testsNote, true);
	}
	let testFiles = loadTests();
	if (!testFiles.length) log(pc.yellow("  no ported test files found — the gate cannot prove behaviour"));
	// the implementer may not edit tests: tests that fail the stack's lint/format check would fail every attempt,
	// so the tester fixes them now (once). Only with the real gate (simulations fake it).
	if (testFiles.length && !o.gate) {
		// the unit's own tests: other units' formatting on main is not this tester's to fix
		const lint = await checkTests(targetProjectDir, adapter, "lint", await ownTests(o.ledger, o.unitId, targetProjectDir, testFiles.map((t) => t.path), adapter.toolchain.ignoredPaths));
		if (lint.error) {
			log(pc.dim("  ported tests fail the lint check: the tester fixes them before implementing"));
			if (await runTruth(`The ported tests fail the stack's lint/format check (\`${lint.command}\`, run in ${targetProjectDir}). The implementer may not edit tests, so fix them now: formatting and lint only, in the TEST files (the linter's fix mode is fine when you give it only those files; other changes are put back), behaviour unchanged. check_ported_tests runs the same check.\n${lint.error}`, true)) testFiles = loadTests();
		}
		// the build/type check too, once the code the tests call is in place (a re-opened unit, a later pass): its errors
		// are then the tests' own (before that, a missing class is the implementer's to write)
		const iface = existsSync(join(truthDirAbs, "interface.md")) ? readFileSync(join(truthDirAbs, "interface.md"), "utf8") : "";
		const codeThere = iface !== "" && !interfaceCodeFiles(iface, relative(o.config.target.path, targetProjectDir), moduleDir, targetProjectDir).length;
		const build = codeThere ? await checkTests(targetProjectDir, adapter, "build", await ownTests(o.ledger, o.unitId, targetProjectDir, testFiles.map((t) => t.path), adapter.toolchain.ignoredPaths)) : undefined;
		if (build?.error) {
			log(pc.dim("  ported tests fail the build check: the tester fixes them before implementing"));
			if (await runTruth(`The ported tests fail the stack's build/type check (\`${build.command}\`, run in ${targetProjectDir}) while the code they call is in place. The implementer may not edit tests, so fix the errors in the TEST files now, behaviour unchanged. check_ported_tests runs the same check.\n${build.error}`, true)) testFiles = loadTests();
		}
	}
	// kept tests and interface.md may name paths the layout does not allow (written before a layout change, the
	// tester skipped): the implementer cannot rename them, so the tester moves them now (once)
	if (testFiles.length && !o.gate) {
		const iface = existsSync(join(truthDirAbs, "interface.md")) ? readFileSync(join(truthDirAbs, "interface.md"), "utf8") : "";
		const bad = await portedLayout(checkLayout, await ownTests(o.ledger, o.unitId, targetProjectDir, testFiles.map((t) => t.path), adapter.toolchain.ignoredPaths), interfaceCodeFiles(iface, relative(o.config.target.path, targetProjectDir), moduleDir, targetProjectDir));
		if (bad.length) {
			log(pc.dim("  ported tests or interface.md name paths the layout does not allow: the tester moves them before implementing"));
			if (await runTruth(`The ported tests or interface.md name files the stack's layout does not allow (the gate's structure_ok). The implementer cannot change a test's file name or imports, so it could never pass: rename or move the test files, change their imports and interface.md to paths the layout below allows, behaviour unchanged. check_ported_tests with code_files checks the new paths.\n${bad.join("\n")}\n\n${adapter.layout.structureDoc}`, true)) testFiles = loadTests();
		}
	}
	const implementedBefore = !!o.ledger.db.prepare("SELECT 1 FROM attempts WHERE unit_id = ? AND role IN ('implement', 'escalate') LIMIT 1").get(o.unitId);
	const greenBefore =
		testFiles.length && !o.gate && !implementedBefore
			? await testsGreenBefore({
					// the unit's own tests: other units' tests in the area pass without this unit's code anyway
					files: () => ownTests(o.ledger, o.unitId, targetProjectDir, testFiles.map((t) => t.path), adapter.toolchain.ignoredPaths),
					pass: (files) => testsPass(targetProjectDir, adapter, files),
					retest: async (why) => {
						log(pc.yellow("  ported tests pass before any code exists: the tester makes them call the unit's code"));
						if (await runTruth(why, true)) testFiles = loadTests();
					},
				})
			: undefined;
	const loadIface = () => (existsSync(join(truthDirAbs, "interface.md")) ? readFileSync(join(truthDirAbs, "interface.md"), "utf8") : "(tester did not write interface.md)");

	// ---- implement → gate → triage loop ----------------------------------------------------------
	// a unit whose truth was kept skipped the tester and is still planned: it is running now all the same
	if (["truth", "planned"].includes(o.ledger.getUnit(o.unitId)!.state)) o.ledger.transitionUnit(o.unitId, "implementing", "truth ready");
	const maxImpl = o.config.run.maxImplementAttempts;
	const maxTotal = maxImpl + o.config.run.maxEscalateAttempts;
	let gate: GateReport | undefined;
	let previousGate: GateReport | undefined;
	let triage: Triage | undefined;
	// a unit that gave its lane back (a stop, or it waited for a unit it reported) goes on counting its tries: the wait
	// is no fresh set of tries. One try is always left
	const triesUsed = (JSON.parse(o.ledger.getUnit(o.unitId)!.meta) as { triesUsed?: number }).triesUsed ?? 0;
	let attemptNo = Math.max(0, Math.min(triesUsed, maxTotal - 1));
	if (triesUsed) {
		o.ledger.updateUnit(o.unitId, { meta: { triesUsed: undefined } });
		log(pc.dim(`  goes on from try ${attemptNo} of ${maxTotal} (tries used before it gave its lane back)`));
	}
	// Jev routing (br label): a unit rated hard with confidence starts on the escalate model
	const route = (JSON.parse(o.ledger.getUnit(o.unitId)!.meta) as { route?: { difficulty?: string; difficultyConfidence?: number } }).route;
	let doctorActions = 0;
	const diagnosed = new Set<string>();
	let forceEscalate = route?.difficulty === "hard" && (route.difficultyConfidence ?? 0) >= 0.75;
	if (forceEscalate) log(pc.dim(`  routed to ${o.config.models.escalate.id}: Jev rates this unit hard (${Math.round((route!.difficultyConfidence ?? 0) * 100)}%)`));
	let lastGateText = "";
	// the reviewer's code findings still open: kept in unit meta, so every attempt and every later run of the unit sees all of them
	const openFindings = () => (JSON.parse(o.ledger.getUnit(o.unitId)!.meta) as { reviewFindings?: string[] }).reviewFindings ?? [];
	// the reviewer's earlier findings it called fixed since: shown to the implementer as what to keep working
	const fixedFindings = () => (JSON.parse(o.ledger.getUnit(o.unitId)!.meta) as { reviewFixed?: string[] }).reviewFixed ?? [];
	// what other models said about the TESTS during an attempt: the implementer disputes one, the reviewer finds some weak
	let disputes: Array<{ test: string; why: string; evidence: string }> = [];
	// open reviewer findings the implementer disputes: the next review keeps each with a reason or drops it
	let findingDisputes: Array<{ finding: string; why: string; evidence: string }> = [];
	// the implementer's final message (the reviewer reads it) and its last check_my_code result in this attempt
	let implementerNote: string | undefined;
	let lastCheck: CheckResult | undefined;
	// the worktree's changed files as they were at that check: code changed after it makes the check stale
	const treeKey = async () => {
		const read = (f: string) => (existsSync(join(targetProjectDir, f)) ? readFileSync(join(targetProjectDir, f), "utf8") : "");
		try {
			return sha1(JSON.stringify((await changedFiles(targetProjectDir, adapter.toolchain.ignoredPaths)).sort().map((f) => [f, read(f)])));
		} catch {
			return undefined; // no git answer: the check counts as stale
		}
	};
	let checkedTree: string | undefined;
	// the last judged review and what it judged: code and tests unchanged since (and nothing disputed) reuse its verdict
	let lastReview: { key: string; r: Awaited<ReturnType<Reviewer>> } | undefined;
	let reviewWeak: string | undefined;
	// what the reviewer says must change outside the unit's files (setup, config, plugin): never the implementer's
	let reviewOutOfScope: string | undefined;
	// the reviewer says the fix is in the project setup or config (else it is app code: no setup model)
	let reviewOutOfScopeSetup = false;
	// tester rounds for the reviewer's weak-tests verdict and for the implementer's disputes: each has its own 2, so a
	// dispute about a test the weak-tests rewrite just broke still reaches the tester
	let testRounds = 0;
	let disputeRounds = 0;
	// tester rounds the reviewer's weak-tests verdict drove (disputes do not count) in which the tester changed a test:
	// the waiver below needs 2 of them. Kept in unit meta with the tester's "kept" and "could not" answers, so a later
	// run of the unit goes on counting
	const unitMeta = () => JSON.parse(o.ledger.getUnit(o.unitId)!.meta) as { weakRounds?: number; testerKept?: string; testerCouldNot?: string; truthChangeSeen?: number };
	// read truth a retest changed after the code existed, not yet shown to a review that judged (a finding then keeps it open)
	const truthChangedAfterCode = (): { lines: string[]; last: number } => {
		const rows = o.ledger.db.prepare("SELECT id, payload FROM evidence WHERE unit_id = ? AND type = 'truth_changed_after_code' AND id > ? ORDER BY id").all(o.unitId, unitMeta().truthChangeSeen ?? 0) as Array<{ id: number; payload: string }>;
		const lines = rows.map((r) => {
			const p = JSON.parse(r.payload) as { case: string; symbol: string; inputs: string; old: string; new: string; why?: string };
			return `${p.case} (${p.symbol}, inputs ${p.inputs}): was ${p.old}, the tester made it ${p.new}${p.why ? `. The tester's last words: ${p.why.replace(/\s+/g, " ").slice(-300)}` : ""}`;
		});
		return { lines, last: rows.at(-1)?.id ?? 0 };
	};
	let weakRounds = unitMeta().weakRounds ?? 0;
	// the last weak-tests round changed no test: the next one runs on the escalate model
	let weakStuck = false;
	// open findings at the last judged review (a later run of the unit starts from those it carries): fewer open after
	// the next one is progress, and that round gives its try back, a few times per run
	let openBefore: number | undefined = openFindings().length || undefined;
	let progressRounds = 0;
	let testsOnlyRounds = 0;
	// the reviewer found only weak tests (the code is fine): after the tester's retest the gate runs again on the same
	// code, with no new implementer session and no new attempt
	let reviewWeakOnly = false;
	let regate = false;
	// this pass only re-runs the gate on the same code (no implementer session, no attempt counted)
	let regateOnly = false;
	// the tester re-ported: triage never sends a retest that did not help to the tester again
	let lastRetest: LastRetest | undefined;
	// every retest runs from the implement loop: the code is in place, so check_ported_tests runs the tests against it
	const retest = async (extra: string, more?: { codeWritten?: boolean; disputeText?: string; stronger?: boolean }) => {
		// the run is stopping: no tester round, the loop hands the lane back
		// no tester round, no progress: a stale answer from an earlier retest never counts toward the waiver
		lastRetest = undefined;
		if (o.stopped?.()) return;
		const files = () => JSON.stringify([loadTests(), readTruthFiles(), loadIface()]);
		const before = files();
		if (await runTruth(extra, false, { codeWritten: true, ...more })) testFiles = loadTests();
		// no test, truth file or interface.md changed: no progress
		lastRetest = { progress: files() !== before };
		// the last attempt is used up, but the tester changed the tests: the gate runs once more on them and the same code
		// (once: never from a regate pass) instead of quarantining code nobody checked against the fixed tests. Not when the
		// reviewer judged the code wrong: the same code would only be rejected again
		if (attemptNo >= maxTotal && !regateOnly && lastRetest.progress && !(gate?.failedStep === "wired_ok" && !reviewWeakOnly)) regate = true;
	};
	const reports: Array<{ owner: string; target: string; problem: string; evidence: string }> = [];
	let reviewJudged = true;
	const providerDown = async (facts: string) => {
		const q = await ask({
			point: "env",
			facts,
			options: [
				{ value: "retry", facts: "the provider works again: run the unit again" },
				{ value: "wait", facts: "keep the unit waiting; the rest of the run goes on" },
			],
		});
		log(pc.red(`  provider failing repeatedly; asked question #${q} (only this unit waits)`));
	};
	const outOfScopeRoute = async (problem: string, setup: boolean): Promise<UnitRunResult | undefined> => {
		const signature = errorSignature("wired_ok", problem);
		// app code outside the unit is no setup gap: the question goes straight to the resolver (it can start a code or fix job)
		const setupFixer = !setup || o.setupFixer === false ? undefined : (o.setupFixer ?? (o.spawn ? undefined : fixSetupWithModel));
		let setupTried = "";
		if (setupFixer) {
			const fixed = await fixRunSetup({ config: o.config, root: o.root, adapter, projectDir: projectDir(o.config, stackId), fixer: setupFixer, ledger: o.ledger, lock: o.mergeLock, unitId: o.unitId, signature, problem: `The reviewer of unit ${o.unitId} (code in ${moduleDir}/) found what must change outside the unit's files; the unit's implementer may write only ${writeGlobs.join(", ")}. Fix it in the project setup if it belongs there, not in the unit's code:\n${problem}` }).catch((e) => (log(pc.yellow(`  setup fix failed: ${e?.message ?? e}`)), undefined));
			if (fixed) {
				o.ledger.updateUnit(o.unitId, { meta: { parked: { diagnosis: { summary: `the project setup was fixed (${fixed})`, note: problem.slice(0, 500) } } } });
				log(pc.cyan(`  setup fixed by the model: ${fixed} — the unit runs again`));
				return { unitId: o.unitId, state: o.ledger.getUnit(o.unitId)!.state, attempts: attemptNo, gate, costUsd: cost };
			}
			setupTried = " The setup model tried and could not fix it.";
		}
		const qid = await ask({
			point: "gate_env",
			sameAs: signature,
			facts: `The reviewer of ${o.unitId} says something must change outside the unit's files (the implementer may write only ${writeGlobs.join(", ")}), so another attempt cannot fix it.${setupTried}\n${problem.slice(0, 1500)}`,
			options: [
				{ value: "retry", facts: "I changed it (or it is not needed — say so in a hint): run the unit again" },
				{ value: "leave", facts: "leave the unit parked" },
			],
			context: { failedStep: "wired_ok", outOfScope: problem.slice(0, 1500) },
		});
		o.ledger.updateUnit(o.unitId, { meta: { parked: { question: qid, env: envFingerprint(o.config, projectDir(o.config, stackId), adapter.toolchain.manifestFiles, setupFiles(o.root, stackId)), diagnosis: { summary: "the reviewer asks for a change outside the unit's files", note: problem.slice(0, 500) } } } });
		log(pc.yellow(`  waiting for human question #${qid} — other units keep running`));
		return { unitId: o.unitId, state: o.ledger.getUnit(o.unitId)!.state, attempts: attemptNo, gate, costUsd: cost };
	};
	// the run is stopping: the unit goes back to planned with its tries counted and its ported tests saved; the
	// scheduler keeps its code like a quarantine's, so its next run goes on from there
	const stopNow = (attempt?: number, report?: GateReport): UnitRunResult | undefined => {
		if (!o.stopped?.()) return undefined;
		if (attempt !== undefined) o.ledger.endAttempt(attempt, { outcome: "stopped", gateReport: report });
		savePorted();
		o.ledger.updateUnit(o.unitId, { meta: { triesUsed: attemptNo, retryNote: `The run was stopped while this unit was being worked on (after ${attemptNo} of ${maxTotal} tries). Check what is done, then finish it.` } });
		o.ledger.transitionUnit(o.unitId, "planned", `run stopped after ${attemptNo} try(s); its code is kept for the next run`);
		log(pc.yellow(`  the run is stopping: ${o.unitId} goes back to planned, its code is kept`));
		return { unitId: o.unitId, state: "planned", attempts: attemptNo, gate, costUsd: cost, stopped: true };
	};
	{
		const s = stopNow();
		if (s) return s;
	}
	while (attemptNo < maxTotal || regate) {
		const s = stopNow();
		if (s) return s;
		regateOnly = regate;
		regate = false;
		if (!regateOnly) attemptNo++;
		// main moved on since the worktree was made (other units, setup fixes): its new commits come in under the
		// unit's work before each attempt, so the attempt and its gate run on the main it will merge into
		if (mainDir) {
			const caught = await catchUpWithMain(targetProjectDir, mainDir);
			if (caught && "commits" in caught) log(pc.dim(`  main's ${caught.commits} new commit(s) brought in under the unit's work`));
			else if (caught) log(pc.dim(`  main's new commits clash with the unit's work in ${caught.clash.join(", ") || "some files"}: the merge resolves them`));
		}
		// the tests as they are on disk now: the tester (it has a shell) may have renamed or removed one since they
		// were listed; the implementer cannot write tests, so the gate still catches any change during this attempt
		testFiles = loadTests();
		lastCheck = undefined;
		const role = forceEscalate || attemptNo > maxImpl ? "escalate" : "implement";
		const modelRole = o.config.models[role];
		setStep(`${regateOnly ? "gate" : role} ${o.unitId}`);
		const attempt = o.ledger.startAttempt(o.unitId, regateOnly ? "gate" : role, regateOnly ? undefined : modelRole.id);
		let res: Awaited<ReturnType<LeafSession["run"]>> = { text: "", toolCalls: 0, blocked: 0, usage: { input: 0, output: 0, cost: 0 } };
		if (!regateOnly) {
			const t0 = Date.now();
			const impl = await spawn({
				role,
				cwd: targetProjectDir,
				config: o.config,
				writeGlobs,
				appendOnlyGlobs,
				protectedGlobs: adapter.protectedGlobs,
				systemPrompt: implementerSystemPrompt(o.config, { ...placeOpts, sharedDirs: adapter.layout.sharedDirs, rules, attempt: attemptNo, quirks: quirkSummary({ ledger: o.ledger }, o.unitId) || undefined, writeGlobs, source: sourceAdapter, target: adapter }),
				customTools: implementerTools({ ...deps, attemptId: attempt, testFiles: () => testFiles.map((t) => t.path), slot: gateSlot, disputeRecheck: disputeRounds < 2, onDispute: (d) => disputes.push(d), onDisputeFinding: (d) => findingDisputes.push(d), onCheck: async (c) => {
					lastCheck = c;
					checkedTree = await treeKey();
				}, onReport: (r) => reports.push(r) }),
				transcriptPath: transcriptPath(o.root, o.unitId, role, attempt),
				validateWrite: async (path, content, before) => {
					const lang = adapter.layout.lang(path);
					if (!lang) return undefined;
					const errs = await addedSyntaxErrors(lang, before, content);
					return errs.length ? `syntax error at line ${errs[0]!.line}: ${errs[0]!.text}` : undefined;
				},
				onToolCall: (e) => e.blocked && log(pc.dim(`  implementer blocked: ${e.blocked}`)),
			});
			const open = openFindings();
			// only the unit's own tests in full (the area's others can be many and long): the rest by path, the gate runs them all
			const own = new Set(await ownTests(o.ledger, o.unitId, targetProjectDir, testFiles.map((t) => t.path), adapter.toolchain.ignoredPaths));
			const others = testFiles.filter((t) => !own.has(t.path)).map((t) => t.path);
			const prompt = [
				// the truth as recorded now (the card was built before the tester ran)
				renderTaskCard({ ...card, ...truthCounts(o.ledger, o.unitId) }, o.config),
				"",
				"## Target interface drafted by the tester (satisfy it)",
				loadIface(),
				"",
				`## This unit's ported tests (read-only): ${testFiles.filter((t) => own.has(t.path)).map((t) => t.path).join(", ") || "none"}`,
				...testFiles.filter((t) => own.has(t.path) && existsSync(join(targetProjectDir, t.path))).map((t) => `### ${t.path}\n\`\`\`${adapter.layout.lang(t.path) ?? ""}\n${readFileSync(join(targetProjectDir, t.path), "utf8")}\n\`\`\``),
				others.length ? `\n## Other tests in this area (read-only, must stay green; read one if you need it)\n${others.map((p) => `- ${p}`).join("\n")}` : "",
				lastGateText ? `\n## Previous attempt failed the gate\n${lastGateText}` : "",
				open.length ? `\n## Open reviewer findings for this unit (from all its reviews so far: fix every one; one you are sure is wrong: dispute_finding with evidence, the reviewer answers it)\n${open.join("\n")}` : "",
				fixedFindings().length ? `\n## Fixed before: keep these working (the reviewer confirmed each fix; a change that undoes one is a finding again)\n${fixedFindings().map((f) => `- ${f}`).join("\n")}` : "",
				// every attempt reads it: each is a new session, and a later (stronger) one needs the hint as much as the first
				o.retryNote ? `\n## Note from the orchestrator\n${o.retryNote}` : "",
			].join("\n");
			try {
				res = await impl.run(prompt);
				const oneMore = async (ask: string) => {
					const more = await impl.run(ask);
					res = { ...more, toolCalls: res.toolCalls + more.toolCalls, blocked: res.blocked + more.blocked, usage: { input: res.usage.input + more.usage.input, output: res.usage.output + more.usage.output, cost: res.usage.cost + more.usage.cost } };
				};
				// DONE while its own last check_my_code was red: the gate would fail the same way, so one more turn
				const red = lastCheck as CheckResult | undefined; // set by the tool during run()
				if (red && !red.ok && !red.timedOut && !res.error && !reports.length && !o.stopped?.()) {
					log(pc.dim(`  ${role} said DONE after a red check_my_code (${red.failed}): one more turn`));
					await oneMore(`Your last check_my_code was red (${red.failed}), so the gate fails the same way. Fix it and call check_my_code again until it is clean.${red.failed === "tests" ? " A red test you are sure is wrong (it expects what the legacy code does not do): call dispute_test for it by name, with evidence from the legacy code. Every red test must be fixed or disputed." : ""} Then end with your final line as before.\n\nThe red check:\n${red.text.slice(0, 5000)}`);
				}
				// DONE with symbols the ledger still shows unproven: the gate's first step fails on them, so one more turn
				const unproven = o.ledger.symbolsOfUnit(o.unitId).filter((s) => !["mapped", "dropped", "tested", "accepted"].includes(s.state));
				if (unproven.length && !res.error && !reports.length) {
					log(pc.dim(`  ${role} said DONE with ${unproven.length} unproven symbol(s): one more turn`));
					await oneMore(`${unproven.length} legacy symbol(s) of this unit are still unproven, so the gate fails on them. Call ledger_prove once with all of them as a list (moved / extracted / merged_into / inlined / split / dropped + why):\n${unproven.map((s) => `- ${s.id}`).join("\n")}\nThen end with your final line as before.`);
				}
			} finally {
				impl.dispose();
			}
			implementerNote = res.text.trim().slice(-1500) || undefined;
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
				// the wait is no fresh set of tries: its next run goes on counting from here
				o.ledger.updateUnit(o.unitId, { meta: { triesUsed: attemptNo, retryNote: `This unit waited for ${owners.join(", ")} to fix what it reported (${reports.map((r) => r.target).join(", ")}). That code is fixed now: use it.` } });
				o.ledger.transitionUnit(o.unitId, "planned", `waits for ${owners.join(", ")} to fix a reported bug`);
				log(pc.yellow(`  reported a bug in ${owners.join(", ")}: re-opened; this unit waits for the fix`));
				return { unitId: o.unitId, state: "planned", attempts: attemptNo, costUsd: cost };
			}
			if (res.error && res.toolCalls === 0) {
				// The session never ran (provider error even after tier fallback). Not the code's fault: no attempt burned.
				o.ledger.endAttempt(attempt, { outcome: "session_error", costUsd: res.usage.cost, gateReport: { error: res.error } });
				attemptNo--;
				if (++providerErrors >= 3) {
					await providerDown(`Model sessions for ${o.unitId} failed ${providerErrors} times in a row before doing any work (provider error after tier fallback, model ${modelRole.id}): ${res.error}`);
					break;
				}
				continue;
			}
			// the session worked: only errors in a row count
			providerErrors = 0;
		}

		if (o.ledger.getUnit(o.unitId)!.state === "implementing") o.ledger.transitionUnit(o.unitId, "gating", `attempt ${attemptNo}`);
		const reviewer = o.reviewer === false ? undefined : (o.reviewer ?? (o.spawn ? undefined : reviewWithModel));
		const review = reviewer
			? async (changedFiles: string[], nearDuplicates?: string[]) => {
					// what the review judges: the changed code and the ported tests as they are now, and the tester's answers
					// (a tester that kept every test and only answered gets a fresh review that reads them)
					const read = (f: string) => (existsSync(join(targetProjectDir, f)) ? readFileSync(join(targetProjectDir, f), "utf8") : "");
					// the reviewer judges the unit's own tests; the area's others it sees by path only (not its to judge)
					const own = await onlyOwnTests(o.ledger, o.unitId, targetProjectDir, testFiles.map((t) => t.path), adapter.toolchain.ignoredPaths);
					const otherTests = testFiles.map((t) => t.path).filter((t) => !own.includes(t));
					const key = sha1(JSON.stringify([[...changedFiles].sort().map((f) => [f, read(f)]).concat(own.map((t) => [t, read(t)])), otherTests, unitMeta().testerKept ?? ""]));
					const seen = { files: Object.fromEntries(changedFiles.map((f) => [f, sha1(read(f))])), tests: sha1(JSON.stringify([testFiles.map((t) => [t.path, read(t.path)]), unitMeta().testerKept ?? ""])) };
					const disputed = findingDisputes;
					const changedTruth = truthChangedAfterCode();
					const truthChanged = changedTruth.lines;
					findingDisputes = [];
					// a merge round: only the clashing files (resolved) and wiring files changed since an approval, it stands
					const clash = (o.approved?.clash ?? []).map((c) => relative(targetProjectDir, join(o.workDir ?? o.config.target.path, c)));
					const approvedBefore = !disputed.length && !truthChanged.length && lastReview?.key !== key && !!o.approved?.review && approvalStands(o.approved.review, seen, (f) => clash.includes(f) || isWiringFile(f, wiring));
					if (approvedBefore) lastReview = { key, r: o.approved!.review!.r };
					const reuse = !disputed.length && !truthChanged.length && lastReview?.key === key;
					if (reuse) log(pc.dim(approvedBefore ? "  only clashing or wiring files changed since the approved review: its verdict stands (no new review)" : "  code and tests unchanged since the last review: its verdict stands (no new review)"));
					// the run is stopping: no review session; the red gate hands the lane back below
					if (!reuse && o.stopped?.()) return { ok: false, judged: false, output: "not judged: the run is stopping" };
					setStep(`review ${o.unitId}`);
					const ra = reuse ? undefined : o.ledger.startAttempt(o.unitId, "review", o.config.models.escalate.id);
					let r = reuse
						? { ...lastReview!.r, costUsd: 0 }
						: await reviewer({ ledger: o.ledger, config: o.config, root: o.root, unitId: o.unitId, adapter, targetProjectDir, moduleDir, legacyFiles: card.files, changedFiles, nearDuplicates, testFiles: own, otherTests, writeGlobs, ownerNote: o.retryNote, greenBefore, openFindings: openFindings(), implementerNote, findingDisputes: disputed, testerKept: unitMeta().testerKept, truthChanged, transcriptPath: transcriptPath(o.root, o.unitId, "review", ra!) });
					if (!reuse && r.judged) lastReview = { key, r };
					if (!reuse && r.judged && r.ok && o.approved) o.approved.review = { ...seen, r };
					// a review that judged them has seen the changed truth: a wrong one is in its findings now
					if (!reuse && r.judged && changedTruth.last) o.ledger.updateUnit(o.unitId, { meta: { truthChangeSeen: changedTruth.last } });
					cost += r.costUsd ?? 0;
					reviewWeakOnly = r.judged && !r.ok && !!r.weakTests && !r.findings?.length && !r.outOfScope;
					// the tester changed the tests in 2 weak-tests rounds and only the tests are still called weak: the code passes,
					// the doubt is noted on the unit. Never for a unit without ported tests (there "weak" means behaviour nobody
					// pinned), nor while the tester's last answer says it could not rewrite a test (it agrees they are weak)
					if (reviewWeakOnly && weakRounds >= 2 && testFiles.length && !noBehaviour(o.ledger, o.unitId) && !unitMeta().testerCouldNot) {
						o.ledger.updateUnit(o.unitId, { meta: { weakTestsNote: `accepted with tests the reviewer still finds weak after ${weakRounds} tester rounds:\n${r.weakTests}` } });
						log(pc.yellow(`  only the tests are still called weak after ${weakRounds} tester rounds: the code passes the review, the doubt is noted on the unit`));
						r = { ...r, ok: true, weakTests: undefined, output: `reviewer: the code is fine; tests still called weak after ${weakRounds} tester rounds (noted on the unit):\n${r.weakTests}` };
						reviewWeakOnly = false;
					}
					reviewWeak = r.weakTests;
					reviewOutOfScope = r.outOfScope;
					reviewOutOfScopeSetup = !!r.outOfScopeSetup;
					reviewJudged = r.judged;
					// the reviewer lists every open finding each time: its list replaces the kept one (a pass clears it)
					if (r.judged && (r.ok || r.findings)) o.ledger.updateUnit(o.unitId, { meta: { reviewFindings: r.ok ? [] : r.findings } });
					// what the reviewer called fixed: the implementer keeps it working (a rewrite must not undo it)
					if (r.judged && r.fixed?.length) o.ledger.updateUnit(o.unitId, { meta: { reviewFixed: [...new Set([...fixedFindings(), ...r.fixed])].slice(-30) } });
					if (ra !== undefined) o.ledger.endAttempt(ra, { outcome: !r.judged ? "not_judged" : r.ok ? "review_ok" : reviewWeakOnly ? "review_weak_tests" : "review_red", costUsd: r.costUsd ?? 0, gateReport: { output: r.output } });
					return r;
				}
			: undefined;
		// the gate takes a CPU slot only for its commands: the review (a model session) never holds one
		// still red on the ported tests after the extra turn, and the implementer disputed tests: the gate would only
		// repeat that test run, so the disputes go straight to the tester (the next attempt runs the whole gate)
		const check = lastCheck as CheckResult | undefined;
		// only when no file changed after that check: a fix made after it (DONE without checking again) needs the real gate
		const sameTree = !!check && checkedTree !== undefined && checkedTree === (await treeKey());
		const straight = !!check && !check.ok && check.failed === "tests" && !check.timedOut && disputes.length > 0 && disputeRounds < 2 && sameTree;
		if (straight) log(pc.dim("  ported tests still red and disputed: straight to the tester"));
		const cleanCheck = reusableCheck(check, sameTree);
		gate = straight
			? { ok: false, steps: [{ name: "ported_tests_green", ok: false, ms: 0, output: check!.text }], changedFiles: check!.files, failedStep: "ported_tests_green", testFiles: testFiles.map((t) => t.path) }
			: await gateFn({ ledger: o.ledger, unitId: o.unitId, adapter, targetProjectDir, mainDir, writeGlobs, appendOnlyGlobs, testFiles, moduleDir, area, root: o.root, stackId, sanctioned: [...tidyPaths, ...card.waitingStubs, ...disputedOthers], legacyWords: legacyWordsFor(sourceAdapter.legacyWords, adapter), review, slot: gateSlot, cleanCheck });
		// the run is stopping: a red gate goes to no triage, tester or next try
		if (!gate.ok) {
			const s = stopNow(attempt, gate);
			if (s) return s;
		}
		// only the tests were called weak: the code was fine, so this is not an implementer failure
		const weakOnly = !gate.ok && gate.failedStep === "wired_ok" && reviewWeakOnly;
		o.ledger.endAttempt(attempt, { outcome: gate.ok ? "gate_green" : weakOnly ? "gate_tests_weak" : `gate_red:${gate.failedStep}`, costUsd: res.usage.cost, tokensIn: res.usage.input, tokensOut: res.usage.output, gateReport: gate });
		log(renderGate(gate));
		if (gate.ok) break;

		lastGateText = `failed step: ${gate.failedStep}\n${gate.steps.find((s) => !s.ok)?.output ?? ""}`;
		o.ledger.transitionUnit(o.unitId, "implementing", `gate failed: ${gate.failedStep}`);

		// the reviewer could not judge (its model is down): not the code's fault, so no attempt burned and no triage
		if (gate.failedStep === "wired_ok" && !reviewJudged) {
			// a regate counted no attempt: nothing to give back, and the review runs again on the same code
			if (regateOnly) regate = true;
			else attemptNo--;
			if (++reviewErrors >= 3) {
				await providerDown(`The reviewer of ${o.unitId} could not judge ${reviewErrors} times in a row (model ${o.config.models.escalate.id}):\n${gate.steps.find((s) => !s.ok)?.output.slice(0, 500) ?? ""}`);
				break;
			}
			continue;
		}
		reviewErrors = 0;

		// build or lint errors only in the unit's own test files: the implementer may not edit them, so the tester fixes
		// them (behaviour unchanged) and the gate runs again on the same code; the try is not counted (a few times per run).
		// A fix that changed no test goes on to triage as usual
		if ((gate.failedStep === "build_ok" || gate.failedStep === "lint_ok") && testsOnlyRounds < MAX_TESTS_ONLY_ROUNDS && !o.stopped?.()) {
			const out = gate.steps.find((s) => !s.ok)?.output ?? "";
			const own = await ownTests(o.ledger, o.unitId, targetProjectDir, testFiles.map((t) => t.path), adapter.toolchain.ignoredPaths);
			const named = filesNamed(out, targetProjectDir, adapter.layout.sourceExtensions);
			if (named.length && named.every((f) => own.some((t) => samePath(f, t)))) {
				testsOnlyRounds++;
				log(pc.yellow(`  ${gate.failedStep} fails only in the unit's own test files: the tester fixes them, this round uses no try (${testsOnlyRounds}/${MAX_TESTS_ONLY_ROUNDS})`));
				const before = JSON.stringify(loadTests());
				if (await runTruth(`The gate's ${gate.failedStep} fails only in your test files (${named.join(", ")}); the implementer may not edit them. Fix the errors in the TEST files, behaviour unchanged; code the tests call that does not exist yet is the implementer's to write, not yours. check_ported_tests runs the same check.\n${out.slice(-4000)}`, true, { codeWritten: true })) testFiles = loadTests();
				lastRetest = { progress: JSON.stringify(loadTests()) !== before };
				if (lastRetest.progress) {
					regate = true;
					previousGate = gate;
					continue;
				}
			}
		}

		if (gate.failedStep === "wired_ok" && !reviewWeakOnly) {
			const openNow = openFindings().length;
			if (!regateOnly && openBefore !== undefined && openNow < openBefore && progressRounds < MAX_PROGRESS_ROUNDS) {
				progressRounds++;
				attemptNo--;
				log(pc.dim(`  the reviewer's open findings went from ${openBefore} to ${openNow}: getting there, this round uses no try (${progressRounds}/${MAX_PROGRESS_ROUNDS})`));
			}
			openBefore = openNow;
		}

		// the reviewer found something that must change outside the unit's files: another attempt cannot fix it.
		// The setup model first when the reviewer puts it in the setup, then one question (the resolver first); only this unit waits.
		if (gate.failedStep === "wired_ok" && reviewOutOfScope) {
			const problem = reviewOutOfScope;
			reviewOutOfScope = undefined;
			log(pc.yellow(`  the reviewer asks for changes outside the unit's files: ${reviewOutOfScopeSetup ? "setup fixer, else " : ""}a question`));
			const parked = await outOfScopeRoute(problem, reviewOutOfScopeSetup);
			if (parked) return parked;
		}

		// another model says the TESTS are wrong: the tester re-checks them against the legacy code first, and its
		// answer goes into the implementer's next prompt (disputes and weak tests twice per unit each; then triage decides as usual)
		const disputeNote = disputes.length && gate.failedStep === "ported_tests_green" && disputeRounds < 2 ? `The implementer disputes these tests:\n${disputes.map((d) => `- ${d.test}: ${d.why}\n  evidence: ${d.evidence}`).join("\n")}` : "";
		// the weak-tests note waits while the same review has code findings: the implementer changes the code first, and a
		// later review that finds only weak tests sends it (the tester and the implementer never change things in one round)
		const weakDrove = !!reviewWeak && reviewWeakOnly && testRounds < 2;
		if (reviewWeak && !reviewWeakOnly && testRounds < 2) log(pc.dim("  weak tests held back: the code findings come first"));
		const testsNote = [disputeNote, weakDrove ? `The reviewer finds these tests too weak (they do not really check the legacy behaviour):\n${reviewWeak}` : ""].filter(Boolean).join("\n\n");
		disputes = [];
		reviewWeak = undefined;
		// weak tests only: the implementer's code was fine and is kept; after the retest the gate re-runs on it (no new attempt)
		if (weakDrove && gate.failedStep === "wired_ok" && reviewWeakOnly) regate = true;
		if (testsNote) {
			if (disputeNote) disputeRounds++;
			if (weakDrove) testRounds++;
			const stronger = weakDrove && weakStuck;
			if (stronger) log(pc.dim(`  the last weak-tests round changed no test: this one runs on ${o.config.models.escalate.id}`));
			// a dispute and a weak-tests round are counted apart: the weak-tests rounds are most of them
			if (disputeNote) o.ledger.addEvidence(o.unitId, "test_disputed", { note: disputeNote.slice(0, 2000) });
			if (weakDrove) o.ledger.addEvidence(o.unitId, "tests_weak", { note: testsNote.slice(0, 2000) });
			log(pc.yellow(`  the tests are questioned by another model: the tester re-checks them against the legacy code`));
			await retest(`${testsNote}\n\nRe-check each against the legacy code (source_symbol_body, read_function, run it on the old code). Where the other model is right, fix the test and its truth case; where it is wrong, keep the test. End with one line per test: "<test>: fixed — …", "<test>: kept — <why>" (the other model is wrong), or "<test>: could not — <why>" (it is right, but you could not rewrite the test). The implementer reads your answer.`, { disputeText: disputeNote || undefined, stronger });
			lastGateText += `\n\n## The tester re-checked the questioned tests\n${lastTesterText.slice(-2000)}`;
			// a stopping run had no tester round: its answer and its rounds stay as they were
			if (weakDrove && !o.stopped?.()) {
				const answer = lastTesterText.split("\n");
				// the answer label right after the test name ("<test>: kept — <why>"), so the wording of a reason never changes how a line is classed
				const label = (l: string, word: string) => l.match(/:\s*(fixed|kept|could not)\b/i)?.[1]?.toLowerCase() === word;
				const couldNot = (l: string) => label(l, "could not");
				// only a round that changed a test counts toward the waiver; one that changed nothing goes the normal red
				// path, and the next weak-tests round runs on the escalate model
				const progress = !!lastRetest?.progress;
				weakStuck = !progress;
				// the tests it kept, with its reasons, go to the next review: a kept test is called weak again only with a reason.
				// A test it could not rewrite is no reasoned "kept": it never reaches the reviewer as one and blocks the waiver
				o.ledger.updateUnit(o.unitId, {
					meta: {
						...(progress ? { weakRounds: ++weakRounds } : {}),
						testerKept: answer.filter((l) => label(l, "kept")).join("\n").slice(-2000) || undefined,
						testerCouldNot: answer.filter(couldNot).join("\n").slice(-2000) || undefined,
					},
				});
			}
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
			// a retest counts for the gate right after it, and after that as long as the finding stays the same
			const afterRetest = lastRetest;
			if (!sameFinding(gate, previousGate)) lastRetest = undefined;
			triage = await triageGate({ ledger: o.ledger, config: o.config, client: o.client, root: o.root }, o.unitId, gate, previousGate, attemptNo, afterRetest);
			// only the tests were called weak (the code is fine): an implementer try has nothing to fix, so a retry or an
			// escalation goes to the tester instead (its retest re-runs the gate on the same code). Not after a retest that
			// changed nothing: another one would not help either, so triage's choice stands
			const toTester = weakOnly && !(afterRetest && !afterRetest.progress) && (triage.action === "retry" || triage.action === "escalate");
			if (toTester) triage = { ...triage, action: "retest", cause: "test_bug", reason: `${triage.reason}; but only the tests are called weak: the tester re-checks them` };
			log(pc.dim(`  triage: ${triage.cause} → ${triage.action} (${triage.reason}; conf ${triage.confidence.toFixed(2)}${triage.sure ? "" : ", unsure"})`));
			if (triage.action === "quarantine") break;
			// triage's retest (it never picks one after a retest that did not help)
			const failed = gate;
			const triageRetest = async () => {
				if (triage?.action !== "retest") return;
				if (failed.testImported?.length) await retest(`The gate's layout check (structure_ok) fails on ${failed.testImported.join(", ")}, a path your ported tests import. The implementer cannot change tests, so it can never pass: rename or move the test files and change their imports (and interface.md) to paths the layout below allows, behaviour unchanged. check_ported_tests with code_files checks the new paths.\n${lastGateText}\n\n${adapter.layout.structureDoc}`);
				else await retest(`The gate failed with ${failed.failedStep}; Jev judged the cause as ${triage.cause}. Re-check interface.md and the ported tests against the legacy behaviour and the implementation at ${targetRel}/${moduleDir}/; fix the TESTS/INTERFACE, not production code.\n${lastGateText}`);
				// only the tests were called weak (the code was fine): the gate re-runs on the same code, no implementer
				// session with nothing to fix (not from a regate pass: that one goes on to a real attempt)
				if (failed.failedStep === "wired_ok" && reviewWeakOnly && !regateOnly) regate = true;
			};
			// the same step failed again: another blind attempt rarely helps — find out why first (once per step)
			const stuck = triage.action !== "ask_human" && !toTester && previousGate?.failedStep === gate.failedStep && !diagnosed.has(gate.failedStep ?? "");
			if (stuck) diagnosed.add(gate.failedStep ?? "");
			if (triage.action === "ask_human" || stuck) {
				// Before bothering a human: find out why. Certain/plausible code- or test-side causes are retried
				// automatically (capped); setup gaps become one exact command the human is told about.
				const failedOut = gate.steps.find((x) => !x.ok)?.output ?? "";
				const dx = await diagnoseFailure({ config: o.config, adapter, projectDir: targetProjectDir, failedStep: gate.failedStep ?? "", output: failedOut, client: o.client });
				log(pc.dim(`  doctor (${dx.by}): ${dx.action} — ${dx.summary}`));
				// the doctor puts the fault in the unit's own tests or code; a retest that did not help is never followed by another
				const codeFault = dx.action === "retest" || dx.action === "reimplement";
				const noRetest = !!afterRetest && (sameFinding(gate, previousGate) || !afterRetest.progress);
				// the same anti-gaming red twice is not the model's fault (triage says so): no doctor's retry runs the remaining tries
				const notTheModel = triage.action === "ask_human" && gate.failedStep === "antigaming_ok";
				if (codeFault && !notTheModel && doctorActions < 2 && !(dx.action === "retest" && noRetest)) {
					doctorActions++;
					if (triage.action === "escalate") forceEscalate = true;
					if (dx.action === "retest") await retest(`The gate failed with ${gate.failedStep}: ${dx.summary}. ${dx.note ?? ""} Fix the TESTS, not production code.\n${lastGateText}`);
					else {
						lastGateText += `\n\nDiagnosis: ${dx.summary}. ${dx.note ?? ""}`;
						// triage chose a retest: the doctor's other verdict does not drop it
						if (!noRetest) await triageRetest();
					}
					previousGate = gate;
					continue;
				}
				// the doctor's actions are used up (or its retest would repeat one that did not help): a fault in the unit's own code or tests never becomes an owner question.
				// The stronger model gets the diagnosis; the attempt cap quarantines the unit after that.
				// Only an environment cause (triage's) still goes to the setup model and then the owner.
				if (codeFault && triage.cause !== "env") {
					lastGateText += `\n\nDiagnosis: ${dx.summary}. ${dx.note ?? ""}`;
					if (!forceEscalate) log(pc.dim(`  the doctor's actions are used up: the stronger model tries with the diagnosis`));
					forceEscalate = true;
					if (!noRetest) await triageRetest();
					previousGate = gate;
					continue;
				}
				// a setup problem of the new project: the setup model fixes it first; the owner only when it cannot
				let setupTried = "";
				const setupFixer = o.setupFixer === false ? undefined : (o.setupFixer ?? (o.spawn ? undefined : fixSetupWithModel));
				// never for anti-gaming: scope or test tampering is no setup gap, the setup model only re-sets what works
				if (setupFixer && gate.failedStep !== "antigaming_ok" && (dx.action === "fix" || triage.cause === "env")) {
					const fixed = await fixRunSetup({ config: o.config, root: o.root, adapter, projectDir: projectDir(o.config, stackId), fixer: setupFixer, ledger: o.ledger, lock: o.mergeLock, unitId: o.unitId, signature: errorSignature(gate.failedStep ?? "", failedOut), problem: `Gate step ${gate.failedStep} failed for unit ${o.unitId} (code in ${moduleDir}/). Diagnosis: ${dx.summary}${dx.command ? ` (suggested: ${dx.command})` : ""}. Fix the project setup, not the unit's code.\nThe unit works in its own git worktree (${targetProjectDir}); these dependency dirs are linked into it from the main project: ${linkedDirs(adapter, o.root).join(", ") || "none"}. Tools that resolve real paths (autoloaders, module resolution) then see the main project's code, not the worktree's: set_worktree_copy gives every later worktree a copy instead.\nGate output tail:\n${failedOut.slice(-3000)}` }).catch((e) => (log(pc.yellow(`  setup fix failed: ${e?.message ?? e}`)), undefined));
					if (fixed) {
						// parked without a question: the scheduler resubmits it on the fixed main (fresh worktree)
						o.ledger.updateUnit(o.unitId, { meta: { parked: { diagnosis: { summary: `the project setup was fixed (${fixed})`, note: dx.summary } } } });
						log(pc.cyan(`  setup fixed by the model: ${fixed} — the unit runs again`));
						return { unitId: o.unitId, state: o.ledger.getUnit(o.unitId)!.state, attempts: attemptNo, gate, triage, costUsd: cost };
					}
					setupTried = " The setup model tried and could not fix it.";
				}
				if (triage.action !== "ask_human") {
					// stuck, but nothing to heal here and nobody to ask: go on as triage said (the attempt cap still holds)
					lastGateText += `\n\nDiagnosis: ${dx.summary}. ${dx.note ?? ""}`;
					if (triage.action === "escalate") forceEscalate = true;
					if (!noRetest) await triageRetest();
					previousGate = gate;
					continue;
				}
				// doctor and setup model could not help: now a person is asked, once, with the diagnosis (phrased by a model)
				const qid = await ask({
					point: "gate_env",
					sameAs: signature,
					facts: `Gate step ${gate.failedStep} of ${o.unitId} failed on attempt ${attemptNo}. Diagnosis (${dx.by}): ${dx.summary}.${setupTried}${dx.command ? ` Fix command: \`${dx.command}\` in ${targetRel || "."}.` : ""} The unit resubmits itself when the target project or the config changes.\nGate output tail:\n${failedOut.slice(-1200)}`,
					options: [
						{ value: "retry", facts: dx.command ? `run it again (after you ran ${dx.command})` : "run it again (after you fixed the environment)" },
						{ value: "leave", facts: "leave the unit parked for a human" },
					],
					context: { diagnosis: dx, failedStep: gate.failedStep },
				});
				// remember the environment the failure happened in: a change (package.json/config) resubmits the unit
				o.ledger.updateUnit(o.unitId, { meta: { parked: { question: qid, env: envFingerprint(o.config, projectDir(o.config, stackId), adapter.toolchain.manifestFiles, setupFiles(o.root, stackId)), diagnosis: dx } } });
				log(pc.yellow(`  waiting for human question #${qid} — other units keep running`));
				return { unitId: o.unitId, state: o.ledger.getUnit(o.unitId)!.state, attempts: attemptNo, gate, triage, costUsd: cost };
			}
			if (triage.action === "escalate") forceEscalate = true;
			await triageRetest();
		}
		previousGate = gate;
	}

	if (gate?.ok) {
		// the weak-tests count is for this round of the unit: a re-opened unit's new tests get their tester rounds again
		if (weakRounds || unitMeta().testerKept || unitMeta().testerCouldNot) o.ledger.updateUnit(o.unitId, { meta: { weakRounds: 0, testerKept: undefined, testerCouldNot: undefined } });
		// The new code is now part of what later units can reuse: index it (exports, helpers, docs).
		const indexed = await indexTarget(o.ledger, adapter, targetProjectDir, gate.changedFiles).catch((e) => (log(pc.yellow(`  target index failed: ${e?.message ?? e}`)), 0));
		log(pc.dim(`  indexed ${indexed} target symbols`));
		// reusable logic becomes findable by meaning (capability cards; no-op without a client)
		const caps = await describeCapabilities(askDeps, { unitId: o.unitId, stack: stackId, area, files: gate.changedFiles, projectDir: targetProjectDir }).catch((e) => (log(pc.yellow(`  capability cards failed: ${e?.message ?? e}`)), { cards: 0, costUsd: 0 }));
		cost += caps.costUsd;
		if (caps.cards) log(pc.dim(`  ${caps.cards} capability card(s)`));
		o.ledger.transitionUnit(o.unitId, "review", "gate green");
		if (o.accept) {
			await acceptUnit(o, targetProjectDir, area);
			await afterAccept(o.ledger, adapter, targetProjectDir, stackId, area, log);
		}
	} else if (attemptNo >= maxTotal || triage?.action === "quarantine") {
		o.ledger.transitionUnit(o.unitId, "quarantined", `gate still red after ${attemptNo} attempts (${gate?.failedStep}); ${triage?.reason ?? ""}`.trim());
	}
	const final = o.ledger.getUnit(o.unitId)!;
	return { unitId: o.unitId, state: final.state, attempts: attemptNo, gate, triage, costUsd: cost };
}

export async function acceptUnit(o: { ledger: Ledger; config: Config; unitId: string }, targetProjectDir: string, area: string): Promise<string | undefined> {
	const sha = await commitAll(o.config.target.path, `feat(${area}): migrate ${o.unitId}\n\n${o.ledger.symbolsOfUnit(o.unitId).map((s) => `- ${s.id} → ${s.state}`).join("\n")}\n\nbigrefactor: unit ${o.unitId}, target ${relative(o.config.target.path, targetProjectDir) || "."}`);
	o.ledger.transitionUnit(o.unitId, "accepted", sha ? `committed ${sha.slice(0, 7)}` : "accepted (nothing new to commit)");
	if (sha) o.ledger.updateUnit(o.unitId, { branch: await mainBranch(o.config.target.path, o.config.target.git.branch), meta: { ...JSON.parse(o.ledger.getUnit(o.unitId)!.meta), commit: sha } });
	return sha;
}

/** After a unit landed in `projectDir`: close tidy tasks the tree shows done, record the stack's drift report. */
export async function afterAccept(ledger: Ledger, adapter: TargetAdapter, projectDirAbs: string, stackId: string, area: string, log: (l: string) => void): Promise<void> {
	const done = completeTidyTasks(ledger, projectDirAbs, stackId, area);
	if (done.length) log(pc.dim(`  tidy done: ${done.join(", ")}`));
	const drift = await recordDrift(ledger, adapter, projectDirAbs);
	if (drift.length) log(pc.dim(`  drift ${stackId}: ${drift.length} finding(s) (br layout)`));
}

/** The workspace files a setup fix changes: the stack's command overrides and its fixes log. */
export function setupFiles(root: string, stackId: string): string[] {
	return [overridesPath(root, stackId), setupLogPath(root, stackId)];
}

/**
 * What a parked environment failure depends on: the target's dependency manifests (adapter-declared), the workspace
 * config and the stack's gate commands. Not the setup fixes log: a fix for another problem must not wake every
 * parked unit (a fix for the unit's own problem answers its question already).
 */
export function envFingerprint(config: Config, projectDir: string, manifestFiles: string[], setup: string[] = []): string {
	setup = setup.filter((f) => !f.endsWith(".fixes.log")); // see setupLogPath
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
 * before the project-relative part (workspace, worktree), or be relative to an allowed dir.
 */
export function draftedOutside(md: string, allowedDirs: string[], targetRel: string, existingRoots: string[]): string[] {
	const out = new Set<string>();
	for (const m of md.matchAll(/(?:^|[\s`'"(\[])((?:\.\/)?(?:[\w@.-]+\/)+[\w.-]+\.[A-Za-z]{1,5})(?=$|[\s`'"),:\]#])/gm)) {
		let p = m[1]!.replace(/^\.\//, "");
		if (targetRel && p.startsWith(`${targetRel}/`)) p = p.slice(targetRel.length + 1);
		// an existing file named relative to the unit's own folder ("components/List.tsx" in src/features/x/) is inside it
		if (p.startsWith("..") || allowedDirs.some((d) => p.startsWith(d) || p.includes(`/${d}`)) || existingRoots.some((r) => existsSync(join(r, p)) || existsSync(join(r, m[1]!)) || allowedDirs.some((d) => existsSync(join(r, d, p))))) continue;
		out.add(p);
	}
	return [...out];
}


/** The unit's truth as recorded now: cases run on the old code, cases read from it, the tester's "no behaviour" reason. */
function truthCounts(ledger: Ledger, unitId: string): { truthCases: number; truthRead: number; noBehaviour?: string } {
	const n = (run: number) => (ledger.db.prepare("SELECT COUNT(*) n FROM truth_cases WHERE unit_id = ? AND verified_on_old = ?").get(unitId, run) as { n: number }).n;
	return { truthCases: n(1), truthRead: n(0), noBehaviour: noBehaviour(ledger, unitId) };
}

/** The old code's file kinds a new name must not carry, minus the new stack's own file types (php in a PHP → Symfony migration). */
export function legacyWordsFor(words: string[] | undefined, target: TargetAdapter): string[] | undefined {
	const own = new Set(target.layout.sourceExtensions.map((e) => e.replace(/^\./, "").toLowerCase()));
	return words?.filter((w) => !own.has(w));
}

/** Which of `paths` (relative to `dir`) main's history ever held; none when `dir` is not in a git checkout. */
export async function everOnMain(dir: string, paths: string[]): Promise<Set<string>> {
	if (!paths.length) return new Set();
	try {
		const out = await exec("git", ["log", "--format=", "--name-only", "--no-renames", "--relative", "HEAD", "--", ...paths], { cwd: dir, maxBuffer: 64 << 20 });
		return new Set(out.split("\n").filter(Boolean));
	} catch {
		return new Set();
	}
}

/** Files interface.md names in the unit's own folder that do not exist yet: the paths the implementer must create. */
export function interfaceCodeFiles(md: string, targetRel: string, moduleDir: string, dir: string): string[] {
	const out = new Set<string>();
	for (const m of md.matchAll(/(?:^|[\s`'"(\[])((?:\.\/)?(?:[\w@.-]+\/)+[\w.-]+\.[A-Za-z]{1,5})(?=$|[\s`'"),:\]#]|\.(?:\s|$))/gm)) {
		let p = m[1]!.replace(/^\.\//, "");
		if (targetRel && p.startsWith(`${targetRel}/`)) p = p.slice(targetRel.length + 1);
		if (p.startsWith(`${moduleDir}/`) && !existsSync(join(dir, p))) out.add(p);
	}
	return [...out];
}
