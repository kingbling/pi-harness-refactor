import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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

/** `ignored`: generated paths of the stacks living here (TargetToolchain.ignoredPaths), written to a new .gitignore. */
export function ensureRepo(path: string, defaultBranch = "main", ignored: string[] = []): void {
	// a target nested inside another checkout (a workspace under a repo) gets its own repo: commits must never land in the parent
	if (isRepo(path) && realpathSync(git(path, ["rev-parse", "--show-toplevel"])) === realpathSync(path)) return;
	git(path, ["init", "-b", defaultBranch]);
	// only a .env at the repo root is kept out: a stack's own .env (Symfony commits its defaults there) is the stack's
	// business, and its own .gitignore says what stays local
	if (!existsSync(join(path, ".gitignore"))) writeFileSync(join(path, ".gitignore"), [...ignored.map((i) => `${i}/`), "/.env"].join("\n") + "\n");
}

/** True when `path` is the top of its own git repo (not a folder inside some other repo, where git would act on the parent). */
export function isRepoRoot(path: string): boolean {
	try {
		return realpathSync(git(path, ["rev-parse", "--show-toplevel"]).trim()) === realpathSync(path);
	} catch {
		return false;
	}
}

export function commitAll(path: string, message: string, opts: { allowEmpty?: boolean } = {}): string | undefined {
	// never commit a parent repo's files: a target folder inside another checkout is not ours to commit
	if (!isRepoRoot(path)) throw new Error(`${path} is not the top of its own git repo; refusing to commit there`);
	git(path, ["add", "-A"]);
	if (!opts.allowEmpty && !isDirty(path) && git(path, ["diff", "--cached", "--name-only"]).length === 0) return undefined;
	git(path, ["-c", "user.name=bigrefactor", "-c", "user.email=bigrefactor@localhost", "commit", "-q", "-m", message, ...(opts.allowEmpty ? ["--allow-empty"] : [])]);
	return headOf(path);
}

/** Folders git tracks directly under `parent` (relative to the repo). */
export function trackedChildDirs(repo: string, parent: string): string[] {
	const pre = parent.replace(/\/?$/, "/");
	const files = git(repo, ["ls-files", "--", pre]).split("\n").filter(Boolean);
	return [...new Set(files.map((f) => f.slice(pre.length)).filter((f) => f.includes("/")).map((f) => f.split("/")[0]!))];
}

/**
 * Rename a tracked folder and commit just that. Two steps through a temporary name, so a rename that only changes
 * upper/lower case also lands where the disk and git ignore case (macOS). Nothing happens while changes are staged.
 */
export function renameDir(repo: string, from: string, to: string, message: string): string | undefined {
	if (git(repo, ["diff", "--cached", "--name-only"]).length) return undefined;
	const tmp = `${from}.rename-${Date.now()}`;
	git(repo, ["mv", from, tmp]);
	mkdirSync(dirname(join(repo, to)), { recursive: true });
	git(repo, ["mv", tmp, to]);
	git(repo, ["-c", "user.name=bigrefactor", "-c", "user.email=bigrefactor@localhost", "commit", "-q", "-m", message]);
	return headOf(repo);
}

/** Worktree per unit so parallel implementers never share a working copy. */
export function addWorktree(repo: string, worktreePath: string, branch: string): void {
	if (existsSync(worktreePath)) return; // same unit resuming in place: keep its work
	// A new worktree always starts from the current main: -B resets a leftover unit branch (from a parked or
	// crashed attempt) instead of reviving it on an old base that lacks every unit accepted since.
	git(repo, ["worktree", "prune"]);
	git(repo, ["worktree", "add", "-q", "-B", branch, worktreePath]);
}

/**
 * A worktree can hold thousands of files (a copied dependency dir): deleting it inline froze the run for a second
 * per unit. It is moved aside instead (instant, same disk), git forgets it, and the files go in the background.
 */
export function removeWorktree(repo: string, worktreePath: string): void {
	if (!existsSync(worktreePath)) return;
	const trash = join(dirname(worktreePath), ".trash", `${basename(worktreePath)}-${process.pid}-${trashSeq++}`);
	try {
		mkdirSync(dirname(trash), { recursive: true });
		renameSync(worktreePath, trash);
	} catch {
		try {
			git(repo, ["worktree", "remove", "--force", worktreePath]);
		} catch {
			/* already gone */
		}
		return;
	}
	try {
		git(repo, ["worktree", "prune"]);
	} catch {
		/* pruned on the next add */
	}
	void rm(trash, { recursive: true, force: true }).catch(() => {});
}
let trashSeq = 0;

/** Worktrees moved aside by an earlier process that ended before deleting them. */
export function emptyWorktreeTrash(worktreesDir: string): void {
	const t = join(worktreesDir, ".trash");
	if (!existsSync(t)) return;
	for (const n of readdirSync(t)) if (!n.includes(`-${process.pid}-`)) void rm(join(t, n), { recursive: true, force: true }).catch(() => {});
}

/**
 * The branch units merge into: the configured one, or, when it is gone from the repo (renamed by hand, e.g.
 * migration/main → main), the branch the target repo has checked out.
 */
export function mainBranch(repo: string, configured: string): string {
	try {
		git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${configured}`]);
		return configured;
	} catch {
		try {
			return git(repo, ["symbolic-ref", "--short", "HEAD"]) || configured;
		} catch {
			return configured;
		}
	}
}
