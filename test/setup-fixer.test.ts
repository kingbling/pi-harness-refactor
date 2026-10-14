import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveCommandOverride } from "../src/adapters/command-overrides.ts";
import type { TargetAdapter } from "../src/adapters/types.ts";
import { ConfigSchema } from "../src/config.ts";
import { checkToolchain } from "../src/init/init.ts";
import type { SetupFixer } from "../src/init/setup-fixer.ts";

/** A stack whose built-in commands no longer fit the installed tools; the setup fixer repairs it, code re-checks. */
function stack(over: Partial<TargetAdapter> = {}) {
	const root = mkdtempSync(join(tmpdir(), "br-fix-"));
	const target = join(root, "new");
	mkdirSync(join(target, "src"), { recursive: true });
	writeFileSync(join(target, "ready"), "");
	const adapter = {
		id: "fixme",
		toolchain: { isProjectReady: () => true },
		probeTest: () => ({ path: "src/probe.spec.txt", content: "expect(1 + 1).toBe(2)\n", failing: "expect(1 + 1).toBe(3)\n" }),
		build: () => ({ cmd: "true", args: [] }),
		lint: () => ({ cmd: "true", args: [] }),
		// the "old flag": always fails, like vitest 5 on --related
		test: () => ({ cmd: "sh", args: ["-c", "echo 'Unknown option --related' >&2; exit 1"] }),
		layout: { moduleDir: (a: string) => `src/features/${a}`, sharedDirs: ["src/shared/"], isTestFile: (p: string) => /\.spec\./.test(p), sourceExtensions: [".ts", ".tsx"], ignoreDirs: ["node_modules"] },
		generatedFiles: [],
		...over,
	} as unknown as TargetAdapter;
	const config = ConfigSchema.parse({ source: { path: root, stack: "php" }, target: { path: target, stacks: ["fixme"] }, models: {} });
	return { root, target, adapter, config };
}
// a real test runner stand-in: green when the probe expects 2, red otherwise
const grep = { cmd: "grep", args: ["-q", "toBe(2)", "{files}"] };

describe("setup check: a model with tools fixes what fails, code decides it worked", () => {
	it("hands the error to the fixer; its command override is used from then on", async () => {
		const { root, adapter, config } = stack();
		const seen: string[] = [];
		const fix: SetupFixer = async (o) => {
			seen.push(o.problem);
			saveCommandOverride(o.root, o.adapter.id, "test", grep, "the flag is gone");
		};
		await checkToolchain(config, adapter, { root, fix });
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatch(/test command fails on a fresh project[\s\S]*Unknown option --related/);
	});

	it("a test command that cannot fail is not a fix; after the tries the owner gets the last problem", async () => {
		const { root, adapter, config } = stack();
		let calls = 0;
		const fix: SetupFixer = async (o) => {
			calls++;
			saveCommandOverride(o.root, o.adapter.id, "test", { cmd: "true", args: [] }, "cheat");
		};
		await expect(checkToolchain(config, adapter, { root, fix, attempts: 2 })).rejects.toThrow(/passes a failing test[\s\S]*could not fix it in 2 tries/);
		expect(calls).toBe(2);
	});

	it("without a workspace or with the fixer off, a failure stops setup as before", async () => {
		const { adapter, config } = stack();
		await expect(checkToolchain(config, adapter, { fix: false })).rejects.toThrow(/test command fails on a fresh project/);
	});
});

describe("setup fixes during the run", () => {
	it("units failing on the same setup problem share one fix; the change is committed; nothing changed = ask the owner", async () => {
		const { fixRunSetup } = await import("../src/init/setup-fixer.ts");
		const { ensureRepo, commitAll } = await import("../src/git.ts");
		const { root, target, adapter, config } = stack({ id: "runfix" } as never);
		await ensureRepo(target, "migration/main", []);
		await commitAll(target, "init");
		let calls = 0;
		const fixer: SetupFixer = async (o) => {
			calls++;
			await new Promise((r) => setTimeout(r, 20));
			writeFileSync(join(o.projectDir, "vitest.config.ts"), "export default {};\n");
			return "added the missing vitest config";
		};
		const ask = () => fixRunSetup({ config, root, adapter, projectDir: target, problem: "vitest: no config", fixer });
		const [a, b] = await Promise.all([ask(), ask()]);
		expect(calls).toBe(1);
		expect(a).toBe("added the missing vitest config");
		expect(b).toBe(a);
		const { execFileSync } = await import("node:child_process");
		expect(execFileSync("git", ["-C", target, "log", "-1", "--format=%s"], { encoding: "utf8" })).toMatch(/setup fixed during the run/);
		// a session that changes nothing is no fix: the unit asks the owner
		expect(await fixRunSetup({ config, root, adapter, projectDir: target, problem: "x", fixer: async () => "looked around" })).toBeUndefined();
	});
});

describe("setup fixes during the run: tests and migrated code stay as they are", () => {
	it("puts back test files and module/shared code the fixer touched, commits the rest under the lock, and leaves a ledger row", async () => {
		const { fixRunSetup } = await import("../src/init/setup-fixer.ts");
		const { ensureRepo, commitAll } = await import("../src/git.ts");
		const { Ledger } = await import("../src/ledger/db.ts");
		const { execFileSync } = await import("node:child_process");
		const { existsSync, readFileSync } = await import("node:fs");
		const { root, target, adapter, config } = stack({ id: "keepcode" } as never);
		// the first commit is the generator's; the code folders come later
		await ensureRepo(target, "migration/main", []);
		await commitAll(target, "scaffold");
		mkdirSync(join(target, "src", "features", "orders"), { recursive: true });
		mkdirSync(join(target, "src", "shared"), { recursive: true });
		writeFileSync(join(target, "src", "features", "orders", "orders.ts"), "export const a = 1;\n");
		writeFileSync(join(target, "src", "features", "orders", "orders.spec.ts"), "expect(a).toBe(1)\n");
		writeFileSync(join(target, "src", "shared", "money.ts"), "export const m = 1;\n");
		await commitAll(target, "init");
		const ledger = new Ledger(":memory:");
		// orders.ts holds an accepted unit's code (a move points to it); money.ts sits in the shared folder but no unit wrote it
		ledger.createUnit({ id: "u1", tier: "T1", deps: [], meta: {}, symbolIds: [] });
		ledger.upsertFile({ path: "legacy.php", hash: "h", lang: "php", loc: 1 });
		ledger.upsertSymbol({ id: "legacy.php::a", name: "a", kind: "const", path: "legacy.php" });
		ledger.db.prepare("INSERT INTO moves(unit_id, src_symbol, op, target_symbols, why, created_at) VALUES ('u1', 'legacy.php::a', 'moved', ?, 'x', datetime('now'))").run(JSON.stringify(["src/features/orders/orders.ts::a"]));
		const fixer: SetupFixer = async (o) => {
			writeFileSync(join(o.projectDir, "vitest.config.ts"), "export default {};\n"); // setup: kept
			writeFileSync(join(o.projectDir, "src", "shared", "money.ts"), "export const m = 2;\n"); // wiring in a shared folder: kept
			writeFileSync(join(o.projectDir, "src", "features", "orders", "orders.ts"), "export const a = 2;\n"); // accepted code
			writeFileSync(join(o.projectDir, "src", "features", "orders", "orders.spec.ts"), "expect(a).toBe(2)\n"); // a test
			writeFileSync(join(o.projectDir, "src", "features", "orders", "extra.spec.ts"), "new test\n"); // a new test
			writeFileSync(join(o.projectDir, "src", "shared", "helper.ts"), "export {};\n"); // new shared code
			writeFileSync(join(o.projectDir, "lint.config.json"), JSON.stringify({ bootstrap: "src/shared/lint-bootstrap.ts" })); // setup: kept
			writeFileSync(join(o.projectDir, "src", "shared", "lint-bootstrap.ts"), "export {};\n"); // new code the kept config loads: kept
			return "added the vitest config";
		};
		let locked = 0;
		const lock = async <T>(fn: () => Promise<T>) => (locked++, fn());
		expect(await fixRunSetup({ config, root, adapter, projectDir: target, problem: "vitest: no config", fixer, ledger, lock })).toBe("added the vitest config");
		expect(locked).toBe(1);
		expect(execFileSync("git", ["-C", target, "show", "--name-only", "--format=", "HEAD"], { encoding: "utf8" }).trim().split("\n").sort()).toEqual(["lint.config.json", "src/shared/lint-bootstrap.ts", "src/shared/money.ts", "vitest.config.ts"]);
		expect(execFileSync("git", ["-C", target, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
		expect(readFileSync(join(target, "src", "features", "orders", "orders.ts"), "utf8")).toBe("export const a = 1;\n");
		expect(existsSync(join(target, "src", "features", "orders", "extra.spec.ts"))).toBe(false);
		const row = ledger.db.prepare("SELECT role, outcome, gate_report FROM attempts").get() as { role: string; outcome: string; gate_report: string };
		expect(row.role).toBe("__setup__:fix:keepcode");
		expect(row.outcome).toBe("fixed");
		const report = JSON.parse(row.gate_report) as { changedFiles: string[]; undone: string[]; said: string };
		expect(report.changedFiles.sort()).toEqual(["lint.config.json", "src/shared/lint-bootstrap.ts", "src/shared/money.ts", "vitest.config.ts"]);
		expect(report.undone.sort()).toEqual(["src/features/orders/extra.spec.ts", "src/features/orders/orders.spec.ts", "src/features/orders/orders.ts", "src/shared/helper.ts"]);
		expect(report.said).toBe("added the vitest config");
	});
});

describe("setup fixes during the run: no new source folders", () => {
	it("new code in a new folder next to the feature root (src/api/) is put back; a top-level wiring file and the dependency stay", async () => {
		const { fixRunSetup } = await import("../src/init/setup-fixer.ts");
		const { ensureRepo, commitAll } = await import("../src/git.ts");
		const { execFileSync } = await import("node:child_process");
		const { existsSync } = await import("node:fs");
		const { root, target, adapter, config } = stack({ id: "nostray" } as never);
		writeFileSync(join(target, "package.json"), "{}\n");
		writeFileSync(join(target, "src", "main.tsx"), "import './icons'\n");
		await ensureRepo(target, "migration/main", []);
		await commitAll(target, "scaffold");
		const fixer: SetupFixer = async (o) => {
			writeFileSync(join(o.projectDir, "package.json"), JSON.stringify({ dependencies: { highcharts: "12" } }));
			writeFileSync(join(o.projectDir, "src", "highcharts.ts"), "export {};\n");
			writeFileSync(join(o.projectDir, "src", "main.tsx"), "import './highcharts'\nimport './icons'\n");
			// the reviewer asked for "the shared client in src/api": app code, not setup
			mkdirSync(join(o.projectDir, "src", "api"), { recursive: true });
			writeFileSync(join(o.projectDir, "src", "api", "client.ts"), "export const apiFetch = 1;\n");
			writeFileSync(join(o.projectDir, "src", "api", "index.ts"), "export * from './client';\n");
			return "installed highcharts and added the client in src/api";
		};
		expect(await fixRunSetup({ config, root, adapter, projectDir: target, problem: "highcharts missing; provide the client in src/api", fixer })).toBeTruthy();
		expect(execFileSync("git", ["-C", target, "show", "--name-only", "--format=", "HEAD"], { encoding: "utf8" }).trim().split("\n").sort()).toEqual(["package.json", "src/highcharts.ts", "src/main.tsx"]);
		expect(existsSync(join(target, "src", "api", "client.ts"))).toBe(false);
	});
});

describe("setup fixes during the run: a folder the fix made holds no app code", () => {
	it("new code in a new folder inside the framework's config/ is put back; a bootstrap file a kept config names stays", async () => {
		const { fixRunSetup } = await import("../src/init/setup-fixer.ts");
		const { ensureRepo, commitAll } = await import("../src/git.ts");
		const { execFileSync } = await import("node:child_process");
		const { existsSync } = await import("node:fs");
		const { root, target, adapter, config } = stack({ id: "noconfigcode" } as never);
		mkdirSync(join(target, "config", "packages"), { recursive: true });
		writeFileSync(join(target, "config", "packages", "framework.ts"), "export {};\n");
		writeFileSync(join(target, "lint.json"), "{}\n");
		await ensureRepo(target, "migration/main", []);
		await commitAll(target, "scaffold");
		const fixer: SetupFixer = async (o) => {
			writeFileSync(join(o.projectDir, "lint.json"), JSON.stringify({ bootstrap: "config/lint-bootstrap.ts" }));
			writeFileSync(join(o.projectDir, "config", "lint-bootstrap.ts"), "export {};\n");
			writeFileSync(join(o.projectDir, "config", "packages", "cache.ts"), "export {};\n");
			mkdirSync(join(o.projectDir, "config", "reports"), { recursive: true });
			writeFileSync(join(o.projectDir, "config", "reports", "queue-factory.ts"), "export class QueueFactory {}\n");
			return "configured the linter";
		};
		expect(await fixRunSetup({ config, root, adapter, projectDir: target, problem: "lint: bootstrap missing", fixer })).toBeTruthy();
		expect(execFileSync("git", ["-C", target, "show", "--name-only", "--format=", "HEAD"], { encoding: "utf8" }).trim().split("\n").sort()).toEqual(["config/lint-bootstrap.ts", "config/packages/cache.ts", "lint.json"]);
		expect(existsSync(join(target, "config", "reports", "queue-factory.ts"))).toBe(false);
	});
});

describe("setup fixes during the run: a note is no fix", () => {
	it("a commit that changes only .md files is taken back and counts as no change", async () => {
		const { fixRunSetup } = await import("../src/init/setup-fixer.ts");
		const { ensureRepo, commitAll, headOf } = await import("../src/git.ts");
		const { existsSync } = await import("node:fs");
		const { root, target, adapter, config } = stack({ id: "notes" } as never);
		await ensureRepo(target, "migration/main", []);
		await commitAll(target, "init");
		const head = await headOf(target);
		const fixer: SetupFixer = async (o) => {
			writeFileSync(join(o.projectDir, "SETUP-NOTES.md"), "nothing to fix: the unit's own code is wrong\n");
			return "wrote down why nothing was fixed";
		};
		expect(await fixRunSetup({ config, root, adapter, projectDir: target, problem: "a test fails", fixer })).toBeUndefined();
		expect(await headOf(target)).toBe(head);
		expect(existsSync(join(target, "SETUP-NOTES.md"))).toBe(false);
	});
});

describe("setup fixes during the run: tries per problem", () => {
	it("fixes that worked do not count toward the run's cap; only sessions that changed nothing do", async () => {
		const { fixRunSetup, MAX_RUN_FIXES } = await import("../src/init/setup-fixer.ts");
		const { ensureRepo, commitAll } = await import("../src/git.ts");
		const { root, target, adapter, config } = stack({ id: "manyfixes" } as never);
		await ensureRepo(target, "migration/main", []);
		await commitAll(target, "init");
		for (let i = 0; i < MAX_RUN_FIXES + 3; i++) {
			const fix: SetupFixer = async (o) => (writeFileSync(join(o.projectDir, `setting-${i}.yaml`), `n: ${i}\n`), `wired setting ${i}`);
			expect(await fixRunSetup({ config, root, adapter, projectDir: target, problem: `problem ${i}`, signature: `problem ${i}`, fixer: fix })).toBe(`wired setting ${i}`);
		}
	}, 60_000);

	it("a problem the model cannot fix stops being tried; a different problem still gets its tries, and a fix is logged", async () => {
		const { fixRunSetup, MAX_FIXES_PER_PROBLEM } = await import("../src/init/setup-fixer.ts");
		const { setupLogPath } = await import("../src/adapters/command-overrides.ts");
		const { ensureRepo, commitAll } = await import("../src/git.ts");
		const { readFileSync } = await import("node:fs");
		const { root, target, adapter, config } = stack({ id: "perproblem" } as never);
		await ensureRepo(target, "migration/main", []);
		await commitAll(target, "init");
		let calls = 0;
		const nothing: SetupFixer = async () => (calls++, "looked around");
		const run = (signature: string, fixer: SetupFixer) => fixRunSetup({ config, root, adapter, projectDir: target, problem: signature, signature, fixer });
		for (let i = 0; i < MAX_FIXES_PER_PROBLEM + 2; i++) expect(await run("lint_ok: out of memory", nothing)).toBeUndefined();
		expect(calls).toBe(MAX_FIXES_PER_PROBLEM);
		const fix: SetupFixer = async (o) => (writeFileSync(join(o.projectDir, "phpstan.neon"), "memory\n"), "raised the memory limit");
		expect(await run("build_ok: class not found", fix)).toBe("raised the memory limit");
		expect(readFileSync(setupLogPath(root, "perproblem"), "utf8")).toMatch(/raised the memory limit/);
	});
});

describe("setup: the model creates the project", () => {
	const manifest = (id: string) => ({
		id, role: "server", subdir: "api", aliases: [], docs: [],
		scaffold: { cmd: "mkdir", args: ["-p", "{name}"], readyFile: "ready.txt" },
		postScaffold: [{ cmd: "touch", args: ["ready.txt"] }],
		build: { cmd: "true", args: [] }, lint: { cmd: "true", args: ["{files}"] }, test: { cmd: "test", args: ["-f", "{files}"] },
		toolchain: { ecosystem: "x", packageName: "^[a-z]+", packageExamples: [], manifestFiles: ["ready.txt"], installed: { file: "none.json", keys: [] }, add: { cmd: "true", args: ["{packages}"] }, worktreeLinks: [], ignoredPaths: [] },
		layout: { moduleDir: "src/{area}", structureDoc: "-", sharedDirs: ["src/shared/"], testFileGlobs: ["{moduleDir}/**/*.test.txt"], testFileRegex: "\\.test\\.txt$", sourceExtensions: [".txt"], langByExtension: {}, skipMarker: "skip\\(", interfaceHint: "-", testHint: "-", legacyMarker: "# LEGACY: {why}", dataAccessHint: "", ignoreDirs: [] },
		platform: {}, stackChoices: [], protectedGlobs: [], patternKinds: ["service"],
		probeTest: { path: "probe.test.txt", content: "ok\n" }, detect: { file: "ready.txt", contains: "" },
	});
	async function workspace(id: string) {
		const { generateAdapter } = await import("../src/adapters/target/generated.ts");
		const { registerGeneratedTargets } = await import("../src/adapters/registry.ts");
		const { FakeModelClient } = await import("../src/models/fake.ts");
		const root = mkdtempSync(join(tmpdir(), "br-create-"));
		await generateAdapter({ id, role: "server", why: "t", client: new FakeModelClient({ chat: () => ({ json: manifest(id) }) }), model: "m", root, deferVerify: true });
		registerGeneratedTargets(root);
		const config = ConfigSchema.parse({ source: { path: root, stack: "php" }, target: { path: join(root, "new"), stacks: [id] }, models: {} });
		return { root, config };
	}
	const quiet = async (fn: () => Promise<void>) => {
		const orig = console.log;
		console.log = () => {};
		try {
			await fn();
		} finally {
			console.log = orig;
		}
	};

	it("no hard-coded generator runs: the model is told how (the adapter's hint) and creates it; code checks", async () => {
		const { setup } = await import("../src/init/init.ts");
		const { root, config } = await workspace("create-a");
		const got: string[] = [];
		await quiet(() => setup(config, root, { creator: async (o) => {
			got.push(o.adapter.scaffoldHint ?? "");
			writeFileSync(join(o.projectDir, "ready.txt"), "made by the model\n");
		} }));
		expect(got[0]).toMatch(/^mkdir -p \{name\}, then touch ready.txt/);
	});

	it("without a model the adapter's own generator is the fallback; a project that never appears stops setup", async () => {
		const { setup } = await import("../src/init/init.ts");
		const { existsSync } = await import("node:fs");
		const a = await workspace("create-b");
		await quiet(() => setup(a.config, a.root, { creator: async () => { throw new Error("no model"); } }));
		expect(existsSync(join(a.config.target.path, "ready.txt"))).toBe(true);
		const b = await workspace("create-c");
		await expect(quiet(() => setup(b.config, b.root, { creator: async () => "did nothing" }))).rejects.toThrow(/no project was created/);
	});
});

describe("worktree dependency dirs: link or (learned) copy", () => {
	it("a linked dir resolves to the main project; a learned copy resolves inside the worktree, like an autoloader needs", async () => {
		const { linkDependencies } = await import("../src/run/run.ts");
		const { realpathSync } = await import("node:fs");
		const base = mkdtempSync(join(tmpdir(), "br-wt-"));
		const main = join(base, "main");
		mkdirSync(join(main, "vendor", "composer"), { recursive: true });
		writeFileSync(join(main, "vendor", "composer", "autoload.php"), "<?php // $baseDir = dirname(dirname(__DIR__))\n");
		const wtLink = join(base, "wt1");
		const wtCopy = join(base, "wt2");
		mkdirSync(wtLink);
		mkdirSync(wtCopy);
		await linkDependencies(main, wtLink, ["vendor"]);
		// the copy runs async (a big vendor takes seconds): nothing is copied yet when the call returns, so the Pi UI keeps going
		const copying = linkDependencies(main, wtCopy, ["vendor"], ["vendor"]);
		expect(existsSync(join(wtCopy, "vendor", "composer", "autoload.php"))).toBe(false);
		await copying;
		expect(realpathSync(join(wtLink, "vendor", "composer"))).toBe(realpathSync(join(main, "vendor", "composer")));
		expect(realpathSync(join(wtCopy, "vendor", "composer"))).toBe(join(realpathSync(wtCopy), "vendor", "composer"));
	});

	it("the setup model can switch only a linked dir to a copy; the choice is kept for the workspace", async () => {
		const { worktreeCopyTool } = await import("../src/init/setup-fixer.ts");
		const { loadCommandOverrides } = await import("../src/adapters/command-overrides.ts");
		const root = mkdtempSync(join(tmpdir(), "br-wtc-"));
		const tool = worktreeCopyTool(root, { id: "s", toolchain: { worktreeLinks: ["vendor"] } } as never) as unknown as { execute: (id: string, p: { dir: string; why: string }) => Promise<{ content: Array<{ text: string }> }> };
		expect((await tool.execute("1", { dir: "src", why: "x" })).content[0]!.text).toMatch(/refused/);
		await tool.execute("2", { dir: "vendor", why: "the autoloader resolves the link to the main project" });
		expect(loadCommandOverrides(root, "s").worktreeCopy).toEqual(["vendor"]);
	});

	it("copying a dir that is a copy already changes nothing: no fix, and the problem no longer calls it linked", async () => {
		const { fixRunSetup, worktreeCopyTool } = await import("../src/init/setup-fixer.ts");
		const { linkedDirs, loadCommandOverrides } = await import("../src/adapters/command-overrides.ts");
		const { ensureRepo, commitAll } = await import("../src/git.ts");
		const { root, target, adapter, config } = stack({ id: "copied", toolchain: { isProjectReady: () => true, worktreeLinks: ["vendor", "node_modules"] } } as never);
		await ensureRepo(target, "migration/main", []);
		await commitAll(target, "init");
		type Tool = { execute: (id: string, p: { dir: string; why: string }) => Promise<{ content: Array<{ text: string }> }> };
		await (worktreeCopyTool(root, adapter) as unknown as Tool).execute("1", { dir: "vendor", why: "autoloader" });
		expect(linkedDirs(adapter, root)).toEqual(["node_modules"]);
		const fixer: SetupFixer = async (o) => {
			const said = await (worktreeCopyTool(o.root, o.adapter) as unknown as Tool).execute("2", { dir: "vendor", why: "autoloader again" });
			expect(said.content[0]!.text).toMatch(/already/);
			return "vendor is copied now";
		};
		expect(await fixRunSetup({ config, root, adapter, projectDir: target, problem: "class not found", fixer })).toBeUndefined();
		expect(loadCommandOverrides(root, "copied").why).not.toMatch(/again/);
	});
});

describe("setup fixes during the run: the test command must still be able to fail", () => {
	it("a fix after which a failing probe test passes is put back whole: files and command override", async () => {
		const { fixRunSetup } = await import("../src/init/setup-fixer.ts");
		const { ensureRepo, commitAll } = await import("../src/git.ts");
		const { overridesPath } = await import("../src/adapters/command-overrides.ts");
		const { existsSync } = await import("node:fs");
		const { execFileSync } = await import("node:child_process");
		const { root, target, adapter, config } = stack({ id: "nofail" } as never);
		await ensureRepo(target, "migration/main", []);
		await commitAll(target, "init");
		const fixer: SetupFixer = async (o) => {
			writeFileSync(join(o.projectDir, "runner.sh"), "exit 0\n");
			saveCommandOverride(o.root, o.adapter.id, "test", { cmd: "sh", args: ["runner.sh"] }, "a wrapper that swallows the exit code");
			return "wrapped the runner";
		};
		expect(await fixRunSetup({ config, root, adapter, projectDir: target, problem: "runner flaky", fixer })).toBeUndefined();
		expect(existsSync(join(target, "runner.sh"))).toBe(false);
		expect(existsSync(overridesPath(root, "nofail"))).toBe(false);
		expect(execFileSync("git", ["-C", target, "log", "-1", "--format=%s"], { encoding: "utf8" })).toMatch(/init/);
	});
});

describe("the gate commands file belongs to the setup fixer", () => {
	it("a session's own change to it is put back; the fixer's change made meanwhile stays", async () => {
		const { keepOverrides, overridesPath, loadCommandOverrides } = await import("../src/adapters/command-overrides.ts");
		const { existsSync } = await import("node:fs");
		const { root } = stack();
		// a tester rewrites it through bash: put back (the file did not exist, so it is gone again)
		let kept = keepOverrides(root, "s1");
		mkdirSync(join(root, ".bigrefactor", "commands"), { recursive: true });
		writeFileSync(overridesPath(root, "s1"), JSON.stringify({ lint: { cmd: "true", args: [] } }));
		expect(kept.restore()).toBe(true);
		expect(existsSync(overridesPath(root, "s1"))).toBe(false);
		// the setup fixer's tool writes it while the session runs: kept
		kept = keepOverrides(root, "s1");
		saveCommandOverride(root, "s1", "test", grep, "flag gone");
		expect(kept.restore()).toBe(false);
		expect(loadCommandOverrides(root, "s1").test).toEqual(grep);
	});
});

describe("setup fixes during the run: one stack's fix stays in its own project", () => {
	it("another stack's project is put back, not committed; the probe test copy is removed, also one committed earlier", async () => {
		const { fixRunSetup } = await import("../src/init/setup-fixer.ts");
		const { ensureRepo, commitAll } = await import("../src/git.ts");
		const { execFileSync } = await import("node:child_process");
		const { existsSync } = await import("node:fs");
		const probe = { path: "src/probe.spec.txt", content: "expect(1 + 1).toBe(2)\n" };
		const { root, target, adapter } = stack({ id: "web", probeTest: () => probe } as never);
		const config = ConfigSchema.parse({ source: { path: root, stack: "php" }, target: { path: target, stacks: ["web", "api"] }, models: {} });
		await ensureRepo(target, "migration/main", []);
		await commitAll(target, "scaffold");
		for (const [f, t] of Object.entries({ "web/src/probe.spec.txt": probe.content, "api/config.yaml": "a: 1\n" })) (mkdirSync(join(target, f, ".."), { recursive: true }), writeFileSync(join(target, f), t));
		await commitAll(target, "leaked probe");
		const fixer: SetupFixer = async (o) => {
			writeFileSync(join(o.projectDir, "vitest.config.ts"), "export default {};\n");
			writeFileSync(join(target, "api", "config.yaml"), "a: 2\n");
			writeFileSync(join(target, "api", "app.en.yaml"), "x: y\n");
			return "added the vitest config";
		};
		expect(await fixRunSetup({ config, root, adapter, projectDir: join(target, "web"), problem: "vitest: no config", fixer })).toBe("added the vitest config");
		expect(execFileSync("git", ["-C", target, "show", "--name-status", "--format=", "HEAD"], { encoding: "utf8" }).trim().split("\n").sort()).toEqual(["A\tweb/vitest.config.ts", "D\tweb/src/probe.spec.txt"]);
		expect(execFileSync("git", ["-C", target, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
		expect(existsSync(join(target, "api", "app.en.yaml"))).toBe(false);
	});
	it("under the merge lock, another stack's folder is put back even while that stack's fix waits for the lock", async () => {
		const { fixRunSetup } = await import("../src/init/setup-fixer.ts");
		const { ensureRepo, commitAll } = await import("../src/git.ts");
		const { execFileSync } = await import("node:child_process");
		const { root, target, adapter: web } = stack({ id: "web2" } as never);
		const api = { ...web, id: "api2" } as TargetAdapter;
		const config = ConfigSchema.parse({ source: { path: root, stack: "php" }, target: { path: target, stacks: ["web2", "api2"] }, models: {} });
		for (const d of ["web2", "api2"]) (mkdirSync(join(target, d), { recursive: true }), writeFileSync(join(target, d, "keep"), ""));
		await ensureRepo(target, "migration/main", []);
		await commitAll(target, "scaffold");
		// one session at a time, like the run's merge lock
		let chain: Promise<unknown> = Promise.resolve();
		const lock = <T>(fn: () => Promise<T>) => {
			const r = chain.then(fn);
			chain = r.catch(() => undefined);
			return r;
		};
		const webFixer: SetupFixer = async (o) => {
			writeFileSync(join(o.projectDir, "vitest.config.ts"), "export default {};\n");
			writeFileSync(join(target, "api2", "stray.yaml"), "x: y\n");
			return "added the vitest config";
		};
		let apiSawStatus: string | undefined;
		const apiFixer: SetupFixer = async (o) => {
			apiSawStatus = execFileSync("git", ["-C", target, "status", "--porcelain"], { encoding: "utf8" });
			writeFileSync(join(o.projectDir, "vitest.config.ts"), "export default {};\n");
			return "added the api vitest config";
		};
		const first = fixRunSetup({ config, root, adapter: web, projectDir: join(target, "web2"), problem: "vitest: no config", fixer: webFixer, lock });
		const second = fixRunSetup({ config, root, adapter: api, projectDir: join(target, "api2"), problem: "vitest: no config", fixer: apiFixer, lock });
		expect(await first).toBe("added the vitest config");
		expect(await second).toBe("added the api vitest config");
		// the web fix's edit in api2/ was put back, not left on main for the api fix to start on and commit as its own
		expect(apiSawStatus).toBe("");
		expect(execFileSync("git", ["-C", target, "log", "--name-only", "--format=", "-2"], { encoding: "utf8" }).split("\n").filter(Boolean).sort()).toEqual(["api2/vitest.config.ts", "web2/vitest.config.ts"]);
		expect(execFileSync("git", ["-C", target, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
	});
});

describe("setup fixes during the run: main stays mergeable and startable", () => {
	it("the merge lock is held while the model edits main, not only for the commit", async () => {
		const { fixRunSetup } = await import("../src/init/setup-fixer.ts");
		const { ensureRepo, commitAll } = await import("../src/git.ts");
		const { root, target, adapter, config } = stack({ id: "lockall" } as never);
		await ensureRepo(target, "migration/main", []);
		await commitAll(target, "init");
		let held = false;
		let lockCalls = 0;
		const lock = async <T>(fn: () => Promise<T>) => {
			lockCalls++;
			held = true;
			try {
				return await fn();
			} finally {
				held = false;
			}
		};
		const editedUnderLock: boolean[] = [];
		const fixer: SetupFixer = async (o) => {
			editedUnderLock.push(held);
			writeFileSync(join(o.projectDir, "vitest.config.ts"), "export default {};\n");
			return "added the vitest config";
		};
		expect(await fixRunSetup({ config, root, adapter, projectDir: target, problem: "vitest: no config", fixer, lock })).toBe("added the vitest config");
		expect(editedUnderLock).toEqual([true]);
		expect(lockCalls).toBe(1);
	});

	it("a fix after which the app's start-up check fails (it passed before) is put back whole", async () => {
		const { fixRunSetup } = await import("../src/init/setup-fixer.ts");
		const { ensureRepo, commitAll } = await import("../src/git.ts");
		const { Ledger } = await import("../src/ledger/db.ts");
		const { execFileSync } = await import("node:child_process");
		// the start-up check: fails when the wiring names a class that is not there
		const boot = () => ({ cmd: "sh", args: ["-c", "if grep -q Missing services.yaml; then echo 'class Missing does not exist' >&2; exit 1; fi"] });
		const { root, target, adapter, config } = stack({ id: "bootguard", boot } as never);
		writeFileSync(join(target, "services.yaml"), "services: {}\n");
		await ensureRepo(target, "migration/main", []);
		await commitAll(target, "init");
		const ledger = new Ledger(":memory:");
		const fixer: SetupFixer = async (o) => {
			writeFileSync(join(o.projectDir, "services.yaml"), "services: { Missing: ~ }\n");
			return "wired Missing (boot still fails: the class is missing from this checkout)";
		};
		expect(await fixRunSetup({ config, root, adapter, projectDir: target, problem: "wire Missing", fixer, ledger })).toBeUndefined();
		expect(execFileSync("git", ["-C", target, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim()).toBe("init");
		expect(execFileSync("git", ["-C", target, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
		const row = ledger.db.prepare("SELECT outcome, gate_report FROM attempts").get() as { outcome: string; gate_report: string };
		expect(row.outcome).toBe("boot_broken");
		expect(row.gate_report).toMatch(/class Missing does not exist/);
	});

	it("a start-up check that already failed before the fix does not hold the fix back", async () => {
		const { fixRunSetup } = await import("../src/init/setup-fixer.ts");
		const { ensureRepo, commitAll } = await import("../src/git.ts");
		const boot = () => ({ cmd: "sh", args: ["-c", "exit 1"] });
		const { root, target, adapter, config } = stack({ id: "bootred", boot } as never);
		await ensureRepo(target, "migration/main", []);
		await commitAll(target, "init");
		const fixer: SetupFixer = async (o) => {
			writeFileSync(join(o.projectDir, "vitest.config.ts"), "export default {};\n");
			return "added the vitest config";
		};
		expect(await fixRunSetup({ config, root, adapter, projectDir: target, problem: "vitest: no config", fixer })).toBe("added the vitest config");
	});
});
