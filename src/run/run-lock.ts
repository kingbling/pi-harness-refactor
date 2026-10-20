import { execFile } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Ledger } from "../ledger/db.ts";
import { statePath } from "../config.ts";

/**
 * One run per workspace. A second run's crash recovery would delete the first run's live worktrees, and a
 * requeue or recheck would reset units the run is working on. The lock is a file with the run's pid; when that
 * process is gone the lock is stale and ignored.
 */
const lockPath = (root: string) => statePath(root, "run.lock");

/** The pid of the live run of this workspace (this process included), or undefined. */
export function liveRun(root: string): number | undefined {
	let pid: number;
	try {
		pid = Number(readFileSync(lockPath(root), "utf8").trim());
	} catch {
		return undefined;
	}
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		process.kill(pid, 0); // only asks whether the process exists
		return pid;
	} catch (e: any) {
		return e?.code === "EPERM" ? pid : undefined; // EPERM: it exists, owned by someone else
	}
}

/** Take the lock for a run, or throw when another run is live. Returns the release. */
export function acquireRunLock(root: string): () => void {
	const pid = liveRun(root);
	if (pid !== undefined) throw new Error(`a run is already going in this workspace (pid ${pid}); stop it first, or wait until it ends`);
	writeFileSync(lockPath(root), String(process.pid));
	return () => {
		if (liveRun(root) === process.pid) rmSync(lockPath(root), { force: true });
	};
}

/** Whether `pid` is a migration run (Pi's run process or a terminal br run), not another program that got its number. */
export async function isRunProcess(pid: number): Promise<boolean> {
	const cmd = await new Promise<string>((done) => execFile("ps", ["-o", "command=", "-p", String(pid)], (_e, so) => done(String(so ?? ""))));
	return /\b(?:run-child|cli)\.[cm]?[tj]s\b/.test(cmd);
}

/**
 * A run started while an earlier one still holds the workspace (Pi was quit and its run is finishing its gates):
 * the earlier run is asked to stop (SIGTERM: it stops as when Pi goes away) and this one waits, looking every
 * `everyMs`, until it has ended. Returns false when `stopped` ended the wait first.
 */
export async function waitForEarlierRun(root: string, o: { log: (l: string) => void; stopped: () => boolean; everyMs?: number }): Promise<boolean> {
	const pid = liveRun(root);
	if (pid === undefined || pid === process.pid || !(await isRunProcess(pid))) return true;
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		// gone already
	}
	o.log(`a run is still going in this workspace (pid ${pid}): it was asked to stop; this run starts once it has ended (looked at every minute; /br stop ends the wait)`);
	const every = o.everyMs ?? 60_000;
	for (let waited = 0; liveRun(root) === pid; waited += every) {
		for (let t = 0; t < every; t += Math.min(1000, every)) {
			if (o.stopped()) return false;
			await new Promise((r) => setTimeout(r, Math.min(1000, every)));
		}
		if (liveRun(root) === pid) o.log(`still waiting for the earlier run (pid ${pid}) to end: ${Math.round((waited + every) / 60_000)} min`);
	}
	o.log(`the earlier run (pid ${pid}) has ended: this run starts`);
	return !o.stopped();
}

/** States a live run is working on: hands off while it runs. */
const IN_FLIGHT = ["truth", "implementing", "gating", "review"];

/**
 * What a requeue may touch now. Without a live run: everything asked. With one: only units the run does not hold
 * (`--all` becomes the quarantined units); the rest are named in `refused`.
 */
export function requeueScope(ledger: Ledger, root: string, ids: string[] | "all"): { ids: string[] | "all"; refused: string[] } {
	const pid = liveRun(root);
	if (pid === undefined) return { ids, refused: [] };
	if (ids === "all") return { ids: ledger.listUnits().filter((u) => u.state === "quarantined").map((u) => u.id), refused: [] };
	const held = (id: string) => IN_FLIGHT.includes(ledger.getUnit(id)?.state ?? "");
	return { ids: ids.filter((id) => !held(id)), refused: ids.filter(held).map((id) => `${id}: the live run (pid ${pid}) is working on it; requeue it after the run`) };
}
