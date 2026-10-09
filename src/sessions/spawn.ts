import { findSourceAdapter } from "../adapters/registry.ts";
import { CODEX_PROVIDER, modelRuntime, openRouterCost, priceAt, resolveCodexModel } from "../models/codex.ts";
import { recordSpend } from "../spend.ts";
import { describeArgs, progress } from "../progress.ts";
import { mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { Config, ModelRole } from "../config.ts";

/**
 * Leaf agent sessions (tester, implementer, setup) run in-process on the Pi SDK, one per unit.
 * Isolation is enforced by code, not prompt:
 *  - tool allowlist per role (implementer: no bash, no test/build);
 *  - a `tool_call` gate blocks every write outside the unit's allowed globs, anything under the
 *    source repo (read-only, always), protected paths, and content that does not parse;
 *  - model per role from config, service tier via samplingParams (`:flex` is not a model id).
 */
export type Role = "implement" | "test" | "escalate" | "setup" | "review";

export interface SpawnOptions {
	role: Role;
	cwd: string; // worktree or target project dir
	/** The folder writeGlobs and protectedGlobs are relative to, when it is not cwd (a tester works in the project, its globs start at the workspace). */
	globRoot?: string;
	config: Config;
	/** Globs (relative to globRoot, else cwd) the session may write to. Empty = read-only session. */
	writeGlobs: string[];
	/** Globs never writable even when inside writeGlobs (tests, configs, generated files). */
	protectedGlobs?: string[];
	/** Globs where NEW files may be created but existing ones never edited (shared helpers used by other units). */
	appendOnlyGlobs?: string[];
	systemPrompt: string;
	customTools?: ToolDefinition[];
	/** Extra allowed built-in tools beyond the role default. */
	tools?: string[];
	modelOverride?: ModelRole;
	onToolCall?: (e: { toolName: string; blocked?: string }) => void;
	/** Validate content before a write/edit lands (syntax check). Return a reason to block. */
	validateWrite?: (path: string, content: string) => Promise<string | undefined>;
	/** JSONL transcript path: every session event is appended (checkpoint, replay, `br why`). */
	transcriptPath?: string;
	/** Terminate the session after this many blocked tool calls (runaway control). Default 5. */
	maxBlocked?: number;
}

const WRITE_VERBS = /(^|[\s;&|(])(rm|mv|cp|tee|sed\s+-i|truncate|chmod|chown|ln|mkdir|touch|git\s+(add|commit|checkout|reset|clean|push|rm|mv|stash|rebase|merge|apply))\b|>{1,2}\s*\S/;

/**
 * Bash guard for roles that may run commands (tester, setup): the legacy source repo is read-only for
 * everyone, by code. A command is blocked when it mentions the source root (or a path inside it) together
 * with a write verb or output redirection. `cd <source> && php cases.php` stays allowed.
 */
/** `mutating`: the source language's own commands that change a checkout (package managers; SourceTraits.mutatingCommands). */
export function bashTouchesReadOnly(command: string, sourceRoot: string, cwd: string, mutating?: RegExp): string | undefined {
	const src = resolve(sourceRoot);
	const relSrc = relative(cwd, src);
	const mentions = command.includes(src) || (relSrc && !relSrc.startsWith("..") && command.includes(relSrc)) || /\.\.\/legacy|\blegacy\//.test(command) && relSrc.includes("legacy");
	// Redirects to /dev/null or between fds (2>/dev/null, 2>&1) write nothing; neither does a redirect whose
	// target lies outside the source repo. Only the remaining write verbs and source-bound redirects count.
	const harmless = command.replace(/\d*>{1,2}\s*(\/dev\/null|&\d)/g, " ").replace(/\d*>{1,2}\s*([^\s;&|]+)/g, (m, target: string) => (resolve(cwd, target).startsWith(src) ? m : " "));
	if (mentions && (WRITE_VERBS.test(harmless) || mutating?.test(harmless))) return "the legacy source repo is read-only: no writes, moves, deletes, redirects or git operations there";
	if (/\bgit\s+(commit|push|rebase|merge|reset|checkout|clean|stash)\b/.test(command)) return "git is driven by the orchestrator (commits per accepted unit); do not run git mutations";
	return undefined;
}

const ROLE_TOOLS: Record<Role, string[]> = {
	implement: ["read", "edit", "write", "grep", "find", "ls"], // never bash
	test: ["read", "write", "edit", "grep", "find", "ls", "bash"], // runs the old test runner
	escalate: ["read", "edit", "write", "grep", "find", "ls"],
	setup: ["read", "edit", "write", "grep", "find", "ls", "bash"],
	review: ["read", "grep", "find", "ls"], // judges, never writes
};

export { modelRuntime };

/** The first model a session runs on: Codex when it serves the role's model, else OpenRouter. */
export async function resolveSessionModel(role: ModelRole): Promise<Model<Api>> {
	return (await resolveCodexModel(role.id)) ?? resolveRoleModel(role);
}

/** OpenRouter model with the configured service tier baked in as a default sampling param. */
export async function resolveRoleModel(role: ModelRole): Promise<Model<Api>> {
	const rt = await modelRuntime();
	const base = rt.getModel("openrouter", role.id);
	if (!base) throw new Error(`model openrouter/${role.id} is not known to Pi (check ~/.pi/agent/models.json or run \`br smoke\`)`);
	const sampling = { ...(base.samplingParams ?? {}) } as Record<string, unknown>;
	if (role.tier !== "default") sampling["service_tier"] = role.tier;
	return { ...base, samplingParams: sampling } as Model<Api>;
}

/** Pi's thinking level is the single knob for reasoning effort (it maps to the provider's reasoning param). */
export function thinkingLevelOf(effort?: string): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" {
	switch (effort) {
		case "none": return "off";
		case "low": return "low";
		case "high": return "high";
		case "xhigh": case "max": return "xhigh";
		default: return "medium";
	}
}

export function isCapacityError(msg: string): boolean {
	return /flex processing is temporarily unavailable|service tier.*unavailable|\b429\b|rate limit|capacity|overloaded/i.test(msg);
}

/** Network drops that outlived Pi's own quick retries: continue the same session later, never a triage round or a tier change. */
export function isTransientError(msg: string): boolean {
	return !isCapacityError(msg) && /\bterminated\b|connection error|request timed out|timed out|ECONNRESET|socket hang up|fetch failed|other side closed/i.test(msg);
}

/** Orchestrator-level recovery after a prompt: capacity → standard tier once; transient → continue the same session (cap, backoff). */
export async function promptWithRecovery(o: {
	prompt: string;
	send: (prompt: string) => Promise<void>;
	takeError: () => string | undefined;
	toDefaultTier?: () => Promise<void>;
	/** Switch from the first provider (Codex) to the fallback one (OpenRouter); undefined when already there. */
	toFallbackProvider?: () => Promise<void>;
	tier?: string;
	record: (e: object) => void;
	sleep?: (ms: number) => Promise<void>;
	transientRetries?: number;
	backoffMs?: number[];
	aborting?: () => boolean;
}): Promise<string | undefined> {
	const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const backoff = o.backoffMs ?? [15_000, 60_000];
	await o.send(o.prompt);
	let error = o.takeError();
	// Codex failed for any reason but a network drop (usage limit, auth, capacity, model missing): OpenRouter takes
	// over in the same session, same prompt — with its own tier recovery below.
	if (error && o.toFallbackProvider && !isTransientError(error)) {
		o.record({ type: "provider_fallback", from: "openai-codex", to: "openrouter", error });
		await o.toFallbackProvider();
		await o.send(o.prompt);
		error = o.takeError();
	}
	// Flex capacity errors surface as an assistant error message, not an exception. The provider never
	// falls back on its own, so the orchestrator does: same session, same prompt, standard tier, once.
	if (error && o.toDefaultTier && isCapacityError(error)) {
		o.record({ type: "tier_fallback", from: o.tier ?? "flex", to: "default", error });
		await o.toDefaultTier();
		await o.send(o.prompt);
		error = o.takeError();
	}
	for (let i = 0; error && isTransientError(error) && i < (o.transientRetries ?? 2) && !o.aborting?.(); i++) {
		const ms = backoff[Math.min(i, backoff.length - 1)]!;
		o.record({ type: "transient_retry", attempt: i + 1, delayMs: ms, error });
		await sleep(ms);
		await o.send(CONTINUE_AFTER_DROP);
		error = o.takeError();
	}
	return error;
}

const CONTINUE_AFTER_DROP = "Your previous response was cut off by a network error. Continue exactly where you left off; do not redo finished tool calls.";

export function globToRegExp(glob: string): RegExp {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i]!;
		if (c === "*") {
			if (glob[i + 1] === "*") {
				i++;
				if (glob[i + 1] === "/") {
					i++;
					out += "(?:.*/)?"; // `**/` matches zero or more directories
				} else out += ".*";
			} else out += "[^/]*";
		} else if (c === "?") out += "[^/]";
		else out += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
	}
	return new RegExp(`^${out}$`);
}

export function makeWriteGate(opts: { cwd: string; globRoot?: string; sourceRoot: string; writeGlobs: string[]; protectedGlobs: string[]; appendOnlyGlobs?: string[] }) {
	const allow = opts.writeGlobs.map(globToRegExp);
	const deny = opts.protectedGlobs.map(globToRegExp);
	const appendOnly = (opts.appendOnlyGlobs ?? []).map(globToRegExp);
	const src = resolve(opts.sourceRoot);
	return (absOrRel: string): string | undefined => {
		const abs = resolve(opts.cwd, absOrRel);
		if (abs === src || abs.startsWith(src + sep)) return "the legacy source repo is read-only";
		const rel = relative(opts.globRoot ?? opts.cwd, abs).split(sep).join("/");
		if (rel.startsWith("..")) return "outside the working directory";
		if (deny.some((r) => r.test(rel))) return `protected path: ${rel}`;
		if (allow.some((r) => r.test(rel))) return undefined;
		if (appendOnly.some((r) => r.test(rel))) return existsSync(abs) ? `shared file exists and may be used by other units; add a new file instead of editing ${rel}` : undefined;
		return `outside this unit's scope: ${rel}`;
	};
}

/**
 * What a blocked session is told: why, where it may write instead (this session's own globs, as absolute paths),
 * and how to report what it cannot do — only with tools this session really has.
 */
export function blockedHint(reason: string, opts: Pick<SpawnOptions, "cwd" | "globRoot" | "writeGlobs" | "appendOnlyGlobs" | "customTools">): string {
	const abs = (g: string) => resolve(opts.globRoot ?? opts.cwd, g).split(sep).join("/");
	const where = opts.writeGlobs.length ? `You may write only: ${opts.writeGlobs.map(abs).join(", ")}${opts.appendOnlyGlobs?.length ? `; new files (never edits) in: ${opts.appendOnlyGlobs.map(abs).join(", ")}` : ""}.` : "This session may not write files.";
	const report = opts.customTools?.some((t) => t.name === "ledger_prove") ? `record anything you cannot do via ledger_prove(op="dropped", why=...) or in your final message` : "say in your final message what you could not do and why";
	return `${reason}. ${where} Otherwise ${report}.`;
}

export interface LeafSession {
	run(prompt: string): Promise<{ text: string; toolCalls: number; blocked: number; usage: { input: number; output: number; cost: number }; error?: string }>;
	dispose(): void;
}

export async function spawnLeaf(opts: SpawnOptions): Promise<LeafSession> {
	// tests and offline runs never start a real model session; callers fall back or inject their own `spawn`
	if (process.env["BR_NO_LLM"]) throw new Error("model sessions are off (BR_NO_LLM)");
	const role = opts.modelOverride ?? opts.config.models[opts.role === "setup" || opts.role === "review" ? "escalate" : opts.role];
	const model = await resolveSessionModel(role);
	const orCost = await openRouterCost(role.id);
	const gate = makeWriteGate({ cwd: opts.cwd, globRoot: opts.globRoot, sourceRoot: opts.config.source.path, writeGlobs: opts.writeGlobs, protectedGlobs: opts.protectedGlobs ?? [], appendOnlyGlobs: opts.appendOnlyGlobs });
	let toolCalls = 0;
	let blocked = 0;
	// one agent per session in the live panel: label = unit (from the transcript name "<unit>.<role>.<attempt>.jsonl")
	const agentLabel = opts.transcriptPath ? basename(opts.transcriptPath).split(".")[0]! : opts.role;
	const roleName = opts.transcriptPath ? (basename(opts.transcriptPath).split(".")[1] ?? opts.role) : opts.role;
	const agentId = progress.agentStart(agentLabel, roleName, `${model.provider}/${model.id}`);

	const guard = (pi: ExtensionAPI) => {
		pi.on("tool_call", async (event) => {
			toolCalls++;
			const input = event.input as Record<string, unknown>;
			let reason: string | undefined;
			if (event.toolName === "write" || event.toolName === "edit") {
				const path = String(input["path"] ?? "");
				reason = gate(path);
				if (!reason && event.toolName === "write" && opts.validateWrite) reason = await opts.validateWrite(path, String(input["content"] ?? ""));
			} else if (event.toolName === "bash") {
				reason = ROLE_TOOLS[opts.role].includes("bash") ? bashTouchesReadOnly(String(input["command"] ?? ""), opts.config.source.path, opts.cwd, findSourceAdapter(opts.config.source.stack)?.traits?.mutatingCommands) : "bash is not available to this role";
			}
			if (progress.aborting) return { block: true, terminate: true, reason: "stopped by the user" };
			if (reason) {
				blocked++;
				opts.onToolCall?.({ toolName: event.toolName, blocked: reason });
				progress.agentTool(agentId, event.toolName, describeArgs(input), reason);
				if (blocked >= (opts.maxBlocked ?? 5)) return { block: true, terminate: true, reason: `${reason}. Too many blocked tool calls (${blocked}); the session is terminated and the orchestrator will retry with the gate report.` };
				return { block: true, reason: blockedHint(reason, opts) };
			}
			opts.onToolCall?.({ toolName: event.toolName });
			progress.agentTool(agentId, event.toolName, describeArgs(input));
			return undefined;
		});
		// Post-write syntax check for edits too (write is validated before it lands; edit cannot be, so check the result on disk).
		pi.on("tool_result", async (event) => {
			// a failed edit is a tool slip, not a reason to give up: say how to get it through
			if (event.toolName === "edit" && event.isError) {
				const text = (event.content ?? []).map((c) => ("text" in c ? c.text : "")).join("\n");
				return { content: [{ type: "text", text: `${text}\nTo get the edit through: read the file again and quote the exact text with enough surrounding lines to be unique, or write the whole file with write.` }], isError: true, details: (event as any).result?.details ?? {} };
			}
			if (event.toolName !== "edit" || event.isError || !opts.validateWrite) return undefined;
			const path = String((event.input as Record<string, unknown>)["path"] ?? "");
			try {
				const abs = resolve(opts.cwd, path);
				const problem = await opts.validateWrite(abs, readFileSync(abs, "utf8"));
				if (problem) return { content: [{ type: "text", text: `Edit applied but the file no longer parses: ${problem}. Fix it before you finish.` }], isError: true, details: (event as any).result?.details ?? {} };
			} catch {
				/* unreadable → nothing to add */
			}
			return undefined;
		});
	};

	const resourceLoader = new DefaultResourceLoader({
		cwd: opts.cwd,
		agentDir: getAgentDir(),
		extensionFactories: [guard],
		// Leaf sessions get exactly our prompt; no user-level AGENTS.md/skills leaking in.
		systemPromptOverride: () => opts.systemPrompt,
		agentsFilesOverride: () => ({ agentsFiles: [] }),
		skillsOverride: () => ({ skills: [], diagnostics: [] }),
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: opts.cwd,
		model,
		thinkingLevel: thinkingLevelOf(role.effort),
		modelRuntime: await modelRuntime(),
		tools: [...ROLE_TOOLS[opts.role], ...(opts.tools ?? []), ...(opts.customTools?.map((t) => t.name) ?? [])],
		customTools: opts.customTools,
		resourceLoader,
		sessionManager: SessionManager.inMemory(),
	});

	if (opts.transcriptPath) mkdirSync(dirname(opts.transcriptPath), { recursive: true });
	const transcript = opts.transcriptPath ? createWriteStream(opts.transcriptPath, { flags: "a" }) : undefined;
	const record = (e: unknown) => transcript?.write(JSON.stringify({ t: Date.now(), ...(e as object) }) + "\n");
	record({ type: "session_spawned", role: opts.role, model: `${model.provider}/${model.id}`, tier: role.tier, cwd: opts.cwd, writeGlobs: opts.writeGlobs });

	return {
		async run(prompt) {
			let text = "";
			let error: string | undefined;
			const usage = { input: 0, output: 0, cost: 0 };
			const unsub = session.subscribe((ev: any) => {
				if (ev.type === "message_end" && ev.message?.role === "assistant") {
					const m = ev.message;
					text = (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
					if (m.usage) {
						usage.input += m.usage.input ?? 0;
						usage.output += m.usage.output ?? 0;
						// a Codex (subscription) call counts what the same call costs on OpenRouter: one money value for both
						const codex = m.provider === CODEX_PROVIDER;
						const usd = (codex ? priceAt(orCost, m.usage) : undefined) ?? m.usage.cost?.total ?? 0;
						usage.cost += usd;
						progress.agentUsage(agentId, { costUsd: usd, tokensIn: m.usage.input ?? 0, tokensOut: m.usage.output ?? 0 });
						recordSpend(usd, `session: ${roleName} ${agentLabel}`, `${m.provider ?? "openrouter"}/${m.model ?? role.id}`, { subscription: codex });
					}
					if (m.stopReason === "error" || m.errorMessage) error = m.errorMessage ?? "assistant message ended with error";
					record({ type: "assistant", text, stopReason: m.stopReason, error: m.errorMessage, usage: m.usage, toolCalls: (m.content ?? []).filter((c: any) => c.type === "toolCall").map((c: any) => ({ name: c.name, args: c.arguments })) });
				} else if (ev.type === "tool_execution_end") {
					record({ type: "tool_result", toolCallId: ev.toolCallId, name: ev.toolName, isError: ev.isError, text: ev.result?.content?.map((c: any) => c.text).join("\n").slice(0, 2000) });
				} else if (ev.type === "tool_execution_start") {
					record({ type: "tool_execution_start", toolCallId: ev.toolCallId, name: ev.toolName, args: ev.args });
				} else if (ev.type === "agent_end" || ev.type === "turn_end") record({ type: ev.type });
			});
			record({ type: "prompt", chars: prompt.length });
			const handle = { abort: () => session.abort() };
			progress.agentAbortable(agentId, handle);
			try {
				error = await promptWithRecovery({
					prompt,
					send: (p) => session.prompt(p),
					takeError: () => {
						const e = error;
						error = undefined;
						return e;
					},
					toFallbackProvider: model.provider === CODEX_PROVIDER ? async () => session.setModel(await resolveRoleModel(role)) : undefined,
					toDefaultTier: role.tier !== "default" ? async () => session.setModel(await resolveRoleModel({ ...role, tier: "default" })) : undefined,
					tier: role.tier,
					record,
					aborting: () => progress.aborting,
				});
			} catch (e: any) {
				error = e?.message ?? String(e);
				record({ type: "prompt_error", error });
			} finally {
				unsub();
				progress.agentEnd(agentId);
			}
			if (progress.aborting && !error) error = "stopped by the user";
			record({ type: "run_end", toolCalls, blocked, usage, error });
			return { text, toolCalls, blocked, usage, error };
		},
		dispose: () => {
			progress.agentEnd(agentId); // never ran, or ran and ended: either way gone from the panel
			session.dispose();
			transcript?.end();
		},
	};
}
