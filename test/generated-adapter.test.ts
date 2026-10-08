import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getTargetAdapter, knownTargets, registerGeneratedTargets, TARGET_ROLES, TARGET_SUBDIRS } from "../src/adapters/registry.ts";
import { fromManifest, generateAdapter, validateManifest, type AdapterManifest } from "../src/adapters/target/generated.ts";
import { FakeModelClient } from "../src/models/fake.ts";

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
