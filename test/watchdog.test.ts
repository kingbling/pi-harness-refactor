import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setStep, startWatchdog } from "../src/run/watchdog.ts";

const busy = (ms: number) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		/* holds the event loop, like a sync child process */
	}
};
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the freeze watchdog", () => {
	it("writes one line with the last step when the event loop was held over a second, nothing for short steps", async () => {
		const root = mkdtempSync(join(tmpdir(), "br-watchdog-"));
		const logged: string[] = [];
		const stop = startWatchdog(root, (l) => logged.push(l));
		try {
			setStep("short step");
			busy(300);
			await tick(450);
			expect(logged).toEqual([]);
			expect(existsSync(join(root, ".bigrefactor", "blocked.log"))).toBe(false);
			setStep("parity: data reset");
			busy(1500);
			await tick(450);
		} finally {
			stop();
		}
		expect(logged).toHaveLength(1);
		expect(logged[0]).toMatch(/^\d{4}-\d\d-\d\dT\S+Z Pi was blocked \d+\.\d s \(last step: parity: data reset\)(; held by: .+)?$/);
		expect(readFileSync(join(root, ".bigrefactor", "blocked.log"), "utf8")).toBe(logged[0] + "\n");
	});

	it("names the function that held the thread, not only the last step another lane set", async () => {
		const root = mkdtempSync(join(tmpdir(), "br-watchdog-"));
		const logged: string[] = [];
		const stop = startWatchdog(root, (l) => logged.push(l));
		function holdTheThreadForTheTest() {
			const until = Date.now() + 1500;
			while (Date.now() < until) { /* the named function itself holds the thread */ }
		}
		try {
			setStep("scheduling pass");
			await tick(300);
			holdTheThreadForTheTest();
			await tick(450);
		} finally {
			stop();
		}
		expect(logged).toHaveLength(1);
		expect(logged[0]).toMatch(/\(last step: scheduling pass\); held by: .*holdTheThreadForTheTest/);
	});

	it("names each freeze from its own samples, and its own profiling never shows up as a freeze", async () => {
		const root = mkdtempSync(join(tmpdir(), "br-watchdog-"));
		const logged: string[] = [];
		const stop = startWatchdog(root, (l) => logged.push(l));
		function firstFreeze() {
			const until = Date.now() + 1300;
			while (Date.now() < until) { /* distinct leaf frames, independent of helper inlining */ }
		}
		function secondFreeze() {
			const until = Date.now() + 1300;
			while (Date.now() < until) { /* distinct leaf frames, independent of helper inlining */ }
		}
		try {
			await tick(300);
			firstFreeze();
			await tick(1000);
			secondFreeze();
			await tick(1000);
		} finally {
			stop();
		}
		expect(logged).toHaveLength(2);
		expect(logged[0]).toMatch(/held by: .*firstFreeze/);
		expect(logged[0]).not.toMatch(/secondFreeze/);
		expect(logged[1]).toMatch(/held by: .*secondFreeze/);
		expect(logged[1]).not.toMatch(/firstFreeze|node:inspector/);
	});

	it("stops watching when stopped", async () => {
		const root = mkdtempSync(join(tmpdir(), "br-watchdog-"));
		const logged: string[] = [];
		startWatchdog(root, (l) => logged.push(l))();
		busy(1300);
		await tick(450);
		expect(logged).toEqual([]);
	});
});
