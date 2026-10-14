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
		expect(logged[0]).toMatch(/^\d{4}-\d\d-\d\dT\S+Z Pi was blocked \d+\.\d s \(last step: parity: data reset\)$/);
		expect(readFileSync(join(root, ".bigrefactor", "blocked.log"), "utf8")).toBe(logged[0] + "\n");
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
