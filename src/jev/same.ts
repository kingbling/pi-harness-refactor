import type { Ledger } from "../ledger/db.ts";
import type { Config } from "../config.ts";
import type { ModelClient } from "../models/types.ts";
import { decide, setDecisionAction } from "./decide.ts";
import { JEV_ACT, choiceOf, answerConfidence } from "./questions.ts";

/** Open questions Jev compares one failure with: the newest few, so the state stays small. */
const MAX_CANDIDATES = 6;

/**
 * "Is this the same failure?" Units with the same failure share one question (and one setup fix). Code matches the
 * key first (errorSignature: cheap and exact). When no open question has the key, Jev reads the open questions of
 * that point and this failure and picks the one with the same cause, or none; only a confident pick joins it. The
 * joined key is remembered on the question, so the next unit with it matches by code. Without a client: key only.
 * Code keeps waiters, caps and bookkeeping; the call is recorded in the decisions table (point "same_cause").
 */
export async function sameQuestion(d: { ledger: Ledger; config: Config; client?: ModelClient }, points: string[], sameAs: string, failure: string, unitId?: string): Promise<{ id?: number; costUsd: number; by?: "key" | "model" }> {
	for (const p of points) {
		const id = d.ledger.openQuestionFor(p, sameAs);
		if (id !== undefined) return { id, costUsd: 0, by: "key" };
	}
	if (!d.client) return { costUsd: 0 };
	// only questions asked as shareable (with a key) can be joined
	const open = d.ledger
		.openQuestions()
		.filter((q) => points.includes(q.point) && q.context && JSON.parse(q.context).sameAs)
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
				instructions: "Which open question describes a failure with the same cause as `failure`? Same cause means one fix (one setup change, one answer) solves both.",
				criteria,
			},
		}, ["same"], unitId);
		const pick = choiceOf(dec.answers["same"]);
		const hit = pick && pick !== "none" && dec.answers["same"] && answerConfidence(dec.answers["same"]) >= JEV_ACT ? open.find((q) => `q${q.id}` === pick) : undefined;
		setDecisionAction(d.ledger, dec.decisionId, hit ? `join #${hit.id}` : "new question");
		if (!hit) return { costUsd: dec.costUsd };
		d.ledger.addSameAs(hit.id, sameAs);
		return { id: hit.id, costUsd: dec.costUsd, by: "model" };
	} catch {
		return { costUsd: 0 }; // the decision model is unavailable: a question of its own, as without a client
	}
}
