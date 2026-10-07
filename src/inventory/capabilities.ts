import type { Config } from "../config.ts";
import type { Ledger } from "../ledger/db.ts";
import type { ModelClient } from "../models/types.ts";

/**
 * Capability cards: reusable business logic made findable by meaning, not by name. After a unit is accepted, a
 * model reads the exported target symbols of its changed files (+ the legacy symbols they came from) and writes
 * one card each: a domain-language summary, domain terms with synonyms, inputs → outputs. Cards are searched
 * with SQLite FTS5 (stemming, bm25):
 *  - `find_capability` (implementer + tester tool),
 *  - `reuseCandidates` (orchestrator, before a unit starts: put on the task card).
 * Stack-neutral: symbols come from the target index the adapters fill.
 */
export interface Capability {
	id: string;
	stack: string;
	area: string | null;
	path: string;
	name: string;
	kind: string;
	summary: string;
	terms: string;
	io: string | null;
	legacy: string[];
	score?: number;
}

const SKIP_KINDS = new Set(["module", "dto", "interface", "const", "enum", "test", "page"]);

export async function describeCapabilities(d: { ledger: Ledger; config: Config; client?: ModelClient }, o: { unitId: string; stack: string; area?: string; files: string[]; projectDir?: string }): Promise<{ cards: number; costUsd: number }> {
	if (!d.client || !o.files.length) return { cards: 0, costUsd: 0 };
	const marks = o.files.map(() => "?").join(",");
	const syms = d.ledger.db.prepare(`SELECT id, path, kind, name, signature, doc FROM index_symbols WHERE side = 'target' AND exported = 1 AND path IN (${marks}) ORDER BY path, line LIMIT 60`).all(...o.files) as Array<{ id: string; path: string; kind: string; name: string; signature: string | null; doc: string | null }>;
	const useful = syms.filter((s) => !SKIP_KINDS.has(s.kind));
	if (!useful.length) return { cards: 0, costUsd: 0 };
	const moves = d.ledger.db.prepare("SELECT src_symbol, target_symbols FROM moves WHERE unit_id = ?").all(o.unitId) as Array<{ src_symbol: string; target_symbols: string }>;
	const legacyOf = (id: string) => moves.filter((m) => (JSON.parse(m.target_symbols) as string[]).some((t) => t === id || id.startsWith(`${t}.`) || t.startsWith(`${id}.`))).map((m) => m.src_symbol);
	const role = d.config.models.implement;
	const res = await d.client.chat({
		model: role.id,
		tier: role.tier as "default" | "flex" | "priority",
		effort: "low",
		schema: {
			type: "object",
			additionalProperties: false,
			required: ["cards"],
			properties: {
				cards: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						required: ["id", "reusable", "summary", "terms", "io"],
						properties: {
							id: { type: "string" },
							reusable: { type: "boolean", description: "false for pure wiring/glue nobody else would call" },
							summary: { type: "string", description: "one sentence in the business domain's words: what it computes/decides/fetches/changes" },
							terms: { type: "string", description: "8–20 domain words and synonyms a developer might search for, incl. legacy names" },
							io: { type: "string", description: "inputs → output, short" },
						},
					},
				},
			},
		},
		messages: [
			{ role: "system", content: "You catalogue reusable business logic of a codebase being migrated, so other developers find it by meaning before writing it again. Describe what each symbol does for the business, not how." },
			{ role: "user", content: `Symbols (stack ${o.stack}${o.area ? `, area ${o.area}` : ""}):\n${useful.map((s) => `- ${s.id} [${s.kind}] ${s.signature ?? ""}${s.doc ? `\n  doc: ${s.doc}` : ""}${legacyOf(s.id).length ? `\n  from legacy: ${legacyOf(s.id).join(", ")}` : ""}`).join("\n")}` },
		],
	});
	const cards = ((res.json ?? {}) as { cards?: Array<{ id: string; reusable: boolean; summary: string; terms: string; io: string }> }).cards ?? [];
	const ins = d.ledger.db.prepare("INSERT OR REPLACE INTO capabilities(id, stack, area, path, name, kind, summary, terms, io, legacy, unit_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
	const delFts = d.ledger.db.prepare("DELETE FROM capabilities_fts WHERE id = ?");
	const insFts = d.ledger.db.prepare("INSERT INTO capabilities_fts(id, name, summary, terms) VALUES (?, ?, ?, ?)");
	let n = 0;
	for (const c of cards) {
		const s = useful.find((x) => x.id === c.id);
		if (!s || !c.reusable) continue;
		ins.run(s.id, o.stack, o.area ?? null, s.path, s.name, s.kind, c.summary, c.terms, c.io, JSON.stringify(legacyOf(s.id)), o.unitId, new Date().toISOString());
		delFts.run(s.id);
		insFts.run(s.id, splitName(s.name), c.summary, c.terms);
		n++;
	}
	return { cards: n, costUsd: res.usage.costUsd };
}

/** Ranked search over the cards. Free words; any word may match (bm25 ranks those matching more first). */
export function findCapabilities(ledger: Ledger, query: string, opts: { stack?: string; limit?: number; excludeUnit?: string } = {}): Capability[] {
	const words = [...new Set(splitName(query).toLowerCase().split(/[^a-z0-9äöüß]+/).filter((w) => w.length > 2 && !STOP.has(w)))];
	if (!words.length) return [];
	const match = words.map((w) => `"${w}"`).join(" OR ");
	const rows = ledger.db
		.prepare(`SELECT c.*, bm25(capabilities_fts, 0, 2.0, 1.0, 1.5) score FROM capabilities_fts f JOIN capabilities c ON c.id = f.id WHERE capabilities_fts MATCH ? ${opts.stack ? "AND c.stack = ?" : ""} ${opts.excludeUnit ? "AND (c.unit_id IS NULL OR c.unit_id != ?)" : ""} ORDER BY score LIMIT ?`)
		.all(...([match, opts.stack, opts.excludeUnit, opts.limit ?? 8].filter((x) => x !== undefined) as Array<string | number>)) as Array<Omit<Capability, "legacy"> & { legacy: string }>;
	return rows.map((r) => ({ ...r, legacy: JSON.parse(r.legacy) as string[] }));
}

/**
 * Before a unit starts: capabilities that may already cover its legacy symbols. Query per symbol = its name
 * words + the words of the legacy symbols it calls; only good matches (≥ 2 words hit) are returned.
 */
export function reuseCandidates(ledger: Ledger, unitId: string, opts: { stack?: string; limit?: number } = {}): Array<{ legacy: string; capability: Capability }> {
	const syms = ledger.db.prepare("SELECT id, name FROM symbols WHERE unit_id = ?").all(unitId) as Array<{ id: string; name: string }>;
	const out: Array<{ legacy: string; capability: Capability }> = [];
	const seen = new Set<string>();
	for (const s of syms) {
		const callees = ledger.db.prepare("SELECT to_id FROM index_deps WHERE from_id = ? LIMIT 8").all(s.id) as Array<{ to_id: string }>;
		const q = [s.name, ...callees.map((c) => c.to_id.split("::").pop()!)].join(" ");
		for (const c of findCapabilities(ledger, q, { stack: opts.stack, limit: 3, excludeUnit: unitId })) {
			if (seen.has(c.id)) continue;
			const own = splitName(s.name).toLowerCase().split(/\s+/).filter((w) => w.length > 2);
			const hay = `${splitName(c.name)} ${c.summary} ${c.terms}`.toLowerCase();
			if (own.filter((w) => hay.includes(w)).length < Math.min(2, own.length)) continue;
			seen.add(c.id);
			out.push({ legacy: s.id, capability: c });
		}
		if (out.length >= (opts.limit ?? 10)) break;
	}
	return out;
}

export function renderCapability(c: Capability): string {
	return `${c.id}  [${c.kind}${c.area ? `, area ${c.area}` : ""}, ${c.stack}]\n    ${c.summary}${c.io ? `\n    ${c.io}` : ""}${c.legacy.length ? `\n    from legacy: ${c.legacy.join(", ")}` : ""}`;
}

/** `calcAvailableSlots` / `calc_available_slots` / `Flight::getSlots` → "calc Available Slots" etc. */
function splitName(s: string): string {
	return s.replace(/::|\.|_|-/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

const STOP = new Set(["get", "set", "the", "and", "for", "with", "from", "this", "that", "new", "class", "function", "return", "value", "data", "list", "item", "items", "index", "default"]);
