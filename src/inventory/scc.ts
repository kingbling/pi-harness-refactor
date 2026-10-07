/**
 * Tarjan SCC + condensation + topological order. Legacy dependency graphs are cyclic; units are
 * built from condensed components so "leaves first" is well defined. Pure code, no model calls.
 */
export interface Graph {
	nodes: string[];
	edges: Map<string, Set<string>>; // from -> to
}

export function buildGraph(nodes: Iterable<string>, edges: Iterable<[string, string]>): Graph {
	const set = new Set(nodes);
	const map = new Map<string, Set<string>>();
	for (const n of set) map.set(n, new Set());
	for (const [a, b] of edges) {
		if (!set.has(a) || !set.has(b) || a === b) continue;
		map.get(a)!.add(b);
	}
	return { nodes: [...set], edges: map };
}

export function tarjanScc(g: Graph): string[][] {
	let index = 0;
	const stack: string[] = [];
	const onStack = new Set<string>();
	const idx = new Map<string, number>();
	const low = new Map<string, number>();
	const out: string[][] = [];

	const strong = (v: string) => {
		idx.set(v, index);
		low.set(v, index);
		index++;
		stack.push(v);
		onStack.add(v);
		for (const w of g.edges.get(v) ?? []) {
			if (!idx.has(w)) {
				strong(w);
				low.set(v, Math.min(low.get(v)!, low.get(w)!));
			} else if (onStack.has(w)) {
				low.set(v, Math.min(low.get(v)!, idx.get(w)!));
			}
		}
		if (low.get(v) === idx.get(v)) {
			const comp: string[] = [];
			let w: string;
			do {
				w = stack.pop()!;
				onStack.delete(w);
				comp.push(w);
			} while (w !== v);
			out.push(comp.sort());
		}
	};
	for (const v of g.nodes) if (!idx.has(v)) strong(v);
	return out;
}

export interface Condensed {
	components: string[][];
	compOf: Map<string, number>;
	/** component -> components it depends on */
	deps: Map<number, Set<number>>;
	/** Leaves first: a component appears after everything it depends on. */
	order: number[];
}

export function condense(g: Graph): Condensed {
	const components = tarjanScc(g);
	const compOf = new Map<string, number>();
	components.forEach((c, i) => c.forEach((n) => compOf.set(n, i)));
	const deps = new Map<number, Set<number>>();
	components.forEach((_, i) => deps.set(i, new Set()));
	for (const [from, tos] of g.edges) {
		const a = compOf.get(from)!;
		for (const to of tos) {
			const b = compOf.get(to)!;
			if (a !== b) deps.get(a)!.add(b);
		}
	}
	// Kahn over the DAG; dependencies (leaves) first.
	const indeg = new Map<number, number>();
	components.forEach((_, i) => indeg.set(i, 0));
	for (const [, ds] of deps) for (const d of ds) indeg.set(d, indeg.get(d)!); // placeholder keeps keys
	const dependents = new Map<number, Set<number>>();
	components.forEach((_, i) => dependents.set(i, new Set()));
	for (const [a, ds] of deps) for (const d of ds) dependents.get(d)!.add(a);
	for (const [a, ds] of deps) indeg.set(a, ds.size);
	const ready = [...indeg.entries()].filter(([, n]) => n === 0).map(([i]) => i).sort((x, y) => x - y);
	const order: number[] = [];
	while (ready.length) {
		const c = ready.shift()!;
		order.push(c);
		for (const dep of [...dependents.get(c)!].sort((x, y) => x - y)) {
			indeg.set(dep, indeg.get(dep)! - 1);
			if (indeg.get(dep) === 0) ready.push(dep);
		}
	}
	return { components, compOf, deps, order };
}

/**
 * Cut oversized cycles so units stay agent-sized. Within each SCC larger than `maxFiles`, nodes are
 * ordered by the Eades–Lin–Smyth heuristic (sinks last, sources first, then by out−in degree) and every
 * back edge is removed. The removed edges are returned so the units can carry them as `cutDeps`:
 * "you reference X, which is scheduled after you — code against its interface / a forward reference".
 * Deterministic: same graph → same cuts. Pure code.
 */
export function cutLargeCycles(g: Graph, maxFiles: number, weight: (n: string) => number = () => 1, groupOf: (n: string) => string | undefined = () => undefined): { graph: Graph; cut: Array<[string, string]> } {
	const cut: Array<[string, string]> = [];
	const edges = new Map<string, Set<string>>();
	for (const [a, s] of g.edges) edges.set(a, new Set(s));
	for (const comp of tarjanScc(g)) {
		if (comp.length <= maxFiles) continue;
		const inComp = new Set(comp);
		// natural groups (model+facade…) are contracted to one node so they are never cut apart and never re-form a cycle
		const gid = (n: string) => groupOf(n) ?? n;
		const members = new Map<string, string[]>();
		for (const n of comp) (members.get(gid(n)) ?? members.set(gid(n), []).get(gid(n))!).push(n);
		const gnodes = [...members.keys()].sort();
		const gout = (gn: string) => [...new Set(members.get(gn)!.flatMap((n) => [...(edges.get(n) ?? [])].filter((m) => inComp.has(m)).map(gid)).filter((m) => m !== gn))];
		const gweight = (gn: string) => members.get(gn)!.reduce((a, n) => a + weight(n), 0);
		const order = eadesOrder(gnodes, gout, gweight);
		const pos = new Map(order.map((n, i) => [n, i]));
		for (const a of comp) {
			for (const b of [...(edges.get(a) ?? [])]) {
				if (!inComp.has(b) || gid(a) === gid(b) || pos.get(gid(a))! < pos.get(gid(b))!) continue; // in-group or forward: keep
				edges.get(a)!.delete(b);
				cut.push([a, b]);
			}
		}
	}
	// remaining cycles are inside natural groups only; condense() makes each of them one component
	return { graph: { nodes: g.nodes, edges }, cut: cut.sort() };
}

function eadesOrder(nodes: string[], outOf: (n: string) => string[], weight: (n: string) => number): string[] {
	const remaining = new Set(nodes);
	const outDeg = new Map<string, number>();
	const inDeg = new Map<string, number>();
	const preds = new Map<string, Set<string>>(nodes.map((n) => [n, new Set()]));
	for (const n of nodes) {
		const outs = outOf(n);
		outDeg.set(n, outs.length);
		for (const m of outs) preds.get(m)!.add(n);
	}
	for (const n of nodes) inDeg.set(n, preds.get(n)!.size);
	const head: string[] = []; // sources
	const tail: string[] = []; // sinks (prepended)
	const remove = (n: string) => {
		remaining.delete(n);
		for (const m of outOf(n)) if (remaining.has(m)) inDeg.set(m, inDeg.get(m)! - 1);
		for (const p of preds.get(n)!) if (remaining.has(p)) outDeg.set(p, outDeg.get(p)! - 1);
	};
	while (remaining.size) {
		let progressed = true;
		while (progressed) {
			progressed = false;
			for (const n of [...remaining].sort()) {
				if (outDeg.get(n) === 0) { tail.unshift(n); remove(n); progressed = true; }
				else if (inDeg.get(n) === 0) { head.push(n); remove(n); progressed = true; }
			}
		}
		if (!remaining.size) break;
		// pick the node with max (out − in); ties: lighter (smaller) first so heavy hubs land late and keep more inbound edges
		const pick = [...remaining].sort((a, b) => (outDeg.get(b)! - inDeg.get(b)!) - (outDeg.get(a)! - inDeg.get(a)!) || weight(a) - weight(b) || a.localeCompare(b))[0]!;
		head.push(pick);
		remove(pick);
	}
	return [...head, ...tail];
}
