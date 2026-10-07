import { globToRegExp } from "../sessions/spawn.ts";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import pc from "picocolors";
import type { Config } from "../config.ts";
import type { FileIndex, IndexedSymbol, SourceAdapter } from "../adapters/types.ts";
import { getSourceAdapter } from "../adapters/registry.ts";
import type { Ledger } from "../ledger/db.ts";
import { buildGraph, condense, cutLargeCycles, tarjanScc } from "./scc.ts";
import { headOf, isRepo } from "../git.ts";
import { loadDecisions } from "./decisions.ts";
import { resolveCodeMap, writeCodeMap } from "./codemap.ts";

export type Tier = "T0" | "T1" | "T2" | "T3";

/**
 * `br inventory`: index every source file → symbols/deps/routes/queries → resolve edges →
 * SCC condensation → tiers → whole-file units (leaves first) → ledger. Deterministic; no models.
 * Must end with unaccounted == 0 (every symbol clustered or dropped as dead code).
 */
export async function inventory(config: Config, _root: string, ledger: Ledger): Promise<InventoryReport> {
	const adapter = getSourceAdapter(config.source.stack);
	const srcRoot = config.source.path;
	process.env["BR_SOURCE_ROOT"] = srcRoot;
	process.env["BR_WORKSPACE"] ??= _root;

	// Source is read-only: we only record where it stands. A later re-run detects drift per file hash.
	const sourceCommit = headOf(srcRoot);
	const previousCommit = ledger.getMeta("source_commit");
	const previousHashes = new Map((ledger.db.prepare("SELECT path, hash FROM files").all() as Array<{ path: string; hash: string }>).map((r) => [r.path, r.hash]));
	const drift = { changed: [] as string[], added: [] as string[], removed: [] as string[], staleUnits: [] as string[] };

	const files = listFiles(srcRoot, adapter);
	const indexes: FileIndex[] = [];
	for (const rel of files) {
		const source = readFileSync(join(srcRoot, rel), "utf8");
		indexes.push(await adapter.indexFile(srcRoot, rel, source));
	}
	// routes: declared in code (per file) and/or in a routes table the adapter knows how to read
	const routes = [...indexes.flatMap((f) => f.routes), ...(adapter.indexRoutes ? await adapter.indexRoutes(srcRoot) : [])];

	// ---- resolve names → symbol ids
	const byName = new Map<string, IndexedSymbol[]>();
	const allSymbols: IndexedSymbol[] = [];
	for (const f of indexes)
		for (const s of f.symbols) {
			allSymbols.push(s);
			const short = s.name.includes("::") ? s.name : s.name; // Class::method and bare names both indexable
			push(byName, short, s);
			if (s.kind === "class" || s.kind === "interface" || s.kind === "trait" || s.kind === "enum") push(byName, s.name, s);
		}
	const fileOf = new Map(indexes.map((f) => [f.path, f]));
	// convention loads (`glob:**/model/**/x.model.php`) → all matching files; cached per glob
	const globCache = new Map<string, string[]>();
	const resolveGlob = (g: string): string[] => {
		let hit = globCache.get(g);
		if (!hit) {
			const re = new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "(?:.*/)?").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$", adapter.names?.caseInsensitive ? "i" : "");
			hit = indexes.map((f) => f.path).filter((p) => re.test(p));
			globCache.set(g, hit);
		}
		return hit;
	};
	const frameworkPrefixes = adapter.frameworkDirs?.(srcRoot) ?? [];
	const isFramework = (p: string) => frameworkPrefixes.some((d) => p.startsWith(d));
	const resolve = (to: string): string | undefined => {
		if (to.startsWith("glob:")) return resolveGlob(to.slice(5))[0];
		if (fileOf.has(to)) return to; // include edge to a file
		const cands = byName.get(to);
		if (cands?.length) return cands[0]!.id;
		// Class::method → fall back to the class
		const cls = to.split("::")[0]!;
		return byName.get(cls)?.[0]?.id;
	};

	// ---- write index tables
	const tx = ledger.db;
	tx.exec("BEGIN");
	try {
		tx.exec("DELETE FROM index_symbols WHERE side='source'; DELETE FROM index_deps; DELETE FROM index_routes WHERE side='source'; DELETE FROM index_literal_refs; DELETE FROM index_queries;");
		const insSym = tx.prepare("INSERT OR REPLACE INTO index_symbols(id, side, path, kind, name, line, signature, exported, ast_hash, end_line) VALUES (?, 'source', ?, ?, ?, ?, ?, ?, ?, ?)");
		const insDep = tx.prepare("INSERT OR IGNORE INTO index_deps(from_id, to_id, kind) VALUES (?, ?, ?)");
		const insLit = tx.prepare("INSERT OR IGNORE INTO index_literal_refs(name, path, line) VALUES (?, ?, 0)");
		const insQ = tx.prepare("INSERT INTO index_queries(symbol_id, kind, tables, text) VALUES (?, ?, ?, ?)");
		const insRoute = tx.prepare("INSERT OR REPLACE INTO index_routes(id, side, method, path, handler_symbol) VALUES (?, 'source', ?, ?, ?)");
		for (const f of indexes) {
			const prev = previousHashes.get(f.path);
			if (prev === undefined && previousHashes.size) drift.added.push(f.path);
			else if (prev !== undefined && prev !== f.hash) drift.changed.push(f.path);
			ledger.upsertFile({ path: f.path, hash: f.hash, lang: f.lang, loc: f.loc });
			for (const s of f.symbols) {
				insSym.run(s.id, s.path, s.kind, s.name, s.line, s.signature ?? null, s.exported ? 1 : 0, s.astHash ?? null, s.endLine ?? null);
				ledger.upsertSymbol({ id: s.id, path: s.path, kind: s.kind, name: s.name, exported: s.exported });
			}
			for (const d of f.deps) {
				if (d.to.startsWith("glob:")) {
					for (const t of resolveGlob(d.to.slice(5))) insDep.run(d.from, t, d.kind);
					continue;
				}
				const to = resolve(d.to);
				if (to) insDep.run(d.from, to, d.kind);
			}
			for (const n of f.literalRefs) insLit.run(n, f.path);
			for (const q of f.queries) insQ.run(q.symbolId, q.kind, JSON.stringify(q.tables), q.text ?? null);
		}
		for (const r of routes) insRoute.run(r.id, r.method ?? null, r.path, r.handlerSymbol ? resolve(r.handlerSymbol) ?? r.handlerSymbol : null);
		writeCodeMap(ledger, resolveCodeMap(indexes, isFramework, { caseInsensitive: adapter.names?.caseInsensitive }));
		tx.exec("COMMIT");
	} catch (e) {
		tx.exec("ROLLBACK");
		throw e;
	}

	// ---- file-level graph (units are whole files; symbol edges roll up to files)
	const symFile = new Map(allSymbols.map((s) => [s.id, s.path]));
	const fileEdges: Array<[string, string]> = [];
	const inbound = new Map<string, number>();
	// Convention loads (`load`) prove liveness but are not graph edges: conventions point both ways
	// (model → its commands dir, command → model) and would weld whole layers into one SCC.
	const softEdges: Array<[string, string]> = []; // convention loads: slicing/reachability only, never SCC/tiers
	const addEdge = (from: string, toFile: string | undefined, livenessOnly = false) => {
		if (!toFile || toFile === from) return;
		if (livenessOnly) softEdges.push([from, toFile]);
		else fileEdges.push([from, toFile]);
		inbound.set(toFile, (inbound.get(toFile) ?? 0) + 1);
	};
	for (const f of indexes)
		for (const d of f.deps) {
			if (d.to.startsWith("glob:")) {
				for (const t of resolveGlob(d.to.slice(5))) addEdge(f.path, t, true);
				continue;
			}
			const to = resolve(d.to);
			if (!to) continue;
			addEdge(f.path, symFile.get(to) ?? (fileOf.has(to) ? to : undefined));
		}
	// routes count as inbound references to their handler files (and make them live roots)
	const routeHit = new Set<string>();
	for (const r of routes) {
		const id = r.handlerSymbol ? resolve(r.handlerSymbol) : undefined;
		const file = id ? symFile.get(id) : undefined;
		if (file) {
			inbound.set(file, (inbound.get(file) ?? 0) + 1);
			routeHit.add(file);
		}
	}
	const literalHits = new Set<string>();
	const literalWhere = new Map<string, Set<string>>(); // literal → files mentioning it (string-literal references become soft edges)
	for (const f of indexes)
		for (const n of f.literalRefs) {
			literalHits.add(n);
			(literalWhere.get(n) ?? literalWhere.set(n, new Set()).get(n)!).add(f.path);
		}

	// ---- registration files: not units; the target adapter regenerates them from the ledger
	const regenerated = indexes.filter((f) => adapter.isRegistrationFile?.(f.path)).map((f) => f.path);
	// owner-confirmed exclusions (area questions → decisions.json `excluded`): same disposition, kept across re-inventories
	const excluded = (loadDecisions(_root) as { excluded?: Record<string, string> }).excluded ?? {};
	for (const f of indexes) if (excluded[f.path] && !regenerated.includes(f.path)) regenerated.push(f.path);
	// ---- framework files: indexed so names resolve, mapped per concern (br frameworks), never units
	const framework = indexes.filter((f) => isFramework(f.path)).map((f) => f.path);
	const frameworkSet = new Set(framework);

	// ---- dead code, transitive: a file is dead when nothing refers to it, or when every file that refers to
	// it (import, convention load, string-literal mention) is itself dead. Repeated to a fixpoint, so a
	// template included only by a dead template is dead too. Entry points, route handlers, registration
	// and framework files are always live. Cycles of only-dead files stay live (conservative).
	const referrers = new Map<string, Set<string>>();
	const refer = (from: string, to: string) => {
		if (from === to) return;
		(referrers.get(to) ?? referrers.set(to, new Set()).get(to)!).add(from);
	};
	for (const [a, b] of fileEdges) refer(a, b);
	for (const [a, b] of softEdges) refer(a, b);
	const literalSoft: Array<[string, string]> = [];
	const candidates: typeof indexes = [];
	for (const f of indexes) {
		if (routeHit.has(f.path) || regenerated.includes(f.path) || frameworkSet.has(f.path) || adapter.isEntryPoint?.(f.path)) continue;
		if (!f.symbols.length) continue; // nothing to drop
		const names = f.symbols.map((s) => s.name.split("::").pop()!);
		const aliases = adapter.fileAliases?.(f.path) ?? [];
		const keys = [...names, ...aliases, f.path.split("/").pop()!.replace(/\.[A-Za-z0-9]+$/, "")].filter((k) => literalHits.has(k));
		for (const k of keys) for (const src of literalWhere.get(k) ?? []) if (src !== f.path) {
			refer(src, f.path);
			literalSoft.push([src, f.path]);
		}
		candidates.push(f);
	}
	const deadNow = new Set<string>();
	for (let changed = true; changed; ) {
		changed = false;
		for (const f of candidates) {
			if (deadNow.has(f.path)) continue;
			const refs = referrers.get(f.path);
			if (!refs || [...refs].every((r) => deadNow.has(r))) {
				deadNow.add(f.path);
				changed = true;
			}
		}
	}
	const dead: string[] = candidates.filter((f) => deadNow.has(f.path)).map((f) => f.path);
	// alive through a string literal: live mentioning files are soft referrers (slicing reaches the file through them)
	for (const [src, to] of literalSoft) if (!deadNow.has(src) && !deadNow.has(to)) softEdges.push([src, to]);

	const deadSet = new Set(dead);
	// ---- tiers
	const locOfFile = new Map(indexes.map((f) => [f.path, f.loc]));
	const raw = buildGraph(indexes.map((f) => f.path), fileEdges);
	const groupOf = (p: string) => adapter.unitGroupOf?.(p);
	if (config.inventory.mergeGroups) for (const f of indexes) { const ga = groupOf(f.path); if (ga) for (const h of indexes) if (h !== f && groupOf(h.path) === ga) { fileEdges.push([f.path, h.path]); fileEdges.push([h.path, f.path]); } }
	const { graph: g, cut } = cutLargeCycles(raw.nodes.length ? buildGraph(raw.nodes, fileEdges) : raw, config.inventory.maxSccFiles, (p) => locOfFile.get(p) ?? 0, groupOf);
	const cond = condense(g);
	const cutFrom = new Map<string, string[]>();
	for (const [a, b] of cut) (cutFrom.get(a) ?? cutFrom.set(a, []).get(a)!).push(b);
	const tierOf = new Map<string, Tier>();
	for (const f of indexes) {
		let tier: Tier | undefined;
		for (const s of f.symbols) {
			const t = adapter.classifyTier?.(s, f);
			if (t && (!tier || t > tier)) tier = t; // T3 > T2 > T1 > T0 lexicographically
		}
		if (!tier) {
			const outDeps = (g.edges.get(f.path) ?? new Set()).size;
			const onlyConstsAndFunctions = f.symbols.every((s) => s.kind === "const" || s.kind === "function");
			tier = outDeps === 0 && onlyConstsAndFunctions && f.queries.length === 0 ? "T0" : "T1";
		}
		if (f.queries.length && tier === "T0") tier = "T1";
		tierOf.set(f.path, tier);
	}

	// ---- self-heal: symbols of started units always point at them (older ledgers could lose the link)
	for (const u of ledger.listUnits().filter((x) => x.state !== "planned")) {
		const files = (JSON.parse(u.meta).files ?? []) as string[];
		if (!files.length) continue;
		ledger.db.prepare(`UPDATE symbols SET unit_id = ? WHERE unit_id IS NULL AND state NOT IN ('discovered','dropped') AND path IN (${files.map(() => "?").join(",")})`).run(u.id, ...files);
	}
	// ---- revive: files an earlier run marked dead/framework/regenerated that are alive now
	{
		const regenSet = new Set(regenerated);
		const flagged = ledger.db.prepare("SELECT path, dead_code, disposition FROM files WHERE dead_code = 1 OR disposition IS NOT NULL").all() as Array<{ path: string; dead_code: number; disposition: string | null }>;
		for (const f of flagged) {
			const stillDead = f.dead_code === 1 && deadSet.has(f.path);
			const stillFramework = f.disposition === "framework" && frameworkSet.has(f.path);
			const stillRegenerated = f.disposition === "regenerated" && regenSet.has(f.path);
			if (stillDead || stillFramework || stillRegenerated) continue;
			if (!fileOf.has(f.path)) continue; // removed upstream: drift handles it
			ledger.reviveFile(f.path, "re-inventory found references (profile/decision change)");
		}
	}
	// ---- units: one per condensed component (usually one file), leaves first.
	// Re-runs are stable: a component with the same file set keeps its unit id; files owned by a unit that
	// already started (truth/implementing/…/accepted) stay with it; planned units that no longer match any
	// component are removed at the end (no stale duplicates after a profile/decision change).
	const unitIds: string[] = [];
	const compUnit = new Map<number, string>();
	const prior = ledger.listUnits().map((u) => ({ id: u.id, state: u.state, files: ((JSON.parse(u.meta).files ?? []) as string[]).slice().sort() }));
	const priorByFiles = new Map(prior.map((u) => [u.files.join("\n"), u.id]));
	const startedFile = new Map<string, string>();
	for (const u of prior) if (u.state !== "planned") for (const f of u.files) startedFile.set(f, u.id);
	let seq = Math.max(0, ...prior.map((u) => Number(/^U(\d+)/.exec(u.id)?.[1] ?? 0)));
	for (const ci of cond.order) {
		const all = cond.components[ci]!.filter((p) => !deadSet.has(p) && !regenerated.includes(p) && !frameworkSet.has(p));
		if (!all.length) continue;
		const comp = all.filter((p) => !startedFile.has(p));
		if (!comp.length) {
			// everything here already belongs to started units: keep them, wire deps through the first one
			compUnit.set(ci, startedFile.get(all[0]!)!);
			continue;
		}
		const tiers = comp.map((p) => tierOf.get(p)!);
		const tier = tiers.sort().at(-1)!;
		const id = priorByFiles.get(comp.slice().sort().join("\n")) ?? unitIdFor(comp, ++seq);
		compUnit.set(ci, id);
		unitIds.push(id);
		const symbolIds = comp.flatMap((p) => fileOf.get(p)!.symbols.map((s) => s.id));
		const deps = [...(cond.deps.get(ci) ?? [])].map((d) => compUnit.get(d)).filter((x): x is string => !!x);
		const dyn = comp.flatMap((p) => fileOf.get(p)!.dynamicMarkers);
		const existing = ledger.getUnit(id);
		const unitMeta = { files: comp, loc: comp.reduce((a, p) => a + fileOf.get(p)!.loc, 0), dynamic_markers: dyn, queries: comp.reduce((a, p) => a + fileOf.get(p)!.queries.length, 0), cutDeps: [...new Set(comp.flatMap((p) => cutFrom.get(p) ?? []))].filter((t) => !comp.includes(t)).sort() };
		if (existing?.state === "planned") {
			// same files, possibly new edges/tier after a profile or decision change
			ledger.db.prepare("UPDATE units SET tier = ?, deps = ? WHERE id = ?").run(tier, JSON.stringify(deps), id);
			ledger.updateUnit(id, { meta: unitMeta });
			for (const sid of symbolIds) ledger.db.prepare("UPDATE symbols SET unit_id = ? WHERE id = ? AND (unit_id IS NULL OR unit_id != ?)").run(id, sid, id);
		}
		if (!existing) {
			ledger.createUnit({
				id,
				tier,
				kind: comp.map((p) => adapter.classifyKind?.(fileOf.get(p)!)).find(Boolean) ?? (tier === "T2" ? "http_handler" : tier === "T0" ? "constants_config" : tier === "T1" ? "domain_logic" : undefined),
				deps,
				meta: unitMeta,
				symbolIds,
			});
		}
		for (const p of comp) ledger.db.prepare("UPDATE files SET tier = ? WHERE path = ?").run(tier, p);
		for (const sid of symbolIds) ledger.db.prepare("UPDATE symbols SET tier = ? WHERE id = ?").run(tier, sid);
	}
	// soft deps (convention loads) per unit → meta.softDeps; the slice planner walks deps ∪ softDeps
	{
		const unitOfFile = new Map<string, string>();
		for (const [ci, id] of compUnit) for (const p of cond.components[ci]!) unitOfFile.set(p, id);
		const soft = new Map<string, Set<string>>();
		for (const [from, to] of softEdges) {
			const a = unitOfFile.get(from);
			const b = unitOfFile.get(to);
			if (a && b && a !== b) (soft.get(a) ?? soft.set(a, new Set()).get(a)!).add(b);
		}
		const upd = ledger.db.prepare("UPDATE units SET meta = json_set(meta, '$.softDeps', json(?)) WHERE id = ?");
		for (const id of unitIds) upd.run(JSON.stringify([...(soft.get(id) ?? [])].sort()), id);
	}
	for (const p of dead) ledger.markDeadCode(p, referrers.get(p)?.size ? `only referenced from dead code (${[...referrers.get(p)!].slice(0, 3).join(", ")})` : "no inbound references and no string-literal mentions of its symbols");
	for (const p of framework) ledger.markFramework(p, "legacy framework: mapped per concern to the target platform (br frameworks), not migrated file by file");
	for (const p of regenerated) ledger.markRegenerated(p, excluded[p] ?? `registration file; the ${config.target.stacks.join("/")} adapter regenerates module/route wiring from the ledger (index_routes)`);
	// planned units from an earlier inventory that this run did not produce (files regrouped, now dead,
	// framework or regenerated) are no longer units; their symbols already point at the new unit
	const produced = new Set(unitIds);
	for (const u of ledger.listUnits({ state: "planned" })) {
		if (produced.has(u.id)) continue;
		ledger.db.prepare("UPDATE symbols SET unit_id = NULL WHERE unit_id = ?").run(u.id);
		ledger.db.prepare("DELETE FROM units WHERE id = ?").run(u.id);
	}
	for (const u of ledger.listUnits({ state: "planned" })) {
		const files = (JSON.parse(u.meta).files ?? []) as string[];
		if (files.length && files.every((f) => regenerated.includes(f) || dead.includes(f) || frameworkSet.has(f))) {
			ledger.db.prepare("UPDATE symbols SET unit_id = NULL WHERE unit_id = ?").run(u.id);
			ledger.db.prepare("DELETE FROM units WHERE id = ?").run(u.id);
		}
	}

	// Drift: units already past planning whose source files changed upstream are flagged stale (not reset —
	// a human or `br sweep --stale` decides whether to redo them). Removed files stay in the ledger with a note.
	const seen = new Set(indexes.map((f) => f.path));
	for (const p of previousHashes.keys()) if (!seen.has(p)) drift.removed.push(p);
	for (const p of [...drift.changed, ...drift.removed]) {
		const sym = ledger.db.prepare("SELECT DISTINCT unit_id FROM symbols WHERE path = ? AND unit_id IS NOT NULL").all(p) as Array<{ unit_id: string }>;
		for (const { unit_id } of sym) {
			const u = ledger.getUnit(unit_id);
			if (!u || u.state === "planned") continue;
			const meta = JSON.parse(u.meta);
			if (!meta.stale) {
				ledger.updateUnit(unit_id, { meta: { ...meta, stale: true, staleReason: `${p} changed upstream (${previousCommit?.slice(0, 7) ?? "?"} → ${sourceCommit?.slice(0, 7) ?? "?"})` } });
				drift.staleUnits.push(unit_id);
			}
		}
	}
	if (sourceCommit) ledger.setMeta("source_commit", sourceCommit);
	ledger.setMeta("source_is_git", isRepo(srcRoot) ? "1" : "0");

	const inv = ledger.checkInvariants();
	const report: InventoryReport = {
		files: indexes.length,
		symbols: allSymbols.length,
		units: unitIds.length,
		dead,
		regenerated,
		framework: framework.length,
		largestScc: Math.max(0, ...cond.components.map((c) => c.length)),
		largestRawScc: Math.max(0, ...tarjanScc(raw).map((c) => c.length)),
		cutEdges: cut.length,
		dynamicRefFiles: indexes.filter((f) => f.dynamicMarkers.length).map((f) => f.path),
		tiers: countBy([...tierOf.values()]),
		unaccounted: ledger.unaccounted().length,
		invariantsOk: inv.ok,
		sourceCommit,
		drift,
	};
	ledger.setMeta("inventory_at", new Date().toISOString());
	console.log(pc.dim(`inventory: ${report.files} files, ${report.symbols} symbols, ${report.units} units, dead ${dead.length}, framework ${framework.length}, cut ${cut.length} edges (raw SCC ${report.largestRawScc}), regenerated ${regenerated.length}, largest SCC ${report.largestScc}, dynamic-ref files ${report.dynamicRefFiles.length}${sourceCommit ? `, source@${sourceCommit.slice(0, 7)}` : ""}`));
	if (drift.changed.length || drift.added.length || drift.removed.length)
		console.log(pc.yellow(`drift since last inventory: ${drift.changed.length} changed, ${drift.added.length} added, ${drift.removed.length} removed → ${drift.staleUnits.length} units marked stale`));
	return report;
}

export interface InventoryReport {
	files: number;
	symbols: number;
	units: number;
	dead: string[];
	regenerated: string[];
	framework: number;
	largestRawScc: number;
	cutEdges: number;
	largestScc: number;
	dynamicRefFiles: string[];
	tiers: Record<string, number>;
	unaccounted: number;
	invariantsOk: boolean;
	sourceCommit?: string;
	drift: { changed: string[]; added: string[]; removed: string[]; staleUnits: string[] };
}

function unitIdFor(files: string[], n: number): string {
	const base = files[0]!.replace(/\.[a-z]+$/, "").split("/").slice(-2).join("_").replace(/[^A-Za-z0-9_]/g, "_");
	return files.length > 1 ? `U${String(n).padStart(3, "0")}_${base}+${files.length - 1}` : `U${String(n).padStart(3, "0")}_${base}`;
}

function listFiles(root: string, adapter: SourceAdapter): string[] {
	const out: string[] = [];
	// the adapter's globs, matched as globs (not just extensions); excluded dirs are pruned while walking
	const include = adapter.include.map(globToRegExp);
	const exclude = adapter.exclude.map(globToRegExp);
	const excludedDir = (rel: string) => exclude.some((re) => re.test(`${rel}/x`) || re.test(rel));
	const visit = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const abs = join(dir, name);
			const rel = relative(root, abs).split(sep).join("/");
			if (excludedDir(rel)) continue;
			let st;
			try {
				st = statSync(abs); // follows symlinks; dangling ones throw and are skipped
			} catch {
				continue;
			}
			if (st.isDirectory()) visit(abs);
			else if (include.some((re) => re.test(rel)) && !exclude.some((re) => re.test(rel))) out.push(rel);
		}
	};
	visit(root);
	return out.sort();
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
	const a = m.get(k);
	if (a) a.push(v);
	else m.set(k, [v]);
}
function countBy(xs: string[]): Record<string, number> {
	const r: Record<string, number> = {};
	for (const x of xs) r[x] = (r[x] ?? 0) + 1;
	return r;
}
