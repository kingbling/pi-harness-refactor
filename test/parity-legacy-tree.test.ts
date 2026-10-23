import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitAll, ensureRepo, git, headOf } from "../src/git.ts";
import { legacyTree } from "../src/run/parity-legacy-tree.ts";

let root: string, source: string, runtime: string, dependency: string, revision: string;
beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "br-legacy-tree-"));
	source = join(root, "source"); runtime = join(root, "runtime"); dependency = join(root, "dependency");
	for (const dir of [source, dependency]) mkdirSync(dir);
	writeFileSync(join(dependency, "framework.php"), "<?php return 42;\n");
	await ensureRepo(dependency, "main"); await commitAll(dependency, "framework snapshot");
	writeFileSync(join(source, "entry.php"), "<?php require 'vendor/framework.php';\n");
	await ensureRepo(source, "main"); await commitAll(source, "app snapshot");
	await git(source, ["-c", "protocol.file.allow=always", "submodule", "add", dependency, "vendor"]);
	// A symlink to a directory must be checked as a link, not opened as if it were a file.
		symlinkSync("vendor", join(source, "framework-link"));
	await commitAll(source, "pin framework submodule and symlink");
	revision = (await headOf(source))!;
	cpSync(source, runtime, { recursive: true, verbatimSymlinks: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("pinned legacy tree provenance", () => {
	it("hashes initialized submodule files and directory symlinks and retains the exact submodule revision", async () => {
		const r = await legacyTree(source, runtime, revision);
		expect(r.mismatches).toEqual([]);
		expect(r.files).toBe(6); // app file, .gitignore, .gitmodules, link, framework file and its .gitignore
		expect(r.hash).toHaveLength(64);
		expect(r.submodules).toEqual({ vendor: await headOf(dependency) });
		expect(await legacyTree(source, runtime, revision)).toEqual(r);
	});
	it("detects a changed framework file and a changed symlink, with overlays limited to their exact paths", async () => {
		const first = await legacyTree(source, runtime, revision);
		writeFileSync(join(runtime, "vendor/framework.php"), "<?php return 99;\n");
		rmSync(join(runtime, "framework-link")); symlinkSync(".", join(runtime, "framework-link"));
		const r = await legacyTree(source, runtime, revision);
		expect(r.mismatches).toEqual(["framework-link", "vendor/framework.php"]);
		expect(r.hash).not.toBe(first.hash);
		expect((await legacyTree(source, runtime, revision, ["vendor/framework.php"])).mismatches).toEqual(["framework-link"]);
	});
	it("descends through nested submodules and reports their full paths and pinned revisions", async () => {
		const nested = join(root, "nested"); mkdirSync(nested);
		writeFileSync(join(nested, "helper.php"), "<?php return 7;\n");
		await ensureRepo(nested, "main"); await commitAll(nested, "nested snapshot");
		await git(join(source, "vendor"), ["-c", "protocol.file.allow=always", "submodule", "add", nested, "deep"]);
		await commitAll(join(source, "vendor"), "pin nested dependency"); await commitAll(source, "update framework pin");
		revision = (await headOf(source))!;
		rmSync(runtime, { recursive: true, force: true }); cpSync(source, runtime, { recursive: true, verbatimSymlinks: true });
		const r = await legacyTree(source, runtime, revision);
		expect(r.mismatches).toEqual([]);
		expect(r.submodules).toEqual({ vendor: await headOf(join(source, "vendor")), "vendor/deep": await headOf(nested) });
		writeFileSync(join(runtime, "vendor/deep/helper.php"), "<?php return 8;\n");
		expect((await legacyTree(source, runtime, revision)).mismatches).toEqual(["vendor/deep/helper.php"]);
	});
	it("rejects an uninitialized submodule or a checkout at a different revision", async () => {
		rmSync(join(source, "vendor/.git"));
		await expect(legacyTree(source, runtime, revision)).rejects.toThrow("submodule vendor is not initialized");
		writeFileSync(join(source, "vendor/.git"), "gitdir: ../.git/modules/vendor\n");
		writeFileSync(join(source, "vendor/framework.php"), "<?php return 99;\n");
		await commitAll(join(source, "vendor"), "unapproved framework change");
		await expect(legacyTree(source, runtime, revision)).rejects.toThrow("expected pinned revision");
	});
	it("detects missing tracked files and executable-mode changes", async () => {
		rmSync(join(runtime, "vendor/framework.php"));
		chmodSync(join(runtime, "entry.php"), 0o755);
		expect((await legacyTree(source, runtime, revision)).mismatches).toEqual(["entry.php", "vendor/framework.php"]);
	});
});
