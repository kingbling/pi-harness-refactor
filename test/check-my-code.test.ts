import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { nestjsAdapter } from "../src/adapters/target/nestjs.ts";
import { ConfigSchema } from "../src/config.ts";
import { implementerSystemPrompt } from "../src/run/prompts.ts";
import { checkMyCodeTool, implementerTools } from "../src/sessions/tools.ts";

/**
 * The implementer runs the gate's build, lint and ported tests on its changed files before it says DONE, instead of
 * finding out from the gate one attempt later.
 */
const here = resolve(import.meta.dirname, "..");
let dir: string;
const write = (p: string, s = "x\n") => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, s));
const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
const exec = (t: unknown) => (t as { execute: (i: string, p: object) => Promise<{ content: Array<{ text: string }>; details: any }> }).execute("x", {});
const SPEC = "src/a/a.service.spec.ts";
const sh = (script: string) => (_d: string, files: string[]) => ({ cmd: "sh", args: ["-c", script, "sh", ...files] });
const tool = (adapter: object, slot?: <T>(fn: () => Promise<T>) => Promise<T>) =>
	checkMyCodeTool({ ledger: undefined as never, config: undefined as never, unitId: "u1", root: dir, targetProjectDir: dir, adapter: { ...nestjsAdapter, ...adapter } as never, testFiles: () => [SPEC], slot });

beforeEach(() => {
	dir = join(here, ".sim", "check-my-code");
	rmSync(dir, { recursive: true, force: true });
	write(join(dir, SPEC), "it('u1#1', () => {});\n");
	write(join(dir, "src/a/old.ts"), "export const old = 1;\n");
	git("init", "-q");
	git("add", "-A");
	git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
	write(join(dir, "src/a/a.service.ts"), "export class A {}\n");
});

describe("check_my_code", () => {
	it("builds and lints only the changed files, then runs the ported tests, inside the gate slot", async () => {
		let slots = 0;
		const r = await exec(tool({ build: sh('echo "built $*"'), lint: sh("true"), test: sh('echo "tested $*"') }, (fn) => (slots++, fn())));
		const out = r.content[0]!.text;
		expect(r.details).toMatchObject({ ok: true, files: ["src/a/a.service.ts"] });
		expect(out).toMatch(/BUILD clean \(`sh -c .* src\/a\/a\.service\.ts`\)/);
		expect(out).not.toContain("old.ts");
		expect(out).toMatch(/LINT clean/);
		expect(out).toContain(`TESTS green (${SPEC})`);
		expect(slots).toBe(3);
	});

	it("stops at a failed build and shows its output", async () => {
		const r = await exec(tool({ build: sh("echo 'Class Foo not found' >&2; exit 1"), lint: sh("exit 1"), test: sh("exit 1") }));
		expect(r.details).toMatchObject({ ok: false, failed: "build" });
		expect(r.content[0]!.text).toMatch(/BUILD FAILED[\s\S]*Class Foo not found/);
		expect(r.content[0]!.text).not.toMatch(/LINT|TESTS/);
	});

	it("reports red tests with their output", async () => {
		const r = await exec(tool({ build: sh("true"), lint: sh("true"), test: sh("echo 'expected 2, got 3'; exit 1") }));
		expect(r.details).toMatchObject({ ok: false, failed: "tests" });
		expect(r.content[0]!.text).toMatch(/TESTS FAILED[\s\S]*expected 2, got 3/);
	});

	it("long red test output shows the failure first and is saved whole in the unit's sessions folder", async () => {
		const r = await exec(tool({ build: sh("true"), lint: sh("true"), test: sh("echo 'FAIL u1#1 total: expected 2, got 3'; i=0; while [ $i -lt 600 ]; do echo \"  <div class=row-$i>\"; i=$((i+1)); done; exit 1") }));
		const out = r.content[0]!.text;
		const full = join(dir, ".bigrefactor", "sessions", "u1.check_my_code.log");
		expect(out).toMatch(/TESTS FAILED[\s\S]*failures:\n[\s\S]*expected 2, got 3/);
		expect(out).toContain(`(full output: ${full})`);
		expect(readFileSync(full, "utf8")).toContain("row-599");
	});

	it("tests red only on deprecations are green with the warning", async () => {
		const r = await exec(tool({ build: sh("true"), lint: sh("true"), test: sh("echo 'OK, but there were issues! Deprecations: 1'; exit 1"), testLenient: sh("echo 'OK, but 1 deprecation'") }));
		expect(r.details).toMatchObject({ ok: true });
		expect(r.content[0]!.text).toMatch(/TESTS green \(.*\)\. warning: every test passed; the run failed only on deprecations/);
	});

	it("is one of the implementer's tools and its prompt asks for it before DONE", () => {
		expect(implementerTools({ ledger: undefined as never, config: undefined as never, unitId: "u1", root: dir, targetProjectDir: dir, adapter: nestjsAdapter }).map((t) => t.name)).toContain("check_my_code");
		const config = ConfigSchema.parse({ source: { path: "/l", stack: "php" }, target: { path: "/t", stacks: ["nestjs"] }, models: {} });
		const p = implementerSystemPrompt(config, { area: "a", stackId: "nestjs", moduleDir: "src/a", structureDoc: "-", sharedDirs: [], rules: "", attempt: 1, source: { id: "php" } as never, target: { layout: { legacyMarker: () => "" } } as never });
		expect(p).toMatch(/call check_my_code[^\n]*fix what it reports/);
		expect(p).not.toMatch(/do not run builds/);
		// a missing class the interface or the tests use is the implementer's to write (a TODO(br:) stub when another unit owns it)
		expect(p).toMatch(/does not exist yet is yours to write[^\n]*TODO\(br:<owning unit>\)[^\n]*Only a change outside your write paths is not yours/);
	});
});
