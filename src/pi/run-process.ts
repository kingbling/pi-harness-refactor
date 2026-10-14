import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PromptOption } from "../init/init.ts";
import { progress, type ProgressSnapshot } from "../progress.ts";
import { startWatchdog } from "../run/watchdog.ts";

/** How long an aborted run process gets to end before it is killed. */
export const ABORT_KILL_MS = 60_000;

/** What Pi hands the run process (src/run/run-child.ts). */
export interface ChildArgs {
	cwd: string;
	/** /br run flags: --limit, --slice, --units, --dry, --force. */
	flags: string[];
	/** Pi shows dialogs: the run asks open decisions on the side and waits for answers when only those are left. */
	hasUI: boolean;
	/** Job name the panel shows. */
	job: string;
}
export interface Ask {
	id: string;
	prompt: string;
	options: PromptOption[];
	recommended?: string;
}
export type FromChild =
	| { type: "progress"; snap: ProgressSnapshot }
	| ({ type: "ask" } & Ask)
	| { type: "decisions-done" }
	| { type: "done"; ok?: boolean; error?: string; lines?: string[] };
export type ToChild = { type: "stop" } | { type: "abort" } | { type: "log"; line: string } | { type: "answer"; id: string; value?: string };

/**
 * Run the migration in its own process, so none of its work holds Pi's thread. The child's progress is mirrored into
 * this process's `progress` (the panel and footer read it unchanged), /br stop reaches the child, its decisions come
 * here as dialogs (`ask`). Resolves at the child's `done` (or its exit: an exit without `done` is an error). `progress.begin` comes first.
 */
export function runInChild(args: ChildArgs, o: { ask?: (q: Ask) => Promise<string | undefined>; decisionsDone?: () => void; abortKillMs?: number } = {}): Promise<{ error?: string; lines?: string[] }> {
	const entry = fileURLToPath(new URL("../run/run-child.ts", import.meta.url));
	// the package has no build step: the child loads its .ts through tsx, like bin/br.js does
	const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
	const child = fork(entry, [JSON.stringify(args)], { cwd: args.cwd, execArgv: ["--import", tsx], stdio: ["ignore", "pipe", "pipe", "ipc"], detached: false, env: { ...process.env, BR_RUN_CHILD: "1", FORCE_COLOR: "0" } });
	// Pi's own freezes while the run goes on land in the same blocked.log as "Pi was blocked"
	const stopWatchdog = startWatchdog(args.cwd, (l) => progress.log(l), { step: "Pi drawing the run" });
	const send = (m: ToChild) => {
		if (child.connected) child.send(m);
	};
	// whatever the child prints lands in the feed, never on Pi's screen
	let over = false;
	for (const s of [child.stdout, child.stderr]) if (s) createInterface({ input: s }).on("line", (l) => !over && progress.log(l));
	let done: { error?: string; lines?: string[] } | undefined;
	let resolveRun!: (o: { error?: string; lines?: string[] }) => void;
	const ended = new Promise<{ error?: string; lines?: string[] }>((r) => (resolveRun = r));
	// the job here ends at the child's `done` (it may stay a moment to save a decision dialog still open here) or exit
	const end = (out: { error?: string; lines?: string[] }) => {
		if (over) return;
		over = true;
		stopWatchdog();
		progress.follow(undefined);
		resolveRun(out);
	};
	// an abort the child does not finish within a minute (a tool that never returns): the whole run process goes
	let killTimer: NodeJS.Timeout | undefined;
	const abort = () => {
		send({ type: "abort" });
		killTimer ??= setTimeout(() => {
			progress.log("the run process did not end within a minute of the abort: killed");
			child.kill("SIGKILL");
		}, o.abortKillMs ?? ABORT_KILL_MS);
		killTimer.unref();
	};
	progress.follow({ stop: (mode) => (mode === "drain" ? send({ type: "stop" }) : abort()), log: (line) => send({ type: "log", line }) });
	// a /br stop that came while the child was being started
	if (progress.stopping) progress.aborting ? abort() : send({ type: "stop" });
	child.on("message", (m: FromChild) => {
		if (m.type === "progress") {
			if (!over) progress.mirror(m.snap);
		} else if (m.type === "decisions-done") o.decisionsDone?.();
		else if (m.type === "done") end((done = { error: m.error, lines: m.lines }));
		else if (m.type === "ask") {
			const ask = o.ask ?? (async () => undefined);
			void ask(m)
				.catch(() => undefined)
				.then((value) => send({ type: "answer", id: m.id, value }));
		}
	});
	const gone = (why: string) => {
		if (done || over) return end(done ?? {});
		const error = `the run process ended unexpectedly (${why})`;
		progress.log(error);
		end({ error });
	};
	// a child that could not start has no exit to wait for
	child.on("error", (e) => child.pid === undefined && gone(e.message));
	child.on("exit", (code, signal) => (clearTimeout(killTimer), gone(signal ? `signal ${signal}` : `exit code ${code}`)));
	return ended;
}
