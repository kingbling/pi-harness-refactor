import type { Ledger } from "../ledger/db.ts";
import type { Step } from "./parity-check.ts";

/**
 * A slice is compared before it is finished: the steps of routes whose handler's unit is accepted are compared,
 * the rest wait for their unit. As more units land the run compares the slice again (a route owner's accept, or a
 * newer main at run start).
 */

/** The slice's routes whose handler's unit is not accepted yet ("ANY dashboard/ajax" → the unit). */
export function waitingRoutes(ledger: Ledger, slice: string): Map<string, string> {
	const units = ledger.db.prepare("SELECT id, state, meta FROM units WHERE json_extract(meta, '$.slice') = ?").all(slice) as Array<{ id: string; state: string; meta: string }>;
	const ownerOf = new Map<string, { id: string; state: string }>();
	for (const u of units) for (const f of (JSON.parse(u.meta) as { files?: string[] }).files ?? []) ownerOf.set(f, u);
	const rows = ledger.db.prepare("SELECT method, path, handler_symbol FROM index_routes WHERE side = 'source' AND handler_symbol IS NOT NULL").all() as Array<{ method: string | null; path: string; handler_symbol: string }>;
	const out = new Map<string, string>();
	for (const r of rows) {
		const u = ownerOf.get(r.handler_symbol.split("::")[0]!);
		if (u && u.state !== "accepted") out.set(routeKey(`${r.method ?? "ANY"} ${r.path}`), u.id);
	}
	return out;
}

/** A route with or without its method word and leading slash ("ANY dashboard/ajax" = "dashboard/ajax"), as stepsProblem counts it. */
const routeKey = (r: unknown) => String(r ?? "").trim().replace(/^[A-Z]+(?:\|[A-Z]+)*\s+/, "").replace(/^\/+/, "");

/** The routes not waiting for their unit: the ones the step writer covers and stepsProblem checks. */
export const readyRoutes = (routes: string[], waiting: Map<string, string>) => routes.filter((r) => !waiting.has(routeKey(r)));

/**
 * Steps of waiting routes are still sent (a later step may need what they save) but not compared. A step that uses a
 * "{{value}}" last saved by a held step waits too: the new app's unfinished route does not give it. `held` says
 * which, for the run's note.
 */
export function holdBack(steps: Step[], waiting: Map<string, string>): { steps: Step[]; held: string[] } {
	const held: string[] = [];
	const heldVar = new Map<string, string>(); // a saved value → the unit it waits for, while a held step saved it last
	const out = steps.map((s) => {
		const unit = waiting.get(routeKey(s.route)) ?? [...JSON.stringify(s).matchAll(/\{\{(\w+)\}\}/g)].map((m) => heldVar.get(m[1]!)).find(Boolean);
		for (const n of Object.keys(s.save ?? {})) unit ? heldVar.set(n, unit) : heldVar.delete(n);
		if (!unit) return s;
		if (s.compare !== "none") held.push(`${s.id} (${unit})`);
		return { ...s, compare: "none" as const };
	});
	return { steps: out, held };
}
