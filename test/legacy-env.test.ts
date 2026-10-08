import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SourceAdapter } from "../src/adapters/types.ts";
import { ConfigSchema } from "../src/config.ts";
import { describeTruthRun, fixLegacyEnv, legacyCopyTool, legacyRunTool, loadLegacyEnv, MAX_LEGACY_FIXES_PER_PROBLEM, verifyTruthOnOld, type LegacyFixer } from "../src/run/legacy-env.ts";

/**
 * The old code runs for truth in its own environment: when its packages are missing, the setup model makes a
 * workspace copy (the legacy repo stays untouched) and installs them there; code re-runs the failed script.
 */
function workspace() {
	const root = mkdtempSync(join(tmpdir(), "br-legacy-"));
	const legacy = join(root, "legacy");
	mkdirSync(legacy, { recursive: true });
	writeFileSync(join(legacy, "app.sh"), "cat deps/lib.json\n"); // needs a dependency that was never installed
	const truthDir = join(root, ".bigrefactor", "truth", "U1");
	mkdirSync(truthDir, { recursive: true });
	writeFileSync(join(truthDir, "cases.sh"), "sh app.sh\n");
	const config = ConfigSchema.parse({ source: { path: legacy, stack: "php" }, target: { path: join(root, "new"), stacks: ["nestjs"] }, models: {} });
	const source = { id: "shell", truth: { scriptName: "cases.sh", run: (_r: string, s: string) => ({ cmd: "sh", args: [s] }), instructions: "" } } as unknown as SourceAdapter;
	return { root, legacy, truthDir, config, source };
}
const call = (t: unknown, p: object) => (t as { execute: (id: string, p: object) => Promise<{ content: Array<{ text: string }> }> }).execute("x", p);

describe("the old code's environment", () => {
	it("is the legacy repo until the setup model makes a copy; the copy gets the dependencies, the repo stays read-only", async () => {
		const { root, legacy, truthDir, config, source } = workspace();
		expect(verifyTruthOnOld(truthDir, config, source, root).ok).toBe(false);
		const fixer: LegacyFixer = async (o) => {
			await call(legacyCopyTool(o.root, o.config), { why: "packages were never installed" });
			const copy = loadLegacyEnv(o.root, o.config).root;
			mkdirSync(join(copy, "deps"), { recursive: true });
			writeFileSync(join(copy, "deps", "lib.json"), '[{"symbol":"app.sh::run","inputs":[],"expected":1}]');
			return "installed the dependencies in a copy";
		};
		const fixed = await fixLegacyEnv({ config, root, source, problem: "cat: deps/lib.json: No such file", truthDir, signature: "truth: missing deps", fixer });
		expect(fixed).toBe("installed the dependencies in a copy");
		expect(verifyTruthOnOld(truthDir, config, source, root)).toMatchObject({ ok: true, cases: [{ symbol: "app.sh::run" }] });
		expect(existsSync(join(legacy, "deps"))).toBe(false);
		expect(describeTruthRun(root, config, source, "/t/cases.sh")).toBe(`cd ${loadLegacyEnv(root, config).root} && sh /t/cases.sh`);
		expect(readFileSync(join(root, ".bigrefactor", "legacy-env.log"), "utf8")).toMatch(/installed the dependencies/);
	});

	it("a session after which the script still fails is no fix, and one problem gets only so many tries", async () => {
		const { root, truthDir, config, source } = workspace();
		let calls = 0;
		const nothing: LegacyFixer = async () => (calls++, "looked around");
		for (let i = 0; i < MAX_LEGACY_FIXES_PER_PROBLEM + 1; i++) expect(await fixLegacyEnv({ config, root, source, problem: "x", truthDir, signature: "truth: same", fixer: nothing })).toBeUndefined();
		expect(calls).toBe(MAX_LEGACY_FIXES_PER_PROBLEM);
	});

	it("the run command can change, but must run the script", async () => {
		const { root, config, source } = workspace();
		expect((await call(legacyRunTool(root, config), { cmd: "true", args: [], why: "cheat" })).content[0]!.text).toMatch(/refused/);
		await call(legacyRunTool(root, config), { cmd: "sh", args: ["-e", "{script}"], why: "stop on the first error" });
		expect(describeTruthRun(root, config, source, "/t/cases.sh")).toBe(`cd ${config.source.path} && sh -e /t/cases.sh`);
	});
});
