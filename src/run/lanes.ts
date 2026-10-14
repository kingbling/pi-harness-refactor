import { cpus, totalmem } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gateSlots, loadConfig, saveConfig } from "../config.ts";

/**
 * `br lanes [n] [--gates m]`: show or change how many units run at once (agent lanes) and how many gates
 * (build/lint/test) run at once. A running scheduler picks the change up within seconds; shrinking lets
 * running units finish. The advice comes from measured session and gate times, not a fixed rule.
 */
export function lanes(configPath: string, set: { lanes?: number; gates?: number }): string {
	const { config, root } = loadConfig(configPath);
	const L: string[] = [];
	if (set.lanes !== undefined || set.gates !== undefined) {
		const before = { lanes: config.run.agentConcurrency, gates: gateSlots(config.run) };
		if (set.lanes !== undefined) config.run.agentConcurrency = Math.max(1, Math.floor(set.lanes));
		// new lanes without a gate number: the gate slots follow the lanes again
		if (set.gates !== undefined) config.run.gateConcurrency = Math.max(1, Math.floor(set.gates));
		else delete config.run.gateConcurrency;
		saveConfig(root, config);
		L.push(`lanes ${before.lanes} → ${config.run.agentConcurrency}, gate slots ${before.gates} → ${gateSlots(config.run)}${config.run.gateConcurrency === undefined ? " (follow the lanes)" : ""} (a running run applies it within seconds; running units always finish)`);
	} else L.push(`lanes ${config.run.agentConcurrency} · gate slots ${gateSlots(config.run)}${config.run.gateConcurrency === undefined ? " (follow the lanes)" : ""} · machine ${cpus().length} cores, ${Math.round(totalmem() / 2 ** 30)} GB`);
	const m = measure(join(root, ".bigrefactor", "ledger.sqlite"));
	if (m) {
		// one unit holds a lane for ~session seconds and a gate slot for ~gate seconds
		const gateLoad = (config.run.agentConcurrency * m.gateS) / (m.unitS * gateSlots(config.run));
		const maxByGates = Math.floor((m.unitS * gateSlots(config.run) * 0.7) / Math.max(0.1, m.gateS));
		L.push(`measured: a unit holds a lane ~${Math.round(m.unitS)} s (tester + implementer), a gate ~${m.gateS.toFixed(1)} s · gate slots ${Math.round(gateLoad * 100)}% busy at this lane count · rate-limited calls so far: ${m.rateLimited}`);
		L.push(`gates would saturate around ${maxByGates} lanes; past that, raise --gates (each gate is a build + test process: ~1 core, more memory as the project grows)`);
	}
	// other units' tests run on main one at a time for all lanes: that wait holds no slot, so the slot numbers miss it
	if (m?.mainWait) {
		const waitS = m.mainWait.ms / 1000;
		L.push(`other units' tests on main (last day): a gate waited ~${Math.round(waitS)} s for main's answer on average over ${m.mainWait.n} gate(s) (one run on main at a time; no slot is held meanwhile)`);
		if (waitS > 60) L.push("work waits on main's test runs, not on gate slots: more gates or lanes do not shorten it");
	}
	// what the running (or last) run measured on its slots: gates, check_my_code and check_ported_tests all wait there
	const s = m?.slots;
	if (s && s.grants) {
		const waitS = s.waitedMs / s.grants / 1000;
		const busy = s.heldMs / (Math.max(1, s.at - s.since) * s.limit);
		// saved every few seconds while a run goes: older than a minute, the run has ended
		const ageMin = Math.round((Date.now() - s.at) / 60_000);
		const which = Date.now() - s.at > 60_000 ? `last run (${ageMin} min ago)` : "this run";
		L.push(`gate slots ${which}: ${Math.round(busy * 100)}% busy (${s.limit} slot(s)), a wait for one ~${waitS.toFixed(1)} s on average over ${s.grants} run(s)`);
		if (waitS > 10) L.push(`work waits ~${Math.round(waitS)} s for a gate slot: raise --gates before adding lanes`);
	}
	L.push("change: br lanes <n> [--gates <m>]  ·  in Pi: /br lanes <n> [gates <m>]");
	return L.join("\n");
}

/** `24`, `24 gates 3`, `gates 3`, `24 --gates 3` → what to set (nothing = show). */
export function parseLanesArgs(args: string[]): { lanes?: number; gates?: number } {
	const gi = args.findIndex((a) => a === "gates" || a === "--gates");
	const gates = gi >= 0 && /^\d+$/.test(args[gi + 1] ?? "") ? Number(args[gi + 1]) : undefined;
	const n = args.find((a, i) => /^\d+$/.test(a) && (gi < 0 || i !== gi + 1));
	return { lanes: n !== undefined ? Number(n) : undefined, gates };
}

/** `br run 24 --limit 5` → 24: a bare number on run is the lane count (not the value of --limit/--slice/--units). */
export function runLanesArg(args: string[]): number | undefined {
	const n = args.find((a, i) => /^\d+$/.test(a) && !["--limit", "--slice", "--units"].includes(args[i - 1] ?? ""));
	return n !== undefined ? Number(n) : undefined;
}

type SlotTotals = { grants: number; waitedMs: number; heldMs: number; since: number; at: number; limit: number };

function measure(ledgerPath: string): { unitS: number; gateS: number; rateLimited: number; slots?: SlotTotals; mainWait?: { ms: number; n: number } } | undefined {
	if (!existsSync(ledgerPath) || !existsSync(dirname(ledgerPath))) return undefined;
	const db = new DatabaseSync(ledgerPath, { readOnly: true });
	try {
		const sess = db.prepare("SELECT role, AVG((julianday(ended_at)-julianday(started_at))*86400) s, COUNT(*) n FROM attempts WHERE ended_at IS NOT NULL AND role IN ('test','implement') GROUP BY role").all() as Array<{ role: string; s: number; n: number }>;
		if (!sess.length) return undefined;
		// only the time a step held a gate slot (slotMs): the review runs outside the slots, and reports from before
		// slotMs was recorded count as nothing measured (NULL), not as gate time
		const gate = db.prepare("SELECT AVG((SELECT SUM(json_extract(s.value,'$.slotMs')) FROM json_each(json_extract(gate_report,'$.steps')) s)) ms FROM attempts WHERE gate_report IS NOT NULL").get() as { ms: number | null };
		const rateLimited = (db.prepare("SELECT COUNT(*) n FROM attempts WHERE outcome LIKE '%429%' OR outcome LIKE '%rate%'").get() as { n: number }).n;
		// the run's gate pool totals (every check that took a slot, not only the gate), saved every few seconds
		const row = db.prepare("SELECT value FROM meta WHERE key = 'gate_slots'").get() as { value: string } | undefined;
		// the ported-test step's wait for main's answer (mainWaitMs), over the last day's gates that asked main
		const main = db.prepare("SELECT AVG(json_extract(s.value,'$.mainWaitMs')) ms, COUNT(*) n FROM attempts a, json_each(json_extract(a.gate_report,'$.steps')) s WHERE a.gate_report IS NOT NULL AND julianday(a.started_at) > julianday('now', '-1 day') AND json_extract(s.value,'$.mainWaitMs') IS NOT NULL").get() as { ms: number | null; n: number };
		return { unitS: sess.reduce((a, r) => a + r.s, 0), gateS: (gate.ms ?? 0) / 1000, rateLimited, slots: row ? (JSON.parse(row.value) as SlotTotals) : undefined, mainWait: main.n ? { ms: main.ms ?? 0, n: main.n } : undefined };
	} finally {
		db.close();
	}
}
