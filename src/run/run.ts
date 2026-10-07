import { forecast, renderForecastLine } from "./forecast.ts";
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { loadCommandOverrides } from "../adapters/command-overrides.ts";
import { fixRunSetup, fixSetupWithModel, type SetupFixer } from "../init/setup-fixer.ts";
import { diagnoseFailure } from "./doctor.ts";
import pc from "picocolors";
import { loadConfig, type Config } from "../config.ts";
import { addWorktree, headOf, removeWorktree } from "../git.ts";
import { projectDir } from "../init/init.ts";
import { getTargetAdapter } from "../adapters/registry.ts";
import { resolveChoices } from "../init/stack.ts";
import { indexTarget } from "../inventory/target.ts";
import { applySlicePlan, planSlices, renderSlicePlan, type SliceOverrides } from "../inventory/slices.ts";
import type { Ledger } from "../ledger/db.ts";
import type { ModelClient } from "../models/types.ts";
import { Semaphore } from "./pool.ts";
import { decide } from "../jev/decide.ts";
import { SYSTEMIC_FAILURE, JEV_ACT } from "../jev/questions.ts";
import { applyPlacementAnswers, placeUnit, resolvePlacements, unplacedReason } from "./placement.ts";
import { syncTaxonomyAnswers } from "./taxonomy.ts";
import { maybeCurateRules } from "../rules/living.ts";
import { answerValue, askViaModel } from "../jev/ask.ts";
import { checkLayout, renderTrees, sampleFacts, scanTree } from "./layout-check.ts";
import { maybeTidyReview } from "./tidy.ts";
import { afterAccept, envFingerprint, runUnit, type UnitRunOptions, type UnitRunResult } from "./unit.ts";

/**
 * The scheduler: many agent sessions, few gate workers, one merge at a time.
 *
 *  ready(unit)  = planned ∧ not stale ∧ not waiting on a question ∧ every dep accepted (merged)
 *  priority     = (sliceRank asc, depth desc, id)  — slices order the work, the DAG keeps it correct
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
	/** Fill idle lanes with truth-ahead work (tester only) for units still waiting on deps. Default: on unless a limit is set. */
	truthAhead?: boolean;
	/** Host-driven drain (Pi's /br stop): when true, running units finish and no new ones start. */
	shouldStop?: () => boolean;
	/** Install the ctrl-c drain handler (CLI). A host with its own ctrl-c (Pi) passes false. Default true. */
	handleSigint?: boolean;
	/**
	 * Units blocked by open decisions (unit id → decision ids), re-read every scheduling loop so an answer
	 * releases its units mid-run. See src/run/decisions-gate.ts.
	 */
	blocked?: () => Map<string, string[]>;
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
}

export interface SchedulerResult {
	ran: UnitRunResult[];
	accepted: number;
	quarantined: number;
	waiting: number;
	costUsd: number;
}

export async function runScheduler(o: SchedulerOptions): Promise<SchedulerResult> {
	process.env["BR_WORKSPACE"] = o.root; // the stacks' layout.json lives in this workspace
	const log = o.log ?? ((l: string) => console.log(l));
	const { ledger, config } = o;

	{
		const prev = lastRun(ledger);
		if (prev?.outcome === "stopped" && !o.dry) log(pc.dim(renderLastRun(prev)));
	}

	// ---- the project must match the stack choices (a mismatch fails every unit's gate the same way)
	if (!o.dry) {
		for (const id of config.target.stacks) {
			const adapter = await getTargetAdapter(id);
			const chosen = resolveChoices(adapter, config.target.choices).map((c) => ({ key: c.choice.key, id: c.option.id, packages: c.option.packages }));
			const problems = adapter.verifyChoices?.(projectDir(config, id), chosen) ?? [];
			const fatal = problems.filter((p) => p.everyUnit);
			if (fatal.length) throw new Error(`bigrefactor: the ${id} project does not match the stack choices — every unit would fail the same way:\n  ${fatal.map((p) => p.text).join("\n  ")}\nfix: change the choice (br decide) or install what is missing, then run again`);
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
	const open = ledger.db.prepare("SELECT id, unit_id FROM attempts WHERE ended_at IS NULL").all() as Array<{ id: number; unit_id: string }>;
	for (const a of open) {
		ledger.endAttempt(a.id, { outcome: "aborted:crash" });
		const u = ledger.getUnit(a.unit_id);
		if (u && ["truth", "implementing", "gating"].includes(u.state)) {
			ledger.db.prepare("UPDATE units SET state = 'planned', updated_at = datetime('now') WHERE id = ?").run(a.unit_id);
			ledger.db.prepare("INSERT INTO transitions(entity, entity_id, from_state, to_state, reason, created_at) VALUES ('unit', ?, ?, 'planned', 'crash recovery: attempt left open', datetime('now'))").run(a.unit_id, u.state);
			removeWorktree(config.target.path, worktreeDir(o.root, a.unit_id));
		}
	}
	if (open.length) log(pc.yellow(`recovered ${open.length} attempt(s) left open by a previous run`));
	// ---- placement: every planned unit gets its stack + area before anything runs (code → Jev → question)
	if (!o.dry) await resolvePlacements({ ledger, config, root: o.root, client: o.client, log: (l) => log(pc.dim(l)) });
	// ---- layout preflight: one folder per legacy file must be caught before a run scales it
	if (!o.dry && !o.spawn) {
		const lr = await checkLayout(config, o.root, ledger);
		for (const w of lr.warnings) log(pc.yellow(`layout: ${w}`));
		if (lr.problems.length && !o.force) throw new Error(`bigrefactor: the target layout has ${lr.problems.length} problem(s), a run would multiply them:\n  ${lr.problems.join("\n  ")}\nfix: br layout shows the details; start anyway with --force`);
		for (const p of lr.problems) log(pc.red(`layout (--force): ${p}`));
	}
	// Parked units (state kept, attempt closed, waiting on a question) are resubmitted as soon as the cause is
	// gone: their question was answered, or — for environment failures — the target project or the stack
	// config changed since they parked. Checked at start and on every scheduling loop.
	const resubmitParked = () => resubmitParkedUnits(ledger, config, o.root, new Set(running.keys()), log, adapters);

	// Each unit lands in the stack placement picks; a worktree holds the whole target repo, so every stack's
	// dependency dirs (adapter-declared) are linked into it.
	const adapters = new Map(await Promise.all(config.target.stacks.map(async (id) => [id, await getTargetAdapter(id)] as const)));
	const linkAll = (wt: string) => {
		for (const [id, a] of adapters) linkDependencies(projectDir(config, id), join(wt, relative(config.target.path, projectDir(config, id))), a.toolchain.worktreeLinks, loadCommandOverrides(o.root, id).worktreeCopy ?? []);
	};
	const placementOf = (meta: string) => placeUnit(config, meta, o.root);
	excludeFromGit(config.target.path, [...new Set([...adapters.values()].flatMap((a) => a.toolchain.ignoredPaths))]);
	const agents = new Semaphore(config.run.agentConcurrency);
	const gates = new Semaphore(config.run.gateConcurrency);
	// Lanes are live: `br lanes <n>` / `/br lanes <n>` edits run.agentConcurrency (and gateConcurrency) in the
	// config; the loop picks it up within seconds. Shrinking never kills a lane — running units finish first.
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
			if (run.agentConcurrency !== laneLimit || run.gateConcurrency !== gates.limit) {
				log(pc.cyan(`lanes ${laneLimit} → ${run.agentConcurrency}, gate slots ${gates.limit} → ${run.gateConcurrency}${run.agentConcurrency < running.size ? ` (${running.size} running finish first)` : ""}`));
				laneLimit = run.agentConcurrency;
				agents.setLimit(laneLimit);
				gates.setLimit(run.gateConcurrency);
			}
		} catch {
			/* unreadable mid-write: next tick */
		}
	};
	reloadLanes();
	const merge = new Semaphore(1);
	const curate = new Semaphore(1);
	const ran: UnitRunResult[] = [];
	const running = new Map<string, Promise<void>>();
	let acceptedNow = 0;
	let cost = 0;
	let stop = false;
	const startedAt = new Date().toISOString();
	// A stop drains: running lanes finish their unit, nothing new starts. It is written down (run log + ledger)
	// so the next run and `br status` can say what happened.
	let stopRecord: { at: string; reason: string; finishing: string[] } | undefined;
	const requestStop = (reason: string) => {
		if (stopRecord) return;
		stop = true;
		stopRecord = { at: new Date().toISOString(), reason, finishing: [...running.keys()] };
		log(pc.yellow(`■ stop requested (${reason}): ${stopRecord.finishing.length} running lane(s) finish${stopRecord.finishing.length ? ` (${stopRecord.finishing.join(", ")})` : ""}; no new units start`));
	};
	const onSigint = () => {
		requestStop("ctrl-c");
		log(pc.dim("ctrl-c again to abort"));
		process.once("SIGINT", () => process.exit(130));
	};
	if (o.handleSigint !== false) process.once("SIGINT", onSigint);

	let decisionBlocked = new Map<string, string[]>();
	let waitingNote = "";
	const ready = (): string[] => {
		applyPlacementAnswers(ledger, config, o.root); // an answered placement question places its unit before it can start
		syncTaxonomyAnswers({ ledger, root: o.root }); // answered area questions: new area, or the owner excluded the unit
		const blocked = ledger.blockedUnits();
		decisionBlocked = o.blocked?.() ?? new Map();
		for (const u of decisionBlocked.keys()) if (!blocked.has(u)) blocked.set(u, []);
		// one unit per target module at a time: units sharing a write scope would conflict on merge
		const busyModules = new Set([...running.keys()].map((id) => placementOf(ledger.getUnit(id)!.meta).moduleKey));
		// One query: planned units whose every dep is accepted (json_each over the deps array), not stale.
		const rows = ledger.db
			.prepare(
				`SELECT u.id, u.meta FROM units u
				 WHERE u.state = 'planned'
				   AND COALESCE(json_extract(u.meta, '$.stale'), 0) = 0
				   AND NOT EXISTS (SELECT 1 FROM json_each(u.deps) d LEFT JOIN units du ON du.id = d.value WHERE du.state IS NULL OR du.state != 'accepted')`,
			)
			.all() as Array<{ id: string; meta: string }>;
		const units = rows.filter((u) => {
			if (running.has(u.id) || blocked.has(u.id)) return false;
			// waits for Jev or its placement question, never runs on a guess (a dry run previews before placement ran)
			if (!o.dry && unplacedReason(config, u.meta, o.root)) return false;
			if (busyModules.has(placementOf(u.meta).moduleKey)) return false;
			if (o.units && !o.units.includes(u.id)) return false;
			if (o.slice && JSON.parse(u.meta).slice !== o.slice) return false;
			return true;
		});
		return units
			.map((u) => ({ id: u.id, m: JSON.parse(u.meta) as { sliceRank?: number; depth?: number } }))
			.sort((a, b) => (a.m.sliceRank ?? 99) - (b.m.sliceRank ?? 99) || (b.m.depth ?? 0) - (a.m.depth ?? 0) || a.id.localeCompare(b.id))
			.map((u) => u.id);
	};

	if (o.dry) {
		const order = ready();
		log(`\nready now (${order.length}): ${order.join(", ") || "-"}`);
		return { ran: [], accepted: 0, quarantined: 0, waiting: order.length, costUsd: 0 };
	}

	const aheadRunning = new Set<string>();
	/** Truth-ahead attempts that ended without truth in this run: never retried in a tight loop. */
	const aheadDone = new Set<string>();
	/** Tester-only lane for a unit whose deps are not accepted yet (see UnitRunOptions.truthOnly). */
	const startAhead = (unitId: string) => {
		aheadRunning.add(unitId);
		const p = agents.run(async () => {
			const wt = worktreeDir(o.root, unitId) + "-ahead";
			const branch = `ahead/${unitId}`;
			const drop = () => {
				removeWorktree(config.target.path, wt);
				try {
					execFileSync("git", ["-C", config.target.path, "branch", "-q", "-D", branch], { stdio: "pipe" });
				} catch {
					/* no branch */
				}
			};
			drop();
			addWorktree(config.target.path, wt, branch);
			linkAll(wt);
			log(pc.cyan(`◇ ${unitId}`) + pc.dim("  truth ahead (deps still migrating)"));
			try {
				const res = await runUnit({ ledger, config, root: o.root, unitId, client: o.client, accept: false, workDir: wt, truthOnly: true, gateSlot: (fn) => gates.run(fn), log: (l) => log(`  ${l}`), spawn: o.spawn, gate: o.gate });
				cost += res.costUsd;
				log(ledger.hasEvidence(unitId, "truth_ahead") ? pc.cyan(`◆ ${unitId}: truth ready`) : pc.yellow(`⏸ ${unitId}: truth ahead failed (waiting on a question)`));
			} catch (e: any) {
				log(pc.yellow(`◇ ${unitId}: truth ahead skipped (${String(e?.message ?? e).split("\n")[0]})`));
			} finally {
				drop();
			}
		});
		running.set(unitId, p.finally(() => (running.delete(unitId), aheadRunning.delete(unitId), aheadDone.add(unitId))));
	};
	/** Planned units waiting only on deps (not on questions), without truth yet: closest to ready first. */
	const aheadCandidates = (): string[] => {
		const blocked = ledger.blockedUnits();
		const rows = ledger.db
			.prepare(
				`SELECT u.id, u.meta,
				   (SELECT COUNT(*) FROM json_each(u.deps) d LEFT JOIN units du ON du.id = d.value WHERE du.state IS NULL OR du.state != 'accepted') AS open
				 FROM units u
				 WHERE u.state = 'planned' AND COALESCE(json_extract(u.meta, '$.stale'), 0) = 0
				   AND substr(COALESCE(u.kind, ''), 1, 3) != 'db_' -- the DB lane has no tester truth to capture ahead
				   AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.unit_id = u.id AND e.type IN ('truth_ahead', 'truth_green_on_old'))`,
			)
			.all() as Array<{ id: string; meta: string; open: number }>;
		return rows
			// a unit still waiting for its placement (an area question) cannot start, not even its tester
			.filter((u) => u.open > 0 && !running.has(u.id) && !aheadDone.has(u.id) && !blocked.has(u.id) && !decisionBlocked.has(u.id) && !unplacedReason(config, u.meta, o.root))
			.filter((u) => (!o.units || o.units.includes(u.id)) && (!o.slice || JSON.parse(u.meta).slice === o.slice))
			.map((u) => ({ id: u.id, open: u.open, rank: (JSON.parse(u.meta) as { sliceRank?: number }).sliceRank ?? 99 }))
			.sort((a, b) => a.open - b.open || a.rank - b.rank || a.id.localeCompare(b.id))
			.map((u) => u.id);
	};

	const startUnit = (unitId: string) => {
		const p = agents.run(async () => {
			const wt = worktreeDir(o.root, unitId);
			const branch = `unit/${unitId}`;
			const fresh = () => {
				removeWorktree(config.target.path, wt);
				try {
					execFileSync("git", ["-C", config.target.path, "branch", "-q", "-D", branch], { stdio: "pipe" });
				} catch {
					/* no branch */
				}
				addWorktree(config.target.path, wt, branch);
				linkAll(wt);
				ledger.updateUnit(unitId, { worktree: wt, branch });
			};
			fresh();
			log(pc.bold(`▶ ${unitId}`) + pc.dim(`  [${JSON.parse(ledger.getUnit(unitId)!.meta).slice ?? "?"}]`));
			let res: UnitRunResult | undefined;
			let conflictNote: string | undefined;
			let crash: string | undefined;
			try {
				// Playbook: run → (merge conflict → fresh worktree on current main, one more implement pass with the conflict as the gate output) ×2 → accept or quarantine.
				for (let round = 1; round <= 3; round++) {
					res = await runUnit({
						ledger,
						config,
						root: o.root,
						unitId,
						client: o.client,
						accept: false,
						workDir: wt,
						reuseTruth: round > 1,
						retryNote: conflictNote,
						gateSlot: (fn) => gates.run(fn),
						log: (l) => log(`  ${l}`),
						spawn: o.spawn,
						gate: o.gate,
					});
					cost += res.costUsd;
					if (res.state !== "review") break;
					try {
						await merge.run(async () => {
							const { stackId } = placementOf(ledger.getUnit(unitId)!.meta);
							const adapter = adapters.get(stackId)!;
							const mainProject = projectDir(config, stackId);
							const sha = mergeUnit(config, unitId, wt, branch, mainProject);
							ledger.transitionUnit(unitId, "accepted", sha ? `merged ${sha.slice(0, 7)} into ${config.target.git.branch}` : "merged (no changes)");
							if (sha) ledger.updateUnit(unitId, { meta: { ...JSON.parse(ledger.getUnit(unitId)!.meta), commit: sha } });
							await indexTarget(ledger, adapter, mainProject, res!.gate?.changedFiles).catch(() => 0);
							afterAccept(ledger, adapter, mainProject, stackId, placementOf(ledger.getUnit(unitId)!.meta).area, (l) => log(`  ${l}`));
							// Registration/wiring files are generated by the adapter from what landed, never by agents.
							if (adapter.generateRegistration) {
								const changed = await adapter.generateRegistration(mainProject, { ledger }).catch((e) => (log(pc.yellow(`  registration generation failed: ${e?.message ?? e}`)), [] as string[]));
								if (changed.length) {
									gitIn(config.target.path, ["add", "-A", "--", ...changed.map((c) => relative(config.target.path, join(mainProject, c)))]);
									gitIn(config.target.path, ["-c", "user.name=bigrefactor", "-c", "user.email=bigrefactor@localhost", "commit", "-q", "-m", `chore: regenerate registration after ${unitId}\n\n${changed.join("\n")}`]);
									log(pc.dim(`  regenerated ${changed.join(", ")}`));
								}
							}
						});
						acceptedNow++;
						log(pc.green(`✓ ${unitId} accepted ($${res.costUsd.toFixed(4)})`));
						// living rules: proposals from units are curated into a new rules version once enough piled up
						await curate.run(() => maybeCurateRules({ ledger, config, root: o.root, client: o.client })).then((r) => Object.entries(r.versions).forEach(([s, v]) => log(pc.cyan(`  rules ${s} → v${v}`))), (e) => log(pc.yellow(`  rules curation failed: ${e?.message ?? e}`)));
						// tidy review: every N accepts of an area a model reads its module; approved changes become tidy tasks
						const { stackId: tStack, area: tArea } = placementOf(ledger.getUnit(unitId)!.meta);
						await curate.run(() => maybeTidyReview({ ledger, config, root: o.root, client: o.client }, { stackId: tStack, area: tArea })).then((r) => r.reviewed && log(pc.cyan(`  tidy review ${tStack}:${tArea}: ${r.asked} change(s) asked, ${r.proposals} convention(s) proposed`)), (e) => log(pc.yellow(`  tidy review failed: ${e?.message ?? e}`)));
						break;
					} catch (e: any) {
						if (!/merge conflict/.test(String(e?.message)) || round === 3) {
							ledger.transitionUnit(unitId, "quarantined", `could not merge: ${String(e?.message).slice(0, 300)}`);
							log(pc.red(`■ ${unitId}: quarantined (${String(e?.message).split("\n")[0]})`));
							break;
						}
						conflictNote = `Your previous pass could not be merged: ${String(e?.message).split("\n")[0]}. The main branch has moved (another unit of the same module landed). The worktree now starts from the current main; re-apply the migration of this unit on top of the existing code (extend files, do not overwrite other units' work).`;
						log(pc.yellow(`  merge conflict → fresh worktree, implement pass ${round + 1}`));
						ledger.transitionUnit(unitId, "implementing", "merge conflict: re-implementing on current main");
						fresh();
					}
				}
				if (res && res.state !== "review" && ledger.getUnit(unitId)!.state !== "accepted") {
					const st = ledger.getUnit(unitId)!.state;
					const q = ledger.openQuestions().find((x) => x.unit_id === unitId);
					log(st === "quarantined" ? pc.red(`■ ${unitId}: quarantined`) : pc.yellow(`⏸ ${unitId}: waiting${q ? ` on question #${q.id}` : ""} (${st})`));
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
				if (crashes >= 2 && st !== "accepted" && st !== "quarantined") ledger.transitionUnit(unitId, "quarantined", `crashed ${crashes} times: ${msg.slice(0, 300)}`);
				crash = msg;
			} finally {
				const st = ledger.getUnit(unitId)!.state;
				if (st === "accepted" || st === "quarantined") {
					removeWorktree(config.target.path, wt);
					try {
						execFileSync("git", ["-C", config.target.path, "branch", "-q", "-D", branch], { stdio: "pipe" });
					} catch {
						/* branch already gone */
					}
				}
				ran.push({ unitId, state: st, attempts: res?.attempts ?? 0, gate: res?.gate, triage: res?.triage, costUsd: res?.costUsd ?? 0 });
				await circuit(unitId, st, res, crash);
			}
		});
		running.set(unitId, p.finally(() => running.delete(unitId)));
	};

	// ---- circuit breaker: when recent units fail the same way (or Jev judges the failures systemic), the run heals
	// instead of stopping: new units wait, the shared cause is diagnosed, the setup model fixes the project (what it
	// learns — a command, a worktree copy — is kept for every later unit), the failed units go back into the queue
	// and the run goes on. Cannot be healed → those units stay quarantined, the run still goes on.
	const recent: Array<{ unit: string; ok: boolean; cause?: string; gate?: string; sig?: string; step?: string; output?: string }> = [];
	const setupFixer = o.setupFixer === false ? undefined : (o.setupFixer ?? (o.spawn ? undefined : fixSetupWithModel));
	const tried = new Set<string>();
	let healing: Promise<void> | undefined;
	const heal = async (what: string, failed: typeof recent) => {
		const units = failed.map((f) => f.unit);
		log(pc.cyan(`⚕ ${what} (${units.join(", ")}): fixing the shared cause; new units wait, running ones go on`));
		const first = failed.find((f) => f.output) ?? failed[0]!;
		const stackId = placeUnit(config, ledger.getUnit(first.unit)?.meta ?? "{}", o.root).stackId;
		const adapter = adapters.get(stackId);
		let fixed: string | undefined;
		if (adapter && setupFixer) {
			const dir = projectDir(config, stackId);
			const dx = await diagnoseFailure({ config, adapter, projectDir: dir, failedStep: first.step ?? "", output: first.output ?? "", client: o.client }).catch(() => undefined);
			if (dx) log(pc.dim(`  diagnosis (${dx.by}): ${dx.action} — ${dx.summary}`));
			if (!dx || dx.action === "fix" || dx.action === "unknown")
				fixed = await fixRunSetup({ config, root: o.root, adapter, projectDir: dir, fixer: setupFixer, problem: `${units.length} units failed the same way (${what}).${dx ? ` Diagnosis: ${dx.summary}${dx.command ? ` (suggested: ${dx.command})` : ""}.` : ""}\nEach unit works in its own git worktree of the target repo (${join(o.root, ".bigrefactor", "worktrees", "<unit>")}); these dependency dirs are linked into it from the main project: ${adapter.toolchain.worktreeLinks.join(", ") || "none"}. Tools that resolve real paths (autoloaders, module resolution) then see the main project's code, not the worktree's: set_worktree_copy gives every later worktree a copy instead.\nGate output of ${first.unit}:\n${(first.output ?? first.gate ?? "").slice(-3000)}` }).catch((e) => (log(pc.yellow(`  setup fix failed: ${e?.message ?? e}`)), undefined));
		}
		recent.length = 0;
		if (fixed) {
			const back = requeueUnits(ledger, config, o.root, units.filter((u) => ["quarantined", "truth", "implementing", "gating"].includes(ledger.getUnit(u)?.state ?? "") && !running.has(u)), "self-heal");
			log(pc.green(`⚕ healed: ${fixed} — ${back.filter((l) => l.endsWith("requeued")).length} unit(s) back in the queue`));
		} else log(pc.yellow(`⚕ could not heal it here; those units stay quarantined (br requeue after a fix), the run goes on`));
	};
	const circuit = async (unitId: string, st: string, res: UnitRunResult | undefined, crash?: string) => {
		const bad = crash ? { name: "exception", output: crash } : res?.gate?.steps.find((x) => !x.ok);
		const gate = bad ? `${bad.name}: ${String(bad.output ?? "").slice(0, 600)}` : undefined;
		recent.push({ unit: unitId, ok: !crash && (st === "accepted" || st === "review"), cause: crash ? "exception" : res?.triage?.cause, gate, sig: bad ? errorSignature(bad.name, String(bad.output ?? "")) : undefined, step: bad?.name, output: bad ? String(bad.output ?? "") : undefined });
		if (recent.length > 6) recent.shift();
		if (healing) return;
		const failed = recent.filter((r) => !r.ok);
		// certain case first: the same error in 3 units is one cause, whatever a model says
		const bySig = new Map<string, typeof recent>();
		for (const f of failed) if (f.sig) bySig.set(f.sig, [...(bySig.get(f.sig) ?? []), f]);
		const same = [...bySig.entries()].find(([sig, fs]) => fs.length >= 3 && !tried.has(sig));
		if (same) {
			tried.add(same[0]);
			healing = heal(`${same[1].length} units failed with the same error`, same[1]).finally(() => (healing = undefined));
			return;
		}
		if (!o.client || tried.has("systemic") || failed.length < 3 || failed.length < recent.length / 2) return;
		try {
			const r = await decide({ client: o.client, ledger, model: config.models.decide.id, second: config.models.escalate.id }, "systemic_failure", { recent_failures: failed.map((f) => ({ unit: f.unit, cause: f.cause, gate: f.gate })) }, SYSTEMIC_FAILURE, ["systemic"]);
			const sys = r.answers["systemic"];
			const kind = r.answers["kind"]?.type === "choice" ? (r.answers["kind"] as { choice: string }).choice : "other";
			if (sys?.type === "noul" && sys.noul >= 0.5 && r.confidence >= JEV_ACT && kind !== "hard_batch") {
				tried.add("systemic");
				healing = heal(`failures look systemic (${kind}, ${Math.round(sys.noul * 100)}%)`, failed).finally(() => (healing = undefined));
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
	/** Before the sample is approved, at most sampleSize units land: lanes never start more than that. */
	const sampleRoom = () => !sampleSize || !!sampleState().approved || acceptedTotal() + running.size - aheadRunning.size < sampleSize;
	/** undefined = go on; otherwise why nothing new starts. Files the review question once the sample has landed. */
	const samplePause = async (): Promise<string | undefined> => {
		if (!sampleSize) return undefined;
		let st = sampleState();
		if (st.approved) {
			if (acceptedTotal() >= sampleSize) return undefined;
			ledger.setMeta("layout_sample", JSON.stringify((st = {}))); // the target was reset since: review the new sample
		}
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
		const sampleRunning = running.size - aheadRunning.size;
		const acc = acceptedTotal();
		if (acc + sampleRunning < sampleSize) return undefined;
		if (!st.question && sampleRunning === 0 && acc >= sampleSize) {
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
			].join("\n");
			const q = await askViaModel({ ledger, config, root: o.root, client: o.client }, { point: "layout_sample", facts, options: [{ value: "approve", facts: "the structure is right: continue the run" }, { value: "stop", facts: "the structure is wrong: keep the run stopped, fix placement/rules, reset the sample" }], recommended: lr?.problems.length || sf.drift ? "stop" : "approve", blocks: "none", askedBy: "orchestrator", context: { sample: acc } });
			ledger.setMeta("layout_sample", JSON.stringify({ question: q.id }));
			log(pc.yellow(`layout sample: ${acc} units landed — review the target tree and answer question #${q.id} (br questions); nothing new starts until then`));
			for (const l of renderTrees(trees, 15)) log(pc.dim(`  ${l}`));
		}
		const qid = sampleState().question;
		return qid ? `layout review: answer question #${qid} to continue` : `layout sample: ${sampleSize} units, waiting for the running ones to land`;
	};

	const spentToday = () => (ledger.db.prepare("SELECT COALESCE(SUM(cost_usd),0) c FROM attempts WHERE started_at >= date('now')").get() as { c: number }).c + (ledger.db.prepare("SELECT COALESCE(SUM(cost_usd),0) c FROM decisions WHERE created_at >= date('now')").get() as { c: number }).c;
	let dayCapHit = false;

	// ---- main loop
	resubmitParked();
	let lastResubmitCheck = Date.now();
	let lastPlaceCheck = Date.now();
	for (;;) {
		reloadLanes();
		if (Date.now() - lastResubmitCheck > 5000) {
			resubmitParked();
			lastResubmitCheck = Date.now();
		}
		// units Jev could not place (call failed, question could not be filed) get another pass
		if (Date.now() - lastPlaceCheck > 60_000) {
			lastPlaceCheck = Date.now();
			await resolvePlacements({ ledger, config, root: o.root, client: o.client, log: (l) => log(pc.dim(l)) }).catch((e) => log(pc.yellow(`placement failed: ${e?.message ?? e}`)));
		}
		if (!dayCapHit && spentToday() >= config.run.budgetUsdPerDay) {
			dayCapHit = true;
			await askViaModel({ ledger, config, root: o.root, client: o.client }, { point: "budget", facts: `Paid model spend today (OpenRouter fallback; the Codex subscription is not counted): $${spentToday().toFixed(2)}; the daily cap run.budgetUsdPerDay is $${config.run.budgetUsdPerDay}. Running units finish; no new ones start today. ${ledger.listUnits({ state: "planned" }).length} units are still planned.`, options: [{ value: "raise", facts: "raise run.budgetUsdPerDay in bigrefactor.config.json and br run again" }, { value: "tomorrow", facts: "leave the cap; br run again tomorrow" }], recommended: "tomorrow", blocks: "none", askedBy: "orchestrator" }).catch((e) => log(pc.yellow(`budget question failed: ${e?.message ?? e}`)));
			log(pc.red(`daily budget cap reached ($${spentToday().toFixed(2)}); not starting new units`));
		}
		if (!stopRecord && o.shouldStop?.()) requestStop("/br stop");
		// A pilot of N migrates N units: in-flight units count toward the limit (otherwise up to N+lanes-1 land).
		const underLimit = () => o.limit === undefined || acceptedNow + running.size < o.limit;
		const sampleReason = stop ? undefined : healing ? "fixing a shared failure (setup model); new units wait" : await samplePause();
		let readyNow = 0;
		if (!stop && !dayCapHit && !sampleReason && underLimit()) {
			const candidates = ready();
			readyNow = candidates.length;
			for (const id of candidates) {
				if (running.size >= laneLimit || !underLimit() || !sampleRoom()) break;
				startUnit(id);
				readyNow--;
			}
		}
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
				? "stopping: running lanes finish, nothing new starts"
				: dayCapHit
					? "daily budget cap reached"
					: sampleReason
						? sampleReason
						: o.limit !== undefined && !underLimit()
						? `pilot limit ${o.limit}: ${acceptedNow} accepted + ${running.size} finishing, nothing new starts`
						: running.size >= max
							? undefined
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
				await healing;
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
			break;
		}
		// wake at least every 2 s: lane changes, resubmits and stops apply without waiting for a unit to end
		await Promise.race([...running.values(), new Promise((r) => setTimeout(r, 2000))]);
		// a lane that ends at once (nothing to do) must not starve the event loop: the UI redraws, /br stop is heard
		await new Promise((r) => setImmediate(r));
	}
	process.off("SIGINT", onSigint);

	const quarantined = ran.filter((r) => r.state === "quarantined").length;
	const waiting = ledger.listUnits({ state: "planned" }).length;
	// a truth-ahead lane leaves its unit planned by design: say what it produced instead
	const truthAhead = (id: string) => (ledger.db.prepare("SELECT 1 FROM evidence WHERE unit_id = ? AND type = 'truth_ahead' LIMIT 1").get(id) ? "planned, truth ready ahead" : undefined);
	const lanes = stopRecord ? stopRecord.finishing.map((id) => { const st = ledger.getUnit(id)?.state ?? "?"; return { unit: id, state: (st === "planned" && truthAhead(id)) || st }; }) : [];
	if (stopRecord) log(pc.yellow(`stopped (${stopRecord.reason}); lanes that finished: ${lanes.map((l) => `${l.unit} → ${l.state}`).join(", ") || "none were running"}`));
	log(`\nrun ${stopRecord ? "stopped" : "finished"}: ${acceptedNow} accepted, ${quarantined} quarantined, ${waiting} still planned${ledger.ownDecisions(startedAt).length ? `, ${ledger.ownDecisions(startedAt).length} routine question(s) decided from your goals` : ""}${ledger.openQuestions().length ? `, ${ledger.openQuestions().length} question(s) open → br questions` : ""}, $${cost.toFixed(3)}`);
	if (!o.dry) log(pc.dim(renderForecastLine(forecast(ledger))));
	if (!o.dry) writeRunRecord(ledger, o.root, { startedAt, endedAt: new Date().toISOString(), outcome: stopRecord ? "stopped" : "finished", stop: stopRecord ? { ...stopRecord, lanes } : undefined, accepted: acceptedNow, quarantined, planned: waiting, openQuestions: ledger.openQuestions().length, costUsd: Number(cost.toFixed(4)), units: ran.map((r) => ({ unit: r.unitId, state: r.state })) });
	return { ran, accepted: acceptedNow, quarantined, waiting, costUsd: cost };
}

/** Bring the unit branch up to date with the main branch and fast-forward it in. */
function mergeUnit(config: Config, unitId: string, wt: string, branch: string, _mainProject: string): string | undefined {
	const main = config.target.git.branch;
	const before = headOf(config.target.path);
	gitIn(wt, ["add", "-A"]); // the stacks' generated paths are excluded repo-wide via info/exclude (see excludeFromGit)
	const staged = execFileSync("git", ["-C", wt, "diff", "--cached", "--name-only"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	if (staged) execFileSync("git", ["-C", wt, "-c", "user.name=bigrefactor", "-c", "user.email=bigrefactor@localhost", "commit", "-q", "-m", `feat: migrate ${unitId}\n\nbigrefactor: unit ${unitId}`], { stdio: "pipe" });
	try {
		execFileSync("git", ["-C", wt, "-c", "user.name=bigrefactor", "-c", "user.email=bigrefactor@localhost", "rebase", "-q", main], { stdio: "pipe" });
	} catch (e: any) {
		execFileSync("git", ["-C", wt, "rebase", "--abort"], { stdio: "pipe" });
		throw new Error(`merge conflict rebasing ${branch} onto ${main}: ${String(e?.stderr ?? e?.message).slice(0, 400)}`);
	}
	execFileSync("git", ["-C", config.target.path, "merge", "-q", "--ff-only", branch], { stdio: "pipe" });
	const after = headOf(config.target.path);
	return after !== before ? after : undefined;
}

function gitIn(dir: string, args: string[]): string {
	try {
		return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	} catch (e: any) {
		throw new Error(`git ${args.join(" ")} failed in ${dir}: ${String(e?.stderr ?? e?.message).trim().slice(0, 500)}`);
	}
}

export function worktreeDir(root: string, unitId: string): string {
	return join(root, ".bigrefactor", "worktrees", unitId);
}

/** Repo-level excludes shared by all worktrees. A generator's `.gitignore` line `dir/` does not match our symlinked dir. */
export function excludeFromGit(repo: string, patterns: string[]): void {
	try {
		const gitDir = execFileSync("git", ["-C", repo, "rev-parse", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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
export function linkDependencies(mainProject: string, wtProject: string, dirs: string[], copy: string[] = []): void {
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
			// APFS clone (macOS) / reflink (Linux): instant, no extra space; symlinks inside are kept as they are
			execFileSync("cp", process.platform === "darwin" ? ["-cR", src, dst] : ["-R", "--reflink=auto", src, dst], { stdio: ["ignore", "pipe", "pipe"] });
		} catch {
			cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
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

/** Same error, different unit → same signature: step + first error line with paths, positions and names in quotes kept, file names dropped. */
export function errorSignature(step: string, output: string): string {
	const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
	const line = clean.split(/\r?\n/).find((l) => /error|failed|cannot|not found/i.test(l)) ?? clean.split(/\r?\n/).find((l) => l.trim()) ?? "";
	return `${step}: ${line.replace(/[\w./\\-]*[\w-]\.[a-z][a-z0-9]{0,5}(?::\d+)+|[\w.-]*[/\\][\w./\\-]+\.[a-z][a-z0-9]{0,5}\b/gi, "<file>").replace(/\b\d+\b/g, "N").replace(/\s+/g, " ").trim().slice(0, 160)}`;
}

/**
 * Parked units (state kept, attempt closed, waiting on a question) go back to planned as soon as the cause is
 * gone: their question was answered, or (environment failures) the target project or stack config changed.
 */
export function resubmitParkedUnits(ledger: Ledger, config: Config, root: string, running: Set<string>, log: (l: string) => void, manifests: Map<string, { toolchain: { manifestFiles: string[] } }>): string[] {
	let cfg = config;
	try {
		cfg = loadConfig(join(root, "bigrefactor.config.json")).config;
	} catch {
		/* keep the run's config */
	}
	// the environment of the stack the unit parked in (its placement)
	const envNow = (meta: string) => {
		const stackId = placeUnit(cfg, meta, root).stackId;
		return envFingerprint(cfg, projectDir(cfg, stackId), manifests.get(stackId)?.toolchain.manifestFiles ?? []);
	};
	const parkedEnv = ledger.db.prepare("SELECT id, meta, json_extract(meta,'$.parked.question') q, json_extract(meta,'$.parked.env') env FROM units WHERE json_extract(meta,'$.parked.env') IS NOT NULL AND state IN ('truth','implementing','gating')").all() as Array<{ id: string; meta: string; q: number | null; env: string }>;
	for (const p of parkedEnv) {
		if (running.has(p.id) || p.env === envNow(p.meta)) continue;
		if (p.q && ledger.openQuestions().some((x) => x.id === p.q)) ledger.answerQuestion(p.q, "auto: the environment changed since the failure (dependency manifest / stack config)", "orchestrator");
	}
	// waiting units whose blocking questions are all answered (non-blocking ones never hold a unit) get their answer applied
	const candidates = (ledger.db.prepare("SELECT id, state, meta FROM units WHERE state IN ('truth','implementing','gating','review') AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.unit_id = units.id AND a.ended_at IS NULL) AND NOT EXISTS (SELECT 1 FROM questions q WHERE q.unit_id = units.id AND q.status = 'open' AND q.blocks != 'none')").all() as Array<{ id: string; state: string; meta: string }>).filter((u) => !running.has(u.id));
	const parked: typeof candidates = [];
	for (const u of candidates) {
		const meta = JSON.parse(u.meta) as { parked?: { question?: number; diagnosis?: { summary?: string; note?: string } }; hold?: number; applied?: number };
		const q = ledger.db.prepare("SELECT id, point, answer, options FROM questions WHERE unit_id = ? AND status IN ('answered','auto') AND id > ? ORDER BY id DESC LIMIT 1").get(u.id, meta.applied ?? 0) as { id: number; point: string; answer: string; options: string | null } | undefined;
		if (meta.hold && (!q || q.id <= meta.hold)) continue; // the owner said wait: only a newer answer or br requeue moves it
		const a = applyParkedAnswer(q?.answer, q?.options ? (JSON.parse(q.options) as string[]) : []);
		if (a.action === "hold") {
			ledger.updateUnit(u.id, { meta: { hold: q!.id, applied: q!.id } });
			continue;
		}
		if (a.action === "quarantine") {
			ledger.updateUnit(u.id, { meta: { applied: q!.id } });
			ledger.transitionUnit(u.id, "quarantined", `owner answered "${q!.answer}" on question #${q!.id}`);
			removeWorktree(config.target.path, worktreeDir(root, u.id));
			log(pc.red(`■ ${u.id}: quarantined by the answer to #${q!.id}`));
			continue;
		}
		// what the run learned before parking (diagnosis) and the owner's hint go to the next attempt
		const lesson = [meta.parked?.diagnosis?.summary && `Before this unit waited, the failure was diagnosed as: ${meta.parked.diagnosis.summary}${meta.parked.diagnosis.note ? ` (${meta.parked.diagnosis.note})` : ""}.`, a.hint && `The owner's hint: ${a.hint}`].filter(Boolean).join(" ");
		ledger.db.prepare("UPDATE units SET state = 'planned', updated_at = datetime('now'), meta = json_set(json_remove(meta, '$.parked', '$.hold'), '$.applied', ?, '$.retryNote', ?) WHERE id = ?").run(q?.id ?? meta.applied ?? 0, lesson || null, u.id);
		ledger.db.prepare("INSERT INTO transitions(entity, entity_id, from_state, to_state, reason, created_at) VALUES ('unit', ?, ?, 'planned', ?, datetime('now'))").run(u.id, u.state, `resubmitted: ${q ? `answer "${q.answer.slice(0, 80)}" on #${q.id}` : "cause resolved"}`);
		removeWorktree(config.target.path, worktreeDir(root, u.id));
		parked.push(u);
	}
	if (parked.length) log(pc.cyan(`↻ resubmitted ${parked.length} unit(s) whose blocker is resolved: ${parked.map((u) => u.id).slice(0, 5).join(", ")}${parked.length > 5 ? ", …" : ""}`));
	return parked.map((u) => u.id);
}

/**
 * Put quarantined or waiting units back into the queue: open attempts end, worktree and branch go, truth stays.
 * Crash counts and "wait" holds are cleared; an owner's requeue is a fresh start. Returns what happened per id.
 */
export function requeueUnits(ledger: Ledger, config: Config, root: string, ids: string[] | "all", by: string): string[] {
	const stuck = (st: string) => ["quarantined", "truth", "implementing", "gating", "review"].includes(st);
	const list = ids === "all" ? ledger.listUnits().filter((u) => stuck(u.state)).map((u) => u.id) : ids;
	const out: string[] = [];
	for (const id of list) {
		const u = ledger.getUnit(id);
		if (!u) {
			out.push(`${id}: unknown unit`);
			continue;
		}
		if (!stuck(u.state)) {
			out.push(`${id}: ${u.state}; only quarantined or waiting units can be requeued`);
			continue;
		}
		for (const a of ledger.db.prepare("SELECT id FROM attempts WHERE unit_id = ? AND ended_at IS NULL").all(id) as Array<{ id: number }>) ledger.endAttempt(a.id, { outcome: "aborted:requeue" });
		removeWorktree(config.target.path, worktreeDir(root, id));
		try {
			execFileSync("git", ["-C", config.target.path, "branch", "-q", "-D", `unit/${id}`], { stdio: "pipe" });
		} catch {
			/* no branch */
		}
		ledger.db.prepare("UPDATE units SET meta = json_remove(meta, '$.crashes', '$.hold', '$.parked') WHERE id = ?").run(id);
		ledger.transitionUnit(id, "planned", `requeued by ${by}`);
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
 * `br requeue`; an answer that is none of the question's options is a free-text hint for the next attempt.
 */
export function applyParkedAnswer(answer: string | undefined, options: string[]): { action: "requeue" | "quarantine" | "hold"; hint?: string } {
	const a = (answer ?? "").trim();
	if (!a || /^auto:/.test(a)) return { action: "requeue" };
	const value = a.split(/\s+[—-]\s+/)[0]!.toLowerCase();
	if (["quarantine", "leave", "investigate"].includes(value)) return { action: "quarantine" };
	if (value === "wait") return { action: "hold" };
	const isOption = options.some((o) => o.toLowerCase() === a.toLowerCase() || o.toLowerCase().startsWith(`${value} `) || o.toLowerCase() === value);
	return { action: "requeue", hint: isOption ? undefined : a };
}

export interface RunRecord {
	startedAt: string;
	endedAt: string;
	outcome: "finished" | "stopped";
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

export function lastRun(ledger: Ledger): RunRecord | undefined {
	const m = ledger.getMeta("last_run");
	return m ? (JSON.parse(m) as RunRecord) : undefined;
}

export function renderLastRun(r: RunRecord): string {
	const when = r.endedAt.slice(0, 16).replace("T", " ");
	if (r.outcome === "stopped" && r.stop) return `last run stopped ${when} (${r.stop.reason}); finished lanes: ${r.stop.lanes.map((l) => `${l.unit} → ${l.state}`).join(", ") || "none"} · ${r.accepted} accepted · ${r.planned} still planned — /br run continues`;
	return `last run finished ${when}: ${r.accepted} accepted, ${r.quarantined} quarantined, ${r.planned} still planned`;
}
