import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Freeze watchdog: the run lives inside Pi, so anything that holds the event loop (a sync child process, a slow
 * ledger query) freezes the whole UI. A timer that should fire every 200 ms measures how late it came; a delay of
 * more than a second is written to .bigrefactor/blocked.log with the step the run was in, so a freeze can be traced.
 */
let step = "starting";

/** What the run does now (cheap: one assignment). The watchdog names it when the loop was blocked. */
export function setStep(label: string): void {
	step = label;
}

/** Start watching; returns the stop function. */
export function startWatchdog(root: string, log: (line: string) => void, o: { everyMs?: number; blockedMs?: number } = {}): () => void {
	const every = o.everyMs ?? 200;
	const limit = o.blockedMs ?? 1000;
	let last = performance.now();
	const timer = setInterval(() => {
		const now = performance.now();
		const late = now - last - every;
		last = now;
		if (late <= limit) return;
		const line = `${new Date().toISOString()} Pi was blocked ${(late / 1000).toFixed(1)} s (last step: ${step})`;
		try {
			mkdirSync(join(root, ".bigrefactor"), { recursive: true });
			appendFileSync(join(root, ".bigrefactor", "blocked.log"), line + "\n");
		} catch {
			/* the log is a help, never a reason to fail */
		}
		log(line);
	}, every);
	timer.unref();
	return () => clearInterval(timer);
}
