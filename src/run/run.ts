import { forecast, renderForecastLine } from "./forecast.ts";
import { execFile } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statfsSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { linkedDirs, loadCommandOverrides, noteFix, setupLogPath } from "../adapters/command-overrides.ts";
import { fixRunSetup, fixSetupWithModel, type NoFix, type SetupFixer } from "../init/setup-fixer.ts";
import type { QuestionRow } from "../ledger/schema.ts";
import { buildRedKey, createBuilder, createMergeCheck, filesNamed, keepBuilderLine, type Repairer } from "./builder.ts";
import { createPusher } from "./push.ts";
import { diagnoseFailure } from "./doctor.ts";
import pc from "picocolors";
import { progress } from "../progress.ts";
import { loadSpend, paidSince } from "../spend.ts";
import { setStep, startWatchdog } from "./watchdog.ts";
import { gateSlots, loadConfig, type Config } from "../config.ts";
import { ensureLedgerIndexes } from "../ledger/indexes.ts";
import { addWorktree, claimMainBranch, emptyWorktreeTrash, headOf, isRepo, mainBranch, removeWorktree, deleteBranch, wsBranch } from "../git.ts";
import { projectDir } from "../init/init.ts";
import { getSourceAdapter, getTargetAdapter } from "../adapters/registry.ts";
import { probeLegacyEnv, type ProbeAnswer, type ProbeAsker } from "./legacy-env.ts";
import { resolveChoices } from "../init/stack.ts";
import { indexTarget } from "../inventory/target.ts";
import { applySlicePlan, blockingOrder, planSlices, renderSlicePlan, type SliceOverrides } from "../inventory/slices.ts";
import type { Ledger } from "../ledger/db.ts";
import type { ModelClient } from "../models/types.ts";
import { Semaphore } from "./pool.ts";
import { decide } from "../jev/decide.ts";
import { SYSTEMIC_FAILURE, JEV_ACT, noulOf } from "../jev/questions.ts";
import { applyPlacementAnswers, placementDir, placeUnit, renameMisspelledAreaDirs, resolvePlacements, unplacedReason } from "./placement.ts";
import { syncTaxonomyAnswers } from "./taxonomy.ts";
import { maybeCurateRules } from "../rules/living.ts";
import { answerValue, askViaModel, decideOpenFromGoals, HINT } from "../jev/ask.ts";
import { MODEL_ANSWERERS, RESOLVER, resolveOpenQuestions, resolveWithModel, waitersOf, type Resolver } from "../jev/resolve.ts";
import { checkLayout, renderTrees, sampleFacts, scanTree } from "./layout-check.ts";
import { maybeTidyReview } from "./tidy.ts";
import { findTests, warmMainCache } from "./ported.ts";
import type { TargetAdapter } from "../adapters/types.ts";
import { createTidyJobs } from "./tidy-job.ts";
import { runCodeJob } from "./code-job.ts";
import { createStubSweep, resolveOwnersWithModel } from "./stub-sweep.ts";
import { finishCheck, finishDue, lastFinish, renderFinishLine } from "./finish-check.ts";
import { createCleaner } from "./cleanup.ts";
import { MAX_PARITY_REOPENS, resumeShared, runSharedJob, sharedCauses, sharedJobText } from "./parity-judge.ts";
import { routeOwners } from "./parity-check.ts";
import { afterAccept, envFingerprint, errorSignature, runUnit, setupFiles, type ApprovedReview, type UnitRunOptions, type UnitRunResult } from "./unit.ts";
import { clipOutput, conflictMarkers, verdictsAtMerge, wholeProjectSteps } from "./gate.ts";
import { isWiringFile } from "../rules/layout-rules.ts";
import { spawnLeaf } from "../sessions/spawn.ts";
import { exec } from "../proc.ts";

/**
 * The scheduler: many agent sessions, few gate workers, one merge at a time.
 *
 *  ready(unit)  = planned ∧ not stale ∧ not waiting on a question ∧ every dep accepted (merged)
 *  priority     = (best sliceRank among the units waiting on it, units it blocks desc, id) — blockingOrder
 *  isolation    = one git worktree per running unit under .bigrefactor/worktrees/<unit> (outside the repo),
 *                 dependency dirs symlinked from the main project; accept = rebase onto the main branch, ff-merge
 *  recovery     = attempts left open by a crash are closed as aborted at start; their units go back to planned
 */
export interface SchedulerOptions {
	ledger: Ledger;
	config: Config;
	root: string;
	client?: ModelClient;
	/** Only these units (and nothing else). */
	units?: string[];
	/** Only units of this slice. */
	slice?: string;
	/** Stop after this many accepted units (pilot). */
	limit?: number;
	dry?: boolean;
	log?: (line: string) => void;
	/** Lane status after every scheduling pass: how many run, how many could, and why nothing new starts (if so). */
	onLanes?: (l: { running: number; max: number; ready: number; ahead: number; reason?: string }) => void;
	/** What the run waits on while no unit runs (start checks, a shared fix, the final build); undefined when done. */
	onWait?: (what: string | undefined) => void;
	/** Fill idle lanes with truth-ahead work (tester only) for units still waiting on deps. Default: on unless a limit is set. */
	truthAhead?: boolean;
	/** Host-driven drain (Pi's /br stop): when true (or a reason), running units finish and no new ones start. */
	shouldStop?: () => boolean | string;
	/** Install the ctrl-c drain handler (CLI). A host with its own ctrl-c (Pi) passes false. Default true. */
	handleSigint?: boolean;
	/**
	 * Units blocked by open decisions (unit id → decision ids), re-read every scheduling loop so an answer
	 * releases its units mid-run. See src/run/decisions-gate.ts.
	 */
	blocked?: () => Map<string, string[]> | Promise<Map<string, string[]>>;
	/** When only decision-blocked units are left: wait for answers (Pi asks them on the side) instead of ending. */
	waitForDecisions?: boolean;
	/** Start despite layout problems (br run --force). The layout preflight is skipped in simulations (spawn injected). */
	force?: boolean;
	/** Layout review after this many accepted units (0 = off). Default: config.run.sampleSize, else 10. */
	sample?: number;
	/** Injection points (simulation). */
	spawn?: UnitRunOptions["spawn"];
	gate?: UnitRunOptions["gate"];
	/** Heals shared setup failures (circuit breaker, gate failures); default the setup model, none when `spawn` is faked. */
	setupFixer?: SetupFixer | false;
	/** Fixes whole-project check failures after merges; default: the big model (none when `spawn` is faked). */
	builderRepair?: Repairer | false;
	/** Tries open questions before the owner sees them (default: a model with read tools; off with a test spawn). */
	resolver?: Resolver | false;
}

export interface SchedulerResult {
	ran: UnitRunResult[];
	accepted: number;
	quarantined: number;
	waiting: number;
	costUsd: number;
}

export async function runScheduler(o: SchedulerOptions): Promise<SchedulerResult> {
	// a step that holds the run's event loop over a second is written to .bigrefactor/blocked.log (slow stops and IPC to Pi)
	const stopWatchdog = startWatchdog(o.root, (l) => (o.log ?? console.log)(pc.yellow(l)));
	try {
		return await schedule(o);
	} finally {
		stopWatchdog();
	}
}

async function schedule(o: SchedulerOptions): Promise<SchedulerResult> {
	process.env["BR_WORKSPACE"] = o.root; // the stacks' layout.json lives in this workspace
	const log = o.log ?? ((l: string) => console.log(l));
	const { ledger, config } = o;
	// the spend log (many MB) is read in slices up front: the budget check below then reads only new lines
	await loadSpend(o.root).catch(() => undefined);
	// an index build writes: it runs in a worker before the run's first write, so neither holds Pi's thread
	if (!o.dry) await ensureLedgerIndexes(join(o.root, ".bigrefactor", "ledger.sqlite"));
	// a long step with no unit running: the host shows it with a timer, so the run never looks frozen
	const waitOn = async <T>(what: string, step: () => Promise<T>): Promise<T> => {
		setStep(what);
		o.onWait?.(what);
		try {
			return await step();
		} finally {
			o.onWait?.(undefined);
		}
	};

	{
		// a run that never got to its end (Pi closed, the run process killed) is written down from the ledger now
		setStep("writing down the last run");
		const lost = o.dry ? undefined : recordLostRun(ledger, o.root);
		const prev = lastRun(ledger);
		if ((prev?.outcome === "stopped" || lost) && !o.dry) log(pc.dim(renderLastRun(prev!)));
	}

	// ---- the project must match the stack choices (a mismatch fails every unit's gate the same way)
	if (!o.dry) {
		for (const id of config.target.stacks) {
			const adapter = await getTargetAdapter(id);
			const chosen = resolveChoices(adapter, config.target.choices).map((c) => ({ key: c.choice.key, id: c.option.id, packages: c.option.packages }));
			const problems = adapter.verifyChoices?.(projectDir(config, id), chosen) ?? [];
			const fatal = problems.filter((p) => p.everyUnit);
			// never a stop: the setup model installs what is missing; units that still fail park on it
			if (fatal.length) {
				const text = fatal.map((p) => p.text).join("\n  ");
				log(pc.red(`${id}: the project does not match the stack choices:\n  ${text}\n  the setup model fixes it; units that need it park until it is fixed (br decide changes a choice)`));
				if (o.setupFixer !== false && !(!o.setupFixer && o.spawn))
					await fixRunSetup({ config, root: o.root, adapter, projectDir: projectDir(config, id), fixer: o.setupFixer || fixSetupWithModel, ledger, signature: "stack choices", problem: `The project does not match the owner's stack choices:\n${text}` }).catch((e) => log(pc.yellow(`${id}: setup fix failed: ${e?.message ?? e}`)));
			}
			for (const p of problems.filter((x) => !x.everyUnit)) log(pc.yellow(`${id}: ${p.text}${p.fix ? ` — fix: ${p.fix}` : ""} (units that need it will park until it is installed)`));
		}
	}

	// ---- slices: computed once per inventory, stored in unit meta
	if (!ledger.getMeta("slice_plan") || o.dry) {
		const plan = planSlices(ledger, loadOverrides(o.root));
		applySlicePlan(ledger, plan);
		log(renderSlicePlan(plan));
	}

	// ---- crash recovery
	setStep("crash recovery");
	const open = ledger.db.prepare("SELECT id, unit_id FROM attempts WHERE ended_at IS NULL").all() as Array<{ id: number; unit_id: string }>;
	for (const a of open) {
		ledger.endAttempt(a.id, { outcome: "aborted:crash" });
		const u = ledger.getUnit(a.unit_id);
		if (u && ["truth", "implementing", "gating"].includes(u.state)) {
			ledger.db.prepare("UPDATE units SET state = 'planned', updated_at = ? WHERE id = ?").run(new Date().toISOString(), a.unit_id);
			ledger.clearStale(a.unit_id);
			ledger.db.prepare("INSERT INTO transitions(entity, entity_id, from_state, to_state, reason, created_at) VALUES ('unit', ?, ?, 'planned', 'crash recovery: attempt left open', ?)").run(a.unit_id, u.state, new Date().toISOString());
			await removeWorktree(config.target.path, worktreeDir(o.root, a.unit_id));
		}
	}
	if (open.length) log(pc.yellow(`recovered ${open.length} attempt(s) left open by a previous run`));
	// accepted with no wiring verdict (no reviewer ran then): back for the reviewer's judgement, code kept
	if (!o.dry && !o.spawn) {
		const { reopenUnjudgedWiring } = await import("./recheck.ts");
		const back = reopenUnjudgedWiring(ledger);
		if (back.length) log(pc.yellow(`${back.length} accepted unit(s) never had their wiring judged: back to planned (code kept) for the reviewer`));
	}
	// ---- truth: can the old code run here? decided once per workspace (run → truth from running it, read → from reading it)
	if (!o.dry && !o.spawn) {
		await waitOn("checking whether the old code runs here", () => probeLegacyEnv({
			config,
			root: o.root,
			source: getSourceAdapter(config.source.stack),
			log,
			// a red probe asks the owner once, blocking nothing: "retry" makes the next run probe again
			ask: async (q) => (await askViaModel({ ledger, config, root: o.root, client: o.client }, { point: "truth_probe", facts: q.facts, options: q.options, recommended: q.recommended, blocks: "none", askedBy: "orchestrator" })).id,
			answer: (id) => answerValue(ledger.getQuestion(id)?.answer),
		})).catch((e) => log(pc.yellow(`truth probe failed: ${e?.message ?? e} (units try running the old code one by one)`)));
		// truth written from reading the old code: its scripts run again once the old code's environment changed (units not
		// accepted here, before a lane takes them; accepted ones on the side once the lanes run)
		const { upgradeReadTruth } = await import("./recheck.ts");
		await waitOn("running read-only truth on the old code again", async () => await upgradeReadTruth({ ledger, config, root: o.root, states: ["planned", "quarantined"], cap: config.run.truthUpgradesPerRun, stopped: () => !!o.shouldStop?.(), log })).catch((e) => log(pc.yellow(`truth upgrade failed: ${e?.message ?? e}`)));
	}
	// ---- stack knowledge written before the plugin asked for it (notApp, wiringFiles): a model adds just that
	if (!o.dry && !o.spawn) {
		const { healStackKnowledge } = await import("./stack-heal.ts");
		await waitOn("updating stack knowledge", () => healStackKnowledge({ ledger, config, root: o.root, client: o.client, log })).catch((e) => log(pc.yellow(`stack knowledge not updated: ${e?.message ?? e}`)));
		// a target file type no grammar reads: a model says once how its comments are written (the comment-only check)
		const { learnCommentSyntax } = await import("./comment-only.ts");
		await waitOn("learning comment syntax", async () => learnCommentSyntax({ ledger, client: o.client, model: config.models.implement.id, adapters: await Promise.all(config.target.stacks.map((id) => getTargetAdapter(id))) })).catch((e) => log(pc.yellow(`comment syntax not learned: ${e?.message ?? e}`)));
		// accepted units that left a file with only comments on main (before the gate refused them) go back to planned
		const { reopenCommentOnly } = await import("./drop-check.ts");
		await waitOn("looking for files with only comments", () => reopenCommentOnly({ ledger, config, log })).catch((e) => log(pc.yellow(`files with only comments not checked: ${e?.message ?? e}`)));
	}
	// ---- placement: every planned unit gets its stack + area before anything runs (code → Jev → question)
	if (!o.dry) await waitOn("placing units: picking each unit's stack and folder", () => resolvePlacements({ ledger, config, root: o.root, client: o.client, log: (l) => log(pc.dim(l)) }));
	// ---- layout preflight: one folder per legacy file must be caught before a run scales it
	if (!o.dry && await isRepo(config.target.path)) {
		const { resetForNewTarget } = await import("./target-reset.ts");
		const back = await resetForNewTarget(ledger, config, o.root);
		if (back) log(pc.cyan(`↻ the target project was created anew: ${back.length} unit(s) worked on before go back to planned; questions about the old project are dropped`));
	}
	if (!o.dry && !o.spawn) {
		const { refreshRulesLayout } = await import("../rules/living.ts");
		for (const s of await refreshRulesLayout({ ledger, root: o.root }, config.target.stacks)) log(pc.dim(`${s}: RULES.md layout section re-rendered from the stack adapter`));
		const lr = await waitOn("checking the target folder layout", () => checkLayout(config, o.root, ledger));
		for (const w of lr.warnings) log(pc.yellow(`layout: ${w}`));
		// never a stop: shown, and the tidy jobs and units work against the layout from here on (br layout shows the details)
		for (const p of lr.problems) log(pc.red(`layout: ${p} (br layout shows the details)`));
	}
	// Parked units (state kept, attempt closed, waiting on a question) are resubmitted as soon as the cause is
	// gone: their question was answered, or — for environment failures — the target project or the stack
	// config changed since they parked. Checked at start and on every scheduling loop.
	// Quarantined units heal too: something of their stack changed since (a setup fix, the old code's environment, the plugin)
	// → back into the queue, every hour or sooner, up to run.maxAutoHeals times; then the owner is asked.
	let askingStuck: Promise<unknown> | undefined;
	// app code a unit needs outside its files: a code model writes it on main with tests (the stack the resolver names, else the unit's)
	const codeJob = o.setupFixer === false || (!o.setupFixer && o.spawn) ? undefined : async (q: QuestionRow, what: string, stack?: string) => {
		const unit = q.unit_id ? ledger.getUnit(q.unit_id) : undefined;
		const stackId = stack && config.target.stacks.includes(stack) ? stack : unit ? placeUnit(config, unit.meta, o.root).stackId : config.target.stacks.length === 1 ? config.target.stacks[0] : undefined;
		const adapter = stackId ? adapters.get(stackId) : undefined;
		if (!adapter) return undefined;
		let merged: string | undefined;
		let refused: { refused: string; diff: string } | undefined;
		let locked: { files: string[]; diff: string } | undefined;
		let miss: { failed: string } | { nothing: string } | undefined;
		// the waiting unit's kept code (its last try, kept when it parked): the job starts from it and merges both
		const keptWork = unit ? (JSON.parse(unit.meta) as { keptWork?: string }).keptWork : undefined;
		const unitWork = unit && keptWork ? { unitId: unit.id, apply: (wt: string) => applyCleanly(wt, keptWork) } : undefined;
		const said = await runCodeJob({ config, root: o.root, ledger, adapter, label: `q${q.id}`, linkAll, log, unitWork, forUnit: q.unit_id ?? undefined, waiting: (ledger.db.prepare("SELECT unit_id FROM question_waiters WHERE question_id = ?").all(q.id) as Array<{ unit_id: string }>).map((w) => w.unit_id), onRefused: (p, diff) => (refused = { refused: p, diff }), onLocked: (l) => (locked = l), onNothing: (s) => (miss = { nothing: s || "the code model gave no reason" }), onFailed: (f) => (miss = { failed: f }), what: `${what}\n\nThis came up as question #${q.id} (${q.point}${q.unit_id ? `, unit ${q.unit_id}` : ""}); the units waiting on it run again once your code is merged.\n${q.question}`, mergeFix: (wt, branch, msg) => merge.run(async () => {
				// withdrawn while the job ran (its unit was requeued and works on its own again): the code would land beside that work
				const now = ledger.getQuestion(q.id);
				if (now?.status === "withdrawn") throw new Error(`question #${q.id} was withdrawn while the job ran (${now.answer ?? "no reason"}), so its code is not merged`);
				return await mergeUnit(config, "code", wt, branch, "", msg);
			}).then((sha) => (pusher.afterMerge(), (merged = sha))) });
		// main holds the unit's kept code now: its next try starts from main
		if (said && unitWork && merged) ledger.updateUnit(unitWork.unitId, { meta: { keptWork: undefined } });
		// a fix on main may unblock quarantined units too, not only the ones waiting on this question
		if (said && stackId) noteFix(o.root, stackId, merged, `code job q${q.id}: ${said}`);
		// what the job wanted in the files that decide how the checks run: the setup model's to judge, with the same diff
		const setup = locked ? await lockedToSetup(adapter, stackId!, `question #${q.id}`, locked) : undefined;
		return said ?? setup ?? refused ?? miss;
	};
	/** A code job changed files that decide how the checks run (put back): the setup model gets the same change to judge. */
	const lockedToSetup = (adapter: TargetAdapter, stackId: string, why: string, l: { files: string[]; diff: string }) =>
		fixRunSetup({ config, root: o.root, adapter, projectDir: projectDir(config, stackId), fixer: o.setupFixer || fixSetupWithModel, ledger, lock: (fn) => merge.run(fn), signature: `code job wanted: ${l.files.slice(0, 5).join(", ")}`, problem: `A code job for ${why} needed a change in files that decide how the checks run (${l.files.join(", ")}). A code job may not change them, so it was put back. Judge it: make the change (or the part of it the project needs) if it is a setup change that keeps every check as strict as it is, else leave it.\nWhat the code job wrote there:\n${l.diff}` }).catch((e) => (log(pc.yellow(`  setup fix failed: ${e?.message ?? e}`)), undefined));
	let resolving: Promise<unknown> | undefined;
	/** The resolver answered something since the run last looked: parked units may run again. */
	let resolvedSome = false;
	// a question the resolver model traces to the project setup: the big setup model fixes it on main first
	const fixJob = o.setupFixer === false || (!o.setupFixer && o.spawn) ? undefined : async (q: QuestionRow, what: string, stack?: string) => {
		const unit = q.unit_id ? ledger.getUnit(q.unit_id) : undefined;
		const stackId = unit ? placeUnit(config, unit.meta, o.root).stackId : stack && config.target.stacks.includes(stack) ? stack : config.target.stacks.length === 1 ? config.target.stacks[0] : undefined;
		const adapter = stackId ? adapters.get(stackId) : undefined;
		if (!stackId || !adapter) return undefined;
		const sameAs = q.context ? (JSON.parse(q.context) as { sameAs?: string }).sameAs : undefined;
		let miss: NoFix | undefined;
		const fixed = await fixRunSetup({ config, root: o.root, adapter, projectDir: projectDir(config, stackId), fixer: o.setupFixer || fixSetupWithModel, ledger, lock: (fn) => merge.run(fn), onNoFix: (n) => (miss = n), signature: sameAs ?? `question ${q.id}`, problem: `${what}\n\nThis came up as question #${q.id} (${q.point}${q.unit_id ? `, unit ${q.unit_id}` : ""}); the units waiting on it run again once the setup is fixed. Fix the project setup, not a unit's own code.\n${q.question}${q.context ? `\nFacts:\n${JSON.stringify(JSON.parse(q.context), null, 1).slice(0, 3000)}` : ""}` });
		const m = miss as NoFix | undefined;
		return fixed ?? (m && (m.ran ? { nothing: `${m.why}${m.said ? `; the setup model said: ${m.said.slice(-800)}` : ""}` } : { failed: m.why }));
	};
	// a path the folder check keeps refusing because the layout has no slot for it: widen the layout (only more allowed)
	const layoutJob = !o.client || o.spawn ? undefined : async (q: QuestionRow, what: string, stack?: string) => {
		const unit = q.unit_id ? ledger.getUnit(q.unit_id) : undefined;
		const stackId = unit ? placeUnit(config, unit.meta, o.root).stackId : stack && config.target.stacks.includes(stack) ? stack : config.target.stacks.length === 1 ? config.target.stacks[0] : undefined;
		const adapter = stackId ? adapters.get(stackId) : undefined;
		if (!stackId || !adapter || !o.client) return undefined;
		const { layoutJob: widen } = await import("../rules/owner-layout.ts");
		const r = await merge.run(() => widen({ root: o.root, stack: stackId, adapter, words: what, client: o.client!, model: config.models.escalate.id, projectDir: projectDir(config, stackId), ledger }));
		if ("applied" in r) noteFix(o.root, stackId, undefined, `layout widened (q${q.id}): ${r.applied}`);
		return r;
	};
	const resubmitParked = async () => {
		// a slip in this pass is logged like the passes below, never the end of the run (units keep their state)
		try {
			await resubmitParkedUnits(ledger, config, o.root, new Set(running.keys()), log, adapters);
		} catch (e) {
			log(pc.yellow(`resubmitting parked units failed: ${(e as Error)?.message ?? e}`));
		}
		if (o.dry) return;
		// healing may ask the decide model, so it runs in line with the stuck questions: one pass at a time
		askingStuck ??= healQuarantined(ledger, config, o.root, new Set(running.keys()), log, adapters, { client: o.client })
			.then(() => askStuckUnits({ ledger, config, root: o.root, client: o.client }))
			.then((n) => {
				if (n) log(pc.yellow(`${n} question(s): units still failing after ${config.run.maxAutoHeals} automatic tries`));
				// parked units others wait on (or the end of the run waits on): the owner is asked, once per unit
				const p = askAboutParked(ledger);
				if (p) log(pc.yellow(`${p} parked unit(s) need you: other units wait on them, or nothing else is left to run → br questions`));
			}, (e) => log(pc.yellow(`asking about stuck units failed: ${e?.message ?? e}`)))
			.finally(() => (askingStuck = undefined));
		// open questions: a model tries each first; only what it cannot settle waits for the owner (context.forOwner)
		const resolver = o.resolver === false ? undefined : (o.resolver ?? (o.spawn ? undefined : resolveWithModel));
		if (resolver)
			resolving ??= resolveOpenQuestions({ ledger, config, root: o.root, resolver, fixJob, codeJob, layoutJob, pluginChangedAt: PLUGIN_TIME, log: (l) => log(pc.cyan(l)) })
				.then((r) => ((resolvedSome ||= r.answered > 0), r.forOwner && log(pc.yellow(`${r.forOwner} question(s) need you (the resolver model could not settle them): /br answer or br questions`))), (e) => log(pc.yellow(`resolving questions failed: ${e?.message ?? e}`)))
				.finally(() => (resolving = undefined));
	};

	// Each unit lands in the stack placement picks; a worktree holds the whole target repo, so every stack's
	// dependency dirs (adapter-declared) are linked into it.
	const adapters = new Map(await Promise.all(config.target.stacks.map(async (id) => [id, await getTargetAdapter(id)] as const)));
	// area folders the plugin now spells differently move in git first, so new units land next to the old code
	if (!o.dry && await isRepo(config.target.path)) {
		try {
			for (const m of await renameMisspelledAreaDirs(config, ledger, new Map([...adapters].map(([id, a]) => [id, a.layout])), (id) => projectDir(config, id))) log(pc.cyan(`↻ renamed ${m}`));
		} catch (e) {
			log(pc.yellow(`renaming area folders failed: ${String((e as Error)?.message ?? e).split("\n")[0]}`));
		}
	}
	const linkAll = async (wt: string) => {
		for (const [id, a] of adapters) await linkDependencies(projectDir(config, id), join(wt, relative(config.target.path, projectDir(config, id))), a.toolchain.worktreeLinks, loadCommandOverrides(o.root, id).worktreeCopy ?? []);
	};
	const placementOf = (meta: string) => placeUnit(config, meta, o.root);
	// the DB lane (one migrations folder, ordered versions) and a shared module run one unit at a time
	let perModule = config.run.unitsPerModule;
	// lanes free and the module limit the only thing holding ready units back (the end of a migration: what is ready sits
	// in one or two modules): a pass may start up to MODULE_BOOST times as many per module. The merge rounds put a clashing
	// unit's code back on the new main for another pass; the cap keeps clashes from piling up past those rounds.
	let boost = false;
	const moduleLimit = (p: { moduleKey: string; shared: boolean }) => (p.shared || p.moduleKey.endsWith(":db") ? 1 : boost ? perModule * MODULE_BOOST : perModule);
	/** Ready units held back only by the module limit, per module (from the last ready() and the pass's own starts). */
	let moduleWait = new Map<string, number>();
	await excludeFromGit(config.target.path, [...new Set([...adapters.values()].flatMap((a) => a.toolchain.ignoredPaths))]);
	const agents = new Semaphore(config.run.agentConcurrency);
	const gates = new Semaphore(gateSlots(config.run));
	// Lanes are live: `br lanes <n>` / `/br lanes <n>` edits run.agentConcurrency (and gateConcurrency; unset, the gates follow the lanes) in the
	// config; the loop picks it up within seconds (run.unitsPerModule too). Shrinking never kills a lane — running units finish first.
	let laneLimit = config.run.agentConcurrency;
	let configMtime = 0;
	const reloadLanes = () => {
		try {
			const f = join(o.root, "bigrefactor.config.json");
			const m = statSync(f).mtimeMs;
			if (m === configMtime) return;
			const first = configMtime === 0;
			configMtime = m;
			if (first) return;
			const run = loadConfig(f).config.run;
			if (run.agentConcurrency !== laneLimit || gateSlots(run) !== gates.limit) {
				log(pc.cyan(`lanes ${laneLimit} → ${run.agentConcurrency}, gate slots ${gates.limit} → ${gateSlots(run)}${run.agentConcurrency < running.size ? ` (${running.size} running finish first)` : ""}`));
				laneLimit = run.agentConcurrency;
				agents.setLimit(laneLimit);
				gates.setLimit(gateSlots(run));
			}
			if (run.unitsPerModule !== perModule) {
				log(pc.cyan(`units per module ${perModule} → ${run.unitsPerModule}`));
				perModule = run.unitsPerModule;
			}
		} catch {
			/* unreadable mid-write: next tick */
		}
	};
	reloadLanes();
	// the gate slots' totals go to the ledger now and then: `br lanes` (another process) judges the slot count by them
	let slotsSaved = 0;
	const saveSlotTotals = () => {
		if (Date.now() - slotsSaved < 10_000) return;
		slotsSaved = Date.now();
		ledger.setMeta("gate_slots", JSON.stringify({ ...gates.totals, at: slotsSaved, limit: gates.limit }));
	};
	const merge = new Semaphore(1);
	// target.git.push "on": main goes to the target repo's remote after merges, on the side
	const pushes = createPusher({ config, root: o.root, log });
	// after every merge main's tree is new: the other units' tests lanes asked main about run on it on the side (not
	// in simulations: no lane waits there)
	const pusher = { ...pushes, afterMerge: () => (pushes.afterMerge(), o.dry || o.spawn ? undefined : void warmMainCache()) };
	// a unit's merge that turns its stack's whole-project build or lint red does not land (off in simulations)
	const mergeCheck = o.dry || o.spawn ? undefined : createMergeCheck({ config, adapters });
	// whole-project checks run on the side, now and then after merges (never in every unit's gate)
	const builder = createBuilder({
		config,
		root: o.root,
		ledger,
		adapters,
		client: o.client,
		log,
		linkAll,
		repair: o.builderRepair ?? (o.spawn ? false : undefined),
		// a main the repair could not fix goes to a code job (it may fix test code too), never to the owner
		codeJob: o.setupFixer === false || (!o.setupFixer && o.spawn) ? undefined : async (stackId, what) => {
			let merged: string | undefined;
			let locked: { files: string[]; diff: string } | undefined;
			const said = await runCodeJob({ config, root: o.root, ledger, adapter: adapters.get(stackId)!, label: `build-${stackId}-${Date.now()}`, linkAll, log: (l) => (log(l), keepBuilderLine(o.root, l)), what, whole: true, onLocked: (l) => (locked = l), mergeFix: (wt, branch, msg) => merge.run(async () => await mergeUnit(config, "code", wt, branch, "", msg)).then((sha) => (pusher.afterMerge(), (merged = sha))) });
			if (said) noteFix(o.root, stackId, merged, `builder code job: ${said}`);
			const setup = locked ? await lockedToSetup(adapters.get(stackId)!, stackId, `the red ${stackId} main`, locked) : undefined;
			return said ?? setup;
		},
		// errors only in files a code job may not change: the setup model fixes them
		fixSetup: o.setupFixer === false || (!o.setupFixer && o.spawn) ? undefined : (stackId, problem) =>
			fixRunSetup({ config, root: o.root, adapter: adapters.get(stackId)!, projectDir: projectDir(config, stackId), fixer: o.setupFixer || fixSetupWithModel, ledger, lock: (fn) => merge.run(fn), signature: errorSignature(`build:${stackId}`, problem), problem: `The whole ${stackId} project fails its checks on main, and every error is in files that decide how the checks run (a code job may not change them). Fix them there, keeping every check as strict as it is.\n${problem.slice(-4000)}` }).catch((e) => (log(pc.yellow(`  setup fix failed: ${e?.message ?? e}`)), undefined)),
		mergeFix: (wt, branch, what) =>
			merge.run(async () => await mergeUnit(config, "builder", wt, branch, "", what)).then((sha) => {
				pusher.afterMerge();
				// builder/<stack>: the repair may unblock quarantined units of that stack
				if (sha) noteFix(o.root, branch.split("/")[1] ?? "", sha, `builder repair: ${what.split("\n").at(-1)}`);
				return sha;
			}),
	});
	// stubs on main no unit will replace (owner accepted or no unit): at the start and after merges a code job gets
	// them (every stack: a unit's marks may sit in another stack), each a few times; then the owner is asked once
	const stubSweep = o.setupFixer === false || (!o.setupFixer && o.spawn) || o.dry
		? undefined
		: createStubSweep({
				ledger,
				log,
				dirOf: (stackId) => projectDir(config, stackId),
				repo: config.target.stacks.length > 1 ? config.target.path : undefined,
				resolveOwners: resolveOwnersWithModel({ ledger, config }),
				otherStacks: (stackId) => config.target.stacks.filter((s) => s !== stackId),
				codeJob: async (stackId, what) => {
					let merged: string | undefined;
					const said = await runCodeJob({ config, root: o.root, ledger, adapter: adapters.get(stackId)!, label: `stubs-${stackId}-${Date.now()}`, linkAll, log, what, mergeFix: (wt, branch, msg) => merge.run(async () => await mergeUnit(config, "code", wt, branch, "", msg)).then((sha) => (pusher.afterMerge(), (merged = sha))) });
					if (said) noteFix(o.root, stackId, merged, `stub sweep code job: ${said}`);
				},
			});
	// when no unit is left to run: the finish check looks at the app as a whole (stubs left, pages the entry never feeds,
	// calls no backend route serves, stacks not joined) and hands what it finds to code jobs. Once per main commit, at
	// most a few times a run: a job that merged changes main, and the next pass looks at the new main
	let finishPasses = 0;
	const finishOn = !(o.setupFixer === false || (!o.setupFixer && o.spawn) || o.dry) && o.limit === undefined && !o.units?.length && !o.slice;
	const runFinish = async (): Promise<boolean> => {
		if (!finishOn || !finishDue(ledger, await headOf(config.target.path), finishPasses)) return false;
		finishPasses++;
		const r = await finishCheck({
			ledger,
			config,
			root: o.root,
			adapters,
			linkAll,
			log,
			sweep: (stackId) => stubSweep?.afterMerge(stackId),
			codeJob: async (stackId, what) => {
				let merged: string | undefined;
				let locked: { files: string[]; diff: string } | undefined;
				const said = await runCodeJob({ config, root: o.root, ledger, adapter: adapters.get(stackId)!, label: `finish-${stackId}-${Date.now()}`, linkAll, log, what, onLocked: (l) => (locked = l), mergeFix: (wt, branch, msg) => merge.run(async () => await mergeUnit(config, "code", wt, branch, "", msg)).then((sha) => (pusher.afterMerge(), (merged = sha))) });
				if (said) noteFix(o.root, stackId, merged, `finish check code job: ${said}`);
				// a dev server proxy or a test config change: files that decide how the checks run, the setup model's to judge
				if (locked) await lockedToSetup(adapters.get(stackId)!, stackId, "the finish check", locked);
				return !!merged;
			},
			ask: async (facts, sameAs) => (ledger.openQuestionFor("finish_check", sameAs) ?? (await askViaModel({ ledger, config, root: o.root, client: o.client }, { point: "finish_check", facts, options: [{ value: "done", facts: "I settled it; check the app again" }, { value: "leave", facts: "leave it as it is" }], recommended: "done", blocks: "none", askedBy: "orchestrator", sameAs })).id),
		}).catch((e) => (log(pc.yellow(`finish check failed: ${e?.message ?? e}`)), undefined));
		return !!r?.merged;
	};
	// marks left from earlier runs (a job that did not merge, a loose owner name) are looked at once at the start too
	if (stubSweep) for (const s of config.target.stacks) void stubSweep.afterMerge(s);
	// parity: can the old app and the new app each start here as a local server? decided once per workspace, on the
	// side (lanes never wait); a side that does not start asks the owner once, blocking nothing
	const probeAsk: { ask: ProbeAsker; answer: ProbeAnswer } = {
		ask: async (q) => (await askViaModel({ ledger, config, root: o.root, client: o.client }, { point: "parity_probe", facts: q.facts, options: q.options, recommended: q.recommended, blocks: "none", askedBy: "orchestrator" })).id,
		answer: (id) => answerValue(ledger.getQuestion(id)?.answer),
	};
	const parityProbe =
		o.dry || o.spawn || !await isRepo(config.target.path)
			? undefined
			: import("./parity.ts")
					.then(({ probeApps }) => probeApps({ config, root: o.root, linkAll, log, ...probeAsk }))
					.catch((e) => log(pc.yellow(`parity probe failed: ${e?.message ?? e} (the run goes on without comparing the apps)`)));
	// parity checks: a slice's routes whose units are accepted are compared old vs new on the side, one slice at a time;
	// the judge re-opens the units whose answers differ and turns odd old behaviour into quirks for the owner
	const serverStack = [...adapters].find(([, a]) => a.role === "server")?.[0] ?? config.target.stacks[0]!;
	const parityQueue: string[] = [];
	let parityRunning: Promise<void> | undefined;
	let parityStopped = false;
	let parityLast: string | undefined;
	const showParity = (what?: string) => (what && setStep(`parity: ${what}`), progress.setParity({ now: what ? { what, since: Date.now() } : undefined, queued: parityQueue.length, last: parityLast }));
	const sliceOf = (unitId: string) => (JSON.parse(ledger.getUnit(unitId)?.meta ?? "{}") as { slice?: string }).slice;
	// a slice can be compared once a unit that answers one of its routes is accepted: only those routes' steps are
	// compared (checkSlice onlyAccepted), and each later route owner's accept compares it again
	const sliceDone = (slice: string) => routeOwners(ledger, slice).some((u) => u.state === "accepted");
	const pumpParity = () => {
		if (parityRunning || parityStopped || !parityQueue.length) return;
		const slice = parityQueue.shift()!;
		parityRunning = (async () => {
			showParity("checking whether the old and the new app start");
			await parityProbe;
			const { fixUpLeft, loadApps } = await import("./parity.ts");
			const apps = loadApps(o.root);
			if (!apps["legacy"]?.up || !apps[serverStack]?.up) return void (parityLast = `off: ${!apps["legacy"]?.up ? "the old app" : "the new app"} does not start here (br parity --probe)`);
			if (!sliceDone(slice)) return;
			const { askBootOwner, bootWaits, setupFixer } = await import("./parity.ts");
			// an app its setup could not get to start: the owner was asked, checks wait for that (each would fail the same way)
			const waits = bootWaits(apps, probeAsk.answer);
			if (waits) return void (parityLast = `off: ${waits === "legacy" ? "the old app" : `the new ${waits} app`} does not start here — waiting for your answer`);
			showParity(`comparing ${slice} with the old app`);
			const { checkSlice } = await import("./parity-check.ts");
			// an app that does not start here (its data reset, start or no answer) goes to its setup model first, then the check goes on
			const fix = setupFixer({ config, root: o.root, log, answer: probeAsk.answer });
			const fixSetup = (side: string, error: string) => (showParity(`setting up ${side === "legacy" ? "the old app" : `the new ${side} app`} again: it did not start`), fix(side, error));
			// each app gets a test account from its setup first, so the steps compare the routes behind the login logged in
			const { ensureTestLogins } = await import("./parity.ts");
			const ensureLogins = (sides: string[]) => (showParity("finding a test account for the old and the new app"), ensureTestLogins({ config, root: o.root, sides, linkAll, log, ...probeAsk }));
			const r = await checkSlice({ ledger, config, root: o.root, slice, linkAll, serverStack, onlyAccepted: true, log, fixSetup, ensureLogins });
			// its setup ran out of fixes: a person must look, asked once
			if (r.setup) await askBootOwner({ root: o.root, side: r.setup.side, error: r.note, ask: probeAsk.ask });
			// the new app does not start on main: a red main the builder fixes, not only a parity error. A stack with no
			// boot check gets one from the setup model first, so the merge check and the builder see it from now on
			if (r.down && adapters.has(r.down.stack)) {
				const adapter = adapters.get(r.down.stack)!;
				if (!o.dry && o.setupFixer !== false && !wholeProjectSteps(adapter, projectDir(config, r.down.stack)).some((s) => s.step === "boot")) {
					showParity(`asking the ${r.down.stack} setup for a boot check: the new app does not start`);
					await fixRunSetup({ config, root: o.root, adapter, projectDir: projectDir(config, r.down.stack), fixer: o.setupFixer || fixSetupWithModel, ledger, lock: (fn) => merge.run(fn), signature: "boot check", problem: `The new ${r.down.stack} app does not start on main (the parity check started it):\n${r.down.error.slice(-3000)}\nNo whole-project check notices this: the stack has no boot command. Set one with set_gate_command (step boot): the framework's own start or container check, one command that exits, and run it to see that it fails on this now. Do not fix the app's code for it: the builder hands that to a code job.` }).catch((e) => log(pc.yellow(`  setup fix failed: ${e?.message ?? e}`)));
				}
				await builder.appDown(r.down.stack, r.down.error);
			}
			// the old app only redirected to itself on https: its setup is asked to fix that (a few times at most), then the slice runs again
			const old = loadApps(o.root)["legacy"];
			if (old?.selfRedirect && fixUpLeft(old, "redirect")) {
				showParity("setting up the old app again: it only redirects to itself on https");
				const { probeApp } = await import("./parity.ts");
				await probeApp({ config, root: o.root, side: "legacy", log, ...probeAsk });
				if (!loadApps(o.root)["legacy"]?.selfRedirect) parityQueue.push(slice);
			}
			parityLast = `${slice}: ${r.outcome === "same" ? "answers like the old app" : r.outcome === "error" || r.outcome === "setup" ? `not compared (${r.note.slice(0, 80)})` : `${r.diffs.length} difference(s)`}`;
			if (r.runId !== undefined && r.outcome === "differs") {
				showParity(`judging ${r.diffs.length} difference(s) in ${slice}`);
				const { judgeRun } = await import("./parity-judge.ts");
				const j = await judgeRun({ ledger, config, root: o.root, runId: r.runId, slice, client: o.client, log, shared: sharedOn });
				pumpShared();
				parityLast = `${slice}: ${j.bugs} bug(s)${j.reopened.length ? ` → re-opened ${j.reopened.join(", ")}` : ""}${j.shared.length ? ` → shared ${j.shared.join(", ")}` : ""}, ${j.quirks} quirk(s) for you${j.allowed ? `, ${j.allowed} allowed` : ""}${j.setup ? `, ${j.setup} from the test setup` : ""}`;
			}
			// a problem only an app's setup here causes (a difference the judge blamed on it):
			// that setup is asked to fix it (a few times at most), then the slice runs again
			const blamed = Object.entries(loadApps(o.root)).filter(([, a]) => a.setupProblem && fixUpLeft(a, "setup")).map(([side]) => side);
			if (blamed.length) {
				showParity(`setting up ${blamed.join(", ")} again: a problem comes from how it runs here`);
				const { probeApps } = await import("./parity.ts");
				await probeApps({ config, root: o.root, linkAll, log, ...probeAsk });
				if (blamed.some((side) => !loadApps(o.root)[side]?.setupProblem)) parityQueue.push(slice);
			}
		})()
			.catch((e) => log(pc.yellow(`parity ${slice}: ${e?.message ?? e}`)))
			.finally(() => {
				parityRunning = undefined;
				showParity();
				pumpParity();
			});
	};
	const queueParity = (slice: string | undefined) => {
		if (!parityProbe || !slice || parityQueue.includes(slice) || !sliceDone(slice)) return;
		parityQueue.push(slice);
		if (parityRunning) progress.setParity({ ...progress.snapshot().parity, queued: parityQueue.length });
		pumpParity();
	};
	// a bug cause the judge found in code many slices share: ONE code job on the server stack fixes it (one at a time,
	// on the side), not a re-open of every unit; its slices are compared again once it lands
	const sharedOn = !(o.setupFixer === false || (!o.setupFixer && o.spawn));
	let sharedRunning: Promise<void> | undefined;
	const pumpShared = () => {
		if (sharedRunning || parityStopped || !sharedOn || !adapters.has(serverStack) || !sharedCauses(ledger).some((x) => x.status === "open")) return;
		sharedRunning = runSharedJob(
			ledger,
			async (c) => {
				let merged: string | undefined;
				const said = await runCodeJob({ config, root: o.root, ledger, adapter: adapters.get(serverStack)!, label: `parity-${c.id}-${c.jobs}`, linkAll, log, what: sharedJobText(c), mergeFix: (wt, branch, msg) => merge.run(async () => await mergeUnit(config, "code", wt, branch, "", msg)).then((sha) => (pusher.afterMerge(), (merged = sha))) });
				if (said && merged) noteFix(o.root, serverStack, merged, `parity shared cause ${c.id}: ${said}`);
				return !!(said && merged);
			},
			(l) => log(pc.yellow(l)),
		)
			.then((r) => r?.slices.forEach((sl) => queueParity(sl)))
			.catch((e) => log(pc.yellow(`parity shared cause: ${e?.message ?? e}`)))
			.finally(() => {
				sharedRunning = undefined;
				pumpShared();
			});
	};
	if (parityProbe) {
		resumeShared(ledger);
		pumpShared();
		// at the start: finished slices never compared, and slices whose last comparison needs another look
		const { checked, again } = parityAgain(ledger, await headOf(config.target.path));
		// the slice names straight from SQL: reading and parsing every unit's meta held the run's thread at start
		const slices = new Set((ledger.db.prepare("SELECT DISTINCT json_extract(meta, '$.slice') AS s FROM units WHERE json_extract(meta, '$.slice') IS NOT NULL").all() as Array<{ s: unknown }>).map((r) => r.s).filter((x): x is string => typeof x === "string" && !!x));
		// and slices of units the owner said to retry after they ran out of parity re-opens
		const answered = applyParityAnswers(ledger);
		for (const sl of slices) if (!checked.has(sl) || again.has(sl) || answered.includes(sl)) queueParity(sl);
	}
	// approved tidy tasks run once each as their own job on main; units of the area wait for it
	// an area is busy while a unit of it runs; a truth-ahead lane (only tests, in its own worktree) never holds a tidy job back
	const tidyJobs = createTidyJobs({ config, root: o.root, ledger, adapters, log, linkAll, worker: o.spawn ? false : undefined, mergeFix: (wt, branch, what) => merge.run(async () => await mergeUnit(config, "tidy", wt, branch, "", what)).then((sha) => (pusher.afterMerge(), sha)), areaBusy: (s, a) => [...running.keys()].some((id) => { if (aheadRunning.has(id)) return false; const p = placementOf(ledger.getUnit(id)!.meta); return p.stackId === s && p.area === a; }) });
	const curate = new Semaphore(1);
	const ran: UnitRunResult[] = [];
	const running = new Map<string, Promise<void>>();
	let acceptedNow = 0;
	let cost = 0;
	let stop = false;
	const startedAt = new Date().toISOString();
	// two workspaces on one repo and main branch would both merge into it
	const other = o.dry ? undefined : await claimMainBranch(config.target.path, config.target.git.branch, o.root);
	if (other) throw new Error(`another workspace (${other}) already migrates into ${config.target.git.branch} of ${config.target.path}: give this workspace its own target.git.branch, or remove that workspace's .bigrefactor folder`);
	if (!o.dry) ledger.setMeta(OPEN_RUN, JSON.stringify({ startedAt }));
	// every model call of this run (units, setup and builder sessions, doctor, triage, questions) for the total
	const usageAtStart = progress.tally();
	setStep("removing leftover worktrees");
	emptyWorktreeTrash(join(o.root, ".bigrefactor", "worktrees"));
	if (!o.dry) for (const n of await sweepWorktrees(config.target.path, join(o.root, ".bigrefactor", "worktrees"))) log(pc.dim(`removed leftover worktree ${n}`));
	// what this workspace made and no longer needs goes on the side: soon after the start, then every run.cleanEveryMinutes;
	// a lane's worktree (a unit id, or <id>-ahead) is in use while the lane runs
	const cleaner = o.dry || o.spawn ? undefined : createCleaner({ config, root: o.root, ledger, everyMinutes: config.run.cleanEveryMinutes, log, inUse: () => new Set([...running.keys()].flatMap((id) => [id, `${id}-ahead`])) });
	const branchNow = await mainBranch(config.target.path, config.target.git.branch);
	if (branchNow !== config.target.git.branch) log(pc.yellow(`target branch ${config.target.git.branch} is gone from ${config.target.path}; units merge into ${branchNow} (the checked-out branch). Set target.git.branch to "${branchNow}" to make it permanent.`));
	if (!o.dry) {
		const caught = decideOpenFromGoals(ledger, config);
		if (caught) log(pc.cyan(`decided ${caught} open routine question(s) from your goals (br questions lists them; br answer <id> changes one)`));
	}
	// A stop drains: running lanes stop their unit at its next step (its code kept, back to planned), nothing new starts. It is written down (run log + ledger)
	// so the next run and `br status` can say what happened.
	let stopRecord: { at: string; reason: string; finishing: string[] } | undefined;
	const requestStop = (reason: string) => {
		if (stopRecord) return;
		stop = true;
		stopRecord = { at: new Date().toISOString(), reason, finishing: [...running.keys()] };
		if (!o.dry) ledger.setMeta(OPEN_RUN, JSON.stringify({ startedAt, stop: stopRecord }));
		// the builder starts nothing new from now on (no check, repair or code job while the lanes finish); its running
		// check is killed, a running repair or code job finishes; the run's end waits for it
		void builder.stop().catch(() => undefined);
		void cleaner?.stop();
		log(pc.yellow(`■ stop requested (${reason}): ${stopRecord.finishing.length} running lane(s) stop at their next step, code kept${stopRecord.finishing.length ? ` (${stopRecord.finishing.join(", ")})` : ""}; no new units start`));
	};
	const onSigint = () => {
		requestStop("ctrl-c");
		log(pc.dim("ctrl-c again to abort"));
		process.once("SIGINT", () => process.exit(130));
	};
	if (o.handleSigint !== false) process.once("SIGINT", onSigint);
	// accepted units with only read truth, on the side: their scripts run on the old code (a few at once, capped), then the
	// tester writes a script for those with none (capped; one at a time, more while lanes are free). A stop ends both.
	const truthScripts = o.dry || o.spawn
		? undefined
		: import("./recheck.ts")
				.then(async ({ upgradeReadTruth, writeTruthScripts }) => {
					// the old code's runtime is down: writing scripts now would only pay models to chase the outage
					if (config.run.truthUpgradesPerRun > 0 && (await upgradeReadTruth({ ledger, config, root: o.root, states: ["accepted"], cap: config.run.truthUpgradesPerRun, stopped: () => !!stopRecord, log })).down) return;
					await writeTruthScripts({ ledger, config, root: o.root, cap: config.run.truthScriptsPerRun, stopped: () => !!stopRecord, freeLanes: () => (stopRecord ? 0 : laneLimit - running.size), log });
				})
				.catch((e) => log(pc.yellow(`truth scripts: ${e?.message ?? e}`)));

	// accepted units' drops, on the side: the ones that read like work not done are judged by a model, a few per run
	const dropCheck = o.dry || o.spawn
		? undefined
		: import("./drop-check.ts")
				.then(({ checkAcceptedDrops }) => checkAcceptedDrops({ ledger, config, root: o.root, client: o.client, stopped: () => !!stopRecord, log }))
				.catch((e) => log(pc.yellow(`drop check: ${e?.message ?? e}`)));

	let decisionBlocked = new Map<string, string[]>();
	let waitingNote = "";
	// urgency: how many units wait on a unit and the best slice among them (deps barely change in a run: once)
	let urgency: ReturnType<typeof blockingOrder> | undefined;
	const urgencyOf = (id: string) => {
		// only the columns it needs: parsing every unit's meta held the run's thread at its first pass
		if (!urgency?.has(id)) urgency = blockingOrder((ledger.db.prepare("SELECT id, deps, json_extract(meta, '$.sliceRank') AS rank FROM units").all() as Array<{ id: string; deps: string; rank: number | null }>).map((u) => ({ id: u.id, deps: JSON.parse(u.deps) as string[], rank: u.rank ?? 99 })));
		return urgency.get(id) ?? { rank: 99, blocks: 0 };
	};
	const blocksNote = (id: string) => {
		const n = urgencyOf(id).blocks;
		return n ? ` — blocks ${n} unit${n === 1 ? "" : "s"}` : "";
	};
	// deps that are no unit any more (a re-inventory regrouped or renamed it) cannot be waited for: said once, then ignored
	const dangling = ledger.db.prepare("SELECT u.id, d.value AS dep FROM units u, json_each(u.deps) d WHERE NOT EXISTS (SELECT 1 FROM units x WHERE x.id = d.value)").all() as Array<{ id: string; dep: string }>;
	if (dangling.length) log(pc.yellow(`${dangling.length} dependency(ies) on units that no longer exist are ignored: ${dangling.slice(0, 5).map((x) => `${x.id} → ${x.dep}`).join(", ")}${dangling.length > 5 ? ", …" : ""}`));
	const ready = async (): Promise<string[]> => {
		applyPlacementAnswers(ledger, config, o.root); // an answered placement question places its unit before it can start
		syncTaxonomyAnswers({ ledger, root: o.root }); // answered area questions: new area, or the owner excluded the unit
		const blocked = ledger.blockedUnits();
		decisionBlocked = (await o.blocked?.()) ?? new Map();
		for (const u of decisionBlocked.keys()) if (!blocked.has(u)) blocked.set(u, []);
		// a few units per target module at a time (run.unitsPerModule): units sharing a write scope may conflict on merge
		const busyModules = new Map<string, number>();
		for (const id of running.keys()) {
			const k = placementOf(ledger.getUnit(id)!.meta).moduleKey;
			busyModules.set(k, (busyModules.get(k) ?? 0) + 1);
		}
		// One query: planned units whose every dep is accepted (json_each over the deps array), not stale.
		const rows = ledger.db
			.prepare(
				`SELECT u.id, u.meta FROM units u
				 WHERE u.state = 'planned'
				   AND COALESCE(json_extract(u.meta, '$.stale'), 0) = 0
				   AND NOT EXISTS (SELECT 1 FROM json_each(u.deps) d JOIN units du ON du.id = d.value WHERE ${OPEN_DEP})`,
			)
			.all() as Array<{ id: string; meta: string }>;
		const held = tidyJobs.heldAreas();
		moduleWait = new Map();
		const units = rows.filter((u) => {
			if (running.has(u.id) || blocked.has(u.id)) return false;
			// waits for Jev or its placement question, never runs on a guess (a dry run previews before placement ran)
			if (!o.dry && unplacedReason(config, u.meta, o.root)) return false;
			const place = placementOf(u.meta);
			if (held.has(`${place.stackId}\0${place.area}`)) return false;
			if (o.units && !o.units.includes(u.id)) return false;
			if (o.slice && JSON.parse(u.meta).slice !== o.slice) return false;
			// last: a unit counted here waits for nothing but the module limit
			if ((busyModules.get(place.moduleKey) ?? 0) >= moduleLimit(place)) {
				moduleWait.set(place.moduleKey, (moduleWait.get(place.moduleKey) ?? 0) + 1);
				return false;
			}
			return true;
		});
		// what many units (or an early slice) wait on goes first, not the alphabet
		return units
			.map((u) => ({ id: u.id, w: urgencyOf(u.id) }))
			.sort((a, b) => a.w.rank - b.w.rank || b.w.blocks - a.w.blocks || a.id.localeCompare(b.id))
			.map((u) => u.id);
	};

	if (o.dry) {
		const order = await ready();
		log(`\nready now (${order.length}): ${order.join(", ") || "-"}`);
		return { ran: [], accepted: 0, quarantined: 0, waiting: order.length, costUsd: 0 };
	}

	/** A lane that still throws (e.g. in its clean-up) is logged: a rejected lane must never reach the scheduler's wait. */
	const laneDone = (unitId: string, p: Promise<unknown>): Promise<void> => p.then(() => undefined, (e: any) => log(pc.red(`✗ ${unitId}: lane failed: ${String(e?.message ?? e).split("\n")[0]}`)));
	const aheadRunning = new Set<string>();
	/** Truth-ahead attempts that ended without truth in this run: never retried in a tight loop. */
	const aheadDone = new Set<string>();
	// lanes started in one scheduling pass make their worktrees side by side (at the start: all of them); each says
	// where the batch is, and each starts its unit as soon as its own worktree is ready
	let passNo = 0;
	let wave = { pass: -1, total: 0 };
	const joinWave = () => {
		if (wave.pass !== passNo) wave = { pass: passNo, total: 0 };
		return { nth: ++wave.total, of: wave };
	};
	const preparingNote = (unitId: string, w: ReturnType<typeof joinWave>) => {
		setStep(`preparing worktree ${unitId}`);
		if (w.of.total > 1) log(pc.dim(`preparing worktree ${unitId} (${w.nth}/${w.of.total})`));
	};
	/** Tester-only lane for a unit whose deps are not accepted yet (see UnitRunOptions.truthOnly). */
	const startAhead = (unitId: string) => {
		aheadRunning.add(unitId);
		const w = joinWave();
		const p = agents.run(async () => {
			const wt = worktreeDir(o.root, unitId) + "-ahead";
			const branch = wsBranch(o.root, `ahead/${unitId}`);
			const drop = async () => {
				await removeWorktree(config.target.path, wt);
				try {
					await deleteBranch(config.target.path, branch);
				} catch {
					/* no branch */
				}
			};
			preparingNote(unitId, w);
			try {
				// inside the try: a worktree that cannot be made skips this lane like any other failure
				await drop();
				await addWorktree(config.target.path, wt, branch);
				await linkAll(wt);
				log(pc.cyan(`◇ ${unitId}`) + pc.dim("  truth ahead (deps still migrating)"));
				const res = await runUnit({ ledger, config, root: o.root, unitId, client: o.client, accept: false, workDir: wt, truthOnly: true, gateSlot: (fn) => gates.run(fn), log: (l) => log(`  ${l}`), spawn: o.spawn, gate: o.gate });
				cost += res.costUsd;
				log(ledger.hasEvidence(unitId, "truth_ahead") ? pc.cyan(`◆ ${unitId}: truth ready`) : pc.yellow(`⏸ ${unitId}: truth ahead failed (waiting on a question)`));
			} catch (e: any) {
				log(pc.yellow(`◇ ${unitId}: truth ahead skipped (${String(e?.message ?? e).split("\n")[0]})`));
			} finally {
				await drop();
			}
		});
		running.set(unitId, laneDone(unitId, p).finally(() => (running.delete(unitId), aheadRunning.delete(unitId), aheadDone.add(unitId))));
	};
	/** Planned units waiting only on deps (not on questions), without truth yet: closest to ready first. */
	const aheadCandidates = (): string[] => {
		const blocked = ledger.blockedUnits();
		const rows = ledger.db
			.prepare(
				`SELECT u.id, u.meta,
				   (SELECT COUNT(*) FROM json_each(u.deps) d JOIN units du ON du.id = d.value WHERE ${OPEN_DEP}) AS open
				 FROM units u
				 WHERE u.state = 'planned' AND COALESCE(json_extract(u.meta, '$.stale'), 0) = 0
				   AND substr(COALESCE(u.kind, ''), 1, 3) != 'db_' -- the DB lane has no tester truth to capture ahead
				   AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.unit_id = u.id AND e.type IN ('truth_ahead', 'truth_green_on_old', 'truth_read', 'truth_none'))`,
			)
			.all() as Array<{ id: string; meta: string; open: number }>;
		return rows
			// a unit still waiting for its placement (an area question) cannot start, not even its tester
			.filter((u) => u.open > 0 && !running.has(u.id) && !aheadDone.has(u.id) && !blocked.has(u.id) && !decisionBlocked.has(u.id) && !unplacedReason(config, u.meta, o.root))
			.filter((u) => (!o.units || o.units.includes(u.id)) && (!o.slice || JSON.parse(u.meta).slice === o.slice))
			.map((u) => ({ id: u.id, open: u.open, w: urgencyOf(u.id) }))
			.sort((a, b) => a.open - b.open || a.w.rank - b.w.rank || b.w.blocks - a.w.blocks || a.id.localeCompare(b.id))
			.map((u) => u.id);
	};

	const startUnit = (unitId: string) => {
		const w = joinWave();
		const p = agents.run(async () => {
			const wt = worktreeDir(o.root, unitId);
			const branch = wsBranch(o.root, `unit/${unitId}`);
			const fresh = async () => {
				await removeWorktree(config.target.path, wt);
				try {
					await deleteBranch(config.target.path, branch);
				} catch {
					/* no branch */
				}
				await addWorktree(config.target.path, wt, branch);
				await linkAll(wt);
				ledger.updateUnit(unitId, { worktree: wt, branch });
			};
			let res: UnitRunResult | undefined;
			let conflictNote: string | undefined;
			// after a refused merge: the tester's note (errors only in the unit's tests) and the stack whose whole-project check it failed
			let testsNote: string | undefined;
			let wholeStack: string | undefined;
			let carried: string | undefined;
			let crash: string | undefined;
			// the last approved review and the files that clashed since: it stands across merge rounds while only those changed
			const approved: { review?: ApprovedReview; clash: string[] } = { clash: [] };
			// a clash only in wiring files is resolved without a new implement pass: no round used, so a cap of its own
			let wiringRounds = 0;
			let mergeOnly = false;
			try {
				// inside the try: a worktree that cannot be made (disk full, git lock) counts as a crash, so the unit is
				// quarantined after the second one instead of being picked first again on every restart
				preparingNote(unitId, w);
				await fresh();
				const restored = await restoreKeptWork(ledger, wt, unitId);
				log(pc.bold(`▶ ${unitId}`) + pc.dim(`  [${JSON.parse(ledger.getUnit(unitId)!.meta).slice ?? "?"}]${restored ? ` (earlier code kept${restored.length ? `, ${restored.length} file(s) clash with main` : ""})` : ""}`));
				// what a requeue, heal or recheck left for this unit (diagnosis, owner hint, findings): its first pass reads it
				carried = [takeRetryNote(ledger, unitId), restored && "The worktree already holds your code from the earlier try, put on top of the current main: fix what failed instead of starting over.", restored?.length && conflictFilesNote(restored)].filter(Boolean).join("\n\n") || undefined;
				// Playbook: run → (merge conflict → fresh worktree on current main with the unit's commit put back on top, one more implement pass to resolve the clashing files) ×2 → accept or quarantine.
				for (let round = 1; round <= 3; round++) {
					if (!mergeOnly) res = await runUnit({
						ledger,
						config,
						root: o.root,
						unitId,
						client: o.client,
						accept: false,
						workDir: wt,
						// a requeue keeps its truth and saved tests; a bad-truth reopen drops the truth evidence, so the tester redoes it then
						reuseTruth: true,
						// the carried note holds for every round of this run, a merge conflict's note comes on top
						retryNote: [carried, conflictNote].filter(Boolean).join("\n\n") || undefined,
						testsNote,
						// the implementer (and tester) see the merge's own check before DONE, not only at the next merge
						wholeCheck: wholeStack && mergeCheck ? () => mergeCheck(wholeStack!, wt, true) : undefined,
						gateSlot: (fn) => gates.run(fn),
						mergeLock: (fn) => merge.run(fn),
						log: (l) => log(`  ${l}`),
						spawn: o.spawn,
						gate: o.gate,
						approved,
						// a stop reaches the running unit: it hands its lane back at the next safe point, its code kept
						stopped: () => stop,
						runStartedAt: startedAt,
					});
					if (!mergeOnly) cost += res!.costUsd;
					mergeOnly = false;
					testsNote = undefined;
					if (res!.state !== "review") break;
					try {
						await merge.run(async () => {
							setStep(`merging ${unitId}`);
							const { stackId } = placementOf(ledger.getUnit(unitId)!.meta);
							const adapter = adapters.get(stackId)!;
							const mainProject = projectDir(config, stackId);
							await rebaseOnMain(config, wt, branch, `feat: migrate ${unitId}\n\nbigrefactor: unit ${unitId}`);
							// a merge that adds errors to the stack's whole-project check (red, or new errors on a red main) does not land
							const broke = await mergeCheck?.(stackId, wt);
							if (broke) {
								await gitIn(wt, ["reset", "-q", await mainBranch(config.target.path, config.target.git.branch)]); // the code stays, uncommitted, on top of main
								throw new BreaksMain(stackId, broke);
							}
							// the whole-project build and lint the gate deferred: judged by that check just now; anything still not
							// judged stops here, before main changes
							const notJudged = verdictsAtMerge(ledger, unitId, !!mergeCheck, !!ledger.getMeta(buildRedKey(stackId)));
							if (notJudged) throw new Error(notJudged);
							const sha = await fastForwardMain(config, branch);
							ledger.transitionUnit(unitId, "accepted", sha ? `merged ${sha.slice(0, 7)} into ${await mainBranch(config.target.path, config.target.git.branch)}` : "merged (no changes)");
							// a success ends the crash count: a later re-open starts with a clean slate
							ledger.updateUnit(unitId, { meta: { ...(sha ? { commit: sha } : {}), crashes: undefined } });
							await indexTarget(ledger, adapter, mainProject, res!.gate?.changedFiles).catch(() => 0);
							// the code is on main now: a slip after this is logged, never a quarantine of a merged unit
							try {
								await afterAccept(ledger, adapter, mainProject, stackId, placementOf(ledger.getUnit(unitId)!.meta).area, (l) => log(`  ${l}`));
								// Registration/wiring files are generated by the adapter from what landed, never by agents.
								if (adapter.generateRegistration) {
									const changed = await adapter.generateRegistration(mainProject, { ledger }).catch((e) => (log(pc.yellow(`  registration generation failed: ${e?.message ?? e}`)), [] as string[]));
									if (changed.length) {
										const files = changed.map((c) => relative(config.target.path, join(mainProject, c)));
										try {
											await gitIn(config.target.path, ["add", "-A", "--", ...files]);
											await gitIn(config.target.path, ["-c", "user.name=bigrefactor", "-c", "user.email=bigrefactor@localhost", "commit", "-q", "-m", `chore: regenerate registration after ${unitId}\n\n${changed.join("\n")}`]);
										} catch (e) {
											// put the wiring files back to the last commit: left changed on main, the next accept would regenerate
											// the same content, see no change and never commit it
											await gitIn(config.target.path, ["reset", "-q", "--", ...files]);
											for (const f of files) {
												try {
													await gitIn(config.target.path, ["checkout", "-q", "HEAD", "--", f]);
												} catch {
													rmSync(join(config.target.path, f), { force: true }); // new with this regeneration: not in the last commit
												}
											}
											throw e;
										}
										log(pc.dim(`  regenerated ${changed.join(", ")}`));
									}
								}
							} catch (e: any) {
								log(pc.yellow(`  after-merge step failed (${unitId} stays accepted): ${String(e?.message ?? e).split("\n")[0]}`));
							}
						});
						acceptedNow++;
						log(pc.green(`✓ ${unitId} accepted ($${res!.costUsd.toFixed(4)})`));
						if (!o.dry) {
							builder.afterMerge(placementOf(ledger.getUnit(unitId)!.meta).stackId);
							pusher.afterMerge();
							for (const s of config.target.stacks) void stubSweep?.afterMerge(s);
							const sl = sliceOf(unitId);
							if (sl && parityOnAccept(ledger, sl, unitId)) queueParity(sl);
						}
						// living rules: proposals from units are curated into a new rules version once enough piled up
						await curate.run(() => maybeCurateRules({ ledger, config, root: o.root, client: o.client })).then((r) => {
								for (const [s, v] of Object.entries(r.versions)) log(pc.cyan(`  rules ${s} → v${v}`));
								// shown once: a refused proposal is final and never curated again
								for (const x of r.refused) log(pc.yellow(`  rules ${x.stack}: proposal ${x.id} ("${x.text.slice(0, 80)}") stays out although the owner said apply — curator: ${x.reason}`));
							}, (e) => log(pc.yellow(`  rules curation failed: ${e?.message ?? e}`)));
						// tidy review: every N accepts of an area a model reads its module; approved changes become tidy tasks
						const { stackId: tStack, area: tArea, shared: tShared } = placementOf(ledger.getUnit(unitId)!.meta);
						await curate.run(() => maybeTidyReview({ ledger, config, root: o.root, client: o.client }, { stackId: tStack, area: tArea, shared: tShared })).then((r) => r.reviewed && log(pc.cyan(`  tidy review ${tStack}:${tArea}: ${r.asked} change(s) asked, ${r.proposals} convention(s) proposed`)), (e) => log(pc.yellow(`  tidy review failed: ${e?.message ?? e}`)));
						break;
					} catch (e: any) {
						const breaks = e instanceof BreaksMain;
						if ((!breaks && !/merge conflict/.test(String(e?.message))) || (breaks && round === 3)) {
							ledger.transitionUnit(unitId, "quarantined", `could not merge: ${String(e?.message).slice(0, 300)}`);
							log(pc.red(`■ ${unitId}: quarantined (${String(e?.message).split("\n")[0]})${blocksNote(unitId)}`));
							break;
						}
						if (breaks) {
							// the worktree keeps the code on top of the current main: the next pass fixes it there
							wholeStack = e.stackId;
							approved.clash = [];
							const tests = res!.gate?.testFiles ?? [];
							const named = filesNamed(e.output, join(wt, relative(config.target.path, projectDir(config, e.stackId))), adapters.get(e.stackId)?.layout.sourceExtensions ?? []);
							// errors only in the unit's own tests: the implementer may not edit them, the tester fixes them first
							if (named.length && named.every((f) => tests.includes(f))) testsNote = `The unit passed its own checks but was not merged: with it, the whole ${e.stackId} project check has errors main does not have, all in your test files (${named.join(", ")}). Fix them in the test files, behaviour unchanged; check_ported_tests runs that check.\n${e.output.slice(-4000)}`;
							conflictNote = `Your previous pass passed its own checks but was not merged: with it, the whole ${e.stackId} project check has errors main does not have${testsNote ? ", all in the ported tests; the tester fixed them, check_my_code shows whether any are left" : ". Fix them (in your files, or where your change breaks other code); check_my_code runs that check now"}. The worktree holds your code on top of the current main.\n${e.output.slice(-4000)}`;
							log(pc.yellow(`  the merge would add errors to the whole-project check of ${e.stackId} → ${testsNote ? "tester, then " : ""}implement pass ${round + 1} with the errors`));
							ledger.transitionUnit(unitId, "implementing", "not merged: the whole-project check fails with it");
							continue;
						}
						// the unit's code passed its checks and review: it goes back on top of the current main, only the clashing files need work
						const sha = await headOf(wt);
						await fresh();
						const clash = sha ? await restoreUnitWork(wt, sha) : undefined;
						approved.clash = clash ?? [];
						// only wiring files clash (route table, main module: every unit adds its entry there): one short session
						// keeps both sides' entries, then the merge (with its stack check) is tried again, no new implement pass or review
						const { stackId: cStack } = placementOf(ledger.getUnit(unitId)!.meta);
						const cAdapter = adapters.get(cStack)!;
						const wiring = cAdapter.generateRegistration ? [] : cAdapter.layout.wiringFiles;
						const projRel = relative(config.target.path, projectDir(config, cStack));
						if (clash?.length && wiringRounds < MAX_WIRING_ROUNDS && clash.every((f) => isWiringFile(relative(projRel, f), wiring))) {
							wiringRounds++;
							log(pc.yellow(`  merge conflict only in wiring files (${clash.join(", ")}) → keeping both sides' entries`));
							if (await resolveWiringClash({ config, root: o.root, unitId, wt, files: clash, spawn: o.spawn })) {
								round--;
								mergeOnly = true;
								continue;
							}
							log(pc.yellow("  the wiring files still hold conflict markers"));
						}
						if (round === 3) {
							// back to the unit's commit as it was before the restore: what a quarantine keeps
							if (sha) await gitIn(wt, ["reset", "-q", "--hard", sha]);
							ledger.transitionUnit(unitId, "quarantined", `could not merge: ${String(e?.message).slice(0, 300)}`);
							log(pc.red(`■ ${unitId}: quarantined (${String(e?.message).split("\n")[0]})${blocksNote(unitId)}`));
							break;
						}
						conflictNote = clash
							? `Your previous pass passed its checks and the review but could not be merged: the main branch has moved (another unit landed). Your code is back in the worktree on top of the current main. ${clash.length ? conflictFilesNote(clash) : "It applied cleanly this time."} Change nothing else unless a check asks for it.`
							: `Your previous pass could not be merged: ${String(e?.message).split("\n")[0]}. The main branch has moved (another unit of the same module landed). The worktree now starts from the current main; re-apply the migration of this unit on top of the existing code (extend files, do not overwrite other units' work).`;
						log(pc.yellow(`  merge conflict → ${clash ? `code put back on current main${clash.length ? `, ${clash.length} file(s) to resolve` : ""}` : "fresh worktree"}, implement pass ${round + 1}`));
						ledger.transitionUnit(unitId, "implementing", clash ? `merge conflict: resolving ${clash.length} file(s) on current main` : "merge conflict: re-implementing on current main");
					}
				}
				if (res && res.state !== "review" && ledger.getUnit(unitId)!.state !== "accepted") {
					const st = ledger.getUnit(unitId)!.state;
					const q = ledger.openQuestions().find((x) => x.unit_id === unitId);
					log(st === "quarantined" ? pc.red(`■ ${unitId}: quarantined${blocksNote(unitId)}`) : res.stopped ? pc.yellow(`⏸ ${unitId}: back to planned for the stop, its code kept`) : pc.yellow(`⏸ ${unitId}: waiting${q ? ` on question #${q.id}` : ""} (${st})`));
				}
			} catch (e: any) {
				// a crash is not a gate failure: end the open attempts, count it, and stop after the second one so a
				// resubmit cannot loop; the circuit breaker sees it as an error signature like any other
				const msg = String(e?.message ?? e);
				log(pc.red(`✗ ${unitId}: ${msg}`));
				for (const a of ledger.db.prepare("SELECT id FROM attempts WHERE unit_id = ? AND ended_at IS NULL").all(unitId) as Array<{ id: number }>) ledger.endAttempt(a.id, { outcome: "exception", gateReport: { error: msg.slice(0, 2000) } });
				const crashes = ((JSON.parse(ledger.getUnit(unitId)!.meta) as { crashes?: number }).crashes ?? 0) + 1;
				ledger.updateUnit(unitId, { meta: { crashes } });
				const st = ledger.getUnit(unitId)!.state;
				if (crashes >= 2 && st !== "accepted" && st !== "quarantined") {
					ledger.transitionUnit(unitId, "quarantined", `crashed ${crashes} times: ${msg.slice(0, 300)}`);
					log(pc.red(`■ ${unitId}: quarantined after ${crashes} crashes${blocksNote(unitId)}`));
				}
				crash = msg;
			} finally {
				const st = ledger.getUnit(unitId)!.state;
				// the worktree goes whatever the state: the next run of this unit starts from a fresh one anyway (fresh()),
				// so a planned unit's would only hold disk space. A quarantined unit's code stays on its branch: a self-heal
				// requeue starts from it (an owner's requeue drops it). So does the code of a unit waiting on a question (a
				// code job for that question starts from it, and the unit goes on from it once answered) and of a unit the
				// stop sent back to planned: its next run goes on from it
				const kept = keepsCode(ledger, unitId) || (st === "planned" && res?.stopped) ? await keepUnitWork(wt, unitId) : undefined;
				if (st === "quarantined") keepPortedTests(config, o.root, unitId, ledger.getUnit(unitId)!.meta, wt, adapters.get(placementOf(ledger.getUnit(unitId)!.meta).stackId)!.layout);
				await removeWorktree(config.target.path, wt);
				if (kept) ledger.updateUnit(unitId, { meta: { keptWork: kept } });
				else {
					try {
						await deleteBranch(config.target.path, branch);
					} catch {
						/* branch already gone */
					}
				}
				ran.push({ unitId, state: st, attempts: res?.attempts ?? 0, gate: res?.gate, triage: res?.triage, costUsd: res?.costUsd ?? 0 });
				await circuit(unitId, st, res, crash);
			}
		});
		running.set(unitId, laneDone(unitId, p).finally(() => running.delete(unitId)));
	};

	// ---- circuit breaker: when recent units fail the same way (or Jev judges the failures systemic), the run heals
	// instead of stopping: new units wait, the shared cause is diagnosed, the setup model fixes the project (what it
	// learns — a command, a worktree copy — is kept for every later unit), the failed units go back into the queue
	// and the run goes on. Cannot be healed → those units stay quarantined, the run still goes on.
	const recent: BreakerEntry[] = [];
	const setupFixer = o.setupFixer === false ? undefined : (o.setupFixer ?? (o.spawn ? undefined : fixSetupWithModel));
	// what was already healed (or tried): one key per error, one per set of errors the model judged; a later storm
	// with another error is still checked
	const tried = new Set<string>();
	let healing: Promise<void> | undefined;
	const heal = async (what: string, failed: BreakerEntry[]) => {
		const units = failed.map((f) => f.unit);
		log(pc.cyan(`⚕ ${what} (${units.join(", ")}): fixing the shared cause; new units wait, running ones go on`));
		const first = failed.find((f) => f.output) ?? failed[0]!;
		const stackId = placeUnit(config, ledger.getUnit(first.unit)?.meta ?? "{}", o.root).stackId;
		const adapter = adapters.get(stackId);
		const output = first.output ?? first.text ?? "";
		let fixed: string | undefined;
		if (adapter && setupFixer) {
			const dir = projectDir(config, stackId);
			const dx = await diagnoseFailure({ config, adapter, projectDir: dir, failedStep: first.step ?? "", output, client: o.client }).catch(() => undefined);
			if (dx) log(pc.dim(`  diagnosis (${dx.by}): ${dx.action} — ${dx.summary}`));
			if (!dx || dx.action === "fix" || dx.action === "unknown")
				fixed = await fixRunSetup({ config, root: o.root, adapter, projectDir: dir, fixer: setupFixer, ledger, lock: (fn) => merge.run(fn), signature: first.sig, problem: `${units.length} units failed the same way (${what}).${dx ? ` Diagnosis: ${dx.summary}${dx.command ? ` (suggested: ${dx.command})` : ""}.` : ""}\nEach unit works in its own git worktree of the target repo (${join(o.root, ".bigrefactor", "worktrees", "<unit>")}); these dependency dirs are linked into it from the main project: ${linkedDirs(adapter, o.root).join(", ") || "none"}. Tools that resolve real paths (autoloaders, module resolution) then see the main project's code, not the worktree's: set_worktree_copy gives every later worktree a copy instead.\nFailure output of ${first.unit} (${first.step}):\n${output.slice(-3000)}` }).catch((e) => (log(pc.yellow(`  setup fix failed: ${e?.message ?? e}`)), undefined));
		}
		recent.length = 0;
		if (fixed) {
			const back = await requeueUnits(ledger, config, o.root, units.filter((u) => ["quarantined", "truth", "implementing", "gating"].includes(ledger.getUnit(u)?.state ?? "") && !running.has(u)), "self-heal", { keepCode: true });
			log(pc.green(`⚕ healed: ${fixed} — ${back.filter((l) => l.endsWith("requeued")).length} unit(s) back in the queue`));
		} else log(pc.yellow(`⚕ could not heal it here; those units stay quarantined (br requeue after a fix), the run goes on`));
	};
	const circuit = async (unitId: string, st: string, res: UnitRunResult | undefined, crash?: string) => {
		// a unit the stop sent back failed nothing: many of them at once are no shared failure to heal
		if (res?.stopped) return;
		recent.push(breakerEntry(ledger, unitId, st, res, crash));
		if (recent.length > 6) recent.shift();
		if (healing) return;
		const pick = breakerPick(recent, tried);
		if (!pick) return;
		if (pick.same) {
			// certain case: the same error in 3 units is one cause, whatever a model says
			tried.add(pick.key);
			healing = heal(`${pick.failed.length} units failed with the same error`, pick.failed).finally(() => (healing = undefined));
			return;
		}
		if (!o.client) return;
		try {
			const r = await decide({ client: o.client, ledger, model: config.models.decide.id, second: config.models.escalate.id, secondWhen: (a) => a["systemic"]?.type === "noul" && a["systemic"].noul >= 0.5 }, "systemic_failure", { recent_failures: pick.failed.map((f) => ({ unit: f.unit, triage: f.triage, key: f.sig, cause: capText(f.text ?? "", 800) })) }, SYSTEMIC_FAILURE, ["systemic"]);
			const sys = r.answers["systemic"];
			const kind = r.answers["kind"]?.type === "choice" ? (r.answers["kind"] as { choice: string }).choice : "other";
			if (sys?.type === "noul" && sys.noul >= 0.5 && r.confidence >= JEV_ACT && kind !== "hard_batch") {
				tried.add(pick.key);
				healing = heal(`failures look systemic (${kind}, ${Math.round(sys.noul * 100)}%)`, pick.failed).finally(() => (healing = undefined));
			}
		} catch {
			/* Jev unavailable: keep running */
		}
	};

	// ---- sample pause: after the first N accepted units nothing new starts until a human approved the tree they
	// produced (one question, phrased by a model; `br run` continues once it is answered "approve").
	const sampleSize = o.dry ? 0 : (o.sample ?? config.run.sampleSize);
	type Sample = { question?: number; approved?: string };
	const sampleState = (): Sample => JSON.parse(ledger.getMeta("layout_sample") ?? "{}") as Sample;
	const acceptedTotal = () => (ledger.db.prepare("SELECT COUNT(*) n FROM units WHERE state = 'accepted'").get() as { n: number }).n;
	let sampleNote = "";
	/**
	 * undefined = go on; otherwise why nothing new starts — only after the owner answered "stop". Files the review
	 * question once the sample has landed; an open (or unanswered) review never stops lanes.
	 */
	const samplePause = async (): Promise<string | undefined> => {
		if (!sampleSize) return undefined;
		let st = sampleState();
		// approved stays approved: a re-open lowering the count is no reset (target-reset clears the sample itself)
		if (st.approved) return undefined;
		if (st.question) {
			const q = ledger.getQuestion(st.question);
			if (q && q.status !== "open" && q.status !== "withdrawn") {
				if (answerValue(q.answer) === "approve") {
					ledger.setMeta("layout_sample", JSON.stringify({ ...st, approved: q.answered_at ?? new Date().toISOString() }));
					log(pc.green(`layout sample approved (#${q.id}): the run continues`));
					return undefined;
				}
				// not approved: the run stops; the next `br run` asks again on the tree as it is then
				ledger.setMeta("layout_sample", JSON.stringify({}));
				requestStop(`layout sample not approved (#${q.id}: ${q.answer})`);
				return "layout sample not approved";
			}
			if (!q || q.status === "withdrawn") (ledger.setMeta("layout_sample", JSON.stringify({})), (st = {}));
		}
		const acc = acceptedTotal();
		if (!st.question && acc >= sampleSize) {
			const trees = await Promise.all(config.target.stacks.map(async (id) => scanTree(config, await getTargetAdapter(id))));
			const landed = ledger.listUnits({ state: "accepted" }).map((u) => {
				const p = placementOf(u.meta);
				return `${u.id} → ${p.stackId}:${p.shared ? "shared/" : ""}${p.area}`;
			});
			const lr = await checkLayout(config, o.root, ledger).catch(() => undefined);
			// what a reviewer needs to see reuse: every landed area's files with their classes, and the drift code found
			const sf = await sampleFacts(config, ledger, ledger.listUnits({ state: "accepted" }).map((u) => placementOf(u.meta))).catch(() => ({ lines: [] as string[], drift: 0 }));
			const facts = [
				`The first ${acc} units landed in the target; the run paused before scaling to the remaining ${ledger.listUnits({ state: "planned" }).length} planned units.`,
				"Intended layout: one legacy area = one feature folder per stack; units of an area extend the same classes; cross-cutting code in the shared dir.",
				"Target tree now:",
				...renderTrees(trees, 40),
				`Units landed (unit → stack:area): ${landed.slice(0, 60).join("; ")}${landed.length > 60 ? " …" : ""}`,
				"Landed area modules (files [exported classes]):",
				...sf.lines,
				...(lr?.problems.length ? [`Layout check problems: ${lr.problems.join(" | ")}`] : ["Layout check: no problems found by code."]),
				// the code makes no pick: a drift line can be a real misplacement or something harmless; the model weighs them
				"The code makes no recommendation: judge from the tree, the drift lines and the problems above whether the structure is right (files that came with the generated project are never counted as drift).",
			].join("\n");
			const q = await askViaModel({ ledger, config, root: o.root, client: o.client }, { point: "layout_sample", facts, options: [{ value: "approve", facts: "the structure is right: continue the run" }, { value: "stop", facts: "the structure is wrong: keep the run stopped, fix placement/rules, reset the sample" }], blocks: "none", askedBy: "orchestrator", context: { sample: acc } });
			ledger.setMeta("layout_sample", JSON.stringify({ question: q.id }));
			log(pc.yellow(`layout sample: ${acc} units landed — review the target tree (question #${q.id}, br questions); the run goes on, an answer "stop" stops it`));
			for (const l of renderTrees(trees, 15)) log(pc.dim(`  ${l}`));
		}
		return undefined;
	};

	// the cap counts money actually paid today; subscription (Codex) calls carry an OpenRouter value but cost nothing
	const spentToday = () => paidSince(o.root, `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
	let dayCapHit = false;

	// ---- main loop
	await resubmitParked();
	let lastResubmitCheck = Date.now();
	let lastPlaceCheck = Date.now();
	// a failing pass never ends the run: the error is shown (once a minute while it repeats) and the next pass tries again
	let passError = "";
	let passErrorAt = 0;
	/** When the error now repeating first came (a broken placement.json or areas.json fails every pass the same way). */
	let passErrorSince = 0;
	// a full disk breaks the ledger, git and installs in odd ways: below run.minFreeDiskGb no new unit starts (said once)
	let diskLow = false;
	const diskReason = (): string | undefined => {
		const gb = freeDiskGb(o.root);
		const low = gb !== undefined && gb < config.run.minFreeDiskGb;
		if (low !== diskLow) log(low ? pc.red(`only ${gb!.toFixed(1)} GB free on the disk (run.minFreeDiskGb ${config.run.minFreeDiskGb}): no new units start until there is more`) : pc.cyan(`disk space back (${gb!.toFixed(1)} GB free): units start again`));
		diskLow = low;
		return low ? `only ${gb!.toFixed(1)} GB free on the disk; new units wait (run.minFreeDiskGb)` : undefined;
	};
	for (;;) {
		try {
			setStep("scheduling pass");
			passNo++;
			reloadLanes();
			saveSlotTotals();
			if (Date.now() - lastResubmitCheck > 5000) {
				await resubmitParked();
				lastResubmitCheck = Date.now();
			}
			// units Jev could not place (call failed, question could not be filed) get another pass
			if (Date.now() - lastPlaceCheck > 60_000) {
				lastPlaceCheck = Date.now();
				await resolvePlacements({ ledger, config, root: o.root, client: o.client, log: (l) => log(pc.dim(l)) }).catch((e) => log(pc.yellow(`placement failed: ${e?.message ?? e}`)));
			}
			if (!dayCapHit && spentToday() >= config.run.budgetUsdPerDay) {
				dayCapHit = true;
				await askViaModel({ ledger, config, root: o.root, client: o.client }, { point: "budget", facts: `Paid model spend today (subscription calls are not counted): $${spentToday().toFixed(2)}; the daily cap run.budgetUsdPerDay is $${config.run.budgetUsdPerDay}. Running units finish; no new ones start today. ${ledger.listUnits({ state: "planned" }).length} units are still planned.`, options: [{ value: "raise", facts: "raise run.budgetUsdPerDay in bigrefactor.config.json and br run again" }, { value: "tomorrow", facts: "leave the cap; br run again tomorrow" }], recommended: "tomorrow", blocks: "none", askedBy: "orchestrator" }).catch((e) => log(pc.yellow(`budget question failed: ${e?.message ?? e}`)));
				log(pc.red(`daily budget cap reached ($${spentToday().toFixed(2)}); not starting new units`));
			}
			const stopWhy = o.shouldStop?.();
			if (!stopRecord && stopWhy) requestStop(typeof stopWhy === "string" ? stopWhy : "/br stop");
			// A pilot of N migrates N units: in-flight units count toward the limit (otherwise up to N+lanes-1 land).
			const underLimit = () => o.limit === undefined || acceptedNow + running.size < o.limit;
			if (!stop && !dayCapHit) tidyJobs.next();
			// the cleaner removes what this workspace made and no longer needs, on the side (never during a stop)
			if (!stop) cleaner?.tick();
			const sampleReason = stop ? undefined : healing ? "fixing a shared failure (setup model); new units wait" : (diskReason() ?? (await samplePause()));
			let readyNow = 0;
			if (!stop && !dayCapHit && !sampleReason && underLimit()) {
				const startReady = async () => {
					const candidates = await ready();
					readyNow = candidates.length;
					// the module limit also within this pass: ready() only knows the units running before it (startUnit adds to running)
					for (const id of candidates) {
						if (running.size >= laneLimit || !underLimit()) break;
						const place = placementOf(ledger.getUnit(id)!.meta);
						const busy = [...running.keys()].filter((r) => placementOf(ledger.getUnit(r)!.meta).moduleKey === place.moduleKey).length;
						if (busy >= moduleLimit(place)) {
							moduleWait.set(place.moduleKey, (moduleWait.get(place.moduleKey) ?? 0) + 1);
							readyNow--;
							continue;
						}
						startUnit(id);
						readyNow--;
					}
				};
				await startReady();
				if (running.size < laneLimit && readyNow === 0 && moduleWait.size && underLimit()) {
					boost = true;
					try {
						await startReady();
					} finally {
						boost = false;
					}
				}
			} else moduleWait = new Map();
			// Lanes stay full while anything is todo: idle lanes capture truth for units still waiting on deps.
			// Not in a pilot (a limit means "spend on N units"), not while stopping or over budget.
			if ((o.truthAhead ?? o.limit === undefined) && !stop && !dayCapHit && !sampleReason && running.size < laneLimit) {
				for (const id of aheadCandidates()) {
					if (running.size >= laneLimit) break;
					startAhead(id);
				}
			}
			{
				const max = laneLimit;
				const reason = stop
					? "stopping: running lanes stop at their next step, nothing new starts"
					: dayCapHit
						? "daily budget cap reached"
						: sampleReason
							? sampleReason
							: o.limit !== undefined && !underLimit()
							? `pilot limit ${o.limit}: ${acceptedNow} accepted + ${running.size} finishing, nothing new starts`
							: running.size >= max
								? undefined
								: readyNow === 0 && moduleWait.size
									? moduleWaitNote(moduleWait, perModule)
									: readyNow === 0
									? aheadRunning.size
										? undefined
										: "no unit ready: the rest wait for dependencies on running units, or for answers"
									: undefined;
				o.onLanes?.({ running: running.size, max, ready: readyNow, ahead: aheadRunning.size, reason });
			}
			if (running.size === 0) {
				// healing a shared failure: wait for it, then go on (never ends the run)
				if (healing) {
					await waitOn("fixing a shared failure (setup model)", () => healing!);
					continue;
				}
				// a self-heal pass (it may ask the decide model) can still put quarantined units back: wait for it first
				if (askingStuck) {
					await waitOn("checking whether stuck units can run again", () => askingStuck!);
					continue;
				}
				if (tidyJobs.busy) {
					await waitOn("a tidy job is changing the code on main", () => tidyJobs.busy!);
					continue;
				}
				// the resolver (and a fix or code job it started) finishes before the run ends; what it answered may
				// release parked units, so the next pass resubmits them at once
				if (resolving) await waitOn("the resolver model is settling open questions", () => resolving!);
				if (resolvedSome) {
					resolvedSome = false;
					lastResubmitCheck = 0;
					continue;
				}
				// the sample review waits like a decision: a terminal or Pi waits for the answer, scripts end the run
				if (sampleReason && !stop && !o.shouldStop?.() && underLimit()) {
					if (o.waitForDecisions) {
						if (sampleReason !== sampleNote) log(pc.yellow(sampleReason));
						sampleNote = sampleReason;
						await new Promise((r) => setTimeout(r, 3000));
						continue;
					}
					log(pc.yellow(`${sampleReason}; then br run continues`));
					break;
				}
				// only decision-blocked work left: wait for the answers (asked on the side) instead of ending
				const pendingBlocked = [...decisionBlocked.keys()].filter((id) => ledger.getUnit(id)?.state === "planned");
				if (o.waitForDecisions && pendingBlocked.length && !stop && !o.shouldStop?.() && !dayCapHit && underLimit()) {
					const ids = [...new Set(pendingBlocked.flatMap((u) => decisionBlocked.get(u) ?? []))];
					const note = `waiting for ${ids.length} decision(s) (${ids.slice(0, 4).join(", ")}${ids.length > 4 ? ", …" : ""}) blocking ${pendingBlocked.length} unit(s)`;
					if (note !== waitingNote) log(pc.yellow(note));
					waitingNote = note;
					await new Promise((r) => setTimeout(r, 3000));
					continue;
				}
				// nothing left to run: is the app really done? A code job it merged may let units run again
				if (!stop && !o.shouldStop?.() && !dayCapHit && (await waitOn("finish check: is the app really done", runFinish))) {
					lastResubmitCheck = 0;
					continue;
				}
				break;
			}
			passError = ""; // a pass that got through ends the streak of a repeating error
		} catch (e: any) {
			const msg = String(e?.message ?? e);
			if (msg !== passError || Date.now() - passErrorAt > 60_000) log(pc.red(`run error (the run goes on): ${msg.slice(0, 600)}`));
			if (msg !== passError) passErrorSince = Date.now();
			passError = msg;
			passErrorAt = Date.now();
			// the same error for 5 minutes with nothing running: no pass can get past it, so the run ends and says why
			// instead of spinning (running lanes would have finished; the next br run starts again after the fix)
			if (!running.size && Date.now() - passErrorSince > 5 * 60_000) requestStop(`every pass failed the same way for 5 minutes; fix it, then br run: ${msg.split("\n")[0]!.slice(0, 300)}`);
		}
		// wake at least every 2 s: lane changes, resubmits and stops apply without waiting for a unit to end
		await Promise.race([...running.values(), new Promise((r) => setTimeout(r, 2000))]);
		// a lane that ends at once (nothing to do) must not starve the event loop: the UI redraws, /br stop is heard
		await new Promise((r) => setImmediate(r));
	}
	process.off("SIGINT", onSigint);
	setStep("finishing the run");
	// a stop (the owner's, new plugin code, Pi gone) does not wait for the comparison with the old app: one check can take
	// an hour (data dumps, setup fix-ups) and holds the next run back; the next run compares the slices again.
	// Without a stop the queued slices are compared before the run ends.
	if (stopRecord) {
		parityStopped = true;
		if (parityRunning || parityQueue.length) log(pc.dim("the comparison with the old app is left for the next run"));
	} else {
		if (parityProbe) await waitOn("checking whether the old and the new app start", () => parityProbe);
	}
	// a shared cause's code job merges on main: it finishes before the run ends (no new one starts after a stop). Without
	// a stop the slices it queues are compared too, and a job that comparison opens: both are awaited until neither runs
	while (sharedRunning || (!stopRecord && parityRunning))
		if (parityRunning && !stopRecord) await waitOn("comparing finished slices with the old app", () => parityRunning!);
		else await waitOn("a code job is fixing a difference many slices share", () => sharedRunning!);
	// a stop lets the running truth script finish; otherwise this run's share is written before it ends
	if (truthScripts) await waitOn("writing scripts that run read-only truth on the old code", () => truthScripts);
	if (dropCheck) await waitOn("checking the drops of accepted units", () => dropCheck);
	// a stop ends the cleaner between items; it does not outlive the run
	if (cleaner) await waitOn("finishing the cleanup pass", () => cleaner.stop());
	// a stub sweep's code job finishes (it merges on main) before the run ends
	if (stubSweep) await waitOn("a code job is replacing stubs no unit will replace", () => stubSweep.idle());
	// the builder checks what was merged since its last pass (a stop skips it: the next run's builder does it)
	if (!o.dry && !stopRecord) await waitOn("whole-project check of what was merged", () => builder.finish()).catch((e) => log(pc.yellow(`builder: ${e?.message ?? e}`)));
	// a stop kills the builder's running check and waits for a running repair or code job: nothing of it outlives the run
	if (!o.dry && stopRecord) await waitOn("stopping the builder", () => builder.stop()).catch((e) => log(pc.yellow(`builder: ${e?.message ?? e}`)));
	if (!o.dry) await waitOn("pushing to the target repo's remote", () => pusher.finish());

	const quarantined = ran.filter((r) => r.state === "quarantined").length;
	const waiting = ledger.listUnits({ state: "planned" }).length;
	// a truth-ahead lane leaves its unit planned by design: say what it produced instead
	const truthAhead = (id: string) => (ledger.db.prepare("SELECT 1 FROM evidence WHERE unit_id = ? AND type = 'truth_ahead' LIMIT 1").get(id) ? "planned, truth ready ahead" : undefined);
	const lanes = stopRecord ? stopRecord.finishing.map((id) => { const st = ledger.getUnit(id)?.state ?? "?"; return { unit: id, state: (st === "planned" && truthAhead(id)) || st }; }) : [];
	if (stopRecord) log(pc.yellow(`stopped (${stopRecord.reason}); lanes that finished: ${lanes.map((l) => `${l.unit} → ${l.state}`).join(", ") || "none were running"}`));
	cost = Math.max(cost, progress.tally().costUsd - usageAtStart.costUsd);
	log(`\nrun ${stopRecord ? "stopped" : "finished"}: ${acceptedNow} accepted, ${quarantined} quarantined, ${waiting} still planned${ledger.ownDecisions(startedAt).length ? `, ${ledger.ownDecisions(startedAt).length} routine question(s) decided from your goals` : ""}${ledger.openQuestions().length ? `, ${ledger.openQuestions().length} question(s) open → br questions` : ""}, $${cost.toFixed(3)}`);
	if (!o.dry) log(pc.dim(renderForecastLine(forecast(ledger))));
	// finished is not verified: what the last finish check left open and what is not proven yet
	if (!o.dry && lastFinish(ledger)) log(pc.dim(renderFinishLine(lastFinish(ledger)!)));
	if (!o.dry) ledger.setMeta(OPEN_RUN, "");
	if (!o.dry) writeRunRecord(ledger, o.root, { startedAt, endedAt: new Date().toISOString(), outcome: stopRecord ? "stopped" : "finished", stop: stopRecord ? { ...stopRecord, lanes } : undefined, accepted: acceptedNow, quarantined, planned: waiting, openQuestions: ledger.openQuestions().length, costUsd: Number(cost.toFixed(4)), units: ran.map((r) => ({ unit: r.unitId, state: r.state })) });
	return { ran, accepted: acceptedNow, quarantined, waiting, costUsd: cost };
}

/** Bring the unit branch up to date with the main branch and fast-forward it in. */
export async function mergeUnit(config: Config, unitId: string, wt: string, branch: string, _mainProject: string, message = `feat: migrate ${unitId}\n\nbigrefactor: unit ${unitId}`): Promise<string | undefined> {
	await rebaseOnMain(config, wt, branch, message);
	return fastForwardMain(config, branch);
}

/** Commit the worktree's changes and rebase its branch onto the main branch (a conflict throws "merge conflict …"). */
export async function rebaseOnMain(config: Config, wt: string, branch: string, message: string): Promise<void> {
	const main = await mainBranch(config.target.path, config.target.git.branch);
	await gitIn(wt, ["add", "-A"]); // the stacks' generated paths are excluded repo-wide via info/exclude (see excludeFromGit)
	const staged = (await exec("git", ["-C", wt, "diff", "--cached", "--name-only"])).trim();
	if (staged) await exec("git", ["-C", wt, "-c", "user.name=bigrefactor", "-c", "user.email=bigrefactor@localhost", "commit", "-q", "-m", message]);
	try {
		await exec("git", ["-C", wt, "-c", "user.name=bigrefactor", "-c", "user.email=bigrefactor@localhost", "rebase", "-q", main]);
	} catch (e: any) {
		const msg = String(e?.stderr ?? e?.message).trim();
		try {
			await exec("git", ["-C", wt, "rebase", "--abort"]);
		} catch {
			/* the rebase never started: nothing to abort, the message above says why */
		}
		// only a real conflict is a merge conflict (another implement pass helps); anything else is reported as it is
		if (/conflict|could not apply/i.test(msg)) throw new Error(`merge conflict rebasing ${branch} onto ${main}: ${msg.slice(0, 400)}`);
		throw new Error(`could not rebase ${branch} onto ${main}: ${msg.slice(0, 400)}`);
	}
}

/** Fast-forward the main branch to the rebased branch; the new head, or undefined when nothing changed. */
export async function fastForwardMain(config: Config, branch: string): Promise<string | undefined> {
	const before = await headOf(config.target.path);
	await exec("git", ["-C", config.target.path, "merge", "-q", "--ff-only", branch]);
	const after = await headOf(config.target.path);
	return after !== before ? after : undefined;
}

/** A unit's merge refused: with it the stack's whole-project check has errors main does not have. */
class BreaksMain extends Error {
	readonly output: string;
	readonly stackId: string;
	constructor(stackId: string, output: string) {
		const plain = output.replace(/\x1b\[[0-9;]*m/g, ""); // colored compiler output: plain file names and a readable reason
		super(`the whole-project check of ${stackId} fails with this merge: ${plain.slice(0, 300)}`);
		this.stackId = stackId;
		this.output = plain;
	}
}

async function gitIn(dir: string, args: string[]): Promise<string> {
	try {
		return (await exec("git", ["-C", dir, ...args])).trim();
	} catch (e: any) {
		throw new Error(`git ${args.join(" ")} failed in ${dir}: ${String(e?.stderr ?? e?.message).trim().slice(0, 500)}`);
	}
}

export function worktreeDir(root: string, unitId: string): string {
	return join(root, ".bigrefactor", "worktrees", unitId);
}

/** Repo-level excludes shared by all worktrees. A generator's `.gitignore` line `dir/` does not match our symlinked dir. */
export async function excludeFromGit(repo: string, patterns: string[]): Promise<void> {
	try {
		const gitDir = (await exec("git", ["-C", repo, "rev-parse", "--git-common-dir"])).trim();
		const abs = gitDir.startsWith("/") ? gitDir : join(repo, gitDir);
		const file = join(abs, "info", "exclude");
		mkdirSync(join(abs, "info"), { recursive: true });
		const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
		const add = patterns.filter((p) => !cur.split("\n").includes(p));
		if (add.length) writeFileSync(file, cur + (cur.endsWith("\n") || !cur ? "" : "\n") + add.join("\n") + "\n");
	} catch {
		/* not a repo yet */
	}
}

/** Dependency dirs into a unit's worktree: linked, or copied (copy-on-write clone where the disk can) when the workspace learned that a link breaks the stack's tools. */
/** Free space on the disk holding `dir`, in GB (undefined where it cannot be read). */
export function freeDiskGb(dir: string): number | undefined {
	try {
		const s = statfsSync(dir);
		return (s.bavail * s.bsize) / 1e9;
	} catch {
		return undefined;
	}
}

/**
 * At the start nothing runs yet: every worktree is left over from a crash or a stop (a unit's next run starts from a
 * fresh one, jobs reset theirs) and only holds disk space and its dependency copy.
 */
export async function sweepWorktrees(repo: string, dir: string): Promise<string[]> {
	if (!existsSync(dir)) return [];
	const gone = readdirSync(dir).filter((n) => !n.startsWith("."));
	for (const n of gone) await removeWorktree(repo, join(dir, n));
	return gone;
}

export async function linkDependencies(mainProject: string, wtProject: string, dirs: string[], copy: string[] = []): Promise<void> {
	for (const d of dirs) {
		const src = join(mainProject, d);
		const dst = join(wtProject, d);
		if (!existsSync(src) || existsSync(dst)) continue;
		if (!copy.includes(d)) {
			symlinkSync(src, dst, "dir");
			continue;
		}
		mkdirSync(dirname(dst), { recursive: true });
		try {
			// APFS clone (macOS) / reflink (Linux): no extra space, but it still walks every file (a 229 MB vendor
			// took ~4 s), so it runs async: a sync copy would freeze the Pi UI and the other lanes; symlinks inside are kept
			await promisify(execFile)("cp", process.platform === "darwin" ? ["-cR", src, dst] : ["-R", "--reflink=auto", src, dst]);
		} catch {
			await cp(src, dst, { recursive: true, verbatimSymlinks: true });
		}
	}
}

function loadOverrides(root: string): SliceOverrides {
	const p = join(root, ".bigrefactor", "slices.json");
	if (!existsSync(p)) return {};
	try {
		return JSON.parse(readFileSync(p, "utf8")) as SliceOverrides;
	} catch {
		return {};
	}
}

export async function run(opts: { units?: string[]; slice?: string; limit?: number; dry?: boolean; force?: boolean }): Promise<void> {
	const { loadConfig, statePath } = await import("../config.ts");
	const { Ledger } = await import("../ledger/db.ts");
	const { OpenRouterClient } = await import("../models/openrouter.ts");
	const { config, root } = loadConfig();
	if (!config.simulatedAt && !opts.force && !opts.dry) throw new Error("`br run` is locked until `br simulate --level 3` has been run and reviewed (or pass --force for a pilot)");
	const ledger = new Ledger(statePath(root, "ledger.sqlite"));
	const { liveBlocks } = await import("./decisions-gate.ts");
	const { getSourceAdapter } = await import("../adapters/registry.ts");
	const blocked = liveBlocks(ledger, config, getSourceAdapter(config.source.stack), await Promise.all(config.target.stacks.map((s) => getTargetAdapter(s))), root);
	// in a terminal the run waits for answers given with `br decide` elsewhere; in scripts it ends instead
	const r = await runScheduler({ ledger, config, root, client: new OpenRouterClient(), units: opts.units, slice: opts.slice, limit: opts.limit, dry: opts.dry, force: opts.force, blocked, waitForDecisions: !!process.stdout.isTTY });
	process.exitCode = r.quarantined && !r.accepted ? 1 : 0;
}


export { errorSignature };

/**
 * Parked units (state kept, attempt closed, waiting on a question) go back to planned as soon as the cause is
 * gone: their question was answered, or (environment failures) the target project or stack config changed.
 */
export async function resubmitParkedUnits(ledger: Ledger, config: Config, root: string, running: Set<string>, log: (l: string) => void, manifests: Map<string, { toolchain: { manifestFiles: string[] } }>): Promise<string[]> {
	let cfg = config;
	try {
		cfg = loadConfig(join(root, "bigrefactor.config.json")).config;
	} catch {
		/* keep the run's config */
	}
	// the environment of the stack the unit parked in (its placement)
	// one fingerprint per stack per pass: hundreds of waiting units must not each read the manifests again
	const envs = new Map<string, string>();
	const envNow = (meta: string) => {
		const stackId = placeUnit(cfg, meta, root).stackId;
		if (!envs.has(stackId)) envs.set(stackId, envFingerprint(cfg, projectDir(cfg, stackId), manifests.get(stackId)?.toolchain.manifestFiles ?? [], setupFiles(root, stackId)));
		return envs.get(stackId)!;
	};
	const open = new Set(ledger.openQuestions().map((x) => x.id));
	const parkedEnv = ledger.db.prepare("SELECT id, meta, json_extract(meta,'$.parked.question') q, json_extract(meta,'$.parked.env') env FROM units WHERE json_extract(meta,'$.parked.env') IS NOT NULL AND state IN ('truth','implementing','gating')").all() as Array<{ id: string; meta: string; q: number | null; env: string }>;
	for (const p of parkedEnv) {
		if (running.has(p.id) || p.env === envNow(p.meta)) continue;
		// several units can wait on one shared question: it is answered once
		if (p.q && open.delete(p.q)) ledger.answerQuestion(p.q, "auto: the environment changed since the failure (dependency manifest or stack config)", "orchestrator");
	}
	// waiting units whose blocking questions are all answered (non-blocking ones never hold a unit) get their answer applied
	const candidates = (ledger.db.prepare("SELECT id, state, meta FROM units WHERE state IN ('truth','implementing','gating','review') AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.unit_id = units.id AND a.ended_at IS NULL) AND NOT EXISTS (SELECT 1 FROM questions q WHERE (q.unit_id = units.id OR q.id IN (SELECT question_id FROM question_waiters w WHERE w.unit_id = units.id)) AND q.status = 'open' AND q.blocks != 'none')").all() as Array<{ id: string; state: string; meta: string }>).filter((u) => !running.has(u.id));
	const parked: typeof candidates = [];
	for (const u of candidates) {
		const meta = JSON.parse(u.meta) as { parked?: { question?: number; diagnosis?: { summary?: string; note?: string } }; hold?: number; applied?: number; ownLook?: boolean };
		// its own question, or the one it waits on with other units
		const q = ledger.db.prepare("SELECT id, unit_id, point, answer, options, answered_by FROM questions WHERE (unit_id = ? OR id IN (SELECT question_id FROM question_waiters WHERE unit_id = ?)) AND status IN ('answered','auto') AND id > ? ORDER BY id DESC LIMIT 1").get(u.id, u.id, meta.applied ?? 0) as { id: number; unit_id: string | null; point: string; answer: string; options: string | null; answered_by: string | null } | undefined;
		if (meta.hold && (!q || q.id <= meta.hold)) continue; // the owner said wait: only a newer answer or br requeue moves it
		const a = applyParkedAnswer(q?.answer, q?.options ? (JSON.parse(q.options) as string[]) : []);
		if (a.action === "hold") {
			ledger.updateUnit(u.id, { meta: { hold: q!.id, applied: q!.id } });
			continue;
		}
		// a model left another unit's question parked: that says nothing about this unit's own failure, which only looked
		// like it. It runs again on its own (once), and asks its own question if it fails again
		const notMine = a.action === "quarantine" && !!q?.unit_id && q.unit_id !== u.id && MODEL_ANSWERERS.includes(q.answered_by ?? "") && !meta.ownLook;
		if (notMine) ledger.db.prepare("DELETE FROM question_waiters WHERE question_id = ? AND unit_id = ?").run(q!.id, u.id);
		if (notMine) ledger.updateUnit(u.id, { meta: { ownLook: true } });
		if (a.action === "quarantine" && !notMine) {
			// healQuestion 0: the owner's answer stands, the auto-heal does not put it back nor ask again (br requeue does).
			// A model's leave parks it (parkedWhy): a later change on main that touches the failure brings it back
			const byModel = MODEL_ANSWERERS.includes(q!.answered_by ?? "");
			ledger.updateUnit(u.id, { meta: { applied: q!.id, healQuestion: 0, ...(byModel ? { parkedWhy: a.hint || `the ${q!.answered_by} left it parked`, parkedAt: Date.now() } : {}) } });
			ledger.transitionUnit(u.id, "quarantined", `${byModel ? q!.answered_by : "owner"} answered "${q!.answer}" on question #${q!.id}`);
			await removeWorktree(config.target.path, worktreeDir(root, u.id));
			log(pc.red(`■ ${u.id}: quarantined by the answer to #${q!.id}`));
			continue;
		}
		// what the run learned before parking (diagnosis) and the hint go to the next attempt, labelled by who gave it
		const lesson = [meta.parked?.diagnosis?.summary && `Before this unit waited, the failure was diagnosed as: ${meta.parked.diagnosis.summary}${meta.parked.diagnosis.note ? ` (${meta.parked.diagnosis.note})` : ""}.`, notMine && `It waited on question #${q!.id} about ${q!.unit_id}; a model left that one parked, which says nothing about this unit's own failure: look at it again on its own.`, !notMine && a.hint && `${MODEL_ANSWERERS.includes(q?.answered_by ?? "") ? "A model's hint (not the owner's)" : "The owner's hint"}: ${a.hint}`].filter(Boolean).join(" ");
		ledger.db.prepare("UPDATE units SET state = 'planned', updated_at = ?, meta = json_set(json_remove(meta, '$.parked', '$.hold', '$.stale', '$.staleReason'), '$.applied', ?, '$.retryNote', ?) WHERE id = ?").run(new Date().toISOString(), q?.id ?? meta.applied ?? 0, lesson || null, u.id);
		ledger.db.prepare("INSERT INTO transitions(entity, entity_id, from_state, to_state, reason, created_at) VALUES ('unit', ?, ?, 'planned', ?, ?)").run(u.id, u.state, `resubmitted: ${q ? `answer "${q.answer.slice(0, 80)}" on #${q.id}` : "cause resolved"}`, new Date().toISOString());
		await removeWorktree(config.target.path, worktreeDir(root, u.id));
		parked.push(u);
	}
	if (parked.length) log(pc.cyan(`↻ resubmitted ${parked.length} unit(s) whose blocker is resolved: ${parked.map((u) => u.id).slice(0, 5).join(", ")}${parked.length > 5 ? ", …" : ""}`));
	return parked.map((u) => u.id);
}

/** When the plugin's own code last changed (an update may fix what quarantined a unit); read once per process. */
export const PLUGIN_TIME = (() => {
	let t = 0;
	const walk = (d: string) => {
		for (const n of readdirSync(d, { withFileTypes: true })) {
			if (n.isDirectory()) walk(join(d, n.name));
			else t = Math.max(t, statSync(join(d, n.name)).mtimeMs);
		}
	};
	try {
		walk(dirname(dirname(fileURLToPath(import.meta.url))));
	} catch {
		/* not readable: only the workspace counts */
	}
	return t;
})();

/**
 * What changed in the plugin since `t`: its commits (subject and files) and what is not committed yet. Empty when
 * nothing did (a newer file time alone, as after a checkout, is no change).
 */
export async function pluginChangesSince(t: number): Promise<string> {
	const repo = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
	try {
		const commits = (await exec("git", ["-C", repo, "log", `--since=${new Date(t).toISOString()}`, "--format=%h %s", "--stat"])).trim();
		const open = (await exec("git", ["-C", repo, "diff", "--stat", "HEAD"])).trim();
		return [commits, open && `not committed yet:\n${open}`].filter(Boolean).join("\n\n");
	} catch {
		return PLUGIN_TIME > t ? "the plugin itself was updated (its git history could not be read)" : "";
	}
}

/** The files whose change may fix a quarantined unit of one stack: its setup fixes and gate commands, its dependency manifests, the old code's environment. */
function fixFiles(config: Config, root: string, manifests: Map<string, { toolchain: { manifestFiles: string[] } }>, stackId: string): string[] {
	return [join(root, ".bigrefactor", "legacy-env.json"), join(root, ".bigrefactor", "legacy-env.log"), ...setupFiles(root, stackId), ...(manifests.get(stackId)?.toolchain.manifestFiles ?? []).map((m) => join(projectDir(config, stackId), m))];
}

const mtime = (f: string) => {
	try {
		return statSync(f).mtimeMs;
	} catch {
		return 0; // not there
	}
};

/** The newest change that may fix a quarantined unit of this stack (another stack's fix does not count): see fixFiles, and the plugin. */
export function lastFixAt(config: Config, root: string, manifests: Map<string, { toolchain: { manifestFiles: string[] } }>, stackId: string): number {
	return Math.max(PLUGIN_TIME, ...fixFiles(config, root, manifests, stackId).map(mtime));
}

/** What changed for a stack since `t`, for the decide model: each setup fix logged since (its line and its commit's diff), the other files by name. */
async function changesSince(config: Config, root: string, manifests: Map<string, { toolchain: { manifestFiles: string[] } }>, stackId: string, t: number): Promise<string> {
	const out: string[] = [];
	const logFile = setupLogPath(root, stackId);
	let lines: string[] = [];
	try {
		lines = readFileSync(logFile, "utf8").split("\n").filter(Boolean);
	} catch {
		/* no fixes yet */
	}
	for (const line of lines) {
		const [at, sha] = line.split(" ");
		if (!(Date.parse(at ?? "") > t)) continue;
		let diff = "";
		if (sha && sha !== "override") {
			try {
				diff = await exec("git", ["-C", config.target.path, "show", "--format=", "--stat", "--patch", sha]);
			} catch {
				/* the commit is gone */
			}
		}
		out.push(`fix: ${line}${diff ? `\n${capText(diff, 4000)}` : ""}`);
	}
	for (const f of fixFiles(config, root, manifests, stackId)) if (f !== logFile && mtime(f) > t) out.push(`changed: ${relative(root, f)}`);
	if (PLUGIN_TIME > t) {
		const plugin = await pluginChangesSince(t);
		if (plugin) out.push(`the plugin itself changed:\n${capText(plugin, 3000)}`);
	}
	return out.join("\n\n");
}

/** The unit's last red attempt: the failed gate step's output (the reviewer's findings when the review failed), or the tester's error. */
function lastRedReport(ledger: Ledger, unitId: string): { step: string; output: string } | undefined {
	const r = ledger.db.prepare("SELECT outcome, gate_report FROM attempts WHERE unit_id = ? AND gate_report IS NOT NULL AND (outcome LIKE 'gate_red%' OR outcome IN ('truth_red', 'review_red')) ORDER BY id DESC LIMIT 1").get(unitId) as { outcome: string; gate_report: string } | undefined;
	if (!r) return undefined;
	try {
		const g = JSON.parse(r.gate_report) as { failedStep?: string; steps?: Array<{ name: string; ok: boolean; output?: string }>; error?: string; output?: string };
		const bad = g.steps?.find((s) => !s.ok);
		return { step: bad?.name ?? r.outcome, output: String(bad?.output ?? g.error ?? g.output ?? "") };
	} catch {
		return { step: r.outcome, output: r.gate_report };
	}
}

/**
 * A failure by its error, not its words: the failed step's first error line, normalized (errorSignature), else the
 * quarantine reason. A unit keeps the ones it was retried on (meta.retriedOn), so the same error in new words is still
 * the same failure, and a new error at the same step is not.
 */
export function failureKind(unitId: string, reason: string, last?: { step: string; output: string }): string {
	// the unit's own id is never part of the key
	return last ? errorSignature(last.step, last.output.replaceAll(unitId, "<unit>")) : errorSignature("quarantine", reason);
}

/** One finished unit as the circuit breaker sees it: the failure text and its key, whatever kind of failure it was. */
export interface BreakerEntry {
	unit: string;
	ok: boolean;
	/** triage's label for a gate failure ("env", "code", ...) or "exception" for a crash */
	triage?: string;
	/** what went wrong: the crash, the failed gate step's output, or why the unit stopped (a merge error, a quarantine) */
	text?: string;
	sig?: string;
	step?: string;
	/** the failed gate step's (or crash's) full output, for the diagnosis */
	output?: string;
}

export function breakerEntry(ledger: Ledger, unitId: string, st: string, res: UnitRunResult | undefined, crash?: string): BreakerEntry {
	const ok = !crash && (st === "accepted" || st === "review");
	if (ok) return { unit: unitId, ok };
	// the unit's own id (a branch, a commit subject) is never part of the key
	const sig = (step: string, out: string) => errorSignature(step, out.replaceAll(unitId, "<unit>"));
	const bad = crash ? { name: "exception", output: crash } : res?.gate?.steps.find((x) => !x.ok);
	if (bad) {
		const output = String(bad.output ?? "");
		return { unit: unitId, ok, triage: crash ? "exception" : res?.triage?.cause, text: `${bad.name}: ${output}`, sig: sig(bad.name, output), step: bad.name, output };
	}
	// waiting only on the owner's keep/drop of the old code's quirks: nothing failed, so nothing to heal
	const waits = st === "quarantined" ? [] : ledger.openQuestions().filter((q) => q.unit_id === unitId && q.blocks !== "none");
	if (waits.length && waits.every((q) => q.point === "quirk")) return { unit: unitId, ok: true };
	// no failed gate step (a merge error, truth, a question): the reason of the unit's last transition says why
	const reason = ledger.transitionsOf("unit", unitId).at(-1)?.reason ?? st;
	return { unit: unitId, ok, triage: res?.triage?.cause, text: reason, sig: sig(st, reason), step: st };
}

/**
 * What the circuit breaker does with the recent units: `same` when 3 failed with one key not tried yet (code heals,
 * no model needed); otherwise, when most of them failed, the set to show the model. Its key is the set of error keys,
 * so a set already healed is not asked again but a later storm with other errors is. undefined: nothing to do.
 */
export function breakerPick(recent: BreakerEntry[], tried: Set<string>): { same: boolean; key: string; failed: BreakerEntry[] } | undefined {
	const failed = recent.filter((r) => !r.ok);
	const bySig = new Map<string, BreakerEntry[]>();
	for (const f of failed) if (f.sig) bySig.set(f.sig, [...(bySig.get(f.sig) ?? []), f]);
	const same = [...bySig.entries()].find(([sig, fs]) => fs.length >= 3 && !tried.has(sig));
	if (same) return { same: true, key: same[0], failed: same[1] };
	if (failed.length < 3 || failed.length < recent.length / 2) return undefined;
	const key = `set: ${[...new Set(failed.map((f) => f.sig ?? f.unit))].sort().join("\n")}`;
	return tried.has(key) ? undefined : { same: false, key, failed };
}

/** Long text for a model: its start and its end (the error line is often at one of them). */
function capText(t: string, max: number): string {
	return t.length <= max ? t : `${t.slice(0, Math.floor(max * 0.4))}\n…\n${t.slice(-Math.floor(max * 0.6))}`;
}

/**
 * SQL (on a dep row `du`) for a dependency still to wait for: not accepted, and not excluded by the owner (not app
 * code: it never runs, so waiting for it would hold its dependents forever). A dep that is no unit any more is not
 * joined at all, so it never blocks.
 */
const OPEN_DEP = "du.state != 'accepted' AND json_extract(du.meta, '$.exclude') IS NULL";

/**
 * Parity questions answered since the last run ("retry" or "leave" after a unit ran out of parity re-opens), applied
 * once per answer. Returns the slices of the units to compare again. The owner's retry is a fresh set of re-opens; a
 * model's retry is one more, so a model cannot loop a unit forever.
 */
export function applyParityAnswers(ledger: Ledger): string[] {
	const slices: string[] = [];
	// answers already applied are skipped in SQL: reading every unit's meta in JS held Pi's thread for ~0.2 s
	const answered = `SELECT unit_id, MAX(id) AS id FROM questions WHERE point = 'parity' AND answer IS NOT NULL AND unit_id IS NOT NULL GROUP BY unit_id`;
	for (const q of ledger.db.prepare(`SELECT a.unit_id, a.id FROM (${answered}) a JOIN units u ON u.id = a.unit_id WHERE COALESCE(json_extract(u.meta, '$.parityRetried'), -1) != a.id`).all() as Array<{ unit_id: string; id: number }>) {
		const meta = JSON.parse(ledger.getUnit(q.unit_id)?.meta ?? "{}") as { parityRetried?: number; slice?: string };
		if (meta.parityRetried === q.id) continue;
		const question = ledger.getQuestion(q.id);
		const value = answerValue(question?.answer);
		const retry = value === "retry";
		const reopens = MODEL_ANSWERERS.includes(question?.answered_by ?? "") ? MAX_PARITY_REOPENS - 1 : 0;
		// "leave" is remembered, so the judge does not ask about this unit again at the next comparison
		ledger.updateUnit(q.unit_id, { meta: { parityRetried: q.id, ...(retry ? { parityReopens: reopens, parityLeft: undefined } : value === "leave" ? { parityLeft: q.id } : {}) } });
		if (retry && meta.slice) slices.push(meta.slice);
	}
	return slices;
}

/** How many times run.unitsPerModule a module may run while lanes are free and only the module limit holds ready units. */
export const MODULE_BOOST = 3;

/** The lanes line when ready units wait only for the module limit (run.unitsPerModule, raised while lanes are free). */
export function moduleWaitNote(wait: Map<string, number>, perModule: number): string {
	const n = [...wait.values()].reduce((a, b) => a + b, 0);
	const where = [...wait].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k} (${c})`);
	return `${n} ready unit${n === 1 ? "" : "s"} wait for a free place in ${where.slice(0, 3).join(", ")}${where.length > 3 ? ", …" : ""}: at most ${perModule * MODULE_BOOST} per module while lanes are free (run.unitsPerModule ${perModule}; a DB or shared module runs 1)`;
}

/** Parity comparisons that failed with an error in a row before a slice is left alone (until a unit of it lands again). */
export const MAX_PARITY_ERRORS = 3;

/**
 * Slices compared before (`checked`), and those whose last comparison needs another look at run start (`again`): it
 * ended in an error (a few times in a row at most), left differences nobody judged, holds quirks the owner has
 * decided since, or ran on an older main than `head` (later units, tidy jobs and repairs change shared code). Only the last run counts: once a later run judged a decided quirk, the slice is not queued again.
 * An app that did not start here ("setup") says nothing about the code: it never counts as an error, and such a slice
 * is compared again. `fixed`: a unit the last real comparison blamed was accepted after it (a fix not compared yet);
 * that also gives a slice that errored too often its tries back.
 */
export function parityAgain(ledger: Ledger, head?: string): { checked: Set<string>; again: Set<string>; fixed: Set<string> } {
	// CROSS JOIN keeps SQLite on the blamed diffs first, then each unit's own transitions: left to choose, it walked every
	// unit transition (200k+ in a long run) for each slice and held the run's thread a second at every accept
	const rows = ledger.db
		.prepare(
			`SELECT x.*, (SELECT COUNT(*) FROM parity_runs e WHERE e.slice = x.slice AND e.outcome = 'error' AND e.id > x.compared_id
			   AND (x.fixed_at IS NULL OR julianday(e.started_at) > x.fixed_at)) AS errors
			 FROM (SELECT r.slice, r.outcome, r.commit_sha, COALESCE(c.id, 0) AS compared_id,
			   (SELECT MAX(julianday(t.created_at)) FROM parity_diffs d CROSS JOIN transitions t ON t.entity = 'unit' AND t.entity_id = d.unit_id AND t.to_state = 'accepted'
			      WHERE d.run_id = c.id AND d.status = 'bug' AND julianday(t.created_at) > julianday(COALESCE(c.ended_at, c.started_at))) AS fixed_at,
			   EXISTS (SELECT 1 FROM parity_diffs d WHERE d.run_id = r.id AND d.status = 'open') AS unjudged,
			   EXISTS (SELECT 1 FROM parity_diffs d JOIN quirks q ON q.id = d.quirk_id WHERE d.run_id = r.id AND d.status = 'quirk' AND q.status IN ('kept', 'dropped')) AS decided
			 FROM parity_runs r LEFT JOIN parity_runs c ON c.id = (SELECT MAX(g.id) FROM parity_runs g WHERE g.slice = r.slice AND g.outcome IN ('same', 'differs'))
			 WHERE r.id = (SELECT MAX(id) FROM parity_runs WHERE slice = r.slice)) x`,
		)
		.all() as Array<{ slice: string; outcome: string; commit_sha: string | null; compared_id: number | null; fixed_at: number | null; errors: number; unjudged: number; decided: number }>;
	// a run from before commits were recorded has none: it is not compared again just for that
	const moved = (r: (typeof rows)[number]) => !!head && !!r.commit_sha && r.commit_sha !== head;
	const fixed = rows.filter((r) => r.fixed_at !== null && (r.outcome !== "error" || r.errors < MAX_PARITY_ERRORS)).map((r) => r.slice);
	const again = rows.filter((r) => (r.outcome === "setup" ? true : r.outcome === "error" ? r.errors < MAX_PARITY_ERRORS : r.unjudged || r.decided || moved(r) || r.fixed_at !== null)).map((r) => r.slice);
	return { checked: new Set(rows.map((r) => r.slice)), again: new Set(again), fixed: new Set(fixed) };
}

/** Whether a unit's accept queues its slice's comparison: a route owner's accept changes what is compared, a slice
 * never compared is queued once, and so is the fix of a unit its last comparison blamed. */
export function parityOnAccept(ledger: Ledger, slice: string, unitId: string): boolean {
	if (routeOwners(ledger, slice).some((u) => u.id === unitId)) return true;
	const pa = parityAgain(ledger);
	return !pa.checked.has(slice) || pa.fixed.has(slice);
}

const ledgerTime = (s: string) => Date.parse(s.includes("T") ? s : `${s.replace(" ", "T")}Z`);

type Quarantined = { id: string; meta: string; at: string; reason: string | null };
const quarantinedUnits = (ledger: Ledger) =>
	ledger.db.prepare("SELECT u.id, u.meta, t.created_at at, t.reason FROM units u JOIN transitions t ON t.id = (SELECT MAX(id) FROM transitions WHERE entity = 'unit' AND entity_id = u.id AND to_state = 'quarantined') WHERE u.state = 'quarantined'").all() as Quarantined[];

/**
 * Requeue a quarantined unit; it remembers the failure it heals from and the kinds of failure it was retried on, so
 * the same failure again is not retried blindly.
 */
async function backInQueue(ledger: Ledger, config: Config, root: string, id: string, heals: number, note: string, from: string, retriedOn: string[]): Promise<void> {
	await requeueUnits(ledger, config, root, [id], "self-heal", { keepCode: true });
	ledger.db.prepare("UPDATE units SET meta = json_set(json_remove(meta, '$.healQuestion', '$.stuck', '$.parkedWhy', '$.parkAsked'), '$.autoHeals', ?, '$.retryNote', ?, '$.healedFrom', ?, '$.retriedOn', json(?)) WHERE id = ?").run(heals, note, from, JSON.stringify(retriedOn), id);
}

/** The failure as the decide model reads it: why it stopped, the kind of failure, and the failed step's error messages first (not the step's noisy start). */
function failureForDecide(reason: string, kind: string, last?: { step: string; output: string }): string {
	return `${reason}\nKind of failure: ${kind}${last ? `\n${last.step}:\n${clipOutput(last.output, 2500)}` : ""}`;
}

/**
 * The newest answer a job (fix, code or layout job) gave after `at` on the unit's own question or one it waits on: that
 * job changed main for this unit, so it is no plain retry.
 */
function jobAnswerAfter(ledger: Ledger, unitId: string, at: string): { id: number; answer: string; options: string | null; answered_by: string } | undefined {
	const jobs = MODEL_ANSWERERS.filter((m) => m !== RESOLVER);
	const q = ledger.db
		.prepare(`SELECT id, answer, options, answered_by, answered_at FROM questions WHERE (unit_id = ? OR id IN (SELECT question_id FROM question_waiters WHERE unit_id = ?)) AND status = 'answered' AND answered_by IN (${jobs.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 1`)
		.get(unitId, unitId, ...jobs) as { id: number; answer: string; options: string | null; answered_by: string; answered_at: string } | undefined;
	if (!q || ledgerTime(q.answered_at) < ledgerTime(at)) return undefined;
	return applyParkedAnswer(q.answer, q.options ? (JSON.parse(q.options) as string[]) : []).action === "requeue" ? q : undefined;
}

/**
 * Does a change made since a stuck unit's failure plausibly touch that failure? The decide model reads what changed
 * (each setup fix with its diff) and the unit's last red report. undefined: the model is unavailable (ask next pass).
 */
async function changeTouches(d: { ledger: Ledger; config: Config; client: ModelClient }, unitId: string, changes: string, failure: string): Promise<boolean | undefined> {
	try {
		const dec = await decide({ client: d.client, ledger: d.ledger, model: d.config.models.decide.id }, "heal_stuck", { changes: capText(changes, 6000), failure: capText(failure, 3000) }, {
			touches: { type: "noul", instructions: "Could a change in `changes` plausibly fix the failure in `failure`? Yes when it touches what the failure is about (the same tool, command, config, dependency, file or error); no when it is about something else." },
		}, ["touches"], unitId);
		return noulOf(dec.answers["touches"]) > 0.5;
	} catch {
		return undefined;
	}
}

/**
 * Quarantined units heal by themselves, up to run.maxAutoHeals times: back into the queue when something of their
 * own stack changed after they failed (see lastFixAt) and the decide model says the change touches their own failure
 * (without a client: on any change), or after run.healEveryMinutes when the failure is new. The same failure again
 * with nothing changed is not retried: the unit is stuck and asked about (askStuckUnits; a model tries first, one
 * question per kind of failure), and the answer is applied here. A requeue here keeps the unit's code (keepUnitWork).
 */
export async function healQuarantined(ledger: Ledger, config: Config, root: string, running: Set<string>, log: (l: string) => void, manifests: Map<string, { toolchain: { manifestFiles: string[] } }>, o: { since?: number; now?: number; client?: ModelClient; pluginChangedAt?: number; pluginChanges?: (since: number) => Promise<string> } = {}): Promise<string[]> {
	const pluginAt = o.pluginChangedAt ?? PLUGIN_TIME;
	// one change time per stack per pass
	const sinces = new Map<string, number>();
	const sinceOf = (stackId: string) => o.since ?? (sinces.get(stackId) ?? sinces.set(stackId, lastFixAt(config, root, manifests, stackId)).get(stackId)!);
	const now = o.now ?? Date.now();
	// when each run started (its code was loaded then): runs.jsonl and the run going on
	const runStarts: number[] = [];
	try {
		for (const l of readFileSync(join(root, ".bigrefactor", "runs.jsonl"), "utf8").split("\n")) if (l.trim()) runStarts.push(Date.parse((JSON.parse(l) as RunRecord).startedAt));
	} catch {
		/* no runs written yet */
	}
	try {
		const open = ledger.getMeta(OPEN_RUN);
		if (open) runStarts.push(Date.parse((JSON.parse(open) as { startedAt: string }).startedAt));
	} catch {
		/* no run going on */
	}
	const runStartBefore = (t: number) => Math.max(0, ...runStarts.filter((s) => s <= t)) || t;
	const back: string[] = [];
	for (const r of quarantinedUnits(ledger)) {
		if (running.has(r.id)) continue;
		const meta = JSON.parse(r.meta) as { autoHeals?: number; healQuestion?: number; healedFrom?: string; stuck?: boolean; healChecked?: number; retriedOn?: string[]; parkedWhy?: string; parkedAt?: number; pluginSeen?: number; parkAsked?: number; jobTried?: number; ownLook?: boolean; parked?: { question?: number } };
		// a question withdrawn after it was asked (the unit was requeued meanwhile) answers nothing: as if none was asked
		if (meta.healQuestion && ledger.getQuestion(meta.healQuestion)?.status === "withdrawn") {
			// the owner's question about a parked unit: parked as before, asked again (askAboutParked)
			const asked = meta.healQuestion === meta.parkAsked;
			ledger.db.prepare(asked ? "UPDATE units SET meta = json_set(json_remove(meta, '$.parkAsked'), '$.healQuestion', 0) WHERE id = ?" : "UPDATE units SET meta = json_remove(meta, '$.healQuestion') WHERE id = ?").run(r.id);
			if (asked) (meta.healQuestion = 0), delete meta.parkAsked;
			else delete meta.healQuestion;
		}
		const heals = meta.autoHeals ?? 0;
		const why = (r.reason ?? "").slice(0, 300);
		const failure = errorSignature("quarantine", r.reason ?? "");
		// the failure itself goes into the note: the kept code may not apply on main any more, then this is all the next run has
		const last = lastRedReport(ledger, r.id);
		const lastFailure = last ? `\nIts last failure (${last.step}):\n${capText(last.output, 3000)}` : "";
		const kind = failureKind(r.id, r.reason ?? "", last);
		const retriedOn = [...new Set([...(meta.retriedOn ?? []), kind])];
		const park = (parkedWhy: string, at = Date.now()) => ledger.db.prepare("UPDATE units SET meta = json_set(meta, '$.healQuestion', 0, '$.parkedWhy', ?, '$.parkedAt', ?) WHERE id = ?").run(parkedWhy, at, r.id);
		const stackId = placeUnit(config, r.meta, root).stackId;
		const since = sinceOf(stackId);
		// a change counts only when the decide model says it touches this unit's own failure: a setup fix about something
		// else would only run the unit into the same failure again
		let changed = ledgerTime(r.at) < since;
		// parked by a model: quietly (healQuestion 0), or with the owner asked about it (askAboutParked) and no answer yet
		const quiet = !!meta.parkedWhy && (meta.healQuestion === 0 || (!!meta.parkAsked && meta.healQuestion === meta.parkAsked));
		// it waited on another unit's question, and a model left that one parked: that says nothing about this unit's own
		// failure (it only looked like it). One run on its own, which asks its own question if it fails again
		const shared = quiet && meta.parked?.question ? ledger.getQuestion(meta.parked.question) : undefined;
		if (shared?.unit_id && shared.unit_id !== r.id && MODEL_ANSWERERS.includes(shared.answered_by ?? "") && !meta.ownLook) {
			await backInQueue(ledger, config, root, r.id, heals + 1, `This unit was parked on question #${shared.id} about ${shared.unit_id}, which only looked like its own failure; a model left that one parked, which says nothing about this unit. Look at its own failure again (automatic try ${heals + 1}).${lastFailure}`, failure, retriedOn);
			ledger.updateUnit(r.id, { meta: { ownLook: true } });
			back.push(r.id);
			continue;
		}
		// a job (code, fix or layout job) changed main for this unit's own question after it failed: one try on top of
		// that change, past its automatic tries too (no plain retry; the decide model is not asked, the job was for it)
		const job = quiet ? jobAnswerAfter(ledger, r.id, r.at) : undefined;
		if (job && job.id !== meta.jobTried) {
			const hint = applyParkedAnswer(job.answer, job.options ? (JSON.parse(job.options) as string[]) : []).hint;
			await backInQueue(ledger, config, root, r.id, heals + 1, `This unit was quarantined (${why}); the ${job.answered_by} changed main for its question #${job.id}, so it runs again on top of that change (automatic try ${heals + 1}).${hint ? ` The model's hint: ${hint}` : ""}${lastFailure}`, failure, retriedOn);
			ledger.updateUnit(r.id, { meta: { jobTried: job.id } });
			back.push(r.id);
			continue;
		}
		// a unit a model parked waits for a change on main after the park, past its automatic tries (the owner's leave stands)
		const parked = quiet && since > (meta.parkedAt ?? 0);
		const mayRun = (meta.healQuestion !== 0 && heals < config.run.maxAutoHeals && (meta.stuck || !meta.healQuestion)) || parked;
		// parked before the plugin changed: what parked it may be fixed in the plugin itself (main shows no change). One
		// more try when the plugin's own changes since the park touch what parked it (the decide model reads them, as for
		// a change on main), counted, past the automatic tries too (like a change on main after the park: a fix in the
		// plugin is no plain retry); asked once per plugin version, and a new park after that try is newer than the plugin
		// "since the park" means since the code the unit last ran on was loaded: the start of the run it was parked in
		// (a fix committed while that run went on is new to the unit, though older than the park)
		const ranOn = runStartBefore(meta.parkedAt ?? 0);
		if (quiet && pluginAt > ranOn && (meta.pluginSeen ?? 0) < pluginAt) {
			// only what is new since the last look: each change is judged once, while it is new, and the list stays short
			const changes = await (o.pluginChanges ?? pluginChangesSince)(Math.max(ranOn, meta.pluginSeen ?? 0));
			const touches = !changes ? false : o.client ? await changeTouches({ ledger, config, client: o.client }, r.id, `The migration tool (plugin) changed:\n${changes}`, `Parked: ${meta.parkedWhy}\n${failureForDecide(r.reason ?? "", kind, last)}`) : true;
			// the decide model is unavailable: asked next pass
			if (touches === undefined) continue;
			if (touches) {
				await backInQueue(ledger, config, root, r.id, heals + 1, `This unit was parked (${meta.parkedWhy}); the migration tool changed since in a way that may fix it, so it runs again (automatic try ${heals + 1} of ${config.run.maxAutoHeals}). Take the earlier failure into account.${lastFailure}`, failure, retriedOn);
				back.push(r.id);
				continue;
			}
			ledger.db.prepare("UPDATE units SET meta = json_set(meta, '$.pluginSeen', ?) WHERE id = ?").run(pluginAt, r.id);
		}
		if (changed && mayRun) {
			// a change the decide model already said does not touch this failure is not asked about again: it sees only
			// the changes since its last no (healChecked), so a long park never pushes the newest fix out of what it reads
			const touches = since <= (meta.healChecked ?? 0) ? false : o.client ? await changeTouches({ ledger, config, client: o.client }, r.id, await changesSince(config, root, manifests, stackId, Math.max(ledgerTime(r.at), meta.healChecked ?? 0)), failureForDecide(r.reason ?? "", kind, last)) : true;
			if (touches) {
				// something changed since the unit failed that may fix it: worth a try, an open question about it or not
				await backInQueue(ledger, config, root, r.id, heals + 1, `This unit was quarantined before (${why}); something changed since, it runs again (automatic try ${heals + 1} of ${config.run.maxAutoHeals}). Take the earlier failure into account.${parked ? ` It was parked: ${meta.parkedWhy}` : ""}${lastFailure}`, failure, retriedOn);
				back.push(r.id);
				continue;
			}
			// the decide model is unavailable: the unit stays as it is, it is asked next pass
			if (touches === undefined) continue;
			ledger.db.prepare("UPDATE units SET meta = json_set(meta, '$.healChecked', ?) WHERE id = ?").run(since, r.id);
			// no: as if nothing changed
			changed = false;
		}
		if (meta.healQuestion) {
			// the owner's answer: retry (with any hint they typed) gives the unit a fresh set of tries; leave keeps it.
			// A model's retry (resolver, fix, code or layout job) is one more try, not a fresh set: its answers on the same failure would
			// otherwise put a unit back forever
			const q = ledger.getQuestion(meta.healQuestion);
			if (!q || (q.status !== "answered" && q.status !== "auto")) continue;
			const a = applyParkedAnswer(q.answer ?? "", q.options ? (JSON.parse(q.options) as string[]) : []);
			const byModel = MODEL_ANSWERERS.includes(q.answered_by ?? "");
			if (a.action !== "requeue") {
				// the resolver's leave: nothing a model can do is left; it stays parked (br status), the owner is not asked
				if (byModel) park(a.hint || "the resolver model left it parked");
				else ledger.db.prepare("UPDATE units SET meta = json_set(meta, '$.healQuestion', 0) WHERE id = ?").run(r.id);
				continue;
			}
			// a model's retry counts against the automatic tries: past them it stays parked, no question (askAboutParked asks
			// the owner when others wait on it). A job changed main for this question: one try on top of it, past the tries too
			const job = byModel && q.answered_by !== RESOLVER;
			if (byModel && heals >= config.run.maxAutoHeals && !(job && meta.jobTried !== q.id)) {
				park(`the ${q.answered_by} said to try again, but its ${config.run.maxAutoHeals} automatic tries are used up${job && a.hint ? `. Its hint: ${a.hint}` : ""}`, job ? ledgerTime(r.at) : Date.now());
				log(pc.yellow(`⏸ ${r.id}: stays parked, no automatic try left (br requeue ${r.id} after a change)`));
				continue;
			}
			// the owner gave more tries for the resolver's hint (ownerMayGrant): it goes with them
			const resolverHint = !byModel && q.context ? (JSON.parse(q.context) as { resolverHint?: string }).resolverHint : undefined;
			await backInQueue(ledger, config, root, r.id, byModel ? heals + 1 : 0, `This unit was quarantined (${why}); ${byModel ? `the ${q.answered_by}` : "the owner"} said to try again.${a.hint ? ` The ${byModel ? "model's" : "owner's"} hint: ${a.hint}` : ""}${resolverHint ? ` The resolver model's hint: ${resolverHint}` : ""}${lastFailure}`, failure, retriedOn);
			if (job) ledger.updateUnit(r.id, { meta: { jobTried: q.id } });
			back.push(r.id);
			continue;
		}
		if (meta.healQuestion === 0 || meta.stuck || heals >= config.run.maxAutoHeals) continue;
		if (!changed) {
			// nothing changed (nothing that touches its failure) and it failed the same way (the same words, or a kind it was retried on): another try would only cost money
			if (failure === meta.healedFrom || meta.retriedOn?.includes(kind)) {
				ledger.db.prepare("UPDATE units SET meta = json_set(meta, '$.stuck', json('true')) WHERE id = ?").run(r.id);
				continue;
			}
			if (now - ledgerTime(r.at) < config.run.healEveryMinutes * 60_000) continue;
		}
		await backInQueue(ledger, config, root, r.id, heals + 1, `This unit was quarantined before (${why}); it runs again (automatic try ${heals + 1} of ${config.run.maxAutoHeals}). Take the earlier failure into account.${lastFailure}`, failure, retriedOn);
		back.push(r.id);
	}
	if (back.length) log(pc.cyan(`⚕ ${back.length} quarantined unit(s) back in the queue: ${back.slice(0, 5).join(", ")}${back.length > 5 ? ", …" : ""}`));
	return back;
}

/**
 * Units that used up their automatic tries: the owner is asked, one question per kind of failure (it blocks only
 * those units). The facts and the key hold the unit's last red report, so only units that really fail alike share a
 * question; the owner's earlier answers on such questions go to the phrasing model (askViaModel).
 */
export async function askStuckUnits(d: { ledger: Ledger; config: Config; root: string; client?: ModelClient }): Promise<number> {
	let asked = 0;
	for (const r of quarantinedUnits(d.ledger)) {
		const meta = JSON.parse(r.meta) as { autoHeals?: number; healQuestion?: number; stuck?: boolean; retriedOn?: string[] };
		if (meta.healQuestion !== undefined || (!meta.stuck && (meta.autoHeals ?? 0) < d.config.run.maxAutoHeals)) continue;
		const last = lastRedReport(d.ledger, r.id);
		// what a retry may still be: none once the automatic tries are used up; only with a hint (or a job) after one on this kind of failure
		const kind = failureKind(r.id, r.reason ?? "", last);
		const retry = (meta.autoHeals ?? 0) >= d.config.run.maxAutoHeals ? "none" : meta.retriedOn?.includes(kind) ? "with a hint" : undefined;
		const q = await askViaModel(d, {
			point: "quarantine",
			unitId: r.id,
			facts: `${r.id} was quarantined and tried again automatically ${meta.autoHeals ?? 0} times${meta.stuck ? "; the last try failed the same way as the one before" : ""}: ${(r.reason ?? "").slice(0, 600)}.${last ? `\nIts last failure (${last.step}):\n${capText(last.output, 1500)}` : ""}${retry === "none" ? "\nIts automatic tries are used up: a plain retry is no answer, only a change on main (a job) or the owner." : retry ? `\nIt was already retried on this kind of failure (${kind}): a plain retry is no answer, only one with a hint that changes the attempt, or a change on main.` : ""}\nOther units with the same failure wait on this answer too.`,
			options: [
				{ value: "retry", facts: "try again (after you fixed something; type a hint instead to steer the next attempt)" },
				{ value: "leave", facts: "leave it parked" },
			],
			blocks: "unit",
			askedBy: "orchestrator",
			context: { failureKind: kind, ...(retry ? { retry } : {}) },
			// units with a different retry left never share a question: one's "retry is no answer" is not the other's
			sameAs: [errorSignature("quarantine", r.reason ?? ""), last && kind, retry && `retry ${retry}`].filter(Boolean).join(" | "),
		});
		// only while it is still quarantined: a self-heal may have requeued it while the question was being asked
		d.ledger.db.prepare("UPDATE units SET meta = json_set(meta, '$.healQuestion', ?) WHERE id = ? AND state = 'quarantined'").run(q.id, r.id);
		if (!q.shared) asked++;
	}
	return asked;
}

/**
 * A unit a model parked (nothing a model can do is left) is not kept quiet when a person is needed: when units wait on
 * it, when accepted units are built on it (it was re-opened after they were accepted), or when nothing else is left to
 * run (the migration cannot finish without it). The owner gets one question per unit: what waits on it, why it was
 * parked (the models' last hint), its last failure and what the last code job for it wrote. Asked once per park
 * (meta.parkAsked); the answer is applied like the unit's other questions (healQuarantined: the owner's retry gives a
 * fresh set of tries). Returns how many were asked.
 */
export function askAboutParked(ledger: Ledger): number {
	const quarantined = quarantinedUnits(ledger);
	const parked = quarantined.filter((r) => {
		const m = JSON.parse(r.meta) as { healQuestion?: number; parkedWhy?: string; parkAsked?: number };
		return m.healQuestion === 0 && !!m.parkedWhy && !m.parkAsked;
	});
	if (!parked.length) return 0;
	const waiting = waitersOf(ledger);
	// the end of the run: every unit still to do waits on a quarantined one
	const behind = new Set(quarantined.flatMap((r) => waiting(r.id)));
	const rest = (ledger.db.prepare("SELECT id FROM units WHERE state NOT IN ('accepted', 'quarantined') AND json_extract(meta, '$.exclude') IS NULL").all() as Array<{ id: string }>).map((r) => r.id);
	const endGame = rest.every((id) => behind.has(id));
	const list = (ids: string[]) => `${ids.slice(0, 8).join(", ")}${ids.length > 8 ? ` and ${ids.length - 8} more` : ""}`;
	let asked = 0;
	for (const r of parked) {
		const parkedWhy = (JSON.parse(r.meta) as { parkedWhy: string }).parkedWhy;
		const waits = waiting(r.id);
		const builtOn = (ledger.db.prepare("SELECT id FROM units WHERE state = 'accepted' AND EXISTS (SELECT 1 FROM json_each(units.deps) WHERE value = ?)").all(r.id) as Array<{ id: string }>).map((u) => u.id);
		if (!waits.length && !builtOn.length && !endGame) continue;
		const needed = [waits.length && `${waits.length} unit(s) cannot start until it is done (${list(waits)})`, builtOn.length && `accepted units are built on it (${list(builtOn)})`, !waits.length && !builtOn.length && "nothing else is left to run, and the migration cannot finish without it"].filter(Boolean).join(", and ");
		const last = lastRedReport(ledger, r.id);
		const diff = (ledger.db.prepare("SELECT json_extract(context, '$.jobDiff') diff FROM questions WHERE unit_id = ? AND json_extract(context, '$.jobDiff') IS NOT NULL ORDER BY id DESC LIMIT 1").get(r.id) as { diff: string } | undefined)?.diff;
		const id = ledger.askQuestion({
			unitId: r.id,
			point: "parked",
			question: `${r.id} is parked: the models can do nothing more for it. You are asked because ${needed}.\nWhy it was parked: ${parkedWhy.slice(0, 1500)}${last ? `\nIts last failure (${last.step}):\n${clipOutput(last.output, 1500)}` : ""}${diff ? `\nWhat the last code job for it wrote (not merged):\n${diff.slice(0, 3000)}` : ""}\nLook at it, then give it a fresh set of tries (type a hint with what it should do differently), or leave it parked.`,
			options: ["retry — give it a fresh set of tries (type a hint to steer it)", "leave — leave it parked"],
			blocks: "unit",
			askedBy: "orchestrator",
			context: { parkedWhy, waiting: waits, builtOn },
		});
		ledger.markForOwner(id, needed);
		ledger.updateUnit(r.id, { meta: { healQuestion: id, parkAsked: id } });
		asked++;
	}
	return asked;
}

/** A quarantined unit's ported tests, kept next to its truth before its worktree goes: a requeue puts them back instead of having them written again. */
export function keepPortedTests(config: Config, root: string, unitId: string, meta: string, wt: string, layout: TargetAdapter["layout"]): string[] {
	try {
		const place = placeUnit(config, meta, root);
		const dir = join(wt, relative(config.target.path, projectDir(config, place.stackId)));
		const ported = join(root, ".bigrefactor", "truth", unitId, "ported");
		const files = findTests(dir, placementDir(layout, place), layout);
		for (const f of files) {
			mkdirSync(dirname(join(ported, f)), { recursive: true });
			cpSync(join(dir, f), join(ported, f));
		}
		return files;
	} catch {
		return []; // no worktree or no tests: the tester writes them again
	}
}

/**
 * A quarantined unit's code, committed on its branch before its worktree goes: a self-heal requeue starts from it
 * instead of from nothing. Returns the commit, or undefined when the unit wrote nothing.
 */
export async function keepUnitWork(wt: string, unitId: string): Promise<string | undefined> {
	try {
		await gitIn(wt, ["add", "-A"]); // generated paths are excluded repo-wide, as in mergeUnit
		if (!await gitIn(wt, ["diff", "--cached", "--name-only"])) return undefined;
		await gitIn(wt, ["-c", "user.name=bigrefactor", "-c", "user.email=bigrefactor@localhost", "commit", "-q", "-m", `wip: ${unitId} as it was quarantined`]);
		return await headOf(wt);
	} catch {
		return undefined; // no worktree: nothing to keep
	}
}

/**
 * Whether a unit's code stays on its branch when its lane ends: it is quarantined (a self-heal goes on from it) or
 * waits (on a question: a code job for that question starts from it, and so does the unit once answered; or after
 * a setup fix on main: the fix may wire code only this unit has, so the unit goes on from it on the fixed main), and
 * its code is worth keeping (mayKeepCode).
 */
export function keepsCode(ledger: Ledger, unitId: string): boolean {
	const u = ledger.getUnit(unitId)!;
	const waits = !!(JSON.parse(u.meta) as { parked?: object }).parked;
	return (u.state === "quarantined" || (waits && u.state !== "accepted")) && mayKeepCode(ledger, unitId);
}

/**
 * Whether a quarantined unit's code is worth keeping: not when its last gate failed antigaming_ok, as the kept files
 * (outside its scope, edited shared ones) would fail it the same way on every self-heal.
 */
export function mayKeepCode(ledger: Ledger, unitId: string): boolean {
	const last = ledger.db.prepare("SELECT outcome FROM attempts WHERE unit_id = ? AND outcome LIKE 'gate_%' ORDER BY id DESC LIMIT 1").get(unitId) as { outcome: string } | undefined;
	return last?.outcome !== "gate_red:antigaming_ok";
}

/**
 * A self-healed unit goes on from its kept code (keptWork), put on top of current main in its fresh worktree; the
 * kept code is used once. The reviewer's open findings point at that code: they carry over only when it does.
 * Returns the files that conflicted with main (they hold both sides), or undefined when nothing was put back.
 */
export async function restoreKeptWork(ledger: Ledger, wt: string, unitId: string): Promise<string[] | undefined> {
	const keptWork = (JSON.parse(ledger.getUnit(unitId)!.meta) as { keptWork?: string }).keptWork;
	const conflicts = keptWork ? await restoreUnitWork(wt, keptWork) : undefined;
	if (keptWork) ledger.updateUnit(unitId, { meta: { keptWork: undefined } });
	if (!conflicts) ledger.db.prepare("UPDATE units SET meta = json_remove(meta, '$.reviewFindings') WHERE id = ?").run(unitId);
	return conflicts;
}

/**
 * Put kept code (keepUnitWork, or a unit commit that did not rebase) back into a fresh worktree on current main,
 * uncommitted as it was. Files that clash with main are kept with git's conflict markers (both sides) for the
 * implementer to resolve; the rest applies as it was. Returns the clashing files ([] when all applied), or
 * undefined when the commit could not be applied at all: the worktree is left clean.
 */
export async function restoreUnitWork(wt: string, sha: string): Promise<string[] | undefined> {
	try {
		await gitIn(wt, ["cherry-pick", "--no-commit", sha]);
		await gitIn(wt, ["reset", "-q"]);
		return [];
	} catch {
		let conflicts: string[] = [];
		try {
			conflicts = (await gitIn(wt, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
		} catch {
			/* no index to read: nothing was applied */
		}
		try {
			if (conflicts.length) {
				// a plain reset ends the cherry-pick but keeps its files: the clean ones applied, the clashing ones with both sides
				await gitIn(wt, ["reset", "-q"]);
				return conflicts;
			}
			await gitIn(wt, ["reset", "-q", "--hard"]);
		} catch {
			/* nothing was applied */
		}
		return undefined;
	}
}

/** Kept code put back on top of main only when it applies without a clash (a code job's start); else the worktree is left clean. */
export async function applyCleanly(wt: string, sha: string): Promise<boolean> {
	const clash = await restoreUnitWork(wt, sha);
	if (clash?.length === 0) return true;
	if (clash) {
		await gitIn(wt, ["checkout", "-q", "--", "."]).catch(() => undefined);
		await gitIn(wt, ["clean", "-fdq"]).catch(() => undefined);
	}
	return false;
}

/** Clashes only in wiring files resolved without an implement pass, per unit run (main can keep moving). */
export const MAX_WIRING_ROUNDS = 5;

/**
 * Wiring files (repo-relative) that clashed with main hold both sides: one short session keeps every entry of both
 * and removes the markers, changing nothing else. True when no marker is left.
 */
export async function resolveWiringClash(o: { config: Config; root: string; unitId: string; wt: string; files: string[]; spawn?: typeof spawnLeaf }): Promise<boolean> {
	mkdirSync(join(o.root, ".bigrefactor", "sessions"), { recursive: true });
	const session = await (o.spawn ?? spawnLeaf)({
		role: "implement",
		cwd: o.wt,
		config: o.config,
		writeGlobs: o.files,
		transcriptPath: join(o.root, ".bigrefactor", "sessions", `${o.unitId}.wiring.jsonl`),
		systemPrompt: `You resolve git merge conflicts in wiring files (route tables, the main module) where every migrated unit registers what it adds. Keep every entry of both sides (imports, routes, registrations), each once, and remove every conflict marker. Change nothing else and edit no other file. Never interactive prompts or servers; do not commit.`,
	});
	try {
		await session.run(`${conflictFilesNote(o.files)}\nPaths are relative to ${o.wt}.`);
	} finally {
		session.dispose();
	}
	return o.files.every((f) => existsSync(join(o.wt, f))) && !conflictMarkers(o.wt, o.files).length;
}

/** What the implementer is told about files that clashed with main when its code was put back on top of it. */
export function conflictFilesNote(files: string[]): string {
	return `These files clashed with the current main and hold git conflict markers: ${files.join(", ")}. Between "<<<<<<< HEAD" and "=======" is main's version (other units' work), between "=======" and ">>>>>>>" is yours. Keep both sides' changes and remove every marker; the other files already hold your code.`;
}

/**
 * Put quarantined or waiting units back into the queue: open attempts end, worktree and branch go, truth stays.
 * `keepCode` (a self-heal): the branch and the code kept on it at quarantine stay, the next run starts from them.
 * Crash counts and "wait" holds are cleared; an owner's requeue is a fresh start. `fresh`: the tester drafts the
 * interface and the tests again (its interface.md and kept tests go; the truth cases from the old code stay).
 * Returns what happened per id.
 */
export async function requeueUnits(ledger: Ledger, config: Config, root: string, ids: string[] | "all", by: string, o: { fresh?: boolean; human?: boolean; keepCode?: boolean } = {}): Promise<string[]> {
	const stuck = (st: string) => ["quarantined", "truth", "implementing", "gating", "review"].includes(st);
	const list = ids === "all" ? ledger.listUnits().filter((u) => stuck(u.state)).map((u) => u.id) : ids;
	const out: string[] = [];
	for (const id of list) {
		const u = ledger.getUnit(id);
		if (!u) {
			out.push(`${id}: unknown unit`);
			continue;
		}
		const dropDraft = async () => {
			for (const f of ["interface.md", "ported"]) await rm(join(root, ".bigrefactor", "truth", id, f), { recursive: true, force: true });
		};
		if (o.fresh && u.state === "planned") {
			// already waiting in the queue: only its draft goes
			await dropDraft();
			out.push(`${id}: requeued`);
			continue;
		}
		if (!stuck(u.state)) {
			out.push(`${id}: ${u.state}; only quarantined or waiting units can be requeued`);
			continue;
		}
		for (const a of ledger.db.prepare("SELECT id FROM attempts WHERE unit_id = ? AND ended_at IS NULL").all(id) as Array<{ id: number }>) ledger.endAttempt(a.id, { outcome: "aborted:requeue" });
		await removeWorktree(config.target.path, worktreeDir(root, id));
		if (!o.keepCode || o.fresh || o.human) {
			try {
				await deleteBranch(config.target.path, wsBranch(root, `unit/${id}`));
			} catch {
				/* no branch */
			}
			ledger.db.prepare("UPDATE units SET meta = json_remove(meta, '$.keptWork', '$.reviewFindings') WHERE id = ?").run(id);
		}
		ledger.db.prepare("UPDATE units SET meta = json_remove(meta, '$.crashes', '$.hold', '$.parked') WHERE id = ?").run(id);
		// only a person's requeue gives the unit new tries (setup model, self-heal) and lets a later quarantine be healed
		// or asked about again; automatic ones keep the caps
		if (o.human) ledger.db.prepare("UPDATE units SET meta = json_remove(meta, '$.setupParks', '$.healQuestion', '$.stuck', '$.healedFrom', '$.autoHeals', '$.healChecked', '$.retriedOn', '$.parkedWhy', '$.parkAsked', '$.jobTried', '$.ownLook') WHERE id = ?").run(id);
		// what it waited on no longer holds it: back in the queue it runs, and a late answer cannot act on it any more
		for (const q of ledger.db.prepare("SELECT id FROM questions WHERE unit_id = ? AND status = 'open' AND point NOT IN ('placement', 'area_taxonomy', 'area_overlap')").all(id) as Array<{ id: number }>) ledger.withdrawQuestion(q.id, `${id} was requeued by ${by}`);
		ledger.db.prepare("DELETE FROM question_waiters WHERE unit_id = ?").run(id);
		if (o.fresh) await dropDraft();
		ledger.transitionUnit(id, "planned", `requeued by ${by}${o.fresh ? " (interface and tests drafted again)" : ""}`);
		out.push(`${id}: requeued`);
	}
	return out;
}

/** The lesson a resubmitted unit carries into its next run (diagnosis + owner hint), read once. */
function takeRetryNote(ledger: Ledger, unitId: string): string | undefined {
	const meta = JSON.parse(ledger.getUnit(unitId)!.meta) as { retryNote?: string };
	if (!meta.retryNote) return undefined;
	ledger.db.prepare("UPDATE units SET meta = json_remove(meta, '$.retryNote') WHERE id = ?").run(unitId);
	return meta.retryNote;
}

/**
 * What an answer tells a waiting unit to do. Stop words quarantine it, "wait" holds it until a newer answer or
 * `br requeue`; "retry" (older ledgers: "fixed") runs it again; an answer that is none of the question's options is
 * a free-text hint for the next attempt, and so is the text after "retry: " or a hint carried with the option (HINT).
 */
export function applyParkedAnswer(answer: string | undefined, options: string[]): { action: "requeue" | "quarantine" | "hold"; hint?: string } {
	const full = (answer ?? "").trim();
	if (!full || /^auto:/.test(full)) return { action: "requeue" };
	const at = full.indexOf(HINT);
	const a = at < 0 ? full : full.slice(0, at).trim();
	const carried = at < 0 ? "" : full.slice(at + HINT.length).trim();
	const value = a.split(/\s+[—-]\s+|:\s/)[0]!.toLowerCase();
	if (["quarantine", "leave", "investigate"].includes(value)) return { action: "quarantine", hint: carried || undefined };
	if (value === "wait") return { action: "hold" };
	const isOption = options.some((o) => o.toLowerCase() === a.toLowerCase() || o.toLowerCase().startsWith(`${value} `) || o.toLowerCase() === value);
	const typed = isOption ? (a.toLowerCase().startsWith(`${value}: `) ? a.slice(value.length + 2).trim() : "") : a;
	const hint = [typed, carried].filter(Boolean).join("\n");
	return { action: "requeue", hint: hint || undefined };
}

export interface RunRecord {
	startedAt: string;
	endedAt: string;
	/** "ended": the run never reached its end (Pi closed, the process killed); written by the next run from the ledger */
	outcome: "finished" | "stopped" | "ended";
	stop?: { at: string; reason: string; finishing: string[]; lanes: Array<{ unit: string; state: string }> };
	accepted: number;
	quarantined: number;
	planned: number;
	openQuestions: number;
	costUsd: number;
	units: Array<{ unit: string; state: string }>;
}

/** Every run is written down: appended to .bigrefactor/runs.jsonl and kept as ledger meta `last_run`. */
export function writeRunRecord(ledger: Ledger, root: string, r: RunRecord): void {
	try {
		mkdirSync(join(root, ".bigrefactor"), { recursive: true });
		appendFileSync(join(root, ".bigrefactor", "runs.jsonl"), JSON.stringify(r) + "\n");
	} catch {
		/* the ledger copy below still records it */
	}
	ledger.setMeta("last_run", JSON.stringify(r));
}

/** Ledger meta of the run going on: its start and, once asked, its stop. Cleared when its record is written. */
const OPEN_RUN = "open_run";

/**
 * A run that started but wrote no record (Pi closed, the run process killed): its record from the ledger, with the
 * time of its last write as its end. Returns it, or undefined when the last run ended normally.
 */
export function recordLostRun(ledger: Ledger, root: string): RunRecord | undefined {
	const m = ledger.getMeta(OPEN_RUN);
	if (!m) return undefined;
	ledger.setMeta(OPEN_RUN, "");
	let open: { startedAt: string; stop?: { at: string; reason: string; finishing: string[] } };
	try {
		open = JSON.parse(m);
	} catch {
		return undefined;
	}
	const since = open.startedAt;
	const one = <T>(sql: string, ...a: string[]) => ledger.db.prepare(sql).get(...a) as T;
	const last = one<{ t: string | null }>("SELECT MAX(t) t FROM (SELECT MAX(created_at) t FROM transitions WHERE created_at >= ? UNION ALL SELECT MAX(COALESCE(ended_at, started_at)) FROM attempts WHERE started_at >= ?)", since, since).t;
	// by time (transitions_time, attempts_time), never by unit or entity ("+" keeps SQLite off those indexes): read by
	// unit, the whole attempts table (gate reports, 100+ MB) was read and held the run's start for seconds
	const into = (state: string) => one<{ n: number }>("SELECT COUNT(DISTINCT entity_id) n FROM transitions WHERE +entity = 'unit' AND to_state = ? AND created_at >= ?", state, since).n;
	const stateOf = (id: string) => ledger.getUnit(id)?.state ?? "?";
	const ran = (ledger.db.prepare("SELECT unit_id FROM attempts WHERE started_at >= ? AND +unit_id IS NOT NULL").all(since) as Array<{ unit_id: string }>).map((r) => r.unit_id);
	const units = [...new Set(ran)].sort().map((id) => ({ unit: id, state: stateOf(id) }));
	const r: RunRecord = {
		startedAt: since,
		endedAt: last ?? since,
		outcome: "ended",
		stop: open.stop ? { ...open.stop, lanes: open.stop.finishing.map((id) => ({ unit: id, state: stateOf(id) })) } : undefined,
		accepted: into("accepted"),
		quarantined: into("quarantined"),
		planned: ledger.listUnits({ state: "planned" }).length,
		openQuestions: ledger.openQuestions().length,
		costUsd: Number(one<{ c: number }>("SELECT COALESCE(SUM(cost_usd), 0) c FROM attempts WHERE started_at >= ?", since).c.toFixed(4)),
		units,
	};
	writeRunRecord(ledger, root, r);
	return r;
}

export function lastRun(ledger: Ledger): RunRecord | undefined {
	const m = ledger.getMeta("last_run");
	return m ? (JSON.parse(m) as RunRecord) : undefined;
}

export function renderLastRun(r: RunRecord): string {
	const when = r.endedAt.slice(0, 16).replace("T", " ");
	if (r.outcome === "ended") return `last run ended ${when} without finishing (Pi closed or the run process stopped)${r.stop ? `, after ${r.stop.reason}` : ""}: ${r.accepted} accepted, ${r.quarantined} quarantined, ${r.planned} still planned — /br run continues`;
	if (r.outcome === "stopped" && r.stop) return `last run stopped ${when} (${r.stop.reason}); finished lanes: ${r.stop.lanes.map((l) => `${l.unit} → ${l.state}`).join(", ") || "none"} · ${r.accepted} accepted · ${r.planned} still planned — /br run continues`;
	return `last run finished ${when}: ${r.accepted} accepted, ${r.quarantined} quarantined, ${r.planned} still planned`;
}
