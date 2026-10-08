import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { answerValue, askViaModel, type AskDeps } from "../jev/ask.ts";
import { decide, setDecisionAction } from "../jev/decide.ts";
import { answerConfidence, choiceOf, JEV_ACT } from "../jev/questions.ts";

/**
 * Legacy quirks. The tester does not pin every oddity of the old code; it records each one with an opinion
 * (record_quirk) and writes the ported tests the way the opinion says. Then:
 *  - the tester's opinion decides, no question, when dropping it only removes an artifact of the old language
 *    or an edge case nobody relies on (language_artifact / edge_case + opinion drop);
 *  - the rest (suspected bugs, intended oddities, anything to keep): one question via a model, always with an
 *    opinion; the model also sees the owner's earlier quirk answers, so a like case gets a like pick; it blocks
 *    only its unit, so implementation starts once the human answered;
 *  - an answer that differs from what the tests follow → the unit re-runs the tester with `quirkRetestNote`.
 * `.bigrefactor/quirks.md` is the human-readable quirk file, rewritten on every change.
 */
export const QUIRK_KINDS = ["language_artifact", "edge_case", "suspected_bug", "intentional"] as const;
export type QuirkKind = (typeof QUIRK_KINDS)[number];

export interface QuirkRow {
	id: number;
	unit_id: string;
	symbol_id: string;
	kind: QuirkKind;
	behaviour: string;
	example: string | null;
	opinion: "drop" | "keep";
	why: string;
	status: "pending" | "asked" | "dropped" | "kept";
	decided_by: string | null;
	applied: "drop" | "keep" | null;
	question_id: number | null;
	created_at: string;
}

/** Behaviour text compared without case, punctuation or spacing ("Returns '0' for []" = "returns 0 for"). */
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * A quirk of the unit that already records this behaviour, or undefined. Code first: the same symbol with the same
 * behaviour text (case, punctuation and spacing ignored). Then, with a client, the decision model reads the unit's
 * quirks and picks the one that describes the same behaviour (one owner answer covers both), or none.
 */
export async function sameQuirk(d: Pick<AskDeps, "ledger" | "config" | "client">, q: { unitId: string; symbolId: string; behaviour: string; example?: string }): Promise<{ row?: QuirkRow; costUsd: number }> {
	const mine = quirksOf(d, q.unitId);
	const exact = mine.find((x) => x.symbol_id === q.symbolId && norm(x.behaviour) === norm(q.behaviour));
	if (exact || !d.client || !mine.length) return { row: exact, costUsd: 0 };
	const open = mine.slice(-MAX_SAME_CANDIDATES);
	const criteria: Record<string, string> = { none: "None of them: a different behaviour, or cannot tell" };
	for (const x of open) criteria[`q${x.id}`] = `${x.symbol_id} (${x.kind}): ${x.behaviour}${x.example ? ` — e.g. ${x.example}` : ""}`.slice(0, 400);
	try {
		const dec = await decide({ client: d.client, ledger: d.ledger, model: d.config.models.decide.id }, "same_quirk", { quirk: `${q.symbolId}: ${q.behaviour}${q.example ? ` — e.g. ${q.example}` : ""}` }, {
			same: {
				type: "choice",
				instructions: "Which recorded quirk describes the same behaviour of the old code as `quirk`? Same means one answer (keep or drop) decides both: the same oddity, maybe in other words or on another symbol of the same code path.",
				criteria,
			},
		}, ["same"], q.unitId);
		const pick = choiceOf(dec.answers["same"]);
		const row = pick && pick !== "none" && dec.answers["same"] && answerConfidence(dec.answers["same"]) >= JEV_ACT ? open.find((x) => `q${x.id}` === pick) : undefined;
		setDecisionAction(d.ledger, dec.decisionId, row ? `same as quirk #${row.id}` : "new quirk");
		return { row, costUsd: dec.costUsd };
	} catch {
		return { costUsd: 0 }; // the decision model is unavailable: code's check only
	}
}
const MAX_SAME_CANDIDATES = 12;

/** The unit's quirks as lines for the tester (so it does not record one twice). */
export function quirkList(d: Pick<AskDeps, "ledger">, unitId: string): string {
	return quirksOf(d, unitId).map((q) => `- #${q.id} ${q.symbol_id} (${q.kind}, ${q.status}${q.status === "pending" || q.status === "asked" ? `, tests follow "${q.applied ?? q.opinion}"` : ""}): ${q.behaviour}`).join("\n");
}

export function recordQuirk(d: Pick<AskDeps, "ledger"> & { root: string }, q: { unitId: string; symbolId: string; kind: QuirkKind; behaviour: string; example?: string; opinion: "drop" | "keep"; why: string }): { id: number; status: QuirkRow["status"]; duplicate?: boolean } {
	// the same behaviour recorded twice is one quirk (one question, one answer)
	const dup = quirksOf(d, q.unitId).find((x) => x.symbol_id === q.symbolId && norm(x.behaviour) === norm(q.behaviour));
	if (dup) return { id: dup.id, status: dup.status, duplicate: true };
	// dropping an old-language artifact or an unused edge case changes nothing a caller relies on: the tester decides
	const auto = (q.kind === "language_artifact" || q.kind === "edge_case") && q.opinion === "drop";
	const status = auto ? "dropped" : "pending";
	const r = d.ledger.db
		.prepare("INSERT INTO quirks(unit_id, symbol_id, kind, behaviour, example, opinion, why, status, decided_by, applied, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
		.run(q.unitId, q.symbolId, q.kind, q.behaviour, q.example ?? null, q.opinion, q.why, status, auto ? "tester" : null, q.opinion, new Date().toISOString());
	writeQuirkFile(d);
	return { id: Number(r.lastInsertRowid), status };
}

export function quirksOf(d: Pick<AskDeps, "ledger">, unitId?: string): QuirkRow[] {
	return (unitId ? d.ledger.db.prepare("SELECT * FROM quirks WHERE unit_id = ? ORDER BY id").all(unitId) : d.ledger.db.prepare("SELECT * FROM quirks ORDER BY unit_id, id").all()) as unknown as QuirkRow[];
}

/** Ask every pending quirk (optionally of one unit). Each question blocks only its unit. */
export async function askPendingQuirks(d: AskDeps & { root: string }, unitId?: string): Promise<{ asked: number; costUsd: number }> {
	const pending = quirksOf(d, unitId).filter((q) => q.status === "pending");
	let cost = 0;
	let asked = 0;
	const earlier = pending.length ? ownerQuirkAnswers(d) : "";
	for (const q of pending) {
		const r = await askViaModel(d, {
			point: "quirk",
			unitId: q.unit_id,
			facts: `While characterizing ${q.symbol_id}, the tester found a quirk (${q.kind}): ${q.behaviour}${q.example ? `\nExample on the old code: ${q.example}` : ""}\nCurrent plan: ${q.opinion === "drop" ? "the new code does NOT reproduce it" : "the new code reproduces it, marked as LEGACY"}. Your answer guides later quirks of the same kind.`,
			options: [
				{ value: "drop", facts: "remove the quirk: the new code implements the intended behaviour" },
				{ value: "keep", facts: "keep the quirk 1:1 (callers may depend on it)" },
			],
			recommended: q.opinion,
			// the tester only sees the code; the phrasing model also knows the owner's goals, so its pick wins
			guess: true,
			agentOpinion: q.why,
			ownerAnswers: earlier || undefined,
			blocks: "unit",
			askedBy: "tester",
			context: { quirkId: q.id, symbol: q.symbol_id },
		});
		cost += r.costUsd;
		asked++;
		d.ledger.db.prepare("UPDATE quirks SET status = 'asked', question_id = ? WHERE id = ?").run(r.id, q.id);
	}
	if (pending.length) writeQuirkFile(d);
	return { asked, costUsd: cost };
}

/**
 * The owner's own earlier quirk answers, for the phrasing model to weigh (newest first). Answers accepted in bulk
 * from a summary and answers the run gave itself are left out: they only repeat a recommendation.
 */
export function ownerQuirkAnswers(d: Pick<AskDeps, "ledger">, limit = 15): string {
	const rows = d.ledger.db
		.prepare("SELECT q.kind, q.symbol_id, q.behaviour, x.answer FROM quirks q JOIN questions x ON x.id = q.question_id WHERE x.status = 'answered' AND x.answered_by NOT LIKE '%accepted the summary%' ORDER BY x.id DESC LIMIT ?")
		.all(limit) as Array<{ kind: string; symbol_id: string; behaviour: string; answer: string }>;
	return rows.map((r) => `- ${r.kind} in ${r.symbol_id}: ${r.behaviour} → ${answerValue(r.answer)}`).join("\n");
}

/** Copy answered quirk questions into the quirk table. Returns units whose tests follow a different decision. */
export function syncQuirkAnswers(d: Pick<AskDeps, "ledger"> & { root: string }): string[] {
	const asked = d.ledger.db.prepare("SELECT q.id, q.unit_id, q.applied, x.answer, x.answered_by FROM quirks q JOIN questions x ON x.id = q.question_id WHERE (q.status = 'asked' AND x.status IN ('answered','auto')) OR (q.decided_by LIKE 'auto%' AND x.status = 'answered')").all() as Array<{ id: number; unit_id: string; applied: string | null; answer: string; answered_by: string }>;
	const rework = new Set<string>();
	for (const a of asked) {
		const v = answerValue(a.answer) === "keep" ? "keep" : "drop";
		d.ledger.db.prepare("UPDATE quirks SET status = ?, decided_by = ? WHERE id = ?").run(v === "keep" ? "kept" : "dropped", a.answered_by ?? "human", a.id);
		if (a.applied !== v) rework.add(a.unit_id);
	}
	if (asked.length) writeQuirkFile(d);
	return [...rework];
}

/**
 * Instruction for the tester when decided quirks differ from what the unit's tests follow; undefined = tests are
 * current. Marks the quirks applied, so the note is produced once.
 */
export function quirkRetestNote(d: Pick<AskDeps, "ledger"> & { root: string }, unitId: string): string | undefined {
	syncQuirkAnswers(d);
	const off = quirksOf(d, unitId).filter((q) => (q.status === "kept" && q.applied !== "keep") || (q.status === "dropped" && q.applied !== "drop"));
	if (!off.length) return undefined;
	for (const q of off) d.ledger.db.prepare("UPDATE quirks SET applied = ? WHERE id = ?").run(q.status === "kept" ? "keep" : "drop", q.id);
	return `The owner decided on quirks you recorded. Rewrite the affected tests and interface.md:\n${off.map((q) => `- ${q.symbol_id}: ${q.behaviour} → ${q.status === "kept" ? "KEEP it (pin it, mark LEGACY)" : "DROP it (test the intended behaviour, do not pin the quirk)"}`).join("\n")}`;
}

/** Decided quirks of a unit, for the implementer's task. */
export function quirkSummary(d: Pick<AskDeps, "ledger">, unitId: string): string {
	const qs = quirksOf(d, unitId).filter((q) => q.status !== "pending");
	return qs.map((q) => `- ${q.symbol_id}: ${q.behaviour} → ${q.status === "kept" ? "keep (reproduce, with the legacy marker comment)" : q.status === "dropped" ? "drop (do not reproduce)" : `waiting for an answer; follow "${q.applied}"`}`).join("\n");
}

export function writeQuirkFile(d: Pick<AskDeps, "ledger"> & { root: string }): void {
	const rows = quirksOf(d);
	const L = ["# Legacy quirks", "", "Recorded by the tester per unit. `dropped` = the new code does not reproduce it; `kept` = reproduced, marked with a legacy comment; `asked` = waiting for your answer (`br questions`).", ""];
	let unit = "";
	for (const q of rows) {
		if (q.unit_id !== unit) L.push(`## ${(unit = q.unit_id)}`, "");
		L.push(`- **${q.status}** (${q.kind}, opinion: ${q.opinion}${q.decided_by ? `, decided by ${q.decided_by}` : ""}${q.question_id ? `, question #${q.question_id}` : ""}) \`${q.symbol_id}\`: ${q.behaviour}${q.example ? ` — e.g. ${q.example}` : ""}`, `  - why: ${q.why}`);
	}
	const p = join(d.root, ".bigrefactor", "quirks.md");
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, L.join("\n") + "\n");
}
