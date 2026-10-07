import { spawn } from "node:child_process";
import { progress } from "./progress.ts";

/**
 * Run a long external command (official generators, package installs) without blocking the event loop.
 * A blocking execFileSync freezes the whole host: inside Pi that means no widget updates, no chat and no
 * stop for the minutes `nest new` takes. While a tracked job runs, output goes line by line into the
 * progress feed instead of the terminal (raw writes corrupt the TUI); otherwise it streams to stdio as before.
 * Rejects with the command's tail output on a non-zero exit.
 * Silence is reported, not guessed at: every 30 s without output the feed says the command still runs (slow
 * downloads look like a hang); after `idleKillMs` (default 15 min) without any output it is stopped as hung.
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
		const watch = setInterval(() => {
			const quiet = Date.now() - lastOutput;
			if (quiet >= idleKillMs && child.exitCode === null && child.pid) {
				hung = true;
				progress.log(`  ${cmd} │ no output for ${secs(quiet)}: stopping it as hung`);
				try {
					process.kill(-child.pid, "SIGTERM");
				} catch {
					child.kill("SIGTERM");
				}
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
			if (s.stopping && progress.aborting && child.exitCode === null && child.pid) {
				try {
					process.kill(-child.pid, "SIGTERM");
				} catch {
					child.kill("SIGTERM");
				}
			}
		});
		child.on("error", (e) => {
			clearInterval(watch);
			onStop();
			reject(e);
		});
		child.on("close", (code, signal) => {
			clearInterval(watch);
			onStop();
			if (code === 0) resolve();
			else reject(new Error(`${cmd} ${args.slice(0, 3).join(" ")} ${hung ? `hung (no output for ${secs(idleKillMs)})` : "failed"} (${signal ?? `exit ${code}`})${tail.length ? `:\n${tail.slice(-8).join("\n")}` : ""}`));
		});
	});
}
