import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exec } from "../src/proc.ts";
import { addWorktree, removeWorktree } from "../src/git.ts";

describe("exec (the awaited stand-in for a sync launch)", () => {
	it("resolves with stdout", async () => {
		expect(await exec("sh", ["-c", "printf hi"])).toBe("hi");
	});
	it("rejects with the fields a sync launch's error had", async () => {
		const e = await exec("sh", ["-c", "echo out; echo err >&2; exit 3"]).catch((x) => x);
		expect(e).toMatchObject({ status: 3, signal: null, stdout: "out\n", stderr: "err\n" });
	});
	it("a command that cannot start rejects with its code", async () => {
		const e = await exec("no-such-command-br", []).catch((x) => x);
		expect(e.code).toBe("ENOENT");
	});
	it("a timeout kills the command", async () => {
		const e = await exec("sleep", ["5"], { timeout: 100 }).catch((x) => x);
		expect(e).toMatchObject({ code: "ETIMEDOUT", signal: "SIGTERM" });
	});
});

describe("worktrees made side by side", () => {
	it("parallel lanes adding and removing worktrees of one repo never collide on git's locks", async () => {
		const repo = mkdtempSync(join(tmpdir(), "br-wt-race-"));
		const g = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
		g(["init", "-q", "-b", "main"]);
		writeFileSync(join(repo, "a.txt"), "a\n");
		g(["add", "-A"]);
		g(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
		const wts = Array.from({ length: 8 }, (_, i) => join(repo, "..", `${repo.split("/").at(-1)}-wt${i}`));
		await Promise.all(wts.map((wt, i) => addWorktree(repo, wt, `unit/U${i}`)));
		expect(wts.every((wt) => existsSync(join(wt, "a.txt")))).toBe(true);
		await Promise.all(wts.map((wt) => removeWorktree(repo, wt)));
		expect(wts.some((wt) => existsSync(wt))).toBe(false);
	});
});
