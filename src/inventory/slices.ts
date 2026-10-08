import type { Ledger } from "../ledger/db.ts";

/**
 * Vertical slices: the human order (foundation → auth → one feature at a time) as a *priority* over
 * the dependency DAG, never a barrier. Pure code over the ledger (routes, units, deps); same index →
 * same plan. Units get meta.slice / meta.sliceRank / meta.depth; the scheduler orders ready units by blockingOrder.
 *
 * Rules (from the orchestration review):
 *  - feature key = first path segment of the route (`/invoices/{id}` → invoices); handlers sharing a
 *    file are merged into one feature; `.bigrefactor/slices.json` overrides win.
 *  - closure(feature) = units reachable from its handler units over unit deps (real code edges).
 *  - foundation = units reached by ≥ max(2, ceil(0.3·features)) features, or T0 units with ≥2 dependents.
 *    Soft edges (string mentions, convention loads) never make a unit shared; they only help place a unit
 *    no real edge reaches into a feature.
 *  - auth = the features Jev named (`advised.auth`, br label) → rank 1. Without that advice (no model ran) a
 *    name match (login, auth, session …) stands in; with it, the match is only one fact in Jev's input.
 *  - remaining features: topological order of the slice graph, tie-break by new LOC ascending.
 *  - units reachable from no entry point → slice `dynamic` (last, human review).
 */
export interface Slice {
	name: string;
	kind: "foundation" | "data" | "auth" | "feature" | "dynamic";
	rank: number;
	entryPoints: string[];
	units: string[];
	loc: number;
}

export interface SliceOverrides {
	/** unit id or file path prefix → slice name */
	overrides?: Record<string, string>;
	/** model advice (br label): applied before `overrides`, which a human owns and which always win */
	advised?: { auth?: string[]; units?: Record<string, string> };
	/** explicit order of feature slices (rank ≥ 2) */
	order?: string[];
	merge?: Array<[string, string]>;
}

export interface SlicePlan {
	slices: Slice[];
	unitSlice: Map<string, string>;
	depth: Map<string, number>;
	foundationSharePct: number;
	dynamicSharePct: number;
}

const AUTH_RE = /login|logout|auth|session|csrf|guard|password/i;

/** The auth word a feature's name or entry points contain (a fact for Jev, not a verdict: `authors` matches too). */
export function authWord(name: string, entryPoints: Iterable<string>): string | undefined {
	for (const s of [name, ...entryPoints]) {
		const m = AUTH_RE.exec(s);
		if (m) return m[0].toLowerCase();
	}
	return undefined;
}

export function planSlices(ledger: Ledger, overrides: SliceOverrides = {}): SlicePlan {
	const units = ledger.listUnits().map((u) => {
		const meta = JSON.parse(u.meta) as { files?: string[]; loc?: number; softDeps?: string[]; lane?: string };
		return { id: u.id, tier: u.tier, deps: JSON.parse(u.deps) as string[], soft: meta.softDeps ?? [], meta, db: meta.lane === "db" };
	});
	const hasData = units.some((u) => u.db);
	const byId = new Map(units.map((u) => [u.id, u]));
	const unitOfFile = new Map<string, string>();
	for (const u of units) for (const f of u.meta.files ?? []) unitOfFile.set(f, u.id);
	const dependents = new Map<string, Set<string>>(units.map((u) => [u.id, new Set()]));
	for (const u of units) for (const d of u.deps) dependents.get(d)?.add(u.id);

	// depth = longest path to a leaf (leaves 0): a fact for the plan and dashboard (the scheduler uses blockingOrder)
	const depth = new Map<string, number>();
	const depthOf = (id: string): number => {
		if (depth.has(id)) return depth.get(id)!;
		const u = byId.get(id);
		const d = u && u.deps.length ? 1 + Math.max(...u.deps.map(depthOf)) : 0;
		depth.set(id, d);
		return d;
	};
	for (const u of units) depthOf(u.id);

	// entry points: routes → handler file → unit
	const routes = ledger.db.prepare("SELECT method, path, handler_symbol FROM index_routes WHERE side = 'source'").all() as Array<{ method: string | null; path: string; handler_symbol: string | null }>;
	const featureOf = new Map<string, { entryPoints: Set<string>; handlers: Set<string> }>();
	const fileFeature = new Map<string, string>();
	for (const r of routes) {
		if (!r.handler_symbol) continue;
		const file = r.handler_symbol.split("::")[0]!;
		const unit = unitOfFile.get(file);
		if (!unit) continue;
		let key = overrides.overrides?.[unit] ?? overrides.overrides?.[file] ?? featureKey(r.path) ?? fileFeature.get(file) ?? "home";
		// one handler file = one feature
		if (fileFeature.has(file) && fileFeature.get(file) !== key) key = fileFeature.get(file)!;
		fileFeature.set(file, key);
		const f = featureOf.get(key) ?? { entryPoints: new Set(), handlers: new Set() };
		f.entryPoints.add(`${r.method ?? "ANY"} ${r.path}`);
		f.handlers.add(unit);
		featureOf.set(key, f);
	}
	for (const [a, b] of overrides.merge ?? []) {
		const fa = featureOf.get(a);
		const fb = featureOf.get(b);
		if (fa && fb) {
			for (const e of fb.entryPoints) fa.entryPoints.add(e);
			for (const h of fb.handlers) fa.handlers.add(h);
			featureOf.delete(b);
		}
	}

	// closures: over real deps (what a feature truly shares), and over real + soft deps (where a unit may belong)
	const closure = new Map<string, Set<string>>();
	const hardClosure = new Map<string, Set<string>>();
	for (const [name, f] of featureOf) {
		closure.set(name, reach(byId, [...f.handlers], true));
		hardClosure.set(name, reach(byId, [...f.handlers], false));
	}
	const reachedByOf = (cl: Map<string, Set<string>>) => {
		const m = new Map<string, Set<string>>();
		for (const [name, c] of cl) for (const u of c) (m.get(u) ?? m.set(u, new Set()).get(u)!).add(name);
		return m;
	};
	const hardReachedBy = reachedByOf(hardClosure);
	const softReachedBy = reachedByOf(closure);
	// features a unit belongs to: the ones reaching it over real deps, else the ones reaching it only softly
	const reachedBy = new Map<string, Set<string>>();
	for (const u of units) {
		const rb = hardReachedBy.get(u.id)?.size ? hardReachedBy.get(u.id)! : softReachedBy.get(u.id);
		if (rb?.size) reachedBy.set(u.id, rb);
	}

	// foundation
	const nFeatures = featureOf.size;
	const threshold = Math.max(2, Math.ceil(0.3 * nFeatures));
	const unitSlice = new Map<string, string>();
	for (const u of units) {
		const rb = hardReachedBy.get(u.id)?.size ?? 0;
		const shared = rb >= threshold || (u.tier === "T0" && (dependents.get(u.id)?.size ?? 0) >= 2) || (nFeatures === 1 && rb === 1 && u.tier === "T0");
		if (shared) unitSlice.set(u.id, "foundation");
	}
	// the DB lane is its own slice, whatever reaches it (every feature reading a table would make it foundation)
	for (const u of units) if (u.db) unitSlice.set(u.id, "data");
	// model advice for units no entry point reaches, then explicit overrides naming foundation/any slice
	for (const [k, v] of Object.entries(overrides.advised?.units ?? {})) if (byId.has(k) && (v === "foundation" || featureOf.has(v)) && !(reachedBy.get(k)?.size)) unitSlice.set(k, v);
	for (const [k, v] of Object.entries(overrides.overrides ?? {})) {
		const id = byId.has(k) ? k : unitOfFile.get(k);
		if (id && !byId.get(id)!.db) unitSlice.set(id, v);
	}
	// each remaining reached unit → its lowest-ranked feature (decided after ranking); first pass: owner = unique feature or deferred
	const pending: string[] = [];
	for (const u of units) {
		if (unitSlice.has(u.id)) continue;
		const rb = reachedBy.get(u.id);
		if (!rb || rb.size === 0) unitSlice.set(u.id, "dynamic");
		else if (rb.size === 1) unitSlice.set(u.id, [...rb][0]!);
		else pending.push(u.id);
	}

	// rank features: auth first, then topological order of the slice graph, tie-break new LOC asc
	const locOf = (id: string) => byId.get(id)?.meta.loc ?? 0;
	const featureNames = [...featureOf.keys()];
	const isAuth = (n: string) => (overrides.advised?.auth ? overrides.advised.auth.includes(n) : !!authWord(n, featureOf.get(n)?.entryPoints ?? []));
	const sliceEdges = new Map<string, Set<string>>(featureNames.map((n) => [n, new Set()]));
	for (const a of featureNames) for (const u of hardClosure.get(a)!) {
		const owner = unitSlice.get(u);
		if (owner && owner !== a && featureOf.has(owner)) sliceEdges.get(a)!.add(owner);
	}
	const newCost = (n: string) => [...closure.get(n)!].filter((u) => unitSlice.get(u) === n || pending.includes(u)).reduce((a, u) => a + locOf(u), 0);
	const ranked: string[] = [];
	const remaining = new Set(featureNames.filter((n) => !isAuth(n)));
	const authFeatures = featureNames.filter(isAuth).sort();
	while (remaining.size) {
		const ready = [...remaining].filter((n) => [...sliceEdges.get(n)!].every((d) => !remaining.has(d) || isAuth(d)));
		const pick = (ready.length ? ready : [...remaining]).sort((a, b) => newCost(a) - newCost(b) || (featureOf.get(b)!.entryPoints.size - featureOf.get(a)!.entryPoints.size) || a.localeCompare(b))[0]!;
		ranked.push(pick);
		remaining.delete(pick);
	}
	if (overrides.order?.length) ranked.sort((a, b) => idx(overrides.order!, a) - idx(overrides.order!, b));
	const order = [...authFeatures, ...ranked];
	// foundation 0, data 1 (when there is a DB lane), auth next, then the features
	const rankOf = new Map<string, number>([["foundation", 0]]);
	const shift = hasData ? 1 : 0;
	if (hasData) rankOf.set("data", 1);
	let r = 1 + shift;
	for (const n of order) rankOf.set(n, authFeatures.includes(n) ? 1 + shift : ++r);
	rankOf.set("dynamic", r + 1);
	for (const u of pending) {
		const owner = [...reachedBy.get(u)!].sort((a, b) => rankOf.get(a)! - rankOf.get(b)!)[0]!;
		unitSlice.set(u, owner);
	}

	const slices: Slice[] = [];
	const names = ["foundation", ...(hasData ? ["data"] : []), ...order, "dynamic"];
	for (const name of names) {
		const members = units.filter((u) => unitSlice.get(u.id) === name).map((u) => u.id);
		if (!members.length && name !== "foundation") continue;
		slices.push({ name, kind: name === "foundation" ? "foundation" : name === "data" ? "data" : name === "dynamic" ? "dynamic" : authFeatures.includes(name) ? "auth" : "feature", rank: rankOf.get(name)!, entryPoints: [...(featureOf.get(name)?.entryPoints ?? [])].sort(), units: members.sort((a, b) => (depth.get(b)! - depth.get(a)!) || a.localeCompare(b)), loc: members.reduce((a, u) => a + locOf(u), 0) });
	}
	const totalLoc = units.reduce((a, u) => a + locOf(u.id), 0) || 1;
	return {
		slices,
		unitSlice,
		depth,
		foundationSharePct: Math.round((100 * (slices.find((s) => s.name === "foundation")?.loc ?? 0)) / totalLoc),
		dynamicSharePct: Math.round((100 * (slices.find((s) => s.name === "dynamic")?.loc ?? 0)) / totalLoc),
	};
}

/**
 * Run order among units that are ready: what waits on a unit decides how urgent it is. `rank` is the best
 * (lowest) slice rank of the unit and of every unit that needs it, directly or through others — a DB unit the
 * foundation needs runs with the foundation. `blocks` is how many units need it. Sort by rank, then blocks
 * (most first), then id.
 */
export function blockingOrder(units: Array<{ id: string; deps: string[]; rank: number }>): Map<string, { rank: number; blocks: number }> {
	const needs = new Map<string, string[]>(units.map((u) => [u.id, []]));
	for (const u of units) for (const d of u.deps) needs.get(d)?.push(u.id);
	const rankOf = new Map(units.map((u) => [u.id, u.rank]));
	const out = new Map<string, { rank: number; blocks: number }>();
	for (const u of units) {
		const seen = new Set<string>();
		const stack = [...needs.get(u.id)!];
		let rank = u.rank;
		while (stack.length) {
			const id = stack.pop()!;
			if (seen.has(id)) continue;
			seen.add(id);
			rank = Math.min(rank, rankOf.get(id)!);
			stack.push(...needs.get(id)!);
		}
		out.set(u.id, { rank, blocks: seen.size });
	}
	return out;
}

/** Persist the plan into unit meta so the scheduler and dashboard can use it without recomputing. */
export function applySlicePlan(ledger: Ledger, plan: SlicePlan): void {
	const rank = new Map(plan.slices.map((s) => [s.name, s.rank]));
	for (const u of ledger.listUnits()) {
		const slice = plan.unitSlice.get(u.id) ?? "dynamic";
		ledger.updateUnit(u.id, { meta: { ...JSON.parse(u.meta), slice, sliceRank: rank.get(slice) ?? 99, depth: plan.depth.get(u.id) ?? 0 } });
	}
	ledger.setMeta("slice_plan", JSON.stringify(plan.slices.map((s) => ({ name: s.name, rank: s.rank, units: s.units.length, loc: s.loc, entryPoints: s.entryPoints }))));
}

export function renderSlicePlan(plan: SlicePlan): string {
	const L = [`slices: ${plan.slices.length}   foundation ${plan.foundationSharePct}% LOC   dynamic ${plan.dynamicSharePct}% LOC${plan.foundationSharePct > 30 ? "   (foundation > 30%: order degenerates to tiers; fine, but expect a late first vertical)" : ""}`];
	for (const s of plan.slices) {
		L.push(`  #${s.rank} ${s.name.padEnd(14)} [${s.kind}] ${String(s.units.length).padStart(3)} units ${String(s.loc).padStart(6)} loc${s.entryPoints.length ? `  ← ${s.entryPoints.slice(0, 4).join(", ")}${s.entryPoints.length > 4 ? ` +${s.entryPoints.length - 4}` : ""}` : ""}`);
		for (const u of s.units) L.push(`       ${u}`);
	}
	return L.join("\n");
}

function featureKey(path: string): string | undefined {
	const seg = path.split("/").filter(Boolean).find((s) => !/^[{:]/.test(s) && !/^v\d+$/.test(s) && s !== "api");
	return seg?.toLowerCase().replace(/\.[a-z0-9]+$/, "");
}

function reach(byId: Map<string, { deps: string[]; soft?: string[] }>, roots: string[], soft: boolean): Set<string> {
	const seen = new Set<string>();
	const stack = [...roots];
	while (stack.length) {
		const id = stack.pop()!;
		if (seen.has(id)) continue;
		seen.add(id);
		const u = byId.get(id);
		for (const d of u?.deps ?? []) stack.push(d);
		if (soft) for (const d of u?.soft ?? []) stack.push(d);
	}
	return seen;
}

function idx(order: string[], n: string): number {
	const i = order.indexOf(n);
	return i < 0 ? order.length : i;
}
