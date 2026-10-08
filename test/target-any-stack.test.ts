import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fromManifest, validateManifest, verifyManifest, type AdapterManifest } from "../src/adapters/target/generated.ts";
import type { TargetAdapter } from "../src/adapters/types.ts";
import { ConfigSchema } from "../src/config.ts";
import { checkToolchain, init, parseTargets } from "../src/init/init.ts";
import { FakeModelClient } from "../src/models/fake.ts";
import { findTests } from "../src/run/ported.ts";

/** Checks that must hold for any target stack, not only the TypeScript ones. */
const assertTest = (n: number) => `import test from "node:test"\nimport assert from "node:assert"\ntest("probe", () => assert.equal(1 + 1, ${n}))\n`;
const manifest = (id: string, over: Partial<AdapterManifest> = {}): AdapterManifest => ({
	id,
	role: "server",
	subdir: "api",
	aliases: [],
	docs: [],
	scaffold: { cmd: "mkdir", args: ["-p", "{name}"], readyFile: "ready.txt" },
	postScaffold: [{ cmd: "touch", args: ["ready.txt"] }],
	build: { cmd: "true", args: [] },
	lint: { cmd: "true", args: ["{files}"] },
	test: { cmd: "node", args: ["--test", "{files}"] },
	toolchain: { ecosystem: "x", packageName: "^[a-z]+", packageExamples: [], manifestFiles: ["ready.txt"], installed: { file: "none.json", keys: [] }, add: { cmd: "true", args: ["{packages}"] }, worktreeLinks: [], ignoredPaths: [] },
	layout: { moduleDir: "src/{area}", structureDoc: "one folder per area", sharedDirs: ["src/shared/"], testFileGlobs: ["{moduleDir}/**/*.test.mjs"], testFileRegex: "\\.test\\.mjs$", sourceExtensions: [".mjs"], langByExtension: {}, skipMarker: "skip\\(", interfaceHint: "-", testHint: "-", legacyMarker: "# LEGACY: {why}", dataAccessHint: "", ignoreDirs: [] },
	platform: {},
	stackChoices: [],
	protectedGlobs: [],
	patternKinds: ["service"],
	probeTest: { path: "probe.test.mjs", content: assertTest(2), failing: assertTest(3) },
	detect: { file: "ready.txt", contains: "" },
	...over,
});

describe("a wrong test must fail, on any stack", () => {
	const stack = (probe: { path: string; content: string; failing?: string }) => {
		const root = mkdtempSync(join(tmpdir(), "br-anystack-"));
		const target = join(root, "new");
		mkdirSync(target, { recursive: true });
		const adapter = {
			id: "py",
			toolchain: { isProjectReady: () => true },
			probeTest: () => probe,
			build: () => ({ cmd: "true", args: [] }),
			lint: () => ({ cmd: "true", args: [] }),
			// a test command that never runs anything (e.g. pytest --collect-only)
			test: () => ({ cmd: "true", args: [] }),
		} as unknown as TargetAdapter;
		const config = ConfigSchema.parse({ source: { path: root, stack: "php" }, target: { path: target, stacks: ["py"] }, models: {} });
		return { config, adapter };
	};

	it("uses the adapter's failing probe (a pytest probe has no toBe(2)) and reports a test command that cannot fail", async () => {
		const { config, adapter } = stack({ path: "test_probe.py", content: "def test_probe():\n    assert 1 + 1 == 2\n", failing: "def test_probe():\n    assert 1 + 1 == 3\n" });
		await expect(checkToolchain(config, adapter, { fix: false })).rejects.toThrow(/passes a failing test/);
	});

	it("says so when the adapter has no failing probe instead of skipping silently", async () => {
		const { config, adapter } = stack({ path: "test_probe.py", content: "def test_probe():\n    assert 1 + 1 == 2\n" });
		const out: string[] = [];
		const orig = console.log;
		console.log = (...a: unknown[]) => out.push(a.join(" "));
		try {
			await checkToolchain(config, adapter, { fix: false });
		} finally {
			console.log = orig;
		}
		expect(out.join("\n")).toMatch(/not checked that the gate's test command can fail/);
	});

	it("a generated manifest needs a failing probe that differs, and its test command must fail on it", async () => {
		expect(validateManifest(manifest("same", { probeTest: { path: "probe.test.mjs", content: assertTest(2), failing: assertTest(2) } })).join("\n")).toMatch(/probeTest.failing must differ/);
		expect(await verifyManifest(manifest("missing", { probeTest: { path: "probe.test.mjs", content: assertTest(2) } }))).toMatch(/probeTest.failing is missing/);
		expect(await verifyManifest(manifest("blind", { test: { cmd: "node", args: ["--version", "{files}"] } }))).toMatch(/passes probeTest.failing/);
		expect(await verifyManifest(manifest("good"))).toBeUndefined();
	});
});

describe("ported tests are found by path", () => {
	it("a folder-based test regex (JVM/RSpec style) still finds the unit's tests", () => {
		const dir = mkdtempSync(join(tmpdir(), "br-ported-"));
		mkdirSync(join(dir, "src/test/kotlin/billing"), { recursive: true });
		writeFileSync(join(dir, "src/test/kotlin/billing/InvoiceTest.kt"), "// u1#1\n");
		const a = fromManifest(manifest("kt", { layout: { ...manifest("kt").layout, testFileGlobs: ["src/test/kotlin/{area}/**/*.kt"], testFileRegex: "^src/test/" } }));
		expect(findTests(dir, a.layout.moduleDir("billing"), a.layout)).toEqual(["src/test/kotlin/billing/InvoiceTest.kt"]);
	});
});

describe("--to names any stack", () => {
	const here = resolve(import.meta.dirname, "..");
	const ws = (name: string) => {
		const d = join(here, ".sim", name);
		rmSync(d, { recursive: true, force: true });
		mkdirSync(join(d, "legacy"), { recursive: true });
		cpSync(join(here, "fixtures", "mini-app"), join(d, "legacy"), { recursive: true });
		return d;
	};
	const quiet = { text: async (_m: string, i?: string) => i, select: async (_m: string, o: Array<{ value: string }>, i?: string) => i ?? o[0]!.value, log: () => {} };
	const args = (d: string, to: string, extra: string[] = []) => ["--source", join(d, "legacy"), "--stack", "php", "--target", join(d, "migrated"), "--to", to, "--yes", "--no-docs", ...extra];

	it("splits on commas and plus, not on spaces", () => {
		expect(parseTargets("spring boot + react")).toEqual({ ids: ["react"], unknown: ["spring boot"] });
		expect(parseTargets("nest, react")).toEqual({ ids: ["nestjs", "react"], unknown: [] });
		expect(parseTargets("nest react")).toEqual({ ids: ["nestjs", "react"], unknown: [] });
	});

	it("an unknown target without a model fails with its name", async () => {
		const d = ws("to-unknown-nollm");
		await expect(init(args(d, "go", ["--no-llm"]), { root: d, prompter: quiet })).rejects.toThrow(/unknown target "go"/);
	});

	it("an unknown target gets an adapter written for it, like an unknown source", async () => {
		const d = ws("to-unknown-gen");
		const client = new FakeModelClient({ chat: (req) => ((req.schema as any)?.properties?.probeTest ? { json: manifest("go") } : undefined) });
		await init(args(d, "go"), { root: d, prompter: quiet, client });
		expect(JSON.parse(readFileSync(join(d, "bigrefactor.config.json"), "utf8")).target.stacks).toEqual(["go"]);
	});
});
