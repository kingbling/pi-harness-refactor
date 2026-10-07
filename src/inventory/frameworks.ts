import type { SourceAdapter, TargetAdapter } from "../adapters/types.ts";
import type { Ledger } from "../ledger/db.ts";
import type { Config } from "../config.ts";
import { effectivePlatform } from "../init/stack.ts";

/**
 * `br frameworks`: what the legacy framework(s) and libraries do for the app, how much the app leans on
 * each concern, and what happens to it: provided by the new platform (map), ported (business logic
 * inside framework classes), dropped, or review. Pure code over the ledger + adapter tables; the result
 * is also stored as meta `framework_plan` so task cards and rules can cite it.
 */
export interface ConcernRow {
	concern: string;
	legacy: string;
	verdict: string;
	platform: string;
	classes: number;
	loc: number;
	appRefs: number; // edges from app files into this concern's symbols
	appFiles: number; // distinct app files referencing it
	extendedBy: number; // app classes extending a framework class of this concern
	top: string[]; // most referenced framework classes
}

export interface FrameworkPlan {
	frameworkFiles: number;
	frameworkLoc: number;
	concerns: ConcernRow[];
	unmapped: Array<{ name: string; path: string; appRefs: number }>;
	libraries: Array<{ name: string; version?: string; dev?: boolean; successor?: string; verdict: string; note?: string }>;
}

export function planFrameworks(ledger: Ledger, source: SourceAdapter, targets: TargetAdapter[], sourceRoot: string, decisions?: { libraries?: Record<string, { verdict: string; successor?: string }>; frameworkClasses?: Record<string, string> }, choices: Config["target"]["choices"] = {}): FrameworkPlan {
	// activate the framework profile for this source root (and the workspace's generated profile) before
	// reading concerns: callers must not have to remember it
	source.frameworkDirs?.(sourceRoot);
	const fw = ledger.db.prepare("SELECT path, loc FROM files WHERE disposition = 'framework'").all() as Array<{ path: string; loc: number }>;
	const fwSet = new Set(fw.map((f) => f.path));
	const syms = ledger.db.prepare("SELECT id, path, kind, name FROM index_symbols WHERE side = 'source'").all() as Array<{ id: string; path: string; kind: string; name: string }>;
	const classOf = new Map<string, { name: string; path: string }>(); // symbol id → owning class symbol (framework side)
	for (const s of syms) if (fwSet.has(s.path)) classOf.set(s.id, { name: s.name.split("::")[0]!, path: s.path });
	const edges = ledger.db.prepare("SELECT from_id, to_id, kind FROM index_deps").all() as Array<{ from_id: string; to_id: string; kind: string }>;
	const pathOf = (id: string) => id.split("::")[0]!;

	// references from dead code do not count: dead files are dropped, their framework use never migrates
	const deadSet = new Set((ledger.db.prepare("SELECT path FROM files WHERE dead_code = 1").all() as Array<{ path: string }>).map((r) => r.path));
	const refs = new Map<string, { refs: number; files: Set<string>; extended: number }>();
	for (const e of edges) {
		const fromPath = pathOf(e.from_id);
		if (fwSet.has(fromPath) || deadSet.has(fromPath) || !fwSet.has(pathOf(e.to_id))) continue; // live app → framework only
		const cls = classOf.get(e.to_id)?.name ?? e.to_id.split("::")[1] ?? e.to_id;
		const r = refs.get(cls) ?? { refs: 0, files: new Set(), extended: 0 };
		r.refs++;
		r.files.add(fromPath);
		if (e.kind === "extends" || e.kind === "implements") r.extended++;
		refs.set(cls, r);
	}

	const concerns = source.frameworkConcerns ?? [];
	// Stack decisions from init override the adapter defaults (e.g. orm → TypeORM instead of Prisma).
	const platform = Object.assign({}, ...targets.map((t) => effectivePlatform(t, choices))) as Record<string, string>;
	const rows = new Map<string, ConcernRow & { _files: Set<string>; _top: Map<string, number> }>();
	for (const c of concerns) {
		if (!rows.has(c.concern)) rows.set(c.concern, { concern: c.concern, legacy: c.legacy, verdict: c.verdict, platform: platform[c.concern] ?? "— (review)", classes: 0, loc: 0, appRefs: 0, appFiles: 0, extendedBy: 0, top: [], _files: new Set(), _top: new Map() });
	}
	const unmapped: FrameworkPlan["unmapped"] = [];
	const locOf = new Map(fw.map((f) => [f.path, f.loc]));
	const seenClass = new Set<string>();
	for (const s of syms) {
		if (!fwSet.has(s.path) || !(s.kind === "class" || s.kind === "interface" || s.kind === "trait" || s.kind === "function")) continue;
		if (seenClass.has(s.name)) continue;
		seenClass.add(s.name);
		const c = concerns.find((k) => k.match.test(s.name));
		const r = refs.get(s.name);
		if (!c) {
			if (r) unmapped.push({ name: s.name, path: s.path, appRefs: r.refs });
			continue;
		}
		const row = rows.get(c.concern)!;
		row.classes++;
		row.loc += locOf.get(s.path) ?? 0;
		if (r) {
			row.appRefs += r.refs;
			row.extendedBy += r.extended;
			for (const f of r.files) row._files.add(f);
			row._top.set(s.name, r.refs);
		}
	}
	const out: ConcernRow[] = [...rows.values()].map((r) => ({ concern: r.concern, legacy: r.legacy, verdict: r.verdict, platform: r.platform, classes: r.classes, loc: r.loc, appRefs: r.appRefs, appFiles: r._files.size, extendedBy: r.extendedBy, top: [...r._top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, k]) => `${n}(${k})`) })).sort((a, b) => b.appRefs - a.appRefs);
	unmapped.sort((a, b) => b.appRefs - a.appRefs);
	const libraries = (source.externalDeps?.(sourceRoot) ?? []).map((l) => { const d = decisions?.libraries?.[l.name]; return d ? { ...l, verdict: d.verdict, successor: d.successor ?? l.successor, note: `${l.note ? l.note + "; " : ""}decided` } : l; });
	// decided framework classes leave the unmapped list
	const decidedClasses = decisions?.frameworkClasses ?? {};
	for (let i = unmapped.length - 1; i >= 0; i--) if (decidedClasses[unmapped[i]!.name]) unmapped.splice(i, 1);
	const plan: FrameworkPlan = { frameworkFiles: fw.length, frameworkLoc: fw.reduce((a, f) => a + f.loc, 0), concerns: out, unmapped: unmapped.slice(0, 40), libraries };
	ledger.setMeta("framework_plan", JSON.stringify(plan));
	return plan;
}

export function renderFrameworkPlan(p: FrameworkPlan): string {
	const L: string[] = [];
	L.push(`framework: ${p.frameworkFiles} files, ${p.frameworkLoc} loc — mapped per concern, not migrated file by file`);
	L.push("");
	L.push(`${"concern".padEnd(10)} ${"verdict".padEnd(8)} ${"refs".padStart(6)} ${"files".padStart(5)} ${"ext".padStart(4)} ${"cls".padStart(4)}  legacy → platform`);
	for (const c of p.concerns) {
		L.push(`${c.concern.padEnd(10)} ${c.verdict.padEnd(8)} ${String(c.appRefs).padStart(6)} ${String(c.appFiles).padStart(5)} ${String(c.extendedBy).padStart(4)} ${String(c.classes).padStart(4)}  ${c.legacy} → ${c.platform}`);
		if (c.top.length) L.push(`${"".padEnd(10)} ${"".padEnd(8)} ${"".padStart(6)} ${"".padStart(5)} ${"".padStart(4)} ${"".padStart(4)}  top: ${c.top.join(", ")}`);
	}
	if (p.unmapped.length) {
		L.push("");
		L.push(`unmapped framework classes referenced by the app (review): ${p.unmapped.length}`);
		for (const u of p.unmapped.slice(0, 15)) L.push(`  ${u.name.padEnd(34)} ${String(u.appRefs).padStart(5)}  ${u.path}`);
	}
	if (p.libraries.length) {
		L.push("");
		L.push("libraries:");
		for (const l of p.libraries) L.push(`  ${l.verdict.padEnd(8)} ${l.name.padEnd(36)} ${(l.version ?? "").padEnd(10)} → ${l.successor ?? "?"}${l.dev ? "  [dev]" : ""}${l.note ? `  (${l.note})` : ""}`);
	}
	return L.join("\n");
}
