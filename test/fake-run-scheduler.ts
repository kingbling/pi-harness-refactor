import { existsSync } from "node:fs";
import type { SchedulerOptions, SchedulerResult } from "../src/run/run.ts";
import { startWatchdog } from "../src/run/watchdog.ts";

/**
 * A scripted scheduler for the run process test (BR_RUN_CHILD_SCHEDULER): starts one unit, then waits until the run
 * is stopped (or, with BR_FAKE_CRASH, ends the process as a crash would; with BR_FAKE_HANG, never ends; with BR_FAKE_FREEZE, freezes 1.5 s first).
 * BR_FAKE_DRAIN_MS: the unit takes that long to finish after the stop. BR_FAKE_FAIL_IF: a run process that finds this
 * file ends at start (exit code 4), as one started on broken plugin code would.
 */
export async function runScheduler(o: SchedulerOptions): Promise<SchedulerResult> {
	const log = o.log!;
	log(`fake run process pid ${process.pid}`);
	const failIf = process.env["BR_FAKE_FAIL_IF"];
	if (failIf && existsSync(failIf)) {
		log("fake: broken code");
		setTimeout(() => process.exit(4), 100);
		return new Promise(() => {});
	}
	log("▶ U1_fake");
	o.onLanes?.({ running: 1, max: 2, ready: 3, ahead: 0 });
	if (process.env["BR_FAKE_CRASH"]) setTimeout(() => process.exit(3), 300);
	// a run that holds its own thread 1.5 s, under the real watchdog
	if (process.env["BR_FAKE_FREEZE"]) {
		const stop = startWatchdog(o.root, log);
		await new Promise((r) => setTimeout(r, 300));
		const t = Date.now();
		while (Date.now() - t < 1500);
		await new Promise((r) => setTimeout(r, 300));
		stop();
	}
	// a run that never ends, whatever it is told (a tool that never returns)
	if (process.env["BR_FAKE_HANG"]) await new Promise(() => setInterval(() => {}, 1000));
	let why: boolean | string | undefined;
	while (!(why = o.shouldStop?.())) await new Promise((r) => setTimeout(r, 50));
	log(`fake: stop (${why === true ? "/br stop" : why})`);
	const drain = Number(process.env["BR_FAKE_DRAIN_MS"] ?? 0);
	if (drain) await new Promise((r) => setTimeout(r, drain));
	log("✓ U1_fake accepted  (fake)");
	return { ran: [], accepted: 1, quarantined: 0, waiting: 2, costUsd: 0 };
}
