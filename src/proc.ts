import { spawn } from "node:child_process";
import { progress } from "./progress.ts";

/**
 * Run a long external command (official generators, package installs) without blocking the event loop.
 * A blocking (sync) launch freezes the whole host: inside Pi that means no widget updates, no chat and no
 * stop for the minutes `nest new` takes. While a tracked job runs, output goes line by line into the
 * progress feed instead of the terminal (raw writes corrupt the TUI); otherwise it streams to stdio as before.
 * Rejects with the command's tail output on a non-zero exit.
 * Silence is reported, not guessed at: every 30 s without output the feed says the command still runs (slow
 * downloads look like a hang); after `idleKillMs` (default 15 min) without any output it is stopped as hung
 * (only when output is captured: with inherited stdio the silence cannot be seen).
 */
/**
 * Who owns the terminal. "ui": a full-screen host (Pi) draws it; a child process that writes to it directly breaks
 * the screen (a PHP warning over the status bar), so every command's output is captured, whatever the tool.
 * "terminal": the plain CLI; untracked output may stream through as before.
 */
let outputHost: "terminal" | "ui" = "terminal";
export function setOutputHost(host: "terminal" | "ui"): void {
	outputHost = host;
}
export const outputCaptured = () => outputHost === "ui" || progress.running;

export function runCommand(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; idleKillMs?: number }): Promise<void> {
	return new Promise((resolve, reject) => {
		const tracked = outputCaptured();
		// stdin is never the terminal: generators must not prompt (CI=1 makes most of them non-interactive too).
		// Detached process group so a stop kills the whole tree (pnpm → create-x → dev server), not just the wrapper.
		const child = spawn(cmd, args, { cwd: opts.cwd, detached: true, env: { ...process.env, ...(opts.env ?? {}), CI: "1", ...(tracked ? { FORCE_COLOR: "0" } : {}) }, stdio: tracked ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"] });
		const tail: string[] = [];
		const started = Date.now();
		let lastOutput = started;
		let hung = false;
		const idleKillMs = opts.idleKillMs ?? 15 * 60_000;
		const secs = (ms: number) => (ms < 120_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)} min`);
		// Kill the whole group; SIGKILL follows if SIGTERM is ignored.
		let killTimer: NodeJS.Timeout | undefined;
		const killTree = () => {
			const sig = (s: NodeJS.Signals) => {
				try {
					if (child.pid) process.kill(-child.pid, s);
				} catch {
					child.kill(s);
				}
			};
			sig("SIGTERM");
			killTimer ??= setTimeout(() => sig("SIGKILL"), 10_000);
			killTimer.unref();
		};
		const watch = setInterval(() => {
			const quiet = Date.now() - lastOutput;
			// Only piped output can be seen; with inherited stdio silence says nothing, so no idle kill there.
			if (tracked && quiet >= idleKillMs && child.exitCode === null && child.pid) {
				hung = true;
				progress.log(`  ${cmd} │ no output for ${secs(quiet)}: stopping it as hung`);
				killTree();
			} else if (quiet >= 30_000 && tracked) progress.log(`  ${cmd} │ … still running (${secs(Date.now() - started)} total, no new output for ${secs(quiet)}; downloads can be slow)`);
		}, 30_000);
		const feed = (chunk: Buffer) => {
			lastOutput = Date.now();
			for (const line of chunk.toString("utf8").split(/\r?\n|\r/)) {
				if (!line.trim()) continue;
				tail.push(line);
				if (tail.length > 30) tail.shift();
				progress.log(`  ${cmd} │ ${line}`);
			}
		};
		child.stdout?.on("data", feed);
		child.stderr?.on("data", feed);
		const onStop = progress.subscribe((s) => {
			if (s.stopping && progress.aborting && child.exitCode === null && child.pid) killTree();
		});
		let settled = false;
		let exitGrace: NodeJS.Timeout | undefined;
		const finish = (err?: Error) => {
			if (settled) return;
			settled = true;
			clearInterval(watch);
			clearTimeout(exitGrace);
			onStop();
			// Let go of pipes a leftover grandchild may still hold.
			child.stdout?.destroy();
			child.stderr?.destroy();
			if (err) reject(err);
			else resolve();
		};
		const done = (code: number | null, signal: NodeJS.Signals | null) =>
			finish(code === 0 ? undefined : new Error(`${cmd} ${args.slice(0, 3).join(" ")} ${hung ? `hung (no output for ${secs(idleKillMs)})` : "failed"} (${signal ?? `exit ${code}`})${tail.length ? `:\n${tail.slice(-8).join("\n")}` : ""}`));
		child.on("error", (e) => finish(e));
		child.on("close", done);
		// A background grandchild (a server, a watcher) can hold the pipes open so "close" never comes:
		// settle a little after the main process exits anyway.
		child.on("exit", (code, signal) => {
			exitGrace = setTimeout(() => done(code, signal), 2_000);
		});
	});
}

/** Error from `exec`: the same fields a sync launch's error had, so existing catch blocks keep working. */
export type ExecError = Error & { stdout: string; stderr: string; status: number | null; signal: NodeJS.Signals | null; code?: string };

/**
 * The awaited stand-in for a sync launch: runs a command and resolves with its stdout (not trimmed). A sync launch
 * freezes Pi's screen for as long as the command runs, so nothing in the plugin launches one.
 * Rejects like the sync call threw: `status`, `signal`, `stdout`, `stderr` on the error (and `code`, e.g. ENOENT,
 * when the command could not start). `stdout` may be a file descriptor: output then goes there, not to the result.
 * `maxBuffer` defaults to node's 1 MiB; `timeout` kills with SIGTERM, as the sync call did.
 */
export function exec(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number; stdout?: number } = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		const maxBuffer = opts.maxBuffer ?? 1024 * 1024;
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let outLen = 0;
		let errLen = 0;
		let failure: string | undefined;
		let settled = false;
		const fd = opts.stdout ?? "pipe"; // stdout into a file the caller opened, else captured
		const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", fd, "pipe"] });
		const timer = opts.timeout
			? setTimeout(() => {
					failure ??= "ETIMEDOUT";
					child.kill("SIGTERM");
				}, opts.timeout)
			: undefined;
		const take = (into: Buffer[], add: (n: number) => number) => (chunk: Buffer) => {
			if (add(chunk.length) > maxBuffer) {
				failure ??= "ENOBUFS";
				child.kill("SIGTERM");
				return;
			}
			into.push(chunk);
		};
		child.stdout?.on("data", take(out, (n) => (outLen += n)));
		child.stderr?.on("data", take(err, (n) => (errLen += n)));
		const fail = (e: Partial<ExecError> & Error, status: number | null, signal: NodeJS.Signals | null) => {
			const x = e as ExecError;
			x.stdout = Buffer.concat(out).toString("utf8");
			x.stderr = Buffer.concat(err).toString("utf8");
			x.status = status;
			x.signal = signal;
			reject(x);
		};
		child.on("error", (e: NodeJS.ErrnoException) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fail(e as Error, null, null);
		});
		child.on("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const stderr = Buffer.concat(err).toString("utf8");
			if (code === 0 && !failure) return resolve(Buffer.concat(out).toString("utf8"));
			const e = new Error(`Command failed: ${[cmd, ...args].join(" ")}${stderr ? `\n${stderr}` : ""}`) as Error & { code?: string };
			if (failure) e.code = failure;
			fail(e, code, signal);
		});
	});
}
