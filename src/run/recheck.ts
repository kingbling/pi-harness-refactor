import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { getSourceAdapter, getTargetAdapter } from "../adapters/registry.ts";
import type { Config } from "../config.ts";
import { isDbUnitKind } from "../inventory/db.ts";
import type { Ledger } from "../ledger/db.ts";
import { notFromOldCode, type TruthCase } from "./legacy-env.ts";
import { placementDir, placeUnit } from "./placement.ts";
import { Semaphore } from "./pool.ts";
import { reviewWithModel, type Reviewer } from "./review.ts";

/**
 * `br recheck`: accepted units, held to the checks they never met. Truth that names "run on the old code" must
 * come from it (the script loads the unit's legacy files and does not type the results in), and the reviewer
 * model judges the unit's commit (real, connected, on the chosen stack). A unit that fails goes back to planned
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
				// 2. the reviewer on the unit's commit
				if (meta.commit) {
					const place = placeUnit(o.config, u.meta, o.root);
					const adapter = await getTargetAdapter(place.stackId);
					const files = committedFiles(o.config.target.path, meta.commit);
					const ra = o.ledger.startAttempt(u.id, "review", o.config.models.escalate.id);
					const r = await (o.reviewer ?? reviewWithModel)({ ledger: o.ledger, config: o.config, root: o.root, unitId: u.id, adapter, targetProjectDir: o.config.target.path, moduleDir: placementDir(adapter.layout, place), legacyFiles: meta.files ?? [], changedFiles: files, commit: meta.commit, transcriptPath: join(o.root, ".bigrefactor", "sessions", `${u.id}.recheck.${ra}.jsonl`) }).catch((e) => ({ ok: true, judged: false, output: `not judged: ${e?.message ?? e}`, costUsd: 0 }));
					o.ledger.endAttempt(ra, { outcome: !r.judged ? "not_judged" : r.ok ? "review_ok" : "review_red", costUsd: r.costUsd ?? 0, gateReport: { output: r.output, recheck: true } });
					if (!r.judged) notJudged++;
					else if (!r.ok) findings.push(r.output);
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

function committedFiles(repo: string, sha: string): string[] {
	try {
		return execFileSync("git", ["show", "--name-only", "--format=", sha], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n").filter(Boolean);
	} catch {
		return [];
	}
}
