import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getSourceAdapter } from "../src/adapters/registry.ts";
import { ConfigSchema } from "../src/config.ts";
import { wireDbDeps } from "../src/inventory/db.ts";
import { inventory } from "../src/inventory/run.ts";
import { blockingOrder, planSlices } from "../src/inventory/slices.ts";
import { unitDifficulty } from "../src/jev/questions.ts";
import { Ledger } from "../src/ledger/db.ts";
import { unitFacts } from "../src/sessions/taskcard.ts";

/**
 * Findings from a live run: one 3-line app file became a dependency of a thousand units (framework cycle + first
 * match of a bare file name), method names in strings made 16k soft edges, constants made big files T0, a quoted
 * word after "model" in a template was taken for a table, and ready units ran in alphabetical order.
 */
const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	delete process.env["BR_WORKSPACE"];
});

async function repo(files: Record<string, string>, frameworkDirs: string[] = []) {
	const ws = mkdtempSync(join(tmpdir(), "br-graph-"));
	dirs.push(ws);
	for (const [p, s] of Object.entries(files)) {
		mkdirSync(dirname(join(ws, "legacy", p)), { recursive: true });
		writeFileSync(join(ws, "legacy", p), s);
	}
	mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
	writeFileSync(join(ws, ".bigrefactor", "framework-profile.json"), JSON.stringify({ id: "test", frameworkDirs, loaders: [], concerns: [] }));
	process.env["BR_WORKSPACE"] = ws;
	getSourceAdapter("php").reloadProfile?.();
	const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, models: {} });
	const ledger = new Ledger(":memory:");
	await inventory(config, ws, ledger);
	const unitOf = (file: string) => ledger.listUnits().find((u) => (JSON.parse(u.meta).files as string[] | undefined)?.includes(file));
	return { ledger, unitOf };
}

describe("unit graph without framework noise", () => {
	it("a cycle through framework code is no unit dep; a file name several files share gives no edge", async () => {
		const { ledger, unitOf } = await repo(
			{
				// the framework's loader includes an app hook (exact path) and every module's enabled.inc.php (bare name)
				"fw/load.php": "<?php\nclass Load {\n  public static function enable_module($m) {\n    require_once __DIR__ . '/../app/hook.php';\n    include 'enabled.inc.php';\n  }\n}\n",
				"app/hook.php": "<?php\nLoad::enable_module('hook');\n",
				"app/modules/a/enabled.inc.php": "<?php\nLoad::enable_module('a');\n",
				"app/modules/b/enabled.inc.php": "<?php\nLoad::enable_module('b');\n",
				"app/Service.php": "<?php\nclass Service {\n  public function run() { return Load::enable_module('s'); }\n}\n",
				"index.php": "<?php\nrequire_once __DIR__ . '/app/Service.php';\n(new Service())->run();\n",
			},
			["fw/"],
		);
		const service = unitOf("app/Service.php")!;
		const hook = unitOf("app/hook.php")!;
		expect(service).toBeDefined();
		expect(hook).toBeDefined();
		// Service → framework → hook used to make hook a dep of everything that touches the framework
		expect(JSON.parse(service.deps)).toEqual([]);
		// the bare name matches two files: no include edge to either
		const toEnabled = ledger.db.prepare("SELECT COUNT(*) n FROM index_deps WHERE to_id LIKE '%enabled.inc.php%'").get() as { n: number };
		expect(toEnabled.n).toBe(0);
		for (const u of ledger.listUnits()) expect(JSON.parse(u.deps).some((d: string) => d === unitOf("app/modules/a/enabled.inc.php")?.id)).toBe(false);
	});

	it("string mentions: only unique class/function/file names make soft edges, never method names", async () => {
		const { unitOf } = await repo({
			"app/Thing.php": "<?php\nclass Thing {\n  public function create() { return 1; }\n}\n",
			"app/Other.php": "<?php\nclass Other {\n  public function create() { return 2; }\n}\n",
			"app/Caller.php": "<?php\nclass Caller {\n  public function go() { $a = 'create'; $b = 'Thing'; return [$a, $b]; }\n}\n",
			"index.php": "<?php\nrequire_once __DIR__ . '/app/Caller.php';\n$x = ['Other'];\n",
		});
		const soft = JSON.parse(unitOf("app/Caller.php")!.meta).softDeps as string[];
		expect(soft).toContain(unitOf("app/Thing.php")!.id); // 'Thing' names exactly one class
		expect(soft).not.toContain(unitOf("app/Other.php")!.id); // 'create' is a method name in two files: no edge
	});

	it("tier comes from deps, not from a constant the file declares", async () => {
		const { unitOf } = await repo({
			"app/Consts.php": "<?php\nconst A = 1;\nconst B = 2;\n",
			"app/Service.php": "<?php\nclass Service {\n  public function run() { return 1; }\n}\n",
			"app/Big.php": "<?php\nconst LIMIT = 10;\nclass Big {\n  public function f() { return new Service(); }\n}\n",
			"index.php": "<?php\nrequire_once __DIR__ . '/app/Consts.php';\nrequire_once __DIR__ . '/app/Big.php';\nrequire_once __DIR__ . '/app/Service.php';\n",
		});
		expect(unitOf("app/Consts.php")!.tier).toBe("T0");
		expect(unitOf("app/Service.php")!.tier).toBe("T0"); // a leaf, whatever it declares
		expect(unitOf("app/Big.php")!.tier).toBe("T1"); // has a dep: the constant does not make it T0
	});
});

describe("slices and run order", () => {
	const routeUnits = (ledger: Ledger, units: Array<{ id: string; deps?: string[]; soft?: string[]; route?: string }>) => {
		for (const u of units) {
			const file = `app/${u.id}.php`;
			ledger.createUnit({ id: u.id, tier: "T1", deps: u.deps ?? [], meta: { files: [file], loc: 10, softDeps: u.soft ?? [] }, symbolIds: [] });
			if (u.route) ledger.db.prepare("INSERT INTO index_routes(id, side, method, path, handler_symbol) VALUES (?, 'source', 'GET', ?, ?)").run(`GET ${u.route}`, u.route, `${file}::${u.id}::show`);
		}
	};

	it("foundation counts real edges only; soft edges just place a unit in a feature", () => {
		const ledger = new Ledger(":memory:");
		routeUnits(ledger, [
			{ id: "Shared" },
			{ id: "Mentioned" },
			{ id: "A", deps: ["Shared"], soft: ["Mentioned"], route: "/a" },
			{ id: "B", deps: ["Shared"], soft: ["Mentioned"], route: "/b" },
			{ id: "C", soft: ["Mentioned"], route: "/c" },
		]);
		const plan = planSlices(ledger);
		expect(plan.unitSlice.get("Shared")).toBe("foundation"); // two features need it for real
		expect(plan.unitSlice.get("Mentioned")).not.toBe("foundation"); // three features only mention it
		expect(["a", "b", "c"]).toContain(plan.unitSlice.get("Mentioned"));
	});

	it("ready units: what an early slice or many units wait on goes first, not the alphabet", () => {
		const order = blockingOrder([
			{ id: "A_alpha", deps: [], rank: 5 },
			{ id: "B_db", deps: [], rank: 5 },
			{ id: "C_found", deps: ["B_db"], rank: 0 }, // the foundation needs the DB unit
			{ id: "D_wide", deps: [], rank: 5 },
			{ id: "E", deps: ["D_wide"], rank: 5 },
			{ id: "F", deps: ["E"], rank: 5 },
		]);
		expect(order.get("B_db")).toEqual({ rank: 0, blocks: 1 });
		expect(order.get("D_wide")).toEqual({ rank: 5, blocks: 2 });
		const ready = ["A_alpha", "B_db", "D_wide"].sort((a, b) => order.get(a)!.rank - order.get(b)!.rank || order.get(b)!.blocks - order.get(a)!.blocks || a.localeCompare(b));
		expect(ready).toEqual(["B_db", "D_wide", "A_alpha"]);
	});
});

describe("DB deps come from indexed queries", () => {
	it("a quoted word after 'model' in a template is no table use; an indexed query is", () => {
		const ledger = new Ledger(":memory:");
		ledger.createUnit({ id: "DB_schema_main", tier: "T0", kind: "db_schema", deps: [], meta: { lane: "db", tables: ["countries", "invoices"] }, symbolIds: [] });
		ledger.createUnit({ id: "U1_form", tier: "T2", deps: [], meta: { files: ["app/form.vue"] }, symbolIds: [] }); // <input v-model="countries">
		ledger.createUnit({ id: "U2_repo", tier: "T1", deps: [], meta: { files: ["app/Repo.php"], queries: 1 }, symbolIds: [] });
		ledger.db.prepare("INSERT INTO index_queries(symbol_id, kind, tables, text) VALUES (?, 'sql', ?, ?)").run("app/Repo.php::Repo::all", JSON.stringify(["Invoices"]), "SELECT * FROM Invoices");
		expect(wireDbDeps(ledger)).toBe(1);
		expect(JSON.parse(ledger.getUnit("U1_form")!.deps)).toEqual([]);
		expect(JSON.parse(ledger.getUnit("U2_repo")!.deps)).toEqual(["DB_schema_main"]);
	});
});

describe("unit facts and difficulty", () => {
	it("size counts by band: a 9,000-line unit is harder than a 700-line one", () => {
		const facts = { branching: 1 };
		expect(unitDifficulty(facts, { loc: 700, deps: 0, cutDeps: 0 }).level).toBe("moderate");
		expect(unitDifficulty(facts, { loc: 9659, deps: 0, cutDeps: 0 }).level).toBe("hard");
	});

	it("the card states facts instead of a kind word: a pure data file says convert it with a script", () => {
		const ws = mkdtempSync(join(tmpdir(), "br-facts-"));
		dirs.push(ws);
		writeFileSync(join(ws, "countries.php"), `<?php\n$countries = [\n${Array.from({ length: 60 }, (_, i) => `  'c${i}' => 'Country ${i}',`).join("\n")}\n];\n`);
		const ledger = new Ledger(":memory:");
		ledger.db.prepare("INSERT INTO index_symbols(id, side, path, kind, name, line) VALUES ('countries.php::script', 'source', 'countries.php', 'other', 'countries.php', 1)").run();
		ledger.createUnit({ id: "U1", tier: "T0", kind: "constants_config", deps: [], meta: { files: ["countries.php"], loc: 63, route: { has_ui: 0.1, needs_db: 0.9 } }, symbolIds: [] });
		const facts = unitFacts(ledger, ledger.getUnit("U1")!, ws);
		expect(facts).toContain("63 lines");
		expect(facts).toContain("reads/writes a database");
		expect(facts).not.toContain("renders UI");
		expect(facts.some((f) => f.includes("pure data"))).toBe(true);
	});
});
