import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { statePath } from "../src/config.ts";
import { liveRun, waitForEarlierRun } from "../src/run/run-lock.ts";

/**
 * Pi was quit while its run still finished its gates, and started again: the new run asks the earlier one to stop
 * and waits for it, looking again every minute (here every 200 ms), instead of refusing to start.
 */
const kids: ChildProcess[] = [];
afterEach(() => {
	for (const k of kids.splice(0)) k.kill("SIGKILL");
});
// a stand-in process whose command line names it a run (run-child.ts), or another program
const start = (code: string, name = "run-child.ts") => {
	const k = spawn(process.execPath, ["-e", code, name], { stdio: "ignore" });
	kids.push(k);
	return k;
};
const holdLock = (pid: number) => {
	const root = mkdtempSync(join(tmpdir(), "br-run-wait-"));
	writeFileSync(statePath(root, "run.lock"), String(pid));
	return root;
};
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const settle = () => new Promise((r) => setTimeout(r, 300));

describe("a run started while an earlier one still holds the workspace", () => {
	it("asks the earlier run to stop and waits, looking again until it has ended, then starts", async () => {
		// the earlier run takes the stop and needs a moment to finish its gates
		const k = start("process.on('SIGTERM', () => setTimeout(() => process.exit(0), 700)); setInterval(() => {}, 1000)");
		await settle();
		const root = holdLock(k.pid!);
		const lines: string[] = [];
		expect(await waitForEarlierRun(root, { log: (l) => lines.push(l), stopped: () => false, everyMs: 200 })).toBe(true);
		expect(liveRun(root)).toBeUndefined();
		expect(lines[0]).toMatch(new RegExp(`a run is still going in this workspace \\(pid ${k.pid}\\): it was asked to stop`));
		expect(lines.at(-1)).toMatch(/has ended: this run starts/);
	});

	it("a stop while waiting ends the wait: the run does not start", async () => {
		const k = start("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)");
		await settle();
		const root = holdLock(k.pid!);
		let stop = false;
		setTimeout(() => (stop = true), 300);
		expect(await waitForEarlierRun(root, { log: () => {}, stopped: () => stop, everyMs: 200 })).toBe(false);
	});

	it("a lock whose pid is another program now is not signalled", async () => {
		const k = start("setInterval(() => {}, 1000)", "something-else.js");
		await settle();
		const root = holdLock(k.pid!);
		expect(await waitForEarlierRun(root, { log: () => {}, stopped: () => false, everyMs: 200 })).toBe(true);
		expect(alive(k.pid!)).toBe(true);
	});
});
