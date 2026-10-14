import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addWorktree, headOf, removeWorktree } from "../src/git.ts";
import { applyCleanly, conflictFilesNote, keepsCode, rebaseOnMain, restoreUnitWork } from "../src/run/run.ts";

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();

describe("a unit whose merge conflicts keeps its reviewed code", () => {
	it("puts the unit's commit back on the new main: clean files applied, clashing files with both sides", async () => {
		const root = mkdtempSync(join(tmpdir(), "br-conflict-"));
		const repo = join(root, "repo");
		execFileSync("git", ["init", "-q", "-b", "main", repo]);
		writeFileSync(join(repo, "App.tsx"), "routes: home\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-q", "-m", "init");
		const wt = join(root, "wt");
		await addWorktree(repo, wt, "unit/U1");
		writeFileSync(join(wt, "App.tsx"), "routes: home, users\n");
		writeFileSync(join(wt, "UsersPage.tsx"), "users page\n");
		// another unit lands on main and touches the same line of App.tsx
		writeFileSync(join(repo, "App.tsx"), "routes: home, offers\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-q", "-m", "another unit");
		const config = { target: { path: repo, git: { branch: "main" } } } as any;
		await expect(rebaseOnMain(config, wt, "unit/U1", "feat: U1")).rejects.toThrow(/merge conflict/);
		// the aborted rebase leaves the unit's commit as the worktree head: that is what goes back
		const sha = (await headOf(wt))!;
		expect(git(wt, "log", "-1", "--format=%s")).toBe("feat: U1");
		await removeWorktree(repo, wt);
		git(repo, "branch", "-q", "-D", "unit/U1");
		await addWorktree(repo, wt, "unit/U1");
		expect(await restoreUnitWork(wt, sha)).toEqual(["App.tsx"]);
		expect(readFileSync(join(wt, "UsersPage.tsx"), "utf8")).toBe("users page\n");
		expect(readFileSync(join(wt, "App.tsx"), "utf8")).toMatch(/<<<<<<< HEAD\nroutes: home, offers\n=======\nroutes: home, users\n>>>>>>> /);
		// uncommitted and no cherry-pick left in progress: the next merge commits it as usual
		expect(git(wt, "status", "--porcelain").split("\n").map((l) => l.trim()).sort()).toEqual(["?? UsersPage.tsx", "M App.tsx"]);
		expect(() => git(wt, "rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD")).toThrow();
		expect(conflictFilesNote(["App.tsx"])).toMatch(/App\.tsx.*<<<<<<< HEAD/);
	});

	it("a code job starts from a waiting unit's kept code only when it applies cleanly; a clash leaves its worktree as main", async () => {
		const root = mkdtempSync(join(tmpdir(), "br-apply-"));
		const repo = join(root, "repo");
		execFileSync("git", ["init", "-q", "-b", "main", repo]);
		writeFileSync(join(repo, "App.tsx"), "routes: home\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-q", "-m", "init");
		const unit = join(root, "unit");
		await addWorktree(repo, unit, "unit/U179");
		writeFileSync(join(unit, "StatusMailRenderer.php"), "class StatusMailRenderer {}\n");
		git(unit, "add", "-A");
		git(unit, "commit", "-q", "-m", "wip: U179");
		const kept = (await headOf(unit))!;
		const job = join(root, "job");
		await addWorktree(repo, job, "code/q1");
		expect(await applyCleanly(job, kept)).toBe(true);
		expect(readFileSync(join(job, "StatusMailRenderer.php"), "utf8")).toBe("class StatusMailRenderer {}\n");
		expect(git(job, "status", "--porcelain")).toBe("?? StatusMailRenderer.php");
		// kept code that clashes with main: nothing of it stays
		writeFileSync(join(unit, "App.tsx"), "routes: home, mail\n");
		git(unit, "commit", "-q", "-am", "wip 2");
		writeFileSync(join(repo, "App.tsx"), "routes: home, offers\n");
		git(repo, "commit", "-q", "-am", "another unit");
		const job2 = join(root, "job2");
		await addWorktree(repo, job2, "code/q2");
		expect(await applyCleanly(job2, (await headOf(unit))!)).toBe(false);
		expect(git(job2, "status", "--porcelain")).toBe("");
	});

	it("a unit waiting on a question keeps its code when its lane ends, like a quarantined one; a unit back in the queue does not", async () => {
		const { Ledger } = await import("../src/ledger/db.ts");
		const ledger = new Ledger(":memory:");
		ledger.createUnit({ id: "U179", tier: "T1", symbolIds: [] });
		ledger.transitionUnit("U179", "implementing", "t");
		expect(keepsCode(ledger, "U179")).toBe(false);
		ledger.updateUnit("U179", { meta: { parked: { question: 4226 } } });
		expect(keepsCode(ledger, "U179")).toBe(true);
		ledger.updateUnit("U179", { meta: { parked: undefined } });
		ledger.transitionUnit("U179", "quarantined", "t");
		expect(keepsCode(ledger, "U179")).toBe(true);
	});
});
