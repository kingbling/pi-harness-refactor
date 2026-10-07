import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { captures, parse, registerGrammar, type Node } from "../../inventory/treesitter.ts";

registerGrammar("typescript", "tree-sitter-typescript/tree-sitter-typescript.wasm");
registerGrammar("tsx", "tree-sitter-typescript/tree-sitter-tsx.wasm");
registerGrammar("javascript", "tree-sitter-javascript/tree-sitter-javascript.wasm");
import type { TargetSymbol } from "../types.ts";

/**
 * TypeScript/TSX export indexer shared by the TypeScript-based target adapters (NestJS, React).
 * The core never calls this directly: it goes through `TargetAdapter.indexFile`.
 */
const QUERY = `
(export_statement declaration: (function_declaration name: (identifier) @fn))
(export_statement declaration: (class_declaration name: (type_identifier) @cls))
(export_statement declaration: (abstract_class_declaration name: (type_identifier) @cls))
(export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @const)))
(export_statement declaration: (interface_declaration name: (type_identifier) @iface))
(export_statement declaration: (enum_declaration name: (identifier) @enum))
(export_statement declaration: (type_alias_declaration name: (type_identifier) @type))
(program (function_declaration name: (identifier) @ifn))
(program (lexical_declaration (variable_declarator name: (identifier) @iconst value: (arrow_function))))
(program (class_declaration name: (type_identifier) @icls))
`;

/** Captures of declarations that are not exported (`@ifn` …). */
const INTERNAL = new Set(["ifn", "iconst", "icls"]);

export interface TsIndexOptions {
	/** Decorator name → kind (framework specific, e.g. Controller → controller). */
	decoratorKinds?: Record<string, string>;
	/** Name suffix → kind when no decorator applies (e.g. /Dto$/ → dto). */
	nameKinds?: Array<[RegExp, string]>;
	sharedDirs: string[];
}

export async function indexTsFile(projectDir: string, rel: string, opts: TsIndexOptions): Promise<TargetSymbol[]> {
	const source = readFileSync(join(projectDir, rel), "utf8");
	const lang = rel.endsWith("x") ? "tsx" : "typescript";
	const tree = await parse(lang, source);
	const out: TargetSymbol[] = [];
	const shared = opts.sharedDirs.some((d) => rel.startsWith(d));
	for (const c of await captures(lang, tree, QUERY)) {
		const internal = INTERNAL.has(c.name);
		const cap = internal ? c.name.slice(1) : c.name;
		const decl = cap === "const" ? c.node.parent!.parent! : c.node.parent!;
		const name = c.node.text;
		const fnOf = (n: Node | null | undefined) => (n?.type === "arrow_function" || n?.type === "function_declaration" || n?.type === "function_expression" ? n : null);
		const fn = cap === "fn" ? decl : cap === "const" ? fnOf(c.node.parent!.childForFieldName("value")) : null;
		const fnHash = fn ? bodyHash(fn.childForFieldName("body"), fn.childForFieldName("parameters") ?? fn.childForFieldName("parameter")) : undefined;
		// not exported: only its bodies matter (the gate's copy check on fresh files); indexTarget never stores them
		if (internal) {
			if (fnHash) out.push({ id: `${rel}::${name}`, path: rel, kind: "function", name, line: c.node.startPosition.row + 1, tags: ["internal"], bodyHash: fnHash });
			if (cap === "cls") out.push(...methods(rel, decl, name, false, true));
			continue;
		}
		const exportStmt = decl.parent!;
		const doc = jsdoc(exportStmt);
		const decorators = exportStmt.namedChildren.filter((n) => n?.type === "decorator").map((n) => n!.text);
		const tags: string[] = [];
		let kind: string = cap === "fn" ? "function" : cap === "cls" ? "class" : cap === "iface" ? "interface" : cap === "enum" ? "enum" : cap === "type" ? "type" : "const";
		for (const [deco, k] of Object.entries(opts.decoratorKinds ?? {})) if (decorators.some((d) => d.startsWith(`@${deco}`))) kind = typeof k === "string" ? k : kind;
		if (kind === "class" || kind === "interface") for (const [re, k] of opts.nameKinds ?? []) if (re.test(name)) kind = k;
		if (shared && (kind === "function" || kind === "const" || kind === "class")) kind = "helper";
		if (shared) tags.push("shared");
		if (cap === "cls") tags.push("class");
		for (const d of decorators) tags.push(d.replace(/\(.*$/s, ""));
		const signature = cap === "fn" ? signatureOf(decl) : cap === "const" ? decl.text.slice(0, 120).replace(/\s+/g, " ") : undefined;
		out.push({ id: `${rel}::${name}`, path: rel, kind, name, line: c.node.startPosition.row + 1, signature, doc, tags, bodyHash: fnHash });
		if (cap === "cls") out.push(...methods(rel, decl, name, shared, false));
	}
	return out;
}

/** Methods of a class: public ones of an exported class are indexed; private/protected (or all of an internal class) are "internal". */
function methods(rel: string, decl: Node, cls: string, shared: boolean, internalClass: boolean): TargetSymbol[] {
	const out: TargetSymbol[] = [];
	for (const m of decl.childForFieldName("body")?.namedChildren ?? []) {
		if (m?.type !== "method_definition") continue;
		const mn = m.childForFieldName("name")?.text;
		if (!mn || mn === "constructor") continue;
		const internal = internalClass || /\bprivate\b|\bprotected\b/.test(m.text.slice(0, m.text.indexOf(mn))) || mn.startsWith("#");
		const accessor = m.children.some((k) => k?.type === "get" || k?.type === "set");
		const hash = accessor ? undefined : bodyHash(m.childForFieldName("body"), m.childForFieldName("parameters"));
		if (internal) {
			if (hash) out.push({ id: `${rel}::${cls}.${mn}`, path: rel, kind: "method", name: `${cls}.${mn}`, line: m.startPosition.row + 1, tags: ["internal"], bodyHash: hash });
			continue;
		}
		out.push({ id: `${rel}::${cls}.${mn}`, path: rel, kind: "method", name: `${cls}.${mn}`, line: m.startPosition.row + 1, signature: signatureOf(m), doc: jsdoc(m), tags: shared ? ["shared"] : [], bodyHash: hash });
	}
	return out;
}

/** Facts a tester/implementer must respect, read from the project config rather than guessed. */
export function tsProjectNotes(projectDir: string): string[] {
	const notes: string[] = [];
	try {
		const tsconfig = readFileSync(join(projectDir, "tsconfig.json"), "utf8");
		if (/"moduleResolution"\s*:\s*"node(16|next)"/i.test(tsconfig) || /"module"\s*:\s*"node(16|next)"/i.test(tsconfig)) notes.push('this project uses NodeNext module resolution: every relative import MUST carry a ".js" extension (import { x } from "./pricing.js"); an extensionless import fails tsc for everyone');
	} catch {
		/* no tsconfig */
	}
	const runner = tsTestRunner(projectDir);
	if (runner === "vitest") notes.push('tests run with Vitest (detected in package.json): import { describe, it, expect, vi, beforeEach } from "vitest"; never import "@jest/globals" or use jest.* — they are not installed');
	else if (runner === "jest") notes.push('tests run with Jest (detected in package.json): use jest globals or import from "@jest/globals"; never import "vitest"');
	return notes;
}

/** The test runner the project actually has (package.json), whatever was chosen: generators decide. */
export function tsTestRunner(projectDir: string): "vitest" | "jest" | undefined {
	try {
		const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
		const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
		return "vitest" in deps ? "vitest" : "jest" in deps ? "jest" : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Does the bootstrapped project match the stack choices? Chosen packages must be installed and the chosen
 * test runner must be the one the project has. Returns problems (empty = consistent).
 */
export function tsVerifyChoices(projectDir: string, chosen: Array<{ key: string; id: string; packages?: string[] }>): import("../types.ts").ChoiceProblem[] {
	const problems: import("../types.ts").ChoiceProblem[] = [];
	let deps: Record<string, string> = {};
	try {
		const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
		deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
	} catch {
		return [{ text: `${projectDir}: no package.json`, everyUnit: true }];
	}
	for (const c of chosen) {
		const missing = (c.packages ?? []).filter((p) => !(p in deps));
		if (missing.length) problems.push({ text: `${c.key}=${c.id}: packages not installed: ${missing.join(", ")}`, everyUnit: false, fix: `pnpm add ${missing.join(" ")}` });
		if (c.key === "tests") {
			const runner = tsTestRunner(projectDir);
			// every unit ports tests: a runner mismatch fails every gate the same way
			if (runner && runner !== c.id) problems.push({ text: `tests=${c.id} but the project runs ${runner}`, everyUnit: true });
		}
	}
	return problems;
}

/**
 * Shared TS layout pieces. A function, not a const: Pi's extension loader (jiti, CJS) can evaluate an adapter
 * while this module is still mid-load, and a `const` read then yields undefined (the spread silently became {},
 * dropping sharedDirs and crashing rules). Function declarations are hoisted, so this is safe in any load order.
 */
export function tsLayoutBase() {
	return {
		sharedDirs: ["src/shared/"], // one shared dir: src/shared/<area>/ for code ≥ 2 feature areas use
		sourceExtensions: [".ts", ".tsx"],
		isTestFile: (p: string) => /\.(spec|test|e2e-spec)\.[cm]?[jt]sx?$/.test(p) || /\.d\.ts$/.test(p),
		lang: (p: string) => (/\.tsx$/.test(p) ? "tsx" : /\.[cm]?ts$/.test(p) ? "typescript" : /\.[cm]?jsx?$/.test(p) ? "javascript" : undefined),
		skipMarker: /\.(skip|only|todo)\s*\(/,
		interfaceHint: "TypeScript signatures; DTOs/classes where the legacy code used arrays",
		legacyMarker: (why: string) => `// LEGACY: ${why}`,
		ignoreDirs: ["node_modules", "dist", "build", "coverage", ".git", "test", "tests", "__tests__"],
	};
}

/** Node project with pnpm: manifest, installed packages, how to add some, what worktrees share and git never sees. */
export function nodeToolchain(): import("../types.ts").TargetToolchain {
	const deps = (dir: string): string[] => {
		try {
			const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
			return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
		} catch {
			return [];
		}
	};
	return {
		ecosystem: "npm",
		packageName: /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*/,
		packageExamples: ["exceljs", "@aws-sdk/client-s3"],
		isProjectReady: (dir) => existsSync(join(dir, "package.json")),
		manifestFiles: ["package.json", "pnpm-lock.yaml"],
		installedPackages: deps,
		addPackages: (_dir, packages) => ({ cmd: "pnpm", args: ["add", ...packages] }),
		worktreeLinks: ["node_modules"],
		ignoredPaths: ["node_modules", "dist"],
	};
}
/** @deprecated use tsLayoutBase(); kept for importers outside the adapters. */
export const TS_LAYOUT_BASE = tsLayoutBase();

function jsdoc(n: Node): string | undefined {
	const prev = n.previousNamedSibling;
	if (prev?.type === "comment" && prev.text.startsWith("/**")) {
		const text = prev.text.replace(/^\/\*\*|\*\/$/g, "").replace(/^\s*\*\s?/gm, "").trim();
		return text.split(/\n\s*\n|\n@/)[0]!.replace(/\s+/g, " ").slice(0, 200);
	}
	return undefined;
}

/**
 * Duplicate detector: hash of a function body's tokens with whitespace, semicolons, comments and type annotations
 * dropped and local names (parameters, declared variables) replaced by their order of use, so a copy with other
 * formatting, types or renamed locals still matches; member and callee names are kept. Bodies under 3 statements
 * or MIN_TOKENS tokens (getters, delegations, the idiomatic load-or-404 handler) are too common to mean anything.
 */
const MIN_TOKENS = 34;
export function bodyHash(body: Node | null | undefined, params?: Node | null): string | undefined {
	if (body?.type !== "statement_block") return undefined;
	if (body.namedChildren.filter((n) => n && n.type !== "comment").length < 3) return undefined;
	const locals = new Set<string>();
	const bindAll = (n: Node | null | undefined) => {
		if (!n || TYPE_NODES.has(n.type)) return;
		if (BINDING.has(n.type)) locals.add(n.text);
		for (const k of n.namedChildren) bindAll(k);
	};
	bindAll(params);
	const declare = (n: Node) => {
		for (const f of DECLARES[n.type] ?? []) bindAll(n.childForFieldName(f));
		for (const k of n.namedChildren) if (k) declare(k);
	};
	declare(body);
	const order = new Map<string, string>();
	const toks: string[] = [];
	const visit = (n: Node) => {
		if (TYPE_NODES.has(n.type)) return;
		if (n.type === "as_expression" || n.type === "satisfies_expression") return void (n.namedChildren[0] && visit(n.namedChildren[0]));
		if (n.childCount === 0) {
			if (n.text === ";") return; // ASI: optional semicolons are style
			if (BINDING.has(n.type) || n.type === "shorthand_property_identifier") {
				if (locals.has(n.text)) return void toks.push(order.get(n.text) ?? (order.set(n.text, `$${order.size}`), order.get(n.text)!));
			}
			return void toks.push(n.text);
		}
		for (const k of n.children) if (k) visit(k);
	};
	visit(body);
	if (toks.length < MIN_TOKENS) return undefined;
	return createHash("sha1").update(toks.join(" ")).digest("hex").slice(0, 16);
}
const BINDING = new Set(["identifier", "shorthand_property_identifier_pattern"]);
/** Node type → fields that declare local names. */
const DECLARES: Record<string, string[]> = { variable_declarator: ["name"], for_in_statement: ["left"], catch_clause: ["parameter"], arrow_function: ["parameter", "parameters"], function_expression: ["parameters"], function_declaration: ["parameters"] };
const TYPE_NODES = new Set(["comment", "type_annotation", "type_arguments", "type_parameters", "omitting_type_annotation", "opting_type_annotation", "asserts_annotation"]);

function signatureOf(decl: Node): string {
	const params = decl.childForFieldName("parameters")?.text ?? "()";
	const ret = decl.childForFieldName("return_type")?.text ?? "";
	return `${params}${ret}`.replace(/\s+/g, " ").slice(0, 160);
}

const RUNNER_PACKAGES: Record<string, "jest" | "vitest" | "mocha"> = { "@jest/globals": "jest", jest: "jest", "@types/jest": "jest", vitest: "vitest", mocha: "mocha", chai: "mocha" };

/**
 * TS gate failures with a certain cause. TS2307 on a package:
 *  - another test runner's package in a test file → the tests are wrong (retest, use the project's runner)
 *  - a package that is not installed, in a test file → retest (only installed packages)
 *  - a package that is not installed, in code → reimplement (use what is installed) — or `fix` when the
 *    stack choices say it should be there (setup missed it: one `pnpm add` fixes it)
 * TS2307 on a relative path → the importing side is wrong (retest/reimplement by file kind).
 */
export function tsDiagnose(projectDir: string, failedStep: string, output: string, isTestFile: (p: string) => boolean, expectedPackages: string[] = []): import("../types.ts").Diagnosis | undefined {
	if (!/build|tsc|type/i.test(failedStep)) return undefined;
	const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
	const m = /([^\s:]+\.[cm]?tsx?):\d+:\d+ - error TS2307: Cannot find module '([^']+)'/.exec(clean);
	if (!m) return undefined;
	const [, file, mod] = m as unknown as [string, string, string];
	const test = isTestFile(file);
	const runner = tsTestRunner(projectDir);
	if (mod.startsWith(".")) return { action: test ? "retest" : "reimplement", summary: `${file} imports ${mod}, which does not exist`, note: `${file} imports '${mod}', which does not exist. Import only files that exist (check the paths; NodeNext needs ".js" extensions).`, by: "rule" };
	const pkg = mod.startsWith("@") ? mod.split("/").slice(0, 2).join("/") : mod.split("/")[0]!;
	const other = RUNNER_PACKAGES[pkg];
	if (test && other && runner && other !== runner) return { action: "retest", summary: `${file} imports ${pkg} (${other}) but the project runs ${runner}`, note: `The project's test runner is ${runner}. Rewrite the tests to import from "${runner}" (never "${pkg}").`, by: "rule" };
	if (expectedPackages.includes(pkg)) return { action: "fix", summary: `${pkg} belongs to the chosen stack but is not installed`, command: `pnpm add ${pkg}`, by: "rule" };
	return { action: test ? "retest" : "reimplement", summary: `${file} imports ${pkg}, which is not installed`, note: `'${pkg}' is not installed in this project. Use only installed packages (see package.json) or the platform's built-ins.`, by: "rule" };
}

/** Probe spec for the setup check: written in the style the project's runner expects. */
export function tsProbeTest(projectDir: string): { path: string; content: string } {
	const runner = tsTestRunner(projectDir);
	const imp = runner === "vitest" ? 'import { describe, it, expect } from "vitest";\n' : runner === "jest" ? 'import { describe, it, expect } from "@jest/globals";\n' : "";
	return { path: "src/__br_probe__.spec.ts", content: `${imp}describe("bigrefactor toolchain probe", () => {\n\tit("runs", () => {\n\t\texpect(1 + 1).toBe(2);\n\t});\n});\n` };
}
