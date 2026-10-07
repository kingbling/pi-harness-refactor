import { describe, expect, it } from "vitest";
import { bashTouchesReadOnly, thinkingLevelOf } from "../src/sessions/spawn.ts";

/**
 * The inline tool_call guard is what keeps the source repo read-only for roles that have bash.
 * These are the pure pieces of it; the write gate itself is covered in writegate.test.ts.
 */
describe("bash guard (roles with bash: tester, setup)", () => {
	const src = "/work/legacy";
	const cwd = "/work/target";
	it("allows running the old code", () => {
		expect(bashTouchesReadOnly("cd /work/legacy && php cases.php", src, cwd)).toBeUndefined();
		expect(bashTouchesReadOnly("php /work/legacy/vendor/bin/phpunit tests/", src, cwd)).toBeUndefined();
		expect(bashTouchesReadOnly("grep -rn 'invoice' /work/legacy/src", src, cwd)).toBeUndefined();
	});
	it("blocks writes, deletes, redirects and git into the source repo", () => {
		expect(bashTouchesReadOnly("rm -rf /work/legacy/cache", src, cwd)).toMatch(/read-only/);
		expect(bashTouchesReadOnly("sed -i 's/a/b/' /work/legacy/src/Config.php", src, cwd)).toMatch(/read-only/);
		expect(bashTouchesReadOnly("php gen.php > /work/legacy/out.json", src, cwd)).toMatch(/read-only/);
		expect(bashTouchesReadOnly("cd /work/legacy && git checkout -- .", src, cwd)).toMatch(/read-only|git/);
	});
	it("blocks git mutations anywhere (the orchestrator commits)", () => {
		expect(bashTouchesReadOnly("git commit -am wip", src, cwd)).toMatch(/git/);
		expect(bashTouchesReadOnly("git status", src, cwd)).toBeUndefined();
	});
	it("writes outside the source repo are the write gate's business, not bash's", () => {
		expect(bashTouchesReadOnly("echo x > /work/target/tmp.txt", src, cwd)).toBeUndefined();
	});
});

describe("reasoning effort → Pi thinking level (single knob)", () => {
	it("maps config effort to thinkingLevel", () => {
		expect(thinkingLevelOf(undefined)).toBe("medium");
		expect(thinkingLevelOf("low")).toBe("low");
		expect(thinkingLevelOf("high")).toBe("high");
		expect(thinkingLevelOf("max")).toBe("xhigh");
		expect(thinkingLevelOf("none")).toBe("off");
	});
});
