import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addWorktree, headOf, removeWorktree } from "../src/git.ts";
import { conflictFilesNote, rebaseOnMain, restoreUnitWork } from "../src/run/run.ts";

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();

describe("a unit whose merge conflicts keeps its reviewed code", () => {
	it("puts the unit's commit back on the new main: clean files applied, clashing files with both sides", () => {
		const root = mkdtempSync(join(tmpdir(), "br-conflict-"));
		const repo = join(root, "repo");
		execFileSync("git", ["init", "-q", "-b", "main", repo]);
		writeFileSync(join(repo, "App.tsx"), "routes: home\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-q", "-m", "init");
		const wt = join(root, "wt");
		addWorktree(repo, wt, "unit/U1");
		writeFileSync(join(wt, "App.tsx"), "routes: home, users\n");
		writeFileSync(join(wt, "UsersPage.tsx"), "users page\n");
		// another unit lands on main and touches the same line of App.tsx
		writeFileSync(join(repo, "App.tsx"), "routes: home, offers\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-q", "-m", "another unit");
		const config = { target: { path: repo, git: { branch: "main" } } } as any;
		expect(() => rebaseOnMain(config, wt, "unit/U1", "feat: U1")).toThrow(/merge conflict/);
		// the aborted rebase leaves the unit's commit as the worktree head: that is what goes back
		const sha = headOf(wt)!;
		expect(git(wt, "log", "-1", "--format=%s")).toBe("feat: U1");
		removeWorktree(repo, wt);
		git(repo, "branch", "-q", "-D", "unit/U1");
		addWorktree(repo, wt, "unit/U1");
		expect(restoreUnitWork(wt, sha)).toEqual(["App.tsx"]);
		expect(readFileSync(join(wt, "UsersPage.tsx"), "utf8")).toBe("users page\n");
		expect(readFileSync(join(wt, "App.tsx"), "utf8")).toMatch(/<<<<<<< HEAD\nroutes: home, offers\n=======\nroutes: home, users\n>>>>>>> /);
		// uncommitted and no cherry-pick left in progress: the next merge commits it as usual
		expect(git(wt, "status", "--porcelain").split("\n").map((l) => l.trim()).sort()).toEqual(["?? UsersPage.tsx", "M App.tsx"]);
		expect(() => git(wt, "rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD")).toThrow();
		expect(conflictFilesNote(["App.tsx"])).toMatch(/App\.tsx.*<<<<<<< HEAD/);
	});
});
