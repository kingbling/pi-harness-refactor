import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitIgnoredDirs, skipDir } from "../src/inventory/ignored.ts";
import { findDbFiles } from "../src/inventory/db.ts";

const repo = (files: Record<string, string>, git = true) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "br-ignored-")));
	for (const [f, body] of Object.entries(files)) (mkdirSync(dirname(join(dir, f)), { recursive: true }), writeFileSync(join(dir, f), body));
	if (git) execFileSync("git", ["init", "-q"], { cwd: dir });
	return dir;
};

describe("folders scans skip: the adapters' and what git ignores, no fixed list", () => {
	it("git's ignored folders are skipped, untracked folders that only hold an ignored file are not", async () => {
		const dir = repo({ ".gitignore": "node_modules/\n/target/\n*.gz\n", "web/node_modules/pkg/schema.json": "{}", "target/classes/schema.sql": "", "db/schema.sql": "", "backup/dump.sql.gz": "x".repeat(60_000), "lib/deps/x.sql": "" });
		const ignored = await gitIgnoredDirs(dir);
		expect([...ignored].sort()).toEqual(["target", "web/node_modules"]);
		const skip = skipDir(dir, ["deps"], ignored);
		expect(skip(join(dir, "web", "node_modules"))).toBe(true);
		expect(skip(join(dir, "lib", "deps"))).toBe(true); // the adapter names it
		expect(skip(join(dir, "backup"))).toBe(false);
		const found = await findDbFiles(dir, ["deps"]);
		expect(found.schema).toEqual(["db/schema.sql"]);
		expect(found.dumps).toEqual(["backup/dump.sql.gz"]); // an ignored dump in a folder git keeps is still found
	});

	it("outside a git repo only dot folders and the adapters' folders are skipped", async () => {
		const dir = repo({ "vendor/a/schema.sql": "", "node_modules/b/schema.sql": "", "db/schema.sql": "" }, false);
		expect((await gitIgnoredDirs(dir)).size).toBe(0);
		expect((await findDbFiles(dir, ["vendor", "node_modules"])).schema).toEqual(["db/schema.sql"]);
	});
});
