import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimMainBranch, wsBranch } from "../src/git.ts";

const dirs: string[] = [];
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), "br-ws-"));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("two workspaces on one target repo", () => {
	it("make different branch names for the same unit, valid as git branch names", () => {
		const a = wsBranch("/x/pi-run", "unit/U1");
		const b = wsBranch("/x/pirun", "unit/U1");
		expect(a).not.toBe(b);
		expect(a).toMatch(/^br-pi-run-[0-9a-f]{6}\/unit\/U1$/);
		expect(wsBranch("/x/pi-run", "unit/U1")).toBe(a);
		const repo = tmp();
		execFileSync("git", ["init", "-q", repo]);
		for (const n of [a, b, wsBranch("/x/odd name.v2", "unit/U1")]) execFileSync("git", ["check-ref-format", "--branch", n], { cwd: repo });
	});

	it("only the first may migrate into one main branch while it exists; a gone workspace's claim is taken over", async () => {
		const repo = tmp();
		execFileSync("git", ["init", "-q", repo]);
		const first = tmp();
		const second = tmp();
		mkdirSync(join(first, ".bigrefactor"));
		expect(await claimMainBranch(repo, "migration/main", first)).toBeUndefined();
		expect(await claimMainBranch(repo, "migration/main", first)).toBeUndefined();
		expect(await claimMainBranch(repo, "migration/main", second)).toBe(first);
		// another main branch of the same repo is free
		expect(await claimMainBranch(repo, "migration/nest", second)).toBeUndefined();
		rmSync(join(first, ".bigrefactor"), { recursive: true });
		expect(await claimMainBranch(repo, "migration/main", second)).toBeUndefined();
		expect(await claimMainBranch(repo, "migration/main", first)).toBeUndefined();
	});
});
