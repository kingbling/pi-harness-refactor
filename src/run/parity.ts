import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import pc from "picocolors";
import { Type } from "typebox";
import type { Config } from "../config.ts";
import { addWorktree, headOf, removeWorktree } from "../git.ts";
import { projectDir } from "../init/init.ts";
import { loadDecisions } from "../inventory/decisions.ts";
import { PLAIN_LANGUAGE } from "../policy.ts";
import { spawnLeaf } from "../sessions/spawn.ts";
import { legacyCopyTool, loadLegacyEnv, ownerPreference, type ProbeAnswer, type ProbeAsker } from "./legacy-env.ts";

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
	dump?: { cmd: string; args: string[] };
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
	at?: string;
}

export const LEGACY = "legacy";
const parityDir = (root: string) => join(root, ".bigrefactor", "parity");
const appsPath = (root: string) => join(parityDir(root), "apps.json");

export function loadApps(root: string): Record<string, AppState> {
	try {
		return JSON.parse(readFileSync(appsPath(root), "utf8")) as Record<string, AppState>;
	} catch {
		return {};
	}
}

function saveApp(root: string, side: string, change: Partial<AppState>): AppState {
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
const TARGET_BRANCH = "parity/main";

/** A fresh worktree of main for the new app (dependencies linked like a unit's). */
export function prepareTargetCopy(config: Config, root: string, linkAll: (wt: string) => void): string {
	const wt = targetWorktree(root);
	removeWorktree(config.target.path, wt);
	try {
		execFileSync("git", ["-C", config.target.path, "branch", "-q", "-D", TARGET_BRANCH], { stdio: "pipe" });
	} catch {
		/* no branch */
	}
	addWorktree(config.target.path, wt, TARGET_BRANCH);
	linkAll(wt);
	return wt;
}

// ---- starting and stopping an app ------------------------------------------------------------------------

export type Booted = { ok: true; stop: () => Promise<void> } | { ok: false; error: string };

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
export async function bootApp(recipe: AppRecipe, appDir: string, o: { timeoutMs?: number } = {}): Promise<Booted> {
	if (!isLocal(recipe.ready)) return { ok: false, error: `the ready URL must be on this machine (http://localhost:<port>/…), got ${recipe.ready}` };
	if (await answers(recipe.ready)) return { ok: false, error: `something already answers on ${recipe.ready} before the app was started: pick a free port (or stop what runs there)` };
	const cwd = resolve(appDir, recipe.dir);
	if (!existsSync(cwd)) return { ok: false, error: `folder ${cwd} does not exist` };
	if (recipe.reset)
		try {
			execFileSync(recipe.reset.cmd, recipe.reset.args, { cwd, env: { ...process.env, ...recipe.env }, timeout: 300_000, stdio: "pipe" });
		} catch (e: any) {
			return { ok: false, error: `the data reset failed: ${[e?.stderr, e?.stdout].map((x) => String(x ?? "").trim()).filter(Boolean).join("\n").slice(-800) || e?.message}` };
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
				execFileSync(recipe.stop.cmd, recipe.stop.args, { cwd, env: { ...process.env, ...recipe.env }, timeout: 120_000, stdio: "pipe" });
			} catch {
				/* best effort: the next boot's port check catches a leftover */
			}
	};
	const deadline = Date.now() + (o.timeoutMs ?? 180_000);
	while (Date.now() < deadline) {
		if (spawnError) return (await stop(), { ok: false, error: `could not start ${recipe.start.cmd}: ${spawnError}` });
		if (exit !== undefined && exit !== 0) return (await stop(), { ok: false, error: `the start command exited with ${exit} before the app answered:\n${tail.join("\n")}` });
		if (await answers(recipe.ready)) return { ok: true, stop };
		await new Promise((r) => setTimeout(r, 1_000));
	}
	await stop();
	return { ok: false, error: `no answer on ${recipe.ready} after ${Math.round((o.timeoutMs ?? 180_000) / 1000)}s:\n${tail.join("\n")}` };
}

/** Start, check, stop: what code (and the model's check_app_boot) runs to decide a recipe works. */
export async function checkRecipe(recipe: AppRecipe, appDir: string, o: { timeoutMs?: number } = {}): Promise<{ ok: boolean; error?: string }> {
	const b = await bootApp(recipe, appDir, o);
	if (!b.ok) return b;
	try {
		if (recipe.dump) dumpData(recipe, appDir);
	} catch (e: any) {
		return { ok: false, error: `the app starts, but the data dump fails: ${String(e?.message ?? e).slice(-800)}` };
	} finally {
		await b.stop();
	}
	return { ok: true };
}

/** The app's data as {table: rows}, from the recipe's dump command. Throws when it prints anything else. */
export function dumpData(recipe: AppRecipe, appDir: string): Record<string, unknown[]> {
	if (!recipe.dump) return {};
	const outText = execFileSync(recipe.dump.cmd, recipe.dump.args, { cwd: resolve(appDir, recipe.dir), env: { ...process.env, ...recipe.env }, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
	const data = JSON.parse(outText.slice(outText.indexOf("{"))) as unknown;
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
	dumpCmd: Type.Optional(Type.String({ description: 'prints the app\'s data as JSON {"table": [rows ordered by primary key]}, nothing else on stdout' })),
	dumpArgs: Type.Optional(Type.Array(Type.String())),
	env: Type.Optional(Type.Record(Type.String(), Type.String())),
	why: Type.Optional(Type.String()),
});
type RecipeInput = { dir: string; cmd: string; args: string[]; ready: string; stopCmd?: string; stopArgs?: string[]; resetCmd?: string; resetArgs?: string[]; dumpCmd?: string; dumpArgs?: string[]; env?: Record<string, string>; why?: string };
const toRecipe = (p: RecipeInput): AppRecipe => ({
	dir: p.dir || ".",
	start: { cmd: p.cmd, args: p.args },
	ready: p.ready,
	...(p.stopCmd ? { stop: { cmd: p.stopCmd, args: p.stopArgs ?? [] } } : {}),
	...(p.resetCmd ? { reset: { cmd: p.resetCmd, args: p.resetArgs ?? [] } } : {}),
	...(p.dumpCmd ? { dump: { cmd: p.dumpCmd, args: p.dumpArgs ?? [] } } : {}),
	...(p.env ? { env: p.env } : {}),
});

/** Why this recipe cannot be used for this side, or undefined. Checked by code, before anything starts. */
export function recipeProblem(config: Config, root: string, side: string, r: AppRecipe): string | undefined {
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
		description: "Start the app with this recipe, wait until the ready URL answers (up to 3 minutes), then stop it. Says whether it came up, with the start command's output when it did not. Use it to try a recipe before saving it.",
		promptSnippet: "check_app_boot: start the app with a recipe, check the ready URL answers, stop it",
		parameters: RecipeParams,
		execute: async (_id: string, p: RecipeInput) => {
			const r = toRecipe(p);
			const bad = recipeProblem(config, root, side, r);
			if (bad) return out(`refused: ${bad}`);
			const res = await checkRecipe(r, appRoot(config, root, side));
			return out(res.ok ? `up: ${r.ready} answered; the app was stopped again` : `not up: ${res.error}`);
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
	return [check, set] as unknown as ToolDefinition[];
}

// ---- the probe -------------------------------------------------------------------------------------------

/** Returns the model's one-sentence account of what it found. */
export type AppFixer = (o: { config: Config; root: string; side: string; appDir: string; problem: string }) => Promise<string | void>;

export const findAppBootWithModel: AppFixer = async (o) => {
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
		customTools: [...(legacy ? [legacyCopyTool(o.root, o.config)] : []), ...appBootTools(o.config, o.root, o.side)],
		transcriptPath: join(o.root, ".bigrefactor", "sessions", `__parity__.${o.side}.${Date.now()}.jsonl`),
		systemPrompt: `You find out how to start ${legacy ? `the OLD app (${o.config.source.stack})` : `the NEW ${o.side} project of a migration`} as a local server, so a migration tool can send the same HTTP requests to the old and the new app and compare the answers. Read what the project itself says (README and docs, compose and container files, package or build manifests, scripts, the framework's own dev server) and check which tools this machine really has (versions, docker) before choosing a way. ${legacy ? `The legacy repo (${o.config.source.path}) is read-only: call make_legacy_copy first, then install and start everything in the copy. ` : ""}Try recipes with check_app_boot (it starts the app, waits for the ready URL and stops it), save the one that works with set_app_boot. Never start the app server yourself in bash and never leave it running; a database the app needs may be started and may stay up. Never interactive prompts. End with one sentence saying how the app starts, or exactly what is missing.\n\n${PLAIN_LANGUAGE}`,
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
		? ` The app uses ${config.db.from.join(" + ") || "a database"}${config.db.to && side !== LEGACY ? ` (the new app: ${config.db.to})` : ""}; schema/data inputs from setup (relative to the old repo ${config.source.path}): ${[...config.db.schemaFiles, ...(config.db.snapshot ? [config.db.snapshot] : [])].join(", ") || "none given"}. Start a database with that schema (and data, when there is a snapshot) if the app needs one to answer. Then also give the recipe a reset (puts that data back to its starting state, so every run starts the same) and a dump (prints the data as JSON {"table": [rows ordered by primary key]}): the tool compares what each app writes.`
		: "";
	const where = side === LEGACY ? `The old app's root (after make_legacy_copy): the copy.` : `The new project is at ${appRoot(config, root, side)} (a worktree of the migration's main branch; its dependencies are linked in).`;
	return `Find out whether this app can be started here as a local server that answers HTTP requests on this machine. ${where}${db}${ports.length ? ` Both apps run at the same time: ${ports.join(", ")}; use another port.` : ""} The app does not have to be complete: any answer on the ready URL (a login page, a redirect, a 404 from the framework) proves it runs. When the app is no HTTP server at all (a command-line tool, a library), say so and stop. Try more than one way before giving up.`;
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
	const commit = o.side === LEGACY ? undefined : headOf(o.config.target.path);
	const moved = cur.up === false && commit !== undefined && commit !== cur.commit && (cur.redProbes ?? 0) < MAX_RED_PROBES;
	if (cur.up !== undefined && !retry && !moved && !o.again) return cur.up;
	const appDir = appRoot(o.config, o.root, o.side);
	const said = await (o.fixer ?? findAppBootWithModel)({ config: o.config, root: o.root, side: o.side, appDir, problem: problemFor(o.config, o.root, o.side) }).catch((e) => `setup model failed: ${e?.message ?? e}`);
	const recipe = loadApps(o.root)[o.side]?.recipe;
	// the copy may have been made during the session: the root is read again
	const bad = recipe ? recipeProblem(o.config, o.root, o.side, recipe) : "no recipe saved";
	const res = bad || !recipe ? { ok: false, error: bad } : await checkRecipe(recipe, appRoot(o.config, o.root, o.side));
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
export async function probeApps(o: { config: Config; root: string; linkAll: (wt: string) => void; again?: boolean; fixer?: AppFixer; log?: (l: string) => void; ask?: ProbeAsker; answer?: ProbeAnswer }): Promise<Record<string, boolean>> {
	const up: Record<string, boolean> = {};
	up[LEGACY] = await probeApp({ ...o, side: LEGACY });
	const wt = prepareTargetCopy(o.config, o.root, o.linkAll);
	try {
		for (const s of o.config.target.stacks) up[s] = await probeApp({ ...o, side: s });
	} finally {
		removeWorktree(o.config.target.path, wt);
	}
	return up;
}
