import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import pc from "picocolors";
import { getSourceAdapter, getTargetAdapter } from "../adapters/registry.ts";
import { gateSlots, type Config } from "../config.ts";
import { isDbUnitKind } from "../inventory/db.ts";
import type { Ledger } from "../ledger/db.ts";
import { describeTruthRun, loadLegacyEnv, notFromOldCode, probeRunsNow, verifyTruthOnOld, type TruthCase } from "./legacy-env.ts";
import { PLAIN_LANGUAGE } from "../policy.ts";
import { spawnLeaf } from "../sessions/spawn.ts";
import { createHash } from "node:crypto";
import type { SourceAdapter } from "../adapters/types.ts";
import { run } from "./gate.ts";
import { placementDir, placeUnit } from "./placement.ts";
import { projectDir } from "../init/init.ts";
import { mentionsCase } from "./ported.ts";
import { differences } from "./differences.ts";
import { Semaphore } from "./pool.ts";
import { reviewWithModel, type Reviewer } from "./review.ts";

/**
 * `br recheck`: accepted units, held to the checks they never met. Truth that names "run on the old code" must
 * come from it (the script loads the unit's legacy files and does not type the results in), the unit's ported
 * tests run again on the main project, and the reviewer model judges the unit's files as they are now (later
 * units, tidy and repairs change accepted code; the original commit is only context). A unit that fails goes back to planned
 * with its code kept on the branch: the next run starts from it with the findings as its note. Each unit is
 * rechecked once (meta.rechecked); --again repeats. A unit recheck sent back that has not run since is judged again
 * (an earlier recheck may have been wrong): clean now → accepted again, code and history as before; otherwise its
 * note holds the new findings.
 */
export interface RecheckOptions {
	ledger: Ledger;
	config: Config;
	root: string;
	limit?: number;
	again?: boolean;
	reviewer?: Reviewer;
	/** Runs a test command (tests swap it); default: the gate's runner. */
	runTests?: (cmd: string, args: string[], cwd: string) => Promise<{ ok: boolean; output: string }>;
	log?: (l: string) => void;
}

/** Bump when recheck's checks change: units an older recheck sent back (and nothing ran since) are judged once more. */
export const RECHECK_VERSION = 3;

export async function recheckAccepted(o: RecheckOptions): Promise<{ checked: number; reopened: string[]; notJudged: number; restored: string[] }> {
	const log = o.log ?? ((l: string) => console.log(l));
	// sent back by an older recheck and nothing ran since (its last transition is that re-open); truth it threw away cannot come back
	const sentBack = (u: { id: string; state: string; meta: string }) =>
		u.state === "planned" &&
		JSON.parse(u.meta).recheckVersion !== RECHECK_VERSION &&
		/^recheck: /.test(o.ledger.transitionsOf("unit", u.id).at(-1)?.reason ?? "") &&
		(["truth_green_on_old", "truth_read", "truth_none"] as const).some((t) => o.ledger.hasEvidence(u.id, t));
	const units = o.ledger
		.listUnits()
		.filter((u) => !isDbUnitKind(u.kind) && ((u.state === "accepted" && (o.again || !JSON.parse(u.meta).rechecked)) || sentBack(u)))
		.slice(0, o.limit ?? Infinity);
	const restored: string[] = [];
	// every test file of a project with its text, read once per recheck (only when a recorded test path is gone)
	const texts = new Map<string, Array<readonly [string, string]>>();
	const testTexts = (dir: string, layout: { isTestFile: (f: string) => boolean }) => {
		if (!texts.has(dir)) {
			let files: string[] = [];
			try {
				files = execFileSync("git", ["ls-files"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).split("\n").filter((f) => f && layout.isTestFile(f));
			} catch {
				/* not a git checkout: nothing to find */
			}
			texts.set(dir, files.filter((f) => existsSync(join(dir, f))).map((f) => [f, readFileSync(join(dir, f), "utf8")] as const));
		}
		return texts.get(dir)!;
	};
	const source = getSourceAdapter(o.config.source.stack);
	const lanes = new Semaphore(o.config.run.agentConcurrency);
	// test runs are CPU-bound: few at once, like the gate
	const gates = new Semaphore(gateSlots(o.config.run));
	const runTests = o.runTests ?? ((cmd: string, args: string[], cwd: string) => run(cmd, args, cwd, 240_000));
	const main = o.config.target.path;
	const reopened: string[] = [];
	let notJudged = 0;
	log(pc.cyan(`recheck: ${units.length} accepted unit(s), ${lanes.limit} at a time`));
	await Promise.all(
		units.map((u) =>
			lanes.run(async () => {
				const meta = JSON.parse(u.meta) as { files?: string[]; commit?: string };
				const again = u.state === "planned";
				const findings: string[] = [];
				// 1. truth said "run on the old code": did the old code produce it?
				const truthDir = join(o.root, ".bigrefactor", "truth", u.id);
				const script = join(truthDir, source.truth.scriptName);
				let badTruth = false;
				if (o.ledger.hasEvidence(u.id, "truth_green_on_old") && existsSync(script)) {
					const cases = (o.ledger.db.prepare("SELECT symbol_id, inputs, expected FROM truth_cases WHERE unit_id = ? AND verified_on_old = 1").all(u.id) as Array<{ symbol_id: string; inputs: string; expected: string }>).map((c): TruthCase => ({ symbol: c.symbol_id, inputs: JSON.parse(c.inputs), expected: JSON.parse(c.expected) }));
					const why = notFromOldCode(readFileSync(script, "utf8"), cases, meta.files ?? []);
					if (why) {
						badTruth = true;
						findings.push(`the tests from the old behaviour are not from the old code: ${why}`);
					}
				}
				const place = placeUnit(o.config, u.meta, o.root);
				const adapter = await getTargetAdapter(place.stackId);
				// the unit's paths (ported tests, moves) are relative to its stack's project, not the repo root
				const dir = projectDir(o.config, place.stackId);
				// 2. the ported tests (one per truth case) still green on main. A test a later tidy moved or renamed is
				//    found again by its case id (it is in the test's text) and the case is linked to its new file
				const linked = o.ledger.db.prepare("SELECT id, ported_test_path p FROM truth_cases WHERE unit_id = ? AND ported_test_path IS NOT NULL").all(u.id) as Array<{ id: string; p: string }>;
				for (const c of linked.filter((c) => !existsSync(join(dir, c.p)))) {
					const now = testTexts(dir, adapter.layout).find(([, t]) => mentionsCase(t, c.id))?.[0];
					if (now) (o.ledger.db.prepare("UPDATE truth_cases SET ported_test_path = ? WHERE id = ?").run(now, c.id), (c.p = now));
				}
				const ported = [...new Set(linked.map((c) => c.p))];
				const gone = ported.filter((f) => !existsSync(join(dir, f)));
				const tests = ported.filter((f) => existsSync(join(dir, f)));
				if (gone.length) findings.push(`ported tests are gone from the main branch: ${gone.join(", ")}`);
				if (tests.length) {
					const t = adapter.test(dir, tests);
					const res = await gates.run(() => runTests(t.cmd, t.args, dir));
					if (!res.ok) findings.push(`the ported tests fail on the main branch now:\n${res.output.slice(-2500)}`);
				}
				// 3. the reviewer on the unit's files as they are now: where its moves point, plus its commit's files still there
				const files = currentFiles(o.ledger, u.id, main, dir, meta.commit);
				// the reviewer actually looked: no files or a reviewer error is not a clean result
				let judged = false;
				if (files.length) {
					const ra = o.ledger.startAttempt(u.id, "review", o.config.models.escalate.id);
					const r = await (o.reviewer ?? reviewWithModel)({ ledger: o.ledger, config: o.config, root: o.root, unitId: u.id, adapter, targetProjectDir: dir, moduleDir: placementDir(adapter.layout, place), legacyFiles: meta.files ?? [], changedFiles: files, testFiles: tests, commit: meta.commit, recheck: true, transcriptPath: join(o.root, ".bigrefactor", "sessions", `${u.id}.recheck.${ra}.jsonl`) }).catch((e) => ({ ok: true, judged: false, output: `not judged: ${e?.message ?? e}`, costUsd: 0 }));
					o.ledger.endAttempt(ra, { outcome: !r.judged ? "not_judged" : r.ok ? "review_ok" : "review_red", costUsd: r.costUsd ?? 0, gateReport: { output: r.output, recheck: true } });
					const rr = r as { outOfScope?: string; weakTests?: string };
					judged = !!r.judged;
					if (!r.judged) notJudged++;
					// only things outside the unit's files: re-running the unit cannot fix them; one note for the owner (the resolver tries first)
					else if (!r.ok && rr.outOfScope && !rr.weakTests && !/^reviewer findings:/m.test(r.output)) {
						o.ledger.askQuestion({ unitId: u.id, point: "review_outside", question: `The reviewer found problems outside ${u.id}'s files (setup, config, packages):\n${rr.outOfScope}`, options: ["done — fixed outside the code", "ignore — leave it"], blocks: "none", askedBy: "recheck" });
						log(pc.yellow(`? ${u.id}: problems outside its files — asked, unit stays accepted`));
					} else if (!r.ok) findings.push(r.output);
				}
				// a sent-back unit nothing judged keeps its old version, so the next recheck tries it again
				o.ledger.updateUnit(u.id, { meta: { ...JSON.parse(o.ledger.getUnit(u.id)!.meta), rechecked: new Date().toISOString(), ...(judged || findings.length ? { recheckVersion: RECHECK_VERSION } : {}) } });
				const note = `This unit was accepted before, and its code stays on the branch. A later check found problems; start from the existing code and fix them:\n${findings.join("\n")}`;
				if (again) {
					if (findings.length) {
						o.ledger.updateUnit(u.id, { meta: { ...JSON.parse(o.ledger.getUnit(u.id)!.meta), retryNote: note } });
						return;
					}
					if (!judged) {
						log(pc.yellow(`${u.id}: not judged; it stays planned`));
						return;
					}
					try {
						o.ledger.undoReopen(u.id, "recheck: clean when judged again; the earlier re-open was wrong");
						o.ledger.db.prepare("UPDATE units SET meta = json_remove(meta, '$.retryNote') WHERE id = ?").run(u.id);
						restored.push(u.id);
						log(pc.green(`↻ ${u.id}: accepted again (the earlier recheck was wrong)`));
					} catch (e) {
						log(pc.yellow(`${u.id}: clean now but cannot be accepted again (${(e as Error).message}); it stays planned`));
					}
					return;
				}
				if (!findings.length) return;
				reopenUnit(o.ledger, u.id, `This unit was accepted before, and its code stays on the branch. A later check found problems; start from the existing code and fix them:\n${findings.join("\n")}`, `recheck: ${findings.join(" ").slice(0, 200)}`, badTruth);
				reopened.push(u.id);
				log(pc.yellow(`↺ ${u.id}: back to planned (code kept) — ${findings.join(" ").split("\n")[0]!.slice(0, 160)}`));
			}),
		),
	);
	log(pc.cyan(`recheck: ${units.length} checked, ${reopened.length} back to planned${restored.length ? `, ${restored.length} accepted again` : ""}${notJudged ? `, ${notJudged} not judged (reviewer failed; br recheck --again)` : ""}`));
	return { checked: units.length, reopened, notJudged, restored };
}

/** An accepted unit back to planned with its code kept: symbols re-open, `note` is its next run's note; bad truth is redone. */
export function reopenUnit(ledger: Ledger, unitId: string, note: string, reason: string, badTruth = false): void {
	for (const s of ledger.symbolsOfUnit(unitId)) if (s.state === "accepted") ledger.transitionSymbol(s.id, "clustered", reason.slice(0, 200));
	if (badTruth) {
		ledger.db.prepare("DELETE FROM truth_cases WHERE unit_id = ?").run(unitId);
		ledger.db.prepare("DELETE FROM evidence WHERE unit_id = ? AND type IN ('truth_green_on_old', 'truth_read', 'truth_none', 'truth_ahead')").run(unitId);
	}
	ledger.updateUnit(unitId, { meta: { retryNote: note } });
	ledger.transitionUnit(unitId, "planned", reason.split("\n")[0]!.slice(0, 200));
}

/**
 * The unit's files on main now, relative to its stack's project `dir`: the files its moves point to, plus the files
 * of its commit (repo-relative in git, so only those inside `dir`) that still exist.
 */
export function currentFiles(ledger: Ledger, unitId: string, main: string, dir: string, commit?: string): string[] {
	const targets = (ledger.db.prepare("SELECT target_symbols FROM moves WHERE unit_id = ? AND op != 'dropped'").all(unitId) as Array<{ target_symbols: string }>).flatMap((r) => (JSON.parse(r.target_symbols) as string[]).map((t) => t.split("::")[0]!));
	const committed = (commit ? committedFiles(main, commit) : []).map((f) => relative(dir, join(main, f))).filter((f) => !f.startsWith(".."));
	return [...new Set([...targets, ...committed])].filter((f) => f && existsSync(join(dir, f)));
}

function committedFiles(repo: string, sha: string): string[] {
	try {
		return execFileSync("git", ["show", "--name-only", "--format=", sha], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

/**
 * Truth written from reading the old code while it could not run here, now that it can: each unit whose tester
 * also left a script has it run on the old code. Green with the same expected values → the cases count as run on
 * the old code. Green with other values → the recorded truth was wrong: the unit is redone from running it (an
 * accepted one goes back to planned with its code kept). Red → left as it is, tried again once the old code's
 * environment changes. Units with only cases.json are counted, not touched (they need a tester session each).
 */
export function upgradeReadTruth(o: { ledger: Ledger; config: Config; root: string; source?: SourceAdapter; log?: (l: string) => void }): { upgraded: string[]; redone: string[]; red: number; noScript: number } {
	const log = o.log ?? ((l: string) => console.log(l));
	const source = o.source ?? getSourceAdapter(o.config.source.stack);
	const env = envHash(o.root, o.config);
	const ids = (o.ledger.db.prepare("SELECT DISTINCT unit_id AS id FROM evidence WHERE type = 'truth_read' AND unit_id NOT IN (SELECT unit_id FROM evidence WHERE type = 'truth_green_on_old')").all() as Array<{ id: string }>).map((r) => r.id);
	const upgraded: string[] = [];
	const redone: string[] = [];
	let red = 0;
	let noScript = 0;
	for (const id of ids) {
		const u = o.ledger.getUnit(id);
		if (!u || !["accepted", "planned", "quarantined"].includes(u.state)) continue;
		const meta = JSON.parse(u.meta) as { files?: string[]; truthUpgradeEnv?: string };
		const truthDir = join(o.root, ".bigrefactor", "truth", id);
		if (!existsSync(join(truthDir, source.truth.scriptName))) {
			noScript++;
			continue;
		}
		if (meta.truthUpgradeEnv === env) continue;
		const ran = verifyTruthOnOld(truthDir, o.config, source, o.root, meta.files ?? []);
		// red, and the probe does not run either: the old code's runtime is down, so no unit counts as tried
		if (!ran.ok && probeRunsNow(o.root, o.config, source) === false) {
			log(pc.yellow(`truth upgrade: the old code's runtime is down (the probe does not run either); tried again at the next run`));
			break;
		}
		o.ledger.updateUnit(id, { meta: { truthUpgradeEnv: env } });
		if (!ran.ok) {
			red++;
			continue;
		}
		const r = judgeRunTruth(o.ledger, o.root, source, id, ran.cases);
		if (r === "upgraded") upgraded.push(id);
		else if (r === "redone") redone.push(id);
	}
	if (upgraded.length || redone.length || red) log(pc.cyan(`truth upgrade: ${upgraded.length} unit(s) now run green on the old code${redone.length ? `, ${redone.length} redone (the old code returns other values)` : ""}${red ? `, ${red} still red` : ""}${noScript ? `; ${noScript} have only read cases (no script)` : ""}`));
	return { upgraded, redone, red, noScript };
}

/**
 * Read truth against what the old code returned when run (`cases`): all recorded cases the same → they count as run on
 * the old code; one with another value where both hold one → the recorded truth was wrong and the unit is redone (an
 * accepted one goes back to planned, code kept); the run covered other cases or other keys → nothing proven either way.
 */
function judgeRunTruth(ledger: Ledger, root: string, source: SourceAdapter, id: string, cases: TruthCase[]): "upgraded" | "redone" | "other" {
	const u = ledger.getUnit(id)!;
	const truthDir = join(root, ".bigrefactor", "truth", id);
	const recorded = ledger.db.prepare("SELECT id, symbol_id, inputs, expected FROM truth_cases WHERE unit_id = ?").all(id) as Array<{ id: string; symbol_id: string; inputs: string; expected: string }>;
	const key = (symbol: string, inputs: string) => `${symbol}\u0000${inputs}`;
	const byKey = new Map(cases.map((c) => [key(c.symbol, JSON.stringify(c.inputs)), c.expected]));
	const ranFor = (c: { symbol_id: string; inputs: string }) => byKey.get(key(c.symbol_id, c.inputs));
	const diffs = (c: { symbol_id: string; inputs: string; expected: string }) => differences(JSON.parse(c.expected), ranFor(c));
	// wrong only where both sides hold a value: a key one side lacks proves nothing either way
	const wrong = recorded.filter((c) => byKey.has(key(c.symbol_id, c.inputs)) && diffs(c).some((d) => d.a !== undefined && d.b !== undefined));
	const unrun = recorded.filter((c) => !byKey.has(key(c.symbol_id, c.inputs)) || diffs(c).length);
	if (!wrong.length && !unrun.length && recorded.length) {
		ledger.db.prepare("UPDATE truth_cases SET verified_on_old = 1 WHERE unit_id = ?").run(id);
		ledger.addEvidence(id, "truth_green_on_old", { cases: recorded.length, script: relative(root, join(truthDir, source.truth.scriptName)), upgradedFromRead: true });
		return "upgraded";
	}
	if (!wrong.length) return "other";
	const note = `The expected values of this unit were written from reading the old code; now that it runs, it returns other values for ${wrong.length} case(s): ${wrong.slice(0, 5).map((c) => `${c.id} expected ${c.expected.slice(0, 120)}, the old code returns ${JSON.stringify(ranFor(c)).slice(0, 120)}`).join("; ")}. The truth is made again from running the old code; start from the existing code.`;
	if (u.state === "accepted") reopenUnit(ledger, id, note, `truth upgrade: ${wrong.length} case(s) differ when run on the old code`, true);
	else {
		ledger.db.prepare("DELETE FROM truth_cases WHERE unit_id = ?").run(id);
		ledger.db.prepare("DELETE FROM evidence WHERE unit_id = ? AND type IN ('truth_green_on_old', 'truth_read', 'truth_none', 'truth_ahead')").run(id);
		ledger.updateUnit(id, { meta: { retryNote: note } });
	}
	return "redone";
}

/** The old code's environment as a short hash: work tried on it is tried again only once it changes. */
/** Bump when how scripts are run changes (2: absolute legacy-repo paths made relative), so scripts tried before are tried again. */
const RUN_RULES = 2;
const envHash = (root: string, config: Config) => createHash("sha1").update(JSON.stringify({ ...loadLegacyEnv(root, config), why: undefined, rules: RUN_RULES })).digest("hex").slice(0, 12);

/** Writes the unit's cases script into `truthDir` (the recorded cases' symbols and inputs, never their expected values); returns its last sentence. `failed`: why the script already there does not do it. */
export type TruthScriptWriter = (o: { config: Config; root: string; source: SourceAdapter; unitId: string; truthDir: string; legacyFiles: string[]; cases: Array<{ symbol: string; inputs: unknown }>; failed?: string }) => Promise<string | void>;

export const writeTruthScriptWithModel: TruthScriptWriter = async (o) => {
	const script = join(o.truthDir, o.source.truth.scriptName);
	const session = await spawnLeaf({
		role: "test",
		cwd: o.truthDir,
		config: o.config,
		writeGlobs: [o.source.truth.scriptName],
		protectedGlobs: [],
		transcriptPath: join(o.root, ".bigrefactor", "sessions", `${o.unitId}.truth-script.${Date.now()}.jsonl`),
		systemPrompt: `You write a characterization script that runs the OLD ${o.source.id} code, so a migration tool can check expected values that were so far only read from that code. Write ${script} only: ${o.source.truth.instructions} Load the unit's real legacy files by paths relative to the folder the script runs in (the old code's folder; the legacy repo is ${o.config.source.path}, but the old code may run from a copy or a container, so never write that absolute path) and call the real code with exactly the inputs you are given; print one case per input, with the same symbol and inputs and the value the old code returns as expected: [{"symbol": <as given>, "inputs": <as given>, "expected": <what the old code returned>}]. Never write a result into the script yourself and never fake the code: when it cannot run, say what is missing and stop. Never change the legacy repo. Run it the way the tool will: ${describeTruthRun(o.root, o.config, o.source, script)}. End with one sentence.\n\n${PLAIN_LANGUAGE}`,
	});
	try {
		const r = await session.run(`Unit ${o.unitId}. Its legacy files: ${o.legacyFiles.join(", ") || "none recorded"}.${o.failed ? ` A ${o.source.truth.scriptName} is there already but does not do it here; fix it or write it again. When run it gave:\n${o.failed.slice(0, 2000)}\n` : ""} The cases to run (symbol and inputs; JSON):\n${JSON.stringify(o.cases, null, 1).slice(0, 12_000)}`);
		return r.text.trim().split("\n").at(-1) ?? "";
	} finally {
		session.dispose();
	}
};

/**
 * Accepted units whose truth was only read from the old code and that have no script to run it, or one the truth
 * upgrade already ran in this environment without it counting: once the old code runs here, the tester writes or
 * fixes that script (told why the old one failed), a few units per run (`cap`), one at a time on the side. Code runs it on
 * the old code and judges it like upgradeReadTruth. A unit is tried once per environment of the old code.
 */
export async function writeTruthScripts(o: { ledger: Ledger; config: Config; root: string; cap: number; source?: SourceAdapter; writer?: TruthScriptWriter; stopped?: () => boolean; log?: (l: string) => void }): Promise<{ tried: number; upgraded: string[]; redone: string[]; red: number; left: number }> {
	const log = o.log ?? ((l: string) => console.log(l));
	const res = { tried: 0, upgraded: [] as string[], redone: [] as string[], red: 0, left: 0 };
	if (loadLegacyEnv(o.root, o.config).mode !== "run" || o.cap <= 0) return res;
	const source = o.source ?? getSourceAdapter(o.config.source.stack);
	const env = envHash(o.root, o.config);
	const ids = (o.ledger.db.prepare("SELECT DISTINCT e.unit_id AS id FROM evidence e JOIN units u ON u.id = e.unit_id WHERE e.type = 'truth_read' AND u.state = 'accepted' AND e.unit_id NOT IN (SELECT unit_id FROM evidence WHERE type = 'truth_green_on_old') ORDER BY e.unit_id").all() as Array<{ id: string }>)
		.map((r) => r.id)
		.filter((id) => {
			const meta = JSON.parse(o.ledger.getUnit(id)!.meta) as { truthScriptEnv?: string; truthUpgradeEnv?: string };
			// a script run here that is still read truth: red, or it printed other cases
			return meta.truthScriptEnv !== env && (!existsSync(join(o.root, ".bigrefactor", "truth", id, source.truth.scriptName)) || meta.truthUpgradeEnv === env);
		});
	res.left = Math.max(0, ids.length - o.cap);
	if (!ids.length) return res;
	log(pc.cyan(`truth scripts: ${Math.min(ids.length, o.cap)} of ${ids.length} accepted unit(s) with read-only truth get a script that runs the old code${res.left ? ` (${res.left} in later runs)` : ""}`));
	for (const id of ids.slice(0, o.cap)) {
		if (o.stopped?.()) break;
		const meta = JSON.parse(o.ledger.getUnit(id)!.meta) as { files?: string[] };
		const truthDir = join(o.root, ".bigrefactor", "truth", id);
		const cases = (o.ledger.db.prepare("SELECT symbol_id, inputs FROM truth_cases WHERE unit_id = ? ORDER BY rowid").all(id) as Array<{ symbol_id: string; inputs: string }>).map((c) => ({ symbol: c.symbol_id, inputs: JSON.parse(c.inputs) as unknown }));
		if (!cases.length) continue;
		res.tried++;
		const before = existsSync(join(truthDir, source.truth.scriptName)) ? verifyTruthOnOld(truthDir, o.config, source, o.root, meta.files ?? []) : undefined;
		const failed = before && (before.ok ? `it runs, but its cases do not match the recorded ones (other symbols or inputs, or other keys in expected); it printed these (expected left out): ${JSON.stringify(before.cases.map((c) => ({ symbol: c.symbol, inputs: c.inputs }))).slice(0, 1000)}` : before.error ?? "it does not run");
		const said = await (o.writer ?? writeTruthScriptWithModel)({ config: o.config, root: o.root, source, unitId: id, truthDir, legacyFiles: meta.files ?? [], cases, failed }).catch((e) => `failed: ${e?.message ?? e}`);
		o.ledger.updateUnit(id, { meta: { truthScriptEnv: env } });
		// the unit may have been re-opened meanwhile (parity, a bug report): then its truth is redone anyway
		if (o.ledger.getUnit(id)?.state !== "accepted") continue;
		const ran = verifyTruthOnOld(truthDir, o.config, source, o.root, meta.files ?? []);
		if (!ran.ok) {
			res.red++;
			log(pc.dim(`  ${id}: the script does not run green on the old code (${String(ran.error ?? said).split("\n")[0]!.slice(0, 160)})`));
			continue;
		}
		const r = judgeRunTruth(o.ledger, o.root, source, id, ran.cases);
		if (r === "upgraded") res.upgraded.push(id);
		else if (r === "redone") res.redone.push(id);
		log(r === "upgraded" ? pc.green(`  ${id}: its read truth runs green on the old code`) : r === "redone" ? pc.yellow(`  ${id}: the old code returns other values; back to planned, truth made again`) : pc.dim(`  ${id}: the script ran other cases than the recorded ones; left as read`));
	}
	log(pc.cyan(`truth scripts: ${res.upgraded.length} upgraded, ${res.redone.length} redone, ${res.red} red${res.left ? `, ${res.left} left for later runs` : ""}`));
	return res;
}
