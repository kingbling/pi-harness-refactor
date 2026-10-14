import { afterEach, describe, expect, it, vi } from "vitest";
import { bashDeletesOutside, bashTouchesReadOnly, compactionReserve, sessionLimits, thinkingLevelOf } from "../src/sessions/spawn.ts";

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

describe("runaway control inside a model session (run.maxUnitTokens, run.idleMs)", () => {
	afterEach(() => vi.useRealTimers());
	const limits = (maxTokens = 250_000, idleMs = 600_000) => {
		const stops: string[] = [];
		return { stops, l: sessionLimits({ maxTokens, idleMs, onStop: (why) => stops.push(why) }) };
	};

	it("stops once when the fresh tokens go over the limit", () => {
		vi.useFakeTimers();
		const { stops, l } = limits(1000);
		l.used(900);
		expect(l.stopped()).toBeUndefined();
		l.used(1200);
		l.used(5000); // the abort takes a moment: further usage does not stop it again
		expect(stops).toEqual(["budget: the session used 1200 tokens, over run.maxUnitTokens (1000)"]);
		expect(l.stopped()).toMatch(/^budget/);
		l.end();
	});

	it("compaction starts at run.compactAt of the context window", () => {
		expect(compactionReserve(400_000, 0.65)).toBe(140_000); // compacts past 260k
		expect(compactionReserve(32_000, 0.65)).toBe(16_384); // room for the summary on a small window
	});

	it("0 is no token limit", () => {
		const { stops, l } = limits(0);
		l.used(50_000_000);
		expect(stops).toEqual([]);
		l.end();
	});

	it("stops after idleMs without activity; any session event starts the clock over", () => {
		vi.useFakeTimers();
		const { stops, l } = limits(250_000, 60_000);
		vi.advanceTimersByTime(59_000);
		l.active(); // a streamed token, a tool start or end
		vi.advanceTimersByTime(59_000);
		expect(stops).toEqual([]);
		vi.advanceTimersByTime(2_000);
		expect(stops).toEqual(["idle_timeout: no model or tool activity for 60s"]);
		l.active(); // late events after the stop do not start a new clock
		vi.advanceTimersByTime(120_000);
		expect(stops).toHaveLength(1);
	});

	it("a running tool is no idleness: a check waiting 30 min for a gate slot is not stopped", () => {
		vi.useFakeTimers();
		const { stops, l } = limits(250_000, 60_000);
		l.toolStart();
		vi.advanceTimersByTime(30 * 60_000);
		expect(stops).toEqual([]);
		l.toolEnd(); // the clock starts when the last running tool ends
		vi.advanceTimersByTime(59_000);
		expect(stops).toEqual([]);
		vi.advanceTimersByTime(2_000);
		expect(stops).toEqual(["idle_timeout: no model or tool activity for 60s"]);
		l.end();
	});

	it("a session that ended never stops later", () => {
		vi.useFakeTimers();
		const { stops, l } = limits(250_000, 1_000);
		l.end();
		vi.advanceTimersByTime(10_000);
		expect(stops).toEqual([]);
	});
});
