import type { SchedulerOptions, SchedulerResult } from "../src/run/run.ts";

/**
 * A scripted scheduler for the run process test (BR_RUN_CHILD_SCHEDULER): starts one unit, then waits until the run
 * is stopped (or, with BR_FAKE_CRASH, ends the process as a crash would; with BR_FAKE_HANG, never ends).
 */
export async function runScheduler(o: SchedulerOptions): Promise<SchedulerResult> {
	const log = o.log!;
	log("▶ U1_fake");
	o.onLanes?.({ running: 1, max: 2, ready: 3, ahead: 0 });
	if (process.env["BR_FAKE_CRASH"]) setTimeout(() => process.exit(3), 300);
	// a run that never ends, whatever it is told (a tool that never returns)
	if (process.env["BR_FAKE_HANG"]) await new Promise(() => setInterval(() => {}, 1000));
	while (!o.shouldStop?.()) await new Promise((r) => setTimeout(r, 50));
	log("✓ U1_fake accepted  (fake)");
	return { ran: [], accepted: 1, quarantined: 0, waiting: 2, costUsd: 0 };
}
