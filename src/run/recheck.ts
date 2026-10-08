import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { getSourceAdapter, getTargetAdapter } from "../adapters/registry.ts";
import type { Config } from "../config.ts";
import { isDbUnitKind } from "../inventory/db.ts";
import type { Ledger } from "../ledger/db.ts";
import { notFromOldCode, type TruthCase } from "./legacy-env.ts";
import { run } from "./gate.ts";
import { placementDir, placeUnit } from "./placement.ts";
import { Semaphore } from "./pool.ts";
import { reviewWithModel, type Reviewer } from "./review.ts";

/**
 * `br recheck`: accepted units, held to the checks they never met. Truth that names "run on the old code" must
 * come from it (the script loads the unit's legacy files and does not type the results in), the unit's ported
 * tests run again on the main project, and the reviewer model judges the unit's files as they are now (later
 * units, tidy and repairs change accepted code; the original commit is only context). A unit that fails goes back to planned
 * with its code kept on the branch: the next run starts from it with the findings as its note. Each unit is
 * rechecked once (meta.rechecked); --again repeats.
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

export async function recheckAccepted(o: RecheckOptions): Promise<{ checked: number; reopened: string[]; notJudged: number }> {
	const log = o.log ?? ((l: string) => console.log(l));
	const units = o.ledger
		.listUnits()
		.filter((u) => u.state === "accepted" && !isDbUnitKind(u.kind) && (o.again || !JSON.parse(u.meta).rechecked))
		.slice(0, o.limit ?? Infinity);
	const source = getSourceAdapter(o.config.source.stack);
	const lanes = new Semaphore(o.config.run.agentConcurrency);
	// test runs are CPU-bound: few at once, like the gate
	const gates = new Semaphore(o.config.run.gateConcurrency);
	const runTests = o.runTests ?? ((cmd: string, args: string[], cwd: string) => run(cmd, args, cwd, 240_000));
	const main = o.config.target.path;
	const reopened: string[] = [];
	let notJudged = 0;
	log(pc.cyan(`recheck: ${units.length} accepted unit(s), ${lanes.limit} at a time`));
	await Promise.all(
		units.map((u) =>
			lanes.run(async () => {
				const meta = JSON.parse(u.meta) as { files?: string[]; commit?: string };
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
				// 2. the ported tests (one per truth case) still green on main
				const ported = [...new Set((o.ledger.db.prepare("SELECT ported_test_path p FROM truth_cases WHERE unit_id = ? AND ported_test_path IS NOT NULL").all(u.id) as Array<{ p: string }>).map((r) => r.p))];
				const gone = ported.filter((f) => !existsSync(join(main, f)));
				const tests = ported.filter((f) => existsSync(join(main, f)));
				if (gone.length) findings.push(`ported tests are gone from the main branch: ${gone.join(", ")}`);
				if (tests.length) {
					const t = adapter.test(main, tests);
					const res = await gates.run(() => runTests(t.cmd, t.args, main));
					if (!res.ok) findings.push(`the ported tests fail on the main branch now:\n${res.output.slice(-2500)}`);
				}
				// 3. the reviewer on the unit's files as they are now: where its moves point, plus its commit's files still there
				const files = currentFiles(o.ledger, u.id, main, meta.commit);
				if (files.length) {
					const ra = o.ledger.startAttempt(u.id, "review", o.config.models.escalate.id);
					const r = await (o.reviewer ?? reviewWithModel)({ ledger: o.ledger, config: o.config, root: o.root, unitId: u.id, adapter, targetProjectDir: main, moduleDir: placementDir(adapter.layout, place), legacyFiles: meta.files ?? [], changedFiles: files, testFiles: tests, commit: meta.commit, recheck: true, transcriptPath: join(o.root, ".bigrefactor", "sessions", `${u.id}.recheck.${ra}.jsonl`) }).catch((e) => ({ ok: true, judged: false, output: `not judged: ${e?.message ?? e}`, costUsd: 0 }));
					o.ledger.endAttempt(ra, { outcome: !r.judged ? "not_judged" : r.ok ? "review_ok" : "review_red", costUsd: r.costUsd ?? 0, gateReport: { output: r.output, recheck: true } });
					const rr = r as { outOfScope?: string; weakTests?: string };
					if (!r.judged) notJudged++;
					// only things outside the unit's files: re-running the unit cannot fix them; one note for the owner (the resolver tries first)
					else if (!r.ok && rr.outOfScope && !rr.weakTests && !/^reviewer findings:/m.test(r.output)) {
						o.ledger.askQuestion({ unitId: u.id, point: "review_outside", question: `The reviewer found problems outside ${u.id}'s files (setup, config, packages):\n${rr.outOfScope}`, options: ["done — fixed outside the code", "ignore — leave it"], blocks: "none", askedBy: "recheck" });
						log(pc.yellow(`? ${u.id}: problems outside its files — asked, unit stays accepted`));
					} else if (!r.ok) findings.push(r.output);
				}
				o.ledger.updateUnit(u.id, { meta: { ...JSON.parse(o.ledger.getUnit(u.id)!.meta), rechecked: new Date().toISOString() } });
				if (!findings.length) return;
				reopenUnit(o.ledger, u.id, `This unit was accepted before, and its code stays on the branch. A later check found problems; start from the existing code and fix them:\n${findings.join("\n")}`, `recheck: ${findings.join(" ").slice(0, 200)}`, badTruth);
				reopened.push(u.id);
				log(pc.yellow(`↺ ${u.id}: back to planned (code kept) — ${findings.join(" ").split("\n")[0]!.slice(0, 160)}`));
			}),
		),
	);
	log(pc.cyan(`recheck: ${units.length} checked, ${reopened.length} back to planned${notJudged ? `, ${notJudged} not judged (reviewer failed; br recheck --again)` : ""}`));
	return { checked: units.length, reopened, notJudged };
}

/** An accepted unit back to planned with its code kept: symbols re-open, `note` is its next run's note; bad truth is redone. */
export function reopenUnit(ledger: Ledger, unitId: string, note: string, reason: string, badTruth = false): void {
	for (const s of ledger.symbolsOfUnit(unitId)) if (s.state === "accepted") ledger.transitionSymbol(s.id, "clustered", reason.slice(0, 200));
	if (badTruth) {
		ledger.db.prepare("DELETE FROM truth_cases WHERE unit_id = ?").run(unitId);
		ledger.db.prepare("DELETE FROM evidence WHERE unit_id = ? AND type IN ('truth_green_on_old', 'truth_ahead')").run(unitId);
	}
	ledger.updateUnit(unitId, { meta: { retryNote: note } });
	ledger.transitionUnit(unitId, "planned", reason.split("\n")[0]!.slice(0, 200));
}

/** The unit's files on main now: the files its moves point to, plus the files of its commit that still exist. */
export function currentFiles(ledger: Ledger, unitId: string, main: string, commit?: string): string[] {
	const targets = (ledger.db.prepare("SELECT target_symbols FROM moves WHERE unit_id = ? AND op != 'dropped'").all(unitId) as Array<{ target_symbols: string }>).flatMap((r) => (JSON.parse(r.target_symbols) as string[]).map((t) => t.split("::")[0]!));
	return [...new Set([...targets, ...(commit ? committedFiles(main, commit) : [])])].filter((f) => f && existsSync(join(main, f)));
}

function committedFiles(repo: string, sha: string): string[] {
	try {
		return execFileSync("git", ["show", "--name-only", "--format=", sha], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n").filter(Boolean);
	} catch {
		return [];
	}
}
