import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import type { Config } from "../config.ts";
import { searchDocs } from "../init/docs.ts";
import { MOVE_OPS, type MoveOp } from "../ledger/schema.ts";
import type { Ledger } from "../ledger/db.ts";
import { captures, parse } from "../inventory/treesitter.ts";
import { sharedSymbols, stackTagLike } from "../inventory/target.ts";
import type { TargetAdapter } from "../adapters/types.ts";
import { QUIRK_KINDS, recordQuirk, type QuirkKind } from "../run/quirks.ts";
import { proposeRule } from "../rules/living.ts";
import { rulesDir } from "../rules/layout.ts";
import { findCapabilities, renderCapability } from "../inventory/capabilities.ts";

/**
 * Pull tools for leaf sessions. All read from the ledger index (source AND target side) so answers
 * are instant and consistent across 30 parallel sessions. `ledger_prove` is the one write: it is how
 * an implementer accounts for every source symbol (the gate refuses units with unproven symbols).
 */
export interface ToolDeps {
	ledger: Ledger;
	config: Config;
	unitId: string;
	attemptId?: number;
	root: string; // project root (where bigrefactor.config.json lives)
	targetProjectDir: string;
	adapter: TargetAdapter;
	/** The unit's area module (from placement), relative to the target project; lookups rank it first. */
	moduleDir?: string;
}

const text = (t: string, details: unknown = {}) => ({ content: [{ type: "text" as const, text: t }], details });
/** Keeps `params` typed from the TypeBox schema while returning the generic ToolDefinition Pi expects. */
const def = <T extends TSchema>(t: ToolDefinition<T>): ToolDefinition => t as unknown as ToolDefinition;

export function symbolLookup(d: ToolDeps): ToolDefinition {
	return def({
		name: "symbol_lookup",
		label: "Symbol lookup",
		description: "Look up a source symbol by exact id (path::Name or path::Class::method) or by name. Returns kind, file, line, signature, state in the ledger, and its outgoing dependencies.",
		promptSnippet: "symbol_lookup: facts about any legacy symbol (where, signature, deps, migration state)",
		parameters: Type.Object({ query: Type.String({ description: "symbol id or bare name" }) }),
		execute: async (_id, p) => {
			const rows = d.ledger.db
				.prepare("SELECT s.id, s.kind, s.path, s.state, s.unit_id, i.line, i.signature FROM symbols s LEFT JOIN index_symbols i ON i.id = s.id WHERE s.id = ? OR s.name = ? OR s.name LIKE ? LIMIT 10")
				.all(p.query, p.query, `%::${p.query}`) as Array<any>;
			if (!rows.length) return text(`no symbol matches "${p.query}"`);
			const out = rows.map((r) => {
				const deps = d.ledger.db.prepare("SELECT to_id, kind FROM index_deps WHERE from_id = ?").all(r.id) as Array<{ to_id: string; kind: string }>;
				const moves = d.ledger.db.prepare("SELECT op, target_symbols, why FROM moves WHERE src_symbol = ?").all(r.id) as Array<{ op: string; target_symbols: string; why: string }>;
				return `${r.id}  [${r.kind}] ${r.path}:${r.line ?? "?"}${r.signature ? ` ${r.signature}` : ""}\n  state=${r.state} unit=${r.unit_id ?? "-"}${deps.length ? `\n  deps: ${deps.map((x) => `${x.to_id} (${x.kind})`).join(", ")}` : ""}${moves.length ? `\n  migrated: ${moves.map((m) => `${m.op} → ${JSON.parse(m.target_symbols).join(", ")} (${m.why})`).join("; ")}` : ""}`;
			});
			return text(out.join("\n\n"));
		},
	});
}

export function whoCalls(d: ToolDeps): ToolDefinition {
	return def({
		name: "who_calls",
		label: "Who calls",
		description: "All call sites / references of a source symbol across the legacy codebase (from the index), plus string-literal mentions that may be dynamic dispatch.",
		promptSnippet: "who_calls: every caller of a legacy symbol",
		parameters: Type.Object({ symbolId: Type.String() }),
		execute: async (_id, p) => {
			const callers = d.ledger.db.prepare("SELECT from_id, kind FROM index_deps WHERE to_id = ?").all(p.symbolId) as Array<{ from_id: string; kind: string }>;
			const name = p.symbolId.split("::").pop()!;
			const literal = d.ledger.db.prepare("SELECT DISTINCT path FROM index_literal_refs WHERE name = ?").all(name) as Array<{ path: string }>;
			return text(
				`${callers.length} static reference(s)${callers.length ? ":\n" + callers.map((c) => `- ${c.from_id} (${c.kind})`).join("\n") : ""}` +
					(literal.length ? `\n${literal.length} string-literal mention(s) of "${name}" (possible dynamic dispatch): ${literal.map((l) => l.path).join(", ")}` : ""),
			);
		},
	});
}

export function sourceSymbolBody(d: ToolDeps): ToolDefinition {
	return def({
		name: "source_symbol_body",
		label: "Source symbol body",
		description: "Exact source code of one legacy symbol (function, method, class) extracted via tree-sitter, so you never need to read whole unrelated files.",
		promptSnippet: "source_symbol_body: code of one legacy symbol",
		parameters: Type.Object({ symbolId: Type.String() }),
		execute: async (_id, p) => {
			const row = d.ledger.db.prepare("SELECT path, name, kind FROM symbols WHERE id = ?").get(p.symbolId) as { path: string; name: string; kind: string } | undefined;
			if (!row) return text(`unknown symbol ${p.symbolId}`);
			const src = readFileSync(join(d.config.source.path, row.path), "utf8");
			const tree = await parse(d.config.source.stack, src);
			const short = row.name.split("::").pop()!;
			const q = row.kind === "method" ? `(method_declaration name: (name) @n)` : row.kind === "function" ? `(function_definition name: (name) @n)` : row.kind === "class" ? `(class_declaration name: (name) @n)` : `(const_element (name) @n)`;
			for (const c of await captures(d.config.source.stack, tree, q)) {
				if (c.node.text !== short) continue;
				const decl = c.node.parent!;
				return text("```" + d.config.source.stack + `\n// ${row.path}:${decl.startPosition.row + 1}\n` + decl.text + "\n```");
			}
			return text(`could not locate ${p.symbolId} in ${row.path}`);
		},
	});
}

export function targetLookup(d: ToolDeps): ToolDefinition {
	return def({
		name: "target_lookup",
		label: "Target lookup",
		description: "Search symbols that already exist in the NEW codebase (accepted migrations): by name fragment, or by the legacy symbol they came from. Results in this unit's area module come first. Use before writing anything that might already exist; query \"*\" lists the area's existing symbols.",
		promptSnippet: "target_lookup: what already exists in the new codebase (reuse, do not duplicate)",
		parameters: Type.Object({ query: Type.String({ description: "name fragment, or a legacy symbol id to find its migrated counterpart" }) }),
		execute: async (_id, p) => {
			if (p.query === "*" && d.moduleDir) {
				const rows = d.ledger.db.prepare("SELECT id, kind, path, line, signature FROM index_symbols WHERE side = 'target' AND path LIKE ? AND tags LIKE ? ORDER BY path, line LIMIT 60").all(`${d.moduleDir}/%`, stackTagLike(d.adapter.id)) as Array<any>;
				return text(rows.length ? rows.map((r) => `${r.id}  [${r.kind}] ${r.path}:${r.line}${r.signature ? ` ${r.signature}` : ""}`).join("\n") : `the area module ${d.moduleDir}/ is empty — you create its first files`);
			}
			const viaMoves = d.ledger.db.prepare("SELECT src_symbol, op, target_symbols, why FROM moves WHERE src_symbol = ? OR src_symbol LIKE ?").all(p.query, `%::${p.query}`) as Array<{ src_symbol: string; op: string; target_symbols: string; why: string }>;
			const q = `%${p.query.toLowerCase()}%`;
			const area = d.moduleDir ? `${d.moduleDir}/%` : "";
			const direct = d.ledger.db.prepare("SELECT id, kind, path, line, signature, doc FROM index_symbols WHERE side = 'target' AND tags LIKE ? AND (lower(name) LIKE ? OR lower(id) LIKE ? OR lower(doc) LIKE ?) ORDER BY (path LIKE ?) DESC LIMIT 15").all(stackTagLike(d.adapter.id), q, q, q, area) as Array<any>;
			const out: string[] = [];
			for (const m of viaMoves) out.push(`${m.src_symbol} was ${m.op} → ${JSON.parse(m.target_symbols).join(", ")}  (${m.why})`);
			for (const r of direct) out.push(`${r.id}  [${r.kind}] ${r.path}:${r.line}${r.signature ? ` ${r.signature}` : ""}${r.doc ? `\n    ${r.doc}` : ""}`);
			return text(out.length ? out.join("\n") : `nothing in the target codebase matches "${p.query}" — you are creating it`);
		},
	});
}

export function patternExamples(d: ToolDeps): ToolDefinition {
	return def({
		name: "pattern_examples",
		label: "Pattern examples",
		description: "The 3 most recently accepted target files of a kind (controller, service, dto, repository, module, test, page, component, hook). Copy their structure, naming and imports.",
		promptSnippet: "pattern_examples: how accepted code of a kind looks in this codebase",
		parameters: Type.Object({ kind: Type.String(), limit: Type.Optional(Type.Number()) }),
		execute: async (_id, p) => {
			const rows = d.ledger.db.prepare("SELECT path FROM index_symbols WHERE side = 'target' AND kind = ? AND tags LIKE ? GROUP BY path ORDER BY MAX(path LIKE ?) DESC, MAX(rowid) DESC LIMIT ?").all(p.kind, stackTagLike(d.adapter.id), d.moduleDir ? `${d.moduleDir}/%` : "", p.limit ?? 3) as Array<{ path: string }>;
			if (!rows.length) {
				const idioms = safeRead(join(rulesDir(d.root, d.adapter.id), "idioms.json"));
				return text(`no accepted ${p.kind} yet. Follow RULES.md and the idiom table${idioms ? `:\n${idioms.slice(0, 3000)}` : ""}.`);
			}
			return text(rows.map((r) => `### ${r.path}\n\`\`\`ts\n${safeRead(join(d.targetProjectDir, r.path))?.slice(0, 4000) ?? "(missing)"}\n\`\`\``).join("\n\n"));
		},
	});
}

export function sharedLookup(d: ToolDeps): ToolDefinition {
	return def({
		name: "shared_lookup",
		label: "Shared helpers",
		description: `Cross-cutting helpers that already exist in the new codebase (errors, logging, money, dates, validation, pagination, …) under ${d.adapter.layout.sharedDirs.join(" | ")}. Call with no query to see everything, or with words to filter. REUSE these; never reimplement one. You may add a new file there but never edit an existing one.`,
		promptSnippet: "shared_lookup: existing cross-cutting helpers to reuse (errors, logging, money, dates…)",
		parameters: Type.Object({ query: Type.Optional(Type.String()) }),
		execute: async (_id, p) => {
			const rows = sharedSymbols(d.ledger, d.adapter.layout.sharedDirs, p.query, 40, d.adapter.id);
			return text(rows.length ? rows.map((r) => `${r.id}  [${r.kind}]${r.signature ? ` ${r.signature}` : ""}${r.doc ? `\n    ${r.doc}` : ""}`).join("\n") : `no shared helpers${p.query ? ` match "${p.query}"` : " yet"} — if you need a cross-cutting helper, create it under ${d.adapter.layout.sharedDirs[0] ?? "the shared dir"}<area>/ with a doc comment so others find it`);
		},
	});
}

export function docsLookup(d: ToolDeps): ToolDefinition {
	return def({
		name: "docs_lookup",
		label: "Docs lookup",
		description: "Search the official documentation fetched at init for every technology in this migration (source stack and all target stacks). All terms must match on one line; returns surrounding snippet.",
		promptSnippet: "docs_lookup: official docs for every technology in this migration",
		parameters: Type.Object({ query: Type.String(), tech: Type.Optional(Type.String({ description: "technology name as in .bigrefactor/docs/<tech>/" })) }),
		execute: async (_id, p) => {
			const hits = searchDocs(d.root, p.query, { tech: p.tech, limit: 6 });
			return text(hits.length ? hits.map((h) => `--- ${h.tech}/${h.name}:${h.line}\n${h.snippet}`).join("\n\n") : `no docs match "${p.query}"${p.tech ? ` in ${p.tech}` : ""}; try fewer words`);
		},
	});
}

export function truthLookup(d: ToolDeps): ToolDefinition {
	return def({
		name: "truth_lookup",
		label: "Truth cases",
		description: "Characterization cases recorded against the OLD code for a symbol of this unit: inputs → expected output. These are the behaviour you must preserve.",
		promptSnippet: "truth_lookup: recorded old-code behaviour for a symbol",
		parameters: Type.Object({ symbolId: Type.Optional(Type.String()) }),
		execute: async (_id, p) => {
			const rows = d.ledger.db.prepare(`SELECT symbol_id, inputs, expected FROM truth_cases WHERE unit_id = ? AND verified_on_old = 1 ${p.symbolId ? "AND symbol_id = ?" : ""} ORDER BY symbol_id, id`).all(...(p.symbolId ? [d.unitId, p.symbolId] : [d.unitId])) as Array<{ symbol_id: string; inputs: string; expected: string }>;
			return text(rows.length ? rows.map((r) => `${r.symbol_id}: ${r.inputs} → ${r.expected}`).join("\n") : "no verified truth cases for this unit yet");
		},
	});
}

export function ledgerProve(d: ToolDeps): ToolDefinition {
	return def({
		name: "ledger_prove",
		label: "Ledger prove",
		description:
			"Record what happened to ONE legacy symbol of this unit. Required for every symbol in the task card before you finish. op: moved (1:1 port), extracted (split into several target symbols), merged_into (deduplicated into an existing/another target symbol), inlined (body folded into its caller), split, dropped (not needed in the new system — say why). targetSymbols are target ids like `src/invoices/pricing.service.ts::PricingService.lineTotal`.",
		promptSnippet: "ledger_prove: account for each legacy symbol (moved/extracted/merged_into/inlined/split/dropped + why)",
		promptGuidelines: ["Call ledger_prove once per legacy symbol in the task card; the unit cannot pass the gate with unproven symbols."],
		parameters: Type.Object({
			srcSymbol: Type.String(),
			op: Type.Union(MOVE_OPS.map((o) => Type.Literal(o))),
			targetSymbols: Type.Optional(Type.Array(Type.String())),
			why: Type.String({ description: "one sentence a reviewer can verify" }),
		}),
		execute: async (_id, p) => {
			const sym = d.ledger.getSymbol(p.srcSymbol);
			if (!sym) return text(`unknown symbol ${p.srcSymbol}; use the exact ids from the task card`, { error: true });
			if (sym.unit_id !== d.unitId) return text(`${p.srcSymbol} belongs to unit ${sym.unit_id}, not ${d.unitId}; only prove your own symbols`, { error: true });
			try {
				d.ledger.prove({ unitId: d.unitId, srcSymbol: p.srcSymbol, op: p.op as MoveOp, targetSymbols: p.targetSymbols, why: p.why, attemptId: d.attemptId });
			} catch (e: any) {
				return text(`rejected: ${e?.message ?? e}`, { error: true });
			}
			const left = d.ledger.db.prepare("SELECT COUNT(*) n FROM symbols WHERE unit_id = ? AND state IN ('clustered','in_progress')").get(d.unitId) as { n: number };
			return text(`recorded ${p.op} for ${p.srcSymbol}. ${left.n} symbol(s) of this unit still unproven.`, { left: left.n });
		},
	});
}

export function findCapabilityTool(d: ToolDeps): ToolDefinition {
	return def({
		name: "find_capability",
		label: "Find capability",
		description: "Search the business logic that already exists in the NEW codebase by meaning: describe what you need in domain words (e.g. \"available screen slots of a flight\", \"agency invoice total\"). Returns capability cards (what it does, inputs → output, legacy origin), best first, across all areas. Call it before implementing any calculation, rule, lookup or workflow; reuse (import/inject) what fits instead of rewriting it.",
		promptSnippet: "find_capability: existing business logic by meaning (reuse before writing)",
		parameters: Type.Object({ need: Type.String({ description: "what the code must do, in domain words" }), stack: Type.Optional(Type.String({ description: "limit to one target stack" })) }),
		execute: async (_id, p) => {
			const hits = findCapabilities(d.ledger, p.need, { stack: p.stack, limit: 8 });
			return text(hits.length ? hits.map(renderCapability).join("\n") : `no capability matches "${p.need}" yet — you are the first to implement it; give it a doc comment so others find it`);
		},
	});
}

export function recordQuirkTool(d: ToolDeps): ToolDefinition {
	return def({
		name: "record_quirk",
		label: "Record quirk",
		description:
			"Record an oddity of the OLD code instead of pinning it blindly: a language artifact (loose emptiness/truthiness, implicit coercion), an edge case, a suspected bug, or intentional-looking odd behaviour. Give your opinion: drop (the new code implements the intended behaviour) or keep (callers depend on it). Language artifacts with opinion drop are dropped without asking; everything else is asked to the owner. Write your test cases the way your opinion says.",
		promptSnippet: "record_quirk: note a legacy oddity with your opinion (drop|keep) instead of pinning it",
		parameters: Type.Object({
			symbolId: Type.String({ description: "legacy symbol id from the task card" }),
			kind: Type.Union(QUIRK_KINDS.map((k) => Type.Literal(k))),
			behaviour: Type.String({ description: "what the old code does, concretely" }),
			example: Type.Optional(Type.String({ description: "input → output on the old code" })),
			opinion: Type.Union([Type.Literal("drop"), Type.Literal("keep")]),
			why: Type.String({ description: "one or two sentences: who could depend on it, what the intended behaviour is" }),
		}),
		execute: async (_id, p) => {
			const sym = d.ledger.getSymbol(p.symbolId);
			if (!sym || sym.unit_id !== d.unitId) return text(`${p.symbolId} is not a symbol of ${d.unitId}; use ids from the task card`, { error: true });
			const r = recordQuirk(d, { unitId: d.unitId, symbolId: p.symbolId, kind: p.kind as QuirkKind, behaviour: p.behaviour, example: p.example, opinion: p.opinion as "drop" | "keep", why: p.why });
			return text(r.status === "dropped" ? `quirk #${r.id} dropped (language artifact): do not pin it; test the intended behaviour.` : `quirk #${r.id} recorded; the owner will be asked. Write the cases following your opinion (${p.opinion}).`, r);
		},
	});
}

export function proposeRuleTool(d: ToolDeps): ToolDefinition {
	return def({
		name: "propose_rule",
		label: "Propose rule",
		description: `Propose an addition or change to the ${d.adapter.id} rules when you learn something other units will need (a convention, a reusable pattern, a pitfall in this codebase, a missing mapping). A curator merges proposals into the next rules version; changes that break already-migrated code are asked to the owner. Not for one-off details of this unit.`,
		promptSnippet: "propose_rule: suggest a rule the other units of this stack should follow",
		parameters: Type.Object({
			kind: Type.Union([Type.Literal("add"), Type.Literal("change")]),
			text: Type.String({ description: "the rule as it should read, one or two lines" }),
			why: Type.String(),
			evidence: Type.Optional(Type.String({ description: "files or symbol ids that show it" })),
		}),
		execute: async (_id, p) => {
			const id = proposeRule(d, { stack: d.adapter.id, unitId: d.unitId, kind: p.kind as "add" | "change", text: p.text, why: p.why, evidence: p.evidence });
			return text(`proposal #${id} recorded for the ${d.adapter.id} rules; keep following the current rules for this unit.`);
		},
	});
}

export function implementerTools(d: ToolDeps): ToolDefinition[] {
	return [symbolLookup(d), whoCalls(d), sourceSymbolBody(d), targetLookup(d), sharedLookup(d), patternExamples(d), docsLookup(d), truthLookup(d), ledgerProve(d), findCapabilityTool(d), proposeRuleTool(d)];
}
export function testerTools(d: ToolDeps): ToolDefinition[] {
	return [symbolLookup(d), whoCalls(d), sourceSymbolBody(d), targetLookup(d), sharedLookup(d), docsLookup(d), findCapabilityTool(d), recordQuirkTool(d), proposeRuleTool(d)];
}

function safeRead(p: string): string | undefined {
	try {
		return readFileSync(p, "utf8");
	} catch {
		return undefined;
	}
}
