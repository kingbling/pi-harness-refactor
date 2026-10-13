import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerGrammar, syntaxErrors } from "../src/inventory/treesitter.ts";

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
