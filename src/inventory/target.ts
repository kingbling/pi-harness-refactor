import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { TargetAdapter } from "../adapters/types.ts";
import type { Ledger } from "../ledger/db.ts";

/**
 * Target-side index: what already exists in the NEW codebase. Re-run on every accepted unit (changed
 * files only) so `target_lookup`, `shared_lookup`, the task card's reuse hints and `pattern_examples`
 * can push "reuse this, do not reimplement" as the codebase grows. Stack-neutral: the adapter parses.
 */
export async function indexTarget(ledger: Ledger, adapter: TargetAdapter, projectDir: string, files?: string[]): Promise<number> {
	if (!adapter.indexFile) return 0;
	const L = adapter.layout;
	const rels = (files ?? listSources(projectDir, L.sourceExtensions)).filter((f) => L.sourceExtensions.some((e) => f.endsWith(e)) && !L.isTestFile(f));
	const del = ledger.db.prepare("DELETE FROM index_symbols WHERE side = 'target' AND path = ?");
	const ins = ledger.db.prepare("INSERT OR REPLACE INTO index_symbols(id, side, path, kind, name, line, signature, exported, ast_hash, doc, tags) VALUES (?, 'target', ?, ?, ?, ?, ?, 1, NULL, ?, ?)");
	let n = 0;
	ledger.db.exec("BEGIN");
	try {
		for (const rel of rels) {
			del.run(rel);
			if (!existsSync(join(projectDir, rel))) continue;
			for (const s of await adapter.indexFile(projectDir, rel)) {
				ins.run(s.id, s.path, s.kind, s.name, s.line, s.signature ?? null, s.doc ?? null, JSON.stringify(s.tags));
				n++;
			}
		}
		ledger.db.exec("COMMIT");
	} catch (e) {
		ledger.db.exec("ROLLBACK");
		throw e;
	}
	return n;
}

/** Exported helpers in the adapter's shared dirs (+ anything indexed as helper), optionally filtered by words over name/doc/path. */
export function sharedSymbols(ledger: Ledger, sharedDirs: string[], query?: string, limit = 40): Array<{ id: string; kind: string; signature: string | null; doc: string | null }> {
	const where = [...sharedDirs.map(() => "path LIKE ?"), "kind = 'helper'"].join(" OR ");
	const args: unknown[] = sharedDirs.map((d) => `${d}%`);
	let sql = `SELECT id, kind, signature, doc FROM index_symbols WHERE side = 'target' AND (${where})`;
	if (query) {
		for (const t of query.toLowerCase().split(/\s+/).filter(Boolean)) {
			sql += " AND (lower(name) LIKE ? OR lower(doc) LIKE ? OR lower(path) LIKE ?)";
			args.push(`%${t}%`, `%${t}%`, `%${t}%`);
		}
	}
	sql += " ORDER BY path, line LIMIT ?";
	args.push(limit);
	return ledger.db.prepare(sql).all(...(args as any[])) as Array<{ id: string; kind: string; signature: string | null; doc: string | null }>;
}

/** Target symbols whose name resembles one of the given legacy short names (cheap reuse hint for the task card). */
export function similarTargetSymbols(ledger: Ledger, legacyNames: string[], limit = 15): Array<{ legacy: string; id: string; kind: string }> {
	const out: Array<{ legacy: string; id: string; kind: string }> = [];
	const stmt = ledger.db.prepare("SELECT id, kind FROM index_symbols WHERE side = 'target' AND lower(name) LIKE ? LIMIT 3");
	for (const n of legacyNames) {
		const short = n.split("::").pop()!.replace(/^(get|set|is|has)_?/i, "").replace(/_/g, "").toLowerCase();
		if (short.length < 4) continue;
		for (const r of stmt.all(`%${short}%`) as Array<{ id: string; kind: string }>) out.push({ legacy: n, id: r.id, kind: r.kind });
		if (out.length >= limit) break;
	}
	return out;
}

function listSources(dir: string, exts: string[]): string[] {
	const out: string[] = [];
	const visit = (d: string) => {
		if (!existsSync(d)) return;
		for (const n of readdirSync(d)) {
			if (["node_modules", "dist", "build", ".git", "vendor", "test", "tests", "__tests__"].includes(n)) continue;
			const p = join(d, n);
			if (statSync(p).isDirectory()) visit(p);
			else if (exts.some((e) => n.endsWith(e))) out.push(relative(dir, p));
		}
	};
	visit(join(dir, "src"));
	return out.sort();
}
