import { describe, expect, it } from "vitest";
import "../src/adapters/source/php.ts";
import "../src/adapters/target/ts-index.ts";
import type { TargetAdapter } from "../src/adapters/types.ts";
import { Ledger } from "../src/ledger/db.ts";
import { FakeModelClient } from "../src/models/fake.ts";
import { learnCommentSyntax, onlyComments } from "../src/run/comment-only.ts";

describe("files with only comments", () => {
	it("a grammar's parse tree decides: comments and template tags are no code", async () => {
		expect(await onlyComments("<?php\n// note\n# hash note\n/* block */\n?>", "a.php", { lang: "php" })).toBe(true);
		expect(await onlyComments("<?php\n// note\nnamespace App;\n", "a.php", { lang: "php" })).toBe(false);
		expect(await onlyComments("<div>hello</div>", "t.php", { lang: "php" })).toBe(false);
		expect(await onlyComments("// a\n/** b */\n", "a.ts", { lang: "typescript" })).toBe(true);
		expect(await onlyComments("// a\nexport const x = 1;\n", "a.ts", { lang: "typescript" })).toBe(false);
		expect(await onlyComments("const url = '//not a comment';\n", "a.js", { lang: "javascript" })).toBe(false);
	});

	it("a file type no grammar reads uses the syntax a model gave once for its extension; unknown counts as code", async () => {
		const ledger = new Ledger(":memory:");
		const py = "# only a note\n# another one\n";
		expect(await onlyComments(py, "a.py", { lang: "python", ledger })).toBe(false); // nothing known yet
		const client = new FakeModelClient({ chat: (r) => (r.messages.some((m) => m.content.includes(".py")) ? { json: { line: ["#"], block: [{ open: '"""', close: '"""' }] } } : undefined) });
		const adapter = { id: "django", layout: { sourceExtensions: [".py", ".ts"], lang: (p: string) => (p.endsWith(".ts") ? "typescript" : undefined) } } as unknown as TargetAdapter;
		expect(await learnCommentSyntax({ ledger, client, model: "m", adapters: [adapter] })).toEqual([".py"]); // .ts has a grammar
		expect(await learnCommentSyntax({ ledger, client, model: "m", adapters: [adapter] })).toEqual([]); // asked once
		expect(client.calls).toHaveLength(1);
		expect(await onlyComments(py, "a.py", { ledger })).toBe(true);
		expect(await onlyComments('"""\ndoc\n"""\n# x\n', "b.py", { ledger })).toBe(true);
		expect(await onlyComments("# x\nimport os\n", "c.py", { ledger })).toBe(false);
	});
});
