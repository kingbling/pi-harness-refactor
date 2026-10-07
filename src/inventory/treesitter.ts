import { createRequire } from "node:module";
import { Language, Parser, Query, type Node, type Tree } from "web-tree-sitter";

export type { Node, Tree, Language };

const require = createRequire(import.meta.url);

/**
 * Grammar wasm comes from each grammar's own npm package (current tree-sitter ABI), the same approach
 * pi-tree-sitter uses. The core knows no language: each adapter registers the grammars it needs when it is
 * loaded (registerGrammar), so adding a language = an adapter + its grammar package.
 */
const GRAMMARS: Record<string, string> = {};

/** `lang` → npm module path of the grammar wasm (resolved from this package's dependencies). */
export function registerGrammar(lang: string, wasmModule: string): void {
	GRAMMARS[lang] = wasmModule;
}

let initialized: Promise<void> | undefined;
const languages = new Map<string, Promise<Language>>();
const queries = new Map<string, Query>();

export async function getLanguage(lang: string): Promise<Language> {
	initialized ??= Parser.init();
	await initialized;
	let p = languages.get(lang);
	if (!p) {
		const rel = GRAMMARS[lang];
		if (!rel) throw new Error(`no tree-sitter grammar registered for "${lang}" (have: ${Object.keys(GRAMMARS).join(", ") || "none"}; an adapter registers its grammar)`);
		p = Language.load(require.resolve(rel));
		languages.set(lang, p);
	}
	return p;
}

export async function parse(lang: string, source: string): Promise<Tree> {
	const language = await getLanguage(lang);
	const parser = new Parser();
	parser.setLanguage(language);
	const tree = parser.parse(source);
	parser.delete();
	if (!tree) throw new Error("tree-sitter returned no tree");
	return tree;
}

/** Compiled queries are cached per (lang, pattern); compiling is the slow part. */
export async function captures(lang: string, tree: Tree, pattern: string): Promise<Array<{ name: string; node: Node }>> {
	const language = await getLanguage(lang);
	const key = `${lang}\u0000${pattern}`;
	let q = queries.get(key);
	if (!q) {
		q = new Query(language, pattern);
		queries.set(key, q);
	}
	return q.captures(tree.rootNode).map((c) => ({ name: c.name, node: c.node }));
}

/** Depth-first walk; return false from the visitor to skip a subtree. */
export function walk(node: Node, visit: (n: Node, depth: number) => boolean | void, depth = 0): void {
	if (visit(node, depth) === false) return;
	for (const c of node.namedChildren) if (c) walk(c, visit, depth + 1);
}

/**
 * Normalized AST text for similarity hashing: node types + leaf text, no whitespace or comments.
 * Two function bodies with identical structure hash equal → dedupe candidates for the task card.
 */
export function normalizedAst(node: Node): string {
	const parts: string[] = [];
	walk(node, (n) => {
		if (n.type === "comment") return false;
		parts.push(n.namedChildCount === 0 ? `${n.type}:${n.text}` : n.type);
	});
	return parts.join(" ");
}

/** Innermost ancestor matching one of the given node types. */
export function enclosing(node: Node, types: string[]): Node | null {
	let cur: Node | null = node.parent;
	while (cur) {
		if (types.includes(cur.type)) return cur;
		cur = cur.parent;
	}
	return null;
}

/** Syntax check used by the write gate: block writes that do not parse. */
export async function syntaxErrors(lang: string, source: string): Promise<Array<{ line: number; text: string }>> {
	const tree = await parse(lang, source);
	const out: Array<{ line: number; text: string }> = [];
	if (!tree.rootNode.hasError) return out;
	walk(tree.rootNode, (n) => {
		if (n.type === "ERROR" || n.isMissing) {
			out.push({ line: n.startPosition.row + 1, text: n.isMissing ? `missing ${n.type}` : n.text.slice(0, 80) });
			return false;
		}
		return n.hasError;
	});
	return out;
}
