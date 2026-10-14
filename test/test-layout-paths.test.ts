import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { nestjsAdapter } from "../src/adapters/target/nestjs.ts";
import { ConfigSchema } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { FakeModelClient } from "../src/models/fake.ts";
import { importedByTests } from "../src/run/gate.ts";
import { triageGate } from "../src/run/triage.ts";
import { checkLayoutRules, normalize } from "../src/rules/layout-rules.ts";
import { checkPortedTestsTool, portedLayout } from "../src/sessions/tools.ts";

/**
 * Tests that contradict the layout: the tester checks its test paths and the code paths its tests import against the
 * stack layout before it is done, and a structure_ok finding on a path a test imports goes back to the tester.
 */
const write = (p: string, s = "x\n") => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, s));
const rules = normalize({ moduleDir: "src/features/{area}", files: [{ path: "pages/{Area}{Name}Page.tsx", doc: "page" }], require: [], forbidDirs: ["utils"] });
const opts = { sharedDirs: ["src/shared/"], isTestFile: (f: string) => f.endsWith(".test.tsx") };
const MOD = "src/features/offers";
const check = (dir: string) => (files: string[]) => checkLayoutRules(files, MOD, "offers", dir, rules, opts, { isNew: () => true });

describe("the tester checks its paths with the layout", () => {
	it("a test importing a page path the layout does not allow fails; the allowed name passes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "br-tl-"));
		const test = `${MOD}/pages/OfferEditPage.test.tsx`;
		expect(await portedLayout(check(dir), [test], [`./${MOD}/pages/OfferEditPage.tsx`])).toEqual([expect.stringMatching(/^src\/features\/offers\/pages\/OfferEditPage\.tsx: not an allowed file/)]);
		expect(await portedLayout(check(dir), [test], [`${MOD}/pages/OffersEditPage.tsx`])).toEqual([]);
	});

	it("check_ported_tests reports the layout of new imported code files, not of existing ones", async () => {
		const ws = mkdtempSync(join(tmpdir(), "br-tl-"));
		const target = join(ws, "migrated");
		write(join(target, `${MOD}/pages/OfferEditPage.test.tsx`), "import { OfferEditPage } from './OfferEditPage';\nit('u1#1 edits', () => {});\n");
		write(join(target, `${MOD}/pages/OfferListPage.tsx`)); // already there (accepted): not the tester's to check
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: target, stacks: ["nestjs"] }, models: {} });
		const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
		ledger.createUnit({ id: "u1", tier: "T1", deps: [], meta: {}, symbolIds: [] });
		const adapter = { ...nestjsAdapter, layout: { ...nestjsAdapter.layout, testFileGlobs: (m: string) => [`${m}/**/*.test.tsx`] }, lint: () => ({ cmd: "true", args: [] }), build: () => ({ cmd: "true", args: [] }) } as never;
		const tool = checkPortedTestsTool({ ledger, config, unitId: "u1", root: ws, targetProjectDir: target, adapter, moduleDir: MOD, currentTruth: () => ({ ok: true, cases: [{ symbol: "s", inputs: [], expected: 1 }] }), checkLayout: check(target) });
		const r = await (tool as unknown as { execute: (i: string, p: object) => Promise<{ content: Array<{ text: string }>; details: { layout: string[] } }> }).execute("x", { code_files: [`${MOD}/pages/OfferEditPage.tsx`, `${MOD}/pages/OfferListPage.tsx`] });
		expect(r.content[0]!.text).toMatch(/LAYOUT FAILED/);
		expect(r.details.layout).toEqual([expect.stringMatching(/^src\/features\/offers\/pages\/OfferEditPage\.tsx:/)]);
		ledger.close();
	});
});

describe("a layout finding on a path a test imports goes to the tester", () => {
	it("the gate names the failing paths a test imports (relative or alias import), not the others", () => {
		const dir = mkdtempSync(join(tmpdir(), "br-tl-"));
		write(join(dir, `${MOD}/pages/OfferEditPage.test.tsx`), "import { OfferEditPage } from './OfferEditPage';\n");
		write(join(dir, `${MOD}/offers.test.tsx`), 'import { x } from "@/features/offers/pages/OfferShowPage";\n');
		const findings = [`${MOD}/pages/OfferEditPage.tsx: not an allowed file`, `${MOD}/pages/OfferShowPage.tsx: not an allowed file`, `${MOD}/pages/OfferOther.tsx: not an allowed file`];
		expect(importedByTests(dir, [`${MOD}/pages/OfferEditPage.test.tsx`, `${MOD}/offers.test.tsx`], findings)).toEqual([`${MOD}/pages/OfferEditPage.tsx`, `${MOD}/pages/OfferShowPage.tsx`]);
	});

	it("triage retests without asking a model; after a retest that did not help it goes the usual way", async () => {
		const root = mkdtempSync(join(tmpdir(), "br-tl-"));
		mkdirSync(join(root, ".bigrefactor"), { recursive: true });
		const config = ConfigSchema.parse({ source: { path: join(root, "legacy"), stack: "php" }, target: { path: join(root, "new"), stacks: ["nestjs"] }, models: {} });
		const ledger = new Ledger(join(root, ".bigrefactor", "ledger.sqlite"));
		ledger.createUnit({ id: "U1", tier: "T0", symbolIds: [], meta: {} });
		const client = new FakeModelClient({ decide: () => ({ cause: "impl_bug" }) });
		const out = `${MOD}/pages/OfferEditPage.tsx: not an allowed file`;
		const gate = { ok: false, failedStep: "structure_ok", steps: [{ name: "structure_ok", ok: false, output: out }], changedFiles: [`${MOD}/pages/OfferEditPage.tsx`], testFiles: [`${MOD}/pages/OfferEditPage.test.tsx`], testImported: [`${MOD}/pages/OfferEditPage.tsx`] } as never;
		const t = await triageGate({ ledger, config, client }, "U1", gate, undefined, 1);
		expect(t.action).toBe("retest");
		expect(client.calls).toEqual([]);
		const after = await triageGate({ ledger, config, client }, "U1", gate, gate, 2, { progress: false });
		expect(after.action).not.toBe("retest");
		expect(client.calls.length).toBeGreaterThan(0);
		ledger.close();
	});
});
