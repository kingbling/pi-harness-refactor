import { createHash } from "node:crypto";
import { diagnoseFailure } from "./doctor.ts";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import pc from "picocolors";
import { getSourceAdapter, getTargetAdapter } from "../adapters/registry.ts";
import type { SourceAdapter, TargetAdapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import { commitAll } from "../git.ts";
import { projectDir } from "../init/init.ts";
import { syntaxErrors } from "../inventory/treesitter.ts";
import { indexTarget } from "../inventory/target.ts";
import type { Ledger } from "../ledger/db.ts";
import type { ModelClient } from "../models/types.ts";
import { spawnLeaf } from "../sessions/spawn.ts";
import { buildTaskCard, renderTaskCard } from "../sessions/taskcard.ts";
import { implementerTools, testerTools } from "../sessions/tools.ts";
import { renderGate, runGate, sha1, type GateReport } from "./gate.ts";
import { implementerSystemPrompt, rulesText, testerSystemPrompt } from "./prompts.ts";
import { triageGate, type Triage } from "./triage.ts";

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
	log?: (line: string) => void;
	/** Git worktree of the target repo to work in (scheduler); default = the target repo itself. */
	workDir?: string;
	/** Extra instruction for the first implement pass (e.g. after a merge conflict). */
	retryNote?: string;
	/** Injection points for simulation level 1 (scripted sessions, scripted build/test outcomes). */
	spawn?: typeof spawnLeaf;
	gate?: typeof runGate;
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

	const stackId = o.config.target.stacks[0]!; // v1: the backend stack owns units; UI units arrive with the React adapter
	const adapter = await getTargetAdapter(stackId);
	const targetProjectDir = o.workDir ? join(o.workDir, relative(o.config.target.path, projectDir(o.config, stackId))) : projectDir(o.config, stackId);
	if (!existsSync(join(targetProjectDir, "package.json"))) throw new Error(`target project missing at ${targetProjectDir}; run br setup`);
	const sourceAdapter = getSourceAdapter(o.config.source.stack);
	const module = moduleName(unit.meta);
	const moduleDir = adapter.layout.moduleDir(module);
	const writeGlobs = [`${moduleDir}/**`];
	const appendOnlyGlobs = adapter.layout.sharedDirs.map((d) => `${d.replace(/\/$/, "")}/**`); // cross-cutting helpers: add new files, never edit
	const truthDirAbs = join(o.root, ".bigrefactor", "truth", o.unitId);
	mkdirSync(truthDirAbs, { recursive: true });
	const truthDirRel = relative(o.root, truthDirAbs);
	const targetRel = relative(o.root, targetProjectDir);
	const rules = rulesText(o.root, targetProjectDir, moduleDir);
	const gateSlot = o.gateSlot ?? (<T>(fn: () => Promise<T>) => fn());
	const spawn = o.spawn ?? spawnLeaf;
	const gateFn = o.gate ?? runGate;
	let cost = 0;
	let providerErrors = 0;

	const deps = { ledger: o.ledger, config: o.config, unitId: o.unitId, root: o.root, targetProjectDir, adapter };
	const card = buildTaskCard(o.ledger, o.config, o.unitId, { targetProjectDir, writeGlobs, adapter });
	if (card.unresolvedDeps.length) log(pc.yellow(`note: ${card.unresolvedDeps.length} dependencies not migrated yet: ${card.unresolvedDeps.join(", ")}`));

	// ---- truth ----------------------------------------------------------------------------------
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
			systemPrompt: testerSystemPrompt(o.config, { truthDir: truthDirRel, targetProjectDir: targetRel, moduleDir, rules, source: sourceAdapter, target: adapter, projectNotes: adapter.projectNotes?.(targetProjectDir) ?? [] }),
			customTools: testerTools({ ...deps, attemptId: attempt }),
			transcriptPath: transcriptPath(o.root, o.unitId, "test", attempt),
			onToolCall: (e) => e.blocked && log(pc.dim(`  tester blocked: ${e.blocked}`)),
		});
		let res;
		try {
			res = await tester.run(renderTaskCard(card, o.config) + (extra ? `\n\n## Re-port requested\n${extra}` : ""));
		} finally {
			tester.dispose();
		}
		cost += res.usage.cost;
		log(pc.dim(`  tester: ${res.toolCalls} tool calls, ${res.blocked} blocked, ${Math.round((Date.now() - t0) / 1000)}s, $${res.usage.cost.toFixed(4)} — ${res.text.split("\n").at(-1)}${res.error ? pc.red(` ERROR: ${res.error}`) : ""}`));

		// Code verifies the truth: re-run the cases script ourselves and load the cases.
		const verified = verifyTruthOnOld(truthDirAbs, o.config, sourceAdapter);
		o.ledger.endAttempt(attempt, { outcome: verified.ok ? "truth_green" : "truth_red", costUsd: res.usage.cost, tokensIn: res.usage.input, tokensOut: res.usage.output, gateReport: { cases: verified.cases.length, error: verified.error } });
		if (!verified.ok) {
			log(pc.red(`  truth failed on old code: ${verified.error}`));
			return false;
		}
		o.ledger.db.prepare("DELETE FROM truth_cases WHERE unit_id = ?").run(o.unitId);
		const ins = o.ledger.db.prepare("INSERT INTO truth_cases(id, unit_id, symbol_id, inputs, expected, verified_on_old, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)");
		verified.cases.forEach((c, i) => ins.run(`${o.unitId}#${i + 1}`, o.unitId, c.symbol, JSON.stringify(c.inputs), JSON.stringify(c.expected), new Date().toISOString()));
		o.ledger.addEvidence(o.unitId, "truth_green_on_old", { cases: verified.cases.length, script: `${truthDirRel}/${sourceAdapter.truth.scriptName}` });
		log(pc.green(`  truth: ${verified.cases.length} cases green on old code`));
		return true;
	};

	const portedDir = join(truthDirAbs, "ported");
	const ahead = !o.truthOnly && o.ledger.hasEvidence(o.unitId, "truth_ahead") && existsSync(portedDir);
	const hasTruth = (o.reuseTruth || ahead) && o.ledger.hasEvidence(o.unitId, "truth_green_on_old") && existsSync(join(truthDirAbs, "interface.md"));
	if (!hasTruth) {
		// Playbook: a red truth script gets one more tester pass with the exact error; then a human question (only this unit waits).
		let truthOk = false;
		let lastErr: string | undefined;
		for (let t = 1; t <= 2 && !truthOk; t++) {
			truthOk = await runTruth(lastErr ? `Your previous ${sourceAdapter.truth.scriptName} failed when run by the orchestrator (from the legacy root). Fix the script so it runs green and prints the JSON array:\n${lastErr}` : undefined);
			if (!truthOk) lastErr = (o.ledger.db.prepare("SELECT gate_report FROM attempts WHERE unit_id = ? AND role = 'test' ORDER BY id DESC LIMIT 1").get(o.unitId) as { gate_report: string } | undefined)?.gate_report ?? "";
		}
		if (!truthOk) {
			const q = o.ledger.askQuestion({ unitId: o.unitId, point: "truth_env", question: `The tester could not get characterization cases green on the old code for ${o.unitId} after 2 passes. Is the legacy code runnable here (deps, autoload, DB)? Fix the environment or mark the unit for goldens instead.`, context: { error: lastErr?.slice(-1500) }, blocks: "unit", askedBy: "orchestrator" });
			log(pc.yellow(`  truth still red; asked question #${q} — only this unit waits`));
			return { unitId: o.unitId, state: o.ledger.getUnit(o.unitId)!.state, attempts: 2, costUsd: cost };
		}
	}

	if (o.truthOnly) {
		// keep the ported tests: the worktree is thrown away until the deps land
		const files = findTests(targetProjectDir, moduleDir, adapter.layout);
		for (const f of files) {
			mkdirSync(dirname(join(portedDir, f)), { recursive: true });
			copyFileSync(join(targetProjectDir, f), join(portedDir, f));
		}
		o.ledger.addEvidence(o.unitId, "truth_ahead", { files });
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

	const loadTests = () => findTests(targetProjectDir, moduleDir, adapter.layout).map((p) => ({ path: p, sha1: sha1(readFileSync(join(targetProjectDir, p))) }));
	let testFiles = loadTests();
	if (!testFiles.length) log(pc.yellow("  no ported test files found — the gate cannot prove behaviour"));
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
	let forceEscalate = route?.difficulty === "hard" && (route.difficultyConfidence ?? 0) >= 0.75;
	if (forceEscalate) log(pc.dim(`  routed to ${o.config.models.escalate.id}: Jev rates this unit hard (${Math.round((route!.difficultyConfidence ?? 0) * 100)}%)`));
	let lastGateText = "";
	while (attemptNo < maxTotal) {
		// Budget per unit is a hard cap enforced by code: spend so far (all roles, all attempts) vs config.
		const spent = (o.ledger.db.prepare("SELECT COALESCE(SUM(cost_usd),0) c FROM attempts WHERE unit_id = ?").get(o.unitId) as { c: number }).c;
		if (spent >= o.config.run.budgetUsdPerUnit) {
			const q = o.ledger.askQuestion({ unitId: o.unitId, point: "budget", question: `${o.unitId} has spent $${spent.toFixed(2)} (cap $${o.config.run.budgetUsdPerUnit}). Raise run.budgetUsdPerUnit, or \`br requeue\` after a fix.`, blocks: "unit", askedBy: "orchestrator" });
			o.ledger.transitionUnit(o.unitId, "quarantined", `budget cap $${o.config.run.budgetUsdPerUnit} reached ($${spent.toFixed(2)})`);
			log(pc.red(`  budget cap reached ($${spent.toFixed(2)}); quarantined, question #${q}`));
			break;
		}
		attemptNo++;
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
			systemPrompt: implementerSystemPrompt(o.config, { moduleDir, sharedDirs: adapter.layout.sharedDirs, rules, attempt: attemptNo }),
			customTools: implementerTools({ ...deps, attemptId: attempt }),
			transcriptPath: transcriptPath(o.root, o.unitId, role, attempt),
			validateWrite: async (path, content) => {
				if (!/\.(ts|tsx)$/.test(path)) return undefined;
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
			...testFiles.map((t) => `### ${t.path}\n\`\`\`ts\n${readFileSync(join(targetProjectDir, t.path), "utf8")}\n\`\`\``),
			lastGateText ? `\n## Previous attempt failed the gate\n${lastGateText}` : "",
			o.retryNote && attemptNo === 1 ? `\n## Note from the orchestrator\n${o.retryNote}` : "",
		].join("\n");
		let res;
		try {
			res = await impl.run(prompt);
		} finally {
			impl.dispose();
		}
		cost += res.usage.cost;
		log(pc.dim(`  ${role} #${attemptNo}: ${res.toolCalls} tool calls, ${res.blocked} blocked, ${Math.round((Date.now() - t0) / 1000)}s, $${res.usage.cost.toFixed(4)} — ${res.text.split("\n").at(-1)}${res.error ? pc.red(` ERROR: ${res.error}`) : ""}`));
		if (res.error && res.toolCalls === 0) {
			// The session never ran (provider error even after tier fallback). Not the code's fault: no attempt burned.
			o.ledger.endAttempt(attempt, { outcome: "session_error", costUsd: res.usage.cost, gateReport: { error: res.error } });
			attemptNo--;
			if (++providerErrors >= 3) {
				const q = o.ledger.askQuestion({ unitId: o.unitId, point: "env", question: `Model sessions keep failing for ${o.unitId}: ${res.error}. Continue when the provider is back?`, blocks: "unit", askedBy: "orchestrator" });
				log(pc.red(`  provider failing repeatedly; asked question #${q} (only this unit waits)`));
				break;
			}
			continue;
		}

		if (o.ledger.getUnit(o.unitId)!.state === "implementing") o.ledger.transitionUnit(o.unitId, "gating", `attempt ${attemptNo}`);
		gate = await gateSlot(() => gateFn({ ledger: o.ledger, unitId: o.unitId, adapter, targetProjectDir, writeGlobs, appendOnlyGlobs, testFiles }));
		o.ledger.endAttempt(attempt, { outcome: gate.ok ? "gate_green" : `gate_red:${gate.failedStep}`, costUsd: res.usage.cost, tokensIn: res.usage.input, tokensOut: res.usage.output, gateReport: gate });
		log(renderGate(gate));
		if (gate.ok) break;

		lastGateText = `failed step: ${gate.failedStep}\n${gate.steps.find((s) => !s.ok)?.output ?? ""}`;
		o.ledger.transitionUnit(o.unitId, "implementing", `gate failed: ${gate.failedStep}`);

		// Jev picks the next step; code enforces caps and acts.
		if (o.client) {
			triage = await triageGate({ ledger: o.ledger, config: o.config, client: o.client }, o.unitId, gate, previousGate, attemptNo);
			log(pc.dim(`  triage: ${triage.cause} → ${triage.action} (${triage.reason}; conf ${triage.confidence.toFixed(2)} ${triage.band})`));
			if (triage.action === "quarantine") break;
			if (triage.action === "ask_human") {
				// Before bothering a human: find out why. Certain/plausible code- or test-side causes are retried
				// automatically (capped); setup gaps become one exact command the human is told about.
				const failedOut = gate.steps.find((x) => !x.ok)?.output ?? "";
				const dx = await diagnoseFailure({ config: o.config, adapter, projectDir: targetProjectDir, failedStep: gate.failedStep ?? "", output: failedOut, client: o.client });
				log(pc.dim(`  doctor (${dx.by}): ${dx.action} — ${dx.summary}`));
				const qid = triage.questionId;
				if ((dx.action === "retest" || dx.action === "reimplement") && doctorActions < 2) {
					doctorActions++;
					if (qid) o.ledger.answerQuestion(qid, `auto: ${dx.action} (${dx.summary})`, "doctor");
					if (dx.action === "retest") {
						const ok = await runTruth(`The gate failed with ${gate.failedStep}: ${dx.summary}. ${dx.note ?? ""} Fix the TESTS, not production code.\n${lastGateText}`);
						if (ok) testFiles = loadTests();
					} else lastGateText += `\n\nDiagnosis: ${dx.summary}. ${dx.note ?? ""}`;
					previousGate = gate;
					continue;
				}
				if (qid) {
					const text = dx.action === "fix"
						? `Easily fixable: ${dx.summary}. Run \`${dx.command}\` in ${targetRel || "."}; the unit resubmits itself when the project changes.`
						: `${o.unitId}: gate step ${gate.failedStep} failed — ${dx.summary}${dx.by === "model" ? " (model diagnosis)" : ""}. Fix the environment; the unit resubmits itself when the project or config changes.`;
					o.ledger.db.prepare("UPDATE questions SET question = ? WHERE id = ?").run(text, qid);
				}
				// remember the environment the failure happened in: a change (package.json/config) resubmits the unit
				o.ledger.updateUnit(o.unitId, { meta: { parked: { question: qid, env: envFingerprint(o.config, projectDir(o.config, stackId)), diagnosis: dx } } });
				log(pc.yellow(`  waiting for human question #${qid} — other units keep running`));
				return { unitId: o.unitId, state: o.ledger.getUnit(o.unitId)!.state, attempts: attemptNo, gate, triage, costUsd: cost };
			}
			if (triage.action === "escalate") forceEscalate = true;
			if (triage.action === "retest") {
				const ok = await runTruth(`The gate failed with ${gate.failedStep}; Jev judged the cause as ${triage.cause}. Re-check interface.md and the ported tests against the legacy behaviour and the implementation at ${targetRel}/src/${module}/; fix the TESTS/INTERFACE, not production code.\n${lastGateText}`);
				if (ok) testFiles = loadTests();
			}
		}
		previousGate = gate;
	}

	if (gate?.ok) {
		// The new code is now part of what later units can reuse: index it (exports, helpers, docs).
		const indexed = await indexTarget(o.ledger, adapter, targetProjectDir, gate.changedFiles).catch((e) => (log(pc.yellow(`  target index failed: ${e?.message ?? e}`)), 0));
		log(pc.dim(`  indexed ${indexed} target symbols`));
		o.ledger.transitionUnit(o.unitId, "review", "gate green");
		if (o.accept) acceptUnit(o, targetProjectDir, module);
	} else if (attemptNo >= maxTotal || triage?.action === "quarantine") {
		o.ledger.transitionUnit(o.unitId, "quarantined", `gate still red after ${attemptNo} attempts (${gate?.failedStep}); ${triage?.reason ?? ""}`.trim());
	}
	const final = o.ledger.getUnit(o.unitId)!;
	return { unitId: o.unitId, state: final.state, attempts: attemptNo, gate, triage, costUsd: cost };
}

export function acceptUnit(o: { ledger: Ledger; config: Config; unitId: string }, targetProjectDir: string, module: string): string | undefined {
	const sha = commitAll(o.config.target.path, `feat(${module}): migrate ${o.unitId}\n\n${o.ledger.symbolsOfUnit(o.unitId).map((s) => `- ${s.id} → ${s.state}`).join("\n")}\n\nbigrefactor: unit ${o.unitId}, target ${relative(o.config.target.path, targetProjectDir) || "."}`);
	o.ledger.transitionUnit(o.unitId, "accepted", sha ? `committed ${sha.slice(0, 7)}` : "accepted (nothing new to commit)");
	if (sha) o.ledger.updateUnit(o.unitId, { branch: o.config.target.git.branch, meta: { ...JSON.parse(o.ledger.getUnit(o.unitId)!.meta), commit: sha } });
	return sha;
}

/** What a parked environment failure depends on: the target's package.json and the workspace config. */
export function envFingerprint(config: Config, projectDir: string): string {
	const read = (p: string) => {
		try {
			return readFileSync(p, "utf8");
		} catch {
			return "";
		}
	};
	return createHash("sha1").update(read(join(projectDir, "package.json"))).update(JSON.stringify(config.target.choices)).update(JSON.stringify(config.target.stacks)).digest("hex").slice(0, 12);
}

function transcriptPath(root: string, unitId: string, role: string, attemptId: number): string {
	const dir = join(root, ".bigrefactor", "sessions");
	mkdirSync(dir, { recursive: true });
	return join(dir, `${unitId}.${role}.${attemptId}.jsonl`);
}

/** `src/controllers/InvoiceController.php` → `invoices`; `src/Pricing.php` → `pricing`; `src/Config.php` → `config`. */
export function moduleName(metaJson: string): string {
	const files = (JSON.parse(metaJson).files ?? []) as string[];
	const base = basename(files[0] ?? "unit").replace(/\.[a-z]+$/, "").replace(/(Controller|Repo|Repository|Service|Model)$/, "");
	const kebab = base.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
	return kebab === "invoice" ? "invoices" : kebab;
}

function verifyTruthOnOld(truthDirAbs: string, config: Config, source: SourceAdapter): { ok: boolean; cases: Array<{ symbol: string; inputs: unknown; expected: unknown }>; error?: string } {
	const script = join(truthDirAbs, source.truth.scriptName);
	if (!existsSync(script)) return { ok: false, cases: [], error: `tester did not write ${source.truth.scriptName}` };
	try {
		const { cmd, args } = source.truth.run(config.source.path, script);
		const out = execFileSync(cmd, args, { cwd: config.source.path, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
		const start = out.indexOf("[");
		const cases = JSON.parse(out.slice(start)) as Array<{ symbol: string; inputs: unknown; expected: unknown }>;
		if (!Array.isArray(cases) || !cases.length) return { ok: false, cases: [], error: `${source.truth.scriptName} printed no cases` };
		const bad = cases.filter((c) => typeof c.symbol !== "string");
		if (bad.length) return { ok: false, cases: [], error: `${bad.length} cases without a symbol id` };
		return { ok: true, cases };
	} catch (e: any) {
		return { ok: false, cases: [], error: (e?.stdout || e?.stderr || e?.message || String(e)).toString().slice(-800) };
	}
}

function findTests(targetProjectDir: string, rel: string, layout: TargetAdapter["layout"]): string[] {
	const dir = join(targetProjectDir, rel);
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	const visit = (d: string) => {
		for (const n of readdirSync(d)) {
			const p = join(d, n);
			if (statSync(p).isDirectory()) visit(p);
			else if (layout.isTestFile(n)) out.push(relative(targetProjectDir, p));
		}
	};
	visit(dir);
	return out.sort();
}
