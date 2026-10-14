import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PromptOption } from "../init/init.ts";
import { progress, type ProgressSnapshot } from "../progress.ts";
import { pluginHead, waitForNewCode } from "../run/plugin-head.ts";
import { startWatchdog } from "../run/watchdog.ts";

/** How long an aborted run process gets to end before it is killed. */
export const ABORT_KILL_MS = 60_000;
/** A run process started again on new code that ends with an error within this time failed at start: the run waits for the next commit. */
export const FAILED_START_MS = 60_000;

/** What Pi hands the run process (src/run/run-child.ts). */
export interface ChildArgs {
	cwd: string;
	/** /br run flags: --limit, --slice, --units, --dry, --force. */
	flags: string[];
	/** Pi shows dialogs: the run asks open decisions on the side and waits for answers when only those are left. */
	hasUI: boolean;
	/** Job name the panel shows. */
	job: string;
	/** The feed of the run before, when the run starts again on new plugin code. */
	feed?: string[];
}
export interface Ask {
	id: string;
	prompt: string;
	options: PromptOption[];
	recommended?: string;
}
type Done = { type: "done"; ok?: boolean; error?: string; lines?: string[]; restart?: boolean };
export type FromChild = { type: "progress"; snap: ProgressSnapshot } | ({ type: "ask" } & Ask) | { type: "decisions-done" } | Done;
export type ToChild = { type: "stop" } | { type: "abort" } | { type: "log"; line: string } | { type: "answer"; id: string; value?: string } | { type: "hello" };
/** `detached`: this Pi runtime let go of a run that goes on (a /reload); the next runtime shows it. */
export interface RunOutcome {
	error?: string;
	lines?: string[];
	detached?: boolean;
}

/**
 * The live run process. It outlives a /reload of the extension (Pi's process stays, a reload loads this module
 * fresh), so it is kept on globalThis, not in a module variable. What the child said or how it ended is noted here
 * by listeners that stay, so nothing is lost while no runtime listens.
 */
interface Live {
	args: ChildArgs;
	child?: ChildProcess;
	done?: Done;
	gone?: string;
	/** The plugin commit the child started on, and when. */
	head?: string;
	startedAt: number;
	/** The child was started again on new code (a failed start then waits for the next commit). */
	restarted: boolean;
	/** A restarted run that failed at start waits for the next plugin commit. */
	waitFix?: { head?: string; error: string };
	/** The runtime showing the run lets go of it (session_shutdown). */
	detach?: () => void;
}
const KEY = Symbol.for("bigrefactor.run-process");
const store = globalThis as { [KEY]?: Live };
/** A run process a runtime before this one started (or this one), still going on. */
export function liveRunProcess(): Pick<Live, "args"> | undefined {
	return store[KEY];
}
/** This runtime goes away (Pi's /reload): stop showing the run, keep it going. */
export function detachRunProcess(): void {
	store[KEY]?.detach?.();
}

/** Start the run process; `again`: it is started again (new code), the feed of the one before goes on in it, ending with this line. */
function startChild(live: Live, head: string | undefined, again?: string): ChildProcess {
	if (again) live.args = { ...live.args, feed: [...progress.snapshot().activity.slice(-60), again] };
	const entry = fileURLToPath(new URL("../run/run-child.ts", import.meta.url));
	// the package has no build step: the child loads its .ts through tsx, like bin/br.js does
	const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
	const child = fork(entry, [JSON.stringify(live.args)], { cwd: live.args.cwd, execArgv: ["--import", tsx], stdio: ["ignore", "pipe", "pipe", "ipc"], detached: false, env: { ...process.env, BR_RUN_CHILD: "1", FORCE_COLOR: "0" } });
	Object.assign(live, { child, done: undefined, gone: undefined, head, startedAt: Date.now() });
	child.on("message", (m: FromChild) => m.type === "done" && (live.done = m));
	child.on("error", (e) => child.pid === undefined && (live.gone ??= e.message));
	child.on("exit", (code, signal) => (live.gone ??= signal ? `signal ${signal}` : `exit code ${code}`));
	return child;
}

/**
 * Run the migration in its own process, so none of its work holds Pi's thread. The child's progress is mirrored into
 * this process's `progress` (the panel and footer read it unchanged), /br stop reaches the child, its decisions come
 * here as dialogs (`ask`). Resolves at the child's `done` (or its exit: an exit without `done` is an error). `progress.begin` comes first.
 * A child that ends for new plugin code (`done.restart`) is started again with the same args; `attach` shows a run
 * process a runtime before this one started (after Pi's /reload) instead of starting one.
 */
export async function runInChild(args: ChildArgs, o: { ask?: (q: Ask) => Promise<string | undefined>; decisionsDone?: () => void; abortKillMs?: number; attach?: boolean } = {}): Promise<RunOutcome> {
	const old = o.attach ? store[KEY] : undefined;
	const live: Live = old ?? { args, startedAt: Date.now(), restarted: false };
	store[KEY] = live;
	let detached = false;
	let letGo: (() => void) | undefined;
	live.detach = () => {
		detached = true;
		letGo?.();
	};
	// Pi's own freezes while the run goes on land in the same blocked.log as "Pi was blocked"
	const stopWatchdog = startWatchdog(live.args.cwd, (l) => progress.log(l), { step: "Pi drawing the run" });
	const send = (m: ToChild) => {
		const c = live.child;
		if (c?.connected) c.send(m);
	};
	// an abort the child does not finish within a minute (a tool that never returns): the whole run process goes
	let killTimer: NodeJS.Timeout | undefined;
	const abort = () => {
		send({ type: "abort" });
		const c = live.child;
		killTimer ??= setTimeout(() => {
			progress.log("the run process did not end within a minute of the abort: killed");
			c?.kill("SIGKILL");
		}, o.abortKillMs ?? ABORT_KILL_MS);
		killTimer.unref();
	};
	progress.follow({ stop: (mode) => (mode === "drain" ? send({ type: "stop" }) : abort()), log: (line) => send({ type: "log", line }) });
	// one dialog per decision, whichever run process asked: its answer goes to the run process of the moment
	const open = new Set<string>();
	const onAsk = (m: Ask) => {
		if (open.has(m.id)) return;
		open.add(m.id);
		void (o.ask ?? (async () => undefined))(m)
			.catch(() => undefined)
			.then((value) => {
				open.delete(m.id);
				// a dialog of a runtime that let go: the next runtime asked again
				if (!detached) send({ type: "answer", id: m.id, value });
			});
	};

	let saidDone = false;
	let hello = !!old;
	/** Show one child until its done, its exit, or this runtime lets go. */
	const follow = (child: ChildProcess) =>
		new Promise<RunOutcome & { restart?: boolean }>((resolve) => {
			let over = false;
			// whatever the child prints lands in the feed, never on Pi's screen
			const rls = [child.stdout, child.stderr].flatMap((s) => (s ? [createInterface({ input: s })] : []));
			for (const rl of rls) rl.on("line", (l) => !over && progress.log(l));
			const finish = (out: RunOutcome & { restart?: boolean }) => {
				if (over) return;
				over = true;
				child.off("message", onMessage);
				child.off("exit", onGone);
				child.off("error", onError);
				for (const rl of rls) rl.close();
				letGo = undefined;
				resolve(out);
			};
			const fromDone = (d: Done) => ({ error: d.error, lines: d.lines, restart: d.restart });
			const onMessage = (m: FromChild) => {
				if (m.type === "progress") {
					if (!over) progress.mirror(m.snap);
				} else if (m.type === "decisions-done") {
					// once per run: a run process started again (or shown again) says it again
					if (!saidDone) o.decisionsDone?.();
					saidDone = true;
				}
				else if (m.type === "done") finish(fromDone(m));
				else if (m.type === "ask") onAsk(m);
			};
			const onGone = () => {
				if (live.done) return finish(fromDone(live.done));
				const error = `the run process ended unexpectedly (${live.gone})`;
				progress.log(error);
				finish({ error });
			};
			// a child that could not start has no exit to wait for
			const onError = () => child.pid === undefined && onGone();
			child.on("message", onMessage);
			child.on("exit", onGone);
			child.on("error", onError);
			letGo = () => finish({ detached: true });
			// it ended while no runtime listened (between a reload's two runtimes)
			if (live.done) return finish(fromDone(live.done));
			if (live.gone) return onGone();
			// a run shown again: its latest state, its open dialog, whether its decisions are through
			if (hello) send({ type: "hello" });
			hello = false;
			// a /br stop that came while the child was being started
			if (progress.stopping) progress.aborting ? abort() : send({ type: "stop" });
		});

	try {
		for (;;) {
			if (detached) return { detached: true };
			if (live.waitFix) {
				const fix = live.waitFix;
				progress.wait("waiting for a fix: the run starts again at the next plugin commit");
				const to = await waitForNewCode(fix.head, () => progress.stopping || detached);
				progress.wait(undefined);
				if (detached) return { detached: true };
				if (!to) return { error: fix.error };
				live.waitFix = undefined;
				startChild(live, to, `run started again on the new code (${to.slice(0, 7)})`);
			}
			if (!live.child) startChild(live, await pluginHead());
			const out = await follow(live.child!);
			if (out.detached) return out;
			clearTimeout(killTimer);
			killTimer = undefined;
			// the owner's stop wins over new code
			if (out.restart && !progress.stopping) {
				live.restarted = true;
				const head = await pluginHead();
				startChild(live, head, `run started again on the new code (${head?.slice(0, 7) ?? "?"})`);
				continue;
			}
			if (out.error && live.restarted && !progress.stopping && Date.now() - live.startedAt < FAILED_START_MS) {
				progress.log(`the run on the new code failed at start: ${out.error.split("\n")[0]}; it starts again at the next plugin commit (/br stop ends it)`);
				live.waitFix = { head: live.head, error: out.error };
				live.child = undefined;
				continue;
			}
			return { error: out.error, lines: out.lines };
		}
	} finally {
		stopWatchdog();
		live.detach = undefined;
		// a run that ended is no longer there to show again; one let go of stays for the next runtime
		if (!detached && store[KEY] === live) delete store[KEY];
		progress.follow(undefined);
	}
}
