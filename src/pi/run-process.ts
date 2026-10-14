import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PromptOption } from "../init/init.ts";
import { progress, type ProgressSnapshot } from "../progress.ts";

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
 * here as dialogs (`ask`). Resolves when the child is gone; an unexpected exit is an error. `progress.begin` comes first.
 */
export function runInChild(args: ChildArgs, o: { ask?: (q: Ask) => Promise<string | undefined>; decisionsDone?: () => void } = {}): Promise<{ error?: string; lines?: string[] }> {
	const entry = fileURLToPath(new URL("../run/run-child.ts", import.meta.url));
	// the package has no build step: the child loads its .ts through tsx, like bin/br.js does
	const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
	const child = fork(entry, [JSON.stringify(args)], { cwd: args.cwd, execArgv: ["--import", tsx], stdio: ["ignore", "pipe", "pipe", "ipc"], detached: false, env: { ...process.env, BR_RUN_CHILD: "1", FORCE_COLOR: "0" } });
	const send = (m: ToChild) => {
		if (child.connected) child.send(m);
	};
	// whatever the child prints lands in the feed, never on Pi's screen
	for (const s of [child.stdout, child.stderr]) if (s) createInterface({ input: s }).on("line", (l) => progress.log(l));
	progress.follow({ stop: (mode) => send({ type: mode === "drain" ? "stop" : "abort" }), log: (line) => send({ type: "log", line }) });
	let done: { error?: string; lines?: string[] } | undefined;
	child.on("message", (m: FromChild) => {
		if (m.type === "progress") progress.mirror(m.snap);
		else if (m.type === "decisions-done") o.decisionsDone?.();
		else if (m.type === "done") done = { error: m.error, lines: m.lines };
		else if (m.type === "ask") {
			const ask = o.ask ?? (async () => undefined);
			void ask(m)
				.catch(() => undefined)
				.then((value) => send({ type: "answer", id: m.id, value }));
		}
	});
	return new Promise((resolve) => {
		const end = (why: string) => {
			progress.follow(undefined);
			if (done) return resolve(done);
			const error = `the run process ended unexpectedly (${why})`;
			progress.log(error);
			resolve({ error });
		};
		// a child that could not start has no exit to wait for
		child.on("error", (e) => child.pid === undefined && end(e.message));
		child.on("exit", (code, signal) => end(signal ? `signal ${signal}` : `exit code ${code}`));
	});
}
