import { extname } from "node:path";
import type { TargetAdapter } from "../adapters/types.ts";
import { hasGrammar, parse, type Node } from "../inventory/treesitter.ts";
import type { Ledger } from "../ledger/db.ts";
import type { ModelClient } from "../models/types.ts";

/**
 * Does a file hold only comments? Where a tree-sitter grammar reads the file, the parse tree says it: every token
 * outside a comment node is a template's open or close tag. A file type no grammar reads uses the comment syntax a
 * model gave once for its extension (learnCommentSyntax, kept in the ledger); without that, the file counts as code.
 */

/** How comments are written in one file type: line markers (`#`, `--`) and block pairs (`/*` `*\/`). */
export interface CommentSyntax {
	line: string[];
	block: Array<{ open: string; close: string }>;
}
const META = "comment_syntax";

/** Template open and close tags (`<?php ?>`, `<% %>`) are no code on their own. */
const TAGS = /<\?(php)?|\?>|<%|%>/g;

export function knownCommentSyntax(ledger: Ledger | undefined): Record<string, CommentSyntax> {
	try {
		return JSON.parse(ledger?.getMeta(META) ?? "{}") as Record<string, CommentSyntax>;
	} catch {
		return {};
	}
}

/** `lang`: the grammar id of the file (the target adapter's layout.lang); `ledger`: where the learned syntax is kept. */
export async function onlyComments(text: string, file: string, o: { lang?: string; ledger?: Ledger } = {}): Promise<boolean> {
	if (hasGrammar(o.lang)) {
		const tree = await parse(o.lang!, text);
		try {
			return !codeTokens(tree.rootNode).replace(TAGS, "").trim();
		} finally {
			tree.delete();
		}
	}
	const syntax = knownCommentSyntax(o.ledger)[extname(file)];
	if (!syntax) return false;
	let rest = text;
	const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	for (const b of syntax.block) if (b.open && b.close) rest = rest.replace(new RegExp(`${esc(b.open)}[\\s\\S]*?${esc(b.close)}`, "g"), "");
	for (const l of syntax.line) if (l) rest = rest.replace(new RegExp(`^\\s*${esc(l)}.*$`, "gm"), "");
	return !rest.replace(TAGS, "").trim();
}

/** The text of every token outside comment nodes (tree-sitter grammars name those nodes "comment", "line_comment", …). */
function codeTokens(root: Node): string {
	const out: string[] = [];
	const stack: Node[] = [root];
	while (stack.length) {
		const n = stack.pop()!;
		if (n.type.includes("comment")) continue;
		if (n.childCount === 0) out.push(n.text);
		else for (const c of n.children) if (c) stack.push(c);
	}
	return out.join(" ");
}

/**
 * Asks a model once per source extension of the target stacks that no grammar reads how comments are written in
 * it, and keeps the answer in the ledger: the comment-only check needs no word list per language.
 */
export async function learnCommentSyntax(o: { ledger: Ledger; client?: ModelClient; model: string; adapters: TargetAdapter[] }): Promise<string[]> {
	const known = knownCommentSyntax(o.ledger);
	const asked: string[] = [];
	for (const a of o.adapters)
		for (const ext of a.layout.sourceExtensions) {
			if (known[ext] || hasGrammar(a.layout.lang?.(`file${ext}`)) || !o.client) continue;
			const res = await o.client.chat({
				model: o.model,
				effort: "low",
				schema: { type: "object", additionalProperties: false, required: ["line", "block"], properties: { line: { type: "array", items: { type: "string" } }, block: { type: "array", items: { type: "object", additionalProperties: false, required: ["open", "close"], properties: { open: { type: "string" }, close: { type: "string" } } } } } },
				messages: [
					{ role: "system", content: "You know the syntax of programming, template and config languages. Answer only with the JSON object." },
					{ role: "user", content: `How are comments written in ${a.id} source files ending in ${ext}? line: the markers that start a comment running to the end of the line (e.g. "#" or "--"); block: the open and close markers of comments that span lines. Give [] where the language has none.` },
				],
			});
			const j = (res.json ?? {}) as Partial<CommentSyntax>;
			known[ext] = { line: (j.line ?? []).filter((x) => typeof x === "string" && x.trim()), block: (j.block ?? []).filter((b) => b?.open?.trim() && b?.close?.trim()) };
			asked.push(ext);
		}
	if (asked.length) o.ledger.setMeta(META, JSON.stringify(known));
	return asked;
}
