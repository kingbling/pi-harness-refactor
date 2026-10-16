import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { exec } from "./proc.ts";

/**
 * Minimal git helpers. Two repos with opposite rules:
 *  - source: read-only. We only ever record its HEAD (pinned commit) and read files. Never write, never commit.
 *  - target: ours. Initialized at `init`, committed by the orchestrator on accepted units/modules.
 */
export function git(cwd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number } = {}): Promise<string> {
	return exec("git", args, { cwd, ...opts }).then((o) => o.trim());
}

/**
 * Git writes that touch a repo's shared parts (worktree list, branch refs, packed-refs) from parallel lanes take
 * turns: now that launches are awaited, two lanes can be inside git at once and collide on its lock files.
 */
const repoQueues = new Map<string, Promise<unknown>>();
export function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
	const key = resolve(repo);
	const next = (repoQueues.get(key) ?? Promise.resolve()).then(fn, fn);
	const tail = next.catch(() => {});
	repoQueues.set(key, tail);
	void tail.then(() => {
		if (repoQueues.get(key) === tail) repoQueues.delete(key);
	});
	return next;
}

/** Delete a local branch (a leftover unit branch); the repo's ref writes take turns. */
export function deleteBranch(repo: string, branch: string): Promise<string> {
	return withRepoLock(repo, () => git(repo, ["branch", "-q", "-D", branch]));
}

export async function isRepo(path: string): Promise<boolean> {
	if (!existsSync(path)) return false;
	try {
		return await git(path, ["rev-parse", "--is-inside-work-tree"]) === "true";
	} catch {
		return false;
	}
}

export async function headOf(path: string): Promise<string | undefined> {
	if (!await isRepo(path)) return undefined;
	try {
		return await git(path, ["rev-parse", "HEAD"]);
	} catch {
		return undefined; // empty repo
	}
}

export async function isDirty(path: string): Promise<boolean> {
	return (await git(path, ["status", "--porcelain"])).length > 0;
}

/** Files changed between two commits (paths relative to repo root). */
export async function changedFiles(path: string, fromCommit: string, toCommit = "HEAD"): Promise<{ added: string[]; modified: string[]; deleted: string[] }> {
	const out = await git(path, ["diff", "--name-status", fromCommit, toCommit]);
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
export async function ensureRepo(path: string, defaultBranch = "main", ignored: string[] = []): Promise<void> {
	// a target nested inside another checkout (a workspace under a repo) gets its own repo: commits must never land in the parent
	if (await isRepo(path) && realpathSync(await git(path, ["rev-parse", "--show-toplevel"])) === realpathSync(path)) return;
	await git(path, ["init", "-b", defaultBranch]);
	// only a .env at the repo root is kept out: a stack's own .env (Symfony commits its defaults there) is the stack's
	// business, and its own .gitignore says what stays local
	if (!existsSync(join(path, ".gitignore"))) writeFileSync(join(path, ".gitignore"), [...ignored.map((i) => `${i}/`), "/.env"].join("\n") + "\n");
}

/**
 * True when a tracked file's change is only whitespace and blank lines (a formatter's fix): it cannot change what
 * a test checks, so the "tests stay untouched" rules let it through.
 */
export async function whitespaceOnly(repo: string, path: string): Promise<boolean> {
	try {
		await git(repo, ["ls-files", "--error-unmatch", "--", path]);
		await git(repo, ["diff", "--quiet", "-w", "--ignore-blank-lines", "HEAD", "--", path]);
		return true;
	} catch {
		return false;
	}
}

/** True when `path` is the top of its own git repo (not a folder inside some other repo, where git would act on the parent). */
export async function isRepoRoot(path: string): Promise<boolean> {
	try {
		return realpathSync((await git(path, ["rev-parse", "--show-toplevel"])).trim()) === realpathSync(path);
	} catch {
		return false;
	}
}

/** `exclude`: repo-relative folders left out of the commit (another stack's project). */
export async function commitAll(path: string, message: string, opts: { allowEmpty?: boolean; exclude?: string[] } = {}): Promise<string | undefined> {
	// never commit a parent repo's files: a target folder inside another checkout is not ours to commit
	if (!await isRepoRoot(path)) throw new Error(`${path} is not the top of its own git repo; refusing to commit there`);
	await git(path, ["add", "-A", ...(opts.exclude?.length ? ["--", ".", ...opts.exclude.map((d) => `:(exclude)${d}`)] : [])]);
	if (!opts.allowEmpty && (opts.exclude?.length || !await isDirty(path)) && (await git(path, ["diff", "--cached", "--name-only"])).length === 0) return undefined;
	await git(path, ["-c", "user.name=bigrefactor", "-c", "user.email=bigrefactor@localhost", "commit", "-q", "-m", message, ...(opts.allowEmpty ? ["--allow-empty"] : [])]);
	return await headOf(path);
}

/** Folders git tracks directly under `parent` (relative to the repo). */
export async function trackedChildDirs(repo: string, parent: string): Promise<string[]> {
	const pre = parent.replace(/\/?$/, "/");
	const files = (await git(repo, ["ls-files", "--", pre])).split("\n").filter(Boolean);
	return [...new Set(files.map((f) => f.slice(pre.length)).filter((f) => f.includes("/")).map((f) => f.split("/")[0]!))];
}

/**
 * Rename a tracked folder and commit just that. Two steps through a temporary name, so a rename that only changes
 * upper/lower case also lands where the disk and git ignore case (macOS). Nothing happens while changes are staged.
 */
export async function renameDir(repo: string, from: string, to: string, message: string): Promise<string | undefined> {
	if ((await git(repo, ["diff", "--cached", "--name-only"])).length) return undefined;
	const tmp = `${from}.rename-${Date.now()}`;
	await git(repo, ["mv", from, tmp]);
	mkdirSync(dirname(join(repo, to)), { recursive: true });
	await git(repo, ["mv", tmp, to]);
	await git(repo, ["-c", "user.name=bigrefactor", "-c", "user.email=bigrefactor@localhost", "commit", "-q", "-m", message]);
	return await headOf(repo);
}

/** Worktree per unit so parallel implementers never share a working copy. */
/**
 * A branch this workspace makes in the target repo: its name carries the workspace (folder name and a hash of its
 * path). Another workspace on the same repo makes branches for the same unit ids, and adding a worktree with -B, or
 * deleting a leftover branch, would otherwise reset or delete that workspace's work.
 */
export function wsBranch(root: string, name: string): string {
	const abs = resolve(root);
	const slug = basename(abs).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "ws";
	return `br-${slug}-${createHash("sha1").update(abs).digest("hex").slice(0, 6)}/${name}`;
}

/**
 * One workspace per main branch: the first run of a workspace writes it into the target repo's git config; a run of
 * another workspace on the same repo and main branch is refused while that workspace still exists (both would merge
 * into one main). Returns the other workspace's path when refused.
 */
export async function claimMainBranch(repo: string, branch: string, root: string): Promise<string | undefined> {
	const key = `bigrefactor.${branch}.workspace`;
	const me = resolve(root);
	const cur = (await git(repo, ["config", "--get", key]).catch(() => "")).trim();
	if (cur && cur !== me && existsSync(join(cur, ".bigrefactor"))) return cur;
	if (cur !== me) await git(repo, ["config", key, me]);
	return undefined;
}

export async function addWorktree(repo: string, worktreePath: string, branch: string): Promise<void> {
	if (existsSync(worktreePath)) return; // same unit resuming in place: keep its work
	// A new worktree always starts from the current main: -B resets a leftover unit branch (from a parked or
	// crashed attempt) instead of reviving it on an old base that lacks every unit accepted since.
	// the worktree list and branch refs are shared by every lane: adds, prunes and removes take turns
	await withRepoLock(repo, async () => {
		await git(repo, ["worktree", "prune"]);
		await git(repo, ["worktree", "add", "-q", "-B", branch, worktreePath]);
		// which workspace made the branch: the cleaner removes only branches whose record points into its own worktrees
		// folder (other workspaces on the same repo make branches with the same names); git drops it with the branch
		await git(repo, ["config", `branch.${branch}.bigrefactorWorktree`, resolve(worktreePath)]);
	});
}

/**
 * A worktree can hold thousands of files (a copied dependency dir): deleting it inline froze the run for a second
 * per unit. It is moved aside instead (instant, same disk), git forgets it, and the files go in the background.
 */
export async function removeWorktree(repo: string, worktreePath: string): Promise<void> {
	if (!existsSync(worktreePath)) return;
	const trash = join(dirname(worktreePath), ".trash", `${basename(worktreePath)}-${process.pid}-${trashSeq++}`);
	try {
		mkdirSync(dirname(trash), { recursive: true });
		renameSync(worktreePath, trash);
	} catch {
		try {
			await withRepoLock(repo, () => git(repo, ["worktree", "remove", "--force", worktreePath]));
		} catch {
			/* already gone */
		}
		return;
	}
	try {
		await withRepoLock(repo, () => git(repo, ["worktree", "prune"]));
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
export async function mainBranch(repo: string, configured: string): Promise<string> {
	try {
		await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${configured}`]);
		return configured;
	} catch {
		try {
			return await git(repo, ["symbolic-ref", "--short", "HEAD"]) || configured;
		} catch {
			return configured;
		}
	}
}
