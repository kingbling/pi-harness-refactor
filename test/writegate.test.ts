import { describe, expect, it } from "vitest";
import { globToRegExp, makeWriteGate } from "../src/sessions/spawn.ts";

describe("write gate", () => {
	const gate = makeWriteGate({
		cwd: "/work/target/api",
		sourceRoot: "/work/legacy",
		writeGlobs: ["src/invoices/**", "src/shared/money.ts"],
		protectedGlobs: ["**/*.spec.ts", "package.json", "src/app.module.ts"],
	});

	it("allows writes inside the unit scope", () => {
		expect(gate("src/invoices/invoices.service.ts")).toBeUndefined();
		expect(gate("/work/target/api/src/shared/money.ts")).toBeUndefined();
	});
	it("blocks the legacy source repo unconditionally", () => {
		expect(gate("/work/legacy/src/Pricing.php")).toMatch(/read-only/);
		expect(gate("../../legacy/routes.php")).toMatch(/read-only/);
	});
	it("blocks protected and out-of-scope paths", () => {
		expect(gate("src/invoices/invoices.service.spec.ts")).toMatch(/protected/);
		expect(gate("package.json")).toMatch(/protected/);
		expect(gate("src/app.module.ts")).toMatch(/protected/);
		expect(gate("src/users/users.service.ts")).toMatch(/outside this unit/);
		expect(gate("/etc/passwd")).toMatch(/outside the working directory/);
	});
	it("glob translation", () => {
		expect(globToRegExp("**/*.spec.ts").test("a/b/c.spec.ts")).toBe(true);
		expect(globToRegExp("**/*.spec.ts").test("c.spec.ts")).toBe(true);
		expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
	});
});
