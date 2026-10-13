import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { everOnMain } from "../src/run/unit.ts";

/** Saved tests are not put back at a path main once had: another unit's test, or one tidy moved since. */
describe("everOnMain", () => {
	it("names the paths main's history held, also ones moved away since", () => {
		const repo = mkdtempSync(join(tmpdir(), "br-ever-"));
		const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, stdio: "pipe" });
		git("init", "-q");
		mkdirSync(join(repo, "app", "tests"), { recursive: true });
		writeFileSync(join(repo, "app", "tests", "OldTest.php"), "<?php\n");
		git("add", "-A");
		git("commit", "-qm", "a");
		mkdirSync(join(repo, "app", "moved"), { recursive: true });
		git("mv", "app/tests/OldTest.php", "app/moved/OldTest.php");
		git("commit", "-qm", "tidy");
		const dir = join(repo, "app");
		expect(everOnMain(dir, ["tests/OldTest.php", "tests/MineTest.php"])).toEqual(new Set(["tests/OldTest.php"]));
		expect(everOnMain(tmpdir(), ["x.php"])).toEqual(new Set());
	});
});
