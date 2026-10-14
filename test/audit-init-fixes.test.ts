import { execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TargetAdapter } from "../src/adapters/types.ts";
import { ConfigSchema } from "../src/config.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

function targetRepo(id: string) {
	const root = tmp("br-audit-");
	const target = join(root, "new");
	mkdirSync(join(target, "src"), { recursive: true });
	writeFileSync(join(target, "src", "a.spec.txt"), "a test\n");
	const adapter = {
		id,
		toolchain: { isProjectReady: () => true },
		layout: { moduleDir: (a: string) => `src/features/${a}`, sharedDirs: ["src/shared/"], isTestFile: (p: string) => /\.spec\./.test(p), sourceExtensions: [".ts"], ignoreDirs: [] },
		generatedFiles: [],
	} as unknown as TargetAdapter;
	const config = ConfigSchema.parse({ source: { path: root, stack: "php" }, target: { path: target, stacks: [id] }, models: {} });
	return { root, target, adapter, config };
}

describe("setup fix during the run: renames and failed commits", () => {
	it("a test the fixer renamed with git mv is put back under its old name", async () => {
		const { undoMigratedCode } = await import("../src/init/setup-fixer.ts");
		const { ensureRepo, commitAll } = await import("../src/git.ts");
		const { target, adapter } = targetRepo("mv");
		await ensureRepo(target, "migration/main", []);
		await commitAll(target, "init");
		git(target, "mv", "src/a.spec.txt", "src/b.spec.txt");
		expect(await undoMigratedCode(target, target, adapter)).toEqual(["src/b.spec.txt"]);
		expect(existsSync(join(target, "src", "a.spec.txt"))).toBe(true);
		expect(existsSync(join(target, "src", "b.spec.txt"))).toBe(false);
		expect(git(target, "status", "--porcelain")).toBe("");
	});

	it("a commit a hook refuses leaves main clean, not with the fixer's edits", async () => {
		const { fixRunSetup } = await import("../src/init/setup-fixer.ts");
		const { ensureRepo, commitAll } = await import("../src/git.ts");
		const { root, target, adapter, config } = targetRepo("hook");
		await ensureRepo(target, "migration/main", []);
		await commitAll(target, "init");
		const hook = join(target, ".git", "hooks", "pre-commit");
		writeFileSync(hook, "#!/bin/sh\nexit 1\n");
		chmodSync(hook, 0o755);
		const fixer = async (o: { projectDir: string }) => (writeFileSync(join(o.projectDir, "tool.config"), "x\n"), "added a config");
		await expect(fixRunSetup({ config, root, adapter, projectDir: target, problem: "p", fixer })).rejects.toThrow();
		expect(git(target, "status", "--porcelain")).toBe("");
		expect(existsSync(join(target, "tool.config"))).toBe(false);
	});
});

describe("generated target adapters", () => {
	it("one broken manifest is skipped, the others still load", async () => {
		const { loadManifests, generatedDir } = await import("../src/adapters/target/generated.ts");
		const root = tmp("br-manifests-");
		mkdirSync(generatedDir(root), { recursive: true });
		writeFileSync(join(generatedDir(root), "broken.json"), "{ cut off");
		expect(loadManifests(root)).toEqual([]);
	});
});

describe("runCommand", () => {
	it("settles when the command exits, even if a background child keeps its output open", async () => {
		const { runCommand, setOutputHost } = await import("../src/proc.ts");
		setOutputHost("ui");
		try {
			const t0 = Date.now();
			await runCommand("sh", ["-c", "sleep 8 & echo started"], { cwd: tmpdir() });
			expect(Date.now() - t0).toBeLessThan(6000);
		} finally {
			setOutputHost("terminal");
		}
	}, 15_000);
});

describe("tree-sitter grammar loading", () => {
	it("a grammar that failed to load is loaded again after it is replaced at the same path", async () => {
		const { getLanguage, registerGrammar } = await import("../src/inventory/treesitter.ts");
		const dir = tmp("br-grammar-");
		const wasm = join(dir, "lang.wasm");
		writeFileSync(wasm, "not a wasm file");
		registerGrammar("audit-lang", wasm);
		await expect(getLanguage("audit-lang")).rejects.toThrow();
		copyFileSync(createRequire(import.meta.url).resolve("tree-sitter-php/tree-sitter-php.wasm"), wasm);
		await expect(getLanguage("audit-lang")).resolves.toBeDefined();
	});
});

describe("PHP entry points", () => {
	it("an entry point the profile names is seen in a fresh process (the profile is loaded, not just read from the cache)", async () => {
		const { phpAdapter, exampleProfileJson } = await import("../src/adapters/source/php.ts");
		const ws = tmp("br-php-entry-");
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		writeFileSync(join(ws, ".bigrefactor", "framework-profile.json"), JSON.stringify({ ...exampleProfileJson(), entryPoint: "(^|/)tooling/cron\\.php$" }));
		const before = { ws: process.env["BR_WORKSPACE"], src: process.env["BR_SOURCE_ROOT"] };
		process.env["BR_WORKSPACE"] = ws;
		process.env["BR_SOURCE_ROOT"] = join(ws, "legacy");
		try {
			phpAdapter.reloadProfile?.();
			expect(phpAdapter.isEntryPoint?.("tooling/cron.php")).toBe(true);
		} finally {
			process.env["BR_WORKSPACE"] = before.ws;
			if (before.src === undefined) delete process.env["BR_SOURCE_ROOT"];
			else process.env["BR_SOURCE_ROOT"] = before.src;
			if (before.ws === undefined) delete process.env["BR_WORKSPACE"];
		}
	});
});

describe("onboarding steps count as done only when they finished", () => {
	it("rules: RULES.md alone is not done", async () => {
		const { rulesPresent } = await import("../src/init/rules.ts");
		const { rulesDir } = await import("../src/rules/layout.ts");
		const { config } = targetRepo("nestjs");
		const root = tmp("br-rules-");
		mkdirSync(join(rulesDir(root, "nestjs"), "astgrep"), { recursive: true });
		writeFileSync(join(rulesDir(root, "nestjs"), "RULES.md"), "# rules\n");
		expect(rulesPresent(root, config)).toBe(false);
		for (const f of ["AGENTS.md", "idioms.json"]) writeFileSync(join(rulesDir(root, "nestjs"), f), "[]");
		writeFileSync(join(rulesDir(root, "nestjs"), "astgrep", "no-any.yml"), "id: no-any\n");
		expect(rulesPresent(root, config)).toBe(true);
	});

	it("setup: done only for the stacks and choices it was run for", async () => {
		const { setupDone } = await import("../src/init/init.ts");
		const { statePath } = await import("../src/config.ts");
		const root = tmp("br-setup-");
		const config = ConfigSchema.parse({ source: { path: root, stack: "php" }, target: { path: join(root, "new"), stacks: ["nestjs"], choices: { nestjs: { orm: "prisma" } } }, models: {} });
		const adapters = [{ id: "nestjs", toolchain: { isProjectReady: () => true, installedPackages: () => [] } } as unknown as TargetAdapter];
		expect(await setupDone(config, root, adapters)).toBe(false); // project files but no commit: a stopped setup
		writeFileSync(statePath(root, "setup-done.json"), JSON.stringify({ stacks: ["nestjs"], choices: { nestjs: { orm: "prisma" } } }));
		expect(await setupDone(config, root, adapters)).toBe(true);
		config.target.choices["nestjs"] = { orm: "typeorm" };
		expect(await setupDone(config, root, adapters)).toBe(false);
	});
});

describe("run lock", () => {
	it("a live run refuses a second one; a lock whose process is gone is ignored", async () => {
		const { acquireRunLock, liveRun } = await import("../src/run/run-lock.ts");
		const { statePath } = await import("../src/config.ts");
		const root = tmp("br-lock-");
		const other = spawn("sleep", ["10"]);
		try {
			writeFileSync(statePath(root, "run.lock"), String(other.pid));
			expect(liveRun(root)).toBe(other.pid);
			expect(() => acquireRunLock(root)).toThrow(/already going/);
		} finally {
			other.kill();
		}
		await new Promise((r) => other.on("exit", r));
		expect(liveRun(root)).toBeUndefined();
		const release = acquireRunLock(root);
		expect(readFileSync(statePath(root, "run.lock"), "utf8")).toBe(String(process.pid));
		release();
		expect(liveRun(root)).toBeUndefined();
	});

	it("while a run is live, requeue leaves the units it is working on alone", async () => {
		const { requeueScope } = await import("../src/run/run-lock.ts");
		const { statePath } = await import("../src/config.ts");
		const { Ledger } = await import("../src/ledger/db.ts");
		const root = tmp("br-lock-");
		const ledger = new Ledger(":memory:");
		for (const id of ["busy", "stuck"]) ledger.createUnit({ id, tier: "T1", deps: [], meta: {}, symbolIds: [] });
		ledger.db.prepare("UPDATE units SET state = ? WHERE id = ?").run("implementing", "busy");
		ledger.db.prepare("UPDATE units SET state = ? WHERE id = ?").run("quarantined", "stuck");
		expect(requeueScope(ledger, root, "all")).toEqual({ ids: "all", refused: [] });
		writeFileSync(statePath(root, "run.lock"), String(process.pid));
		expect(requeueScope(ledger, root, "all").ids).toEqual(["stuck"]);
		const r = requeueScope(ledger, root, ["busy", "stuck"]);
		expect(r.ids).toEqual(["stuck"]);
		expect(r.refused[0]).toMatch(/^busy: the live run/);
	});
});
