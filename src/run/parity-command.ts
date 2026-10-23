import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const MAX_OBSERVATION_TIMEOUT_MS = 24 * 60 * 60_000;

/** Explicit, finite budgets are frozen with the recipe/suite. Never turn an invalid value into an unbounded check. */
export function observationTimeoutMs(value: unknown, fallback: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_OBSERVATION_TIMEOUT_MS)
		throw new Error(`observation timeoutMs must be an integer from 1 to ${MAX_OBSERVATION_TIMEOUT_MS}`);
	return value;
}

export interface ObservationContext {
	side?: "legacy" | "target";
	slice?: string;
	phase?: "probe" | "initial" | "step" | "contract";
	step?: string;
}

/** Recipe/inherited variables cannot spoof which frozen scenario is running. Empty values clear stale context. */
export function observationEnvironment(context: ObservationContext): Record<string, string> {
	return {
		BR_PARITY_SIDE: context.side ?? "", BR_PARITY_SLICE: context.slice ?? "",
		BR_PARITY_PHASE: context.phase ?? "probe", BR_PARITY_STEP: context.step ?? "",
	};
}

/** Drivers spawn native database/browser readers. Bound output/time and reap their whole process group. */
export function runVerificationCommand(command: { cmd: string; args: string[] }, cwd: string, timeout: number, env: NodeJS.ProcessEnv,
	limits: { maxBytes?: number; outputProblem?: string; label?: string } = {}): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const budget = observationTimeoutMs(timeout, 120_000);
		const label = limits.label ?? "check", maxBytes = limits.maxBytes ?? 8 * 1024 * 1024;
		const child = spawn(process.execPath, [fileURLToPath(new URL("./parity-command-child.mjs", import.meta.url)), String(process.pid), JSON.stringify(command)], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		const stdout: Buffer[] = [];
		let stderr = "", size = 0, settled = false;
		const kill = () => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } };
		const finish = (problem?: string) => {
			if (settled) return;
			settled = true; clearTimeout(timer); process.removeListener("exit", kill);
			kill(); child.stdout.destroy(); child.stderr.destroy();
			if (problem) reject(new Error(`${problem}${stderr ? `: ${stderr.slice(-2000)}` : ""}`));
			else resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr });
		};
		const timer = setTimeout(() => finish(`${label} timed out after ${budget}ms`), budget);
		process.once("exit", kill);
		child.stdout.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > maxBytes) finish(limits.outputProblem ?? "check output exceeded 8 MiB");
			else stdout.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			size += chunk.length;
			stderr = (stderr + chunk.toString("utf8")).slice(-4000);
			if (size > maxBytes) finish(limits.outputProblem ?? "check output exceeded 8 MiB");
		});
		child.on("error", (e) => finish(`${label} could not start: ${e.message}`));
		// An inherited stdout pipe must not let an orphan keep `close` pending after the launcher exits.
		child.on("exit", kill);
		child.on("close", (code, signal) => finish(code === 0 ? undefined : `${label} failed (${signal ?? code})`));
	});
}
