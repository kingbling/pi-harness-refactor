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
