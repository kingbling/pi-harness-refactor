import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { Ledger, UnitRow } from "../ledger/db.ts";
import { sharedSymbols, similarTargetSymbols } from "../inventory/target.ts";
import type { TargetAdapter } from "../adapters/types.ts";

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
	truthCases: number;
	/** Cross-cutting helpers that already exist in the target (reuse, never reimplement). */
	sharedHelpers: Array<{ id: string; kind: string; signature: string | null; doc: string | null }>;
	/** Target symbols whose names resemble this unit's legacy symbols — check before creating. */
	reuseHints: Array<{ legacy: string; id: string; kind: string }>;
	targetProjectDir: string;
	writeGlobs: string[];
	sharedDirs: string[];
}

export function buildTaskCard(ledger: Ledger, config: Config, unitId: string, opts: { targetProjectDir: string; writeGlobs: string[]; adapter: TargetAdapter }): TaskCard {
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
	const outEdges = db.prepare(`SELECT DISTINCT d.to_id FROM index_deps d JOIN symbols s ON s.id = d.from_id WHERE s.unit_id = ?`).all(unitId) as Array<{ to_id: string }>;
	const resolvedDeps: TaskCard["resolvedDeps"] = [];
	const unresolvedDeps: string[] = [];
	for (const { to_id } of outEdges) {
		if (ids.has(to_id)) continue;
		const isFile = !to_id.includes("::");
		const targets = db.prepare(isFile ? "SELECT m.src_symbol, m.op, m.target_symbols FROM moves m JOIN symbols s ON s.id = m.src_symbol WHERE s.path = ? AND s.state IN ('accepted','tested','mapped')" : "SELECT m.src_symbol, m.op, m.target_symbols FROM moves m JOIN symbols s ON s.id = m.src_symbol WHERE m.src_symbol = ? AND s.state IN ('accepted','tested','mapped')").all(to_id) as Array<{ src_symbol: string; op: string; target_symbols: string }>;
		if (targets.length) for (const t of targets) resolvedDeps.push({ source: t.src_symbol, target: JSON.parse(t.target_symbols), op: t.op });
		else if (!isFile) unresolvedDeps.push(to_id);
	}

	const callers = (db.prepare(`SELECT DISTINCT d.from_id AS "from", d.kind FROM index_deps d WHERE d.to_id IN (${[...ids].map(() => "?").join(",") || "''"}) AND d.from_id NOT IN (${[...ids].map(() => "?").join(",") || "''"})`).all(...ids, ...ids) as Array<{ from: string; kind: string }>) ?? [];

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

	// legacy framework classes this unit leans on → what the platform provides (from the framework plan + decisions)
	const fwRefs: TaskCard["frameworkRefs"] = [];
	const fwFiles = new Set((db.prepare("SELECT path FROM files WHERE disposition = 'framework'").all() as Array<{ path: string }>).map((r) => r.path));
	if (fwFiles.size) {
		const plan = ledger.getMeta("framework_plan");
		const concerns = plan ? (JSON.parse(plan) as { concerns: Array<{ concern: string; verdict: string; platform: string; top: string[] }> }).concerns : [];
		const counts = new Map<string, number>();
		for (const { to_id } of outEdges) {
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
	const sharedHelpers = sharedSymbols(ledger, opts.adapter.layout.sharedDirs, undefined, 30);
	const reuseHints = similarTargetSymbols(ledger, symbols.map((s) => s.name));
	return { unit, files, symbols, resolvedDeps, unresolvedDeps, callers, dupCandidates, routes, queries, dynamicMarkers: meta.dynamic_markers ?? [], cutDeps: meta.cutDeps ?? [], frameworkRefs: fwRefs, truthCases, sharedHelpers, reuseHints, targetProjectDir: opts.targetProjectDir, writeGlobs: opts.writeGlobs, sharedDirs: opts.adapter.layout.sharedDirs };
}

/** Markdown rendering of the card for the prompt. Source files are appended in full (whole file in one pass). */
export function renderTaskCard(card: TaskCard, config: Config, opts: { includeSource?: boolean } = { includeSource: true }): string {
	const L: string[] = [];
	L.push(`# Unit ${card.unit.id}  (tier ${card.unit.tier}${card.unit.kind ? `, kind ${card.unit.kind}` : ""})`);
	L.push(`Source files (${config.source.stack}, read-only): ${card.files.join(", ")}`);
	L.push(`Target: ${config.target.stacks.join(" + ")} project at ${card.targetProjectDir}. You may write only: ${card.writeGlobs.join(", ")}`);
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
		L.push("", "## Database access (DTOs required; keep-schema: tables stay as they are)");
		for (const q of card.queries) L.push(`- ${q.symbol}: tables ${q.tables.join(", ")}${q.text ? ` — \`${q.text.slice(0, 80)}\`` : ""}`);
	}
	if (card.dynamicMarkers.length) L.push("", `## Dynamic constructs found (handle explicitly): ${card.dynamicMarkers.join(", ")}`);
	if (card.sharedHelpers.length) {
		L.push("", `## Shared helpers that already exist (reuse; add new ones under ${card.sharedDirs[0] ?? "the shared dir"}, never edit existing)`);
		for (const h of card.sharedHelpers) L.push(`- ${h.id} [${h.kind}]${h.signature ? ` ${h.signature}` : ""}${h.doc ? ` — ${h.doc}` : ""}`);
	} else L.push("", `## Shared helpers: none yet. Cross-cutting code (errors, logging, money, dates, validation) goes to ${card.sharedDirs[0] ?? "the shared dir"}<area>/ with a doc comment so later units find it via shared_lookup.`);
	if (card.reuseHints.length) {
		L.push("", "## Possibly already migrated elsewhere (target_lookup before creating)");
		for (const h of card.reuseHints) L.push(`- ${h.legacy} ~ ${h.id} [${h.kind}]`);
	}
	L.push("", `## Truth: ${card.truthCases} characterization cases verified on the old code (truth_lookup tool)`);
	if (opts.includeSource) {
		for (const f of card.files) {
			L.push("", `## Source: ${f}`, "```" + config.source.stack);
			L.push(readFileSync(join(config.source.path, f), "utf8"));
			L.push("```");
		}
	}
	return L.join("\n");
}
