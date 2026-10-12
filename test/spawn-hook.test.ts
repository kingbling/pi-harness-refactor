import { describe, expect, it } from "vitest";
import { bashDeletesOutside, bashTouchesReadOnly, thinkingLevelOf } from "../src/sessions/spawn.ts";

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
		// package-manager writes come from the source language (adapter), not a core list
		expect(bashTouchesReadOnly("cd /work/legacy && composer update", src, cwd)).toBeUndefined();
		expect(bashTouchesReadOnly("cd /work/legacy && composer update", src, cwd, /\bcomposer\s+update\b/)).toMatch(/read-only/);
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

describe("bash deletes stay inside the session's folder", () => {
	const cwd = "/work/.bigrefactor/worktrees/u7/app";
	it("refuses deletes and moves that reach other lanes, the ledger or home", () => {
		expect(bashDeletesOutside("rm -rf ../../*", cwd)).toMatch(/inside your working directory/);
		expect(bashDeletesOutside("cd /x && rm ../../../ledger.sqlite", cwd)).toMatch(/inside/);
		expect(bashDeletesOutside("rm -rf ~/.cache/*", cwd)).toMatch(/inside/);
		expect(bashDeletesOutside("rm -rf $HOME", cwd)).toMatch(/inside/);
		expect(bashDeletesOutside("rm -rf /", cwd)).toMatch(/inside/);
		expect(bashDeletesOutside("rm -rf /tmp", cwd)).toMatch(/inside/);
		expect(bashDeletesOutside("mv src ../other", cwd)).toMatch(/inside/);
		expect(bashDeletesOutside("find .. -name '*.js' -delete", cwd)).toMatch(/inside/);
		expect(bashDeletesOutside("rm -rf $DIR/x", cwd)).toMatch(/inside/);
	});
	it("allows deletes inside the folder, in temp, and where the session may write", () => {
		expect(bashDeletesOutside("rm -rf ./build dist/x.js", cwd)).toBeUndefined();
		expect(bashDeletesOutside("rm /tmp/x && rm -f node_modules/.cache/a", cwd)).toBeUndefined();
		expect(bashDeletesOutside("find . -name '*.tmp' -delete", cwd)).toBeUndefined();
		expect(bashDeletesOutside("rm /work/.bigrefactor/truth/u7/cases.php", cwd, (abs) => abs.startsWith("/work/.bigrefactor/truth/u7/"))).toBeUndefined();
		expect(bashDeletesOutside("ls ../../ && cat ../x", cwd)).toBeUndefined();
	});
});
