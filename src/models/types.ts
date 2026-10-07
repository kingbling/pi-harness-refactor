/** Provider-neutral model client surface. Live (OpenRouter) and Fake implementations share it. */

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface ChatRequest {
	model: string;
	tier?: "default" | "flex" | "priority";
	messages: ChatMessage[];
	/** JSON schema for structured output; the client enforces `response_format` when set. */
	schema?: Record<string, unknown>;
	effort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
	maxTokens?: number;
	signal?: AbortSignal;
}

export interface Usage {
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	/** List price of a call served by a subscription (Codex): not spent, so not in costUsd; shown only. */
	listUsd?: number;
	/** What actually served the call (fallback / tier may differ from the request). */
	model: string;
	tierServed?: string;
}

export interface ChatResponse {
	text: string;
	json?: unknown;
	usage: Usage;
}

// --- decisions (Jev / System One) -----------------------------------------

export type DecisionQuestion =
	| { type: "noul"; instructions: string | object; criteria?: { true?: string; false?: string } }
	| { type: "choice"; instructions: string | object; criteria: Record<string, string | null> }
	| { type: "score"; instructions: string | object; criteria: string[] };

export type DecisionAnswer =
	| { type: "noul"; noul: number }
	| { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
	| { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number };

export interface DecisionRequest {
	model: string;
	state: unknown;
	questions: Record<string, DecisionQuestion>;
	signal?: AbortSignal;
}

export interface DecisionResponse {
	answers: Record<string, DecisionAnswer>;
	usage: Usage;
}

export interface ModelClient {
	chat(req: ChatRequest): Promise<ChatResponse>;
	decide(req: DecisionRequest): Promise<DecisionResponse>;
	/** Resolves a model id against the provider catalog; used by `br smoke`. */
	resolveModel(id: string): Promise<{ exists: boolean; contextLength?: number; pricing?: { prompt: string; completion: string }; note?: string }>;
}
