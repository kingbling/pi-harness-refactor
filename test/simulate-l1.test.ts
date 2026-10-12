import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { simulateL1 } from "../src/run/simulate.ts";

/**
 * `br simulate --level 1` as a test, so it cannot rot unseen: the real scheduler with scripted sessions and gates on
 * the fixture (stop, resize, truth ahead, triage branches, post-merge slip, resolver wait, crash count, sample).
 * The truth scripts run on the old code, so it needs php.
 */
const hasPhp = (() => {
	try {
		execFileSync("php", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

describe("simulation L1", () => {
	it.skipIf(!hasPhp)("runs green", async () => {
		const r = await simulateL1({ dir: join(resolve(import.meta.dirname, ".."), ".sim", "l1-test"), quiet: true });
		expect(r.problems).toEqual([]);
	}, 120_000);
});
