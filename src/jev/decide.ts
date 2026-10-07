import { createHash } from "node:crypto";
import type { Ledger } from "../ledger/db.ts";
import type { DecisionAnswer, ModelClient } from "../models/types.ts";
import { answerConfidence, type Battery } from "./questions.ts";

export interface Decision {
	answers: Record<string, DecisionAnswer>;
	/** Minimum confidence across the answers the caller declared as primary. */
	confidence: number;
	costUsd: number;
	decisionId: number;
}

/**
 * Runs a battery against a state and records the call in the ledger (for audit + calibration).
 * `primary` names the questions whose confidence gates the action; the rest are speculative.
 */
export async function decide(
	deps: { client: ModelClient; ledger: Ledger; model: string },
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
	const latencyMs = Date.now() - t0;
	const confs = primary.map((q) => (res.answers[q] ? answerConfidence(res.answers[q]!) : 0));
	const confidence = confs.length ? Math.min(...confs) : 0;
	const decisionId = deps.ledger.recordDecision({
		unitId,
		point,
		model: res.usage.model,
		stateHash,
		answers: res.answers,
		confidence,
		costUsd: res.usage.costUsd,
		latencyMs,
	});
	return { answers: res.answers, confidence, costUsd: res.usage.costUsd, decisionId };
}

export function setDecisionAction(ledger: Ledger, decisionId: number, action: string): void {
	ledger.db.prepare("UPDATE decisions SET action = ? WHERE id = ?").run(action, decisionId);
}
