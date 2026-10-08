import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeCall, CodeComment, CodeFunction, FileIndex } from "../adapters/types.ts";
import type { Ledger } from "../ledger/db.ts";

/**
 * Code map: every legacy function with its comments lifted out and its calls resolved, so agents can follow
 * "the way to the end" file to file without opening whole files. Adapters report syntax (FileIndex.functions /
 * containers); this module resolves calls stack-neutrally:
 *   receiver type → method through the inheritance chain; unknown type → unique method name, else ambiguous
 *   (candidates kept); targets under a framework dir → framework; nothing found → external (builtin/vendor).
 */
export type Resolution = "code" | "framework" | "ambiguous" | "external";

export interface ResolvedCall {
	from: string;
	seq: number;
	line: number;
	kind: CodeCall["kind"];
	name: string;
	resolution: Resolution;
	to?: string;
	candidates?: string[];
}

export interface CodeMapRows {
	functions: Array<CodeFunction & { path: string; bodyHash?: string }>;
	calls: ResolvedCall[];
}

const MAX_CANDIDATES = 8;

export function resolveCodeMap(indexes: FileIndex[], isFramework: (path: string) => boolean, opts: { caseInsensitive?: boolean } = {}): CodeMapRows {
	// name semantics come from the adapter (some languages match names regardless of case)
	const key = (n: string) => (opts.caseInsensitive ? n.toLowerCase() : n);
	const fnPath = new Map<string, string>();
	const fnById = new Map<string, CodeFunction>();
	const classDecls = new Map<string, Array<{ id: string; path: string }>>(); // class key → every declaration
	const parents = new Map<string, { parent?: string; uses?: string[] }>();
	const methods = new Map<string, Map<string, string[]>>(); // class key → method key → ids (one per declaring file)
	const byMethodName = new Map<string, string[]>(); // method key → ids
	const globals = new Map<string, string[]>(); // function key → ids
	const hashOf = new Map<string, string | undefined>();
	const functions: CodeMapRows["functions"] = [];
	const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => m.set(k, [...(m.get(k) ?? []), v]);

	for (const f of indexes) {
		for (const s of f.symbols) {
			hashOf.set(s.id, s.astHash);
			if (["class", "interface", "trait", "enum"].includes(s.kind)) push(classDecls, key(s.name), { id: s.id, path: f.path });
		}
		for (const c of f.containers ?? []) if (!parents.has(key(c.name)) || !isFramework(f.path)) parents.set(key(c.name), { parent: c.parent, uses: c.uses });
		for (const fn of f.functions ?? []) {
			fnPath.set(fn.id, f.path);
			fnById.set(fn.id, fn);
			functions.push({ ...fn, path: f.path, bodyHash: hashOf.get(fn.id) });
			if (fn.container) {
				const m = methods.get(key(fn.container)) ?? new Map<string, string[]>();
				push(m, key(fn.name), fn.id);
				methods.set(key(fn.container), m);
				push(byMethodName, key(fn.name), fn.id);
			} else push(globals, key(fn.name), fn.id);
		}
	}
	const pathOf = (id: string) => fnPath.get(id) ?? id.split("::")[0]!;
	const app = (ids: string[]) => ids.filter((x) => !isFramework(pathOf(x)));
	/** One target, or the candidates when several files declare it (same-named classes): app declarations win over framework ones. */
	const pick = (ids: string[]): Pick<ResolvedCall, "resolution" | "to" | "candidates"> => {
		const own = app(ids);
		const pool = own.length ? own : ids;
		if (pool.length === 1) return { resolution: own.length ? "code" : "framework", to: pool[0] };
		return { resolution: own.length ? "ambiguous" : "framework", candidates: pool.slice(0, MAX_CANDIDATES) };
	};
	/** Method `name` on `cls`, through parents and used traits: the declarations of the first class in the chain that has it. */
	const lookup = (cls: string | undefined, name: string): { ids?: string[]; reachesFramework: boolean } => {
		const seen = new Set<string>();
		const queue = cls ? [key(cls)] : [];
		let reachesFramework = false;
		while (queue.length) {
			const c = queue.shift()!;
			if (seen.has(c) || seen.size > 20) continue;
			seen.add(c);
			if ((classDecls.get(c) ?? []).some((d) => isFramework(d.path))) reachesFramework = true;
			const hit = methods.get(c)?.get(key(name));
			if (hit?.length) return { ids: hit, reachesFramework };
			const p = parents.get(c);
			if (p?.uses) queue.push(...p.uses.map(key));
			if (p?.parent) queue.push(key(p.parent));
		}
		return { reachesFramework };
	};

	const calls: ResolvedCall[] = [];
	for (const fn of fnById.values()) {
		const memo = new Map<number, Pick<ResolvedCall, "resolution" | "to" | "candidates">>();
		const typeOfCall = (i: number): string | undefined => {
			const c = fn.calls[i];
			if (!c) return undefined;
			if (c.kind === "new") return c.name;
			const r = resolveAt(i);
			return r.to && r.resolution !== "ambiguous" ? fnById.get(r.to)?.returns : undefined;
		};
		const receiverType = (c: CodeCall): string | undefined => {
			if (c.receiver === "this") return fn.container;
			if (c.receiverCall !== undefined) return typeOfCall(c.receiverCall);
			if (!c.receiver) return undefined;
			const declared = fn.locals[c.receiver];
			if (declared) return declared;
			const from = fn.assigned[c.receiver];
			return from !== undefined ? typeOfCall(from) : undefined;
		};
		const resolveAt = (i: number): Pick<ResolvedCall, "resolution" | "to" | "candidates"> => {
			const hit = memo.get(i);
			if (hit) return hit;
			memo.set(i, { resolution: "external" }); // cycle guard: indices point at other call sites, a loop means no type
			const c = fn.calls[i]!;
			let r: Pick<ResolvedCall, "resolution" | "to" | "candidates"> = { resolution: "external" };
			if (c.kind === "new") {
				const decls = classDecls.get(key(c.name));
				if (decls?.length) r = pick(decls.map((d) => d.id));
			} else if (c.kind === "function") {
				const ids = globals.get(key(c.name));
				if (ids?.length) r = pick(ids);
			} else {
				const cls = c.kind === "static" ? (c.scope === "self" ? fn.container : c.scope === "parent" ? parents.get(key(fn.container ?? ""))?.parent : c.scope) : receiverType(c);
				if (cls) {
					// receiver type known: only that class's chain counts; a miss is the framework (if the chain reaches it) or external
					const l = lookup(cls, c.name);
					if (l.ids) r = pick(l.ids);
					else if (l.reachesFramework) r = { resolution: "framework", to: classDecls.get(key(cls))?.[0]?.id };
				} else if (c.kind === "member") {
					// receiver type unknown: by name; a single app method wins only if no framework method shares the name
					const all = byMethodName.get(key(c.name)) ?? [];
					const own = app(all);
					if (own.length === 1 && all.length === 1) r = { resolution: "code", to: own[0] };
					else if (own.length) r = { resolution: "ambiguous", candidates: [...own, ...all.filter((x) => !own.includes(x))].slice(0, MAX_CANDIDATES) };
					else if (all.length) r = { resolution: "framework", candidates: all.slice(0, MAX_CANDIDATES) };
				}
			}
			memo.set(i, r);
			return r;
		};
		fn.calls.forEach((c, i) => {
			const r = resolveAt(i);
			calls.push({ from: fn.id, seq: i, line: c.line, kind: c.kind, name: c.name, ...r });
		});
	}
	return { functions, calls };
}

/** Writes the code map inside the caller's transaction. */
export function writeCodeMap(ledger: Ledger, rows: CodeMapRows): void {
	const db = ledger.db;
	const old = new Map((db.prepare("SELECT id, body_hash FROM code_functions").all() as Array<{ id: string; body_hash: string | null }>).map((r) => [r.id, r.body_hash]));
	const upsert = db.prepare(`INSERT INTO code_functions(id, path, container, name, line, end_line, signature, returns, comments, body_hash) VALUES (?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET path=excluded.path, container=excluded.container, name=excluded.name, line=excluded.line, end_line=excluded.end_line,
		signature=excluded.signature, returns=excluded.returns, comments=excluded.comments, body_hash=excluded.body_hash`);
	const seen = new Set<string>();
	for (const f of rows.functions) {
		seen.add(f.id);
		upsert.run(f.id, f.path, f.container ?? null, f.name, f.line, f.endLine, f.signature, f.returns ?? null, JSON.stringify(f.comments), f.bodyHash ?? null);
	}
	const del = db.prepare("DELETE FROM code_functions WHERE id = ?");
	for (const id of old.keys()) if (!seen.has(id)) del.run(id);
	db.exec("DELETE FROM code_calls");
	const ins = db.prepare("INSERT INTO code_calls(from_id, seq, line, kind, name, resolution, to_id, candidates) VALUES (?,?,?,?,?,?,?,?)");
	for (const c of rows.calls) ins.run(c.from, c.seq, c.line, c.kind, c.name, c.resolution, c.to ?? null, c.candidates ? JSON.stringify(c.candidates) : null);
}

export interface FunctionRow {
	id: string;
	path: string;
	container: string | null;
	name: string;
	line: number;
	end_line: number;
	signature: string | null;
	returns: string | null;
	comments: string;
}

/** A function by id, or by `Class::name` / bare name when unique. */
export function findFunction(ledger: Ledger, ref: string): FunctionRow | undefined {
	const db = ledger.db;
	const byId = db.prepare("SELECT * FROM code_functions WHERE id = ?").get(ref) as FunctionRow | undefined;
	if (byId) return byId;
	const [a, b] = ref.includes("::") ? ref.split("::").slice(-2) : [undefined, ref];
	const rows = (a ? db.prepare("SELECT * FROM code_functions WHERE container = ? AND name = ? LIMIT 2").all(a, b) : db.prepare("SELECT * FROM code_functions WHERE name = ? LIMIT 2").all(b)) as unknown as FunctionRow[];
	return rows.length === 1 ? rows[0] : undefined;
}

export function functionsInFiles(ledger: Ledger, files: string[]): FunctionRow[] {
	if (!files.length) return [];
	return ledger.db.prepare(`SELECT * FROM code_functions WHERE path IN (${files.map(() => "?").join(",")}) ORDER BY path, line`).all(...files) as unknown as FunctionRow[];
}

export function callsFrom(ledger: Ledger, id: string): ResolvedCall[] {
	return (ledger.db.prepare("SELECT from_id, seq, line, kind, name, resolution, to_id, candidates FROM code_calls WHERE from_id = ? ORDER BY seq").all(id) as Array<any>).map(toCall);
}

export function callersOf(ledger: Ledger, ids: string[]): ResolvedCall[] {
	if (!ids.length) return [];
	return (ledger.db.prepare(`SELECT from_id, seq, line, kind, name, resolution, to_id, candidates FROM code_calls WHERE to_id IN (${ids.map(() => "?").join(",")}) ORDER BY from_id, seq`).all(...ids) as Array<any>).map(toCall);
}

function toCall(r: any): ResolvedCall {
	return { from: r.from_id, seq: r.seq, line: r.line, kind: r.kind, name: r.name, resolution: r.resolution, to: r.to_id ?? undefined, candidates: r.candidates ? JSON.parse(r.candidates) : undefined };
}

/**
 * Where this unit's code leads outside its own files, depth-first to `depth` levels, deduplicated ("seen above")
 * and bounded to `maxLines` with an announced cut. Framework calls are summarized per target, not followed.
 */
export function callTree(ledger: Ledger, unitFiles: string[], opts: { depth?: number; maxLines?: number; stateOf?: (id: string) => string | undefined } = {}): string[] {
	const depth = opts.depth ?? 4;
	const maxLines = opts.maxLines ?? 40;
	const own = new Set(unitFiles);
	const fnPath = ledger.db.prepare("SELECT path, line, end_line FROM code_functions WHERE id = ?");
	const lines: string[] = [];
	const shown = new Set<string>();
	let cut = 0;
	const framework = new Map<string, number>();
	const ambiguous = new Map<string, string[]>();
	const visit = (id: string, level: number) => {
		for (const c of callsFrom(ledger, id)) {
			if (c.resolution === "framework") framework.set(c.to ?? c.name, (framework.get(c.to ?? c.name) ?? 0) + 1);
			if (c.resolution === "ambiguous" && level === 0) ambiguous.set(`${c.name}()`, c.candidates ?? []);
			if (c.resolution !== "code" || !c.to) continue;
			const where = fnPath.get(c.to) as { path: string; line: number; end_line: number } | undefined;
			const path = where?.path ?? c.to.split("::")[0]!;
			if (own.has(path)) {
				if (level === 0 && !shown.has(c.to)) {
					shown.add(c.to);
					visit(c.to, level); // helpers inside the unit: follow them without indenting
				}
				continue;
			}
			if (lines.length >= maxLines) {
				cut++;
				continue;
			}
			const label = `${"  ".repeat(level)}- ${shortId(c.to)} @ ${path}${where ? ` L${where.line}-${where.end_line}` : ""}${opts.stateOf?.(c.to) ? ` [${opts.stateOf(c.to)}]` : ""}`;
			if (shown.has(c.to)) continue; // each target once
			shown.add(c.to);
			lines.push(label);
			if (level + 1 < depth) visit(c.to, level + 1);
		}
	};
	for (const f of functionsInFiles(ledger, unitFiles)) {
		if (shown.has(f.id)) continue;
		shown.add(f.id);
		visit(f.id, 0);
	}
	if (cut) lines.push(`- (${cut} more calls omitted; read_function / who_calls to go deeper)`);
	if (ambiguous.size) lines.push(`- ambiguous (receiver type unknown; check with read_function): ${[...ambiguous].slice(0, 8).map(([n, c]) => `${n} → ${c.slice(0, 3).map(shortId).join(" | ")}${c.length > 3 ? " | …" : ""}`).join("; ")}`);
	if (framework.size) lines.push(`- framework: ${[...framework].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t, n]) => `${shortId(t)} ${n}×`).join(", ")}`);
	return lines;
}

const shortId = (id: string) => (id.includes("::") ? id.split("::").slice(1).join("::") : id);

/**
 * Reading view of one function: comments lifted out (documentation and notes listed above the code with their
 * line numbers; commented-out code and banners dropped), indentation stripped unless the language needs it.
 * Line positions are kept (blank where a comment was), so `L<start>` + offset is the original line number.
 */
export function readFunction(ledger: Ledger, sourceRoot: string, ref: string, opts: { indentSignificant?: boolean } = {}): string | undefined {
	const f = findFunction(ledger, ref);
	if (!f) return undefined;
	const all = readFileSync(join(sourceRoot, f.path), "utf8").split("\n");
	const comments = JSON.parse(f.comments) as CodeComment[];
	const start = Math.min(f.line, ...comments.map((c) => c.line));
	const lines = all.slice(start - 1, f.end_line);
	// blank out every comment span (positions are 0-based columns on 1-based lines)
	for (const c of comments) {
		for (let ln = c.line; ln <= c.endLine; ln++) {
			const i = ln - start;
			if (i < 0 || i >= lines.length) continue;
			const text = lines[i]!;
			const from = ln === c.line ? c.col : 0;
			const to = ln === c.endLine ? c.endCol : text.length;
			lines[i] = text.slice(0, from) + " ".repeat(Math.max(0, to - from)) + text.slice(to);
		}
	}
	const body = lines.map((l) => (opts.indentSignificant ? l.trimEnd() : l.trim())).join("\n");
	const kept = comments.filter((c) => c.kind !== "code" && c.kind !== "banner");
	const dropped = comments.length - kept.length;
	const tidy = (c: CodeComment) => (c.body ?? c.text).split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
	const out = [`${f.id}  (${f.path} L${f.line}-${f.end_line}${start < f.line ? `, doc from L${start}` : ""})`];
	if (kept.length) out.push("comments:", ...kept.map((c) => `  L${c.line} ${c.kind === "doc" ? "[doc] " : ""}${tidy(c)}`));
	if (dropped) out.push(`(${dropped} commented-out code / banner comment${dropped > 1 ? "s" : ""} removed)`);
	out.push(`code (starts at L${start}, line positions kept):`, body.trim() ? body : "(empty)");
	return out.join("\n");
}
