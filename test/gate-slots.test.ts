import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema, gateSlots, loadConfig } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { lanes } from "../src/run/lanes.ts";
import { Semaphore } from "../src/run/pool.ts";

/**
 * The gate pool counts how long work waited for a slot and held one; `br lanes` reads the run's totals and asks for
 * more gate slots, not more lanes, when work waits long for one.
 */
describe("gate slots", () => {
	it("the pool adds up wait and hold time per slot", async () => {
		const pool = new Semaphore(1);
		const hold = () => pool.run(() => new Promise((r) => setTimeout(r, 100)));
		await Promise.all([hold(), hold()]);
		expect(pool.totals.grants).toBe(2);
		expect(pool.totals.heldMs).toBeGreaterThanOrEqual(190);
		// the second one waited for the first
		expect(pool.totals.waitedMs).toBeGreaterThanOrEqual(90);
	});

	it("br lanes shows the run's slot totals and says to raise the gate slots when work waits long", () => {
		const dir = mkdtempSync(join(tmpdir(), "br-slots-"));
		try {
			const f = join(dir, "bigrefactor.config.json");
			writeFileSync(f, JSON.stringify(ConfigSchema.parse({ source: { path: dir, stack: "php" }, target: { path: dir, stacks: ["nestjs"] }, models: {} })));
			mkdirSync(join(dir, ".bigrefactor"), { recursive: true });
			const ledger = new Ledger(join(dir, ".bigrefactor", "ledger.sqlite"));
			ledger.db.prepare("INSERT INTO attempts(role, started_at, ended_at) VALUES ('implement', datetime('now', '-60 seconds'), datetime('now'))").run();
			const since = Date.now() - 3_600_000;
			ledger.setMeta("gate_slots", JSON.stringify({ grants: 100, waitedMs: 100 * 40_000, heldMs: 3_600_000, since, at: since + 3_600_000, limit: 2 }));
			ledger.close();
			const out = lanes(f, {});
			expect(out).toMatch(/gate slots this run: 50% busy \(2 slot\(s\)\), a wait for one ~40\.0 s on average over 100 run\(s\)/);
			expect(out).toMatch(/raise --gates before adding lanes/);
			// totals saved long ago: the run has ended, so they are the last run's
			const old = new Ledger(join(dir, ".bigrefactor", "ledger.sqlite"));
			old.setMeta("gate_slots", JSON.stringify({ grants: 100, waitedMs: 100 * 40_000, heldMs: 3_600_000, since: since - 600_000, at: since + 3_000_000, limit: 2 }));
			old.close();
			expect(lanes(f, {})).toMatch(/gate slots last run \(10 min ago\): 50% busy/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("br lanes shows how long gates waited for main's answer on other units' tests, which no slot measures", () => {
		const dir = mkdtempSync(join(tmpdir(), "br-mainwait-"));
		try {
			const f = join(dir, "bigrefactor.config.json");
			writeFileSync(f, JSON.stringify(ConfigSchema.parse({ source: { path: dir, stack: "php" }, target: { path: dir, stacks: ["nestjs"] }, models: {} })));
			mkdirSync(join(dir, ".bigrefactor"), { recursive: true });
			const ledger = new Ledger(join(dir, ".bigrefactor", "ledger.sqlite"));
			ledger.db.prepare("INSERT INTO attempts(role, started_at, ended_at) VALUES ('implement', datetime('now', '-60 seconds'), datetime('now'))").run();
			const report = (mainWaitMs?: number) => JSON.stringify({ ok: false, steps: [{ name: "build_ok", ok: true, ms: 3000, slotMs: 3000, output: "" }, { name: "ported_tests_green", ok: false, ms: 900_000, slotMs: 30_000, ...(mainWaitMs ? { mainWaitMs } : {}), output: "" }] });
			const add = ledger.db.prepare("INSERT INTO attempts(role, started_at, ended_at, gate_report) VALUES ('implement', ?, ?, ?)");
			const now = new Date().toISOString();
			add.run(now, now, report(800_000));
			add.run(now, now, report(600_000));
			add.run(now, now, report()); // main not asked
			add.run("2020-01-01T00:00:00.000Z", "2020-01-01T00:01:00.000Z", report(5_000)); // long ago
			ledger.close();
			const out = lanes(f, {});
			expect(out).toMatch(/other units' tests on main \(last day\): a gate waited ~700 s for main's answer on average over 2 gate\(s\)/);
			expect(out).toMatch(/work waits on main's test runs, not on gate slots/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("gate slots follow the lanes unless the owner picks a number; new lanes alone hand them back to the lanes", () => {
		const run = (lanes: number, gates?: number) => ConfigSchema.parse({ source: { path: "/x", stack: "php" }, target: { path: "/x", stacks: ["nestjs"] }, models: {}, run: { agentConcurrency: lanes, gateConcurrency: gates } }).run;
		expect(gateSlots(run(20), 12)).toBe(4);
		expect(gateSlots(run(8), 12)).toBe(2);
		expect(gateSlots(run(40), 12)).toBe(4);
		expect(gateSlots(run(20, 3), 12)).toBe(3);
		const dir = mkdtempSync(join(tmpdir(), "br-follow-"));
		try {
			const f = join(dir, "bigrefactor.config.json");
			// a config saved before: every default written out, gate slots stuck at 2
			writeFileSync(f, JSON.stringify(ConfigSchema.parse({ source: { path: dir, stack: "php" }, target: { path: dir, stacks: ["nestjs"] }, models: {}, run: { agentConcurrency: 20, gateConcurrency: 2 } })));
			lanes(f, { lanes: 20 });
			expect(JSON.parse(readFileSync(f, "utf8")).run.gateConcurrency).toBeUndefined();
			expect(gateSlots(loadConfig(f).config.run, 12)).toBe(4);
			lanes(f, { gates: 3 });
			expect(loadConfig(f).config.run.gateConcurrency).toBe(3);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
