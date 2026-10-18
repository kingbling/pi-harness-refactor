import type { Ledger } from "../ledger/db.ts";
import type { Config } from "../config.ts";
import type { ModelClient } from "../models/types.ts";
import { decide, setDecisionAction } from "./decide.ts";
import { choiceOf, answerConfidence } from "./questions.ts";

/** Open questions Jev compares one failure with: the newest few, so the state stays small. */
const MAX_CANDIDATES = 6;
/**
 * A model join parks a unit on another unit's answer, so it needs more than the usual JEV_ACT: at 0.76 it joined a
 * stub left in one unit's files to another unit's stray TODO mark.
 */
export const SAME_CAUSE_ACT = 0.85;

/** What a question's facts say about the failure; a join needs them to agree (cannotJoin). */
export type FailureFacts = { failedStep?: string; failureKind?: string; retry?: string; outOfScope?: string };
const stepOf = (c: FailureFacts) => c.failedStep ?? c.failureKind?.split(":")[0];

/**
 * Why a failure cannot share an open question, whatever the model says: another step failed, another retry is left
 * (one's "a plain retry is no answer" is not the other's), or one needs a change outside the unit's files and the
 * other does not. undefined: they may share it.
 */
export function cannotJoin(mine: FailureFacts, theirs: FailureFacts): string | undefined {
	if (stepOf(mine) && stepOf(theirs) && stepOf(mine) !== stepOf(theirs)) return "another step failed";
	if ((mine.retry ?? "") !== (theirs.retry ?? "")) return "another retry is left";
	if (!!mine.outOfScope !== !!theirs.outOfScope) return "one needs a change outside the unit's files, the other does not";
	return undefined;
}

/**
 * "Is this the same failure?" Units with the same failure share one question (and one setup fix). Code matches the
 * key first (errorSignature: cheap and exact). When no open question has the key, Jev reads the open questions of
 * that point and this failure and picks the one with the same cause, or none; only a confident pick joins it. The
 * joined key is remembered on the question, so the next unit with it matches by code. Without a client: key only.
 * Code keeps waiters, caps and bookkeeping; the call is recorded in the decisions table (point "same_cause").
 * `facts`: what this failure's question would carry (step, retry, out of scope): the model may join only questions
 * that agree (cannotJoin), and only at SAME_CAUSE_ACT.
 */
export async function sameQuestion(d: { ledger: Ledger; config: Config; client?: ModelClient }, points: string[], sameAs: string, failure: string, unitId?: string, facts: FailureFacts = {}): Promise<{ id?: number; costUsd: number; by?: "key" | "model" }> {
	for (const p of points) {
		const id = d.ledger.openQuestionFor(p, sameAs);
		if (id !== undefined) return { id, costUsd: 0, by: "key" };
	}
	// a key that names its own unit (parity:<unit>) is about that unit only: it never joins another unit's question
	const ownKey = (key: string, unit: string | null | undefined) => !!unit && key.includes(unit);
	if (!d.client || ownKey(sameAs, unitId)) return { costUsd: 0 };
	// only questions asked as shareable (with a key) can be joined, and only those whose facts agree with this failure's
	const open = d.ledger
		.openQuestions()
		.filter((q) => points.includes(q.point) && q.context && JSON.parse(q.context).sameAs && !ownKey(JSON.parse(q.context).sameAs, q.unit_id) && !cannotJoin(facts, JSON.parse(q.context)))
		.slice(-MAX_CANDIDATES);
	if (!open.length) return { costUsd: 0 };
	const criteria: Record<string, string> = { none: "None of them: a different cause, or cannot tell" }; // first: a neutral answer means "none"
	for (const q of open) {
		const c = JSON.parse(q.context!) as { facts?: string; diagnosis?: { summary?: string } };
		criteria[`q${q.id}`] = `${c.diagnosis?.summary ? `Diagnosis: ${c.diagnosis.summary}\n` : ""}${(c.facts ?? q.question).slice(-500)}`;
	}
	try {
		const dec = await decide({ client: d.client, ledger: d.ledger, model: d.config.models.decide.id }, "same_cause", { failure: failure.slice(-1500) }, {
			same: {
				type: "choice",
				instructions: "Which open question describes a failure with the same cause as `failure`? Same cause means one fix (one setup change, one answer) solves both. Problems that only look alike are not the same cause: another file, function, loader or class to change, or a problem inside the failing unit's own files, needs another fix.",
				criteria,
			},
		}, ["same"], unitId);
		const pick = choiceOf(dec.answers["same"]);
		const hit = pick && pick !== "none" && dec.answers["same"] && answerConfidence(dec.answers["same"]) >= SAME_CAUSE_ACT ? open.find((q) => `q${q.id}` === pick) : undefined;
		setDecisionAction(d.ledger, dec.decisionId, hit ? `join #${hit.id}` : "new question");
		if (!hit) return { costUsd: dec.costUsd };
		d.ledger.addSameAs(hit.id, sameAs);
		return { id: hit.id, costUsd: dec.costUsd, by: "model" };
	} catch {
		return { costUsd: 0 }; // the decision model is unavailable: a question of its own, as without a client
	}
}
