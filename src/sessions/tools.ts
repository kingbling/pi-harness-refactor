import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelClient } from "../models/types.ts";
import { caseIds, NO_BEHAVIOUR_FILE, READ_CASES_FILE, type TruthResult } from "../run/legacy-env.ts";
import { catchUpWithMain, caseCoverage, checkTests, holds, ownTests, runPortedTests, sameAsAt } from "../run/ported.ts";
import { antigamingCheck, buildFiles, changedFiles, clipOutput, gateFiles, othersTestsChanged, structureCheck, type GateInput } from "../run/gate.ts";
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
	/** Implementer: a test it believes is wrong goes to the tester before the next attempt (see dispute_test). Tester: an earlier unit's test file it had to change, with evidence: the change is kept (disputeEarlierTestTool). */
	onDispute?: (d: { test: string; why: string; evidence: string }) => void;
	/** Implementer: a reviewer finding it believes is wrong goes back to the reviewer, who keeps it with a reason or drops it (see dispute_finding). */
	onDisputeFinding?: (d: { finding: string; why: string; evidence: string }) => void;
	/** Implementer: every check_my_code result, so the orchestrator knows when DONE comes after a red check. Tester (codeWritten): every check_ported_tests result (`failed: "tests"` when its test run was red). */
	onCheck?: (c: { ok: boolean; failed?: string; text: string; timedOut?: boolean; files: string[]; ran?: Array<"build" | "lint" | "tests">; tests?: string[] }) => void | Promise<void>;
	/** Implementer: false when the unit's tester has no dispute re-check left (dispute_test then says so). */
	disputeRecheck?: boolean;
	/** When this run of the orchestrator started (ISO): report_migrated_bug takes at most MAX_REPORTS_PER_RUN rounds of this unit since then. */
	runStartedAt?: string;
	/** Implementer: a bug in another unit's accepted code re-opens that unit; this one waits (see report_migrated_bug). */
	onReport?: (r: { owner: string; target: string; problem: string; evidence: string }) => void;
	/** Decision model for cheap judgements in tools (record_quirk: is this quirk already recorded?). */
	client?: ModelClient;
	/** Tester: the unit's truth dir (absolute), where no_behaviour_to_pin writes its declaration. */
	truthDir?: string;
	/** Tester: the truth cases as code would load them now (runs the truth script / reads cases.json), for check_ported_tests. */
	currentTruth?: () => TruthResult | Promise<TruthResult>;
	/** Tester: the gate's structure_ok layout check on these project-relative paths (one `<path>: <problem>` per line), for check_ported_tests. */
	checkLayout?: (files: string[]) => string[] | Promise<string[]>;
	/** The unit's last pass was not merged for whole-project errors: that check on the worktree, only errors main does not have (undefined = none). */
	wholeCheck?: () => Promise<string | undefined>;
	/** Implementer: the unit's ported test files (project-relative) as they are now, for check_my_code. */
	testFiles?: () => string[];
	/** Main's checkout of the unit's project: another unit's test that fails counts only if it passes there (as in the gate). */
	mainDir?: string;
	/** The gate's CPU slot: check_my_code runs its commands inside it, like the gate (tests take it per run). */
	slot?: <T>(fn: () => Promise<T>) => Promise<T>;
	/** Tester: earlier units' test files this unit may change (tidy, disputed), as the gate allows them. */
	sanctioned?: string[];
	/** Tester: the implementer's code is in place (a retest from the implement loop), so check_ported_tests runs the tests. */
	codeWritten?: boolean;
	/** Implementer: what the gate will be given now, so check_my_code runs the gate's cheap code-only steps (scope, stub marks, layout) first. */
	gateInput?: () => GateInput;
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

/** The names the source framework knows a legacy file by besides its symbols (a template's view name, a command name). */
export function fileAliases(config: Config, path: string): string[] {
	try {
		return getSourceAdapter(config.source.stack).fileAliases?.(path) ?? [];
	} catch {
		return []; // unknown source adapter
	}
}

/** The unit that owns a legacy symbol (exact id first) or else any symbol of its file, or null. */
export function unitOfLegacy(ledger: Ledger, idOrPath: string): string | null {
	const row = ledger.db.prepare("SELECT unit_id FROM symbols WHERE (id = ? OR path = ?) AND unit_id IS NOT NULL ORDER BY id = ? DESC LIMIT 1").get(idOrPath, idOrPath.split("::")[0]!, idOrPath) as { unit_id: string } | undefined;
	return row?.unit_id ?? null;
}

/** ", unit X <state> on <stack>" for a legacy caller's unit: one not accepted yet is not migrated; its stack says who can wire what. */
export function unitState(ledger: Ledger, unit: string | null): string {
	if (!unit) return "";
	const u = ledger.getUnit(unit);
	let stack: string | undefined;
	try {
		stack = (JSON.parse(u?.meta ?? "{}") as { place?: { stack?: string } }).place?.stack;
	} catch {
		/* no meta: no stack */
	}
	return `, unit ${unit} ${u?.state ?? "unknown"}${stack ? ` on ${stack}` : ""}`;
}

/**
 * The legacy callers of a unit's code, one line each with the caller's unit, its state and stack: code calls and
 * symbol-level deps, plus the files that name the unit's code in a string (a controller rendering a template by its
 * view name). The implementer's card and the reviewer get the same lines, so both judge the wiring from the same facts.
 */
export function legacyCallerLines(ledger: Ledger, config: Config, unitId: string, legacyFiles: string[]): string[] {
	const db = ledger.db;
	const own = new Set(legacyFiles);
	const outside = (id: string) => !own.has(id.split("::")[0]!);
	const callers = (
		db
			.prepare(`SELECT DISTINCT e.from_id, e.how, f.unit_id FROM (
				SELECT c.from_id, c.kind || ' call' AS how FROM code_calls c JOIN symbols s ON s.id = c.to_id WHERE s.unit_id = ? AND c.resolution = 'code'
				UNION SELECT d.from_id, d.kind AS how FROM index_deps d JOIN symbols s ON s.id = d.to_id WHERE s.unit_id = ?
			) e LEFT JOIN symbols f ON f.id = e.from_id ORDER BY e.from_id`)
			.all(unitId, unitId) as Array<{ from_id: string; how: string; unit_id: string | null }>
	).filter((c) => c.unit_id !== unitId && outside(c.from_id));
	// names the code is reached by: its classes/functions, plus the names the framework knows a file by (a template's view name)
	const names = [...new Set([...(db.prepare("SELECT DISTINCT name FROM symbols WHERE unit_id = ? AND kind IN ('class','function')").all(unitId) as Array<{ name: string }>).map((r) => r.name), ...legacyFiles.flatMap((f) => fileAliases(config, f))])];
	const literal = names.length ? (db.prepare(`SELECT DISTINCT name, path FROM index_literal_refs WHERE name IN (${names.map(() => "?").join(",")}) ORDER BY path`).all(...names) as Array<{ name: string; path: string }>).filter((l) => !own.has(l.path)) : [];
	return [
		...callers.map((c) => `- ${c.from_id} (${c.how}${unitState(ledger, c.unit_id ?? unitOfLegacy(ledger, c.from_id))})`),
		...literal.map((l) => `- ${l.path} names "${l.name}" in a string (maybe a factory, dynamic call or rendered view${unitState(ledger, unitOfLegacy(ledger, l.path))})`),
	];
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
			// the symbol's name, plus the names the framework knows its file by (a template's view name, a command name)
			const names = [...new Set([p.symbolId.split("::").pop()!, ...fileAliases(d.config, p.symbolId.split("::")[0]!)])];
			const literal = d.ledger.db.prepare(`SELECT DISTINCT name, path FROM index_literal_refs WHERE name IN (${names.map(() => "?").join(",")}) ORDER BY path`).all(...names) as Array<{ name: string; path: string }>;
			// the caller's unit, its state and stack: a caller whose unit is not accepted yet is not migrated
			const where = (from: string) => unitState(d.ledger, unitOfLegacy(d.ledger, from.split(" L")[0]!));
			return text(
				`${callers.length} static reference(s)${callers.length ? ":\n" + callers.map((c) => `- ${c.from_id} (${c.kind}${where(c.from_id)})`).join("\n") : ""}` +
					(literal.length ? `\n${literal.length} string-literal mention(s) (possible dynamic dispatch or rendered view):\n${literal.map((l) => `- ${l.path} names "${l.name}"${where(l.path)}`).join("\n")}` : ""),
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

/** The kinds of drop ledger_prove takes: code the new system does not need. Not done or put off is no drop. */
export const DROP_KINDS = ["dead", "platform", "owner"] as const;
const NO_DROP_KIND = "a drop needs dropKind: dead (nothing reaches it), platform (the target does it) or owner (the owner decided). Work not done, put off, or left to another unit is no drop: prove it merged_into the code that does it, or leave it unproven and say why in your final message";

export function ledgerProve(d: ToolDeps): ToolDefinition {
	return def({
		name: "ledger_prove",
		label: "Ledger prove",
		description:
			"Record what happened to legacy symbols of this unit: a list, one entry per symbol (prove them all in one call when you can). Required for every symbol in the task card before you finish. op: moved (1:1 port), extracted (split into several target symbols), merged_into (deduplicated into an existing/another target symbol), inlined (body folded into its caller), split, dropped (not needed in the new system: give dropKind and say why). A drop is only for code the new system does not need: dead (nothing in the legacy app reaches it), platform (the target framework or platform does it; say where) or owner (the owner decided it; name the question). Work not done, put off for later, or left to another unit or to the owner is never a drop: when other code already does it, prove it merged_into that code; when you cannot do it, leave it unproven and say why in your final message. The reviewer checks every drop against the legacy code. targetSymbols are target ids `<project-relative file>::<symbol>` as target_lookup prints them. A symbol proven before keeps its proof; prove it again only when what it points to changed.",
		promptSnippet: "ledger_prove: account for the legacy symbols, a list in one call (moved/extracted/merged_into/inlined/split/dropped + why)",
		promptGuidelines: ["Call ledger_prove with every legacy symbol of the task card (a list, one call); the unit cannot pass the gate with unproven symbols."],
		parameters: Type.Object({
			proofs: Type.Array(
				Type.Object({
					srcSymbol: Type.String(),
					op: Type.Union(MOVE_OPS.map((o) => Type.Literal(o))),
					targetSymbols: Type.Optional(Type.Array(Type.String())),
					dropKind: Type.Optional(Type.Union(DROP_KINDS.map((k) => Type.Literal(k)), { description: "op dropped only: dead, platform or owner" })),
					why: Type.String({ description: "one sentence a reviewer can verify" }),
				}),
				{ minItems: 1 },
			),
		}),
		execute: async (_id, p) => {
			const lines: string[] = [];
			let refused = 0;
			// each entry on its own: a refused one is named, the others are recorded
			for (const q of p.proofs) {
				const sym = d.ledger.getSymbol(q.srcSymbol);
				let problem = !sym ? "unknown symbol; use the exact ids from the task card" : sym.unit_id !== d.unitId ? `belongs to unit ${sym.unit_id}, not ${d.unitId}; only prove your own symbols` : q.op === "dropped" && !q.dropKind ? NO_DROP_KIND : undefined;
				if (!problem)
					try {
						// the kind leads the reason: the reviewer and later checks read what the drop claims
						const why = q.op === "dropped" && !q.why.startsWith(`${q.dropKind}:`) ? `${q.dropKind}: ${q.why}` : q.why;
						d.ledger.prove({ unitId: d.unitId, srcSymbol: q.srcSymbol, op: q.op as MoveOp, targetSymbols: q.targetSymbols, why, attemptId: d.attemptId });
					} catch (e: any) {
						problem = `rejected: ${e?.message ?? e}`;
					}
				if (problem) refused++;
				lines.push(problem ? `${q.srcSymbol}: ${problem}` : `recorded ${q.op} for ${q.srcSymbol}`);
			}
			const left = (d.ledger.db.prepare("SELECT id FROM symbols WHERE unit_id = ? AND state IN ('clustered','in_progress') ORDER BY id").all(d.unitId) as Array<{ id: string }>).map((r) => r.id);
			lines.push(left.length ? `${left.length} symbol(s) of this unit still unproven: ${left.slice(0, 40).join(", ")}${left.length > 40 ? " …" : ""}` : "every symbol of this unit is proven.");
			return text(lines.join("\n"), { left: left.length, ...(refused ? { error: refused === p.proofs.length } : {}) });
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
		description: `Propose an addition or change to the ${d.adapter.id} rules when you learn something other units will need (a convention, a reusable pattern, a pitfall in this codebase, a missing mapping). A curator merges proposals into the next rules version; changes that break already-migrated code are asked to the owner. Not for one-off details of this unit. Rules say how code is written; the checks (gates, reviewer, ledger tools) are code and do not read them, so a rule about what a check must accept changes nothing: do not propose one (a wrong test goes to dispute_test, a blocker outside your files is reported in your final message).`,
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
			if (d.disputeRecheck === false) return text("recorded, but the tester's re-checks for this unit are used up: nobody re-checks this test now and it stays as it is. Implement the behaviour of the legacy code, not the disputed expectation, and name the disputed test with your evidence in your final answer.");
			return text("recorded: the tester re-checks it if this attempt fails the tests. Implement the behaviour of the legacy code, not the disputed expectation.");
		},
	});
}

/**
 * Tester: an earlier unit's test that is wrong now (its fixture cannot build what this unit's code must be, it
 * expects what the legacy code does not do) is changed in the open, with evidence, instead of being undone.
 */
export function disputeEarlierTestTool(d: ToolDeps): ToolDefinition {
	return def({
		name: "dispute_test",
		label: "Dispute an earlier unit's test",
		description: "An earlier unit's test file must change for this unit (not just get new tests added, which is always fine): one of its tests or fixtures is wrong, or cannot work with what the legacy code really does. Name the file and give evidence from the legacy code. Your change to that file is then kept (otherwise changed or removed lines in an earlier unit's test file are undone when you finish); the tests still have to pass at the gate.",
		promptSnippet: "dispute_test: keep your change to an earlier unit's test file (with evidence from the legacy code)",
		parameters: Type.Object({ test: Type.String({ description: "the earlier unit's test file, project-relative" }), why: Type.String(), evidence: Type.String({ description: "what the legacy code really does (symbol, line, value)" }) }),
		execute: async (_id, p) => {
			const file = p.test.trim();
			if (!d.adapter.layout.isTestFile(file) || !existsSync(join(d.targetProjectDir, file))) return text(`${file} is not a test file in ${d.targetProjectDir}: give the project-relative path of the earlier unit's test file.`, { error: true });
			if (!d.onDispute) return text("not available in this session", { error: true });
			d.onDispute({ test: file, why: p.why, evidence: p.evidence });
			return text(`recorded: your change to ${file} is kept and logged with your evidence; the gate still runs it.`);
		},
	});
}

export function disputeFindingTool(d: ToolDeps): ToolDefinition {
	return def({
		name: "dispute_finding",
		label: "Dispute a reviewer finding",
		description: "An open reviewer finding is wrong: the legacy code does not do what it asks, or the code already does it. The reviewer reads your dispute at the next review and must keep the finding with a reason or drop it. Give the finding as it was written and evidence (legacy symbol and line, or the file and line of your code that already does it), not a guess. Fix the findings you do not dispute.",
		promptSnippet: "dispute_finding: a reviewer finding you believe is wrong goes back to the reviewer (with evidence)",
		parameters: Type.Object({ finding: Type.String({ description: "the finding as the reviewer wrote it (file:line and problem)" }), why: Type.String(), evidence: Type.String({ description: "what the legacy code or your code really does (symbol or file, line)" }) }),
		execute: async (_id, p) => {
			if (!d.onDisputeFinding) return text("not available in this session", { error: true });
			d.onDisputeFinding(p);
			return text("recorded: the reviewer must keep this finding with a reason or drop it at the next review.");
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
/** Rounds a unit may wait on units it reported, per run of the orchestrator. */
export const MAX_REPORTS_PER_RUN = 2;

/** `from` reaches `to` through its deps (directly or through other units). */
function dependsOn(ledger: Ledger, from: string, to: string): boolean {
	const seen = new Set<string>();
	const walk = (id: string): boolean => {
		if (id === to) return true;
		if (seen.has(id)) return false;
		seen.add(id);
		const u = ledger.getUnit(id);
		return !!u && (JSON.parse(u.deps) as string[]).some(walk);
	};
	return walk(from);
}

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
			// this unit would wait for the owner while the owner (re-opened) waits for this unit: neither would ever start
			if (dependsOn(d.ledger, owner, d.unitId)) return text(`${owner} itself depends on this unit, so it cannot be fixed first. Finish this unit with what exists and describe the gap in ${p.target} in your final message.`, { error: true });
			const file = p.target.split("::")[0]!.replace(/^\.\//, "");
			// the owner's accepted code was merged after this worktree last took main's commits: what looks missing or old
			// here is on main. Main's commits are brought in once; when they clash with this unit's work, no re-open
			const commit = (JSON.parse(d.ledger.getUnit(owner)!.meta) as { commit?: string }).commit;
			if (commit && !(await holds(d.targetProjectDir, commit))) {
				const caught = d.mainDir ? await catchUpWithMain(d.targetProjectDir, d.mainDir) : undefined;
				if (await holds(d.targetProjectDir, commit)) return text(`${owner}'s accepted code was merged into main after your worktree was made, so you did not see it. Main's new commits are now in your worktree: read ${file} again and report only a bug that is still there. Nothing was reported.`, { error: true });
				const clash = caught && "clash" in caught ? ` because main's new commits clash with your changes in ${caught.clash.join(", ") || "some files"}` : "";
				// the file is here as the owner left it (or missing in both): the bug is in the owner's code, report it
				if (!(await sameAsAt(d.targetProjectDir, commit, file)))
					return text(`${owner}'s accepted code is on main but not in your worktree${clash}, so ${file} here is older than ${owner}'s. Read it as merged (git show ${commit.slice(0, 12)}:${file}), keep your change compatible with it, and report only a bug that is in that code. Nothing was reported; the merge of this unit brings ${owner}'s code in. A report about ${file} goes through only once it is here as ${owner} left it, so for a bug in that code describe the gap in your final message instead of reporting it again.`, { error: true });
			}
			// this unit changed the file itself: what looks wrong may be its own change, not the owner's code
			const mine = await changedFiles(d.targetProjectDir, d.adapter.toolchain.ignoredPaths).catch(() => [] as string[]);
			if (mine.includes(file)) return text(`${file} is changed in this unit's own worktree, so the problem may come from that change, not from ${owner}'s code. Look at your change (git diff -- ${file}); undo it if it is not yours to make, and report only a bug that is in the code as ${owner} left it.`, { error: true });
			// a unit that already waited on reports this run finishes with what exists: each round costs a re-open and a wait
			const rounds = d.runStartedAt ? (d.ledger.db.prepare("SELECT COUNT(*) n FROM attempts WHERE unit_id = ? AND outcome = 'waits_on_fix' AND started_at >= ?").get(d.unitId, d.runStartedAt) as { n: number }).n : 0;
			if (rounds >= MAX_REPORTS_PER_RUN) return text(`this unit already waited ${rounds} times this run on units it reported: not again in this run. Finish this unit with what exists and describe the gap in ${p.target} in your final message.`, { error: true });
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
		description: "Run the orchestrator's own checks on your ported tests: which truth case ids (\"<unit>#N\", searched as exact text) no test file mentions, where it searched, the stack layout check (the gate's structure_ok) on your test files and on the production files they import, the output of the target stack's build and lint on this unit's test files (run in the target project dir, the same commands the gate runs), earlier units' test files you changed (undone when you finish), and once the implementer's code is in place the tests run against it. Pass code_files: every production file your tests import that does not exist yet, as the implementer must create it (project-relative path with its extension). The implementer cannot edit tests, so a path the layout does not allow fails every attempt. Call it before you finish and fix what it reports.",
		promptSnippet: "check_ported_tests: the orchestrator's checks on your tests (case ids found, layout of test and imported paths, build, lint) — call before TESTER DONE",
		parameters: Type.Object({ code_files: Type.Optional(Type.Array(Type.String(), { description: "production files the tests import, project-relative with extension (e.g. src/features/offers/pages/OffersEditPage.tsx)" })) }),
		execute: async (_id, p) => {
			const moduleDir = d.moduleDir ?? "";
			const out: string[] = [];
			const truth = await d.currentTruth?.();
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
			// what the test files really import counts too: a leftover or renamed test can import a path code_files does not name
			const imported = missingTestImports(d.targetProjectDir, cov.files, d.adapter.layout.sourceExtensions);
			const codeFiles = [...new Set([...(p.code_files ?? []).map((f) => f.replace(/^\.\//, "")).filter((f) => !existsSync(join(d.targetProjectDir, f))), ...imported.keys()])];
			const layout = d.checkLayout ? (await portedLayout(d.checkLayout, cov.files, codeFiles)).map((l) => {
				const by = [...imported].find(([f]) => l.startsWith(`${f}:`))?.[1];
				return by ? `${l} (imported by ${by})` : l;
			}) : [];
			if (d.checkLayout) out.push(layout.length ? `LAYOUT FAILED (the gate's structure_ok; the implementer cannot change a test's file name or imports, so fix them now: rename or move the test, change its imports and interface.md to paths the layout allows; a test file left over from an earlier name is removed or fixed too):\n${layout.join("\n")}` : `LAYOUT clean for ${cov.files.length} test file(s) and ${codeFiles.length} imported code file(s).${p.code_files?.length ? "" : " Pass code_files (the production files your tests import) to check those paths too."}`);
			// earlier units' test files are put back when the session ends: the tester hears it now, not after
			let others: string[] = [];
			try {
				others = await othersTestsChanged(d.targetProjectDir, d.unitId, (f) => d.adapter.layout.isTestFile(f), d.sanctioned ?? []);
			} catch {
				/* not a git checkout: nothing to compare */
			}
			for (const f of others) out.push(`${f} holds tests of earlier units; you changed or removed lines there, and that is undone when you finish (only those ids would remain). Adding new tests or fixtures to it is fine. If an existing test or fixture there is wrong, call dispute_test with the file and evidence from the legacy code and your change is kept; otherwise put back what you changed and put this unit's tests in a new test file next to it that the layout allows.`);
			if (cov.files.length) {
				// the same build and lint the gate runs, on this unit's own test files (other units' are not the tester's to fix);
				// a whole-project one is not the tester's to fix either
				const own = await ownTests(d.ledger, d.unitId, d.targetProjectDir, cov.files, d.adapter.toolchain.ignoredPaths);
				// the gate refuses a skipped, focused or incomplete test in the unit's own files (antigaming_ok)
				const skipping = own.filter((f) => existsSync(join(d.targetProjectDir, f)) && d.adapter.layout.skipMarker.test(readFileSync(join(d.targetProjectDir, f), "utf8")));
				if (skipping.length) out.push(`SKIPPED FAILED: ${skipping.join(", ")} skip tests or leave them incomplete (${d.adapter.layout.skipMarker.source}); a test that does not run proves nothing and the gate refuses it. Make each one run and check the recorded behaviour.`);
				for (const name of ["build", "lint"] as const) {
					const r = await checkTests(d.targetProjectDir, d.adapter, name, own);
					const NAME = name.toUpperCase();
					out.push(r.skipped ? `${NAME} not run per unit (${r.skipped}).` : r.error ? `${NAME} FAILED (\`${r.command}\`, run in ${d.targetProjectDir}); fix the test files (${name === "lint" ? "formatting/static issues only" : "the errors in them; code from interface.md that does not exist yet is the implementer's to write, not yours"}, behaviour unchanged):\n${r.error}` : `${NAME} clean (\`${r.command}\`, run in ${d.targetProjectDir}).`);
				}
			}
			const whole = d.wholeCheck ? await d.wholeCheck() : undefined;
			if (d.wholeCheck) out.push(whole ? `WHOLE-PROJECT check FAILED (the unit was not merged for these; errors main has too are left out). Fix the errors in your test files, behaviour unchanged; errors in code files are the implementer's:\n${whole.slice(-4000)}` : "WHOLE-PROJECT check: no errors main does not have.");
			// after the implementer worked, the tests run against its code (the same run as check_my_code)
			if (d.codeWritten && cov.files.length) {
				const r = await runPortedTests({ ledger: d.ledger, unitId: d.unitId, adapter: d.adapter, dir: d.targetProjectDir, tests: cov.files, mainDir: d.mainDir, timeoutMs: CHECK_MY_CODE_TIMEOUT_MS, slot: d.slot });
				const full = join(d.root, ".bigrefactor", "sessions", `${d.unitId}.check_ported_tests.log`);
				out.push(r.ok ? `TESTS green against the implementer's code (${cov.files.join(", ")}).` : `TESTS FAILED: the implementer's code is in place: a test that fails here is either wrong (check it against the legacy code and fix it) or catches a real bug in the code (keep it and say why in your final line):\n${clipOutput(r.output, 4000, full)}`);
				// the orchestrator knows when TESTER DONE comes after a red run (or tests changed after it)
				await d.onCheck?.({ ok: r.ok, failed: r.ok ? undefined : "tests", text: out.join("\n"), timedOut: r.output.endsWith("[timed out]"), files: cov.files });
			} else if (d.codeWritten) await d.onCheck?.({ ok: true, text: out.join("\n"), files: cov.files });
			return text(out.join("\n"), { missing: cov.missing, files: cov.files, layout });
		},
	});
}

/** The layout findings on the tester's test files and the production paths they import; findings about other files (a required file missing) are the implementer's. */
export async function portedLayout(check: (files: string[]) => string[] | Promise<string[]>, tests: string[], codeFiles: string[]): Promise<string[]> {
	const files = [...new Set([...tests, ...codeFiles.map((f) => f.replace(/^\.\//, ""))])];
	if (!files.length) return [];
	return (await check(files)).filter((l) => !l.startsWith("warning:") && files.some((f) => l.startsWith(`${f}:`)));
}

/**
 * The production files the test files import that do not exist yet, as the implementer would have to create them: each
 * relative path in quotes ("./SupplierViewPage", '../api/client') resolved against its test's folder, with the test's
 * own source extension when it names none. The layout check then judges what the tests really import, not only the
 * code_files the tester lists. Maps each path to the test that imports it.
 */
export function missingTestImports(projectDir: string, tests: string[], sourceExtensions: string[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const t of tests) {
		const abs = join(projectDir, t);
		if (!existsSync(abs)) continue;
		const ext = sourceExtensions.find((e) => t.endsWith(e)) ?? sourceExtensions[0] ?? "";
		for (const m of readFileSync(abs, "utf8").matchAll(/["'](\.\.?\/[^"'\s]+)["']/g)) {
			const rel = join(dirname(t), m[1]!);
			if (rel.startsWith("..")) continue; // outside the project
			// an existing file or folder (an index file) is no new path; nor is one with an extension already there
			if (existsSync(join(projectDir, rel)) || sourceExtensions.some((e) => existsSync(join(projectDir, rel + e)))) continue;
			const path = sourceExtensions.some((e) => rel.endsWith(e)) ? rel : rel + ext;
			if (!out.has(path)) out.set(path, t);
		}
	}
	return out;
}

/** Each command check_my_code runs gets this long: the gate runs it anyway, so a slow one is not waited for. */
export const CHECK_MY_CODE_TIMEOUT_MS = 120_000;

/**
 * The implementer checks its code the way the gate will before it says DONE: the stack's build and lint on the
 * files it changed (scoped as the gate scopes them), then the unit's ported tests. It stops at the first failure,
 * like the gate, so a broken build does not also wait for the tests.
 */
export function checkMyCodeTool(d: ToolDeps): ToolDefinition {
	return def({
		name: "check_my_code",
		label: "Check my code",
		description: "Run the gate's own checks on the code you changed: write scope, silenced checks, stub marks (TODO(br:)) and the stack layout, then the target stack's build and lint on your changed files (after a refused merge also the whole-project check the merge runs), then the unit's ported tests (run in the target project dir, the same commands the gate runs). It stops at the first failure. Call it before you finish and fix what it reports.",
		promptSnippet: "check_my_code: the gate's scope, layout, build, lint and ported tests on your changed files — call before IMPLEMENTER DONE",
		parameters: Type.Object({}),
		execute: async () => {
			const dir = d.targetProjectDir;
			const slot = d.slot ?? (<T>(fn: () => Promise<T>) => fn());
			const secs = CHECK_MY_CODE_TIMEOUT_MS / 1000;
			const files = buildFiles(dir, d.adapter, await changedFiles(dir, d.adapter.toolchain.ignoredPaths));
			const out = [`Changed files checked: ${files.length ? files.join(", ") : "none"}.`];
			// what really ran (not skipped): a green check on the gate's tree spares the gate the runs it holds
			const ran: Array<"build" | "lint" | "tests"> = [];
			// every result reaches the orchestrator: DONE after a red check gets one more turn
			const done = async (r: { ok: boolean; failed?: string; files: string[]; tests?: string[] }, timedOut?: boolean) => {
				await d.onCheck?.({ ...r, ran, text: out.join("\n"), timedOut });
				return text(out.join("\n"), r);
			};
			// the gate's code-only steps first (no command, no slot): scope, silenced checks, stub marks, layout, copies
			if (d.gateInput) {
				const g = d.gateInput();
				const gf = await gateFiles(g);
				const ag = await antigamingCheck(g, gf, true);
				if (!ag.ok) {
					out.push(`SCOPE FAILED (the gate's antigaming_ok); fix it and call check_my_code again:\n${ag.output}`);
					return done({ ok: false, failed: "antigaming", files });
				}
				const st = await structureCheck(g, gf);
				if (!st.ok) {
					const fromTests = st.testImported.length ? `\nYour ported tests import ${st.testImported.join(", ")}. You cannot change tests: call dispute_test for the test that imports it (the tester moves it to a path the layout allows).` : "";
					out.push(`STRUCTURE FAILED (the gate's structure_ok); fix it and call check_my_code again:\n${st.output}${fromTests}`);
					return done({ ok: false, failed: "structure", files });
				}
				out.push("SCOPE and STRUCTURE clean.");
			}
			// build, lint and the whole-project check in one slot: one wait in the queue, not one per command
			const failed = await slot(async () => {
				for (const name of ["build", "lint"] as const) {
					const r = await checkTests(dir, d.adapter, name, files, CHECK_MY_CODE_TIMEOUT_MS);
					const NAME = name.toUpperCase();
					if (r.skipped) out.push(`${NAME} not run per unit (${r.skipped}).`);
					else if (!r.error) (out.push(`${NAME} clean (\`${r.command}\`).`), ran.push(name));
					else {
						out.push(`${NAME} FAILED (\`${r.command}\`, run in ${dir}${r.error.endsWith("[timed out]") ? `, stopped after ${secs} s: the gate runs it again with more time` : ""}); fix it and call check_my_code again:\n${r.error}`);
						return done({ ok: false, failed: name, files }, r.error.endsWith("[timed out]"));
					}
				}
				// the last pass was not merged for whole-project errors: the same check the merge runs, so DONE comes after they are gone
				if (d.wholeCheck) {
					const whole = await d.wholeCheck();
					if (whole) {
						out.push(`WHOLE-PROJECT check FAILED (your last pass was not merged for these; errors main has too are left out); fix them and call check_my_code again:\n${whole.slice(-4000)}`);
						return done({ ok: false, failed: "whole", files });
					}
					out.push("WHOLE-PROJECT check clean: no errors main does not have.");
				}
				return undefined;
			});
			if (failed) return failed;
			const tests = (d.testFiles?.() ?? []).filter((f) => existsSync(join(dir, f)));
			if (!tests.length) {
				out.push("TESTS not run: this unit has no ported test files.");
				return done({ ok: true, files });
			}
			const r = await runPortedTests({ ledger: d.ledger, unitId: d.unitId, adapter: d.adapter, dir, tests, mainDir: d.mainDir, timeoutMs: CHECK_MY_CODE_TIMEOUT_MS, slot });
			if (r.ok) ran.push("tests");
			// the failing tests first; the whole output is saved in the unit's sessions folder when it is cut
			const full = join(d.root, ".bigrefactor", "sessions", `${d.unitId}.check_my_code.log`);
			const warned = r.ok ? r.output.split("\n").filter((l) => l.startsWith("warning:")).map((l) => ` ${l}`).join("") : "";
			out.push(r.ok ? `TESTS green (${tests.join(", ")}).${warned}` : `TESTS FAILED${r.output.endsWith("[timed out]") ? ` (stopped after ${secs} s: the gate runs them again with more time)` : ""}; fix the code, not the tests (or call dispute_test with evidence):\n${clipOutput(r.output, 4000, full)}`);
			return done({ ok: r.ok, failed: r.ok ? undefined : "tests", files, tests }, r.output.endsWith("[timed out]"));
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
	return [symbolLookup(d), whoCalls(d), readFunctionTool(d), sourceSymbolBody(d), targetLookup(d), sharedLookup(d), patternExamples(d), docsLookup(d), truthLookup(d), ledgerProve(d), findCapabilityTool(d), proposeRuleTool(d), disputeTestTool(d), disputeFindingTool(d), reportMigratedBugTool(d), checkMyCodeTool(d)];
}
export function testerTools(d: ToolDeps): ToolDefinition[] {
	return [symbolLookup(d), whoCalls(d), readFunctionTool(d), sourceSymbolBody(d), targetLookup(d), sharedLookup(d), docsLookup(d), findCapabilityTool(d), recordQuirkTool(d), proposeRuleTool(d), checkPortedTestsTool(d), noBehaviourTool(d), ...(d.onDispute ? [disputeEarlierTestTool(d)] : [])];
}

function safeRead(p: string): string | undefined {
	try {
		return readFileSync(p, "utf8");
	} catch {
		return undefined;
	}
}
