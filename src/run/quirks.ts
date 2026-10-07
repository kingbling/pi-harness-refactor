import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { answerValue, askViaModel, type AskDeps } from "../jev/ask.ts";

/**
 * Legacy quirks. The tester does not pin every oddity of the old code; it records each one with an opinion
 * (record_quirk) and writes the ported tests the way the opinion says. Then:
 *  - language_artifact + opinion drop (loose emptiness/truthiness, implicit coercion): dropped, no question;
 *  - everything else: one question via a model ("can this be removed?", always with an opinion); it blocks
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

export function recordQuirk(d: Pick<AskDeps, "ledger"> & { root: string }, q: { unitId: string; symbolId: string; kind: QuirkKind; behaviour: string; example?: string; opinion: "drop" | "keep"; why: string }): { id: number; status: QuirkRow["status"] } {
	const auto = q.kind === "language_artifact" && q.opinion === "drop";
	const status = auto ? "dropped" : "pending";
	const r = d.ledger.db
		.prepare("INSERT INTO quirks(unit_id, symbol_id, kind, behaviour, example, opinion, why, status, decided_by, applied, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
		.run(q.unitId, q.symbolId, q.kind, q.behaviour, q.example ?? null, q.opinion, q.why, status, auto ? "auto" : null, q.opinion, new Date().toISOString());
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
	for (const q of pending) {
		const r = await askViaModel(d, {
			point: "quirk",
			unitId: q.unit_id,
			facts: `While characterizing ${q.symbol_id}, the tester found a quirk (${q.kind}): ${q.behaviour}${q.example ? `\nExample on the old code: ${q.example}` : ""}\nCurrent plan: ${q.opinion === "drop" ? "the new code does NOT reproduce it" : "the new code reproduces it, marked as LEGACY"}.`,
			options: [
				{ value: "drop", facts: "remove the quirk: the new code implements the intended behaviour" },
				{ value: "keep", facts: "keep the quirk 1:1 (callers may depend on it)" },
			],
			recommended: q.opinion,
			agentOpinion: q.why,
			blocks: "unit",
			askedBy: "tester",
			context: { quirkId: q.id, symbol: q.symbol_id },
		});
		cost += r.costUsd;
		d.ledger.db.prepare("UPDATE quirks SET status = 'asked', question_id = ? WHERE id = ?").run(r.id, q.id);
	}
	if (pending.length) writeQuirkFile(d);
	return { asked: pending.length, costUsd: cost };
}

/** Copy answered quirk questions into the quirk table. Returns units whose tests follow a different decision. */
export function syncQuirkAnswers(d: Pick<AskDeps, "ledger"> & { root: string }): string[] {
	const asked = d.ledger.db.prepare("SELECT q.id, q.unit_id, q.applied, x.answer, x.answered_by FROM quirks q JOIN questions x ON x.id = q.question_id WHERE q.status = 'asked' AND x.status IN ('answered','auto')").all() as Array<{ id: number; unit_id: string; applied: string | null; answer: string; answered_by: string }>;
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
