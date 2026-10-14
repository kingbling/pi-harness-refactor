import { findSourceAdapter } from "../adapters/registry.ts";
import { CODEX_PROVIDER, modelRuntime, openRouterCost, priceAt, resolveCodexModel } from "../models/codex.ts";
import { recordSpend } from "../spend.ts";
import { describeArgs, progress } from "../progress.ts";
import { mkdirSync, lstatSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { Type, type TSchema } from "typebox";
import { basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
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
	/** A protected path the globs cannot say (config, but not the tests and wiring files a job may write). */
	isProtected?: (rel: string) => boolean;
	/**
	 * Run after each bash command: a write through the shell is not seen by the write gate. A returned note is added
	 * to the command's output (what was put back and why).
	 */
	afterBash?: () => Promise<string | undefined>;
	/** Globs where NEW files may be created but existing ones never edited (shared helpers used by other units). */
	appendOnlyGlobs?: string[];
	systemPrompt: string;
	customTools?: ToolDefinition[];
	/** Extra allowed built-in tools beyond the role default. */
	tools?: string[];
	modelOverride?: ModelRole;
	onToolCall?: (e: { toolName: string; blocked?: string }) => void;
	/** Validate content before a write/edit lands (syntax check). `before` is the file as it was (undefined for a new file), so only problems the change added count. Return a reason to block. */
	validateWrite?: (path: string, content: string, before?: string) => Promise<string | undefined>;
	/** JSONL transcript path: every session event is appended (checkpoint, replay, `br why`). */
	transcriptPath?: string;
	/** Terminate the session after this many blocked tool calls (runaway control). Default 5. */
	maxBlocked?: number;
}

/** A file's text, or undefined when it does not exist yet (or cannot be read). */
function fileText(abs: string): string | undefined {
	try {
		return readFileSync(abs, "utf8");
	} catch {
		return undefined;
	}
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

/** A bash result with the session's afterBash note added (what was put back after the command), or undefined: unchanged. */
export async function afterBashResult(event: { content?: Array<{ type: string; text?: string }>; isError?: boolean; result?: { details?: unknown } }, afterBash: () => Promise<string | undefined>): Promise<{ content: any[]; isError?: boolean; details: any } | undefined> {
	const note = await afterBash().catch(() => undefined);
	if (!note) return undefined;
	return { content: [...(event.content ?? []), { type: "text", text: note }], isError: event.isError, details: event.result?.details ?? {} };
}

const DELETES = /^(rm|rmdir|unlink|mv)$/;

/**
 * Deletes and moves stay inside the session's own folder: a shell slip like `rm -rf ../../*` from a worktree would
 * wipe the other lanes, the ledger and every transcript. A path counts as inside when it is under cwd, under the
 * temp dir, or somewhere `mayWrite` allows (the session's own write globs, e.g. the tester's truth folder).
 */
export function bashDeletesOutside(command: string, cwd: string, mayWrite: (abs: string) => boolean = () => false): string | undefined {
	const home = process.env["HOME"] ?? "~";
	const inside = (arg: string) => {
		if (/\$(?!HOME\b|\{HOME\})/.test(arg)) return false; // a variable code cannot resolve: not provably inside
		const p = arg.replace(/^["']|["']$/g, "").replace(/^~(?=\/|$)/, home).replace(/\$\{?HOME\}?/g, home);
		const abs = resolve(cwd, p);
		return abs === resolve(cwd) || [resolve(cwd), resolve(tmpdir()), "/tmp", "/private/tmp"].some((r) => abs.startsWith(r + sep)) || mayWrite(abs);
	};
	for (const seg of command.split(/&&|\|\||[;|\n]/)) {
		const words = seg.trim().split(/\s+/).filter(Boolean);
		while (words[0] && /^(sudo|command|xargs|\w+=\S*)$/.test(words[0])) words.shift();
		const verb = words[0] ?? "";
		let paths: string[] = [];
		if (DELETES.test(verb)) paths = words.slice(1).filter((w) => !w.startsWith("-"));
		else if (verb === "find" && words.some((w) => w === "-delete" || w === "rm")) {
			const firstFlag = words.findIndex((w, i) => i > 0 && w.startsWith("-"));
			paths = words.slice(1, firstFlag < 0 ? undefined : firstFlag); // the folders find starts in
		}
		const outside = paths.find((p) => !inside(p));
		if (outside !== undefined) return `only files inside your working directory (${cwd}) may be deleted or moved; "${outside}" is not`;
	}
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
	// the user stopped it: no other provider or tier, never the prompt again
	if (o.aborting?.()) return error;
	// Codex failed for any reason but a network drop (usage limit, auth, capacity, model missing): OpenRouter takes
	// over in the same session, same prompt — with its own tier recovery below.
	if (error && o.toFallbackProvider && !isTransientError(error)) {
		o.record({ type: "provider_fallback", from: "openai-codex", to: "openrouter", error });
		await o.toFallbackProvider();
		await o.send(o.prompt);
		error = o.takeError();
		if (o.aborting?.()) return error;
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

export function makeWriteGate(opts: { cwd: string; globRoot?: string; sourceRoot: string; writeGlobs: string[]; protectedGlobs: string[]; isProtected?: (rel: string) => boolean; appendOnlyGlobs?: string[] }) {
	const allow = opts.writeGlobs.map(globToRegExp);
	const deny = opts.protectedGlobs.map(globToRegExp);
	const named = new Set(opts.writeGlobs.filter((g) => !/[*?[{]/.test(g)));
	const appendOnly = (opts.appendOnlyGlobs ?? []).map(globToRegExp);
	const src = resolve(opts.sourceRoot);
	return (absOrRel: string): string | undefined => {
		const abs = resolve(opts.cwd, absOrRel);
		if (abs === src || abs.startsWith(src + sep)) return "the legacy source repo is read-only";
		const rel = relative(opts.globRoot ?? opts.cwd, abs).split(sep).join("/");
		if (rel.startsWith("..")) return "outside the working directory";
		// a file the session is given by name (a stack's wiring file) beats a broad protected glob (config/**)
		if ((deny.some((r) => r.test(rel)) || opts.isProtected?.(rel)) && !named.has(rel)) return `protected path: ${rel}`;
		if (allow.some((r) => r.test(rel))) return undefined;
		if (appendOnly.some((r) => r.test(rel))) return existsSync(abs) ? `shared file exists and may be used by other units; add a new file instead of editing ${rel}` : undefined;
		return `outside this unit's scope: ${rel}`;
	};
}

/** File-only mutations use the same scope as writes, and reject symlink traversal and directory removal. */
export function scopedFileTools(opts: Pick<SpawnOptions, "cwd" | "globRoot" | "writeGlobs" | "protectedGlobs" | "isProtected" | "appendOnlyGlobs"> & { sourceRoot: string }): ToolDefinition[] {
	const gate = makeWriteGate({ ...opts, protectedGlobs: opts.protectedGlobs ?? [] });
	// Built on first use: the session's folder may not exist yet when its tools are made.
	let physicalGate: ReturnType<typeof makeWriteGate> | undefined;
	const physical = () => (physicalGate ??= makeWriteGate({ ...opts, cwd: realpathSync(opts.cwd), globRoot: opts.globRoot ? realpathSync(opts.globRoot) : undefined, sourceRoot: existsSync(opts.sourceRoot) ? realpathSync(opts.sourceRoot) : opts.sourceRoot, protectedGlobs: opts.protectedGlobs ?? [] }));
	const checked = (path: string, existing: boolean): string => {
		if (!path.trim()) throw new Error("a file path is required");
		const abs = resolve(opts.cwd, path);
		const reason = gate(abs);
		if (reason) throw new Error(reason);
		// Check the real parent too: a writable-looking path must not escape through a symlink.
		const parent = realpathSync(dirname(abs));
		const realPath = resolve(parent, basename(abs));
		const physicalReason = physical()(realPath);
		if (physicalReason) throw new Error(physicalReason);
		if (existing) {
			if (!lstatSync(abs).isFile()) throw new Error("only regular files may be removed or renamed");
		} else {
			try {
				lstatSync(abs);
			} catch (e: any) {
				if (e.code === "ENOENT") return abs;
				throw e;
			}
			throw new Error("rename destination already exists; remove the obsolete source instead of overwriting it");
		}
		return abs;
	};
	const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
	const define = <T extends TSchema>(tool: ToolDefinition<T>): ToolDefinition => tool as unknown as ToolDefinition;
	return [
		define({
			name: "remove_file", label: "Remove file",
			description: "Delete an obsolete regular file inside your write scope. No directories, protected tests, existing shared files or legacy files. Deletions are kept in the change and checked for scope; do not leave compatibility shims with rejected filenames.",
			parameters: Type.Object({ path: Type.String() }),
			execute: async (_id, p) => {
				unlinkSync(checked(p.path, true));
				return result(`Removed ${p.path}`);
			},
		}),
		define({
			name: "rename_file", label: "Rename file",
			description: "Move a regular file within your write scope to a new filename. Both paths are checked; the destination must not exist. Update imports afterwards. If the replacement already exists, use remove_file on the obsolete file, not a compatibility shim.",
			parameters: Type.Object({ path: Type.String(), destination: Type.String() }),
			execute: async (_id, p) => {
				const source = checked(p.path, true);
				const destination = checked(p.destination, false);
				renameSync(source, destination);
				return result(`Renamed ${p.path} to ${p.destination}`);
			},
		}),
	];
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

/** Pi compacts when the context passes the window minus this reserve: the reserve that makes it compact at `share` of the window. */
export function compactionReserve(contextWindow: number, share: number): number {
	return Math.max(16_384, Math.round(contextWindow * (1 - share)));
}

/**
 * Runaway control inside one model session: fresh tokens (input + output, cache reads excluded) over `maxTokens`, or
 * no model or tool activity for `idleMs`, stops it once (`onStop` with the reason). What it wrote still goes to the gate.
 * A running tool is activity: a check waiting for a gate slot or a long test run is not an idle session.
 */
export function sessionLimits(o: { maxTokens: number; idleMs: number; onStop: (why: string) => void }) {
	let stopped: string | undefined;
	const stop = (why: string) => {
		if (stopped) return;
		stopped = why;
		o.onStop(why);
	};
	let idle: ReturnType<typeof setTimeout> | undefined;
	let tools = 0;
	const active = () => {
		clearTimeout(idle);
		if (!stopped && !tools) idle = setTimeout(() => stop(`idle_timeout: no model or tool activity for ${Math.round(o.idleMs / 1000)}s`), o.idleMs);
	};
	active();
	return {
		/** Any session event: the idle clock starts over. */
		active,
		/** A tool call starts or ends: no idle clock while one runs. */
		toolStart: () => (tools++, active()),
		toolEnd: () => ((tools = Math.max(0, tools - 1)), active()),
		/** The session's fresh tokens so far. */
		used: (tokens: number) => {
			if (o.maxTokens > 0 && tokens > o.maxTokens) stop(`budget: the session used ${tokens} tokens, over run.maxUnitTokens (${o.maxTokens})`);
		},
		stopped: () => stopped,
		end: () => clearTimeout(idle),
	};
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
	const gate = makeWriteGate({ cwd: opts.cwd, globRoot: opts.globRoot, sourceRoot: opts.config.source.path, writeGlobs: opts.writeGlobs, protectedGlobs: opts.protectedGlobs ?? [], isProtected: opts.isProtected, appendOnlyGlobs: opts.appendOnlyGlobs });
	let toolCalls = 0;
	let blocked = 0;
	// the file as it was before each edit, so the syntax check after it reports only errors the edit added
	const beforeEdit = new Map<string, string | undefined>();
	// one agent per session in the live panel: label = unit (from the transcript name "<unit>.<role>.<attempt>.jsonl")
	const agentLabel = opts.transcriptPath ? basename(opts.transcriptPath).split(".")[0]! : opts.role;
	const roleName = opts.transcriptPath ? (basename(opts.transcriptPath).split(".")[1] ?? opts.role) : opts.role;
	const agentId = progress.agentStart(agentLabel, roleName, `${model.provider}/${model.id}`);

	const guard = (pi: ExtensionAPI) => {
		pi.on("tool_call", async (event) => {
			toolCalls++;
			const input = event.input as Record<string, unknown>;
			let reason: string | undefined;
			if (["write", "edit", "remove_file", "rename_file"].includes(event.toolName)) {
				const path = String(input["path"] ?? "");
				reason = gate(path);
				if (!reason && event.toolName === "rename_file") reason = gate(String(input["destination"] ?? ""));
				if (!reason && event.toolName === "write" && opts.validateWrite) reason = await opts.validateWrite(path, String(input["content"] ?? ""), fileText(resolve(opts.cwd, path)));
				if (!reason && event.toolName === "edit" && opts.validateWrite) beforeEdit.set(event.toolCallId, fileText(resolve(opts.cwd, path)));
			} else if (event.toolName === "bash") {
				const command = String(input["command"] ?? "");
				reason = ROLE_TOOLS[opts.role].includes("bash") ? (bashTouchesReadOnly(command, opts.config.source.path, opts.cwd, findSourceAdapter(opts.config.source.stack)?.traits?.mutatingCommands) ?? bashDeletesOutside(command, opts.cwd, (abs) => opts.writeGlobs.length > 0 && !gate(abs))) : "bash is not available to this role";
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
			if (event.toolName === "bash" && opts.afterBash) return afterBashResult(event as any, opts.afterBash);
			// a failed edit is a tool slip, not a reason to give up: say how to get it through
			if (event.toolName === "edit" && event.isError) {
				const text = (event.content ?? []).map((c) => ("text" in c ? c.text : "")).join("\n");
				return { content: [{ type: "text", text: `${text}\nTo get the edit through: read the file again and quote the exact text with enough surrounding lines to be unique, or write the whole file with write.` }], isError: true, details: (event as any).result?.details ?? {} };
			}
			const before = beforeEdit.get(event.toolCallId);
			beforeEdit.delete(event.toolCallId);
			if (event.toolName !== "edit" || event.isError || !opts.validateWrite) return undefined;
			const path = String((event.input as Record<string, unknown>)["path"] ?? "");
			try {
				const abs = resolve(opts.cwd, path);
				const problem = await opts.validateWrite(abs, readFileSync(abs, "utf8"), before);
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

	const customTools = [...(opts.customTools ?? []), ...(["implement", "escalate"].includes(opts.role) ? scopedFileTools({ ...opts, sourceRoot: opts.config.source.path }) : [])];
	// long work in one session: older turns are summarized once the context is run.compactAt full, never cut off
	const settingsManager = SettingsManager.create(opts.cwd, getAgentDir());
	settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens: compactionReserve(model.contextWindow, opts.config.run.compactAt), keepRecentTokens: settingsManager.getCompactionKeepRecentTokens(model) } });
	const { session } = await createAgentSession({
		cwd: opts.cwd,
		model,
		settingsManager,
		thinkingLevel: thinkingLevelOf(role.effort),
		modelRuntime: await modelRuntime(),
		tools: [...ROLE_TOOLS[opts.role], ...(opts.tools ?? []), ...customTools.map((t) => t.name)],
		customTools,
		resourceLoader,
		sessionManager: SessionManager.inMemory(),
	});

	if (opts.transcriptPath) mkdirSync(dirname(opts.transcriptPath), { recursive: true });
	const transcript = opts.transcriptPath ? createWriteStream(opts.transcriptPath, { flags: "a" }) : undefined;
	const record = (e: unknown) => transcript?.write(JSON.stringify({ t: Date.now(), ...(e as object) }) + "\n");
	record({ type: "session_spawned", role: opts.role, model: `${model.provider}/${model.id}`, tier: role.tier, cwd: opts.cwd, writeGlobs: opts.writeGlobs });

	return {
		async run(prompt) {
			// counts are per prompt: blocked calls from an earlier run() never terminate this one
			toolCalls = 0;
			blocked = 0;
			let text = "";
			let error: string | undefined;
			const usage = { input: 0, output: 0, cost: 0 };
			const limits = sessionLimits({
				maxTokens: opts.config.run.maxUnitTokens,
				idleMs: opts.config.run.idleMs,
				onStop: (why) => (record({ type: "session_stopped", why }), session.abort()),
			});
			const unsub = session.subscribe((ev: any) => {
				if (ev.type === "tool_execution_start") limits.toolStart();
				else if (ev.type === "tool_execution_end") limits.toolEnd();
				else limits.active();
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
						limits.used(usage.input + usage.output);
						progress.agentUsage(agentId, { costUsd: usd, tokensIn: m.usage.input ?? 0, tokensOut: m.usage.output ?? 0 });
						recordSpend(usd, `session: ${roleName} ${agentLabel}`, `${m.provider ?? "openrouter"}/${m.model ?? role.id}`, { subscription: codex });
					}
					// a later good message (Pi's own retry got through) clears an earlier error: only the last one counts
					error = m.stopReason === "error" || m.errorMessage ? (m.errorMessage ?? "assistant message ended with error") : undefined;
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
					aborting: () => progress.aborting || !!limits.stopped(),
				});
			} catch (e: any) {
				error = e?.message ?? String(e);
				record({ type: "prompt_error", error });
			} finally {
				limits.end();
				unsub();
				progress.agentEnd(agentId);
			}
			if (limits.stopped()) error = limits.stopped();
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
