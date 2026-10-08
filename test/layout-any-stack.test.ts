import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { checkLayoutRules, checkLayoutTree, normalize, saveLayoutRules, validateLayoutRules } from "../src/rules/layout-rules.ts";
import { validateRulesLayout } from "../src/rules/layout.ts";
import { saveRulesVersion } from "../src/rules/living.ts";

/** The layout checks work for stacks that are not TypeScript: snake_case file names, tool folders, roots other than src/. */
function project(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "br-las-"));
	for (const [p, t] of Object.entries(files)) (mkdirSync(dirname(join(dir, p)), { recursive: true }), writeFileSync(join(dir, p), t));
	return dir;
}
const py = normalize({ moduleDir: "app/{area_snake}", files: [{ path: "{name_snake}.py", doc: "a module" }, { path: "migrations/{name_snake}.py", doc: "a migration" }], forbidDirs: ["utils"] });
const opts = { sharedDirs: ["app/shared/"], isTestFile: (f: string) => /(^|\/)test_[^/]*\.py$/.test(f), sourceExtensions: [".py"], ignoreDirs: ["__pycache__"] };

describe("layout rules on a Python target", () => {
	it("{name_snake} lets the layout allow snake_case file names; kebab names still fail", () => {
		expect(validateLayoutRules(py)).toEqual([]);
		const check = (f: string) => checkLayoutRules([f], "app/billing", "billing", "/nonexistent", py, opts);
		expect(check("app/billing/invoice_service.py")).toEqual([]);
		expect(check("app/billing/migrations/0001_initial.py")).toEqual([]);
		expect(check("app/billing/invoice-service.py")).not.toEqual([]);
	});
	it("folders the stack's tools make (layout.ignoreDirs) are no drift", () => {
		const dir = project({ "app/billing/invoice_service.py": "x = 1\n", "app/billing/__pycache__/invoice_service.cpython-312.pyc": "", "app/__pycache__/x.pyc": "" });
		expect(checkLayoutTree(dir, py, opts)).toEqual([]);
		expect(checkLayoutTree(dir, py, { ...opts, ignoreDirs: [] }).length).toBeGreaterThan(0);
	});
});

describe("RULES.md competing module roots outside src/", () => {
	const prev = process.env["BR_WORKSPACE"];
	afterEach(() => {
		if (prev === undefined) delete process.env["BR_WORKSPACE"];
		else process.env["BR_WORKSPACE"] = prev;
	});
	it("a path under the adapter's own top folder but outside its module root is reported", async () => {
		const root = mkdtempSync(join(tmpdir(), "br-las-ws-"));
		mkdirSync(join(root, "legacy"));
		process.env["BR_WORKSPACE"] = root;
		saveLayoutRules(root, "nestjs", normalize({ moduleDir: "internal/features/{area}", files: [{ path: "{name}.ts", doc: "code" }], forbidDirs: [] }));
		const config = ConfigSchema.parse({ version: 1, source: { path: join(root, "legacy"), stack: "php" }, target: { path: join(root, "new"), stacks: ["nestjs"] }, models: {} });
		const ledger = new Ledger(":memory:");
		await saveRulesVersion({ ledger, root }, "nestjs", "Put billing code in `internal/billing/handlers/` and features in `internal/features/billing/`.", { version: 1 });
		const problems = await validateRulesLayout(root, config);
		expect(problems.some((p) => p.includes("module root internal/billing/"))).toBe(true);
		expect(problems.some((p) => p.includes("module root internal/features/"))).toBe(false);
	});
});
