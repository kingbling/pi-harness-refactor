import type { ChatRequest, ChatResponse, DecisionAnswer, DecisionQuestion, DecisionRequest, DecisionResponse, ModelClient } from "./types.ts";

/**
 * Deterministic client for `br simulate --level 1` and unit tests.
 * Outcomes are scripted per decision point / per prompt tag, not recorded transcripts,
 * so prompt wording can change without invalidating fixtures.
 */
export interface FakeScript {
	/** Called for every chat; return text or structured json. Default: echoes a stub. */
	chat?: (req: ChatRequest) => { text?: string; json?: unknown } | undefined;
	/** Scripted decision answers keyed by question id; unspecified questions get neutral answers. */
	decide?: (req: DecisionRequest) => Partial<Record<string, DecisionAnswer | string | number | boolean>> | undefined;
	/** Model ids considered to exist. */
	models?: string[];
}

export class FakeModelClient implements ModelClient {
	calls: Array<{ kind: "chat" | "decide"; req: ChatRequest | DecisionRequest }> = [];
	constructor(private readonly script: FakeScript = {}) {}

	async chat(req: ChatRequest): Promise<ChatResponse> {
		this.calls.push({ kind: "chat", req });
		const r = this.script.chat?.(req);
		const text = r?.text ?? (r?.json ? JSON.stringify(r.json) : "FAKE");
		return { text, json: r?.json, usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.0001, model: req.model, tierServed: req.tier } };
	}

	async decide(req: DecisionRequest): Promise<DecisionResponse> {
		this.calls.push({ kind: "decide", req });
		const scripted = this.script.decide?.(req) ?? {};
		const answers: Record<string, DecisionAnswer> = {};
		for (const [id, q] of Object.entries(req.questions)) answers[id] = coerce(q, scripted[id]);
		return { answers, usage: { inputTokens: 200, outputTokens: 0, costUsd: 0.00001, model: req.model } };
	}

	async resolveModel(id: string) {
		return { exists: (this.script.models ?? ["typesafe/jev-1.13", "openai/gpt-6-luna", "openai/gpt-6.1-sol"]).includes(id) };
	}
}

/** Turn a scripted shorthand (string choice, number score/noul, boolean noul) into a full typed answer. */
function coerce(q: DecisionQuestion, v: DecisionAnswer | string | number | boolean | undefined): DecisionAnswer {
	if (v && typeof v === "object") return v;
	switch (q.type) {
		case "noul": {
			const p = typeof v === "boolean" ? (v ? 0.95 : 0.05) : typeof v === "number" ? v : 0.5;
			return { type: "noul", noul: p };
		}
		case "choice": {
			const keys = Object.keys(q.criteria);
			const choice = typeof v === "string" && keys.includes(v) ? v : keys[0]!;
			const probabilities: Record<string, number> = {};
			for (const k of keys) probabilities[k] = k === choice ? 0.9 : 0.1 / Math.max(1, keys.length - 1);
			return { type: "choice", choice, probabilities, confidence: keys.length > 1 ? (0.9 - 1 / keys.length) / (1 - 1 / keys.length) : 1 };
		}
		case "score": {
			const n = q.criteria.length;
			const idx = typeof v === "number" ? Math.max(0, Math.min(n - 1, Math.round(v))) : Math.floor(n / 2);
			const probabilities: Record<string, number> = {};
			const legend: Record<string, string> = {};
			q.criteria.forEach((c, i) => ((probabilities[String(i)] = i === idx ? 1 : 0), (legend[String(i)] = c)));
			return { type: "score", score: idx, legend, probabilities, confidence: 1 };
		}
	}
}
