import { spawn } from "node:child_process";
import { progress } from "./progress.ts";

/**
 * Run a long external command (official generators, package installs) without blocking the event loop.
 * A blocking execFileSync freezes the whole host: inside Pi that means no widget updates, no chat and no
 * stop for the minutes `nest new` takes. While a tracked job runs, output goes line by line into the
 * progress feed instead of the terminal (raw writes corrupt the TUI); otherwise it streams to stdio as before.
 * Rejects with the command's tail output on a non-zero exit.
 */
export function runCommand(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<void> {
	return new Promise((resolve, reject) => {
		const tracked = progress.running;
		// stdin is never the terminal: generators must not prompt (CI=1 makes most of them non-interactive too).
		// Detached process group so a stop kills the whole tree (pnpm → create-x → dev server), not just the wrapper.
		const child = spawn(cmd, args, { cwd: opts.cwd, detached: true, env: { ...process.env, ...(opts.env ?? {}), CI: "1", ...(tracked ? { FORCE_COLOR: "0" } : {}) }, stdio: tracked ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"] });
		const tail: string[] = [];
		const feed = (chunk: Buffer) => {
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
			onStop();
			reject(e);
		});
		child.on("close", (code, signal) => {
			onStop();
			if (code === 0) resolve();
			else reject(new Error(`${cmd} ${args.slice(0, 3).join(" ")} failed (${signal ?? `exit ${code}`})${tail.length ? `:\n${tail.slice(-8).join("\n")}` : ""}`));
		});
	});
}
