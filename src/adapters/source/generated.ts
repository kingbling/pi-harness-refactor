import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, normalize, relative } from "node:path";
import { Query } from "web-tree-sitter";
import type { Config } from "../../config.ts";
import { getLanguage, matches, normalizedAst, parse, registerGrammar, walk, type Node } from "../../inventory/treesitter.ts";
import type { CodeCall, CodeComment, CodeContainer, CodeFunction, FileIndex, IndexedDep, IndexedQuery, IndexedSymbol, SourceAdapter } from "../types.ts";
import { exampleProfileJson, phpAdapter, profileFromJson, type FrameworkProfileJson } from "./php.ts";
import { sqlTables } from "./sql.ts";

/**
 * A source (legacy) adapter for a language bigrefactor has no hand-written adapter for. A model looks at the
 * legacy repo with tools, picks and installs a tree-sitter grammar, and writes this manifest as DATA; code checks
 * it (grammar loads, queries compile, most sample files yield symbols, the truth command runs) before it is saved
 * to `.bigrefactor/adapters/source/<id>.json`. The indexer below is language-neutral: everything that knows the
 * language is in the manifest's queries. Framework conventions (entry points, framework folders, loaders,
 * concerns) are not guessed here: they come from the model-written framework profile (`br profile`) and Jev.
 */
export interface Cmd { cmd: string; args: string[] }
export interface SourceManifest {
	/** Adapter id = config.source.stack (lowercase, e.g. "python"). */
	id: string;
	/** Language name shown to models and stored per file (e.g. "python"). */
	language: string;
	/** File globs relative to the legacy root. */
	include: string[];
	exclude: string[];
	/** npm package of the tree-sitter grammar and the .wasm file inside it (installed under .bigrefactor/grammars). */
	grammar: { package: string; wasm: string };
	queries: {
		/** Captures the NAME node of each declaration; the capture name is the kind: class|function|method|const|interface|trait|enum|other. */
		symbols: string;
		/** Captures: import (the imported module/path string), call (called function name), new (constructed class), extends, implements, use. */
		deps: string;
		/** Optional, per match: one of @function @member @static @new on the called name, plus @receiver (member) or @scope (static). */
		calls?: string;
	};
	/** Node types of comments and string literals in this grammar. */
	nodes: { comments: string[]; strings: string[] };
	/** Called names that dispatch dynamically (eval, getattr, send, …): a marker, not an edge. */
	dynamicCalls?: string[];
	caseInsensitiveNames?: boolean;
	indentSignificant?: boolean;
	traits?: { globalState?: string; languageArtifacts?: string[]; mutatingCommands?: string; vendorDirs?: string[] };
	docs: Array<{ name: string; url: string }>;
	/** How a tester runs a script on the old code: `{script}` = the script path, `{root}` = the legacy root (the cwd). */
	truth: { scriptName: string; run: Cmd; instructions: string; probe: string };
	/** Command the tester may run for the legacy test suite. */
	oldTestCommand?: string;
	/** Third-party packages the legacy repo declares (its package manifest, read by the model). */
	packages?: Array<{ name: string; version?: string; dev?: boolean }>;
	/** Data stores the legacy code talks to, each with where the model saw it (a driver package, a DSN, a compose service). */
	dataStores?: Array<{ engine: string; evidence: string }>;
}

// ---- grammar ----------------------------------------------------------------------------------------------

export const grammarsDir = (root: string) => join(root, ".bigrefactor", "grammars");
const require = createRequire(import.meta.url);
/** The grammar wasm: installed into the workspace by the model, else one this plugin ships. */
export function grammarPath(m: SourceManifest, root: string): string | undefined {
	const inWs = join(grammarsDir(root), "node_modules", m.grammar.package, m.grammar.wasm);
	if (existsSync(inWs)) return inWs;
	try {
		return require.resolve(`${m.grammar.package}/${m.grammar.wasm}`);
	} catch {
		return undefined;
	}
}
/** Registered under its own name: a generated "javascript" never replaces the grammar a target adapter uses. */
const langKey = (m: SourceManifest) => `source:${m.id}`;

// ---- generic indexer --------------------------------------------------------------------------------------

const KINDS = new Set(["class", "function", "method", "const", "interface", "trait", "enum", "other"]);
const CONTAINER_KINDS = new Set(["class", "interface", "trait", "enum"]);
const key = (n: Node) => `${n.startIndex}:${n.endIndex}:${n.type}`;
const BANNER = /^(copyright|\(c\)|license|licence|all rights reserved|@author|\$Id[:$]|this (library|program|file) is free software)/im;
const SEPARATOR = /^[\s=*#+\-|_~.]*$/;
/** Comment words without the usual comment markers of any language. */
const commentBody = (text: string): string =>
	text
		.split("\n")
		.map((l) => l.replace(/^\s*(\/\*+|\/\/+|#+|--+|;+|\*(?!\/)|'''|"""|<!--)\s?/, "").replace(/\s*(\*+\/|'''|"""|-->)\s*$/, "").trimEnd())
		.join("\n")
		.trim();
const unquote = (s: string) => s.replace(/^[a-zA-Z]*(['"`]{1,3})/, "").replace(/(['"`]{1,3})$/, "");
/** Head of a declaration: its text up to the body, on one line. */
const headOf = (decl: Node): string => {
	const body = decl.childForFieldName("body");
	const raw = body ? decl.text.slice(0, body.startIndex - decl.startIndex) : decl.text.split("\n")[0]!;
	return raw.replace(/\s+/g, " ").trim().slice(0, 300);
};

/** Literal string arguments of a call (non-literals undefined), for the framework profile's loaders. */
function stringArgs(nameNode: Node, strings: string[]): Array<string | undefined> {
	let call: Node | null = nameNode;
	for (let i = 0; i < 3 && call; i++, call = call.parent) {
		const args = call.childForFieldName("arguments") ?? call.namedChildren.find((c) => c?.type.includes("argument")) ?? null;
		if (!args) continue;
		return args.namedChildren.map((a) => {
			const v = a && !strings.includes(a.type) && a.namedChildCount === 1 ? a.namedChildren[0] : a;
			if (v && strings.includes(v.type) && !v.namedChildren.some((c) => c && /interpolation|substitution/.test(c.type))) return unquote(v.text);
			return undefined;
		});
	}
	return [];
}

/** `import` target → a legacy file when it resolves inside the repo, else the name as written. */
function resolveImport(root: string, fromRel: string, spec: string, exts: string[]): string {
	const bases = spec.startsWith(".") || spec.startsWith("/") ? [normalize(join(dirname(join(root, fromRel)), spec))] : [join(root, spec), join(root, spec.replace(/\./g, "/"))];
	for (const b of bases)
		for (const c of [b, ...exts.map((e) => b + e), ...exts.map((e) => join(b, `index${e}`)), ...exts.map((e) => join(b, `__init__${e}`))]) {
			try {
				if (statSync(c).isFile()) return relative(root, c);
			} catch {
				/* next candidate */
			}
		}
	return basename(spec);
}

let profileCache: { key: string; profile?: ReturnType<typeof profileFromJson> } = { key: "" };
/** The model-written framework profile of the workspace (`br profile`), re-read when the file changes. */
function profile(): ReturnType<typeof profileFromJson> | undefined {
	const ws = process.env["BR_WORKSPACE"];
	const file = ws ? join(ws, ".bigrefactor", "framework-profile.json") : undefined;
	let mtime = 0;
	try {
		mtime = file ? statSync(file).mtimeMs : 0;
	} catch {
		/* none */
	}
	const k = `${file}|${mtime}`;
	if (k !== profileCache.key) profileCache = { key: k, profile: file && mtime ? profileFromJson(JSON.parse(readFileSync(file, "utf8")) as FrameworkProfileJson) : undefined };
	return profileCache.profile;
}

export function fromSourceManifest(m: SourceManifest, root: string): SourceAdapter {
	const lang = langKey(m);
	const wasm = grammarPath(m, root);
	if (wasm) registerGrammar(lang, wasm);
	const exts = [...new Set(m.include.map((g) => /(\.[A-Za-z0-9]+)$/.exec(g)?.[1]).filter((x): x is string => !!x))];
	const dynamic = new Set(m.dynamicCalls ?? []);
	const re = (s?: string) => (s ? new RegExp(s, "m") : undefined);

	return {
		id: m.id,
		include: m.include,
		exclude: m.exclude,
		docs: m.docs,
		names: { caseInsensitive: !!m.caseInsensitiveNames },
		reading: { indentSignificant: !!m.indentSignificant },
		traits: { globalState: re(m.traits?.globalState), languageArtifacts: m.traits?.languageArtifacts, mutatingCommands: re(m.traits?.mutatingCommands), vendorDirs: m.traits?.vendorDirs },

		async detect(dir) {
			const n = await countMatching(dir, m, 200);
			return { confidence: n >= 20 ? 0.8 : n > 0 ? 0.6 : 0 };
		},

		async indexFile(srcRoot, relPath, source) {
			const tree = await parse(lang, source);
			const symbols: IndexedSymbol[] = [];
			const deps: IndexedDep[] = [];
			const queries: IndexedQuery[] = [];
			const literalRefs = new Set<string>();
			const dynamicMarkers = new Set<string>();
			const seen = new Map<string, number>();
			const symId = (name: string) => {
				const base = `${relPath}::${name}`;
				const n = (seen.get(base) ?? 0) + 1;
				seen.set(base, n);
				return n === 1 ? base : `${base}#${n}`;
			};

			// --- symbols: containers first, so a method knows its class wherever it is captured
			const caps = (await matches(lang, tree, m.queries.symbols)).flat().filter((c) => KINDS.has(c.name) && c.node.parent);
			const containerName = new Map<string, string>(); // decl key → class name
			for (const c of caps) if (CONTAINER_KINDS.has(c.name)) containerName.set(key(c.node.parent!), c.node.text);
			const enclosingContainer = (n: Node): Node | undefined => {
				for (let p = n.parent; p; p = p.parent) if (containerName.has(key(p))) return p;
				return undefined;
			};
			const declOf = new Map<string, { id: string; kind: string; node: Node; short: string; container?: string }>();
			for (const c of caps) {
				const decl = c.node.parent!;
				if (declOf.has(key(decl))) continue;
				const name = c.node.text;
				const box = c.name === "method" || c.name === "const" || c.name === "function" ? enclosingContainer(decl) : undefined;
				const container = box ? containerName.get(key(box)) : undefined;
				const kind = (c.name === "function" && container ? "method" : c.name === "method" && !container ? "function" : c.name) as IndexedSymbol["kind"];
				const full = container ? `${container}::${name}` : name;
				const id = symId(full);
				declOf.set(key(decl), { id, kind, node: decl, short: name, container });
				symbols.push({ id, path: relPath, kind, name: full, line: c.node.startPosition.row + 1, endLine: decl.endPosition.row + 1, exported: true, astHash: createHash("sha1").update(normalizedAst(decl)).digest("hex").slice(0, 16), signature: kind === "function" || kind === "method" ? headOf(decl) : undefined });
			}
			const isFn = (d: { kind: string }) => d.kind === "function" || d.kind === "method";
			/** Innermost function/method around a node (its symbol), else undefined. */
			const fnOf = (n: Node) => {
				for (let p: Node | null = n; p; p = p.parent) {
					const d = declOf.get(key(p));
					if (d && isFn(d)) return d;
				}
				return undefined;
			};
			const owner = (n: Node) => fnOf(n)?.id ?? relPath;
			const classId = (n: Node) => {
				const box = enclosingContainer(n);
				return (box && declOf.get(key(box))?.id) || relPath;
			};

			// --- deps
			const prof = profile();
			const callsOf = new Map<string, CodeCall[]>(); // function id → calls
			const callAt = new Map<string, { fn: string; index: number }>();
			const addCall = (n: Node, call: CodeCall, callNode: Node) => {
				const fn = fnOf(n);
				if (!fn) return undefined;
				const list = callsOf.get(fn.id) ?? callsOf.set(fn.id, []).get(fn.id)!;
				callAt.set(key(callNode), { fn: fn.id, index: list.length });
				list.push(call);
				return list.length - 1;
			};
			const parents = new Map<string, string>(); // class name → parent
			const callNodeOf = (name: Node): Node => {
				for (let p: Node | null = name.parent, i = 0; p && i < 3; p = p.parent, i++) if (p.childForFieldName("arguments") || p.namedChildren.some((c) => c?.type.includes("argument"))) return p;
				return name.parent ?? name;
			};
			for (const c of (await matches(lang, tree, m.queries.deps)).flat()) {
				const text = c.node.text;
				switch (c.name) {
					case "import": {
						const spec = m.nodes.strings.includes(c.node.type) ? unquote(text) : text;
						if (spec) deps.push({ from: relPath, to: resolveImport(srcRoot, relPath, spec, exts), kind: "include" });
						break;
					}
					case "call":
						if (dynamic.has(text)) dynamicMarkers.add(text);
						else {
							deps.push({ from: owner(c.node), to: text, kind: "call" });
							for (const g of prof?.loaders(null, text, stringArgs(c.node, m.nodes.strings)) ?? []) deps.push({ from: owner(c.node), to: `glob:${g}`, kind: "load" });
							if (!m.queries.calls) addCall(c.node, { line: c.node.startPosition.row + 1, kind: "function", name: text }, callNodeOf(c.node));
						}
						break;
					case "new":
						deps.push({ from: owner(c.node), to: text, kind: "new" });
						if (!m.queries.calls) addCall(c.node, { line: c.node.startPosition.row + 1, kind: "new", name: text }, callNodeOf(c.node));
						break;
					case "extends":
					case "implements":
					case "use": {
						deps.push({ from: classId(c.node), to: text, kind: c.name });
						const box = enclosingContainer(c.node);
						if (c.name === "extends" && box) parents.set(containerName.get(key(box))!, text);
						break;
					}
				}
			}

			// --- calls of the code map (and static calls as edges)
			if (m.queries.calls) {
				const pending: Array<{ fn: string; index: number; receiver: Node }> = [];
				for (const match of await matches(lang, tree, m.queries.calls)) {
					const named = match.find((c) => ["function", "member", "static", "new"].includes(c.name));
					if (!named) continue;
					const recv = match.find((c) => c.name === "receiver" || c.name === "scope")?.node;
					const kind = named.name as CodeCall["kind"];
					const name = named.node.text;
					const line = named.node.startPosition.row + 1;
					const call: CodeCall = { line, kind, name };
					if (kind === "static" && recv) {
						call.scope = /^(self|static|this)$/i.test(recv.text) ? "self" : /^(parent|super)$/i.test(recv.text) ? "parent" : recv.text.split(/[\\.:]/).pop();
						deps.push({ from: owner(named.node), to: `${recv.text}::${name}`, kind: "static_call" });
						for (const g of prof?.loaders(recv.text, name, stringArgs(named.node, m.nodes.strings)) ?? []) deps.push({ from: owner(named.node), to: `glob:${g}`, kind: "load" });
					}
					if (kind === "member" && recv) call.receiver = /^(this|self|\$this|@)$/.test(recv.text) ? "this" : /^[$@]?\w+$/.test(recv.text) ? recv.text : undefined;
					if (kind === "function" && dynamic.has(name)) dynamicMarkers.add(name);
					const index = addCall(named.node, call, callNodeOf(named.node));
					const fn = fnOf(named.node);
					if (index !== undefined && fn && kind === "member" && recv) pending.push({ fn: fn.id, index, receiver: recv });
				}
				for (const p of pending) {
					const at = callAt.get(key(p.receiver));
					if (at && at.fn === p.fn) callsOf.get(p.fn)![p.index]!.receiverCall = at.index;
				}
			}

			// --- comments, string literals (resource keys, class names), SQL
			const comments: Node[] = [];
			walk(tree.rootNode, (n) => {
				if (m.nodes.comments.includes(n.type)) {
					comments.push(n);
					return false;
				}
				if (m.nodes.strings.includes(n.type)) {
					const text = unquote(n.text);
					for (const x of text.matchAll(/\b([A-Z][A-Za-z0-9_]{2,})\b/g)) literalRefs.add(x[1]!);
					if (/^[a-z0-9_.-]+(\/[a-z0-9_.-]+)*$/.test(text) && text.length >= 3 && text.length <= 120) literalRefs.add(text);
					const tables = sqlTables(text);
					if (tables.length) queries.push({ symbolId: owner(n), kind: "sql", tables, text: text.slice(0, 200) });
					return false;
				}
				return true;
			});

			// files without declarations still count: one synthetic symbol (what the file is, Jev and the profile say)
			if (!symbols.length) symbols.push({ id: symId("script"), path: relPath, kind: "other", name: relPath.split("/").pop()!, line: 1, exported: true });
			for (const g of prof?.impliedDeps?.(relPath) ?? []) deps.push({ from: relPath, to: `glob:${g}`, kind: "load" });

			// --- code map: functions with their comments and calls; containers with their parents
			const toComment = (c: Node, kind?: CodeComment["kind"]): CodeComment => {
				const body = commentBody(c.text);
				return { line: c.startPosition.row + 1, endLine: c.endPosition.row + 1, col: c.startPosition.column, endCol: c.endPosition.column, text: c.text, body, kind: BANNER.test(body) || SEPARATOR.test(body) ? "banner" : (kind ?? "note") };
			};
			const functions: CodeFunction[] = [];
			const fns = [...declOf.values()].filter(isFn);
			for (const d of fns) {
				const start = d.node.startPosition.row;
				// doc: the comments right above the declaration (line by line, no gap)
				const doc: CodeComment[] = [];
				let row = start;
				for (const c of [...comments].reverse()) {
					if (c.endPosition.row === row - 1 || (c.endPosition.row === row && c.endIndex <= d.node.startIndex)) {
						doc.unshift(toComment(c, "doc"));
						row = c.startPosition.row;
					} else if (c.endPosition.row < row - 1) break;
				}
				const inner = comments.filter((c) => c.startIndex >= d.node.startIndex && c.endIndex <= d.node.endIndex && fnOf(c)?.id === d.id).map((c) => toComment(c));
				functions.push({ id: d.id, container: d.kind === "method" ? d.container : undefined, name: d.short, line: start + 1, endLine: d.node.endPosition.row + 1, signature: headOf(d.node), comments: [...doc, ...inner], calls: callsOf.get(d.id) ?? [], locals: {}, assigned: {} });
			}
			const containers: CodeContainer[] = [...new Set(containerName.values())].map((name) => ({ name, parent: parents.get(name) }));
			return { path: relPath, lang: m.language, loc: source.split("\n").length, hash: createHash("sha1").update(source).digest("hex"), symbols, deps, routes: [], queries, literalRefs: [...literalRefs], dynamicMarkers: [...dynamicMarkers], functions, containers };
		},

		classifyKind(file) {
			return file.queries.length ? "data_access" : undefined;
		},
		isEntryPoint: (path) => profile()?.entryPoint?.test(path) ?? false,
		frameworkDirs: () => profile()?.frameworkDirs ?? [],
		get frameworkConcerns() {
			return profile()?.concerns ?? [];
		},
		get legacyWords() {
			return profile()?.legacyWords;
		},
		reloadProfile() {
			profileCache = { key: "" };
		},
		profileExample() {
			return { example: exampleProfileJson(), schemaDoc: phpAdapter.profileExample!().schemaDoc };
		},
		validateProfile: (json) => phpAdapter.validateProfile!(json),
		truth: {
			scriptName: m.truth.scriptName,
			run: (sourceRoot, script) => ({ cmd: m.truth.run.cmd.replaceAll("{script}", script).replaceAll("{root}", sourceRoot), args: m.truth.run.args.map((a) => a.replaceAll("{script}", script).replaceAll("{root}", sourceRoot)) }),
			instructions: m.truth.instructions,
		},
		...(m.oldTestCommand ? { oldTestCommand: () => m.oldTestCommand! } : {}),
		externalDeps: () => (m.packages ?? []).map((p) => ({ name: p.name, version: p.version, dev: !!p.dev, verdict: "review" as const })),
		dbSignals: () => m.dataStores ?? [],
	};
}

/** Files under `dir` the manifest owns, counted up to `limit` (bounded walk, vendor dirs skipped). */
async function countMatching(dir: string, m: SourceManifest, limit: number): Promise<number> {
	const { globToRegExp } = await import("../../sessions/spawn.ts");
	const inc = m.include.map(globToRegExp);
	const exc = m.exclude.map(globToRegExp);
	const skip = new Set([".git", "node_modules", ...(m.traits?.vendorDirs ?? [])]);
	let n = 0;
	const visit = (abs: string, depth: number) => {
		if (n >= limit || depth > 5) return;
		let entries;
		try {
			entries = readdirSync(abs, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (n >= limit) return;
			const rel = relative(dir, join(abs, e.name)).split("\\").join("/");
			if (e.isDirectory()) {
				if (!skip.has(e.name)) visit(join(abs, e.name), depth + 1);
			} else if (inc.some((r) => r.test(rel)) && !exc.some((r) => r.test(rel))) n++;
		}
	};
	if (existsSync(dir)) visit(dir, 0);
	return n;
}
// ---- storage ----------------------------------------------------------------------------------------------

export const sourceAdaptersDir = (root: string) => join(root, ".bigrefactor", "adapters", "source");
/** Where the model writes its manifest; it is moved to `<id>.json` once code has verified it. */
export const draftPath = (root: string) => join(sourceAdaptersDir(root), "draft", "manifest.json");

/** Verified source manifests of this workspace (a structurally broken one, e.g. edited by hand, is skipped). */
export function loadSourceManifests(root: string): SourceManifest[] {
	const dir = sourceAdaptersDir(root);
	if (!existsSync(dir)) return [];
	const out: SourceManifest[] = [];
	for (const n of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
		try {
			const m = JSON.parse(readFileSync(join(dir, n), "utf8")) as SourceManifest;
			if (!validateSourceManifest(m).length) out.push(m);
		} catch {
			/* unreadable: skipped */
		}
	}
	return out;
}

// ---- verification -----------------------------------------------------------------------------------------

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "cmd", "cmd.exe", "powershell", "pwsh", "eval", "exec", "xargs", "sudo", "su", "doas"]);

/** Shape problems (no grammar or files needed); empty = fine. */
export function validateSourceManifest(m: SourceManifest): string[] {
	const out: string[] = [];
	if (!m || typeof m !== "object") return ["not a JSON object"];
	if (!/^[a-z][a-z0-9-]*$/.test(m.id ?? "")) out.push(`id "${m.id}" must be lowercase letters, digits and dashes`);
	if (!m.language) out.push("language is missing");
	if (!Array.isArray(m.include) || !m.include.length) out.push("include must list file globs");
	if (!Array.isArray(m.exclude)) out.push("exclude must be an array (may be empty)");
	if (!m.grammar?.package || !m.grammar?.wasm) out.push("grammar needs package and wasm");
	if (!m.queries?.symbols) out.push("queries.symbols is missing");
	if (typeof m.queries?.deps !== "string") out.push("queries.deps is missing (may be an empty string)");
	if (!Array.isArray(m.nodes?.comments) || !Array.isArray(m.nodes?.strings)) out.push("nodes.comments and nodes.strings must be arrays of node types");
	const t = m.truth;
	if (!t?.scriptName || /[/\\]/.test(t.scriptName)) out.push("truth.scriptName must be a plain file name");
	if (!t?.run || typeof t.run.cmd !== "string" || !Array.isArray(t.run.args)) out.push("truth.run needs cmd + args");
	else {
		if (!/^[\w@+.-]+(\/[\w@+.-]+)*$/.test(t.run.cmd) || t.run.cmd.includes("..")) out.push(`truth.run.cmd "${t.run.cmd}" must be one executable`);
		if (SHELLS.has(basename(t.run.cmd).toLowerCase())) out.push(`truth.run.cmd "${t.run.cmd}" is a shell; name the language's runtime`);
		if (t.run.args.some((a) => typeof a !== "string" || /[;&|`$<>\n]/.test(a))) out.push("truth.run.args contain shell syntax; give plain arguments");
		if (!t.run.args.some((a) => a.includes("{script}"))) out.push("truth.run.args must contain {script}");
	}
	if (!t?.probe) out.push("truth.probe (a script that prints []) is missing");
	if (m.packages !== undefined && (!Array.isArray(m.packages) || m.packages.some((p) => !p || typeof p.name !== "string" || !p.name))) out.push("packages must be an array of {name, version?, dev?}");
	if (m.dataStores !== undefined && (!Array.isArray(m.dataStores) || m.dataStores.some((d) => !d || !/^[a-z0-9]+$/.test(d.engine ?? "") || typeof d.evidence !== "string"))) out.push("dataStores must be an array of {engine (one lowercase word, e.g. mysql), evidence}");
	for (const [k, r] of [["traits.globalState", m.traits?.globalState], ["traits.mutatingCommands", m.traits?.mutatingCommands]] as const) {
		if (!r) continue;
		try {
			new RegExp(r);
		} catch {
			out.push(`${k} is not a valid regex`);
		}
	}
	return out;
}

/**
 * Proves a manifest on the real legacy repo: grammar loads, node types exist, queries compile, most sample files
 * yield symbols, and the truth command runs a probe script that prints []. Undefined = all good, else what failed.
 */
export async function verifySourceManifest(m: SourceManifest, o: { root: string; sourceRoot: string; sample?: number }): Promise<string | undefined> {
	const shape = validateSourceManifest(m);
	if (shape.length) return `invalid manifest:\n${shape.join("\n")}`;
	const wasm = grammarPath(m, o.root);
	if (!wasm) return `grammar not found: neither ${join(grammarsDir(o.root), "node_modules", m.grammar.package, m.grammar.wasm)} nor ${m.grammar.package}/${m.grammar.wasm} in the plugin exists (install it: npm install --prefix ${grammarsDir(o.root)} ${m.grammar.package}; check the .wasm file name inside it)`;
	registerGrammar(langKey(m), wasm);
	let language;
	try {
		language = await getLanguage(langKey(m));
	} catch (e: any) {
		return `the grammar ${wasm} does not load: ${e?.message ?? e} (it must be a tree-sitter .wasm built for a current tree-sitter ABI)`;
	}
	const problems: string[] = [];
	for (const t of [...m.nodes.comments, ...m.nodes.strings]) if (language.idForNodeType(t, true) === null) problems.push(`node type "${t}" does not exist in this grammar`);
	for (const [k, q] of [["symbols", m.queries.symbols], ["deps", m.queries.deps], ["calls", m.queries.calls]] as const) {
		if (!q) continue;
		try {
			new Query(language, q).delete();
		} catch (e: any) {
			problems.push(`queries.${k} does not compile: ${e?.message ?? e}`);
		}
	}
	if (problems.length) return problems.join("\n");

	const { listFiles } = await import("../../inventory/run.ts");
	const files = listFiles(o.sourceRoot, m);
	if (!files.length) return `include/exclude match no file under ${o.sourceRoot}`;
	const n = o.sample ?? 40;
	const sample = files.length <= n ? files : Array.from({ length: n }, (_, i) => files[Math.floor((i * files.length) / n)]!);
	const adapter = fromSourceManifest(m, o.root);
	const empty: string[] = [];
	const broken: string[] = [];
	for (const f of sample) {
		try {
			const idx = await adapter.indexFile(o.sourceRoot, f, readFileSync(join(o.sourceRoot, f), "utf8"));
			if (idx.symbols.every((s) => s.kind === "other" && s.id.endsWith("::script"))) empty.push(f);
		} catch (e: any) {
			broken.push(`${f}: ${String(e?.message ?? e).slice(0, 200)}`);
		}
	}
	if (broken.length) problems.push(`indexing failed on ${broken.length} of ${sample.length} sample files:\n${broken.slice(0, 5).join("\n")}`);
	if (empty.length * 2 > sample.length) problems.push(`queries.symbols found no declaration in ${empty.length} of ${sample.length} sample files, e.g. ${empty.slice(0, 5).join(", ")}`);

	const truth = probeTruth(m, o.root, o.sourceRoot);
	if (truth) problems.push(truth);
	return problems.length ? problems.join("\n") : undefined;
}

/** Runs truth.probe with truth.run from the legacy root; it must print []. */
function probeTruth(m: SourceManifest, root: string, sourceRoot: string): string | undefined {
	const dir = join(sourceAdaptersDir(root), "probe");
	mkdirSync(dir, { recursive: true });
	const script = join(dir, m.truth.scriptName);
	writeFileSync(script, m.truth.probe);
	const fill = (a: string) => a.replaceAll("{script}", script).replaceAll("{root}", sourceRoot);
	const cmd = [fill(m.truth.run.cmd), ...m.truth.run.args.map(fill)];
	try {
		const out = execFileSync(cmd[0]!, cmd.slice(1), { cwd: sourceRoot, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
		const at = out.indexOf("[");
		let ok = false;
		try {
			const v = at >= 0 ? JSON.parse(out.slice(at)) : undefined;
			ok = Array.isArray(v) && v.length === 0;
		} catch {
			/* not JSON */
		}
		return ok ? undefined : `truth: \`${cmd.join(" ")}\` ran but did not print [] (stdout: ${out.trim().slice(0, 300) || "empty"})`;
	} catch (e: any) {
		return `truth: \`${cmd.join(" ")}\` failed: ${[e?.stderr, e?.stdout, e?.message].map((x) => String(x ?? "").trim()).filter(Boolean).join("\n").slice(0, 800)}`;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ---- generation -------------------------------------------------------------------------------------------

/** A JavaScript manifest: the worked example the model sees (and a test fixture). */
export function exampleSourceManifest(): SourceManifest {
	return {
		id: "javascript",
		language: "javascript",
		include: ["**/*.js", "**/*.mjs", "**/*.cjs"],
		exclude: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.git/**", "**/vendor/**", "**/*.min.js", "**/test/**", "**/tests/**"],
		grammar: { package: "tree-sitter-javascript", wasm: "tree-sitter-javascript.wasm" },
		queries: {
			symbols: [
				"(function_declaration name: (identifier) @function)",
				"(generator_function_declaration name: (identifier) @function)",
				"(class_declaration name: (identifier) @class)",
				"(method_definition name: (property_identifier) @method)",
				"(variable_declarator name: (identifier) @function value: [(arrow_function) (function_expression)])",
			].join("\n"),
			deps: [
				"(import_statement source: (string) @import)",
				'(call_expression function: (identifier) @_req arguments: (arguments (string) @import) (#eq? @_req "require"))',
				"(call_expression function: (identifier) @call)",
				"(new_expression constructor: (identifier) @new)",
				"(class_heritage (identifier) @extends)",
			].join("\n"),
			calls: [
				"(call_expression function: (identifier) @function)",
				"(call_expression function: (member_expression object: (_) @receiver property: (property_identifier) @member))",
				"(new_expression constructor: (identifier) @new)",
			].join("\n"),
		},
		nodes: { comments: ["comment"], strings: ["string", "template_string"] },
		dynamicCalls: ["eval", "Function"],
		traits: { globalState: "\\b(window|globalThis|document\\.cookie|localStorage|sessionStorage|process\\.env)\\b", languageArtifacts: ["loose equality (==) and truthiness", "prototype patching"], mutatingCommands: "\\b(npm|yarn|pnpm)\\s+(install|i|add|remove|update|ci)\\b", vendorDirs: ["node_modules"] },
		packages: [{ name: "pg", version: "^8.11.0" }, { name: "jest", version: "^29.0.0", dev: true }],
		dataStores: [{ engine: "postgresql", evidence: "package.json depends on pg" }],
		docs: [{ name: "MDN JavaScript reference", url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference" }],
		truth: {
			scriptName: "cases.cjs",
			run: { cmd: "node", args: ["{script}"] },
			instructions: "a Node script that require()s the legacy files (paths relative to the legacy root; it runs from there), calls each case and prints ONE JSON array with console.log(JSON.stringify(...)).",
			probe: "console.log(JSON.stringify([]));\n",
		},
	};
}

const SYSTEM = (root: string, sourceRoot: string, draft: string) => `You write a SOURCE adapter manifest so a migration tool can index a legacy codebase in a language it has no built-in support for. The manifest is DATA; the tool's generic tree-sitter indexer interprets it.

The legacy code is at ${sourceRoot} (read-only: never write there). The workspace is ${root}.

Work like this:
1. Look at the legacy repo with ls, find, grep and read: which language(s), which file extensions, which folders are third-party or generated (vendor, node_modules, build output), how code is loaded (imports, requires, includes).
2. Pick the tree-sitter grammar npm package for the main language (e.g. tree-sitter-python, tree-sitter-ruby, tree-sitter-java, tree-sitter-go, tree-sitter-c-sharp). Install it into the workspace: npm install --prefix ${grammarsDir(root)} <package>. Check which .wasm file it ships: find ${grammarsDir(root)}/node_modules/<package> -name '*.wasm'. A package without a .wasm cannot be used: try another version or package.
3. Read the grammar's src/node-types.json (or grammar.js / queries/tags.scm) to learn the real node types and field names. Write the queries with those names only.
4. Write the manifest to ${draft}. The tool then checks it (grammar loads, node types exist, queries compile, most sample files yield symbols, the truth command prints []) and tells you exactly what failed.

Manifest fields:
- id: lowercase adapter id (usually the language, e.g. "python"); language: the language name.
- include / exclude: file globs relative to the legacy root (** for any folders). Exclude third-party, generated and test folders.
- grammar: { package, wasm } — wasm is the file's path inside the package.
- queries.symbols: tree-sitter query that captures the NAME node of each declaration; the capture name is the kind: @class @function @method @const @interface @trait @enum @other. The declaration is the name node's parent.
- queries.deps: captures @import (the string or name of an imported module/file), @call (name of a called function), @new (name of a constructed class), @extends, @implements, @use (mixins/traits). Use predicates like (#eq? @_x "require") with captures starting with _ for helpers.
- queries.calls (optional, for the code map): per pattern one of @function (plain call name), @member (method name, with @receiver on the object), @static (class-level call name, with @scope on the class), @new.
- nodes.comments / nodes.strings: the grammar's node types for comments and string literals.
- dynamicCalls: called names that dispatch dynamically in this language (eval, getattr, send, reflection).
- caseInsensitiveNames: true only when the language matches names regardless of case. indentSignificant: true when indentation is syntax.
- traits: globalState (regex over source text for process-global state), languageArtifacts (one-line constructs that do not carry over), mutatingCommands (regex for package-manager commands that would change the checkout), vendorDirs.
- docs: official language docs URLs.
- truth: how a tester runs a script against the OLD code: scriptName (file name with the language's extension), run {cmd, args} — ONE executable, plain args, no shell; {script} is the script path, {root} the legacy root (the command runs there) — instructions (one sentence: how the script loads legacy code and prints ONE JSON array), probe (the smallest script that prints [] ). Try the command yourself with bash on a probe script in ${root}/.bigrefactor/scratch/ (never in the legacy repo).
- oldTestCommand (optional): the legacy test runner command.
- packages: the third-party packages the repo declares, read from its package manifest(s) (whatever this language uses): [{name, version, dev}]. Leave out the language runtime itself.
- dataStores: the databases, caches and queues the code talks to: [{engine: one lowercase word (mysql, postgresql, sqlite, mongodb, redis …), evidence: where you saw it (a driver package, a connection string, a compose service)}]. An empty array when there are none.
Do not describe framework conventions (entry points, routes, templates): another step reads them from the code.
Worked example (JavaScript):
${JSON.stringify(exampleSourceManifest(), null, 2)}
End the session right after writing the file.`;

/** A session that writes the draft manifest (a model with tools; tests pass a scripted one). */
export interface ManifestWriter {
	run(prompt: string): Promise<unknown>;
	dispose(): void;
}

/**
 * A model with tools looks at the legacy repo, installs a grammar and writes the manifest; code verifies it on the
 * real repo. Each failure goes back to the same session, up to `repairs` times. Returns the saved manifest.
 */
export async function generateSourceAdapter(opts: { root: string; sourceRoot: string; id?: string; config?: Config; writer?: ManifestWriter; repairs?: number; log?: (l: string) => void }): Promise<SourceManifest> {
	const log = opts.log ?? (() => {});
	const draft = draftPath(opts.root);
	rmSync(dirname(draft), { recursive: true, force: true });
	mkdirSync(dirname(draft), { recursive: true });
	const writer = opts.writer ?? (await defaultWriter(opts.root, opts.sourceRoot, draft, opts.config, opts.id));
	let prompt = `Write the source adapter manifest for the legacy code at ${opts.sourceRoot}${opts.id ? ` (id must be "${opts.id}")` : ""}.`;
	let failure = "";
	try {
		for (let attempt = 0; attempt <= (opts.repairs ?? 2); attempt++) {
			await writer.run(prompt);
			let m: SourceManifest | undefined;
			try {
				m = JSON.parse(readFileSync(draft, "utf8")) as SourceManifest;
			} catch (e: any) {
				failure = existsSync(draft) ? `${draft} is not valid JSON: ${e?.message ?? e}` : `${draft} was not written`;
			}
			if (m) {
				if (opts.id) m.id = opts.id;
				log(`  source adapter: manifest written (attempt ${attempt + 1}), checking it on the legacy code…`);
				const problem = await verifySourceManifest(m, { root: opts.root, sourceRoot: opts.sourceRoot }).catch((e: any) => String(e?.message ?? e));
				if (!problem) {
					mkdirSync(sourceAdaptersDir(opts.root), { recursive: true });
					writeFileSync(join(sourceAdaptersDir(opts.root), `${m.id}.json`), JSON.stringify(m, null, 2) + "\n");
					rmSync(dirname(draft), { recursive: true, force: true });
					log(`  source adapter ${m.id}: verified (grammar, queries, sample files, truth command)`);
					return m;
				}
				failure = problem;
			}
			log(`  source adapter: attempt ${attempt + 1} rejected — ${failure.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3).join("; ")}`);
			prompt = `The check failed:\n${failure.slice(-3000)}\nFix the manifest and write ${draft} again.`;
		}
	} finally {
		writer.dispose();
	}
	throw new Error(`no working source adapter could be written: ${failure.split("\n").slice(0, 6).join("\n")}`);
}

async function defaultWriter(root: string, sourceRoot: string, draft: string, config: Config | undefined, id: string | undefined): Promise<ManifestWriter> {
	const { ConfigSchema } = await import("../../config.ts");
	const { spawnLeaf } = await import("../../sessions/spawn.ts");
	// before init has written a config (the stack is what is being found out), a provisional one carries the defaults
	const cfg = config ?? ConfigSchema.parse({ source: { path: sourceRoot, stack: id ?? "unknown" }, target: { path: join(root, ".bigrefactor", "no-target"), stacks: ["none"] }, models: {} });
	return spawnLeaf({
		role: "setup",
		cwd: root,
		config: cfg,
		writeGlobs: [".bigrefactor/adapters/source/draft/**", ".bigrefactor/grammars/**", ".bigrefactor/scratch/**"],
		systemPrompt: SYSTEM(root, sourceRoot, draft),
		transcriptPath: join(root, ".bigrefactor", "sessions", `__init__.source-adapter.${Date.now()}.jsonl`),
	});
}
