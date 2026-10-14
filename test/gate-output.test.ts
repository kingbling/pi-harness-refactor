import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TargetAdapter } from "../src/adapters/types.ts";
import { withCommandOverrides } from "../src/adapters/command-overrides.ts";
import { nestjsAdapter } from "../src/adapters/target/nestjs.ts";
import { setCommandTool } from "../src/init/setup-fixer.ts";
import { clipOutput, runTests } from "../src/run/gate.ts";

describe("gate output", () => {
	it("clipOutput shows the failure first, drops colours and deprecations, and saves the full output", () => {
		const dom = Array.from({ length: 300 }, (_, i) => `        \x1b[36m<div class="row-${i}">\x1b[39m`).join("\n");
		const deprecations = Array.from({ length: 40 }, (_, i) => `  ${i}) Deprecated: Since symfony/http-kernel 7.${i}: some option is deprecated`).join("\n");
		const out = [
			`$ npx vitest related --run ${Array.from({ length: 30 }, (_, i) => `src/features/a/F${i}.test.tsx`).join(" ")}`,
			" RUN  v5.0.3",
			deprecations,
			" FAIL  src/features/a/Page.test.tsx > Page > U1#6 renders the edit link",
			"TestingLibraryElementError: Unable to find an accessible element with the role \"link\" and name \"Edit\"",
			dom,
			" ❯ src/features/a/Page.test.tsx:69:25",
			"     69|     expect(await screen.findByRole('link', { name: 'Edit' })).toHaveAttribute('href', '/x')",
			" Test Files  1 failed | 5 passed (6)",
			"      Tests  1 failed | 14 passed (15)",
		].join("\n");
		const saveTo = join(mkdtempSync(join(tmpdir(), "br-clip-")), "sessions", "U1.ported_tests_green.log");
		const c = clipOutput(out, 4000, saveTo);
		expect(c.length).toBeLessThanOrEqual(4200);
		expect(c).not.toContain("\x1b[");
		expect(c).not.toMatch(/Deprecated: Since/);
		// the failure and its code frame come before the DOM dump and the long command line
		expect(c.indexOf("Unable to find an accessible element")).toBeLessThan(c.indexOf("── rest of the output ──"));
		expect(c.indexOf("Page.test.tsx:69:25")).toBeLessThan(c.indexOf("── rest of the output ──"));
		expect(c).toContain("Tests  1 failed | 14 passed");
		expect(c).toContain(`(full output: ${saveTo})`);
		expect(readFileSync(saveTo, "utf8")).toContain("row-299");
		expect(readFileSync(saveTo, "utf8")).not.toContain("\x1b[");
	});

	it("clipOutput saves nothing when nothing is cut", () => {
		const saveTo = join(mkdtempSync(join(tmpdir(), "br-clip-")), "U1.log");
		expect(clipOutput("\x1b[31mFAIL\x1b[39m x", 6000, saveTo)).toBe("FAIL x");
		expect(existsSync(saveTo)).toBe(false);
	});

	it("clipOutput keeps a code line inside a failure block even when it says notice", () => {
		const noise = Array.from({ length: 200 }, (_, i) => `  ${i}) PHPUnit Deprecation: something old ${i}`).join("\n");
		const filler = Array.from({ length: 200 }, (_, i) => `ok ${i} passed`).join("\n");
		const out = [filler, "1) App\\Tests\\NoticeTest::testFind", "Failed asserting that null is identical to 3.", "  12 |   $notice = $repo->find($id);", noise].join("\n");
		const c = clipOutput(out, 3000);
		expect(c).toContain("$notice = $repo->find($id);");
		expect(c).not.toMatch(/PHPUnit Deprecation: something old 150/);
		expect(c).toMatch(/deprecation or notice line\(s\) left out/);
	});

	it("clipOutput puts each distinct error message with its count first and keeps it after every failed test; notice lists go first", () => {
		const wt = "/w/worktrees/U1/symfony";
		const trace = Array.from({ length: 25 }, (_, i) => `${wt}/vendor/symfony/config/Loader/FileLoader.php:${100 + i}`).join("\n");
		const msg = `Symfony\\Component\\Config\\Exception\\LoaderLoadException: Expected to find class "App\\Targeting\\AirlineCodes" in file "${wt}/src/Targeting/AirlineCodes.php"`;
		// a notice list: numbered entries that look like failed tests, many of them
		const notices = ["12 tests triggered 24 PHPUnit notices:", "", ...Array.from({ length: 60 }, (_, i) => [`${i + 1}) App\\Tests\\AccessTest::testVoter#${i}`, "* No expectations were configured for the mock object for App\\Security\\Subject.", "", `${wt}/tests/AccessTest.php:38`, ""]).flat()].join("\n");
		const file = (f: string, n: number) => [`Running ${f}`, "PHPUnit 13.4.1", "", "EE", "", `There were ${n} errors:`, "", ...Array.from({ length: n }, (_, i) => [`${i + 1}) App\\Tests\\${f.replace(/\W/g, "")}::test${i}`, msg, "", trace, ""]).flat(), "ERRORS!", `Tests: ${n}, Errors: ${n}.`].join("\n");
		const out = [notices, ...Array.from({ length: 8 }, (_, i) => file(`tests/T${i}Test.php`, 3)), "Failed tests/T0Test.php (exit 2)"].join("\n");
		const c = clipOutput(out, 6000);
		expect(c.length).toBeLessThanOrEqual(6300);
		// the shared cause, once with its count, before anything else of the output
		expect(c).toMatch(/error messages \(each distinct one, × the failed tests with it\):\n24 × Symfony\\Component\\Config\\Exception\\LoaderLoadException: Expected to find class/);
		// after each failed test its message stays, though it repeats
		const failures = c.slice(c.indexOf("failures:"));
		expect(failures).toMatch(/1\) App\\Tests\\testsT0TestphP?::test0\n.*LoaderLoadException/i);
		expect((failures.match(/LoaderLoadException/g) ?? []).length).toBeGreaterThan(2);
		// the notice list is gone, not shown as failures
		expect(c).not.toContain("No expectations were configured");
		expect(c).not.toContain("AccessTest::testVoter");
	});

	// a per-file wrapper (like tools/run-phpunit.php): every arg is a test file, so flags may never be added to it
	const runner = (body: string) => {
		const dir = mkdtempSync(join(tmpdir(), "br-runner-"));
		writeFileSync(join(dir, "runner"), `#!/bin/sh\necho "$*" >> ran.log\n${body}\n`);
		chmodSync(join(dir, "runner"), 0o755);
		const test = (_r: string, files: string[]) => ({ cmd: "./runner", args: files });
		return { dir, adapter: { test } as unknown as TargetAdapter, lenient: { test, testLenient: (_r: string, files: string[]) => ({ cmd: "./runner", args: ["--lenient", ...files] }) } as unknown as TargetAdapter };
	};
	const ran = (dir: string) => readFileSync(join(dir, "ran.log"), "utf8").trim().split("\n");

	it("a run red only on deprecations or notices is green with a warning when the stack has a lenient test command", async () => {
		const { dir, lenient } = runner(`echo "OK, but there were issues! Tests: 3, Deprecations: 2, Notices: 1"\ncase "$1" in --lenient) exit 0;; esac\nexit 1`);
		const r = await runTests(lenient, dir, ["tests/ATest.php"], 10_000);
		expect(r.ok).toBe(true);
		expect(r.output).toMatch(/^warning: every test passed/);
		expect(ran(dir)).toEqual(["tests/ATest.php", "--lenient tests/ATest.php"]);
	});

	it("without a lenient test command no flag is added and the run is not repeated", async () => {
		const { dir, adapter } = runner(`echo "OK, but there were issues! Tests: 3, Deprecations: 2, PHPUnit Notices: 1"\nexit 1`);
		const r = await runTests(adapter, dir, ["tests/ATest.php"], 10_000);
		expect(r.ok).toBe(false);
		expect(ran(dir)).toEqual(["tests/ATest.php"]);
	});

	it("a failed test stays red with the lenient command, and the first run's output is kept", async () => {
		const { dir, lenient } = runner(`case "$1" in --lenient) echo "lenient run output"; exit 1;; esac\necho "FAILURES! Tests: 3, Failures: 1, Deprecations: 2"\nexit 1`);
		const r = await runTests(lenient, dir, ["tests/ATest.php"], 10_000);
		expect(r.ok).toBe(false);
		expect(r.output).toContain("Failures: 1");
		expect(r.output).not.toContain("lenient run output");
	});

	it("the setup fixer's testLenient command is the stack's lenient test command, with the files", async () => {
		const root = mkdtempSync(join(tmpdir(), "br-lenient-"));
		expect(withCommandOverrides(nestjsAdapter, root).testLenient?.(root, ["a.php"])).toBeUndefined();
		await (setCommandTool(root, "nestjs") as unknown as { execute: (i: string, p: object) => Promise<unknown> }).execute("x", { step: "testLenient", cmd: "vendor/bin/phpunit", args: ["--do-not-fail-on-deprecation", "{files}"], why: "phpunit --help lists it" });
		expect(withCommandOverrides(nestjsAdapter, root).testLenient?.(root, ["a.php"])).toEqual({ cmd: "vendor/bin/phpunit", args: ["--do-not-fail-on-deprecation", "a.php"] });
	});

	it("a red run without deprecations is not run again", async () => {
		const { dir, lenient } = runner(`echo "FAILURES! Tests: 1, Failures: 1"\nexit 1`);
		const r = await runTests(lenient, dir, [], 10_000);
		expect(r.ok).toBe(false);
		expect(ran(dir)).toHaveLength(1);
	});
});
