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
