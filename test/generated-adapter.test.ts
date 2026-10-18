import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getTargetAdapter, knownTargets, registerGeneratedTargets, TARGET_ROLES, TARGET_SUBDIRS } from "../src/adapters/registry.ts";
import { fromManifest, generateAdapter, validateManifest, type AdapterManifest } from "../src/adapters/target/generated.ts";
import { FakeModelClient } from "../src/models/fake.ts";
import { placementDir } from "../src/run/placement.ts";

const here = resolve(import.meta.dirname, "..");

const manifest = (over: Partial<AdapterManifest> = {}): AdapterManifest => ({
	id: "vuex-test",
	role: "ui",
	subdir: "web",
	aliases: [],
	docs: [{ name: "Vue", url: "https://vuejs.org/guide/" }],
	scaffold: { cmd: "npm", args: ["create", "vite@latest", "{name}", "--", "--template", "vue-ts"], readyFile: "package.json" },
	postScaffold: [{ cmd: "npm", args: ["install"] }],
	build: { cmd: "npx", args: ["vue-tsc", "--noEmit"] },
	lint: { cmd: "npx", args: ["eslint", "{files}"] },
	test: { cmd: "npx", args: ["vitest", "run", "{files}"] },
	toolchain: { ecosystem: "npm", packageName: "^(?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*", packageExamples: ["pinia"], manifestFiles: ["package.json"], installed: { file: "package.json", keys: ["dependencies", "devDependencies"] }, add: { cmd: "npm", args: ["install", "{packages}"] }, worktreeLinks: ["node_modules"], ignoredPaths: ["node_modules", "dist"] },
	layout: { moduleDir: "src/features/{area}", structureDoc: "one folder per feature", sharedDirs: ["src/shared/"], testFileGlobs: ["{moduleDir}/**/*.test.ts"], testFileRegex: "\\.test\\.ts$", sourceExtensions: [".vue", ".ts"], langByExtension: { ".vue": "vue", ".ts": "typescript" }, skipMarker: "\\.(skip|only)\\(", interfaceHint: "props + emits", testHint: "*.test.ts next to the component", legacyMarker: "// LEGACY: {why}", dataAccessHint: "", ignoreDirs: ["node_modules", "dist"] },
	platform: { rendering: "Vue SFCs" },
	stackChoices: [],
	protectedGlobs: ["**/*.test.ts", "package.json"],
	patternKinds: ["component", "composable", "test"],
	probeTest: { path: "src/probe.test.ts", content: "import { test, expect } from 'vitest'; test('p', () => expect(1).toBe(1));" },
	detect: { file: "package.json", contains: "\"vue\"" },
	...over,
});

describe("generated target adapters", () => {
	it("tests may live outside the area module (tests/{Area}/…), so the app does not load them as its own code", () => {
		const base = manifest();
		const a = fromManifest(manifest({ layout: { ...base.layout, moduleDir: "src/{Area}", testFileGlobs: ["tests/{Area}/**/*Test.php", "tests/{area_snake}/*.php"] } }));
		expect(a.layout.testFileGlobs(a.layout.moduleDir("ad-serving"))).toEqual(["tests/AdServing/**/*Test.php", "tests/ad_serving/*.php"]);
	});

	it("a shared area folder is spelled like the stack's area folders, and its test globs name the area too", () => {
		const base = manifest();
		const a = fromManifest(manifest({ layout: { ...base.layout, moduleDir: "src/{Area}", sharedDirs: ["src/Shared/"], testFileGlobs: ["{moduleDir}/tests/**/*Test.php", "tests/{Area}/**/*Test.php"] } }));
		const dir = placementDir(a.layout, { stackId: "x", area: "file-storage", moduleKey: "x:file-storage", shared: true, source: "model" });
		expect(dir).toBe("src/Shared/FileStorage");
		expect(a.layout.testFileGlobs(dir)).toEqual(["src/Shared/FileStorage/tests/**/*Test.php", "tests/FileStorage/**/*Test.php"]);
	});

	it("a manifest becomes a full adapter: placeholders expand, regexes compile, nothing runs through a shell", () => {
		const a = fromManifest(manifest());
		expect(a.layout.moduleDir("user-admin")).toBe("src/features/user-admin");
		expect(a.lint("/p", ["a.ts", "b.ts"])).toEqual({ cmd: "npx", args: ["eslint", "a.ts", "b.ts"] });
		expect(a.test("/p", [])).toEqual({ cmd: "npx", args: ["vitest", "run"] });
		expect(a.toolchain.addPackages("/p", ["pinia"])).toEqual({ cmd: "npm", args: ["install", "pinia"] });
		expect(a.layout.isTestFile("src/x.test.ts")).toBe(true);
		expect(a.layout.legacyMarker("why")).toBe("// LEGACY: why");
		expect(validateManifest(manifest())).toEqual([]);
		expect(validateManifest(manifest({ build: { cmd: "bash", args: ["-c", "rm -rf /"] } })).join("\n")).toMatch(/shell/);
		expect(validateManifest(manifest({ test: { cmd: "npx vitest run", args: [] } })).join("\n")).toMatch(/single executable/);
		expect(validateManifest(manifest({ lint: { cmd: "npx", args: ["eslint", "a.ts; curl x | sh"] } })).join("\n")).toMatch(/shell syntax/);
	});

	it("generation: invalid or failing manifests go back to the model; the verified one is saved and registered", async () => {
		const ws = join(here, ".sim", "gen-adapter");
		rmSync(ws, { recursive: true, force: true });
		mkdirSync(ws, { recursive: true });
		let n = 0;
		const client = new FakeModelClient({ chat: () => ({ json: ++n === 1 ? manifest({ build: { cmd: "sh", args: ["-c", "x"] } }) : manifest() }) });
		const tried: string[] = [];
		const asked: string[][] = [];
		const m = await generateAdapter({ id: "vuex-test", role: "ui", why: "Vue islands", client, model: "m", root: ws, confirm: async (c) => (asked.push(c), true), verify: async (x) => (tried.push(x.build.cmd), tried.length === 1 ? "test failed on the fresh project" : undefined) });
		expect(n).toBe(3); // invalid → re-asked; verification failure → re-asked; then verified
		expect(asked[0]!.join("\n")).toMatch(/scaffold: npm create vite@latest/);
		expect(m.id).toBe("vuex-test");
		expect(existsSync(join(ws, ".bigrefactor", "adapters", "vuex-test.json"))).toBe(true);
		const repair = client.calls.at(-1)!.req as { messages: Array<{ content: string }> };
		expect(repair.messages.at(-1)!.content).toMatch(/test failed on the fresh project/);
		expect(registerGeneratedTargets(ws)).toEqual(["vuex-test"]);
		expect(knownTargets()).toContain("vuex-test");
		expect(TARGET_ROLES["vuex-test"]).toBe("ui");
		expect(TARGET_SUBDIRS["vuex-test"]).toBe("web");
		expect((await getTargetAdapter("vuex-test")).layout.moduleDir("billing")).toBe("src/features/billing");
		// a tool missing on this machine stops at once (no repair round, nothing runs)
		const { missingTools } = await import("../src/adapters/target/generated.ts");
		expect(missingTools(manifest({ scaffold: { cmd: "no-such-tool-xyz", args: [], readyFile: "x" } }))).toEqual(["no-such-tool-xyz"]);
		const c2 = new FakeModelClient({ chat: () => ({ json: manifest({ id: "x2", scaffold: { cmd: "no-such-tool-xyz", args: [], readyFile: "x" } }) }) });
		await expect(generateAdapter({ id: "x2", role: "server", why: "", client: c2, model: "m", root: ws, verify: async () => undefined })).rejects.toThrow(/needs no-such-tool-xyz on this machine/);
		expect(c2.calls.length).toBe(1);
		// a hand-edited manifest that turns invalid is never loaded
		writeFileSync(join(ws, ".bigrefactor", "adapters", "evil.json"), JSON.stringify(manifest({ id: "evil", build: { cmd: "sudo", args: ["x"] } })));
		expect(registerGeneratedTargets(ws)).not.toContain("evil");
		expect(JSON.parse(readFileSync(join(ws, ".bigrefactor", "adapters", "vuex-test.json"), "utf8")).role).toBe("ui");
	});
});

describe("generated target adapters on non-TypeScript stacks", () => {
	const go = (over: Partial<AdapterManifest["layout"]> = {}) => {
		const base = manifest();
		return manifest({
			id: "go-test",
			toolchain: { ...base.toolchain, packageName: "^[\\w./-]+", installed: { file: "", keys: [], list: { cmd: process.execPath, args: ["-e", "console.log('example.com/app'); console.log('github.com/go-chi/chi/v5 v5.0.12')"] }, listPattern: "^(\\S+) v\\d" } },
			layout: { ...base.layout, moduleDir: "internal/{area}", sharedDirs: ["internal/shared/"], dataDirs: ["db/migrations", "internal/store/"], wiringFiles: ["cmd/server/routes.go"], ...over },
		});
	};

	it("installed packages come from the stack's list command when it has no JSON manifest", async () => {
		expect(await fromManifest(go()).toolchain.installedPackages(here)).toEqual(["github.com/go-chi/chi/v5"]);
		// the JSON manifest still works where it applies
		expect(await fromManifest(manifest()).toolchain.installedPackages(here)).toContain("vitest");
		const ok = go();
		ok.toolchain.installed.list = { cmd: "go", args: ["list", "-m", "all"] };
		expect(validateManifest(ok)).toEqual([]);
		const bad = go();
		bad.toolchain.installed.list = { cmd: "sh", args: ["-c", "pip list"] };
		expect(validateManifest(bad).join("\n")).toMatch(/installed\.list.*shell/);
	});

	it("the manifest names the data folders and the wiring files; the adapter passes them on", () => {
		const a = fromManifest(go());
		expect(a.layout.dataDirs).toEqual(["db/migrations/", "internal/store/"]);
		expect(a.layout.wiringFiles).toEqual(["cmd/server/routes.go"]);
		expect(fromManifest(manifest()).layout.dataDirs).toBeUndefined(); // older manifests: the DB lane's defaults
		expect(validateManifest(go({ dataDirs: ["../db/"] })).join("\n")).toMatch(/dataDirs.*project-relative/);
	});

	it("the implementer is told where to register its unit, not that wiring is generated", async () => {
		const { implementerSystemPrompt } = await import("../src/run/prompts.ts");
		const { ConfigSchema } = await import("../src/config.ts");
		const config = ConfigSchema.parse({ source: { path: "/x", stack: "php" }, target: { path: "/y", stacks: ["go-test"] }, models: {} });
		const opts = { area: "billing", stackId: "go-test", moduleDir: "internal/billing", structureDoc: "-", sharedDirs: [], rules: "", attempt: 1, source: { id: "php" } as never };
		const p = implementerSystemPrompt(config, { ...opts, target: fromManifest(go()) });
		expect(p).toContain("in cmd/server/routes.go");
		expect(p).not.toMatch(/wiring files are generated/);
		expect(implementerSystemPrompt(config, { ...opts, target: { ...fromManifest(go()), generateRegistration: async () => [] } })).toMatch(/wiring files are generated/);
	});

	it("without a symbol index the lookups say so and send the model to grep/ls instead of claiming nothing exists", async () => {
		const { Ledger } = await import("../src/ledger/db.ts");
		const { ConfigSchema } = await import("../src/config.ts");
		const { patternExamples, sharedLookup, targetLookup } = await import("../src/sessions/tools.ts");
		const ledger = new Ledger(":memory:");
		const config = ConfigSchema.parse({ source: { path: "/x", stack: "php" }, target: { path: "/y", stacks: ["go-test"] }, models: {} });
		const d = { ledger, config, unitId: "u1", root: "/nowhere", targetProjectDir: "/y", adapter: fromManifest(go()), moduleDir: "internal/billing" };
		const run = async (t: ReturnType<typeof targetLookup>, p: object) => JSON.stringify(await (t as unknown as { execute: (i: string, p: object) => Promise<unknown> }).execute("x", p));
		for (const out of [await run(targetLookup(d), { query: "Invoice" }), await run(targetLookup(d), { query: "*" }), await run(sharedLookup(d), {}), await run(patternExamples(d), { kind: "component" })]) {
			expect(out).toMatch(/no symbol index/);
			expect(out).not.toMatch(/you are creating it|is empty/);
		}
	});
});

describe("stack knowledge is checked when the adapter is written", () => {
	const php = (layout: Partial<AdapterManifest["layout"]> = {}) => {
		const base = manifest();
		return manifest({ id: "sym-test", role: "server", layout: { ...base.layout, moduleDir: "src/{Area}", testFileGlobs: ["tests/{Area}/**/*Test.php"], testFileRegex: "Test\\.php$", sourceExtensions: [".php"], rules: { source: "docs", moduleDir: "src/{Area}", files: [{ path: "{Area}Bundle.php", doc: "the area's bundle" }, { path: "{Name}.php", doc: "a class" }], require: ["{Area}Bundle.php"], forbidDirs: [], place: [], maxLines: 400 }, ...layout } });
	};

	it("a required file nothing registers goes back to the model until it names the wiring file", async () => {
		const ws = join(here, ".sim", "gen-adapter-wiring");
		rmSync(ws, { recursive: true, force: true });
		mkdirSync(ws, { recursive: true });
		const answers = [php(), php({ wiringFiles: ["config/bundles.php"] })];
		const client = new FakeModelClient({ chat: () => ({ json: answers.shift() }) });
		const m = await generateAdapter({ id: "sym-test", role: "server", why: "", client, model: "m", root: ws, verify: async () => undefined });
		expect(client.calls.length).toBe(2);
		const repair = client.calls.at(-1)!.req as { messages: Array<{ content: string }> };
		expect(repair.messages.at(-1)!.content).toMatch(/require makes every feature folder hold \{Area\}Bundle\.php, but layout\.wiringFiles is empty/);
		expect(m.layout.wiringFiles).toEqual(["config/bundles.php"]);
		// the model is asked for a skip marker that also catches the runner's own skip and incomplete calls
		expect(repair.messages[0]!.content).toMatch(/layout\.skipMarker: .*skip, only and incomplete call/);
		// a saved older manifest still loads: the check runs only when one is written
		expect(validateManifest(php())).toEqual([]);
	});

	it("an area with two test homes is rejected; several globs under one home are fine", async () => {
		const { stackProblems } = await import("../src/adapters/target/generated.ts");
		expect(stackProblems(php({ testFileGlobs: ["{moduleDir}/tests/**/*Test.php", "tests/{Area}/**/*Test.php"], wiringFiles: ["config/bundles.php"] })).join("\n")).toMatch(/2 test homes \(src\/Probe\/tests, tests\/Probe\): pick ONE/);
		expect(stackProblems(php({ wiringFiles: ["config/bundles.php"] }))).toEqual([]);
		expect(stackProblems(manifest({ layout: { ...manifest().layout, testFileGlobs: ["{moduleDir}/**/*.test.ts", "{moduleDir}/*.spec.ts"] } }))).toEqual([]);
	});

	it("run start: a saved manifest without wiringFiles gets that one question; nothing to register drops the require", async () => {
		const { healWiringFiles, loadManifests } = await import("../src/adapters/target/generated.ts");
		const ws = join(here, ".sim", "heal-wiring");
		rmSync(ws, { recursive: true, force: true });
		mkdirSync(join(ws, ".bigrefactor", "adapters"), { recursive: true });
		const save = (m: AdapterManifest) => writeFileSync(join(ws, ".bigrefactor", "adapters", `${m.id}.json`), JSON.stringify(m));
		save(php());
		save(manifest({ layout: { ...manifest().layout, wiringFiles: [] } })); // answered before: not asked again
		const client = new FakeModelClient({ chat: () => ({ json: { wiringFiles: ["config/bundles.php"] } }) });
		expect(await healWiringFiles(ws, { client, model: "m" })).toEqual(["sym-test"]);
		expect(client.calls.length).toBe(1);
		expect(JSON.stringify((client.calls[0]!.req as { messages: unknown[] }).messages)).toContain("{Area}Bundle.php");
		const healed = loadManifests(ws).find((m) => m.id === "sym-test")!;
		expect(healed.layout.wiringFiles).toEqual(["config/bundles.php"]);
		expect(healed.layout.rules!.require).toEqual(["{Area}Bundle.php"]);
		expect(healed.scaffold).toEqual(php().scaffold); // the rest stays
		expect(await healWiringFiles(ws, { client, model: "m" })).toEqual([]); // asked once

		// the model says nothing is registered by hand: the required file is dropped (manifest and the workspace's layout.json)
		save(php());
		const { saveLayoutRules, loadLayoutRules } = await import("../src/rules/layout-rules.ts");
		saveLayoutRules(ws, "sym-test", php().layout.rules!);
		const none = new FakeModelClient({ chat: () => ({ json: { wiringFiles: [] } }) });
		await healWiringFiles(ws, { client: none, model: "m" });
		expect(loadManifests(ws).find((m) => m.id === "sym-test")!.layout.rules!.require).toEqual([]);
		expect(loadLayoutRules(ws, "sym-test")!.require).toEqual([]);
	});

	it("run start: a wiring file the project no longer has (a setup fix moved it) is asked again, with the files tracked near it", async () => {
		const { execFileSync } = await import("node:child_process");
		const { healWiringFiles, loadManifests } = await import("../src/adapters/target/generated.ts");
		const ws = join(here, ".sim", "heal-wiring-gone");
		const proj = join(ws, "project");
		rmSync(ws, { recursive: true, force: true });
		mkdirSync(join(ws, ".bigrefactor", "adapters"), { recursive: true });
		mkdirSync(join(proj, "config", "bundles"), { recursive: true });
		writeFileSync(join(proj, "config", "bundles.php"), "<?php return [];\n");
		writeFileSync(join(proj, "config", "routes.yaml"), "\n");
		const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: proj });
		git("init", "-q");
		git("add", "-A");
		git("commit", "-qm", "init");
		// a setup fix moved the registration file
		git("mv", "config/bundles.php", "config/bundles/registry.php");
		git("commit", "-qm", "move");
		const save = (wiringFiles: string[]) => writeFileSync(join(ws, ".bigrefactor", "adapters", "sym-test.json"), JSON.stringify(php({ wiringFiles })));
		const { saveLayoutRules, loadLayoutRules } = await import("../src/rules/layout-rules.ts");
		saveLayoutRules(ws, "sym-test", php().layout.rules!);
		// a moved file the model names nothing for: the working list and the require stay
		save(["config/bundles.php", "config/routes.yaml"]);
		const empty = new FakeModelClient({ chat: () => ({ json: {} }) });
		expect(await healWiringFiles(ws, { client: empty, model: "m", dirOf: () => proj })).toEqual([]);
		expect(empty.calls.length).toBe(1);
		expect(loadManifests(ws).find((m) => m.id === "sym-test")!.layout.wiringFiles).toEqual(["config/bundles.php", "config/routes.yaml"]);
		expect(loadLayoutRules(ws, "sym-test")!.require).toEqual(php().layout.rules!.require);
		// a file git never had (a unit creates it later) is not stale: no question
		save(["config/bundles/registry.php", "config/routes.yaml", "config/services.php"]);
		const never = new FakeModelClient({ chat: () => ({ json: { wiringFiles: [] } }) });
		expect(await healWiringFiles(ws, { client: never, model: "m", dirOf: () => proj })).toEqual([]);
		expect(never.calls.length).toBe(0);

		save(["config/bundles.php", "config/routes.yaml", "config/{Area}/*.yaml"]);
		const client = new FakeModelClient({ chat: () => ({ json: { wiringFiles: ["config/bundles/registry.php", "config/routes.yaml"] } }) });
		expect(await healWiringFiles(ws, { client, model: "m", dirOf: () => proj })).toEqual(["sym-test"]);
		expect(client.calls.length).toBe(1);
		const asked = JSON.stringify((client.calls[0]!.req as { messages: unknown[] }).messages);
		expect(asked).toContain("no longer has: config/bundles.php"); // the glob is not looked for
		expect(asked).toContain("config/bundles/registry.php");
		expect(loadManifests(ws).find((m) => m.id === "sym-test")!.layout.wiringFiles).toEqual(["config/bundles/registry.php", "config/routes.yaml"]);
		// all present now: not asked again
		expect(await healWiringFiles(ws, { client, model: "m", dirOf: () => proj })).toEqual([]);
		expect(client.calls.length).toBe(1);
	});

	it("run start: a saved manifest without boot gets that one question; the command is tried on main's project, a failure goes back once", async () => {
		const { execFileSync } = await import("node:child_process");
		const { healBoot, loadManifests } = await import("../src/adapters/target/generated.ts");
		const ws = join(here, ".sim", "heal-boot");
		const proj = join(ws, "project");
		rmSync(ws, { recursive: true, force: true });
		mkdirSync(join(ws, ".bigrefactor", "adapters"), { recursive: true });
		mkdirSync(join(proj, "bin"), { recursive: true });
		writeFileSync(join(proj, "bin", "console"), "#!/bin/sh\n[ \"$1\" = \"lint:container\" ] || { echo \"Command $1 is not defined.\"; exit 1; }\necho ok\n");
		chmodSync(join(proj, "bin", "console"), 0o755);
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "init", "-q"], { cwd: proj });
		execFileSync("git", ["add", "-A"], { cwd: proj });
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: proj });
		const save = (over: Partial<AdapterManifest> = {}) => writeFileSync(join(ws, ".bigrefactor", "adapters", "sym-test.json"), JSON.stringify({ ...php(), ...over }));
		save();
		// first a wrong command, then the right one after its output
		const answers = [{ boot: { cmd: "bin/console", args: ["about:nothing"] } }, { boot: { cmd: "bin/console", args: ["lint:container"] } }];
		const client = new FakeModelClient({ chat: () => ({ json: answers.shift() }) });
		expect(await healBoot(ws, { client, model: "m", dirOf: () => proj })).toEqual(["sym-test"]);
		expect(client.calls.length).toBe(2);
		expect(JSON.stringify((client.calls[0]!.req as { messages: unknown[] }).messages)).toContain("bin/console");
		expect(JSON.stringify((client.calls[1]!.req as { messages: unknown[] }).messages)).toContain("Command about:nothing is not defined.");
		expect(loadManifests(ws)[0]!.boot).toEqual({ cmd: "bin/console", args: ["lint:container"] });
		expect(await healBoot(ws, { client, model: "m", dirOf: () => proj })).toEqual([]); // asked once
		expect(client.calls.length).toBe(2);
		// the same command again after it failed: the app itself does not start, the command is kept
		save();
		const broken = new FakeModelClient({ chat: () => ({ json: { boot: { cmd: "bin/console", args: ["cache:clear"] } } }) });
		await healBoot(ws, { client: broken, model: "m", dirOf: () => proj });
		expect(broken.calls.length).toBe(2);
		expect(loadManifests(ws)[0]!.boot).toEqual({ cmd: "bin/console", args: ["cache:clear"] });
		// the workspace already has its own boot command (the setup fixer's): not asked
		save();
		const own = new FakeModelClient({ chat: () => ({ json: {} }) });
		expect(await healBoot(ws, { client: own, model: "m", dirOf: () => proj, hasOwn: () => true })).toEqual([]);
		expect(own.calls.length).toBe(0);
	});

	it("run start: a saved manifest without checkConfigGlobs gets that one question; code jobs may then change the other protected files", async () => {
		const { healCheckConfig, loadManifests } = await import("../src/adapters/target/generated.ts");
		const { lockedForCodeJobs } = await import("../src/run/code-job.ts");
		const ws = join(here, ".sim", "heal-check-config");
		rmSync(ws, { recursive: true, force: true });
		mkdirSync(join(ws, ".bigrefactor", "adapters"), { recursive: true });
		const m = php();
		const old = { ...m, protectedGlobs: ["config/**", "src/Kernel.php", "phpunit.xml.dist"] };
		writeFileSync(join(ws, ".bigrefactor", "adapters", `${m.id}.json`), JSON.stringify(old));
		// before the answer: every protected file is locked for code jobs
		expect(lockedForCodeJobs(fromManifest(old), "config/packages/security.yaml")).toBe(true);
		const client = new FakeModelClient({ chat: () => ({ json: { checkConfigGlobs: ["phpunit.xml.dist", "phpstan.neon", "composer.json", "/etc/passwd", "../x"] } }) });
		expect(await healCheckConfig(ws, { client, model: "m" })).toEqual([m.id]);
		const healed = loadManifests(ws).find((x) => x.id === m.id)!;
		expect(healed.checkConfigGlobs).toEqual(["phpunit.xml.dist", "phpstan.neon", "composer.json"]); // nothing outside the project
		const a = fromManifest(healed);
		expect(lockedForCodeJobs(a, "config/packages/security.yaml")).toBe(false);
		expect(lockedForCodeJobs(a, "src/Kernel.php")).toBe(false);
		expect(lockedForCodeJobs(a, "phpunit.xml.dist")).toBe(true);
		expect(await healCheckConfig(ws, { client, model: "m" })).toEqual([]); // asked once
		expect(client.calls.length).toBe(1);
	});

	it("a skip marker must match every skip sample the model gives; an older manifest gets that one question at run start", async () => {
		const { healSkipMarker, loadManifests } = await import("../src/adapters/target/generated.ts");
		expect(validateManifest(php({ skipMarker: "@migration-skip", skipSamples: ["$this->markTestIncomplete('x');"] })).join("\n")).toMatch(/does not match these skip samples: \$this->markTestIncomplete/);
		expect(validateManifest(php({ skipMarker: "markTest(Skipped|Incomplete)\\(", skipSamples: ["$this->markTestIncomplete('x');", "self::markTestSkipped('y');"] }))).toEqual([]);
		const ws = join(here, ".sim", "heal-skip-marker");
		rmSync(ws, { recursive: true, force: true });
		mkdirSync(join(ws, ".bigrefactor", "adapters"), { recursive: true });
		writeFileSync(join(ws, ".bigrefactor", "adapters", "sym-test.json"), JSON.stringify(php({ skipMarker: "@migration-skip" })));
		// first a marker that misses a sample, then one that matches all of them
		const answers = [
			{ skipMarker: "markTestSkipped", skipSamples: ["self::markTestSkipped('a');", "self::markTestIncomplete('b');"] },
			{ skipMarker: "markTest(Skipped|Incomplete)\\(|#\\[Group\\('skip'\\)\\]", skipSamples: ["self::markTestSkipped('a');", "self::markTestIncomplete('b');", "#[Group('skip')]"] },
		];
		const client = new FakeModelClient({ chat: () => ({ json: answers.shift() }) });
		expect(await healSkipMarker(ws, { client, model: "m" })).toEqual(["sym-test"]);
		expect(JSON.stringify((client.calls[1]!.req as { messages: unknown[] }).messages)).toContain("does not match these skip samples: self::markTestIncomplete");
		const healed = loadManifests(ws)[0]!;
		expect(fromManifest(healed).layout.skipMarker.test("        self::markTestIncomplete('Workflow implementation pending.');")).toBe(true);
		expect(await healSkipMarker(ws, { client, model: "m" })).toEqual([]); // asked once
		expect(client.calls.length).toBe(2);
	});

	it("run start: a manifest without migrateFresh gets the command tried on main's project, or a tool from the setup model; the data folders too", async () => {
		const { healMigrateFresh, loadManifests } = await import("../src/adapters/target/generated.ts");
		const ws = join(here, ".sim", "heal-migrate-fresh");
		const proj = join(ws, "project");
		rmSync(ws, { recursive: true, force: true });
		mkdirSync(join(ws, ".bigrefactor", "adapters"), { recursive: true });
		mkdirSync(join(proj, "bin"), { recursive: true });
		writeFileSync(join(proj, "bin", "migrate"), "#!/bin/sh\n[ \"$1\" = \"--fresh\" ] || { echo \"unknown option $1\"; exit 1; }\necho \"Version20260623000000: relation users does not exist\"; exit 1\n");
		chmodSync(join(proj, "bin", "migrate"), 0o755);
		const save = () => writeFileSync(join(ws, ".bigrefactor", "adapters", "sym-test.json"), JSON.stringify(php()));
		save();
		// the command fails because a migration does: answered the same after its output, it is kept
		const answers = [
			{ migrateFresh: { cmd: "bin/migrate", args: ["--fresh"] }, dataDirs: ["migrations", "/etc"], hasMigrations: true },
			{ migrateFresh: { cmd: "bin/migrate", args: ["--fresh"] }, dataDirs: ["migrations"], hasMigrations: true },
		];
		const client = new FakeModelClient({ chat: () => ({ json: answers.shift() }) });
		expect(await healMigrateFresh(ws, { client, model: "m", dirOf: () => proj })).toEqual(["sym-test"]);
		expect(JSON.stringify((client.calls[1]!.req as { messages: unknown[] }).messages)).toContain("relation users does not exist");
		let m = loadManifests(ws)[0]!;
		expect(m.migrateFresh).toEqual({ cmd: "bin/migrate", args: ["--fresh"] });
		expect(m.layout.dataDirs).toEqual(["migrations/"]);
		expect(await healMigrateFresh(ws, { client, model: "m", dirOf: () => proj })).toEqual([]); // asked once
		// no command yet, but migrations: the setup model is asked for a tool; none is saved so it is not asked again
		save();
		const none = new FakeModelClient({ chat: () => ({ json: { migrateFresh: { cmd: "", args: [] }, dataDirs: [], hasMigrations: true } }) });
		const asked: string[] = [];
		await healMigrateFresh(ws, { client: none, model: "m", dirOf: () => proj, writeTool: async (_id, problem) => (asked.push(problem), true) });
		expect(asked[0]).toMatch(/set_gate_command step migrateFresh/);
		m = loadManifests(ws)[0]!;
		expect(m.migrateFresh).toEqual({ cmd: "", args: [] });
		expect(fromManifest(m).migrateFresh).toBeUndefined();
		// the workspace already sets one: not asked
		save();
		const own = new FakeModelClient({ chat: () => ({ json: {} }) });
		expect(await healMigrateFresh(ws, { client: own, model: "m", dirOf: () => proj, hasOwn: () => true })).toEqual([]);
		expect(own.calls.length).toBe(0);
	});

	it("the implementer is never told the stack needs no registration when the adapter never said so", async () => {
		const { implementerSystemPrompt } = await import("../src/run/prompts.ts");
		const { ConfigSchema } = await import("../src/config.ts");
		const config = ConfigSchema.parse({ source: { path: "/x", stack: "php" }, target: { path: "/y", stacks: ["sym-test"] }, models: {} });
		const opts = { area: "billing", stackId: "sym-test", moduleDir: "src/Billing", structureDoc: "-", sharedDirs: [], rules: "", attempt: 1, source: { id: "php" } as never };
		const older = implementerSystemPrompt(config, { ...opts, target: fromManifest(php({ rules: undefined })) });
		expect(older).not.toMatch(/finds new code without a registration file/);
		expect(older).toMatch(/No registration file is named for this stack/);
		expect(implementerSystemPrompt(config, { ...opts, target: fromManifest(php({ rules: undefined, wiringFiles: [] })) })).toMatch(/finds new code without a registration file/);
	});

	it("the migrate-on-empty-database command is checked like the others and passed on", () => {
		const m = manifest({ migrateFresh: { cmd: "bin/console", args: ["doctrine:migrations:migrate", "--no-interaction", "--env=test"] } });
		expect(validateManifest(m)).toEqual([]);
		expect(fromManifest(m).migrateFresh!("/p")).toEqual({ cmd: "bin/console", args: ["doctrine:migrations:migrate", "--no-interaction", "--env=test"] });
		expect(fromManifest(manifest()).migrateFresh).toBeUndefined();
		expect(validateManifest(manifest({ migrateFresh: { cmd: "sh", args: ["-c", "x"] } })).join("\n")).toMatch(/migrateFresh.*shell/);
	});

	it("the model's boot check is checked like the others and passed on; an empty one is none", () => {
		const m = manifest({ boot: { cmd: "bin/app", args: ["check"] } });
		expect(validateManifest(m)).toEqual([]);
		expect(fromManifest(m).boot!("/p")).toEqual({ cmd: "bin/app", args: ["check"] });
		expect(fromManifest(manifest({ boot: { cmd: "", args: [] } })).boot).toBeUndefined();
		expect(validateManifest(manifest({ boot: { cmd: "sh", args: ["-c", "x"] } })).join("\n")).toMatch(/boot.*shell/);
	});
});
