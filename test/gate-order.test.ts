import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nestjsAdapter } from "../src/adapters/target/nestjs.ts";
import { NEST_LAYOUT } from "../src/adapters/target/ts-structure.ts";
import type { TargetAdapter } from "../src/adapters/types.ts";
import { Ledger } from "../src/ledger/db.ts";
import { clipOutput, reusableCheck, runGate, type GateReport } from "../src/run/gate.ts";
import { checkLayoutRules, normalize } from "../src/rules/layout-rules.ts";

/**
 * The gate does not contradict the unit's own scope (its ported tests, the stubs it was told to replace), runs the
 * ported tests before the review model, keeps the start and the end of long output, records slot time apart, and
 * takes build, lint and the tests from a green check_my_code on the same tree.
 */
const tick = { cmd: "true", args: [] as string[] };
const adapter: TargetAdapter = { ...nestjsAdapter, build: () => tick, lint: () => tick, test: () => tick };

let ws: string;
let project: string;
let ledger: Ledger;
const write = (rel: string, body: string) => {
	mkdirSync(dirname(join(project, rel)), { recursive: true });
	writeFileSync(join(project, rel), body);
};
const sha1 = (rel: string) => createHash("sha1").update(readFileSync(join(project, rel))).digest("hex");
const commit = () => {
	execFileSync("git", ["add", "-A"], { cwd: project });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "landed"], { cwd: project });
};
const step = (r: GateReport, name: string) => r.steps.find((s) => s.name === name);
const gate = (extra: Partial<Parameters<typeof runGate>[0]> = {}) =>
	runGate({ ledger, unitId: "u1", adapter, targetProjectDir: project, writeGlobs: ["src/features/agency/**"], testFiles: [], moduleDir: "src/features/agency", area: "agency", ...extra });

beforeEach(() => {
	ws = mkdtempSync(join(tmpdir(), "br-gate-order-"));
	project = join(ws, "api");
	mkdirSync(project, { recursive: true });
	write("package.json", JSON.stringify({ dependencies: { "@nestjs/core": "^11" } }));
	write("src/shared/agency/agency.spec.ts", "it('u1#1 old', () => {});\n");
	write("src/features/billing/billing.service.ts", "export class BillingService {\n\t// TODO(br:u1)\n}\n");
	execFileSync("git", ["init", "-q"], { cwd: project });
	commit();
	mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
	ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
	ledger.createUnit({ id: "u1", tier: "T0", symbolIds: [] });
	write("src/features/agency/agency.service.ts", "export class AgencyService {\n\ttotal(): number {\n\t\treturn 1;\n\t}\n}\n");
});
afterEach(() => {
	ledger.close();
	rmSync(ws, { recursive: true, force: true });
});

describe("gate: own scope", () => {
	it("a re-ported test of this unit in the add-only zone is not 'edited an existing shared file'", async () => {
		write("src/shared/agency/agency.spec.ts", "it('u1#1 re-ported', () => {});\n");
		const testFiles = [{ path: "src/shared/agency/agency.spec.ts", sha1: sha1("src/shared/agency/agency.spec.ts") }];
		const r = await gate({ appendOnlyGlobs: ["src/shared/**"], testFiles });
		expect(step(r, "antigaming_ok")?.output).not.toContain("add-only");
		expect(step(r, "antigaming_ok")?.ok).toBe(true);
		// someone else's test there still is an edit of a shared file
		const other = await gate({ appendOnlyGlobs: ["src/shared/**"], testFiles: [] });
		expect(step(other, "antigaming_ok")?.output).toContain("edited an existing shared file (add-only zone): src/shared/agency/agency.spec.ts");
	});

	it("a whole-project build skipped in the unit's gate is stored as not judged, not as a green build", async () => {
		await gate();
		const ev = ledger.evidenceOf("u1").find((e) => e.type === "build_ok");
		expect(JSON.parse(ev!.payload)).toMatchObject({ judged: false, note: expect.stringMatching(/whole-project build: the builder runs it/) });
	});

	it("no production file changed but ported tests to run: reuse passes anti-gaming, the tests and the reviewer decide", async () => {
		commit();
		const testFiles = [{ path: "src/shared/agency/agency.spec.ts", sha1: sha1("src/shared/agency/agency.spec.ts") }];
		const r = await gate({ testFiles });
		expect(step(r, "antigaming_ok")).toMatchObject({ ok: true, output: expect.stringMatching(/reuse/) });
		// without tests, writing nothing is still a failure
		expect(step(await gate(), "antigaming_ok")).toMatchObject({ ok: false, output: expect.stringMatching(/no production files were written/) });
	});

	it("a file that still holds a merge conflict marker fails antigaming_ok, in any file type", async () => {
		write("src/features/agency/agency.module.yaml", "routes:\n<<<<<<< HEAD\n  - a\n=======\n  - b\n>>>>>>> unit\n");
		const r = await gate();
		expect(step(r, "antigaming_ok")?.ok).toBe(false);
		expect(step(r, "antigaming_ok")?.output).toContain("unresolved merge conflict in src/features/agency/agency.module.yaml:2");
		// a markdown heading underline is no marker
		write("src/features/agency/agency.module.yaml", "routes:\n  - a\n  - b\n");
		write("src/features/agency/README.md", "Agency\n=======\n");
		expect(step(await gate(), "antigaming_ok")?.ok).toBe(true);
	});

	it("a stub mark this unit adds must name a unit still to come: not an invented owner, not this unit, not an accepted one", async () => {
		ledger.createUnit({ id: "u2", tier: "T0", symbolIds: [] });
		ledger.createUnit({ id: "u3", tier: "T0", symbolIds: [] });
		ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = 'u3'").run();
		const withMark = (owner: string) => write("src/features/agency/agency.service.ts", `export class AgencyService {\n\t// TODO(br:${owner}) save\n\ttotal(): number {\n\t\treturn 1;\n\t}\n}\n`);
		withMark("shared-workflow-owner");
		expect(step(await gate(), "antigaming_ok")).toMatchObject({ ok: false, output: expect.stringMatching(/agency\.service\.ts:2: TODO\(br:shared-workflow-owner\) names no unit[\s\S]*generic behaviour/) });
		withMark("u1");
		expect(step(await gate(), "antigaming_ok")?.output).toMatch(/names this unit/);
		withMark("u3");
		expect(step(await gate(), "antigaming_ok")?.output).toMatch(/names u3, which is accepted/);
		withMark("u2");
		expect(step(await gate(), "antigaming_ok")?.ok).toBe(true);
	});

	it("a stub the unit was told to replace passes structure_ok when sanctioned", async () => {
		ledger.addEvidence("u1", "truth_none", { reason: "a contract only" });
		write("src/features/billing/billing.service.ts", "export class BillingService {\n\tagencyTotal(): number {\n\t\treturn 2;\n\t}\n}\n");
		const writeGlobs = ["src/features/agency/**", "src/features/billing/billing.service.ts"];
		const without = await gate({ writeGlobs });
		expect(step(without, "structure_ok")?.output).toContain("src/features/billing/billing.service.ts: outside this unit's module");
		const sanctioned = await gate({ writeGlobs, sanctioned: ["src/features/billing/billing.service.ts"] });
		expect(step(sanctioned, "structure_ok")?.output).not.toContain("outside this unit's");
	});

	it("checkLayoutRules lets a sanctioned file outside the feature folder through", () => {
		const rules = normalize(NEST_LAYOUT);
		const opts = { sharedDirs: ["src/shared/"], isTestFile: (f: string) => /\.spec\.ts$/.test(f), sourceExtensions: [".ts"] };
		const f = "src/billing/billing.service.ts";
		expect(checkLayoutRules([f], "src/agency", "agency", "/nonexistent", rules, opts, {}).join("\n")).toContain("outside this unit's feature folder");
		expect(checkLayoutRules([f], "src/agency", "agency", "/nonexistent", rules, opts, { sanctioned: [f] })).toEqual([]);
	});
});

describe("gate: order and output", () => {
	it("runs the ported tests before the review model: red tests never reach the review", async () => {
		write("src/features/agency/agency.service.spec.ts", "it('x', () => {});\n");
		const testFiles = [{ path: "src/features/agency/agency.service.spec.ts", sha1: sha1("src/features/agency/agency.service.spec.ts") }];
		let reviewed = 0;
		const review = async () => (reviewed++, { ok: true, output: "fine", judged: true });
		const red = await gate({ testFiles, review, adapter: { ...adapter, test: () => ({ cmd: "false", args: [] }) } });
		expect(red.failedStep).toBe("ported_tests_green");
		expect(reviewed).toBe(0);
		const green = await gate({ testFiles, review });
		expect(green.ok).toBe(true);
		expect(reviewed).toBe(1);
		expect(green.steps.map((s) => s.name).slice(-2)).toEqual(["ported_tests_green", "wired_ok"]);
	});

	it("records only the time a step held a gate slot, not the wait for it or the review", async () => {
		write("src/features/agency/agency.service.spec.ts", "it('x', () => {});\n");
		const testFiles = [{ path: "src/features/agency/agency.service.spec.ts", sha1: sha1("src/features/agency/agency.service.spec.ts") }];
		let slots = 0;
		const slot = async <T>(fn: () => Promise<T>) => (slots++, await new Promise((r) => setTimeout(r, 300)), fn());
		const review = async () => (await new Promise((r) => setTimeout(r, 300)), { ok: true, output: "fine", judged: true });
		const r = await gate({ testFiles, review, slot });
		const tests = step(r, "ported_tests_green")!;
		expect(tests.ms).toBeGreaterThanOrEqual(290);
		expect(tests.slotMs!).toBeLessThan(tests.ms - 200);
		expect(step(r, "wired_ok")!.slotMs).toBe(0);
		expect(step(r, "antigaming_ok")!.slotMs).toBe(0);
		// build, lint and rules share one slot (one wait, outside their steps); the test run takes its own
		expect(slots).toBe(2);
		for (const n of ["build_ok", "lint_ok", "rules_ok"]) expect(step(r, n)!.slotMs).toBe(step(r, n)!.ms);
		expect(step(r, "build_ok")!.ms).toBeLessThan(200);
	});

	it("a green check_my_code on the same tree stands for build, lint and the tests; the other steps still run", async () => {
		const spec = "src/features/agency/agency.service.spec.ts";
		write(spec, "it('x', () => {});\n");
		const testFiles = [{ path: spec, sha1: sha1(spec) }];
		// every command fails: a step that ran its command is red
		const fail = (_d: string, files: string[]) => ({ cmd: "false", args: files });
		const red = { ...adapter, build: fail, lint: fail, test: fail };
		const green = { ok: true, ran: ["build", "lint", "tests"], tests: [spec], text: "TESTS green" };
		let reviewed = 0;
		const review = async () => (reviewed++, { ok: true, output: "fine", judged: true });
		const r = await gate({ testFiles, review, adapter: red, cleanCheck: reusableCheck(green, true) });
		expect(r.ok).toBe(true);
		for (const n of ["build_ok", "lint_ok", "ported_tests_green"]) expect(step(r, n)!.output).toMatch(/^from check_my_code on the same tree/);
		expect(r.steps.map((s) => s.name)).toEqual(["symbolproof_ok", "antigaming_ok", "structure_ok", "build_ok", "lint_ok", "rules_ok", "ported_tests_green", "wired_ok"]);
		expect(reviewed).toBe(1);
		// the check ran other test files: build and lint stand, the gate runs the tests itself
		const other = await gate({ testFiles, review, adapter: red, cleanCheck: reusableCheck({ ...green, tests: ["src/features/agency/other.spec.ts"] }, true) });
		expect(other.failedStep).toBe("ported_tests_green");
		// no check: the gate runs build itself
		expect((await gate({ testFiles, review, adapter: red })).failedStep).toBe("build_ok");
	});

	it("a red check, a changed tree or a skipped command is never reused", () => {
		const green = { ok: true, ran: ["build", "lint", "tests"], tests: ["a.spec.ts"], text: "TESTS green" };
		expect(reusableCheck(green, true)).toEqual({ tests: ["a.spec.ts"], text: "TESTS green" });
		expect(reusableCheck({ ...green, ok: false }, true)).toBeUndefined();
		expect(reusableCheck(green, false)).toBeUndefined();
		expect(reusableCheck({ ...green, timedOut: true }, true)).toBeUndefined();
		expect(reusableCheck({ ...green, ran: ["lint", "tests"] }, true)).toBeUndefined();
		expect(reusableCheck(undefined, true)).toBeUndefined();
	});

	it("clipOutput keeps the start and the end and collapses repeated lines", () => {
		const errs = Array.from({ length: 200 }, (_, i) => `  ${i + 10}     Class App\\Foo not found.${" ".repeat(30)}\n         🪪  class.notFound${" ".repeat(40)}\n         💡  Learn more at https://phpstan.org/user-guide/discovering-symbols`).join("\n");
		const out = `vendor/bin/phpstan analyse\n  Line   src/Foo/Service.php\n${errs}\n [ERROR] Found 200 errors\nInstructions for interpreting errors`;
		const c = clipOutput(out);
		expect(c.length).toBeLessThanOrEqual(6100);
		expect(c).toContain("vendor/bin/phpstan analyse");
		expect(c).toContain("Line   src/Foo/Service.php");
		expect(c).toContain("Found 200 errors");
		expect(c).toContain("Instructions for interpreting errors");
		expect(c).toMatch(/\d+ repeated line\(s\) left out/);
		expect(c.match(/class\.notFound/g)!.length).toBe(2);
		expect(clipOutput("short")).toBe("short");
	});
});
