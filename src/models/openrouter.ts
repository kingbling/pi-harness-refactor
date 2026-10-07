import { recordSpend } from "../spend.ts";
import { progress } from "../progress.ts";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatRequest, ChatResponse, DecisionRequest, DecisionResponse, ModelClient, Usage } from "./types.ts";

import { codexChat } from "./codex.ts";

const BASE = "https://openrouter.ai/api";
const CHAT_URL = `${BASE}/v1/chat/completions`;
const DECISIONS_URL = `${BASE}/alpha/decisions`;
const MODELS_URL = `${BASE}/v1/models`;

/** Key from env, else Pi's stored auth (~/.pi/agent/auth.json → openrouter). */
export function resolveOpenRouterKey(envName = "OPENROUTER_API_KEY"): string {
	const fromEnv = process.env[envName];
	if (fromEnv) return fromEnv;
	const authPath = join(homedir(), ".pi", "agent", "auth.json");
	if (existsSync(authPath)) {
		try {
			const auth = JSON.parse(readFileSync(authPath, "utf8"));
			const entry = auth.openrouter;
			const key = typeof entry === "string" ? entry : entry?.key ?? entry?.apiKey ?? entry?.access ?? entry?.token;
			if (typeof key === "string" && key) return key;
		} catch {
			/* fall through */
		}
	}
	throw new Error(`No OpenRouter key: set ${envName} or log in to openrouter in Pi (/login).`);
}

export interface OpenRouterOptions {
	apiKey?: string;
	/** Flex capacity 429s before resending on the default tier. */
	flexRetries?: number;
	/** Idle timeout per request (ms). Token-budget timeouts live in the session driver. */
	idleTimeoutMs?: number;
	fetchImpl?: typeof fetch;
	onUsage?: (u: Usage & { kind: "chat" | "decide" }) => void;
	/** Try the Codex login in Pi first for openai/* models (default: on, unless a fetch is injected). */
	codex?: boolean;
}

/** Every direct call counts in the live job totals (paid dollars, Codex list price, tokens). */
const tally = (u: Usage) => progress.callUsage({ costUsd: u.costUsd, codexUsd: u.listUsd ?? 0, tokensIn: u.inputTokens, tokensOut: u.outputTokens });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class OpenRouterClient implements ModelClient {
	private readonly key: string;
	private readonly flexRetries: number;
	private readonly idleTimeoutMs: number;
	private readonly fetchImpl: typeof fetch;
	private readonly onUsage?: OpenRouterOptions["onUsage"];
	private catalog?: Map<string, any>;
	private readonly codex: boolean;

	constructor(opts: OpenRouterOptions = {}) {
		this.key = opts.apiKey ?? resolveOpenRouterKey();
		this.flexRetries = opts.flexRetries ?? 2;
		this.idleTimeoutMs = opts.idleTimeoutMs ?? 10 * 60_000;
		this.fetchImpl = opts.fetchImpl ?? fetch;
		this.onUsage = opts.onUsage;
		this.codex = opts.codex ?? !opts.fetchImpl;
	}

	private headers() {
		return {
			Authorization: `Bearer ${this.key}`,
			"Content-Type": "application/json",
			"HTTP-Referer": "https://github.com/bigrefactor",
			"X-Title": "bigrefactor",
		};
	}

	private async post(url: string, body: unknown, signal?: AbortSignal): Promise<any> {
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(new Error("idle timeout")), this.idleTimeoutMs);
		signal?.addEventListener("abort", () => ctl.abort(signal.reason), { once: true });
		try {
			const res = await this.fetchImpl(url, { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: ctl.signal });
			const text = await res.text();
			let json: any;
			try {
				json = JSON.parse(text);
			} catch {
				json = { raw: text };
			}
			// OpenRouter reports some provider failures as HTTP 200 with an `error` body (e.g. flex capacity: code 502);
			// treat them like the HTTP error they stand for, so tier fallback and retries apply.
			const status = !res.ok ? res.status : json?.error ? Number(json.error.code) || 502 : 0;
			if (status) {
				const err: any = new Error(`OpenRouter ${status}: ${json?.error?.message ?? text.slice(0, 300)}`);
				err.status = status;
				err.body = json;
				throw err;
			}
			return json;
		} finally {
			clearTimeout(timer);
		}
	}

	async chat(req: ChatRequest): Promise<ChatResponse> {
		if (this.codex) {
			const viaCodex = await codexChat(req);
			if (viaCodex) {
				this.onUsage?.({ ...viaCodex.usage, kind: "chat" });
				tally(viaCodex.usage);
				return viaCodex;
			}
		}
		let tier = req.tier ?? "default";
		let flexFails = 0;
		let attempt = 0;
		for (;;) {
			const body: Record<string, unknown> = {
				model: req.model,
				messages: req.messages,
				usage: { include: true },
			};
			if (tier !== "default") body.service_tier = tier;
			if (req.maxTokens) body.max_tokens = req.maxTokens;
			if (req.effort && req.effort !== "none") body.reasoning = { effort: req.effort };
			if (req.schema) body.response_format = { type: "json_schema", json_schema: { name: "out", strict: true, schema: req.schema } };
			try {
				const json = await this.post(CHAT_URL, body, req.signal);
				const text: string = json.choices?.[0]?.message?.content ?? "";
				const usage: Usage = {
					inputTokens: json.usage?.prompt_tokens ?? 0,
					outputTokens: json.usage?.completion_tokens ?? 0,
					costUsd: json.usage?.cost ?? 0,
					model: json.model ?? req.model,
					tierServed: json.service_tier ?? tier,
				};
				this.onUsage?.({ ...usage, kind: "chat" });
				tally(usage);
				recordSpend(usage.costUsd, "api: chat", usage.model);
				let parsed: unknown;
				if (req.schema) {
					try {
						parsed = JSON.parse(text);
					} catch {
						parsed = undefined;
					}
				}
				return { text, json: parsed, usage };
			} catch (e: any) {
				attempt++;
				const status = e?.status as number | undefined;
				const capacity = status === 429 || status === 502 || status === 503 || status === 529;
				if (capacity && tier === "flex") {
					flexFails++;
					if (flexFails > this.flexRetries) {
						tier = "default"; // orchestrator-owned fallback: flex never falls back on its own
						continue;
					}
				}
				// no status = network-level failure (reset, DNS, "fetch failed"): transient, retry like a 5xx
				const network = status === undefined && !req.signal?.aborted && /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|idle timeout/i.test(String(e?.message ?? "") + String(e?.cause?.code ?? ""));
				if ((capacity || network || (status && status >= 500)) && attempt < 6) {
					await sleep(Math.min(30_000, 1000 * 2 ** attempt + Math.random() * 500));
					continue;
				}
				throw e;
			}
		}
	}

	async decide(req: DecisionRequest): Promise<DecisionResponse> {
		let attempt = 0;
		for (;;) {
			try {
				const json = await this.post(DECISIONS_URL, { model: req.model, state: req.state, questions: req.questions }, req.signal);
				const usage: Usage = {
					inputTokens: json.usage?.input_tokens ?? 0,
					outputTokens: json.usage?.output_tokens ?? 0,
					costUsd: json.usage?.cost ?? 0,
					model: json.model ?? req.model,
				};
				this.onUsage?.({ ...usage, kind: "decide" });
				tally(usage);
				recordSpend(usage.costUsd, "api: decide", usage.model);
				return { answers: json.answers, usage };
			} catch (e: any) {
				attempt++;
				const status = e?.status as number | undefined;
				const network = status === undefined && !req.signal?.aborted && /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|idle timeout/i.test(String(e?.message ?? "") + String(e?.cause?.code ?? ""));
				if ((status === 429 || status === 529 || network || (status && status >= 500)) && attempt < 6) {
					await sleep(Math.min(10_000, 500 * 2 ** attempt + Math.random() * 200));
					continue;
				}
				throw e;
			}
		}
	}

	async resolveModel(id: string) {
		if (!this.catalog) {
			const res = await this.fetchImpl(MODELS_URL);
			const json: any = await res.json();
			this.catalog = new Map((json.data as any[]).map((m) => [m.id, m]));
		}
		let m = this.catalog.get(id);
		if (!m) {
			// Decision (System One) models are not in the chat catalog; the per-model endpoints API knows them.
			const res = await this.fetchImpl(`${MODELS_URL}/${id}/endpoints`);
			if (res.ok) {
				const json: any = await res.json();
				const ep = json.data?.endpoints?.[0];
				if (ep) m = { id, context_length: ep.context_length, pricing: ep.pricing, modality: json.data?.architecture?.modality };
			}
		}
		if (!m) {
			const bare = id.replace(/:[a-z]+$/, "");
			const note = this.catalog.has(bare) ? `"${id}" not found but "${bare}" exists — tiers are service_tier, not id suffixes` : undefined;
			return { exists: false, note };
		}
		return { exists: true, contextLength: m.context_length, pricing: { prompt: m.pricing?.prompt, completion: m.pricing?.completion } };
	}
}
