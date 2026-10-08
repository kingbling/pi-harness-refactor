import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSourceAdapter, knownSources, registerGeneratedSources } from "../src/adapters/registry.ts";
import { draftPath, exampleSourceManifest, generateSourceAdapter, type ManifestWriter, type SourceManifest } from "../src/adapters/source/generated.ts";
import { ConfigSchema } from "../src/config.ts";
import { inventory } from "../src/inventory/run.ts";
import { Ledger } from "../src/ledger/db.ts";

const here = resolve(import.meta.dirname, "..");

/** A tiny legacy app in JavaScript: an entry script, a class hierarchy, a helper, SQL, one file nothing uses. */
function legacyRepo(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
	const files: Record<string, string> = {
		"index.js": `const repo = require("./lib/repo");\nconsole.log(repo.load({ query: (q) => q }));\n`,
		"lib/base.js": `class Base {\n  describe() { return "base"; }\n}\nmodule.exports = { Base };\n`,
		"lib/money.js": `// Money helpers\n/** Adds two amounts. */\nfunction add(a, b) {\n  return a + b; // plain sum\n}\nmodule.exports = { add };\n`,
		"lib/invoice.js": `const { add } = require("./money");\nconst { Base } = require("./base");\n/** An invoice. */\nclass Invoice extends Base {\n  total() {\n    return add(this.net, this.tax);\n  }\n  label() {\n    return this.describe().toUpperCase();\n  }\n}\nmodule.exports = { Invoice };\n`,
		"lib/repo.js": `const { Invoice } = require("./invoice");\nfunction load(db) {\n  return db.query("SELECT * FROM invoices WHERE id = 1");\n}\nconst make = () => new Invoice();\nmodule.exports = { load, make };\n`,
		"old/unused.js": `function unused() {\n  return 1;\n}\n`,
		"node_modules/dep/index.js": `function vendored() {}\n`,
	};
	for (const [p, c] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, p)), { recursive: true });
		writeFileSync(join(dir, p), c);
	}
}

/** A scripted "model": writes the next manifest of the list on each round and records the prompts it got. */
function scripted(root: string, manifests: SourceManifest[]): ManifestWriter & { prompts: string[]; disposed: boolean } {
	const w = {
		prompts: [] as string[],
		disposed: false,
		async run(prompt: string) {
			w.prompts.push(prompt);
			const m = manifests[Math.min(w.prompts.length - 1, manifests.length - 1)]!;
			mkdirSync(dirname(draftPath(root)), { recursive: true });
			writeFileSync(draftPath(root), JSON.stringify(m));
		},
		dispose() {
			w.disposed = true;
		},
	};
	return w;
}

const prevWs = process.env["BR_WORKSPACE"];
afterEach(() => {
	if (prevWs === undefined) delete process.env["BR_WORKSPACE"];
	else process.env["BR_WORKSPACE"] = prevWs;
});

describe("generated source adapters", () => {
	it("a model-written manifest is verified, saved, registered, indexes JavaScript and runs the inventory", async () => {
		const ws = join(here, ".sim", "gen-source");
		const legacy = join(ws, "legacy");
		rmSync(ws, { recursive: true, force: true });
		legacyRepo(legacy);
		const bad = exampleSourceManifest();
		bad.queries = { ...bad.queries, symbols: "(function_declaration nme: (identifier) @function)" };
		const writer = scripted(ws, [bad, exampleSourceManifest()]);
		const logs: string[] = [];
		const m = await generateSourceAdapter({ root: ws, sourceRoot: legacy, writer, log: (l) => logs.push(l) });

		// the broken query went back to the model with the exact error; the fixed manifest passed
		expect(writer.prompts).toHaveLength(2);
		expect(writer.prompts[1]).toMatch(/queries\.symbols does not compile/);
		expect(writer.disposed).toBe(true);
		expect(m.id).toBe("javascript");
		expect(existsSync(join(ws, ".bigrefactor", "adapters", "source", "javascript.json"))).toBe(true);
		expect(existsSync(draftPath(ws))).toBe(false);

		process.env["BR_WORKSPACE"] = ws;
		expect(registerGeneratedSources(ws)).toEqual(["javascript"]);
		expect(knownSources()).toEqual(expect.arrayContaining(["php", "javascript"]));
		expect(getSourceAdapter("php").id).toBe("php"); // the hand-written adapter stays
		const a = getSourceAdapter("javascript");
		expect((await a.detect(legacy)).confidence).toBeGreaterThan(0);
		expect(a.truth.run(legacy, "/x/cases.cjs")).toEqual({ cmd: "node", args: ["/x/cases.cjs"] });

		// symbols, deps, functions with comments and calls, containers with their parent class
		const read = (p: string) => readFileSync(join(legacy, p), "utf8");
		const inv = await a.indexFile(legacy, "lib/invoice.js", read("lib/invoice.js"));
		expect(inv.lang).toBe("javascript");
		expect(inv.symbols.map((s) => `${s.kind} ${s.name}`)).toEqual(["class Invoice", "method Invoice::total", "method Invoice::label"]);
		expect(inv.deps).toEqual(expect.arrayContaining([{ from: "lib/invoice.js", to: "lib/money.js", kind: "include" }, { from: "lib/invoice.js::Invoice", to: "Base", kind: "extends" }, { from: "lib/invoice.js::Invoice::total", to: "add", kind: "call" }]));
		expect(inv.containers).toEqual([{ name: "Invoice", parent: "Base" }]);
		const label = inv.functions!.find((f) => f.name === "label")!;
		expect(label.container).toBe("Invoice");
		expect(label.calls.map((c) => `${c.kind} ${c.name} ${c.receiver ?? ""}`.trim())).toEqual(["member describe this", "member toUpperCase"]);
		expect(label.calls[1]!.receiverCall).toBe(0); // toUpperCase is called on the result of this.describe()
		const money = await a.indexFile(legacy, "lib/money.js", read("lib/money.js"));
		const add = money.functions!.find((f) => f.name === "add")!;
		expect(add.comments.map((c) => `${c.kind}:${c.body}`)).toEqual(["doc:Money helpers", "doc:Adds two amounts.", "note:plain sum"]);
		const repo = await a.indexFile(legacy, "lib/repo.js", read("lib/repo.js"));
		expect(repo.symbols.map((s) => s.name)).toEqual(["load", "make"]);
		expect(repo.queries).toEqual([expect.objectContaining({ symbolId: "lib/repo.js::load", kind: "sql", tables: ["invoices"] })]);
		expect(repo.deps).toContainEqual({ from: "lib/repo.js::make", to: "Invoice", kind: "new" });

		// entry points come from the model-written framework profile, not from file-name guesses
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		writeFileSync(join(ws, ".bigrefactor", "framework-profile.json"), JSON.stringify({ id: "plain-node", frameworkDirs: [], loaders: [], concerns: [], entryPoint: "^index\\.js$" }));
		a.reloadProfile?.();
		expect(a.isEntryPoint?.("index.js")).toBe(true);
		const config = ConfigSchema.parse({ source: { path: legacy, stack: "javascript" }, target: { path: join(ws, "new"), stacks: ["nestjs"] }, models: {} });
		const ledger = new Ledger(":memory:");
		const r = await inventory(config, ws, ledger);
		expect(r.files).toBe(6); // node_modules is excluded
		expect(r.dead).toEqual(["old/unused.js"]);
		expect(r.invariantsOk).toBe(true);
		expect(ledger.status().symbols["discovered"] ?? 0).toBe(0); // every symbol clustered or dropped as dead
		const files = ledger.listUnits().map((u) => JSON.parse(u.meta).files[0]);
		expect(files.indexOf("lib/money.js")).toBeLessThan(files.indexOf("lib/invoice.js")); // leaves first
		const calls = ledger.db.prepare("SELECT COUNT(*) n FROM code_calls").get() as { n: number };
		expect(calls.n).toBeGreaterThan(0);
	});

	it("init on code no adapter reads has the reader written instead of failing; offline it says so", async () => {
		const ws = join(here, ".sim", "gen-source-init");
		const legacy = join(here, ".sim", "gen-source-init-legacy");
		rmSync(ws, { recursive: true, force: true });
		mkdirSync(ws, { recursive: true });
		legacyRepo(legacy);
		process.env["BR_WORKSPACE"] = ws;
		const { init } = await import("../src/init/init.ts");
		const ui = { text: async () => undefined, select: async () => undefined, log: () => {} };
		const args = ["--yes", "--source", legacy, "--target", join(here, ".sim", "gen-source-init-new"), "--to", "nestjs", "--no-docs"];
		await expect(init(args, { root: ws, prompter: ui, noLlm: true })).rejects.toThrow(/without a model \(--no-llm\)/);
		const writer = scripted(ws, [exampleSourceManifest()]);
		await init(args, { root: ws, prompter: ui, sourceWriter: writer });
		expect(writer.prompts).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(ws, "bigrefactor.config.json"), "utf8")).source.stack).toBe("javascript");
	});

	it("a manifest that never verifies fails with the last error, and a hand-broken one is never loaded", async () => {
		const ws = join(here, ".sim", "gen-source-fail");
		const legacy = join(ws, "legacy");
		rmSync(ws, { recursive: true, force: true });
		legacyRepo(legacy);
		const m = exampleSourceManifest();
		const broken: SourceManifest[] = [
			{ ...m, nodes: { comments: ["remark"], strings: ["string"] } },
			{ ...m, truth: { ...m.truth, probe: "console.log('nope')" } },
			{ ...m, grammar: { package: "tree-sitter-nosuchlang", wasm: "x.wasm" } },
		];
		const writer = scripted(ws, broken);
		await expect(generateSourceAdapter({ root: ws, sourceRoot: legacy, writer, repairs: 2 })).rejects.toThrow(/grammar not found/);
		expect(writer.prompts[1]).toMatch(/node type "remark" does not exist/);
		expect(writer.prompts[2]).toMatch(/did not print \[\]/);
		expect(existsSync(join(ws, ".bigrefactor", "adapters", "source", "javascript.json"))).toBe(false);

		mkdirSync(join(ws, ".bigrefactor", "adapters", "source"), { recursive: true });
		writeFileSync(join(ws, ".bigrefactor", "adapters", "source", "evil.json"), JSON.stringify({ ...m, id: "evil", truth: { ...m.truth, run: { cmd: "sh", args: ["-c", "{script}"] } } }));
		expect(registerGeneratedSources(ws)).not.toContain("evil");
	});
});
