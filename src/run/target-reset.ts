import type { Config } from "../config.ts";
import { git, mainBranch } from "../git.ts";
import type { Ledger } from "../ledger/db.ts";
import { reopenUnit } from "./recheck.ts";
import { requeueUnits } from "./run.ts";

/** Points whose questions are about the files of the target project as it was (its gate output, its tree, its build). */
const TARGET_POINTS = ["gate_env", "triage_gate", "build", "layout_sample", "quarantine", "tidy"];

async function ok(repo: string, args: string[]): Promise<boolean> {
	try {
		await git(repo, args);
		return true;
	} catch {
		return false;
	}
}

/**
 * The commit is still known to the project: on the branch units merge into (not whatever is checked out right
 * now), or at least still in the repo (the branch was rebased or squashed, or another branch is checked out).
 * Only a project set up anew has lost the commits themselves.
 */
async function stillThere(repo: string, branch: string, sha: string): Promise<boolean> {
	return (await ok(repo, ["merge-base", "--is-ancestor", sha, `refs/heads/${branch}`])) || (await ok(repo, ["cat-file", "-e", `${sha}^{commit}`]));
}

/**
 * The target project was created anew (deleted and set up again): the code the accepted units merged is gone, so
 * what the ledger says about that old project no longer holds. Seen when no accepted unit's merge commit is in the
 * target repo any more (not on its branch and not in it at all). Every unit worked on goes back to planned and runs again (its tests too: they lived
 * in the old project); the layout sample and the questions about the old project's files are dropped. What was
 * learned about the legacy code stays: inventory, placement, decisions. Returns the units put back, or undefined.
 */
export async function resetForNewTarget(ledger: Ledger, config: Config, root: string): Promise<string[] | undefined> {
	const accepted = ledger.listUnits({ state: "accepted" }).map((u) => ({ id: u.id, commit: (JSON.parse(u.meta) as { commit?: string }).commit }));
	const commits = accepted.flatMap((u) => (u.commit ? [u.commit] : []));
	const branch = await mainBranch(config.target.path, config.target.git.branch);
	if (!commits.length) return undefined;
	for (const c of commits) if (await stillThere(config.target.path, branch, c)) return undefined;
	const reason = "the target project was created anew: its earlier code is gone";
	for (const u of accepted) {
		ledger.db.prepare("DELETE FROM moves WHERE unit_id = ?").run(u.id);
		ledger.db.prepare("UPDATE units SET meta = json_remove(meta, '$.commit', '$.applied', '$.healedFrom', '$.stuck') WHERE id = ?").run(u.id);
		reopenUnit(ledger, u.id, "", reason, true);
	}
	const stuck = (await requeueUnits(ledger, config, root, "all", reason)).filter((l) => l.endsWith(": requeued")).map((l) => l.split(":")[0]!);
	// planned units still parked on a question about the old project
	ledger.db.prepare("UPDATE units SET meta = json_remove(meta, '$.parked', '$.hold', '$.healedFrom', '$.stuck') WHERE state = 'planned'").run();
	const q = ledger.db.prepare(`UPDATE questions SET status = 'withdrawn', answer = COALESCE(answer || ' — ', '') || ?, answered_at = COALESCE(answered_at, datetime('now')) WHERE point IN (${TARGET_POINTS.map(() => "?").join(",")}) AND status IN ('open', 'answered')`);
	q.run(`withdrawn: ${reason}`, ...TARGET_POINTS);
	ledger.setMeta("layout_sample", "{}");
	return [...accepted.map((u) => u.id), ...stuck];
}
