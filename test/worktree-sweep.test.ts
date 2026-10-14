import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addWorktree } from "../src/git.ts";
import { Ledger } from "../src/ledger/db.ts";
import { freeDiskGb, sweepWorktrees } from "../src/run/run.ts";

/** At the start, worktrees nothing will resume (accepted units, code jobs, builders) are removed; disk space is read. */
let ws: string;
let repo: string;
let dir: string;
let ledger: Ledger;
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
	ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
});
afterEach(() => {
	ledger.close();
	rmSync(ws, { recursive: true, force: true });
});

describe("leftover worktrees", () => {
	it("removes those of accepted units and old jobs, keeps the ones a unit resumes in", () => {
		for (const id of ["u1", "u2", "u3"]) ledger.createUnit({ id, tier: "T0", symbolIds: [] });
		ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = 'u1'").run();
		ledger.db.prepare("UPDATE units SET state = 'quarantined' WHERE id = 'u3'").run();
		for (const [n, b] of [["u1", "unit/u1"], ["u1-ahead", "ahead/u1"], ["u2", "unit/u2"], ["u3", "unit/u3"], ["__code__build-react-1", "code/x"], ["__builder__react", "builder/react"]]) addWorktree(repo, join(dir, n!), b!);
		expect(sweepWorktrees(ledger, repo, dir).sort()).toEqual(["__builder__react", "__code__build-react-1", "u1", "u1-ahead"]);
		expect(existsSync(join(dir, "u2"))).toBe(true);
		expect(existsSync(join(dir, "u3"))).toBe(true);
		expect(existsSync(join(dir, "u1"))).toBe(false);
	});

	it("reads the free disk space", () => {
		expect(freeDiskGb(ws)).toBeGreaterThan(0);
		expect(freeDiskGb(join(ws, "missing"))).toBeUndefined();
	});
});
