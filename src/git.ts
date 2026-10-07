import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Minimal git helpers. Two repos with opposite rules:
 *  - source: read-only. We only ever record its HEAD (pinned commit) and read files. Never write, never commit.
 *  - target: ours. Initialized at `init`, committed by the orchestrator on accepted units/modules.
 */
function git(cwd: string, args: string[], opts: ExecFileSyncOptions = {}): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).toString().trim();
}

export function isRepo(path: string): boolean {
	if (!existsSync(path)) return false;
	try {
		return git(path, ["rev-parse", "--is-inside-work-tree"]) === "true";
	} catch {
		return false;
	}
}

export function headOf(path: string): string | undefined {
	if (!isRepo(path)) return undefined;
	try {
		return git(path, ["rev-parse", "HEAD"]);
	} catch {
		return undefined; // empty repo
	}
}

export function isDirty(path: string): boolean {
	return git(path, ["status", "--porcelain"]).length > 0;
}

/** Files changed between two commits (paths relative to repo root). */
export function changedFiles(path: string, fromCommit: string, toCommit = "HEAD"): { added: string[]; modified: string[]; deleted: string[] } {
	const out = git(path, ["diff", "--name-status", fromCommit, toCommit]);
	const r = { added: [] as string[], modified: [] as string[], deleted: [] as string[] };
	for (const line of out.split("\n").filter(Boolean)) {
		const [status, ...rest] = line.split("\t");
		const file = rest.at(-1)!;
		if (status!.startsWith("A")) r.added.push(file);
		else if (status!.startsWith("D")) r.deleted.push(file);
		else r.modified.push(file);
	}
	return r;
}

export function ensureRepo(path: string, defaultBranch = "main"): void {
	if (isRepo(path)) return;
	git(path, ["init", "-b", defaultBranch]);
	if (!existsSync(join(path, ".gitignore"))) {
		execFileSync("sh", ["-c", `printf 'node_modules/\\ndist/\\n.env\\n' > .gitignore`], { cwd: path });
	}
}

export function commitAll(path: string, message: string, opts: { allowEmpty?: boolean } = {}): string | undefined {
	git(path, ["add", "-A"]);
	if (!opts.allowEmpty && !isDirty(path) && git(path, ["diff", "--cached", "--name-only"]).length === 0) return undefined;
	git(path, ["-c", "user.name=bigrefactor", "-c", "user.email=bigrefactor@localhost", "commit", "-q", "-m", message, ...(opts.allowEmpty ? ["--allow-empty"] : [])]);
	return headOf(path);
}

export function currentBranch(path: string): string {
	return git(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export function checkoutBranch(path: string, branch: string, create = true): void {
	try {
		git(path, ["checkout", "-q", branch]);
	} catch {
		if (!create) throw new Error(`branch ${branch} does not exist`);
		git(path, ["checkout", "-q", "-b", branch]);
	}
}

/** Worktree per unit so parallel implementers never share a working copy. */
export function addWorktree(repo: string, worktreePath: string, branch: string): void {
	if (existsSync(worktreePath)) return; // same unit resuming in place: keep its work
	// A new worktree always starts from the current main: -B resets a leftover unit branch (from a parked or
	// crashed attempt) instead of reviving it on an old base that lacks every unit accepted since.
	git(repo, ["worktree", "prune"]);
	git(repo, ["worktree", "add", "-q", "-B", branch, worktreePath]);
}

export function removeWorktree(repo: string, worktreePath: string): void {
	try {
		git(repo, ["worktree", "remove", "--force", worktreePath]);
	} catch {
		/* already gone */
	}
}
