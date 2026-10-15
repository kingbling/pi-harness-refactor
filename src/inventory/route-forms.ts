import type { FileIndex } from "../adapters/types.ts";

/** Ledger meta: the app's own route classes the last inventory counted (absent: an index built before they counted). */
export const ROUTE_SUBCLASSES = "route_subclasses";

/**
 * Route forms: the framework profile names the route classes (its model read the router). The app's own
 * subclasses of them, at any depth, declare routes the same way (`new AgencySelectorRoute('url', $this, 'x')`),
 * so they are found here from the index's extends edges, never from a list in code. Returns the subclasses the
 * profile's test does not already match, as the code declares them.
 */
export function routeSubclasses(indexes: FileIndex[], isRoute: (name: string) => boolean, caseInsensitive = false): string[] {
	const key = (n: string) => {
		const bare = n.replace(/^\\/, "").split(/\\|::|\./).pop() ?? n;
		return caseInsensitive ? bare.toLowerCase() : bare;
	};
	const nameOf = new Map<string, string>();
	for (const f of indexes) for (const s of f.symbols) if (s.kind === "class") nameOf.set(s.id, s.name);
	const parents = new Map<string, { name: string; of: string[] }>();
	for (const f of indexes)
		for (const d of f.deps) {
			const child = d.kind === "extends" ? nameOf.get(d.from) : undefined;
			if (!child) continue;
			const row = parents.get(key(child)) ?? parents.set(key(child), { name: child, of: [] }).get(key(child))!;
			row.of.push(key(d.to));
		}
	const routes = new Set([...parents.entries()].flatMap(([k, r]) => [...(isRoute(r.name) ? [k] : []), ...r.of.filter((p) => isRoute(p))]));
	const out: string[] = [];
	for (let grew = true; grew; ) {
		grew = false;
		for (const [k, r] of parents)
			if (!routes.has(k) && r.of.some((p) => routes.has(p))) {
				routes.add(k);
				out.push(r.name);
				grew = true;
			}
	}
	return out.sort();
}
