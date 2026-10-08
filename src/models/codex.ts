import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ChatRequest, ChatResponse } from "./types.ts";

/**
 * Codex first (hardcoded for now): the OpenAI Codex login in Pi serves `openai/<model>` as `<model>` on the
 * openai-codex provider. Sessions and chat calls try it before OpenRouter; any failure falls through to
 * OpenRouter with the role's tier (flex), whose own recovery goes to the default tier.
 * BR_NO_CODEX=1 turns it off.
 */
export const CODEX_PROVIDER = "openai-codex";

let runtime: Promise<ModelRuntime> | undefined;
export function modelRuntime(): Promise<ModelRuntime> {
	runtime ??= ModelRuntime.create();
	return runtime;
}

export function codexModelId(roleId: string): string | undefined {
	return /^openai\/(.+)$/.exec(roleId)?.[1];
}

export async function resolveCodexModel(roleId: string): Promise<Model<Api> | undefined> {
	const id = codexModelId(roleId);
	if (!id || process.env["BR_NO_CODEX"]) return undefined;
	const rt = await modelRuntime();
	if (!rt.hasConfiguredAuth(CODEX_PROVIDER)) return undefined;
	return rt.getModel(CODEX_PROVIDER, id);
}

const EFFORT: Record<string, "minimal" | "low" | "medium" | "high" | "xhigh"> = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh" };

/**
 * One chat call on Codex; undefined = not served (no login, unknown model, error, or no valid JSON when a schema
 * was asked for), so the caller goes on to OpenRouter. Structured output is asked for in the prompt and checked
 * here (parses, has every required top-level key).
 */
type Cost = { input: number; output: number; cacheRead: number; cacheWrite: number };
type Tokens = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };

/** $ for these tokens at a model's per-million prices. */
export function priceAt(cost: Cost | undefined, u: Tokens): number | undefined {
	if (!cost) return undefined;
	return ((u.input ?? 0) * cost.input + (u.output ?? 0) * cost.output + (u.cacheRead ?? 0) * cost.cacheRead + (u.cacheWrite ?? 0) * cost.cacheWrite) / 1e6;
}

/**
 * A subscription call is counted in money like a paid one: what the same model and tokens cost on OpenRouter (so
 * Codex and OpenRouter show the same value). Falls back to the subscription's list price when OpenRouter does not
 * list the model.
 */
export async function openRouterCost(modelId: string): Promise<Cost | undefined> {
	const rt = await modelRuntime().catch(() => undefined);
	const id = modelId.includes("/") ? modelId : `openai/${modelId}`;
	return (rt?.getModel("openrouter", id) as { cost?: Cost } | undefined)?.cost;
}

export async function codexChat(req: ChatRequest): Promise<ChatResponse | undefined> {
	const model = await resolveCodexModel(req.model).catch(() => undefined);
	if (!model) return undefined;
	const rt = await modelRuntime();
	const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
	const schemaNote = req.schema ? `\n\nAnswer with ONE JSON object only (no prose, no code fence) that validates against this JSON schema:\n${JSON.stringify(req.schema)}` : "";
	try {
		const res = await rt.completeSimple(
			model,
			{
				systemPrompt: system + schemaNote,
				messages: req.messages.filter((m) => m.role !== "system").map((m) =>
					m.role === "user"
						? { role: "user" as const, content: m.content, timestamp: Date.now() }
						: ({ role: "assistant", content: [{ type: "text", text: m.content }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } as never),
				),
			},
			{ reasoning: req.effort && req.effort !== "none" ? EFFORT[req.effort] : undefined, signal: req.signal, maxTokens: req.maxTokens },
		);
		if (res.stopReason === "error" || res.stopReason === "aborted") return undefined;
		const text = res.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n").trim();
		let json: unknown;
		if (req.schema) {
			json = parseJsonObject(text);
			const required = (req.schema["required"] as string[] | undefined) ?? [];
			if (!json || typeof json !== "object" || required.some((k) => !(k in (json as object)))) return undefined;
		}
		const costUsd = priceAt(await openRouterCost(req.model), res.usage ?? {}) ?? res.usage?.cost?.total ?? 0;
		return { text, json, usage: { inputTokens: res.usage?.input ?? 0, outputTokens: res.usage?.output ?? 0, costUsd, subscription: true, model: `${CODEX_PROVIDER}/${model.id}`, tierServed: "codex" } };
	} catch {
		return undefined;
	}
}

function parseJsonObject(text: string): unknown {
	const body = text.replace(/^```(?:json)?\s*|\s*```$/g, "");
	try {
		return JSON.parse(body);
	} catch {
		const a = body.indexOf("{");
		const b = body.lastIndexOf("}");
		if (a < 0 || b <= a) return undefined;
		try {
			return JSON.parse(body.slice(a, b + 1));
		} catch {
			return undefined;
		}
	}
}
