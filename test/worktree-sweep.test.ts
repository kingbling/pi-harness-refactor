import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addWorktree } from "../src/git.ts";
import { freeDiskGb, sweepWorktrees } from "../src/run/run.ts";

/** At the start every leftover worktree is removed; disk space is read. */
let ws: string;
let repo: string;
let dir: string;
beforeEach(() => {
	ws = mkdtempSync(join(tmpdir(), "br-sweep-"));
	repo = join(ws, "repo");
	dir = join(ws, ".bigrefactor", "worktrees");
	mkdirSync(repo, { recursive: true });
	mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "-q"], { cwd: repo });
	writeFileSync(join(repo, "a.txt"), "a\n");
	execFileSync("git", ["add", "-A"], { cwd: repo });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
});
afterEach(() => {
	rmSync(ws, { recursive: true, force: true });
});

describe("leftover worktrees", () => {
	it("removes every leftover worktree: nothing resumes in one, a unit's next run starts from a fresh one", () => {
		for (const [n, b] of [["u1", "unit/u1"], ["u1-ahead", "ahead/u1"], ["u2", "unit/u2"], ["__code__build-react-1", "code/x"], ["__builder__react", "builder/react"]]) addWorktree(repo, join(dir, n!), b!);
		mkdirSync(join(dir, ".trash"), { recursive: true });
		expect(sweepWorktrees(repo, dir).sort()).toEqual(["__builder__react", "__code__build-react-1", "u1", "u1-ahead", "u2"]);
		expect(existsSync(join(dir, "u2"))).toBe(false);
		expect(existsSync(join(dir, ".trash"))).toBe(true);
	});

	it("reads the free disk space", () => {
		expect(freeDiskGb(ws)).toBeGreaterThan(0);
		expect(freeDiskGb(join(ws, "missing"))).toBeUndefined();
	});
});
