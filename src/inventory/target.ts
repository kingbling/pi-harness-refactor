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
	const rels = (files ?? listSources(projectDir, L.sourceExtensions, L.ignoreDirs)).filter((f) => L.sourceExtensions.some((e) => f.endsWith(e)) && !L.isTestFile(f));
	// several stacks share one ledger with project-relative paths: rows carry a stack tag (see stackTagLike)
	const del = ledger.db.prepare("DELETE FROM index_symbols WHERE side = 'target' AND path = ? AND (tags IS NULL OR tags NOT LIKE '%\"stack:%' OR tags LIKE ?)");
	const ins = ledger.db.prepare("INSERT OR REPLACE INTO index_symbols(id, side, path, kind, name, line, signature, exported, ast_hash, doc, tags) VALUES (?, 'target', ?, ?, ?, ?, ?, 1, ?, ?, ?)");
	let n = 0;
	ledger.db.exec("BEGIN");
	try {
		for (const rel of rels) {
			del.run(rel, stackTagLike(adapter.id));
			if (!existsSync(join(projectDir, rel))) continue;
			for (const s of await adapter.indexFile(projectDir, rel)) {
				if (s.tags.includes("internal")) continue; // non-exported bodies: the gate's copy check only
				ins.run(s.id, s.path, s.kind, s.name, s.line, s.signature ?? null, s.bodyHash ?? null, s.doc ?? null, JSON.stringify([...s.tags, `stack:${adapter.id}`]));
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

/** LIKE pattern matching the target index rows of one stack (tags JSON carries "stack:<id>"). */
export function stackTagLike(stackId: string): string {
	return `%"stack:${stackId}"%`;
}

type Row = { id: string; path: string; name: string };
/** Exported classes of one stack in the target index (the reuse check's "already exists"). */
export function targetClasses(ledger: Ledger, stackId: string): Row[] {
	return ledger.db.prepare("SELECT id, path, name FROM index_symbols WHERE side = 'target' AND tags LIKE '%\"class\"%' AND tags LIKE ?").all(stackTagLike(stackId)) as Row[];
}
/** Functions/methods of one stack whose normalized body hashes to `hash`. */
export function targetBodies(ledger: Ledger, stackId: string, hash: string): Row[] {
	return ledger.db.prepare("SELECT id, path, name FROM index_symbols WHERE side = 'target' AND ast_hash = ? AND tags LIKE ?").all(hash, stackTagLike(stackId)) as Row[];
}

/** Exported helpers in the adapter's shared dirs (+ anything indexed as helper), optionally filtered by words over name/doc/path. */
export function sharedSymbols(ledger: Ledger, sharedDirs: string[], query?: string, limit = 40, stackId?: string): Array<{ id: string; kind: string; signature: string | null; doc: string | null }> {
	const where = [...sharedDirs.map(() => "path LIKE ?"), "kind = 'helper'"].join(" OR ");
	const args: unknown[] = sharedDirs.map((d) => `${d}%`);
	let sql = `SELECT id, kind, signature, doc FROM index_symbols WHERE side = 'target' AND (${where})`;
	if (stackId) {
		sql += " AND tags LIKE ?";
		args.push(stackTagLike(stackId));
	}
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
export function similarTargetSymbols(ledger: Ledger, legacyNames: string[], limit = 15, stackId?: string): Array<{ legacy: string; id: string; kind: string }> {
	const out: Array<{ legacy: string; id: string; kind: string }> = [];
	const stmt = ledger.db.prepare(`SELECT id, kind FROM index_symbols WHERE side = 'target' AND lower(name) LIKE ?${stackId ? " AND tags LIKE ?" : ""} LIMIT 3`);
	for (const n of legacyNames) {
		const short = n.split("::").pop()!.replace(/^(get|set|is|has)_?/i, "").replace(/_/g, "").toLowerCase();
		if (short.length < 4) continue;
		for (const r of stmt.all(...[`%${short}%`, ...(stackId ? [stackTagLike(stackId)] : [])]) as Array<{ id: string; kind: string }>) out.push({ legacy: n, id: r.id, kind: r.kind });
		if (out.length >= limit) break;
	}
	return out;
}

function listSources(dir: string, exts: string[], ignore: string[]): string[] {
	const out: string[] = [];
	const visit = (d: string) => {
		if (!existsSync(d)) return;
		for (const n of readdirSync(d)) {
			if (n.startsWith(".") || ignore.includes(n)) continue;
			const p = join(d, n);
			if (statSync(p).isDirectory()) visit(p);
			else if (exts.some((e) => n.endsWith(e))) out.push(relative(dir, p));
		}
	};
	visit(join(dir, "src"));
	return out.sort();
}
