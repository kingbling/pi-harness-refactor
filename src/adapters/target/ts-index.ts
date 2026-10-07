import { readFileSync } from "node:fs";
import { join } from "node:path";
import { captures, parse, type Node } from "../../inventory/treesitter.ts";
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
`;

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
		const decl = c.name === "const" ? c.node.parent!.parent! : c.node.parent!;
		const exportStmt = decl.parent!;
		const doc = jsdoc(exportStmt);
		const decorators = exportStmt.namedChildren.filter((n) => n?.type === "decorator").map((n) => n!.text);
		const name = c.node.text;
		const tags: string[] = [];
		let kind: string = c.name === "fn" ? "function" : c.name === "cls" ? "class" : c.name === "iface" ? "interface" : c.name === "enum" ? "enum" : c.name === "type" ? "type" : "const";
		for (const [deco, k] of Object.entries(opts.decoratorKinds ?? {})) if (decorators.some((d) => d.startsWith(`@${deco}`))) kind = typeof k === "string" ? k : kind;
		if (kind === "class" || kind === "interface") for (const [re, k] of opts.nameKinds ?? []) if (re.test(name)) kind = k;
		if (shared && (kind === "function" || kind === "const" || kind === "class")) kind = "helper";
		if (shared) tags.push("shared");
		for (const d of decorators) tags.push(d.replace(/\(.*$/s, ""));
		const signature = c.name === "fn" ? signatureOf(decl) : c.name === "const" ? decl.text.slice(0, 120).replace(/\s+/g, " ") : undefined;
		out.push({ id: `${rel}::${name}`, path: rel, kind, name, line: c.node.startPosition.row + 1, signature, doc, tags });
		if (c.name === "cls") {
			const body = decl.childForFieldName("body");
			for (const m of body?.namedChildren ?? []) {
				if (m?.type !== "method_definition") continue;
				const mn = m.childForFieldName("name")?.text;
				if (!mn || mn === "constructor" || /\bprivate\b|\bprotected\b/.test(m.text.slice(0, m.text.indexOf(mn)))) continue;
				out.push({ id: `${rel}::${name}.${mn}`, path: rel, kind: "method", name: `${name}.${mn}`, line: m.startPosition.row + 1, signature: signatureOf(m), doc: jsdoc(m), tags: shared ? ["shared"] : [] });
			}
		}
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
		sharedDirs: ["src/shared/", "src/common/", "src/utils/", "src/lib/"],
		sourceExtensions: [".ts", ".tsx"],
		isTestFile: (p: string) => /\.(spec|test|e2e-spec)\.[cm]?[jt]sx?$/.test(p) || /\.d\.ts$/.test(p),
		lang: (p: string) => (/\.tsx$/.test(p) ? "tsx" : /\.[cm]?ts$/.test(p) ? "typescript" : /\.[cm]?jsx?$/.test(p) ? "javascript" : undefined),
		skipMarker: /\.(skip|only|todo)\s*\(/,
		interfaceHint: "TypeScript signatures; DTOs/classes where the legacy code used arrays",
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
