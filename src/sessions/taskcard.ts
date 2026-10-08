import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Config } from "../config.ts";
import type { Ledger, UnitRow } from "../ledger/db.ts";
import { renderCapability, reuseCandidates, type Capability } from "../inventory/capabilities.ts";
import { sharedSymbols, similarTargetSymbols, stackTagLike } from "../inventory/target.ts";
import type { TargetAdapter } from "../adapters/types.ts";
import { placeUnit, type Placement } from "../run/placement.ts";
import { tidyTaskCard } from "../run/tidy.ts";
import { callTree } from "../inventory/codemap.ts";

/**
 * Task card: the whole context an implementer or tester gets pushed. Everything else is pulled
 * through tools. Target ≤ ~2k tokens of card + the unit's source files (whole file in one pass).
 */
export interface TaskCard {
	unit: UnitRow;
	files: string[];
	symbols: Array<{ id: string; name: string; kind: string; exported: boolean; signature?: string; line: number }>;
	/** Outgoing deps already migrated: source symbol → target symbol(s), so the implementer imports instead of re-porting. */
	resolvedDeps: Array<{ source: string; target: string[]; op: string }>;
	/** Source symbols this unit depends on that are NOT migrated yet (scheduler should not run the unit, but say so). */
	unresolvedDeps: string[];
	/** Who calls this unit (so interfaces stay compatible). */
	callers: Array<{ from: string; kind: string }>;
	/** Normalized-AST duplicates within the unit or against accepted target code. */
	dupCandidates: Array<{ a: string; b: string; reason: string }>;
	routes: Array<{ method: string | null; path: string; handler: string | null }>;
	queries: Array<{ symbol: string; tables: string[]; text: string | null }>;
	dynamicMarkers: string[];
	cutDeps: string[];
	frameworkRefs: Array<{ cls: string; refs: number; verdict: string; platform: string }>;
	/** Where the unit's code leads outside its files (code map), with migration state per target. */
	callTree: string[];
	truthCases: number;
	/** Cases written from reading the old code (it could not run): weaker, marked as such. */
	truthRead?: number;
	/** Cross-cutting helpers that already exist in the target (reuse, never reimplement). */
	sharedHelpers: Array<{ id: string; kind: string; signature: string | null; doc: string | null }>;
	/** Target symbols whose names resemble this unit's legacy symbols — check before creating. */
	reuseHints: Array<{ legacy: string; id: string; kind: string }>;
	/** Capability cards (by meaning) that may already cover this unit's legacy symbols: import/inject, never rewrite. */
	reuseCandidates: Array<{ legacy: string; capability: Capability }>;
	/** Approved tidy tasks of the unit's area (rendered list; empty = none). */
	tidyTasks: string;
	targetProjectDir: string;
	writeGlobs: string[];
	sharedDirs: string[];
	/** Where the unit lands (stack, legacy area, shared or not) and its module dir in the target project. */
	place?: Placement;
	moduleDir?: string;
	/** The area's module as it is now (binding dir, contents, sibling units): units of one area extend it, never fork it. */
	areaModule?: AreaModule;
	/** The target stack's data-access convention (TargetLayout.dataAccessHint). */
	dataAccessHint?: string;
}

export interface AreaModule {
	area: string;
	stackId: string;
	moduleDir: string;
	shared: boolean;
	structureDoc: string;
	/** Non-test files in moduleDir (relative to it) with the exported symbols the target index has for them. */
	files: Array<{ path: string; symbols: Array<{ name: string; kind: string; signature: string | null }> }>;
	testFiles: number;
	/** Classes already in the module: new behaviour becomes methods on these. */
	classes: string[];
	/** Other units placed in the same module; accepted ones with the target files they produced. */
	siblings: Array<{ id: string; state: string; targetFiles: string[] }>;
}

/** Render bounds; every cut is announced with an "N more omitted" line. */
const MAX_AREA_FILES = 40;
const MAX_AREA_SYMBOLS = 80;
const MAX_ACCEPTED = 15;
const MAX_OTHER_SIBLINGS = 40;
const MAX_SIBLING_FILES = 6;

export function buildTaskCard(ledger: Ledger, config: Config, unitId: string, opts: { targetProjectDir: string; writeGlobs: string[]; adapter: TargetAdapter; place?: Placement; moduleDir?: string; root?: string }): TaskCard {
	const unit = ledger.getUnit(unitId);
	if (!unit) throw new Error(`unit ${unitId} not found`);
	const meta = JSON.parse(unit.meta) as { files?: string[]; dynamic_markers?: string[]; cutDeps?: string[] };
	const files = meta.files ?? [];
	const db = ledger.db;

	const symbols = (db.prepare("SELECT s.id, s.name, s.kind, s.exported, i.signature, i.line FROM symbols s LEFT JOIN index_symbols i ON i.id = s.id WHERE s.unit_id = ? ORDER BY i.line").all(unitId) as Array<any>).map((r) => ({
		id: r.id as string,
		name: r.name as string,
		kind: r.kind as string,
		exported: !!r.exported,
		signature: (r.signature as string | null) ?? undefined,
		line: Number(r.line ?? 0),
	}));
	const ids = new Set(symbols.map((s) => s.id));

	// deps: edges leaving the unit → resolved via moves (if the target unit is accepted) or unresolved
	// edges: symbol-level deps (new/extends/use/includes) plus code-map calls (every call kind, receivers typed)
	const outEdges = db.prepare(`SELECT DISTINCT d.to_id FROM index_deps d JOIN symbols s ON s.id = d.from_id WHERE s.unit_id = ?
		UNION SELECT DISTINCT c.to_id FROM code_calls c JOIN symbols s ON s.id = c.from_id WHERE s.unit_id = ? AND c.to_id IS NOT NULL AND c.resolution = 'code'`).all(unitId, unitId) as Array<{ to_id: string }>;
	// typed calls into the framework: only for the framework section (never "not migrated yet": the framework is not ported)
	const fwCalls = db.prepare(`SELECT c.to_id FROM code_calls c JOIN symbols s ON s.id = c.from_id WHERE s.unit_id = ? AND c.to_id IS NOT NULL AND c.resolution = 'framework'`).all(unitId) as Array<{ to_id: string }>;
	const resolvedDeps: TaskCard["resolvedDeps"] = [];
	const unresolvedDeps: string[] = [];
	for (const { to_id } of outEdges) {
		if (ids.has(to_id)) continue;
		const isFile = !to_id.includes("::");
		const targets = db.prepare(isFile ? "SELECT m.src_symbol, m.op, m.target_symbols FROM moves m JOIN symbols s ON s.id = m.src_symbol WHERE s.path = ? AND s.state IN ('accepted','tested','mapped')" : "SELECT m.src_symbol, m.op, m.target_symbols FROM moves m JOIN symbols s ON s.id = m.src_symbol WHERE m.src_symbol = ? AND s.state IN ('accepted','tested','mapped')").all(to_id) as Array<{ src_symbol: string; op: string; target_symbols: string }>;
		if (targets.length) for (const t of targets) resolvedDeps.push({ source: t.src_symbol, target: JSON.parse(t.target_symbols), op: t.op });
		else if (!isFile) unresolvedDeps.push(to_id);
	}

	const inIds = [...ids].map(() => "?").join(",") || "''";
	// calls inside functions come from the code map; file-scope calls (templates, scripts) only exist as symbol-level deps
	const callers = (db.prepare(`SELECT DISTINCT d.from_id AS "from", d.kind FROM index_deps d WHERE d.to_id IN (${inIds}) AND d.from_id NOT IN (${inIds}) AND (d.kind NOT IN ('call','static_call') OR d.from_id NOT IN (SELECT id FROM code_functions))
		UNION SELECT DISTINCT c.from_id AS "from", 'call' AS kind FROM code_calls c WHERE c.to_id IN (${inIds}) AND c.from_id NOT IN (${inIds}) AND c.resolution = 'code'`).all(...ids, ...ids, ...ids, ...ids) as Array<{ from: string; kind: string }>) ?? [];

	// dup candidates: same ast_hash inside the unit, or against anything already accepted (source side; target dedupe comes from target_lookup)
	const dupCandidates: TaskCard["dupCandidates"] = [];
	const hashes = db.prepare(`SELECT id, ast_hash FROM index_symbols WHERE id IN (${[...ids].map(() => "?").join(",") || "''"}) AND ast_hash IS NOT NULL AND kind IN ('function','method')`).all(...ids) as Array<{ id: string; ast_hash: string }>;
	for (const h of hashes) {
		const same = db.prepare("SELECT i.id, s.state FROM index_symbols i JOIN symbols s ON s.id = i.id WHERE i.ast_hash = ? AND i.id != ? AND i.kind IN ('function','method')").all(h.ast_hash, h.id) as Array<{ id: string; state: string }>;
		for (const o of same) if (o.id > h.id || !ids.has(o.id)) dupCandidates.push({ a: h.id, b: o.id, reason: `identical normalized AST${ids.has(o.id) ? " (same unit)" : ` (other unit, state ${o.state})`}` });
	}

	const routes = db.prepare(`SELECT method, path, handler_symbol AS handler FROM index_routes WHERE handler_symbol IN (${[...ids].map(() => "?").join(",") || "''"})`).all(...ids) as TaskCard["routes"];
	const queries = (db.prepare(`SELECT symbol_id AS symbol, tables, text FROM index_queries WHERE symbol_id IN (${[...ids].map(() => "?").join(",") || "''"}) AND tables != '[]'`).all(...ids) as Array<{ symbol: string; tables: string; text: string | null }>).map((q) => ({ ...q, tables: JSON.parse(q.tables) as string[] }));
	const truthCases = (db.prepare("SELECT COUNT(*) n FROM truth_cases WHERE unit_id = ? AND verified_on_old = 1").get(unitId) as { n: number }).n;
	const truthRead = (db.prepare("SELECT COUNT(*) n FROM truth_cases WHERE unit_id = ? AND verified_on_old = 0").get(unitId) as { n: number }).n;

	// legacy framework classes this unit leans on → what the platform provides (from the framework plan + decisions)
	const fwRefs: TaskCard["frameworkRefs"] = [];
	const fwFiles = new Set((db.prepare("SELECT path FROM files WHERE disposition = 'framework'").all() as Array<{ path: string }>).map((r) => r.path));
	if (fwFiles.size) {
		const plan = ledger.getMeta("framework_plan");
		const concerns = plan ? (JSON.parse(plan) as { concerns: Array<{ concern: string; verdict: string; platform: string; top: string[] }> }).concerns : [];
		const counts = new Map<string, number>();
		for (const { to_id } of [...outEdges, ...fwCalls]) {
			const path = to_id.split("::")[0]!;
			if (!fwFiles.has(path)) continue;
			const cls = to_id.split("::")[1] ?? path.split("/").pop()!;
			counts.set(cls, (counts.get(cls) ?? 0) + 1);
		}
		for (const [cls, n] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
			const c = concerns.find((k) => k.top.some((t) => t.replace(/\(\d+\)$/, "") === cls));
			fwRefs.push({ cls, refs: n, verdict: c?.verdict ?? "review", platform: c?.platform ?? "see RULES.md → Legacy framework mapping" });
		}
	}
	const stackId = opts.place?.stackId ?? opts.adapter.id;
	const sharedHelpers = sharedSymbols(ledger, opts.adapter.layout.sharedDirs, undefined, 30, stackId);
	const reuseHints = similarTargetSymbols(ledger, symbols.map((s) => s.name), 15, stackId);
	const candidates = reuseCandidates(ledger, unitId, { stack: stackId, limit: 8 });
	const tidy = opts.place ? tidyTaskCard(ledger, stackId, opts.place.area) : "";
	const stateOf = db.prepare("SELECT state FROM symbols WHERE id = ?");
	const tree = callTree(ledger, files, { stateOf: (id) => (stateOf.get(id) as { state: string } | undefined)?.state });
	return { unit, files, symbols, resolvedDeps, unresolvedDeps, callers, dupCandidates, routes, queries, dynamicMarkers: meta.dynamic_markers ?? [], cutDeps: meta.cutDeps ?? [], frameworkRefs: fwRefs, callTree: tree, truthCases, truthRead, sharedHelpers, reuseHints, reuseCandidates: candidates, tidyTasks: tidy, targetProjectDir: opts.targetProjectDir, writeGlobs: opts.writeGlobs, sharedDirs: opts.adapter.layout.sharedDirs, dataAccessHint: opts.adapter.layout.dataAccessHint, place: opts.place, moduleDir: opts.moduleDir, areaModule: opts.place && opts.moduleDir ? areaModule(ledger, config, unitId, opts.place, opts.moduleDir, opts) : undefined };
}

/** Current state of the unit's area module: files on disk, their indexed exports, and the other units placed there. */
function areaModule(ledger: Ledger, config: Config, unitId: string, place: Placement, moduleDir: string, opts: { targetProjectDir: string; adapter: TargetAdapter; root?: string }): AreaModule {
	const dir = moduleDir.replace(/\/$/, "");
	const onDisk = filesUnder(opts.targetProjectDir, dir);
	const rels = onDisk.filter((f) => !opts.adapter.layout.isTestFile(`${dir}/${f}`));
	// index paths are project-relative (stacks can collide): trust only rows for files this project has
	const byPath = new Map<string, AreaModule["files"][number]["symbols"]>();
	for (const r of ledger.db.prepare("SELECT path, kind, name, signature FROM index_symbols WHERE side = 'target' AND path LIKE ? AND (tags IS NULL OR tags NOT LIKE '%\"stack:%' OR tags LIKE ?) ORDER BY path, line").all(`${dir}/%`, stackTagLike(place.stackId)) as Array<{ path: string; kind: string; name: string; signature: string | null }>) {
		const list = byPath.get(r.path) ?? [];
		list.push({ name: r.name, kind: r.kind, signature: r.signature });
		byPath.set(r.path, list);
	}
	const files = rels.map((f) => ({ path: f, symbols: byPath.get(`${dir}/${f}`) ?? [] }));
	const syms = files.flatMap((f) => f.symbols);
	const owners = new Set(syms.filter((s) => s.kind === "method").map((s) => s.name.split(".")[0]!));
	const classes = syms.filter((s) => !s.name.includes(".") && (s.kind === "class" || owners.has(s.name))).map((s) => s.name);

	const siblings: AreaModule["siblings"] = [];
	const moves = ledger.db.prepare("SELECT target_symbols FROM moves WHERE unit_id = ?");
	for (const u of ledger.listUnits()) {
		if (u.id === unitId) continue;
		let p: Placement;
		try {
			p = placeUnit(config, u.meta, opts.root);
		} catch {
			continue;
		}
		if (p.stackId !== place.stackId || p.area !== place.area || p.shared !== place.shared) continue;
		const targetFiles = u.state === "accepted" ? [...new Set((moves.all(u.id) as Array<{ target_symbols: string }>).flatMap((m) => (JSON.parse(m.target_symbols) as string[]).map((t) => t.split("::")[0]!)))].sort() : [];
		siblings.push({ id: u.id, state: u.state, targetFiles });
	}
	return { area: place.area, stackId: place.stackId, moduleDir: dir, shared: place.shared, structureDoc: opts.adapter.layout.structureDoc, files, testFiles: onDisk.length - rels.length, classes, siblings };
}

function renderAreaModule(a: AreaModule, L: string[]): void {
	L.push("", `## Area module (binding): ${a.area} on ${a.stackId} → ${a.moduleDir}/${a.shared ? " (shared: used by several areas; add new files, never edit existing ones)" : ""}`);
	L.push(`One legacy area = one module per stack. Everything this unit writes goes under ${a.moduleDir}/, and every unit of the area extends the same classes instead of adding parallel ones.`);
	if (a.shared) L.push(`This unit is shared (used by several areas): its files are topic files directly in ${a.moduleDir}/, named as the layout below names files; the feature-dir shapes are for the code that imports it.`);
	L.push("File shape inside the module:", a.structureDoc);
	if (!a.files.length) L.push("", `### ${a.moduleDir}/ is empty: this unit creates the area's first files; later units of the area will extend them.`);
	else {
		L.push("", `### Current contents of ${a.moduleDir}/ — extend these${a.classes.length ? `: add methods to ${a.classes.slice(0, 4).join(", ")} rather than new classes` : ""}`);
		let budget = MAX_AREA_SYMBOLS;
		for (const f of a.files.slice(0, MAX_AREA_FILES)) {
			L.push(`- ${f.path}`);
			const shown = f.symbols.slice(0, Math.max(0, budget));
			for (const s of shown) L.push(`  - ${s.name.includes(".") ? "" : `${s.kind} `}${s.name}${s.signature ?? ""}`);
			budget -= shown.length;
			if (f.symbols.length > shown.length) L.push(`  - (${f.symbols.length - shown.length} more exports omitted; target_lookup)`);
		}
		if (a.files.length > MAX_AREA_FILES) L.push(`- (${a.files.length - MAX_AREA_FILES} more files omitted; target_lookup)`);
	}
	if (a.testFiles) L.push(`(${a.testFiles} test files in the module not listed)`);
	if (!a.siblings.length) return;
	L.push("", "### Same-area units (they share this module: reuse what accepted ones built, leave room for the planned ones)");
	const accepted = a.siblings.filter((s) => s.state === "accepted");
	for (const s of accepted.slice(0, MAX_ACCEPTED)) L.push(`- accepted ${s.id}${s.targetFiles.length ? ` → ${s.targetFiles.slice(0, MAX_SIBLING_FILES).join(", ")}${s.targetFiles.length > MAX_SIBLING_FILES ? ` (+${s.targetFiles.length - MAX_SIBLING_FILES} more)` : ""}` : ""}`);
	if (accepted.length > MAX_ACCEPTED) L.push(`- (${accepted.length - MAX_ACCEPTED} more accepted units omitted)`);
	const others = a.siblings.filter((s) => s.state !== "accepted");
	const shown = others.slice(0, MAX_OTHER_SIBLINGS);
	const byState = new Map<string, string[]>();
	for (const s of shown) byState.set(s.state, [...(byState.get(s.state) ?? []), s.id]);
	for (const [state, ids] of byState) L.push(`- ${state}: ${ids.join(", ")}`);
	if (others.length > shown.length) L.push(`- (${others.length - shown.length} more units omitted)`);
}

/** Markdown rendering of the card for the prompt. Source files are appended in full (whole file in one pass). */
export function renderTaskCard(card: TaskCard, config: Config, opts: { includeSource?: boolean } = { includeSource: true }): string {
	const L: string[] = [];
	L.push(`# Unit ${card.unit.id}  (tier ${card.unit.tier}${card.unit.kind ? `, kind ${card.unit.kind}` : ""})`);
	L.push(`Source files (${config.source.stack}, read-only): ${card.files.join(", ")}`);
	L.push(`Target: ${card.place?.stackId ?? config.target.stacks.join(" + ")} project at ${card.targetProjectDir}. You may write only: ${card.writeGlobs.join(", ")}`);
	if (card.areaModule) renderAreaModule(card.areaModule, L);
	if (card.tidyTasks) L.push("", "## Tidy tasks for this area (do these too)", card.tidyTasks, "Moves whose source is already gone were done by the orchestrator: update the imports. Merged sources are removed once every target exists.");
	L.push("");
	L.push("## Symbols you must account for (every one needs a ledger_prove call)");
	for (const s of card.symbols) L.push(`- ${s.id}  [${s.kind}${s.exported ? "" : ", private"}]${s.signature ? ` ${s.signature}` : ""}`);
	if (card.resolvedDeps.length) {
		L.push("", "## Already migrated dependencies — import these, do not re-port");
		for (const d of card.resolvedDeps) L.push(`- ${d.source} → ${d.target.join(", ")} (${d.op})`);
	}
	if (card.unresolvedDeps.length) L.push("", `## Dependencies not migrated yet (stub minimal interfaces, mark TODO(br:${card.unit.id})): ${card.unresolvedDeps.join(", ")}`);
	if (card.callers.length) L.push("", `## Called from: ${card.callers.map((c) => `${c.from} (${c.kind})`).join(", ")} — keep behaviour compatible`);
	if (card.dupCandidates.length) {
		L.push("", "## Duplicate candidates (dedupe: keep one target symbol, prove the other as merged_into)");
		for (const d of card.dupCandidates) L.push(`- ${d.a} ≡ ${d.b}: ${d.reason}`);
	}
	if (card.frameworkRefs.length) {
		L.push("", "## Legacy framework classes used here → platform replacement (never port the framework itself)");
		for (const f of card.frameworkRefs) L.push(`- ${f.cls} (${f.refs}×): ${f.verdict} → ${f.platform}`);
	}
	if (card.callTree.length) {
		L.push("", "## Where this code leads (calls outside this unit, file to file; [state] = migration state; read_function <id> to read one)");
		L.push(...card.callTree);
	}
	if (card.cutDeps.length) {
		L.push("", "## Forward references (cycle cut: these legacy files are scheduled AFTER this unit)");
		L.push("Code against an interface or type you declare in this unit; do not port them here, do not stub their behaviour.");
		for (const f of card.cutDeps) L.push(`- ${f}`);
	}
	if (card.routes.length) {
		L.push("", "## Routes");
		for (const r of card.routes) L.push(`- ${r.method ?? "ANY"} ${r.path} → ${r.handler}`);
	}
	if (card.queries.length) {
		L.push("", `## Database access${card.dataAccessHint ? ` (${card.dataAccessHint})` : ""}`);
		for (const q of card.queries) L.push(`- ${q.symbol}: tables ${q.tables.join(", ")}${q.text ? ` — \`${q.text.slice(0, 80)}\`` : ""}`);
	}
	if (card.dynamicMarkers.length) L.push("", `## Dynamic constructs found (handle explicitly): ${card.dynamicMarkers.join(", ")}`);
	if (card.sharedHelpers.length) {
		L.push("", `## Shared helpers that already exist (reuse; new files only inside these existing topics of ${card.sharedDirs[0] ?? "the shared dir"}, never edit existing ones, never start a topic)`);
		for (const h of card.sharedHelpers) L.push(`- ${h.id} [${h.kind}]${h.signature ? ` ${h.signature}` : ""}${h.doc ? ` — ${h.doc}` : ""}`);
	} else L.push("", `## Shared helpers: none yet. Code of this unit goes in its module; shared topics (${card.sharedDirs[0] ?? "the shared dir"}<topic>/) are started by shared units and tidy tasks, never named after an area.`);
	if (card.reuseCandidates.length) {
		L.push("", "## Reuse candidates — this logic may already exist (found by meaning): import/inject it instead of rewriting; find_capability for more");
		for (const c of card.reuseCandidates) L.push(`- for ${c.legacy}: ${renderCapability(c.capability)}`);
	}
	if (card.reuseHints.length) {
		L.push("", "## Possibly already migrated elsewhere (target_lookup before creating)");
		for (const h of card.reuseHints) L.push(`- ${h.legacy} ~ ${h.id} [${h.kind}]`);
	}
	L.push("", `## Truth: ${card.truthCases} characterization cases verified on the old code${card.truthRead ? `, ${card.truthRead} read from the old code but not run (it cannot run here)` : ""} (truth_lookup tool)`);
	if (opts.includeSource) {
		for (const f of card.files) {
			L.push("", `## Source: ${f}`, "```" + config.source.stack);
			L.push(readFileSync(join(config.source.path, f), "utf8"));
			L.push("```");
		}
	}
	return L.join("\n");
}

/** Files under `dir` of the project (relative to `dir`), tests included. Uncapped: the renderer bounds and says so. */
function filesUnder(projectDir: string, dir: string): string[] {
	const root = join(projectDir, dir);
	const out: string[] = [];
	const visit = (d: string) => {
		if (!existsSync(d)) return;
		for (const n of readdirSync(d).sort()) {
			const p = join(d, n);
			if (statSync(p).isDirectory()) visit(p);
			else out.push(relative(root, p));
		}
	};
	visit(root);
	return out;
}
