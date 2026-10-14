import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import "../src/adapters/target/ts-index.ts";
import { addedSyntaxErrors, registerGrammar, syntaxErrors } from "../src/inventory/treesitter.ts";

/** The edit/write check reports only errors the change added: a parser gap already in the file (App.tsx's `readonly import(...)`) is not the writer's fault. */
describe("addedSyntaxErrors", () => {
	const old = "interface C {\n  rows: readonly import('./x').Row[];\n}\nexport function A() { return <p>hi</p>; }\n";
	it("an error already in the file before the edit is not reported", async () => {
		expect(await syntaxErrors("tsx", old)).not.toEqual([]);
		const edited = `// a comment the edit added\n${old}export const b = 2;\n`;
		expect(await addedSyntaxErrors("tsx", old, edited)).toEqual([]);
	});
	it("an error the edit added is still reported, and a new file is checked in full", async () => {
		const added = await addedSyntaxErrors("tsx", old, `${old}export const b = ;\n`);
		expect(added).toHaveLength(1);
		expect(added[0]!.line).toBe(5);
		expect(await addedSyntaxErrors("tsx", undefined, old)).not.toEqual([]);
	});
});

/** The write check: a file type with no grammar is written unchecked instead of refused. */
describe("syntaxErrors", () => {
	it("a language with no grammar (twig, yaml) gets no check instead of throwing", async () => {
		await expect(syntaxErrors("twig", "{% if x %}{{ x }}{% endif %}")).resolves.toEqual([]);
		await expect(syntaxErrors("yaml", "a: [1, 2\n")).resolves.toEqual([]);
	});
	it("a registered grammar still checks", async () => {
		registerGrammar("syntax-php", "tree-sitter-php/tree-sitter-php.wasm");
		expect(await syntaxErrors("syntax-php", "<?php function f( { ")).not.toEqual([]);
		expect(await syntaxErrors("syntax-php", "<?php function f() {}\n")).toEqual([]);
	});
	it("a registered grammar that fails to load still shows its error", async () => {
		const wasm = join(mkdtempSync(join(tmpdir(), "br-syntax-")), "bad.wasm");
		writeFileSync(wasm, "not a wasm file");
		registerGrammar("syntax-bad", wasm);
		await expect(syntaxErrors("syntax-bad", "x")).rejects.toThrow();
	});
});
