import { describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { isCapacityError, isTransientError, promptWithRecovery, spawnLeaf } from "../src/sessions/spawn.ts";

// A fake Pi session for spawnLeaf: each prompt() plays the next scripted list of assistant messages to the subscriber.
const pi = vi.hoisted(() => ({ turns: [] as Array<Array<Record<string, unknown>>>, models: [] as string[], prompts: [] as string[] }));
vi.mock("@earendil-works/pi-coding-agent", () => ({
	DefaultResourceLoader: class {
		async reload() {}
	},
	getAgentDir: () => "/nonexistent-agent-dir",
	SessionManager: { inMemory: () => ({}) },
	SettingsManager: { create: () => ({ applyOverrides: () => {}, getCompactionKeepRecentTokens: () => 20_000 }) },
	createAgentSession: async () => {
		let listener: ((ev: unknown) => void) | undefined;
		return {
			session: {
				subscribe: (fn: (ev: unknown) => void) => ((listener = fn), () => (listener = undefined)),
				prompt: async (p: string) => {
					pi.prompts.push(p);
					for (const m of pi.turns.shift() ?? []) listener?.({ type: "message_end", message: { role: "assistant", content: [], ...m } });
				},
				setModel: async (m: { provider: string }) => void pi.models.push(m.provider),
				abort() {},
				dispose() {},
			},
		};
	},
}));
// Codex serves the role first (so a provider switch is possible); the role's flex tier makes a tier switch possible
vi.mock("../src/models/codex.ts", () => ({
	CODEX_PROVIDER: "openai-codex",
	modelRuntime: async () => ({ getModel: (provider: string, id: string) => ({ provider, id, samplingParams: {} }) }),
	resolveCodexModel: async (id: string) => ({ provider: "openai-codex", id }),
	openRouterCost: async () => undefined,
	priceAt: () => undefined,
}));

/** Scripted Pi session: each send() ends with the next scripted assistant error (undefined = clean turn). */
function scripted(errors: Array<string | undefined>) {
	const sent: string[] = [];
	const events: any[] = [];
	const slept: number[] = [];
	let pending: string | undefined;
	let tierSwitches = 0;
	return {
		sent,
		events,
		slept,
		tierSwitches: () => tierSwitches,
		opts: {
			send: async (p: string) => {
				sent.push(p);
				pending = errors.shift();
			},
			takeError: () => {
				const e = pending;
				pending = undefined;
				return e;
			},
			toDefaultTier: async () => {
				tierSwitches++;
			},
			record: (e: object) => events.push(e),
			sleep: async (ms: number) => {
				slept.push(ms);
			},
		},
	};
}

describe("session error recovery", () => {
	it("classifies Pi's leftover network errors as transient, not capacity", () => {
		for (const m of ["terminated", "Connection error.", "Request timed out.", "read ECONNRESET", "socket hang up"]) {
			expect(isTransientError(m)).toBe(true);
			expect(isCapacityError(m)).toBe(false);
		}
		expect(isTransientError("Flex processing is temporarily unavailable. Please try again later or use standard processing.")).toBe(false);
		expect(isTransientError("Invalid API key")).toBe(false);
	});

	it("Codex first: a usage limit moves the same prompt to OpenRouter flex, then its capacity error to the default tier", async () => {
		const s = scripted(["You have hit your ChatGPT usage limit (plus plan). Try again later.", "Flex processing is temporarily unavailable.", undefined]);
		let providerSwitches = 0;
		const err = await promptWithRecovery({ prompt: "TASK", ...s.opts, toFallbackProvider: async () => void providerSwitches++ });
		expect(err).toBeUndefined();
		expect(providerSwitches).toBe(1);
		expect(s.tierSwitches()).toBe(1);
		expect(s.sent).toEqual(["TASK", "TASK", "TASK"]);
		expect(s.events.map((e) => e.type)).toEqual(["provider_fallback", "tier_fallback"]);
	});

	it("a network drop on Codex is retried there, not moved to OpenRouter", async () => {
		const s = scripted(["terminated", undefined]);
		let providerSwitches = 0;
		expect(await promptWithRecovery({ prompt: "TASK", ...s.opts, toFallbackProvider: async () => void providerSwitches++ })).toBeUndefined();
		expect(providerSwitches).toBe(0);
	});

	it("a hung Codex request (no answer for idleMs, cut) goes on in the same session on OpenRouter, without sending the task twice", async () => {
		const s = scripted(["model_hang: no model activity for 300s, the request was cut", "model_hang: no model activity for 300s, the request was cut", undefined]);
		let providerSwitches = 0;
		expect(isTransientError("model_hang: no model activity for 300s, the request was cut")).toBe(true);
		expect(await promptWithRecovery({ prompt: "TASK", ...s.opts, toFallbackProvider: async () => void providerSwitches++ })).toBeUndefined();
		expect(providerSwitches).toBe(1);
		expect(s.sent).toEqual(["TASK", expect.stringMatching(/^Your previous response was cut off/), expect.stringMatching(/^Your previous response was cut off/)]);
		expect(s.tierSwitches()).toBe(0);
	});

	it("continues the same session after a drop, with backoff, without a tier fallback", async () => {
		const s = scripted(["terminated", "Connection error.", undefined]);
		const err = await promptWithRecovery({ prompt: "TASK", ...s.opts });
		expect(err).toBeUndefined();
		expect(s.sent[0]).toBe("TASK");
		expect(s.sent.slice(1).every((p) => /cut off by a network error/.test(p))).toBe(true);
		expect(s.slept).toEqual([15_000, 60_000]);
		expect(s.tierSwitches()).toBe(0);
		expect(s.events.map((e) => e.type)).toEqual(["transient_retry", "transient_retry"]);
	});

	it("gives up after the cap and returns the error for the orchestrator", async () => {
		const s = scripted(["Request timed out.", "Request timed out.", "Request timed out."]);
		expect(await promptWithRecovery({ prompt: "TASK", ...s.opts })).toBe("Request timed out.");
		expect(s.sent).toHaveLength(3);
	});

	it("falls back to the standard tier once on flex capacity, then handles a drop there too", async () => {
		const s = scripted(["Flex processing is temporarily unavailable. Please try again later or use standard processing.", "socket hang up", undefined]);
		expect(await promptWithRecovery({ prompt: "TASK", ...s.opts })).toBeUndefined();
		expect(s.tierSwitches()).toBe(1);
		expect(s.sent[1]).toBe("TASK");
		expect(s.events.map((e) => e.type)).toEqual(["tier_fallback", "transient_retry"]);
	});

	it("does not retry non-transient errors or while the user is stopping", async () => {
		const a = scripted(["Invalid API key"]);
		expect(await promptWithRecovery({ prompt: "TASK", ...a.opts })).toBe("Invalid API key");
		expect(a.sent).toHaveLength(1);
		const b = scripted(["terminated"]);
		expect(await promptWithRecovery({ prompt: "TASK", ...b.opts, aborting: () => true })).toBe("terminated");
		expect(b.sent).toHaveLength(1);
	});

	it("a user stop on Codex never moves the prompt to OpenRouter or the default tier", async () => {
		const s = scripted(["Request was aborted"]);
		let providerSwitches = 0;
		expect(await promptWithRecovery({ prompt: "TASK", ...s.opts, toFallbackProvider: async () => void providerSwitches++, aborting: () => true })).toBe("Request was aborted");
		expect(providerSwitches).toBe(0);
		expect(s.tierSwitches()).toBe(0);
		expect(s.sent).toEqual(["TASK"]);
	});
});

describe("spawnLeaf: only the last assistant message's error counts", () => {
	const config = ConfigSchema.parse({ source: { path: "/nonexistent-legacy", stack: "php" }, target: { path: "/nonexistent-new", stacks: ["nestjs"] }, models: {} });
	const run = async (turns: Array<Array<Record<string, unknown>>>) => {
		pi.turns = turns;
		pi.models = [];
		pi.prompts = [];
		const off = process.env["BR_NO_LLM"];
		delete process.env["BR_NO_LLM"];
		try {
			const s = await spawnLeaf({ role: "implement", cwd: "/nonexistent-cwd", config, writeGlobs: [], systemPrompt: "x" });
			try {
				return await s.run("TASK");
			} finally {
				s.dispose();
			}
		} finally {
			if (off !== undefined) process.env["BR_NO_LLM"] = off;
		}
	};
	const rateLimited = { stopReason: "error", errorMessage: "429 Too Many Requests: rate limit exceeded" };
	const done = { stopReason: "stop", content: [{ type: "text", text: "done" }] };

	it("a 429 that Pi's own retry gets past (a later good message) switches no provider and no tier", async () => {
		const r = await run([[rateLimited, done]]);
		expect(r.error).toBeUndefined();
		expect(r.text).toBe("done");
		expect(pi.models).toEqual([]);
		expect(pi.prompts).toEqual(["TASK"]);
	});

	it("a 429 that stays the last message still moves to the fallback provider", async () => {
		const r = await run([[done, rateLimited], [done]]);
		expect(r.error).toBeUndefined();
		expect(pi.models).toEqual(["openrouter"]);
		expect(pi.prompts).toEqual(["TASK", "TASK"]);
	});
});
