import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
		probeTest: () => ({ path: "src/probe.spec.txt", content: "expect(1 + 1).toBe(2)\n" }),
		build: () => ({ cmd: "true", args: [] }),
		lint: () => ({ cmd: "true", args: [] }),
		// the "old flag": always fails, like vitest 5 on --related
		test: () => ({ cmd: "sh", args: ["-c", "echo 'Unknown option --related' >&2; exit 1"] }),
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
		ensureRepo(target, "migration/main", []);
		commitAll(target, "init");
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
		linkDependencies(main, wtLink, ["vendor"]);
		linkDependencies(main, wtCopy, ["vendor"], ["vendor"]);
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
});
