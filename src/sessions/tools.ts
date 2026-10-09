import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelClient } from "../models/types.ts";
import { caseIds, NO_BEHAVIOUR_FILE, READ_CASES_FILE, type TruthResult } from "../run/legacy-env.ts";
import { caseCoverage, checkTests } from "../run/ported.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import type { Config } from "../config.ts";
import { searchDocs } from "../init/docs.ts";
import { MOVE_OPS, type MoveOp } from "../ledger/schema.ts";
import type { Ledger } from "../ledger/db.ts";
import { callersOf, callsFrom, findFunction, readFunction } from "../inventory/codemap.ts";
import { getSourceAdapter } from "../adapters/registry.ts";
import { sharedSymbols, stackTagLike } from "../inventory/target.ts";
import type { TargetAdapter } from "../adapters/types.ts";
import { QUIRK_KINDS, quirkList, recordQuirk, sameQuirk, type QuirkKind } from "../run/quirks.ts";
import { decide, setDecisionAction } from "../jev/decide.ts";
import { choiceOf, JEV_ACT } from "../jev/questions.ts";
import { proposeRule } from "../rules/living.ts";
import { rulesDir } from "../rules/layout.ts";
import { slashed } from "../rules/layout-rules.ts";
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
	/** Implementer: a test it believes is wrong goes to the tester before the next attempt (see dispute_test). */
	onDispute?: (d: { test: string; why: string; evidence: string }) => void;
	/** Implementer: a bug in another unit's accepted code re-opens that unit; this one waits (see report_migrated_bug). */
	onReport?: (r: { owner: string; target: string; problem: string; evidence: string }) => void;
	/** Decision model for cheap judgements in tools (record_quirk: is this quirk already recorded?). */
	client?: ModelClient;
	/** Tester: the unit's truth dir (absolute), where no_behaviour_to_pin writes its declaration. */
	truthDir?: string;
	/** Tester: the truth cases as code would load them now (runs the truth script / reads cases.json), for check_ported_tests. */
	currentTruth?: () => TruthResult;
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
				const calls = callsFrom(d.ledger, r.id).filter((c) => c.to || c.candidates);
				const deps = [
					...(d.ledger.db.prepare("SELECT to_id, kind FROM index_deps WHERE from_id = ? AND (kind NOT IN ('call','static_call') OR from_id NOT IN (SELECT id FROM code_functions))").all(r.id) as Array<{ to_id: string; kind: string }>),
					...calls.map((c) => ({ to_id: c.to ?? `${c.name}() → ${c.candidates!.slice(0, 3).join(" | ")}`, kind: c.resolution === "code" ? `call L${c.line}` : `${c.resolution} L${c.line}` })),
				];
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
			const fromCalls = callersOf(d.ledger, [p.symbolId]).map((c) => ({ from_id: `${c.from} L${c.line}`, kind: `${c.kind} call` }));
			const callers = [...fromCalls, ...(d.ledger.db.prepare("SELECT from_id, kind FROM index_deps WHERE to_id = ? AND (kind NOT IN ('call','static_call') OR from_id NOT IN (SELECT id FROM code_functions))").all(p.symbolId) as Array<{ from_id: string; kind: string }>)];
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
		description: "Exact, unmodified source code of one legacy symbol (function, method, class) by its line span, so you never need to read whole unrelated files. For reading rather than pinning exact behaviour, read_function is shorter.",
		promptSnippet: "source_symbol_body: exact code of one legacy symbol",
		parameters: Type.Object({ symbolId: Type.String() }),
		execute: async (_id, p) => text(symbolBody(d, p.symbolId)),
	});
}

/** The exact legacy code of one symbol by its line span, headed by its path and lines (source_symbol_body's answer). */
function symbolBody(d: ToolDeps, symbolId: string): string {
	const row = d.ledger.db.prepare("SELECT s.path, i.line, i.end_line FROM symbols s LEFT JOIN index_symbols i ON i.id = s.id WHERE s.id = ?").get(symbolId) as { path: string; line: number | null; end_line: number | null } | undefined;
	if (!row) return `unknown symbol ${symbolId}`;
	const src = safeRead(join(d.config.source.path, row.path));
	if (src === undefined) return `cannot read ${row.path}`;
	const lines = src.split("\n");
	const fn = findFunction(d.ledger, symbolId);
	const from = fn?.line ?? row.line ?? 1;
	const end = fn?.end_line ?? row.end_line;
	// ledgers indexed before end lines existed: bounded slice instead of the rest of the file
	const to = end ?? Math.min(lines.length, from + 199);
	return `${row.path}:${from}-${to}\n` + "```" + d.config.source.stack + "\n" + lines.slice(from - 1, to).join("\n") + "\n```" + (end ? "" : `\n(end of the symbol unknown: showing at most 200 lines; re-run br inventory for exact spans)`);
}

export function readFunctionTool(d: ToolDeps): ToolDefinition {
	return def({
		name: "read_function",
		label: "Read function",
		description: "Reading view of one legacy function/method: its comments lifted out with line numbers, then the code without comments or indentation (line positions kept). Use it to follow the call tree on your task card; use source_symbol_body when you must pin exact text.",
		promptSnippet: "read_function: one legacy function, comments lifted out, ready to read",
		parameters: Type.Object({ id: Type.String({ description: "function id from the task card / who_calls, or Class::method" }) }),
		execute: async (_id, p) => {
			const adapter = (() => {
				try {
					return getSourceAdapter(d.config.source.stack);
				} catch {
					return undefined;
				}
			})();
			const view = readFunction(d.ledger, d.config.source.path, p.id, { indentSignificant: adapter?.reading?.indentSignificant });
			if (!view) return text(`no function "${p.id}" in the code map (symbol_lookup to find its id)`);
			const calls = callsFrom(d.ledger, findFunction(d.ledger, p.id)!.id).filter((c) => c.resolution !== "external");
			const callText = calls.length ? `\ncalls:\n${calls.map((c) => `  L${c.line} ${c.name}() → ${c.to ?? c.candidates?.slice(0, 3).join(" | ") ?? "?"} [${c.resolution}]`).join("\n")}` : "";
			return text(view + callText);
		},
	});
}

/** A stack without a symbol index (generated adapters): the lookups cannot tell what exists, so the model searches. */
const noIndex = (d: ToolDeps) => (d.adapter.indexFile ? "" : `the ${d.adapter.id} stack has no symbol index, so this tool cannot tell what code exists: search the target project with grep, ls and read before writing anything new`);

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
				if (!rows.length && noIndex(d)) return text(`${noIndex(d)} (start with ls ${d.moduleDir}/)`);
				return text(rows.length ? rows.map((r) => `${r.id}  [${r.kind}] ${r.path}:${r.line}${r.signature ? ` ${r.signature}` : ""}`).join("\n") : `the area module ${d.moduleDir}/ is empty — you create its first files`);
			}
			const viaMoves = d.ledger.db.prepare("SELECT src_symbol, op, target_symbols, why FROM moves WHERE src_symbol = ? OR src_symbol LIKE ?").all(p.query, `%::${p.query}`) as Array<{ src_symbol: string; op: string; target_symbols: string; why: string }>;
			const q = `%${p.query.toLowerCase()}%`;
			const area = d.moduleDir ? `${d.moduleDir}/%` : "";
			const direct = d.ledger.db.prepare("SELECT id, kind, path, line, signature, doc FROM index_symbols WHERE side = 'target' AND tags LIKE ? AND (lower(name) LIKE ? OR lower(id) LIKE ? OR lower(doc) LIKE ?) ORDER BY (path LIKE ?) DESC LIMIT 15").all(stackTagLike(d.adapter.id), q, q, q, area) as Array<any>;
			const out: string[] = [];
			for (const m of viaMoves) out.push(`${m.src_symbol} was ${m.op} → ${JSON.parse(m.target_symbols).join(", ")}  (${m.why})`);
			for (const r of direct) out.push(`${r.id}  [${r.kind}] ${r.path}:${r.line}${r.signature ? ` ${r.signature}` : ""}${r.doc ? `\n    ${r.doc}` : ""}`);
			if (noIndex(d)) out.push(`(${noIndex(d)})`);
			return text(out.length ? out.join("\n") : `nothing in the target codebase matches "${p.query}" — you are creating it`);
		},
	});
}

export function patternExamples(d: ToolDeps): ToolDefinition {
	return def({
		name: "pattern_examples",
		label: "Pattern examples",
		description: `The 3 most recently accepted target files of a kind (${d.adapter.patternKinds.join(", ")}). Copy their structure, naming and imports.`,
		promptSnippet: "pattern_examples: how accepted code of a kind looks in this codebase",
		parameters: Type.Object({ kind: Type.String(), limit: Type.Optional(Type.Number()) }),
		execute: async (_id, p) => {
			const rows = d.ledger.db.prepare("SELECT path FROM index_symbols WHERE side = 'target' AND kind = ? AND tags LIKE ? GROUP BY path ORDER BY MAX(path LIKE ?) DESC, MAX(rowid) DESC LIMIT ?").all(p.kind, stackTagLike(d.adapter.id), d.moduleDir ? `${d.moduleDir}/%` : "", p.limit ?? 3) as Array<{ path: string }>;
			if (!rows.length) {
				const idioms = safeRead(join(rulesDir(d.root, d.adapter.id), "idioms.json"));
				const head = noIndex(d) ? `no examples listed: ${noIndex(d)} (accepted files of this kind may exist).` : `no accepted ${p.kind} yet.`;
				return text(`${head} Follow RULES.md and the idiom table${idioms ? `:\n${idioms.slice(0, 3000)}` : ""}.`);
			}
			return text(rows.map((r) => `### ${r.path}\n\`\`\`${d.adapter.layout.lang(r.path) ?? ""}\n${safeRead(join(d.targetProjectDir, r.path))?.slice(0, 4000) ?? "(missing)"}\n\`\`\``).join("\n\n"));
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
			if (!rows.length && noIndex(d)) return text(`${noIndex(d)}; shared helpers live in topic folders under ${d.adapter.layout.sharedDirs.join(" | ") || "the shared dir"}: list them and read the files there`);
			return text(rows.length ? rows.map((r) => `${r.id}  [${r.kind}]${r.signature ? ` ${r.signature}` : ""}${r.doc ? `\n    ${r.doc}` : ""}`).join("\n") : `no shared helpers${p.query ? ` match "${p.query}"` : " yet"} — cross-cutting helpers live in topic folders named after what they do (${d.adapter.layout.sharedDirs[0] ? slashed(d.adapter.layout.sharedDirs[0]) : "the shared dir/"}<topic>/), never named after an area; add a file with a doc comment to an existing topic, or keep the code in your module`);
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
		description: "Characterization cases of the OLD code for a symbol of this unit: case id, inputs → expected output. Recorded by running the old code, or — marked — read from it when it cannot run. These are the behaviour you must preserve.",
		promptSnippet: "truth_lookup: recorded old-code behaviour for a symbol",
		parameters: Type.Object({ symbolId: Type.Optional(Type.String()) }),
		execute: async (_id, p) => {
			const rows = d.ledger.db.prepare(`SELECT id, symbol_id, inputs, expected, verified_on_old FROM truth_cases WHERE unit_id = ? ${p.symbolId ? "AND symbol_id = ?" : ""} ORDER BY symbol_id, id`).all(...(p.symbolId ? [d.unitId, p.symbolId] : [d.unitId])) as Array<{ id: string; symbol_id: string; inputs: string; expected: string; verified_on_old: number }>;
			return text(rows.length ? rows.map((r) => `${r.id} ${r.symbol_id}: ${r.inputs} → ${r.expected}${r.verified_on_old ? "" : " (read from the old code, not run)"}`).join("\n") : "no truth cases for this unit yet");
		},
	});
}

export function ledgerProve(d: ToolDeps): ToolDefinition {
	return def({
		name: "ledger_prove",
		label: "Ledger prove",
		description:
			"Record what happened to ONE legacy symbol of this unit. Required for every symbol in the task card before you finish. op: moved (1:1 port), extracted (split into several target symbols), merged_into (deduplicated into an existing/another target symbol), inlined (body folded into its caller), split, dropped (not needed in the new system — say why). targetSymbols are target ids `<project-relative file>::<symbol>` as target_lookup prints them.",
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
			"Record an oddity of the OLD code instead of pinning it blindly: a language artifact (loose emptiness/truthiness, implicit coercion), an edge case nobody may rely on, or a suspected bug. Ordinary behaviour — what the code plainly does on purpose, even when it looks unusual — is a test case, not a quirk. One behaviour is one quirk: record it once, not per symbol or per case (the reply lists what this unit already has; an already recorded behaviour is returned, not added). Give your opinion: drop (the new code implements the intended behaviour) or keep (callers depend on it). Language artifacts and edge cases with opinion drop are dropped without asking; everything else is asked to the owner. Write your test cases the way your opinion says.",
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
			const all = () => `\nQuirks of ${d.unitId} so far:\n${quirkList(d, d.unitId)}`;
			const same = await sameQuirk(d, { unitId: d.unitId, symbolId: p.symbolId, behaviour: p.behaviour, example: p.example });
			if (same.row) {
				const follow = same.row.status === "kept" ? "keep" : same.row.status === "dropped" ? "drop" : (same.row.applied ?? same.row.opinion);
				return text(`already recorded as quirk #${same.row.id} (${same.row.symbol_id}: ${same.row.behaviour}); not added again. Write the cases following "${follow}".${all()}`, { id: same.row.id, status: same.row.status, duplicate: true });
			}
			const r = recordQuirk(d, { unitId: d.unitId, symbolId: p.symbolId, kind: p.kind as QuirkKind, behaviour: p.behaviour, example: p.example, opinion: p.opinion as "drop" | "keep", why: p.why });
			return text(`${r.status === "dropped" ? `quirk #${r.id} dropped (no caller relies on it): do not pin it; test the intended behaviour.` : `quirk #${r.id} recorded; the owner will be asked. Write the cases following your opinion (${p.opinion}).`}${all()}`, r);
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

export function disputeTestTool(d: ToolDeps): ToolDefinition {
	return def({
		name: "dispute_test",
		label: "Dispute a test",
		description: "A ported test (or its truth case) is wrong: it expects something the legacy code does not do, or it imports a name the interface cannot have. You cannot edit tests; the tester re-checks this one against the legacy code before your next attempt and fixes it or tells you why it is right. Give evidence from the legacy code, not a guess.",
		promptSnippet: "dispute_test: a test you believe is wrong goes back to the tester (with evidence)",
		parameters: Type.Object({ test: Type.String({ description: "test file and test name (or truth case id)" }), why: Type.String(), evidence: Type.String({ description: "what the legacy code really does (symbol, line, value)" }) }),
		execute: async (_id, p) => {
			d.onDispute?.(p);
			return text("recorded: the tester re-checks it if this attempt fails the tests. Implement the behaviour of the legacy code, not the disputed expectation.");
		},
	});
}

/** The accepted unit whose ported code is `target` (`path::Name`, or a file path), via the ledger's moves. */
export function ownerOf(ledger: Ledger, target: string, except: string): string[] {
	const file = target.split("::")[0]!;
	const q = (like: string) => (ledger.db.prepare("SELECT DISTINCT m.unit_id id FROM moves m JOIN units u ON u.id = m.unit_id WHERE u.state = 'accepted' AND m.unit_id != ? AND m.target_symbols LIKE ?").all(except, like) as Array<{ id: string }>).map((r) => r.id);
	const exact = target.includes("::") ? q(`%"${target}%`) : [];
	return exact.length ? exact : q(`%"${file}::%`);
}

export const MAX_REPORT_REOPENS = 2;

export function reportMigratedBugTool(d: ToolDeps): ToolDefinition {
	return def({
		name: "report_migrated_bug",
		label: "Report a bug in migrated code",
		description: `Code another unit already migrated (outside your write scope) is wrong or misses something this unit needs from it. Do not copy it or work around it: report it. That unit is re-opened with your report and fixed first; this unit waits and continues after it. Give the target symbol (\`<file>::<Name>\` as target_lookup prints it), the problem and evidence from the legacy code. Each unit is re-opened by reports at most ${MAX_REPORT_REOPENS} times.`,
		promptSnippet: "report_migrated_bug: a bug in another unit's accepted code re-opens that unit; this one waits for the fix",
		parameters: Type.Object({ target: Type.String(), problem: Type.String(), evidence: Type.String() }),
		execute: async (_id, p) => {
			const owners = ownerOf(d.ledger, p.target, d.unitId);
			if (!owners.length) return text(`no accepted unit owns ${p.target}: check the name with target_lookup (shared helpers you may extend are not reported)`, { error: true });
			if (owners.length > 1) return text(`several units wrote ${p.target.split("::")[0]}: ${owners.join(", ")}. Name the symbol (<file>::<Name>).`, { error: true });
			const owner = owners[0]!;
			const reopens = (JSON.parse(d.ledger.getUnit(owner)!.meta) as { reportReopens?: number }).reportReopens ?? 0;
			if (reopens >= MAX_REPORT_REOPENS) return text(`${owner} was already re-opened ${reopens} times by reports: not again. Finish this unit with what exists and describe the gap in your final message.`, { error: true });
			d.onReport?.({ owner, ...p });
			return text(`reported to ${owner}: it is re-opened with your report once this session ends, and this unit waits until it is accepted again. Finish what does not depend on it, then stop.`);
		},
	});
}

/**
 * The tester checks its own ported tests the way the orchestrator will: every truth case id as exact text in a test
 * file where this unit's tests belong, and the stack's build and lint on those test files, scoped as the gate scopes
 * them (run from the target project dir; the implementer cannot edit tests, so a test that fails a check fails every
 * attempt). A build or lint that checks the whole project runs after merges, so it is reported as not run here.
 */
export function checkPortedTestsTool(d: ToolDeps): ToolDefinition {
	return def({
		name: "check_ported_tests",
		label: "Check ported tests",
		description: "Run the orchestrator's own checks on your ported tests: which truth case ids (\"<unit>#N\", searched as exact text) no test file mentions, where it searched, and the output of the target stack's build and lint on the test files (run in the target project dir, the same commands the gate runs). Call it before you finish and fix what it reports.",
		promptSnippet: "check_ported_tests: the orchestrator's checks on your tests (case ids found, build, lint) — call before TESTER DONE",
		parameters: Type.Object({}),
		execute: async () => {
			const moduleDir = d.moduleDir ?? "";
			const out: string[] = [];
			const truth = d.currentTruth?.();
			let ids: string[];
			if (truth?.ok) {
				ids = caseIds(d.unitId, d.ledger.db.prepare("SELECT id, symbol_id, inputs FROM truth_cases WHERE unit_id = ? ORDER BY rowid").all(d.unitId) as Array<{ id: string; symbol_id: string; inputs: string }>, truth.cases);
				if (truth.none) out.push(`No runtime behaviour declared (${truth.none}): no case needs a test.`);
			} else {
				ids = (d.ledger.db.prepare("SELECT id FROM truth_cases WHERE unit_id = ? ORDER BY rowid").all(d.unitId) as Array<{ id: string }>).map((r) => r.id);
				if (truth) out.push(`Your truth cases do not load yet: ${truth.error ?? "unknown error"}${ids.length ? `\nChecked the ${ids.length} case id(s) recorded earlier instead.` : ""}`);
			}
			const cov = caseCoverage(d.targetProjectDir, moduleDir, d.adapter.layout, ids);
			out.push(`Searched for test files matching ${cov.globs.join(", ")} in ${d.targetProjectDir}: ${cov.files.length ? cov.files.join(", ") : "none found"}.`);
			out.push(cov.missing.length ? `MISSING: ${cov.missing.length} of ${ids.length} case id(s) appear in no test file: ${cov.missing.join(", ")}. Put each id unchanged ("#" included) in its test's name, or next to the test in a comment or description.` : `All ${ids.length} case id(s) found.`);
			if (cov.files.length) {
				// the same build and lint the gate runs on the unit's files; a whole-project one is not the tester's to fix
				for (const name of ["build", "lint"] as const) {
					const r = await checkTests(d.targetProjectDir, d.adapter, name, cov.files);
					const NAME = name.toUpperCase();
					out.push(r.skipped ? `${NAME} not run per unit (${r.skipped}).` : r.error ? `${NAME} FAILED (\`${r.command}\`, run in ${d.targetProjectDir}); fix the test files (${name === "lint" ? "formatting/static issues only" : "the errors in them"}, behaviour unchanged):\n${r.error}` : `${NAME} clean (\`${r.command}\`, run in ${d.targetProjectDir}).`);
				}
			}
			return text(out.join("\n"), { missing: cov.missing, files: cov.files });
		},
	});
}

/** A unit with nothing to run (a pure contract, type declarations, constants): the tester says so with a reason instead of inventing cases. */
export function noBehaviourTool(d: ToolDeps): ToolDefinition {
	return def({
		name: "no_behaviour_to_pin",
		label: "No behaviour to pin",
		description: "Declare that this unit has NO runtime behaviour a test could pin: it only declares a contract (interface, abstract signatures), types or constant values — nothing is computed, decided or changed when it runs. Then write no truth cases and no ported tests for it (still draft interface.md). Give the reason a reviewer can check against the legacy code. Never use it to skip behaviour that is hard to test.",
		promptSnippet: "no_behaviour_to_pin: the unit only declares a contract/types/constants — nothing to test (with the reason)",
		parameters: Type.Object({ reason: Type.String({ description: "what the unit consists of and why nothing in it runs" }) }),
		execute: async (_id, p) => {
			if (!d.truthDir) return text("not available in this session", { error: true });
			if (!p.reason.trim()) return text("a reason is required", { error: true });
			// the decision model reads the legacy code against the reason; on a refusal nothing is written or removed
			const refused = await behaviourFound(d, p.reason.trim());
			if (refused) return text(refused, { error: true });
			mkdirSync(d.truthDir, { recursive: true });
			writeFileSync(join(d.truthDir, NO_BEHAVIOUR_FILE), JSON.stringify({ reason: p.reason.trim() }, null, 2) + "\n");
			// cases an earlier attempt left behind would count instead of this judgement: this declaration replaces them
			const old = [READ_CASES_FILE, getSourceAdapter(d.config.source.stack).truth.scriptName].filter((f) => existsSync(join(d.truthDir!, f)));
			for (const f of old) rmSync(join(d.truthDir, f), { force: true });
			return text(`recorded: no truth cases and no ported tests are expected for this unit; the reviewer checks your reason.${old.length ? ` Removed the cases an earlier attempt left (${old.join(", ")}).` : ""} If you write cases after this, they count instead.`);
		},
	});
}

/**
 * Does the unit's legacy code run something a test could pin, whatever the tester's reason says? The refusal text,
 * or undefined when the declaration stands (also when there is no decision model or no code: the reviewer checks it).
 */
async function behaviourFound(d: ToolDeps, reason: string): Promise<string | undefined> {
	const symbols = d.ledger.symbolsOfUnit(d.unitId);
	if (!d.client || !symbols.length) return undefined;
	const code = symbols.map((s) => symbolBody(d, s.id)).join("\n\n").slice(0, MAX_BODY_CHARS);
	try {
		const dec = await decide({ client: d.client, ledger: d.ledger, model: d.config.models.decide.id, second: d.config.models.escalate.id }, "no_behaviour", { reason, code }, {
			behaviour: {
				type: "choice",
				instructions: "The tester says the legacy code in `code` has no runtime behaviour a test could pin, for `reason`. Read the code itself: when it runs, does it compute, decide, send, store or change anything?",
				criteria: {
					none: "No: it only declares a contract (interfaces, abstract signatures), types or constant values",
					runs: "Yes: when it runs it computes, decides, sends (a request, a mail), stores or changes something a test can pin",
				},
			},
		}, ["behaviour"], d.unitId);
		const refuse = choiceOf(dec.answers["behaviour"]) === "runs" && dec.confidence >= JEV_ACT;
		setDecisionAction(d.ledger, dec.decisionId, refuse ? "refused no_behaviour_to_pin" : "no behaviour declared");
		if (!refuse) return undefined;
		return `refused: the decision model read this unit's legacy code (${symbols.map((s) => s.id).slice(0, 5).join(", ")}${symbols.length > 5 ? ", …" : ""}) and judged that it runs: it computes, decides, sends, stores or changes something a test can pin. Your reason was: "${reason}". Nothing was recorded and no cases were removed: write truth cases and ported tests for that behaviour instead. If you are sure the code only declares a contract, types or constants, call it again with a reason that names what each symbol declares.`;
	} catch {
		return undefined; // the decision model is unavailable: the reviewer checks the reason
	}
}
const MAX_BODY_CHARS = 20_000;

export function implementerTools(d: ToolDeps): ToolDefinition[] {
	return [symbolLookup(d), whoCalls(d), readFunctionTool(d), sourceSymbolBody(d), targetLookup(d), sharedLookup(d), patternExamples(d), docsLookup(d), truthLookup(d), ledgerProve(d), findCapabilityTool(d), proposeRuleTool(d), disputeTestTool(d), reportMigratedBugTool(d)];
}
export function testerTools(d: ToolDeps): ToolDefinition[] {
	return [symbolLookup(d), whoCalls(d), readFunctionTool(d), sourceSymbolBody(d), targetLookup(d), sharedLookup(d), docsLookup(d), findCapabilityTool(d), recordQuirkTool(d), proposeRuleTool(d), checkPortedTestsTool(d), noBehaviourTool(d)];
}

function safeRead(p: string): string | undefined {
	try {
		return readFileSync(p, "utf8");
	} catch {
		return undefined;
	}
}
