import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { FakeModelClient } from "../src/models/fake.ts";
import { triageGate } from "../src/run/triage.ts";
import { keptTests, textValueIn } from "../src/run/unit.ts";

/**
 * The tester's own work comes back to the tester: a skipped test it saved goes to a retest (the implementer may not edit
 * tests), only real test files are put back from the saved folder, and a value run on the old code stays in its test.
 */
describe("a skipped or .only ported test", () => {
	it("goes to the tester without asking a model; after a retest that did not help it goes the usual way", async () => {
		const root = mkdtempSync(join(tmpdir(), "br-skip-"));
		mkdirSync(join(root, ".bigrefactor"), { recursive: true });
		const config = ConfigSchema.parse({ source: { path: join(root, "legacy"), stack: "php" }, target: { path: join(root, "new"), stacks: ["react"] }, models: {} });
		const ledger = new Ledger(join(root, ".bigrefactor", "ledger.sqlite"));
		ledger.createUnit({ id: "U1", tier: "T0", symbolIds: [], meta: {} });
		const client = new FakeModelClient({ decide: () => ({ cause: "impl_bug" }) });
		const gate = { ok: false, failedStep: "antigaming_ok", steps: [{ name: "antigaming_ok", ok: false, output: "skipped, focused or incomplete test in src/features/view/View.test.tsx" }], changedFiles: [] } as never;
		const t = await triageGate({ ledger, config, client }, "U1", gate, undefined, 1);
		expect(t).toMatchObject({ action: "retest", cause: "test_bug" });
		expect(client.calls).toEqual([]);
		expect((await triageGate({ ledger, config, client }, "U1", gate, gate, 2, { progress: false })).action).not.toBe("retest");
		// mixed with a scope problem of the implementer: not the tester's alone
		const mixed = { ok: false, failedStep: "antigaming_ok", steps: [{ name: "antigaming_ok", ok: false, output: "skipped, focused or incomplete test in src/features/view/View.test.tsx\nwrite outside unit scope: src/main.tsx" }], changedFiles: [] } as never;
		expect((await triageGate({ ledger, config, client }, "U1", mixed, undefined, 1)).action).toBe("retry");
		ledger.close();
	});
});

describe("saved ported tests put back", () => {
	it("only test files inside the area's test paths; a file at the project root is not", () => {
		const globs = ["src/features/inventory/**/*.test.tsx"];
		const isTest = (f: string) => f.endsWith(".test.tsx");
		expect(keptTests(["LocationList.test.tsx", "src/features/inventory/components/LocationList.test.tsx", "src/features/inventory/notes.md"], globs, isTest)).toEqual(["src/features/inventory/components/LocationList.test.tsx"]);
	});
});

describe("a value run on the old code in its test", () => {
	it("is found as plain text; short, quoted or non-text values are not checked", () => {
		expect(textValueIn('"12.30 USD"', "expect(f.format(12.3)).toBe('12.30 USD');")).toBe(true);
		expect(textValueIn('"12.30 USD"', "expect(f.format(12.3)).toBe('12.3 USD');")).toBe(false);
		expect(textValueIn("12.3", "12.3")).toBe(false);
		expect(textValueIn('"ab"', "ab")).toBe(false);
		expect(textValueIn('"say \\"hi\\""', 'say "hi"')).toBe(false);
	});
});
