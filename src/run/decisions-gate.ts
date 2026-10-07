import { statSync } from "node:fs";
import type { SourceAdapter, TargetAdapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import { openDecisions, type Decision } from "../inventory/decisions.ts";
import { planFrameworks } from "../inventory/frameworks.ts";
import type { Ledger } from "../ledger/db.ts";

/**
 * Decisions during a run: instead of refusing the whole run, each open decision blocks only the units it
 * affects; the run continues with everything else and the host asks the decisions on the side (Pi: dialogs
 * while the run goes on; CLI: `br decide` in another terminal). The scheduler re-reads the blocks every
 * loop, so answering a decision releases its units without a restart.
 *
 *   global  → changes the whole target (stack, targets, data strategy, truth env, unit grouping): refuse to start
 *   scoped  → blocks exactly the affected units (framework class → units that call it, budget → huge units, …)
 *   free    → affects no unit directly (library successor, low-use classes): asked, never blocks
 */
const GLOBAL = /^(targets|db-strategy|frontend|truth-env|target-location|cycle-cuts)$|^stack:/;

export interface DecisionGate {
	global: Decision[];
	scoped: Array<{ decision: Decision; units: string[] }>;
	free: Decision[];
	/** unit id → the decision ids blocking it */
	blocked: Map<string, string[]>;
}

export function decisionGate(ledger: Ledger, config: Config, source: SourceAdapter, targets: TargetAdapter[], root: string): DecisionGate {
	const open = openDecisions(ledger, config, source, targets, root);
	const gate: DecisionGate = { global: [], scoped: [], free: [], blocked: new Map() };
	if (!open.length) return gate;
	const plan = open.some((d) => d.id.startsWith("fw:")) ? planFrameworks(ledger, source, targets, config.source.path) : undefined;
	const unitsCalling = (path: string, cls: string): string[] =>
		(
			ledger.db
				.prepare(
					`SELECT DISTINCT s.unit_id u FROM index_deps d
					 JOIN symbols s ON s.path = substr(d.from_id, 1, instr(d.from_id, '::') - 1)
					 WHERE (d.to_id = ? OR d.to_id LIKE ?) AND s.unit_id IS NOT NULL`,
				)
				.all(`${path}::${cls}`, `${path}::${cls}::%`) as Array<{ u: string }>
		).map((r) => r.u);
	const unitsWhere = (sql: string): string[] => (ledger.db.prepare(`SELECT id FROM units WHERE state = 'planned' AND ${sql}`).all() as Array<{ id: string }>).map((r) => r.id);

	for (const d of open) {
		if (GLOBAL.test(d.id)) {
			gate.global.push(d);
			continue;
		}
		let units: string[] = [];
		const [kind, key] = [d.id.split(":")[0], d.id.split(":").slice(1).join(":")];
		if (kind === "fw" && key !== "rest") {
			const cls = plan?.unmapped.find((u) => u.name === key);
			if (cls) units = unitsCalling(cls.path, cls.name);
		} else if (kind === "store") units = unitsWhere("COALESCE(json_extract(meta,'$.route.needs_db'), 0) >= 0.5");
		else if (d.id === "budget") units = unitsWhere("json_extract(meta,'$.loc') > 3000");
		else if (d.id === "dynamic-slice") units = unitsWhere("json_extract(meta,'$.slice') = 'dynamic'");
		if (units.length) {
			gate.scoped.push({ decision: d, units });
			for (const u of units) (gate.blocked.get(u) ?? gate.blocked.set(u, []).get(u)!).push(d.id);
		} else gate.free.push(d);
	}
	return gate;
}

export function renderGate(g: DecisionGate): string[] {
	const L: string[] = [];
	if (g.global.length) L.push(`${g.global.length} decision(s) change the whole target and must be answered before a run: ${g.global.map((d) => d.id).join(", ")}`);
	for (const s of g.scoped) L.push(`· ${s.decision.id} blocks ${s.units.length} unit(s) until answered`);
	if (g.free.length) L.push(`· ${g.free.length} more decision(s) block nothing (${g.free.slice(0, 5).map((d) => d.id).join(", ")}${g.free.length > 5 ? ", …" : ""})`);
	return L;
}

/**
 * Live blocks for the scheduler: recomputed only when decisions.json changes (an answer landed), so the
 * per-loop cost is one stat call. Returns the hook `runScheduler({ blocked })` expects.
 */
export function liveBlocks(ledger: Ledger, config: Config, source: SourceAdapter, targets: TargetAdapter[], root: string, onChange?: (g: DecisionGate) => void): () => Map<string, string[]> {

	const file = `${root}/.bigrefactor/decisions.json`;
	let seen = -1;
	let current = new Map<string, string[]>();
	return () => {
		let m = 0;
		try {
			m = statSync(file).mtimeMs;
		} catch {
			/* no decisions file yet */
		}
		if (m !== seen) {
			seen = m;
			const g = decisionGate(ledger, config, source, targets, root);
			current = g.blocked;
			onChange?.(g);
		}
		return current;
	};
}
