import { createHash } from "node:crypto";
import type { Ledger } from "../ledger/db.ts";
import type { DecisionAnswer, ModelClient } from "../models/types.ts";
import { answerConfidence, JEV_ACT, type Battery } from "./questions.ts";

export interface Decision {
	answers: Record<string, DecisionAnswer>;
	/** Minimum confidence across the answers the caller declared as primary. */
	confidence: number;
	costUsd: number;
	decisionId: number;
	/** Below JEV_ACT a stronger model was asked on the same evidence: agreed = the answer stands at JEV_ACT. */
	secondOpinion?: "agreed" | "disagreed" | "unavailable";
}

/**
 * Runs a battery against a state and records the call in the ledger (for audit + calibration).
 * `primary` names the questions whose confidence gates the action; the rest are speculative.
 */
export async function decide(
	deps: {
		client: ModelClient;
		ledger: Ledger;
		model: string;
		/** model for the second opinion below JEV_ACT */
		second?: string;
		/** Only ask it when Jev's answer, once confirmed, would change what the caller does (default: always). */
		secondWhen?: (answers: Record<string, DecisionAnswer>) => boolean;
	},
	point: string,
	state: unknown,
	battery: Battery,
	primary: string[],
	unitId?: string,
): Promise<Decision> {
	const stateJson = JSON.stringify(state);
	const stateHash = createHash("sha1").update(stateJson).digest("hex").slice(0, 12);
	const t0 = Date.now();
	const res = await deps.client.decide({ model: deps.model, state, questions: battery });
	const confs = primary.map((q) => (res.answers[q] ? answerConfidence(res.answers[q]!) : 0));
	let confidence = confs.length ? Math.min(...confs) : 0;
	let answers = res.answers;
	let cost = res.usage.costUsd;
	let model = res.usage.model;
	let secondOpinion: Decision["secondOpinion"];
	let second: { verdict: string; model: string; answers?: unknown; jevConfidence: number } | undefined;
	if (confidence < JEV_ACT && deps.second && primary.length && (deps.secondWhen?.(res.answers) ?? true)) {
		const so = await askSecondOpinion(deps.client, deps.second, state, battery, primary, res.answers);
		cost += so.costUsd;
		secondOpinion = so.verdict;
		// kept either way: a disagreeing answer is what calibration and template changes learn from
		second = { verdict: so.verdict, model: so.model, answers: so.raw, jevConfidence: confidence };
		if (so.verdict === "agreed") {
			answers = so.answers;
			confidence = JEV_ACT;
			model = `${res.usage.model}+${so.model}`;
		}
	}
	const decisionId = deps.ledger.recordDecision({
		unitId,
		point,
		model,
		stateHash,
		answers: second ? { ...answers, _jev: res.answers, _second_opinion: second } : answers,
		confidence,
		costUsd: cost,
		latencyMs: Date.now() - t0,
		state: stateJson,
	});
	return { answers, confidence, costUsd: cost, decisionId, secondOpinion };
}

/**
 * Second opinion: the stronger model answers the primary questions on the same evidence, blind to Jev's answer.
 * It agrees when every primary choice matches and every yes/no lands on the same side; then the answers stand.
 * Score questions are not second-guessed (they never agree by construction).
 */
async function askSecondOpinion(client: ModelClient, model: string, state: unknown, battery: Battery, primary: string[], jev: Record<string, DecisionAnswer>): Promise<{ verdict: "agreed" | "disagreed" | "unavailable"; answers: Record<string, DecisionAnswer>; costUsd: number; model: string; raw?: unknown }> {
	const qs = primary.filter((q) => battery[q] && battery[q]!.type !== "score");
	if (!qs.length) return { verdict: "unavailable", answers: jev, costUsd: 0, model };
	const properties: Record<string, unknown> = {};
	for (const q of qs) {
		const b = battery[q]!;
		properties[q] = b.type === "choice" ? { type: "string", enum: Object.keys(b.criteria) } : { type: "number", description: "probability 0..1 that the answer is yes" };
	}
	try {
		const r = await client.chat({
			model,
			effort: "medium",
			schema: { type: "object", additionalProperties: false, required: qs, properties },
			messages: [
				{ role: "system", content: "Answer each question about the state. Choices: pick the best option key. Yes/no questions: give the probability of yes. Be calibrated; use only the given state." },
				{ role: "user", content: `State:\n${JSON.stringify(state).slice(0, 12000)}\n\nQuestions:\n${qs.map((q) => `${q}: ${JSON.stringify(battery[q])}`).join("\n")}` },
			],
		});
		const j = r.json as Record<string, unknown> | undefined;
		if (!j) return { verdict: "unavailable", answers: jev, costUsd: r.usage.costUsd, model: r.usage.model };
		const agreed = qs.every((q) => {
			const a = jev[q];
			if (a?.type === "choice") return j[q] === a.choice;
			if (a?.type === "noul") return typeof j[q] === "number" && (j[q] as number) >= 0.5 === a.noul >= 0.5 && Math.abs((j[q] as number) - 0.5) >= 0.2;
			return false;
		});
		// agreed: each primary answer stands at the act line (callers read per-answer confidence too)
		const lifted: Record<string, DecisionAnswer> = { ...jev };
		if (agreed)
			for (const q of qs) {
				const a = jev[q]!;
				if (a.type === "choice") lifted[q] = { ...a, confidence: Math.max(a.confidence, JEV_ACT) };
				else if (a.type === "noul") lifted[q] = { ...a, noul: a.noul >= 0.5 ? Math.max(a.noul, 0.5 + JEV_ACT / 2) : Math.min(a.noul, 0.5 - JEV_ACT / 2) };
			}
		return { verdict: agreed ? "agreed" : "disagreed", answers: lifted, costUsd: r.usage.costUsd, model: r.usage.model, raw: j };
	} catch {
		return { verdict: "unavailable", answers: jev, costUsd: 0, model };
	}
}

export function setDecisionAction(ledger: Ledger, decisionId: number, action: string): void {
	ledger.db.prepare("UPDATE decisions SET action = ? WHERE id = ?").run(action, decisionId);
}
