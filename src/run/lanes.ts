import { cpus, totalmem } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, saveConfig } from "../config.ts";

/**
 * `br lanes [n] [--gates m]`: show or change how many units run at once (agent lanes) and how many gates
 * (build/lint/test) run at once. A running scheduler picks the change up within seconds; shrinking lets
 * running units finish. The advice comes from measured session and gate times, not a fixed rule.
 */
export function lanes(configPath: string, set: { lanes?: number; gates?: number }): string {
	const { config, root } = loadConfig(configPath);
	const L: string[] = [];
	if (set.lanes !== undefined || set.gates !== undefined) {
		const before = { lanes: config.run.agentConcurrency, gates: config.run.gateConcurrency };
		if (set.lanes !== undefined) config.run.agentConcurrency = Math.max(1, Math.floor(set.lanes));
		if (set.gates !== undefined) config.run.gateConcurrency = Math.max(1, Math.floor(set.gates));
		saveConfig(root, config);
		L.push(`lanes ${before.lanes} → ${config.run.agentConcurrency}, gate slots ${before.gates} → ${config.run.gateConcurrency} (a running run applies it within seconds; running units always finish)`);
	} else L.push(`lanes ${config.run.agentConcurrency} · gate slots ${config.run.gateConcurrency} · machine ${cpus().length} cores, ${Math.round(totalmem() / 2 ** 30)} GB`);
	const m = measure(join(root, ".bigrefactor", "ledger.sqlite"));
	if (m) {
		// one unit holds a lane for ~session seconds and a gate slot for ~gate seconds
		const gateLoad = (config.run.agentConcurrency * m.gateS) / (m.unitS * config.run.gateConcurrency);
		const maxByGates = Math.floor((m.unitS * config.run.gateConcurrency * 0.7) / Math.max(0.1, m.gateS));
		L.push(`measured: a unit holds a lane ~${Math.round(m.unitS)} s (tester + implementer), a gate ~${m.gateS.toFixed(1)} s · gate slots ${Math.round(gateLoad * 100)}% busy at this lane count · rate-limited calls so far: ${m.rateLimited}`);
		L.push(`gates would saturate around ${maxByGates} lanes; past that, raise --gates (each gate is a tsc + test process: ~1 core, more memory as the project grows)`);
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

function measure(ledgerPath: string): { unitS: number; gateS: number; rateLimited: number } | undefined {
	if (!existsSync(ledgerPath) || !existsSync(dirname(ledgerPath))) return undefined;
	const db = new DatabaseSync(ledgerPath, { readOnly: true });
	try {
		const sess = db.prepare("SELECT role, AVG((julianday(ended_at)-julianday(started_at))*86400) s, COUNT(*) n FROM attempts WHERE ended_at IS NOT NULL AND role IN ('test','implement') GROUP BY role").all() as Array<{ role: string; s: number; n: number }>;
		if (!sess.length) return undefined;
		const gate = db.prepare("SELECT AVG((SELECT SUM(json_extract(s.value,'$.ms')) FROM json_each(json_extract(gate_report,'$.steps')) s)) ms FROM attempts WHERE gate_report IS NOT NULL").get() as { ms: number | null };
		const rateLimited = (db.prepare("SELECT COUNT(*) n FROM attempts WHERE outcome LIKE '%429%' OR outcome LIKE '%rate%'").get() as { n: number }).n;
		return { unitS: sess.reduce((a, r) => a + r.s, 0), gateS: (gate.ms ?? 0) / 1000, rateLimited };
	} finally {
		db.close();
	}
}
