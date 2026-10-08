import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commitAll, ensureRepo } from "../src/git.ts";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("git: a target nested inside another checkout", () => {
	it("gets its own repo; commits never land in the parent (bigrefactor's own .sim/ lives inside its repo)", () => {
		const parent = realpathSync(mkdtempSync(join(tmpdir(), "br-parent-")));
		git(parent, ["init", "-q", "-b", "main"]);
		writeFileSync(join(parent, "keep.txt"), "x\n");
		git(parent, ["add", "-A"]);
		git(parent, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "parent"]);
		const target = join(parent, ".sim", "l1", "migrated");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "a.txt"), "a\n");
		writeFileSync(join(parent, "untracked-in-parent.txt"), "must stay untracked\n");
		ensureRepo(target, "migration/main");
		expect(realpathSync(git(target, ["rev-parse", "--show-toplevel"]))).toBe(target);
		commitAll(target, "chore: bootstrap (simulated)");
		expect(git(parent, ["log", "--oneline"]).split("\n")).toHaveLength(1);
		expect(git(parent, ["status", "--porcelain"])).toContain("untracked-in-parent.txt");
		expect(git(target, ["log", "--format=%s"])).toBe("chore: bootstrap (simulated)");
	});
});

describe("git: removing a unit worktree", () => {
	it("is instant: the folder moves aside, git forgets it, the files go in the background, and the unit can start again", async () => {
		const { addWorktree, removeWorktree } = await import("../src/git.ts");
		const { existsSync, readdirSync } = await import("node:fs");
		const repo = realpathSync(mkdtempSync(join(tmpdir(), "br-wt-")));
		ensureRepo(repo, "migration/main", []);
		writeFileSync(join(repo, "a.txt"), "x\n");
		commitAll(repo, "init");
		const wt = join(repo, "..", `${repo.split("/").pop()}-wts`, "U1");
		addWorktree(repo, wt, "unit/U1");
		mkdirSync(join(wt, "vendor", "deep"), { recursive: true });
		writeFileSync(join(wt, "vendor", "deep", "f.php"), "<?php\n");
		removeWorktree(repo, wt);
		expect(existsSync(wt)).toBe(false);
		expect(git(repo, ["worktree", "list"])).not.toMatch(/U1/);
		addWorktree(repo, wt, "unit/U1");
		expect(existsSync(join(wt, "a.txt"))).toBe(true);
		await new Promise((r) => setTimeout(r, 200));
		expect(readdirSync(join(wt, "..", ".trash"))).toEqual([]);
	});
});

describe("git: the branch units merge into", () => {
	it("follows the checked-out branch when the configured one was renamed by hand; a merge onto it works", async () => {
		const { addWorktree, mainBranch } = await import("../src/git.ts");
		const { mergeUnit } = await import("../src/run/run.ts");
		const { ConfigSchema } = await import("../src/config.ts");
		const repo = realpathSync(mkdtempSync(join(tmpdir(), "br-branch-")));
		ensureRepo(repo, "migration/main", []);
		writeFileSync(join(repo, "a.txt"), "x\n");
		commitAll(repo, "init");
		expect(mainBranch(repo, "migration/main")).toBe("migration/main");
		git(repo, ["branch", "-m", "migration/main", "main"]); // what the owner did to publish it as main
		expect(mainBranch(repo, "migration/main")).toBe("main");
		const config = ConfigSchema.parse({ source: { path: repo, stack: "php" }, target: { path: repo, stacks: ["nestjs"] }, models: {} });
		const wt = join(repo, "..", `${repo.split("/").pop()}-wt`);
		addWorktree(repo, wt, "unit/U1");
		writeFileSync(join(wt, "b.txt"), "y\n");
		expect(mergeUnit(config, "U1", wt, "unit/U1", repo)).toBeTruthy();
		expect(git(repo, ["log", "-1", "--format=%s"])).toBe("feat: migrate U1");
	});
});
