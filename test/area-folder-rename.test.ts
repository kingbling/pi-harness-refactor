import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TargetLayout } from "../src/adapters/types.ts";
import { ConfigSchema } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { renameMisspelledAreaDirs } from "../src/run/placement.ts";

/**
 * The plugin changed how it spells an area's folder (src/Shared/persistence → src/Shared/Persistence): code already
 * in git moves along, so new units land next to it. Two steps in git, so case-only renames work on macOS too.
 */
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function workspace(files: string[]) {
	const ws = mkdtempSync(join(tmpdir(), "br-rename-"));
	const repo = join(ws, "migrated");
	for (const f of files) {
		mkdirSync(dirname(join(repo, f)), { recursive: true });
		writeFileSync(join(repo, f), "<?php\n");
	}
	git(repo, "init", "-q", "-b", "main");
	git(repo, "add", "-A");
	git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
	const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: repo, stacks: ["symfony"] }, models: {} });
	const ledger = new Ledger(":memory:");
	const unit = (id: string, area: string, shared: boolean) => ledger.createUnit({ id, tier: "T1", symbolIds: [], meta: { files: [`legacy/${id}.php`], place: { stack: "symfony", area, shared, source: "model" } } });
	// only what placement reads: the stack's area folder ({Area} → PascalCase) and its shared dir
	const pascal = (a: string) => a.split("-").map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");
	const layout = { moduleDir: (a: string) => `src/${pascal(a)}`, sharedDirs: ["src/Shared/"] } as unknown as TargetLayout;
	const rename = () => renameMisspelledAreaDirs(config, ledger, new Map([["symfony", layout]]), () => repo);
	return { repo, unit, rename };
}

describe("area folders follow the plugin's spelling", () => {
	it("renames a case-only and a kebab spelling in git, commits it, and leaves the right ones alone", () => {
		const { repo, unit, rename } = workspace(["src/Shared/persistence/DynamicData.php", "src/Shared/persistence/tests/DynamicDataTest.php", "src/Shared/file-storage/DocumentOwner.php", "src/Campaigns/Campaign.php"]);
		unit("U1", "persistence", true);
		unit("U2", "file-storage", true);
		unit("U3", "campaigns", false);
		expect(rename().sort()).toEqual(["src/Shared/file-storage → src/Shared/FileStorage", "src/Shared/persistence → src/Shared/Persistence"]);
		expect(git(repo, "ls-files").split("\n").sort()).toEqual(["src/Campaigns/Campaign.php", "src/Shared/FileStorage/DocumentOwner.php", "src/Shared/Persistence/DynamicData.php", "src/Shared/Persistence/tests/DynamicDataTest.php"]);
		expect(git(repo, "status", "--porcelain")).toBe("");
		expect(rename()).toEqual([]); // nothing left to do
	});

	it("leaves the folders alone while something is staged", () => {
		const { repo, unit, rename } = workspace(["src/Shared/persistence/DynamicData.php"]);
		unit("U1", "persistence", true);
		writeFileSync(join(repo, "README.md"), "x\n");
		git(repo, "add", "README.md");
		expect(rename()).toEqual([]);
		expect(git(repo, "ls-files")).toContain("src/Shared/persistence/DynamicData.php");
	});
});
