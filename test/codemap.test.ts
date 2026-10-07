import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { phpAdapter } from "../src/adapters/source/php.ts";
import { ConfigSchema } from "../src/config.ts";
import { callTree, readFunction, resolveCodeMap, writeCodeMap, type ResolvedCall } from "../src/inventory/codemap.ts";
import { inventory } from "../src/inventory/run.ts";
import { Ledger } from "../src/ledger/db.ts";
import { whoCalls } from "../src/sessions/tools.ts";

/**
 * Code map: the adapter reports syntax (functions, comments, calls, declared types), the core resolves calls
 * stack-neutrally. Covers every resolution path: $this through inheritance, self/parent, typed parameter,
 * `new X` variable, return type of a previous call, chained calls, @var annotation, unknown receiver with a
 * unique / ambiguous method name, framework targets, builtins; plus comment lifting and the reading view.
 */
const FILES: Record<string, string> = {
	"fw/FwBase.php": `<?php
class FwBase {
	public function render(): string { return ''; }
}`,
	"src/Base.php": `<?php
class Base extends FwBase {
	public function helper(): Money { return new Money(); }
}`,
	"src/Money.php": `<?php
/**
 * Copyright 2009 Some Corp. All rights reserved.
 */
class Money {
	/**
	 * Rounds to cents, the way invoices print it.
	 */
	public function round2($x) {
		// banker's rounding is NOT used here
		// $old = round($x, 3);
		return round($x, 2);
	}
	public static function make(): self { return new Money(); }
}`,
	"src/Repo.php": `<?php
class Repo {
	public function find() { return 1; }
	public function save() { return 2; }
	public function uniqueThing() { return 3; }
}`,
	"src/Other.php": `<?php
class Other {
	public function save() { return 4; }
}`,
	"src/Shop.php": `<?php
class Shop extends Base {
	public function total(Repo $repo, $x) {
		$m = new Money();
		$m->round2(1);
		$this->helper()->round2(2);
		$repo->find();
		$made = Money::make();
		$made->round2(3);
		self::tax();
		parent::helper();
		/** @var Repo $r */
		$r = lookup();
		$r->save();
		$unknown->save();
		$anything->uniqueThing();
		$this->render();
		strlen('a');
		return lookup();
	}
	private static function tax() { return 0; }
}
function lookup() { return null; }`,
};

async function setup() {
	const root = mkdtempSync(join(tmpdir(), "br-codemap-"));
	for (const [p, src] of Object.entries(FILES)) {
		mkdirSync(join(root, p, ".."), { recursive: true });
		writeFileSync(join(root, p), src);
	}
	const indexes = await Promise.all(Object.entries(FILES).map(([p, src]) => phpAdapter.indexFile(root, p, src)));
	const rows = resolveCodeMap(indexes, (p) => p.startsWith("fw/"));
	const ledger = new Ledger(":memory:");
	writeCodeMap(ledger, rows);
	return { root, indexes, rows, ledger };
}

const at = (calls: ResolvedCall[], line: number, name: string) => calls.find((c) => c.from === "src/Shop.php::Shop::total" && c.line === line && c.name === name);

describe("code map", () => {
	it("mints each symbol id once: edges and queries point at real symbols", async () => {
		const { indexes } = await setup();
		const ids = new Set(indexes.flatMap((f) => f.symbols.map((s) => s.id)));
		const files = new Set(indexes.map((f) => f.path));
		for (const f of indexes) for (const d of f.deps) expect(ids.has(d.from) || files.has(d.from), `${d.from} → ${d.to}`).toBe(true);
		const shop = indexes.find((f) => f.path === "src/Shop.php")!;
		expect(shop.symbols.find((s) => s.name === "Shop::total")).toMatchObject({ line: 3, endLine: 20 });
	});

	it("resolves every call kind through declared and inferred types", async () => {
		const { rows } = await setup();
		const c = rows.calls;
		expect(at(c, 5, "round2")).toMatchObject({ resolution: "code", to: "src/Money.php::Money::round2" }); // $m = new Money
		expect(at(c, 6, "helper")).toMatchObject({ resolution: "code", to: "src/Base.php::Base::helper" }); // $this through parent
		expect(at(c, 6, "round2")).toMatchObject({ resolution: "code", to: "src/Money.php::Money::round2" }); // chained: helper(): Money
		expect(at(c, 7, "find")).toMatchObject({ resolution: "code", to: "src/Repo.php::Repo::find" }); // typed parameter
		expect(at(c, 9, "round2")).toMatchObject({ resolution: "code", to: "src/Money.php::Money::round2" }); // make(): self
		expect(at(c, 10, "tax")).toMatchObject({ resolution: "code", to: "src/Shop.php::Shop::tax" }); // self::
		expect(at(c, 11, "helper")).toMatchObject({ resolution: "code", to: "src/Base.php::Base::helper" }); // parent::
		expect(at(c, 14, "save")).toMatchObject({ resolution: "code", to: "src/Repo.php::Repo::save" }); // @var annotation
		expect(at(c, 15, "save")).toMatchObject({ resolution: "ambiguous", candidates: ["src/Repo.php::Repo::save", "src/Other.php::Other::save"] });
		expect(at(c, 16, "uniqueThing")).toMatchObject({ resolution: "code", to: "src/Repo.php::Repo::uniqueThing" }); // unique name
		expect(at(c, 17, "render")).toMatchObject({ resolution: "framework", to: "fw/FwBase.php::FwBase::render" });
		expect(at(c, 18, "strlen")).toMatchObject({ resolution: "external" });
		expect(at(c, 13, "lookup")).toMatchObject({ resolution: "code", to: "src/Shop.php::lookup" });
	});

	it("lifts comments out: doc, notes, commented-out code; the reading view drops code and banners, keeps line positions", async () => {
		const { root, rows, ledger } = await setup();
		const round2 = rows.functions.find((f) => f.id === "src/Money.php::Money::round2")!;
		expect(round2.comments.map((c) => c.kind)).toEqual(["doc", "note", "code"]);
		const view = readFunction(ledger, root, "Money::round2")!;
		expect(view).toMatch(/L6 \[doc\] Rounds to cents, the way invoices print it\./);
		expect(view).toMatch(/L10 banker's rounding is NOT used here/);
		expect(view).toMatch(/1 commented-out code \/ banner comment removed/);
		expect(view).not.toMatch(/\$old/);
		const code = view.split("line positions kept):\n")[1]!.split("\n");
		expect(code[code.length - 2]).toBe("return round($x, 2);"); // indentation stripped
		expect(code.indexOf("public function round2($x) {")).toBe(9 - 6); // L9 at offset 3 from L6
	});

	it("call tree on the task card: file to file, unit-internal helpers followed, framework summarized, ambiguous named", async () => {
		const { ledger } = await setup();
		const tree = callTree(ledger, ["src/Shop.php"]).join("\n");
		expect(tree).toMatch(/- Money::round2 @ src\/Money\.php L9-13/);
		expect(tree).toMatch(/- Base::helper @ src\/Base\.php L3-3/);
		expect(tree).toMatch(/- Repo::find @ src\/Repo\.php/);
		expect(tree).not.toMatch(/Shop::tax @/); // same unit
		expect(tree).toMatch(/ambiguous .*save\(\) → Repo::save \| Other::save/);
		expect(tree).toMatch(/framework: FwBase::render 1×/);
		expect(tree.match(/Money::round2 @/g)).toHaveLength(1); // shown once
	});

	it("review cases: long chains, typed misses, anonymous classes, nested functions, case, name clashes, banners", async () => {
		const files: Record<string, string> = {
			"fw/Model.php": `<?php
class Model { public function save() { return 1; } }`,
			"src/Thing.php": `<?php
class Thing {
	public function a(): Thing { return $this; }
	public function target() { return 1; }
}
class Other { public function a() {} public function target() {} }
class MyPdo extends PDO { function run() { return $this->prepare('x'); } }
class Stmt { function prepare($q) {} }
class Report { function save() {} }
class Outer {
	function make() { $o = new class extends Outer { function bar() { return 1; } }; if (!function_exists('helperFn')) { function helperFn() {} } }
	function bar() { return 2; }
	function caller() { $this->bar(); helperFn(); }
}
function chain(Thing $t) { $t->a()->a()->a()->a()->a()->a()->a()->target(); $m = new money(); $any->save(); }
class Money {
    /**
     * Loads the user.
     *
     * @param int $id
     */
    public function load($id) {
        /* Copyright 2009 Some Corp */
        return 1;
    }
}`,
			"src/Admin/Helper.php": `<?php
class Helper { function format() {} }
function useHelper(Helper $h) { $h->format(); }`,
			"src/Shop/Helper.php": `<?php
class Helper { function format() {} function total() {} }`,
		};
		const root = mkdtempSync(join(tmpdir(), "br-codemap2-"));
		for (const [p, src] of Object.entries(files)) {
			mkdirSync(join(root, p, ".."), { recursive: true });
			writeFileSync(join(root, p), src);
		}
		const indexes = await Promise.all(Object.entries(files).map(([p, src]) => phpAdapter.indexFile(root, p, src)));
		const { calls, functions } = resolveCodeMap(indexes, (p) => p.startsWith("fw/"), { caseInsensitive: phpAdapter.names?.caseInsensitive });
		const of = (from: string) => calls.filter((c) => c.from === from);
		// an 8-link fluent chain resolves every link through return types (no depth cut)
		const chain = of("src/Thing.php::chain");
		expect(chain.filter((c) => c.name === "a").every((c) => c.to === "src/Thing.php::Thing::a")).toBe(true);
		expect(chain.find((c) => c.name === "target")).toMatchObject({ resolution: "code", to: "src/Thing.php::Thing::target" });
		// class names match case-insensitively where the language says so
		expect(chain.find((c) => c.kind === "new")).toMatchObject({ resolution: "code", to: "src/Thing.php::Money" });
		// untyped ->save(): one app method AND a framework method share the name → ambiguous, not a guess
		expect(chain.find((c) => c.name === "save")).toMatchObject({ resolution: "ambiguous", candidates: ["src/Thing.php::Report::save", "fw/Model.php::Model::save"] });
		// typed receiver whose parent is not indexed: external, never an unrelated app method by name
		expect(of("src/Thing.php::MyPdo::run")[0]).toMatchObject({ resolution: "external" });
		// anonymous class methods stay apart; $this->bar() reaches the real Outer::bar
		const caller = of("src/Thing.php::Outer::caller");
		expect(caller.find((c) => c.name === "bar")).toMatchObject({ resolution: "code", to: "src/Thing.php::Outer::bar" });
		expect(functions.find((f) => f.name === "bar" && f.container?.startsWith("class@"))).toBeTruthy();
		// a function declared inside a method is global
		expect(caller.find((c) => c.name === "helperFn")).toMatchObject({ resolution: "code", to: "src/Thing.php::helperFn" });
		// same class name in two files: candidates, not first-wins
		expect(of("src/Admin/Helper.php::useHelper")[0]).toMatchObject({ resolution: "ambiguous" });
		// an indented docblock stays a doc; a copyright comment is a banner
		const load = functions.find((f) => f.id === "src/Thing.php::Money::load")!;
		expect(load.comments.map((c) => c.kind)).toEqual(["doc", "banner"]);
		expect(load.comments[0]!.body).toBe("Loads the user.\n\n@param int $id");
	});

	it("inventory writes the code map and leaves no dangling edge on the fixture", async () => {
		const FIXTURE = resolve(import.meta.dirname, "../fixtures/mini-app");
		const ledger = new Ledger(":memory:");
		const config = ConfigSchema.parse({ source: { path: FIXTURE, stack: "php" }, target: { path: "/tmp/x", stacks: ["nestjs"] }, models: {} });
		await inventory(config, FIXTURE, ledger);
		const dangling = ledger.db.prepare("SELECT from_id FROM index_deps WHERE from_id NOT IN (SELECT id FROM index_symbols) AND from_id NOT IN (SELECT path FROM files)").all();
		expect(dangling).toEqual([]);
		const qDangling = ledger.db.prepare("SELECT symbol_id FROM index_queries WHERE symbol_id NOT IN (SELECT id FROM index_symbols) AND symbol_id NOT IN (SELECT path FROM files)").all();
		expect(qDangling).toEqual([]);
		expect((ledger.db.prepare("SELECT COUNT(*) n FROM code_functions").get() as { n: number }).n).toBeGreaterThan(5);
		expect((ledger.db.prepare("SELECT COUNT(*) n FROM code_calls WHERE resolution = 'code' AND to_id NOT IN (SELECT id FROM index_symbols)").get() as { n: number }).n).toBe(0);
		const routes = ledger.db.prepare("SELECT handler_symbol FROM index_routes WHERE handler_symbol NOT IN (SELECT id FROM index_symbols)").all();
		expect(routes).toEqual([]);
		// file-scope callers (the template's format_money calls) stay visible next to code-map callers
		const fm = (ledger.db.prepare("SELECT id FROM index_symbols WHERE name = 'format_money'").get() as { id: string }).id;
		const out = await whoCalls({ ledger, config } as never).execute("t", { symbolId: fm }, undefined as never, undefined as never, undefined as never);
		expect((out.content[0] as { text: string }).text).toMatch(/templates\/invoice\.php \(call\)/);
	});
});
