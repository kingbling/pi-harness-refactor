import { forecast, renderForecastLine } from "./forecast.ts";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
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
import { SYSTEMIC_FAILURE } from "../jev/questions.ts";
import { envFingerprint, moduleName, runUnit, type UnitRunOptions, type UnitRunResult } from "./unit.ts";

/**
 * The scheduler: many agent sessions, few gate workers, one merge at a time.
 *
 *  ready(unit)  = planned ∧ not stale ∧ not waiting on a question ∧ every dep accepted (merged)
 *  priority     = (sliceRank asc, depth desc, id)  — slices order the work, the DAG keeps it correct
 *  isolation    = one git worktree per running unit under .bigrefactor/worktrees/<unit> (outside the repo),
 *                 node_modules symlinked from the main project; accept = rebase onto the main branch, ff-merge
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
	/** Injection points (simulation). */
	spawn?: UnitRunOptions["spawn"];
	gate?: UnitRunOptions["gate"];
}

export interface SchedulerResult {
	ran: UnitRunResult[];
	accepted: number;
	quarantined: number;
	waiting: number;
	costUsd: number;
}

export async function runScheduler(o: SchedulerOptions): Promise<SchedulerResult> {
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
	// Parked units (state kept, attempt closed, waiting on a question) are resubmitted as soon as the cause is
	// gone: their question was answered, or — for environment failures — the target project or the stack
	// config changed since they parked. Checked at start and on every scheduling loop.
	const resubmitParked = () => resubmitParkedUnits(ledger, config, o.root, new Set(running.keys()), log);

	const stackId = config.target.stacks[0]!;
	const mainProject = projectDir(config, stackId);
	const adapter = await getTargetAdapter(stackId);
	excludeFromGit(config.target.path, ["node_modules", "dist"]);
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
		const blocked = ledger.blockedUnits();
		decisionBlocked = o.blocked?.() ?? new Map();
		for (const u of decisionBlocked.keys()) if (!blocked.has(u)) blocked.set(u, []);
		// one unit per target module at a time: units sharing a write scope would conflict on merge
		const busyModules = new Set([...running.keys()].map((id) => moduleName(ledger.getUnit(id)!.meta)));
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
			if (busyModules.has(moduleName(u.meta))) return false;
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
			linkNodeModules(mainProject, join(wt, relative(config.target.path, mainProject)));
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
		running.set(unitId, p.finally(() => (running.delete(unitId), aheadRunning.delete(unitId))));
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
				   AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.unit_id = u.id AND e.type IN ('truth_ahead', 'truth_green_on_old'))`,
			)
			.all() as Array<{ id: string; meta: string; open: number }>;
		return rows
			.filter((u) => u.open > 0 && !running.has(u.id) && !blocked.has(u.id) && !decisionBlocked.has(u.id))
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
				linkNodeModules(mainProject, join(wt, relative(config.target.path, mainProject)));
				ledger.updateUnit(unitId, { worktree: wt, branch });
			};
			fresh();
			log(pc.bold(`▶ ${unitId}`) + pc.dim(`  [${JSON.parse(ledger.getUnit(unitId)!.meta).slice ?? "?"}]`));
			let res: UnitRunResult | undefined;
			let conflictNote: string | undefined;
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
							const sha = mergeUnit(config, unitId, wt, branch, mainProject);
							ledger.transitionUnit(unitId, "accepted", sha ? `merged ${sha.slice(0, 7)} into ${config.target.git.branch}` : "merged (no changes)");
							if (sha) ledger.updateUnit(unitId, { meta: { ...JSON.parse(ledger.getUnit(unitId)!.meta), commit: sha } });
							await indexTarget(ledger, adapter, mainProject, res!.gate?.changedFiles).catch(() => 0);
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
				log(pc.red(`✗ ${unitId}: ${e?.message ?? e}`));
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
				await circuit(unitId, st, res);
			}
		});
		running.set(unitId, p.finally(() => running.delete(unitId)));
	};

	// ---- circuit breaker: when most recently finished units failed, Jev decides whether the failures share one
	// root cause (bad rule, broken env, model degradation). Systemic → stop starting units + one ledger question.
	const recent: Array<{ unit: string; ok: boolean; cause?: string; gate?: string; sig?: string }> = [];
	let circuitOpen = false;
	const circuit = async (unitId: string, st: string, res: UnitRunResult | undefined) => {
		const bad = res?.gate?.steps.find((x) => !x.ok);
		const gate = bad ? `${bad.name}: ${String(bad.output ?? "").slice(0, 600)}` : undefined;
		recent.push({ unit: unitId, ok: st === "accepted" || st === "review", cause: res?.triage?.cause, gate, sig: bad ? errorSignature(bad.name, String(bad.output ?? "")) : undefined });
		if (recent.length > 6) recent.shift();
		const failed = recent.filter((r) => !r.ok);
		// certain case first: the same error in 3 units is one cause, whatever a model says
		const bySig = new Map<string, string[]>();
		for (const f of failed) if (f.sig) bySig.set(f.sig, [...(bySig.get(f.sig) ?? []), f.unit]);
		const same = [...bySig.entries()].find(([, us]) => us.length >= 3);
		if (!circuitOpen && same) {
			circuitOpen = true;
			requestStop(`circuit breaker: same error in ${same[1].length} units`);
			const q = ledger.askQuestion({ point: "systemic_failure", question: `${same[1].length} units failed with the same error (${same[0]}): ${same[1].join(", ")}. One cause, not ${same[1].length} bugs — fix it once; parked units resubmit themselves when the project or config changes.`, blocks: "none", askedBy: "orchestrator" });
			log(pc.red(`circuit open: ${same[1].length} units failed with the same error (${same[0]}); running units finish, no new ones start — question #${q}`));
			return;
		}
		if (circuitOpen || !o.client || failed.length < 3 || failed.length < recent.length / 2) return;
		try {
			const r = await decide({ client: o.client, ledger, model: config.models.decide.id }, "systemic_failure", { recent_failures: failed.map((f) => ({ unit: f.unit, cause: f.cause, gate: f.gate })) }, SYSTEMIC_FAILURE, ["systemic"]);
			const sys = r.answers["systemic"];
			const kind = r.answers["kind"]?.type === "choice" ? (r.answers["kind"] as { choice: string }).choice : "other";
			if (sys?.type === "noul" && sys.noul >= 0.75 && kind !== "hard_batch") {
				circuitOpen = true;
				requestStop(`circuit breaker: systemic failure`);
				const q = ledger.askQuestion({ point: "systemic_failure", question: `${failed.length} of the last ${recent.length} units failed with one shared cause (Jev: ${kind}, ${Math.round(sys.noul * 100)}%): ${failed.map((f) => `${f.unit}${f.cause ? ` (${f.cause})` : ""}`).join(", ")}. Fix the cause, then \`br requeue\` and \`br run\`.`, blocks: "none", askedBy: "orchestrator" });
				log(pc.red(`circuit open: failures look systemic (${kind}); running units finish, no new ones start — question #${q}`));
			}
		} catch {
			/* Jev unavailable: keep running */
		}
	};

	const spentToday = () => (ledger.db.prepare("SELECT COALESCE(SUM(cost_usd),0) c FROM attempts WHERE started_at >= date('now')").get() as { c: number }).c + (ledger.db.prepare("SELECT COALESCE(SUM(cost_usd),0) c FROM decisions WHERE created_at >= date('now')").get() as { c: number }).c;
	let dayCapHit = false;

	// ---- main loop
	resubmitParked();
	let lastResubmitCheck = Date.now();
	for (;;) {
		reloadLanes();
		if (Date.now() - lastResubmitCheck > 5000) {
			resubmitParked();
			lastResubmitCheck = Date.now();
		}
		if (!dayCapHit && spentToday() >= config.run.budgetUsdPerDay) {
			dayCapHit = true;
			ledger.askQuestion({ point: "budget", question: `Daily budget $${config.run.budgetUsdPerDay} reached ($${spentToday().toFixed(2)} today). Running units finish; no new ones start. Raise run.budgetUsdPerDay or rerun tomorrow.`, blocks: "none", askedBy: "orchestrator" });
			log(pc.red(`daily budget cap reached ($${spentToday().toFixed(2)}); not starting new units`));
		}
		if (!stopRecord && o.shouldStop?.()) requestStop("/br stop");
		// A pilot of N migrates N units: in-flight units count toward the limit (otherwise up to N+lanes-1 land).
		const underLimit = () => o.limit === undefined || acceptedNow + running.size < o.limit;
		let readyNow = 0;
		if (!stop && !dayCapHit && underLimit()) {
			const candidates = ready();
			readyNow = candidates.length;
			for (const id of candidates) {
				if (running.size >= laneLimit || !underLimit()) break;
				startUnit(id);
				readyNow--;
			}
		}
		// Lanes stay full while anything is todo: idle lanes capture truth for units still waiting on deps.
		// Not in a pilot (a limit means "spend on N units"), not while stopping or over budget.
		if ((o.truthAhead ?? o.limit === undefined) && !stop && !dayCapHit && running.size < laneLimit) {
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
	}
	process.off("SIGINT", onSigint);

	const quarantined = ran.filter((r) => r.state === "quarantined").length;
	const waiting = ledger.listUnits({ state: "planned" }).length;
	// a truth-ahead lane leaves its unit planned by design: say what it produced instead
	const truthAhead = (id: string) => (ledger.db.prepare("SELECT 1 FROM evidence WHERE unit_id = ? AND type = 'truth_ahead' LIMIT 1").get(id) ? "planned, truth ready ahead" : undefined);
	const lanes = stopRecord ? stopRecord.finishing.map((id) => { const st = ledger.getUnit(id)?.state ?? "?"; return { unit: id, state: (st === "planned" && truthAhead(id)) || st }; }) : [];
	if (stopRecord) log(pc.yellow(`stopped (${stopRecord.reason}); lanes that finished: ${lanes.map((l) => `${l.unit} → ${l.state}`).join(", ") || "none were running"}`));
	log(`\nrun ${stopRecord ? "stopped" : "finished"}: ${acceptedNow} accepted, ${quarantined} quarantined, ${waiting} still planned${ledger.openQuestions().length ? `, ${ledger.openQuestions().length} question(s) open → br questions` : ""}, $${cost.toFixed(3)}`);
	if (!o.dry) log(pc.dim(renderForecastLine(forecast(ledger))));
	if (!o.dry) writeRunRecord(ledger, o.root, { startedAt, endedAt: new Date().toISOString(), outcome: stopRecord ? "stopped" : "finished", stop: stopRecord ? { ...stopRecord, lanes } : undefined, accepted: acceptedNow, quarantined, planned: waiting, openQuestions: ledger.openQuestions().length, costUsd: Number(cost.toFixed(4)), units: ran.map((r) => ({ unit: r.unitId, state: r.state })) });
	return { ran, accepted: acceptedNow, quarantined, waiting, costUsd: cost };
}

/** Bring the unit branch up to date with the main branch and fast-forward it in. */
function mergeUnit(config: Config, unitId: string, wt: string, branch: string, _mainProject: string): string | undefined {
	const main = config.target.git.branch;
	const before = headOf(config.target.path);
	gitIn(wt, ["add", "-A"]); // node_modules/dist are excluded repo-wide via info/exclude (see excludeFromGit)
	const staged = execFileSync("git", ["-C", wt, "diff", "--cached", "--name-only"], { encoding: "utf8" }).trim();
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

/** Repo-level excludes shared by all worktrees. The generators' `.gitignore` uses `node_modules/`, which does not match our symlink. */
export function excludeFromGit(repo: string, patterns: string[]): void {
	try {
		const gitDir = execFileSync("git", ["-C", repo, "rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim();
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

function linkNodeModules(mainProject: string, wtProject: string): void {
	const src = join(mainProject, "node_modules");
	const dst = join(wtProject, "node_modules");
	if (existsSync(src) && !existsSync(dst)) symlinkSync(src, dst, "dir");
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
	const r = await runScheduler({ ledger, config, root, client: new OpenRouterClient(), units: opts.units, slice: opts.slice, limit: opts.limit, dry: opts.dry, blocked, waitForDecisions: !!process.stdout.isTTY });
	process.exitCode = r.quarantined && !r.accepted ? 1 : 0;
}

/** Same error, different unit → same signature: step + first error line with paths, positions and names in quotes kept, file names dropped. */
export function errorSignature(step: string, output: string): string {
	const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
	const line = clean.split(/\r?\n/).find((l) => /error|failed|cannot|not found/i.test(l)) ?? clean.split(/\r?\n/).find((l) => l.trim()) ?? "";
	return `${step}: ${line.replace(/\S+\.(?:[cm]?[jt]sx?|php|py|rb|go|java)(?::\d+)*/g, "<file>").replace(/\b\d+\b/g, "N").replace(/\s+/g, " ").trim().slice(0, 160)}`;
}

/**
 * Parked units (state kept, attempt closed, waiting on a question) go back to planned as soon as the cause is
 * gone: their question was answered, or (environment failures) the target project or stack config changed.
 */
export function resubmitParkedUnits(ledger: Ledger, config: Config, root: string, running: Set<string>, log: (l: string) => void): string[] {
	let cfg = config;
	try {
		cfg = loadConfig(join(root, "bigrefactor.config.json")).config;
	} catch {
		/* keep the run's config */
	}
	const envNow = envFingerprint(cfg, projectDir(cfg, cfg.target.stacks[0]!));
	const parkedEnv = ledger.db.prepare("SELECT id, json_extract(meta,'$.parked.question') q, json_extract(meta,'$.parked.env') env FROM units WHERE json_extract(meta,'$.parked.env') IS NOT NULL AND state IN ('truth','implementing','gating')").all() as Array<{ id: string; q: number | null; env: string }>;
	for (const p of parkedEnv) {
		if (running.has(p.id) || p.env === envNow) continue;
		if (p.q && ledger.openQuestions().some((x) => x.id === p.q)) ledger.answerQuestion(p.q, "auto: the environment changed since the failure (package.json / stack config)", "orchestrator");
	}
	const parked = (ledger.db.prepare("SELECT id, state FROM units WHERE state IN ('truth','implementing','gating','review') AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.unit_id = units.id AND a.ended_at IS NULL) AND NOT EXISTS (SELECT 1 FROM questions q WHERE q.unit_id = units.id AND q.status = 'open')").all() as Array<{ id: string; state: string }>).filter((u) => !running.has(u.id));
	for (const u of parked) {
		ledger.db.prepare("UPDATE units SET state = 'planned', updated_at = datetime('now'), meta = json_remove(meta, '$.parked') WHERE id = ?").run(u.id);
		ledger.db.prepare("INSERT INTO transitions(entity, entity_id, from_state, to_state, reason, created_at) VALUES ('unit', ?, ?, 'planned', 'resubmitted: cause resolved (question answered or environment changed)', datetime('now'))").run(u.id, u.state);
		removeWorktree(config.target.path, worktreeDir(root, u.id));
	}
	if (parked.length) log(pc.cyan(`↻ resubmitted ${parked.length} unit(s) whose blocker is resolved: ${parked.map((u) => u.id).slice(0, 5).join(", ")}${parked.length > 5 ? ", …" : ""}`));
	return parked.map((u) => u.id);
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
