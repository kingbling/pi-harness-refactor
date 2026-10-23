import { parseExactJson } from "./exact-json.ts";
import { MAX_OBSERVATION_TIMEOUT_MS, observationEnvironment, observationTimeoutMs, runVerificationCommand, type ObservationContext } from "./parity-command.ts";
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import pc from "picocolors";
import { Type } from "typebox";
import type { Config } from "../config.ts";
import { addWorktree, headOf, removeWorktree, deleteBranch, wsBranch } from "../git.ts";
import { projectDir } from "../init/init.ts";
import { loadDecisions } from "../inventory/decisions.ts";
import { PLAIN_LANGUAGE } from "../policy.ts";
import { spawnLeaf } from "../sessions/spawn.ts";
import { legacyCopyTool, loadLegacyEnv, ownerPreference, type ProbeAnswer, type ProbeAsker } from "./legacy-env.ts";
import { exec } from "../proc.ts";
import { readFile, rm } from "node:fs/promises";
import { setStep } from "./watchdog.ts";
import { recordOwnedTool, whileSettingUp } from "./cleanup.ts";
import { legacyTree } from "./parity-legacy-tree.ts";
import { fixtureFileProblem, recordFixture, scopeIfValid } from "./parity-scope.ts";

/**
 * Differential parity, step one: can the OLD app and the NEW app each be started here as a local server that
 * answers HTTP? Nothing about the stack is assumed: a setup model with tools finds out how (the repo's own docs,
 * compose files, scripts, the framework's dev server, what this machine has) and saves a recipe; code decides it
 * works by starting the app, getting an answer on the ready URL and stopping it again. Saved per workspace in
 * .bigrefactor/parity/apps.json, one entry per side: "legacy" and each target stack id.
 *
 * The old app never runs in the read-only legacy repo (a running app writes caches, sessions, logs): only in the
 * workspace copy. The new app runs in its own worktree of main, so merges never change it under a running server.
 */

/** How to start one app. `dir` is relative to the app's root (the legacy copy, or the stack's project in the parity worktree). */
export interface AppRecipe {
	dir: string;
	start: { cmd: string; args: string[] };
	/** A URL on this machine that answers once the app is up (any status below 500). */
	ready: string;
	/** Run after the server process is stopped (e.g. taking down containers the start command brought up). */
	stop?: { cmd: string; args: string[] };
	/** Puts the app's data back to its starting state; runs before every start, so runs are comparable. */
	reset?: { cmd: string; args: string[] };
	/** Prints the app's data as JSON {"table": [rows ordered by primary key]}; read before and after steps that change data. */
	dump?: { cmd: string; args: string[]; timeoutMs?: number };
	env?: Record<string, string>;
}

export interface AppState {
	recipe?: AppRecipe;
	/** Decided by code: true = the recipe started the app and it answered. Unset = not probed yet. */
	up?: boolean;
	said?: string;
	/** The owner question asked once after a red probe (blocks nothing): "retry" makes the next probe try again. */
	probeQuestion?: number;
	/** The new app only: the main commit the last probe ran at, and how many probes in a row were red. */
	commit?: string;
	redProbes?: number;
	/** Set once an app that was up was probed again to add a data reset and dump (older workspaces; now dataProbes). */
	dataProbed?: boolean;
	/** How often an app that was up was probed again to add a data reset and dump (at most MAX_FIXUPS). */
	dataProbes?: number;
	/** The old app only: a slice check saw it answer with a redirect to itself on another scheme (http → https), so no handler was reached. */
	selfRedirect?: string;
	/** Set once the old app was probed again over that redirect (older workspaces; now redirectProbes). */
	redirectProbed?: boolean;
	/** How often the old app was probed again over that redirect (at most MAX_FIXUPS). */
	redirectProbes?: number;
	/** A slice check found a problem that only this app's setup here causes (what and why): a difference the parity
	 * judge blamed on the setup (an app not starting is bootProblem). */
	setupProblem?: string;
	/** The setup problems (routes and kinds) it was asked to fix: a new one gets a fix-up although the earlier ones used them up. */
	setupFor?: string[];
	/** Set once the app was probed again over such a problem (older workspaces; now setupProbes). */
	setupProbed?: boolean;
	/** How often the app was probed again over such a problem (at most MAX_FIXUPS). */
	setupProbes?: number;
	/** A slice check could not start this app (its data reset or start failed): what failed, for its setup to fix. */
	bootProblem?: string;
	/** How often its setup was asked to fix that since the app last started for a slice check (at most MAX_FIXUPS). */
	bootProbes?: number;
	/** The owner question asked once those fixes ran out: slice checks wait for it, "retry" gives the setup its tries back. */
	bootQuestion?: number;
	/** Set once its setup checked whether the data reset keeps a full second copy of a large database (which is then dropped). */
	resetSpaceChecked?: boolean;
	/** How often its setup was asked for what strict parity needs of its data (fixtureGaps), at most MAX_FIXUPS. */
	fixtureProbes?: number;
	/** A new app only: the old app's fixture (scope.json legacyAt) its reset was last made to load the same data as. */
	fixtureFor?: string;
	/** The test account the comparison logs in with on this app, found or made by its setup model (set_test_login). */
	login?: TestLogin;
	/** How often its setup model was asked for a test account (at most MAX_LOGIN_TRIES until the owner says retry). */
	loginTries?: number;
	/** The owner question asked once those tries found no account: "retry" gives them back. */
	loginQuestion?: number;
	at?: string;
}

/** One request of a login, as a slice step sends it (without route and compare). */
export interface LoginRequest {
	method: string;
	path: string;
	headers?: Record<string, string>;
	form?: Record<string, string>;
	body?: unknown;
	save?: Record<string, string>;
}

/** A test account: the requests that log it in, or `none` when the app has no login of its own. */
export interface TestLogin {
	user?: string;
	password?: string;
	steps?: LoginRequest[];
	said?: string;
	none?: string;
}

export const LEGACY = "legacy";

/** An app that is up is probed again over the same kind of problem at most this often (a model that gave up once may not twice). */
export const MAX_FIXUPS = 3;
type FixKind = "data" | "redirect" | "setup" | "boot" | "fixture";
const fixUps = (a: AppState, kind: FixKind) =>
	kind === "fixture" ? (a.fixtureProbes ?? 0) : kind === "data" ? (a.dataProbes ?? (a.dataProbed ? 1 : 0)) : kind === "redirect" ? (a.redirectProbes ?? (a.redirectProbed ? 1 : 0)) : kind === "boot" ? (a.bootProbes ?? 0) : (a.setupProbes ?? (a.setupProbed ? 1 : 0));
/** Whether the app may still be probed again over this kind of problem. */
export const fixUpLeft = (a: AppState | undefined, kind: FixKind) => !!a && fixUps(a, kind) < MAX_FIXUPS;

/** A command's error for a person or a model: no colour codes, the start (the tool's own message) and the end (a traceback's last line). */
export function clipError(e: any, n = 1_200): string {
	const t = ([e?.stderr, e?.stdout].map((x) => String(x ?? "").trim()).filter(Boolean).join("\n") || String(e?.message ?? e)).replace(/\x1b\[[0-9;]*m/g, "");
	return t.length <= n ? t : `${t.slice(0, Math.floor(n * 0.4))}\n…\n${t.slice(-Math.ceil(n * 0.6))}`;
}

/**
 * How a command ended, from exec's error. Only this decides a failure: a tool that prints a notice ("OrbStack is
 * already running") and exits 0 is fine, so its output alone never says what went wrong.
 */
export function howEnded(e: any, timeoutMs?: number): string {
	if (e?.code === "ETIMEDOUT") return `it did not finish${timeoutMs ? ` within ${Math.round(timeoutMs / 1000)} s` : ""} and was stopped`;
	if (e?.code === "ENOBUFS") return "it printed more output than is read and was stopped";
	if (typeof e?.code === "string") return `it could not be run (${e.code})`;
	if (e?.signal) return `it was stopped (${e.signal})`;
	return `it exited with status ${e?.status ?? "unknown"}`;
}

/**
 * The request a slice check saw redirected to the app itself on another scheme ("POST /x → 301 https://(this app)/x"),
 * sent again over plain http: what it answers when it still redirects that way, else undefined.
 */
export async function stillRedirects(ready: string, selfRedirect: string): Promise<string | undefined> {
	const m = /^(\S+) (\S+) →/.exec(selfRedirect);
	if (!m) return undefined;
	const url = new URL(m[2]!, ready);
	try {
		const r = await fetch(url, { method: m[1], redirect: "manual", signal: AbortSignal.timeout(10_000) });
		const to = r.headers.get("location");
		if (r.status < 300 || r.status >= 400 || !to) return undefined;
		const loc = new URL(to, url);
		return loc.hostname === url.hostname && loc.protocol !== url.protocol ? `${m[1]} ${m[2]} → ${r.status} ${to}` : undefined;
	} catch {
		return undefined;
	}
}
const parityDir = (root: string) => join(root, ".bigrefactor", "parity");
const appsPath = (root: string) => join(parityDir(root), "apps.json");

export function loadApps(root: string): Record<string, AppState> {
	try {
		return JSON.parse(readFileSync(appsPath(root), "utf8")) as Record<string, AppState>;
	} catch {
		return {};
	}
}

export function saveApp(root: string, side: string, change: Partial<AppState>): AppState {
	const all = loadApps(root);
	const next = { ...all[side], ...change, at: new Date().toISOString() };
	all[side] = next;
	mkdirSync(parityDir(root), { recursive: true });
	writeFileSync(appsPath(root), JSON.stringify(all, null, 2) + "\n");
	return next;
}

/** Where a side's app lives: the legacy copy, or the stack's project inside the parity worktree. */
export function appRoot(config: Config, root: string, side: string): string {
	if (side === LEGACY) return loadLegacyEnv(root, config).root;
	return join(targetWorktree(root), relative(config.target.path, projectDir(config, side)));
}

export const targetWorktree = (root: string) => join(root, ".bigrefactor", "worktrees", "__parity__");

/** A fresh worktree of main for the new app (dependencies linked like a unit's). */
export async function prepareTargetCopy(config: Config, root: string, linkAll: (wt: string) => void | Promise<void>): Promise<string> {
	const wt = targetWorktree(root);
	await removeWorktree(config.target.path, wt);
	try {
		await deleteBranch(config.target.path, wsBranch(root, "parity/main"));
	} catch {
		/* no branch */
	}
	await addWorktree(config.target.path, wt, wsBranch(root, "parity/main"));
	await linkAll(wt);
	return wt;
}

// ---- starting and stopping an app ------------------------------------------------------------------------

/** `stage` says where it failed: "setup" = before the app's own start command (ready URL, port, folder, data reset), "start" = the start command or no answer. */
export type Booted = { ok: true; stop: () => Promise<void> } | { ok: false; error: string; stage: "setup" | "start" };

const isLocal = (url: string) => {
	try {
		const u = new URL(url);
		return /^https?:$/.test(u.protocol) && ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(u.hostname);
	} catch {
		return false;
	}
};

/** Any HTTP answer below 500 counts: a login redirect or a 404 on "/" still proves a server is there. */
async function answers(url: string): Promise<boolean> {
	try {
		const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(3_000) });
		return r.status < 500;
	} catch {
		return false;
	}
}

/** True while any process of the group still runs (signal 0 only checks). */
const groupAlive = (pid: number) => {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (e: any) {
		return e?.code === "EPERM";
	}
};

/** App servers started and not stopped yet: killed when the harness exits (a double Ctrl-C skips every stop()). */
const liveGroups = new Set<number>();
process.on("exit", () => {
	for (const pid of liveGroups)
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			/* already gone */
		}
});

/**
 * Start the app, wait until the ready URL answers, hand back how to stop it. A start command that exits 0 (a
 * container started in the background) is fine; one that exits non-zero before the app answers is a failure.
 * Something already answering on the ready URL is refused: it would make any recipe look green.
 */
export async function bootApp(recipe: AppRecipe, appDir: string, o: { timeoutMs?: number; resetTimeoutMs?: number } = {}): Promise<Booted> {
	if (!isLocal(recipe.ready)) return { ok: false, stage: "setup", error: `the ready URL must be on this machine (http://localhost:<port>/…), got ${recipe.ready}` };
	if (await answers(recipe.ready)) return { ok: false, stage: "setup", error: `something already answers on ${recipe.ready} before the app was started: pick a free port (or stop what runs there)` };
	const cwd = resolve(appDir, recipe.dir);
	setStep(`parity: data reset and start of the app in ${cwd}`);
	if (!existsSync(cwd)) return { ok: false, stage: "setup", error: `folder ${cwd} does not exist` };
	// the reset is judged by its exit status alone; its output only helps say why
	const resetMs = o.resetTimeoutMs ?? 300_000;
	if (recipe.reset)
		try {
			await exec(recipe.reset.cmd, recipe.reset.args, { cwd, env: { ...process.env, ...recipe.env }, timeout: resetMs });
		} catch (e: any) {
			return { ok: false, stage: "setup", error: `the data reset failed (${[recipe.reset.cmd, ...recipe.reset.args].join(" ")}: ${howEnded(e, resetMs)}); its output: ${clipError(e)}` };
		}
	const tail: string[] = [];
	const child = spawn(recipe.start.cmd, recipe.start.args, { cwd, detached: true, env: { ...process.env, ...recipe.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
	const feed = (b: Buffer) => {
		for (const l of b.toString("utf8").split(/\r?\n/)) if (l.trim()) (tail.push(l), tail.length > 40 && tail.shift());
	};
	child.stdout?.on("data", feed);
	child.stderr?.on("data", feed);
	let exit: number | null | undefined;
	let spawnError: string | undefined;
	child.on("exit", (c) => (exit = c));
	child.on("error", (e) => (spawnError = e.message));
	if (child.pid) liveGroups.add(child.pid);
	const stop = async () => {
		// the whole group, even when the start command already exited: a wrapper that ran `server &` and exited 0
		// leaves the server in the group, and it would refuse every later boot ("something already answers")
		if (child.pid) {
			const pid = child.pid;
			if (groupAlive(pid)) {
				try {
					process.kill(-pid, "SIGTERM");
				} catch {
					/* already gone */
				}
				for (let i = 0; i < 50 && groupAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
				if (groupAlive(pid))
					try {
						process.kill(-pid, "SIGKILL");
					} catch {
						/* already gone */
					}
			}
			liveGroups.delete(pid);
		}
		if (recipe.stop)
			try {
				await exec(recipe.stop.cmd, recipe.stop.args, { cwd, env: { ...process.env, ...recipe.env }, timeout: 120_000 });
			} catch {
				/* best effort: the next boot's port check catches a leftover */
			}
	};
	const deadline = Date.now() + (o.timeoutMs ?? 180_000);
	while (Date.now() < deadline) {
		if (spawnError) return (await stop(), { ok: false, stage: "start", error: `could not start ${recipe.start.cmd}: ${spawnError}` });
		if (exit !== undefined && exit !== 0) return (await stop(), { ok: false, stage: "start", error: `the start command exited with ${exit} before the app answered:\n${tail.join("\n")}` });
		if (await answers(recipe.ready)) return { ok: true, stop };
		await new Promise((r) => setTimeout(r, 1_000));
	}
	await stop();
	return { ok: false, stage: "start", error: `no answer on ${recipe.ready} after ${Math.round((o.timeoutMs ?? 180_000) / 1000)}s:\n${tail.join("\n")}` };
}

/** Start, check, stop: what code (and the model's check_app_boot) runs to decide a recipe works. */
export async function checkRecipe(recipe: AppRecipe, appDir: string, o: { timeoutMs?: number; selfRedirect?: string } = {}): Promise<{ ok: boolean; error?: string; dumpFailed?: boolean; redirectFailed?: boolean }> {
	const b = await bootApp(recipe, appDir, o);
	if (!b.ok) return { ok: false, error: b.error };
	let still: string | undefined;
	try {
		// the request a slice check saw redirected to the app itself: plain http must reach its handler now
		still = o.selfRedirect ? await stillRedirects(recipe.ready, o.selfRedirect) : undefined;
		if (recipe.dump) await dumpData(recipe, appDir);
	} catch (e: any) {
		// the app came up after the reset ran, so the reset works: say so, it can be kept without the dump
		return { ok: false, dumpFailed: true, redirectFailed: !!still, error: `the app starts${recipe.reset ? " and the data reset works" : ""}, but the data dump fails: ${clipError(e, 800)}${still ? `; and plain http still only redirects to the app itself: ${still}` : ""}` };
	} finally {
		await b.stop();
	}
	if (still) return { ok: false, redirectFailed: true, error: `the app starts${recipe.dump ? " and dumps its data" : ""}, but plain http still only redirects to the app itself: ${still}. No request reaches a handler, so nothing can be compared.` };
	return { ok: true };
}

/**
 * The biggest data dump that is read. Reading and parsing a dump holds the run's thread: a dump of a whole production
 * database (over 512 MB) held it 10 s on every try and then failed anyway ("Cannot create a string longer than …").
 */
export const MAX_DUMP_MB = 100;

/** The app's data as {table: rows}, from the recipe's dump command. Throws when it prints anything else. */
export async function dumpData(recipe: AppRecipe, appDir: string, context: ObservationContext = {}): Promise<Record<string, unknown[]>> {
	if (!recipe.dump) return {};
	setStep(`parity: data dump of the app in ${appDir}`);
	const timeout = observationTimeoutMs(recipe.dump.timeoutMs, 600_000);
	const { stdout: outText } = await runVerificationCommand(recipe.dump, resolve(appDir, recipe.dir), timeout,
		{ ...process.env, ...recipe.env, ...observationEnvironment(context) }, {
			maxBytes: MAX_DUMP_MB * 1024 * 1024, label: "data dump",
			outputProblem: `the dump printed more than the ${MAX_DUMP_MB} MB a comparison reads: use a complete bounded observation (such as row counts and full-row digests), or only the tables this workflow writes`,
		});
	const data = parseExactJson(outText.slice(outText.indexOf("{")));
	if (!data || typeof data !== "object" || Array.isArray(data) || !Object.values(data).every(Array.isArray)) throw new Error('the dump must print {"table": [rows]}');
	return data as Record<string, unknown[]>;
}

// ---- the setup model's tools -----------------------------------------------------------------------------

const out = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
const portOf = (url: string) => {
	try {
		const u = new URL(url);
		return u.port || (u.protocol === "https:" ? "443" : "80");
	} catch {
		return "";
	}
};
const RecipeParams = Type.Object({
	dir: Type.String({ description: "folder the start command runs in, relative to the app's root ('.' = the root)" }),
	cmd: Type.String(),
	args: Type.Array(Type.String()),
	ready: Type.String({ description: "a URL on this machine that answers once the app is up, e.g. http://localhost:8081/" }),
	stopCmd: Type.Optional(Type.String({ description: "run after the server process is stopped, e.g. to take down containers it started" })),
	stopArgs: Type.Optional(Type.Array(Type.String())),
	resetCmd: Type.Optional(Type.String({ description: "puts the app's data back to its starting state (e.g. reloads the database from the schema/snapshot); runs before every start" })),
	resetArgs: Type.Optional(Type.Array(Type.String())),
	dumpCmd: Type.Optional(Type.String({ description: `prints the app's data as JSON {"table": [rows ordered by primary key]}, nothing else on stdout; at most ${MAX_DUMP_MB} MB (complete bounded observations (full-row hashes and counts), or the tables this workflow writes)` })),
	dumpArgs: Type.Optional(Type.Array(Type.String())),
	dumpTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_OBSERVATION_TIMEOUT_MS, description: "Explicit time budget for a complete data observation, in milliseconds; default 600000" })),
	env: Type.Optional(Type.Record(Type.String(), Type.String())),
	why: Type.Optional(Type.String()),
});
type RecipeInput = { dir: string; cmd: string; args: string[]; ready: string; stopCmd?: string; stopArgs?: string[]; resetCmd?: string; resetArgs?: string[]; dumpCmd?: string; dumpArgs?: string[]; dumpTimeoutMs?: number; env?: Record<string, string>; why?: string };
const toRecipe = (p: RecipeInput): AppRecipe => ({
	dir: p.dir || ".",
	start: { cmd: p.cmd, args: p.args },
	ready: p.ready,
	...(p.stopCmd ? { stop: { cmd: p.stopCmd, args: p.stopArgs ?? [] } } : {}),
	...(p.resetCmd ? { reset: { cmd: p.resetCmd, args: p.resetArgs ?? [] } } : {}),
	...(p.dumpCmd ? { dump: { cmd: p.dumpCmd, args: p.dumpArgs ?? [], ...(p.dumpTimeoutMs !== undefined ? { timeoutMs: p.dumpTimeoutMs } : {}) } } : {}),
	...(p.env ? { env: p.env } : {}),
});

/** Why this recipe cannot be used for this side, or undefined. Checked by code, before anything starts. */
export function recipeProblem(config: Config, root: string, side: string, r: AppRecipe): string | undefined {
	try { observationTimeoutMs(r.dump?.timeoutMs, 600_000); } catch (e) { return String(e); }
	if (isAbsolute(r.dir) || r.dir.split(/[\\/]/).includes("..")) return `dir must be relative to the app's root and stay inside it, got ${r.dir}`;
	if (!isLocal(r.ready)) return `the ready URL must be on this machine (http://localhost:<port>/…), got ${r.ready}`;
	if (side === LEGACY && resolve(appRoot(config, root, side)) === resolve(config.source.path)) return "the legacy repo is read-only and a running app writes into its folder: call make_legacy_copy first, the old app runs in the copy";
	const taken = Object.entries(loadApps(root)).find(([s, a]) => s !== side && a.recipe && portOf(a.recipe.ready) === portOf(r.ready));
	if (taken) return `port ${portOf(r.ready)} is the ${taken[0]} app's: both apps run at the same time, pick another port`;
	return undefined;
}

export function appBootTools(config: Config, root: string, side: string): ToolDefinition[] {
	const check = {
		name: "check_app_boot",
		label: "Try starting the app",
		description: "Start the app with this recipe, wait until the ready URL answers (up to 3 minutes), run its data dump, then stop it. When a slice check saw the app redirect plain http to itself on https, it also sends that request again and says whether it still does. Says whether it came up, with the start command's output when it did not. Use it to try a recipe before saving it.",
		promptSnippet: "check_app_boot: start the app with a recipe, check the ready URL answers, stop it",
		parameters: RecipeParams,
		execute: async (_id: string, p: RecipeInput) => {
			const r = toRecipe(p);
			const bad = recipeProblem(config, root, side, r);
			if (bad) return out(`refused: ${bad}`);
			const res = await checkRecipe(r, appRoot(config, root, side), { selfRedirect: loadApps(root)[side]?.selfRedirect });
			return out(res.ok ? `up: ${r.ready} answered${r.dump ? ", the data dump works" : ""}; the app was stopped again` : `not up: ${res.error}`);
		},
	};
	const set = {
		name: "set_app_boot",
		label: "Save how the app starts",
		description: "Save the recipe that starts this app as a local server. Code then starts it once more itself to confirm.",
		promptSnippet: "set_app_boot: save the recipe that starts the app",
		parameters: RecipeParams,
		execute: async (_id: string, p: RecipeInput) => {
			const r = toRecipe(p);
			const bad = recipeProblem(config, root, side, r);
			if (bad) return out(`refused: ${bad}`);
			saveApp(root, side, { recipe: r, said: p.why });
			return out(`saved: ${[r.start.cmd, ...r.start.args].join(" ")} in ${r.dir}, ready at ${r.ready}`);
		},
	};
	const LoginRequestParams = Type.Object({
		method: Type.String(),
		path: Type.String({ description: "starts with /" }),
		headers: Type.Optional(Type.Record(Type.String(), Type.String())),
		form: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "form fields, sent url-encoded" })),
		body: Type.Optional(Type.Unknown({ description: "JSON body" })),
		save: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "name → regex; group 1 of the first match in the answer is used as {{name}} in later requests (a CSRF token)" })),
	});
	const tryRequests = {
		name: "try_requests",
		label: "Try requests on the app",
		description: "Start the app with its saved recipe, send these requests in order with one cookie jar (as a slice comparison does), show each answer (status, redirect, the start of the body), stop it. Use it to check a login: a page behind the login must answer as logged in after it.",
		promptSnippet: "try_requests: start the app, send requests with one cookie jar, see the answers",
		parameters: Type.Object({ requests: Type.Array(LoginRequestParams) }),
		execute: async (_id: string, p: { requests: LoginRequest[] }) => {
			const recipe = loadApps(root)[side]?.recipe;
			if (!recipe) return out("refused: this app has no saved recipe yet (set_app_boot first)");
			const bad = p.requests.find((r) => !r.method || !String(r.path ?? "").startsWith("/"));
			if (bad) return out("refused: every request needs a method and a path starting with /");
			const b = await bootApp(recipe, appRoot(config, root, side));
			if (!b.ok) return out(`the app did not start: ${b.error}`);
			try {
				const { runSteps } = await import("./parity-check.ts");
				const steps = p.requests.map((r, i) => ({ ...r, id: `r${i + 1}`, route: "setup", compare: "none" as const }));
				const res = await runSteps(steps, { side: "legacy", base: () => recipe.ready });
				return out(steps.map((s, i) => `${s.id} ${s.method} ${s.path} → ${res[i]!.error ? `ERROR ${res[i]!.error}` : `${res[i]!.status}${res[i]!.location ? ` → ${res[i]!.location}` : ""} ${String(typeof res[i]!.body === "string" ? res[i]!.body : JSON.stringify(res[i]!.body)).slice(0, 300)}`}`).join("\n"));
			} finally {
				await b.stop();
			}
		},
	};
	const setLogin = {
		name: "set_test_login",
		label: "Save the test account",
		description: "Save the test account the comparison logs in with on this app: the user, its password and the requests that log it in (as tried with try_requests). Or, when this app has no login of its own, only `none` with why.",
		promptSnippet: "set_test_login: save the test account and how it logs in",
		parameters: Type.Object({
			user: Type.Optional(Type.String()),
			password: Type.Optional(Type.String()),
			steps: Type.Optional(Type.Array(LoginRequestParams, { description: "the login requests, in order; {{name}} uses a value an earlier one saved" })),
			said: Type.Optional(Type.String({ description: "where the account comes from and what it may see" })),
			none: Type.Optional(Type.String({ description: "only when the app has no login of its own: why" })),
		}),
		execute: async (_id: string, p: TestLogin) => {
			if (p.none) return saveApp(root, side, { login: { none: p.none } }), out("saved: this app has no login of its own");
			if (!p.steps?.length || p.steps.some((r) => !r.method || !String(r.path ?? "").startsWith("/"))) return out("refused: give the login requests (each with a method and a path starting with /), or none with why");
			saveApp(root, side, { login: { user: p.user, password: p.password, steps: p.steps, said: p.said } });
			return out(`saved: the test account${p.user ? ` ${p.user}` : ""} (${p.steps.length} login request(s))`);
		},
	};
	const setFixture = {
		name: "set_fixture_files",
		label: "Record the fixture files",
		description: `Record the files this app's data reset, dump and start read (the seed data, the scripts, config files), so the strict parity check fingerprints them; replaces what this app recorded before. Not files in the temporary parity worktree (.bigrefactor/worktrees): it is made again for every check, and the new app's tracked files are covered by its commit; record the overlay you copy into it instead.${side === LEGACY ? " overrides: each tracked file of the legacy copy you changed for local config (path relative to the legacy repo, and why); the check compares every other tracked file with the pinned source. Leave overrides out to keep the declared ones." : ""}`,
		promptSnippet: "set_fixture_files: record the files the data reset, dump and start read",
		parameters: Type.Object({
			files: Type.Array(Type.String({ description: "relative to the workspace, or absolute" })),
			...(side === LEGACY ? { overrides: Type.Optional(Type.Array(Type.Object({ path: Type.String(), why: Type.String() }))) } : {}),
		}),
		execute: async (_id: string, p: { files: string[]; overrides?: Array<{ path: string; why: string }> }) => {
			const bad = recordFixture(root, side, p.files, side === LEGACY ? p.overrides : undefined);
			return out(bad ? `refused: ${bad}` : `recorded ${p.files.length} fixture file(s)${p.overrides ? ` and ${p.overrides.length} override(s)` : ""}`);
		},
	};
	return [check, set, tryRequests, setLogin, setFixture] as unknown as ToolDefinition[];
}

// ---- the probe -------------------------------------------------------------------------------------------

/** Returns the model's one-sentence account of what it found. */
export type AppFixer = (o: { config: Config; root: string; side: string; appDir: string; problem: string }) => Promise<string | void>;

// the cleaner leaves Docker alone while this model runs: what it makes is named by no recipe until set_app_boot
export const findAppBootWithModel: AppFixer = (o) => whileSettingUp(() => findAppBoot(o));
const findAppBoot: AppFixer = async (o) => {
	const legacy = o.side === LEGACY;
	const work = parityDir(o.root);
	mkdirSync(work, { recursive: true });
	const truth = legacy ? loadDecisions(o.root).truth : undefined;
	const session = await spawnLeaf({
		role: "setup",
		cwd: work,
		config: o.config,
		writeGlobs: ["**"],
		protectedGlobs: [],
		customTools: [...(legacy ? [legacyCopyTool(o.root, o.config)] : []), ...appBootTools(o.config, o.root, o.side), recordOwnedTool(o.root)],
		transcriptPath: join(o.root, ".bigrefactor", "sessions", `__parity__.${o.side}.${Date.now()}.jsonl`),
		systemPrompt: `You find out how to start ${legacy ? `the OLD app (${o.config.source.stack})` : `the NEW ${o.side} project of a migration`} as a local server, so a migration tool can send the same HTTP requests to the old and the new app and compare the answers. Read what the project itself says (README and docs, compose and container files, package or build manifests, scripts, the framework's own dev server) and check which tools this machine really has (versions, docker) before choosing a way. ${legacy ? `The legacy repo (${o.config.source.path}) is read-only: call make_legacy_copy first, then install and start everything in the copy. ` : "Start it the way it runs in production (its production mode and settings, in this local copy only): a debug toolbar, profiler or developer error page that a development mode adds to its answers makes every page differ from the old app. "}Try recipes with check_app_boot (it starts the app, waits for the ready URL and stops it), save the one that works with set_app_boot. Never start the app server yourself in bash and never leave it running; a database the app needs may be started and may stay up. Docker on this machine is shared with other projects: start your own containers and volumes and put the label bigrefactor.root=${resolve(o.root)} on each (docker run --label, docker volume create --label, labels: in a compose file); never create databases or anything else inside another project's container when you can start your own; whatever you still make without that label, write down with record_owned; a database inside a server you did not start is created only by record_owned (kind database), never by you. The workspace removes only what is labelled or recorded, once no recipe names it. Never interactive prompts. End with one sentence saying how the app starts, or exactly what is missing.\n\n${PLAIN_LANGUAGE}`,
	});
	try {
		const r = await session.run(`${o.problem}${truth ? ownerPreference(truth) : ""}`);
		const said = r.text.trim().split("\n").at(-1) ?? "";
		console.log(pc.dim(`  parity setup model (${o.side}): ${r.toolCalls} tool calls, $${r.usage.cost.toFixed(4)} — ${said}${r.error ? pc.red(` ERROR: ${r.error}`) : ""}`));
		return said;
	} finally {
		session.dispose();
	}
};

function problemFor(config: Config, root: string, side: string): string {
	const apps = loadApps(root);
	const ports = Object.entries(apps)
		.filter(([s, a]) => s !== side && a.recipe)
		.map(([s, a]) => `${s} uses port ${portOf(a.recipe!.ready)}`);
	const db = config.db.strategy !== "none" && (config.db.from.length || config.db.schemaFiles.length || config.db.snapshot)
		? ` The app uses ${config.db.from.join(" + ") || "a database"}${config.db.to && side !== LEGACY ? ` (the new app: ${config.db.to})` : ""}; schema/data inputs from setup (relative to the old repo ${config.source.path}): ${[...config.db.schemaFiles, ...(config.db.snapshot ? [config.db.snapshot] : [])].join(", ") || "none given"}. Start a database with that schema (and data, when there is a snapshot) if the app needs one to answer. Then also give the recipe a dump (prints the data as JSON {"table": [rows ordered by primary key]}): the tool compares what each app writes. And a reset that puts the data back to the same starting state before every run: it loads the schema and a small fixture (seed data with the test account and enough rows that pages show real data), never a second full copy of a large database (more than a few GB). Record the files it reads with set_fixture_files.`
		: "";
	const where = side === LEGACY ? `The old app's root (after make_legacy_copy): the copy.` : `The new project is at ${appRoot(config, root, side)} (a worktree of the migration's main branch; its dependencies are linked in).`;
	return `Find out whether this app can be started here as a local server that answers HTTP requests on this machine. ${where}${db}${ports.length ? ` Both apps run at the same time: ${ports.join(", ")}; use another port.` : ""} The app does not have to be complete: any answer on the ready URL (a login page, a redirect, a 404 from the framework) proves it runs. When the app is no HTTP server at all (a command-line tool, a library), say so and stop. Try more than one way before giving up.`;
}

/**
 * What strict parity still needs of this app's data (empty: nothing). Every slice is replayed on both apps from the
 * same starting data, so each app needs a reset loading a small fixture, its files in scope.json, the old app's
 * changed config files declared, and a new app the same data as the old app's fixture (it waits for that fixture).
 */
export async function fixtureGaps(config: Config, root: string, side: string, cur: AppState): Promise<string[]> {
	if (config.db.strategy === "none" || !cur.recipe) return [];
	const scope = scopeIfValid(root);
	const legacy = side === LEGACY;
	if (!legacy && !scope?.legacyAt) return [];
	const gaps: string[] = [];
	if (!cur.recipe.reset) gaps.push("it has no data reset, so no two runs start from the same data");
	if (!scope?.by?.[side]?.length) gaps.push("the files its data reset, dump and start read are not recorded (set_fixture_files)");
	const stale = (scope?.by?.[side] ?? []).map((f) => fixtureFileProblem(root, f)).filter((x): x is string => !!x);
	if (stale.length) gaps.push(`its recorded files cannot be fingerprinted: ${stale.slice(0, 5).join("; ")}${stale.length > 5 ? ` (${stale.length} in all)` : ""}; record them again with set_fixture_files`);
	if (!legacy && cur.fixtureFor !== scope!.legacyAt) gaps.push(`the old app's fixture (${(scope!.by?.[LEGACY] ?? []).join(", ")}) is newer than this app's data setup: its reset must load the same business data`);
	if (legacy) {
		try {
			const pinned = config.source.commit ?? (await headOf(config.source.path));
			if (!pinned) throw new Error("the legacy repo has no commit");
			const tree = await legacyTree(config.source.path, appRoot(config, root, LEGACY), pinned, (scope?.legacyOverrides ?? []).map((x) => x.path));
			if (tree.mismatches.length) gaps.push(`these tracked files of the copy differ from the pinned source and are not declared: ${tree.mismatches.slice(0, 30).join(", ")}${tree.mismatches.length > 30 ? ` and ${tree.mismatches.length - 30} more` : ""}. Declare each that is local config (database, URLs, http) as an override with why (set_fixture_files); put any other back as the source has it`);
		} catch (e: any) {
			gaps.push(`its copy cannot be compared with the pinned source: ${String(e?.message ?? e).slice(0, 400)}`);
		}
	}
	return gaps;
}

function fixtureText(config: Config, root: string, side: string, gaps: string[]): string {
	const legacy = side === LEGACY;
	const scope = scopeIfValid(root);
	return `the strict parity check replays every slice on both apps from the same starting data, and ${gaps.join("; and ")}. Give the recipe a reset that empties this app's database and loads its schema and a small fixture before every start: seed data with what the comparison needs (the test account, and enough rows that the pages and commands show real data; take them from the data the app runs on here). Never a second full copy of a large database. Keep the seed and scripts in ${join(parityDir(root), "fixture")}. Two resets in a row must leave the same data (its dump shows the same). ${legacy ? "The new app loads the same business data from your seed later, so keep it plain (SQL inserts or JSON rows per table)." : `Load the same business data the old app's fixture holds (${(scope?.by?.[LEGACY] ?? []).join(", ")}) into this app's database${config.db.to ? ` (${config.db.to})` : ""}: the same rows and values in this app's schema, so both apps start alike.`} The test account must still log in after the reset. Then call set_fixture_files with every file the reset, the dump and the start read (seed, scripts, config)${legacy ? ", and the overrides" : ""}`;
}

/** A red new app is probed again once main has moved on, at most this many probes in a row. */
const MAX_RED_PROBES = 3;

/**
 * Once per workspace and side: can this app be started here? The setup model writes a recipe; code starts the
 * app with it and gets an answer, or it is red. Red asks the owner once (blocks nothing); "retry" probes again.
 * A red new app is also probed again once main has new commits (the first probe often runs before it can start).
 * `again` probes regardless of an earlier result.
 */
export async function probeApp(o: { config: Config; root: string; side: string; fixer?: AppFixer; log?: (l: string) => void; ask?: ProbeAsker; answer?: ProbeAnswer; again?: boolean }): Promise<boolean> {
	const log = o.log ?? ((l: string) => console.log(l));
	const cur = loadApps(o.root)[o.side] ?? {};
	const retry = cur.up === false && cur.probeQuestion !== undefined && o.answer?.(cur.probeQuestion) === "retry";
	const commit = o.side === LEGACY ? undefined : await headOf(o.config.target.path);
	const moved = cur.up === false && commit !== undefined && commit !== cur.commit && (cur.redProbes ?? 0) < MAX_RED_PROBES;
	// an app that starts but cannot dump its data: written data is never compared, so it is asked to add a dump (a reset is optional)
	const lacksData = cur.up === true && !!cur.recipe && o.config.db.strategy === "keep-schema" && !cur.recipe.dump;
	// once per app: a reset that restores from a full second copy of a large database costs that much disk, so it is dropped
	const space = cur.up === true && !!cur.recipe?.reset && !cur.resetSpaceChecked;
	// an app that only redirects to itself on https: no request reaches a handler, so it is asked to fix that (and the data, if missing)
	const redirect = cur.up === true && !!cur.recipe && !!cur.selfRedirect && fixUpLeft(cur, "redirect");
	// a slice check blamed how this app runs here (a difference, or it did not start): it is asked to fix that
	const setup = cur.up === true && !!cur.recipe && !!cur.setupProblem && fixUpLeft(cur, "setup");
	// a slice check could not start it (its data reset or start failed): it is asked to fix that
	const boot = cur.up === true && !!cur.recipe && !!cur.bootProblem && fixUpLeft(cur, "boot");
	// what strict parity needs of its data (a reset loading a small fixture, its files recorded, the old app's config overlays declared)
	const legacyAt = scopeIfValid(o.root)?.legacyAt;
	const fixture = cur.up === true && !!cur.recipe && fixUpLeft(cur, "fixture") ? await fixtureGaps(o.config, o.root, o.side, cur) : [];
	// each kind at most MAX_FIXUPS times, whatever came of it
	const fixUp = (lacksData && fixUpLeft(cur, "data")) || redirect || setup || boot || space || fixture.length > 0;
	if (cur.up !== undefined && !retry && !moved && !fixUp && !o.again) return cur.up;
	const appDir = appRoot(o.config, o.root, o.side);
	const missing = [
		...(lacksData ? [`it has ${!cur.recipe!.reset && !cur.recipe!.dump ? "no data reset and no data dump" : !cur.recipe!.reset ? "no data reset" : "no data dump"}, so what the apps write is never compared`] : []),
		...(redirect ? [`it answers requests over http with a redirect to itself on another scheme (${cur.selfRedirect}), so no request reaches its handlers and nothing is compared: make plain http reach the handlers in this local copy. Switch off the app's or its web server's setting that forces https, in the copy's local config only (never the app's code): the comparison sends the same plain-http requests to both apps and compares what the handlers answer, it does not check the https rule, so keeping that rule on here only hides every handler. check_app_boot sends that request again and says whether it still redirects`] : []),
		...(setup ? [`a slice check found a problem that only its setup here causes (${cur.setupProblem}): fix that in its setup (start, data reset, data dump, local config), not in the app's code`] : []),
		...(space ? [`its data reset (${[cur.recipe!.reset!.cmd, ...cur.recipe!.reset!.args].join(" ")}) may restore from a full second copy of the data (a copied database, volume or folder). Find out with your tools what it restores from and how much disk that takes. When it is a full copy of a large database (more than a few GB), replace the restore from that copy with loading the schema and a small fixture (seed data with the test account and enough rows that pages show real data; record its files with set_fixture_files); once check_app_boot shows the app still starts, delete that copy: only that copy, never the data the app runs on or anything another project uses. When the reset costs little disk, keep it`] : []),
		...(fixture.length ? [fixtureText(o.config, o.root, o.side, fixture)] : []),
		...(boot ? [`it did not start for a slice check just now (${cur.bootProblem}). Find out why with your tools (is each service and container it needs running, does its reset script still work, what does the command print when you run it). Fix that in its setup here (start, data reset, the services it needs, local config), not in the app's code; check_app_boot shows whether it starts again. When the cause is the app's own code, change nothing and say so: that goes to whoever fixes the code`] : []),
	];
	const problem = fixUp ? `${problemFor(o.config, o.root, o.side)}\n\nThe app already starts with the saved recipe (${[cur.recipe!.start.cmd, ...cur.recipe!.start.args].join(" ")}, ready at ${cur.recipe!.ready}), but ${missing.join("; and ")}. Keep how it starts; fix what is missing and save the recipe again.` : problemFor(o.config, o.root, o.side);
	const said = await (o.fixer ?? findAppBootWithModel)({ config: o.config, root: o.root, side: o.side, appDir, problem }).catch((e) => `setup model failed: ${e?.message ?? e}`);
	const recipe = loadApps(o.root)[o.side]?.recipe;
	// the copy may have been made during the session: the root is read again
	const bad = recipe ? recipeProblem(o.config, o.root, o.side, recipe) : "no recipe saved";
	const res: { ok: boolean; error?: string; dumpFailed?: boolean; redirectFailed?: boolean } = bad || !recipe ? { ok: false, error: bad } : await checkRecipe(recipe, appRoot(o.config, o.root, o.side), { selfRedirect: redirect ? cur.selfRedirect : undefined });
	if (fixUp) {
		// the app started before: a new recipe that does not work is dropped, the old one stays; one that only fails
		// on its dump keeps the rest (the reset ran before the app came up, so it works)
		// one that starts and dumps but still redirects is kept too: it is no worse than the old one
		const kept = res.ok || (res.redirectFailed && !res.dumpFailed) ? recipe! : res.dumpFailed && recipe ? { ...recipe, dump: undefined } : cur.recipe!;
		// the redirect is gone when the check sent the request again and it was not redirected (also when only the dump failed)
		const redirectGone = redirect && !!recipe && !bad && !res.redirectFailed && (res.ok || !!res.dumpFailed);
		// a reset the fixture task saved loads a small fixture (it was told never a full copy): no space check for it
		saveApp(o.root, o.side, { up: true, recipe: kept, ...(lacksData ? { dataProbed: undefined, dataProbes: fixUps(cur, "data") + 1 } : {}), ...(redirect ? { redirectProbed: undefined, redirectProbes: fixUps(cur, "redirect") + 1, ...(redirectGone ? { selfRedirect: undefined } : {}) } : {}), ...(setup ? { setupProbed: undefined, setupProbes: fixUps(cur, "setup") + 1, ...(res.ok ? { setupProblem: undefined } : {}) } : {}), ...(boot ? { bootProbes: fixUps(cur, "boot") + 1, ...(res.ok ? { bootProblem: undefined } : {}) } : {}), ...(space ? { resetSpaceChecked: true } : {}), ...(fixture.length ? { fixtureProbes: fixUps(cur, "fixture") + 1, ...(res.ok ? { resetSpaceChecked: true, ...(o.side !== LEGACY ? { fixtureFor: legacyAt } : {}) } : {}) } : {}) });
		appendFileSync(join(parityDir(o.root), "probe.log"), `${new Date().toISOString()} ${o.side} → data: ${kept.reset && kept.dump ? "reset and dump added" : `still ${!kept.reset ? "no reset" : ""}${!kept.reset && !kept.dump ? ", " : ""}${!kept.dump ? "no dump" : ""}`}${redirect ? `; redirect to itself: ${redirectGone ? "gone" : "still there"}` : ""}${setup ? `; setup problem: ${res.ok ? "new recipe saved" : "old recipe kept"}` : ""}${boot ? `; did not start for a slice check: ${res.ok ? "starts again" : "still does not start"}` : ""}${space ? `; data reset: ${kept.reset ? "kept" : "dropped (it kept a full copy of the data)"}` : ""}${fixture.length ? `; strict parity fixture: ${res.ok && kept.reset ? "reset saved" : "still missing"} (${fixture.length} gap(s) asked)` : ""}${res.ok ? "" : ` (the new recipe failed: ${String(res.error).replace(/\s+/g, " ").slice(0, 300)})`}\n`);
		log(kept.dump ? pc.green(`parity: ${o.side === LEGACY ? "the old app" : `the new ${o.side} app`} can now ${kept.reset ? "reset and " : ""}dump its data`) : pc.yellow(`parity: ${o.side === LEGACY ? "the old app" : `the new ${o.side} app`} still cannot dump its data — written data is not compared`));
		return true;
	}
	const why = res.ok ? said || "it starts" : [said, res.error].filter(Boolean).join(" — ");
	saveApp(o.root, o.side, { up: res.ok, said: why, probeQuestion: undefined, commit, redProbes: res.ok ? 0 : (cur.redProbes ?? 0) + 1 });
	mkdirSync(parityDir(o.root), { recursive: true });
	appendFileSync(join(parityDir(o.root), "probe.log"), `${new Date().toISOString()} ${o.side} → ${res.ok ? "up" : "down"}: ${String(why).replace(/\s+/g, " ").slice(0, 600)}\n`);
	const name = o.side === LEGACY ? "the old app" : `the new ${o.side} app`;
	if (res.ok) {
		log(pc.green(`parity: ${name} starts here (${recipe!.ready})`));
		return true;
	}
	log(pc.yellow(`parity: ${name} could not be started here (${String(said || res.error).split("\n")[0]}) — parity checks stay off until it does`));
	// probed again only because main moved: the owner's open question still stands, no second one
	if (moved && !retry && !o.again && cur.probeQuestion !== undefined) return (saveApp(o.root, o.side, { probeQuestion: cur.probeQuestion }), false);
	const qid = await o
		.ask?.({
			facts: `To compare the old and the new app on the same requests, both must run here as local servers. A setup model tried to start ${name} and could not. What it said: ${said || "nothing"}. ${res.error ? `Code's check: ${String(res.error).slice(0, 600)}` : ""} The migration goes on without these checks.`,
			options: [
				{ value: "retry", facts: "I installed or set up what is missing: try again at the next probe" },
				{ value: "skip", facts: "keep going without comparing the apps" },
			],
			recommended: "skip",
		})
		.catch(() => undefined);
	if (qid !== undefined) saveApp(o.root, o.side, { probeQuestion: qid });
	return false;
}

/** Probe the old app, then each target stack's app in a fresh worktree of main. Returns which sides are up. */
export async function probeApps(o: { config: Config; root: string; linkAll: (wt: string) => void | Promise<void>; again?: boolean; fixer?: AppFixer; log?: (l: string) => void; ask?: ProbeAsker; answer?: ProbeAnswer }): Promise<Record<string, boolean>> {
	const up: Record<string, boolean> = {};
	up[LEGACY] = await probeApp({ ...o, side: LEGACY });
	const wt = await prepareTargetCopy(o.config, o.root, o.linkAll);
	try {
		for (const s of o.config.target.stacks) up[s] = await probeApp({ ...o, side: s });
	} finally {
		await removeWorktree(o.config.target.path, wt);
	}
	return up;
}

/**
 * For a slice check: an app that did not start (its data reset or start failed) goes to its setup model with what
 * failed (MAX_FIXUPS times at most until it starts for a slice check again). True when code then sees it start.
 * The owner's "retry" on the question asked once the fixes ran out gives them back.
 */
export const setupFixer = (o: { config: Config; root: string; fixer?: AppFixer; log?: (l: string) => void; answer?: ProbeAnswer }) => async (side: string, error: string): Promise<boolean> => {
	const q = loadApps(o.root)[side]?.bootQuestion;
	const retry = q !== undefined && o.answer?.(q) === "retry";
	saveApp(o.root, side, { bootProblem: error.slice(0, 1_500), ...(retry ? { bootProbes: undefined, bootQuestion: undefined } : {}) });
	await probeApp({ config: o.config, root: o.root, side, fixer: o.fixer, log: o.log });
	return !loadApps(o.root)[side]?.bootProblem;
};

/**
 * An app its setup could not get to start for slice checks, MAX_FIXUPS times: a person must look (a container tool or
 * database not running, say). Asked once; until the answer, `bootWaits` holds the slice checks (each would only fail
 * the same way). Returns whether a question is open now.
 */
export async function askBootOwner(o: { root: string; side: string; error: string; ask?: ProbeAsker }): Promise<boolean> {
	const a = loadApps(o.root)[o.side];
	if (!a?.bootProblem || fixUpLeft(a, "boot")) return false;
	if (a.bootQuestion !== undefined) return true;
	const name = o.side === LEGACY ? "the old app" : `the new ${o.side} app`;
	const qid = await o
		.ask?.({
			facts: `To compare the old and the new app, both must start here. ${name} stopped starting for slice checks, and its setup model tried ${MAX_FIXUPS} times to fix that without success. What failed last: ${o.error.slice(0, 600)} The migration goes on; slice comparisons wait until this is answered.`,
			options: [
				{ value: "retry", facts: "I fixed what it needs (started the service, the container tool, the database): try again" },
				{ value: "skip", facts: "keep going without comparing the apps" },
			],
			recommended: "retry",
		})
		.catch(() => undefined);
	if (qid === undefined) return false;
	saveApp(o.root, o.side, { bootQuestion: qid });
	return true;
}

/** The app whose start the owner was asked about and has not said "retry" yet: slice checks wait for that answer. */
export function bootWaits(apps: Record<string, AppState>, answer: ProbeAnswer): string | undefined {
	return Object.entries(apps).find(([, a]) => a.bootQuestion !== undefined && answer(a.bootQuestion) !== "retry")?.[0];
}

// ---- the test account ------------------------------------------------------------------------------------

/** How often an app's setup model is asked for a test account before the owner is asked (once). */
export const MAX_LOGIN_TRIES = 2;

const appName = (side: string) => (side === LEGACY ? "the old app" : `the new ${side} app`);

/** What the setup model is told when it should find or make a test account (a new app is told the old app's). */
function loginProblem(config: Config, root: string, side: string): string {
	const old = side === LEGACY ? undefined : loadApps(root)[LEGACY]?.login;
	const a = loadApps(root)[side];
	const where = side === LEGACY ? "the old app (it runs from the workspace copy; the legacy repo stays read-only)" : `the new ${side} app (${appRoot(config, root, side)})`;
	return [
		`The app already starts with the saved recipe${a?.recipe ? ` (ready at ${a.recipe.ready})` : ""}. Keep how it starts.`,
		`Now give the comparison a test account on ${where}. The same requests go to the old and the new app; without a login, every route behind the login only shows the login redirect, so their real answers are never compared.`,
		"Find one with your tools: a test or development user the project already has (fixtures, seeds, docs, env files, the data the app runs on here), or make one in this app's local data here (its own database copy, never the legacy repo and never data another project uses). Give it rights to see the app's pages. When the recipe has a data reset, the account must still be there after it (make it part of the reset).",
		...(old?.steps ? [`The old app's test account: user ${old.user ?? "?"}, password ${old.password ?? "?"}, logged in with ${JSON.stringify(old.steps)}${old.said ? ` (${old.said})` : ""}. Use the same account in this app's data when you can, so one login works on both.`] : []),
		"Check it with try_requests (it starts the app, sends the login and then a page behind it, stops it): that page must answer as logged in. Save it with set_test_login. When this app has no login of its own (it only serves files, say), save none with why.",
	].join("\n");
}

/**
 * Before a slice check: each app gets a test account from its setup model (MAX_LOGIN_TRIES at most), so the steps
 * can log in. The old app first; a new app is told the old app's account, to use the same one. Tries used up with no
 * account: the owner is asked once (a person may know or make one), "retry" gives the tries back. `sides`: the new
 * apps the check sends requests to; they run in the parity worktree, prepared here when one is asked.
 */
export async function ensureTestLogins(o: { config: Config; root: string; sides: string[]; linkAll: (wt: string) => void | Promise<void>; fixer?: AppFixer; log?: (l: string) => void; ask?: ProbeAsker; answer?: ProbeAnswer }): Promise<void> {
	const log = o.log ?? ((l: string) => console.log(l));
	const due = (side: string) => {
		const a = loadApps(o.root)[side];
		if (!a?.up || !a.recipe || a.login) return false;
		if (a.loginQuestion !== undefined && o.answer?.(a.loginQuestion) === "retry") saveApp(o.root, side, { loginTries: 0, loginQuestion: undefined });
		return (loadApps(o.root)[side]!.loginTries ?? 0) < MAX_LOGIN_TRIES;
	};
	const ask = async (side: string) => {
		const a = loadApps(o.root)[side];
		if (!a?.up || a.login || a.loginQuestion !== undefined || (a.loginTries ?? 0) < MAX_LOGIN_TRIES) return;
		const qid = await o
			.ask?.({
				facts: `To compare the old and the new app behind the login, the comparison needs a test account on ${appName(side)}. Its setup model looked ${MAX_LOGIN_TRIES} times and found or made none. Until there is one, routes behind the login are compared logged out only (both apps sending to the login page). The migration goes on.`,
				options: [
					{ value: "retry", facts: "I made a test account or wrote where one is (docs, env, fixtures): look again" },
					{ value: "skip", facts: "compare logged out only" },
				],
				recommended: "retry",
			})
			.catch(() => undefined);
		if (qid !== undefined) saveApp(o.root, side, { loginQuestion: qid });
	};
	const one = async (side: string) => {
		if (!due(side)) return ask(side);
		setStep(`parity: a test account for ${appName(side)}`);
		const said = await (o.fixer ?? findAppBootWithModel)({ config: o.config, root: o.root, side, appDir: appRoot(o.config, o.root, side), problem: loginProblem(o.config, o.root, side) }).catch((e) => `setup model failed: ${e?.message ?? e}`);
		const a = saveApp(o.root, side, { loginTries: (loadApps(o.root)[side]?.loginTries ?? 0) + 1 });
		appendFileSync(join(parityDir(o.root), "probe.log"), `${new Date().toISOString()} ${side} → test account: ${a.login ? (a.login.none ? `none needed (${a.login.none})` : `saved${a.login.user ? ` (${a.login.user})` : ""}`) : `none found: ${String(said ?? "").replace(/\s+/g, " ").slice(0, 300)}`}\n`);
		log(a.login ? pc.green(`parity: ${appName(side)} has a test account now`) : pc.yellow(`parity: no test account found for ${appName(side)} — routes behind the login are compared logged out`));
		await ask(side);
	};
	await one(LEGACY);
	// the new apps follow a known old account: without one there is nothing to log in with on both
	if (!loadApps(o.root)[LEGACY]?.login?.steps) return;
	const sides = o.sides.filter((s) => s !== LEGACY && due(s));
	for (const s of o.sides.filter((x) => x !== LEGACY && !sides.includes(x))) await ask(s);
	if (!sides.length) return;
	const wt = await prepareTargetCopy(o.config, o.root, o.linkAll);
	try {
		for (const s of sides) await one(s);
	} finally {
		await removeWorktree(o.config.target.path, wt);
	}
}

/** What the step writer is told about the test accounts. `login`: the old app has one, so the steps must log in. */
export function loginFacts(root: string, stacks: string[]): { text: string; login: boolean } {
	const apps = loadApps(root);
	if (!apps[LEGACY]?.login?.steps) return { text: "No test account is known yet: routes behind a login can only be compared logged out (their redirect to the login page).", login: false };
	const of = (side: string) => {
		const l = apps[side]?.login;
		if (!l) return `${appName(side)}: no account of its own known (try the old app's)`;
		if (l.none) return `${appName(side)}: no login of its own (${l.none})`;
		return `${appName(side)}: user ${l.user ?? "?"}, password ${l.password ?? "?"}; it logs in with ${JSON.stringify(l.steps)}${l.said ? ` (${l.said})` : ""}`;
	};
	return { text: `Test accounts (each app's setup found or made them in the data the apps run on here):\n${[LEGACY, ...stacks].map((s) => `- ${of(s)}`).join("\n")}`, login: true };
}
