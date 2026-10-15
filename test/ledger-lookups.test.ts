import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTargetAdapter } from "../src/adapters/registry.ts";
import { ConfigSchema, type Config } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { BIG_TABLE_INDEXES } from "../src/ledger/schema.ts";
import { applyPlacementAnswers, placementDir, placeUnit } from "../src/run/placement.ts";
import { recordLostRun } from "../src/run/run.ts";
import { syncTaxonomyAnswers } from "../src/run/taxonomy.ts";
import { buildTaskCard } from "../src/sessions/taskcard.ts";

/**
 * The run process does its ledger reads on its one thread. On a real ledger (2000 units, 450 MB) a read that walks a
 * whole table held it for seconds: the start's record of a lost run read all attempts (3.8 s) and every unit start's
 * task card read all moves, truth cases and look-alike code per lookup (0.5-1 s, per unit). These tables grow with
 * the migration, so every read of them in those paths must find its rows through an index. The query plan says so
 * without a big ledger: the same SQL, the same indexes, a plan that names a full SCAN or not.
 */
const GROWING = ["attempts", "transitions", "decisions", "evidence", "moves", "truth_cases", "index_deps", "code_calls"];

let ws: string;
let ledger: Ledger;
let config: Config;
let seen: Array<{ sql: string; args: unknown[] }>;

/** Every statement run through the ledger from now on, with its arguments. */
function record(l: Ledger): void {
	seen = [];
	const prepare = l.db.prepare.bind(l.db);
	(l.db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
		const st = prepare(sql);
		const wrap =
			(fn: "all" | "get" | "run") =>
			(...args: unknown[]) => {
				seen.push({ sql, args });
				return (st[fn] as (...a: unknown[]) => unknown)(...args);
			};
		return { all: wrap("all"), get: wrap("get"), run: wrap("run") };
	};
}

/** Full scans of the growing tables in the plans of the statements seen (aliases resolved to their table). */
function fullScans(l: Ledger, tables = GROWING): string[] {
	const out = new Set<string>();
	const raw = l.db.prepare.bind(l.db);
	for (const { sql, args } of seen) {
		if (!/^\s*(SELECT|WITH)/i.test(sql)) continue;
		const plan = raw(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as [])) as Array<{ detail: string }>;
		for (const { detail } of plan) {
			// a whole-table read: SCAN (unless of a small covering index), or SEARCH with no index (MAX over a table)
			const m = /^(SCAN|SEARCH) (\w+)\b(.*)$/.exec(detail);
			if (!m || (m[1] === "SCAN" ? m[3]!.includes("USING COVERING INDEX") : m[3]!.includes("USING"))) continue;
			const name = m[2]!;
			// "SCAN d" names an alias: the table it stands for in the statement
			const table = tables.includes(name) ? name : new RegExp(`\\b(?:FROM|JOIN)\\s+(\\w+)\\s+(?:AS\\s+)?${name}\\b`, "i").exec(sql)?.[1];
			if (table && tables.includes(table)) out.add(`${table}: ${sql.replace(/\s+/g, " ").slice(0, 140)} → ${detail}`);
		}
	}
	return [...out];
}

beforeEach(() => {
	ws = mkdtempSync(join(tmpdir(), "br-lookups-"));
	mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
	mkdirSync(join(ws, "legacy"), { recursive: true });
	config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, models: {} });
	ledger = new Ledger(":memory:");
	// what ensureLedgerIndexes builds before a run starts
	ledger.db.exec(BIG_TABLE_INDEXES);
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe("ledger reads on the run's thread", () => {
	it("a unit's task card finds its rows by index, never by reading a whole growing table", async () => {
		const api = join(ws, "migrated", "api");
		const write = (rel: string, body: string) => (mkdirSync(dirname(join(api, rel)), { recursive: true }), writeFileSync(join(api, rel), body));
		write("package.json", "{}");
		write("src/features/agency/agency.service.ts", "export class AgencyService { findAll(): string[] { return []; } }\n");
		ledger.upsertFile({ path: "legacy/agency.php", hash: "h", lang: "php", loc: 10 });
		ledger.upsertSymbol({ id: "legacy/agency.php::Agency", path: "legacy/agency.php", kind: "class", name: "Agency" });
		ledger.upsertSymbol({ id: "legacy/agency.php::Agency::list", path: "legacy/agency.php", kind: "method", name: "list" });
		ledger.db.prepare("INSERT INTO index_symbols(id, side, path, kind, name, line, exported, ast_hash) VALUES (?, 'source', ?, 'method', 'list', 3, 1, 'h1')").run("legacy/agency.php::Agency::list", "legacy/agency.php");
		ledger.createUnit({ id: "agency_model", tier: "T1", meta: { files: ["legacy/agency.php"], place: { stack: "nestjs", area: "agency", shared: false, source: "code" } }, symbolIds: ["legacy/agency.php::Agency", "legacy/agency.php::Agency::list"] });
		ledger.createUnit({ id: "agency_old", tier: "T1", meta: { files: ["legacy/old.php"], place: { stack: "nestjs", area: "agency", shared: false, source: "code" } }, symbolIds: [] });
		ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = 'agency_old'").run();
		const adapter = await getTargetAdapter("nestjs");
		const place = placeUnit(config, ledger.getUnit("agency_model")!.meta, ws);
		const moduleDir = placementDir(adapter.layout, place);

		record(ledger);
		const card = await buildTaskCard(ledger, config, "agency_model", { targetProjectDir: api, writeGlobs: [`${moduleDir}/**`], adapter, place, moduleDir, root: ws });
		expect(card.areaModule?.siblings.map((s) => s.id)).toEqual(["agency_old"]);
		expect(seen.length).toBeGreaterThan(10);
		expect(fullScans(ledger)).toEqual([]);
	});

	it("the start's record of a lost run reads attempts and transitions by time", () => {
		ledger.createUnit({ id: "u1", tier: "leaf", symbolIds: [] });
		const startedAt = new Date(Date.now() - 60_000).toISOString();
		ledger.db.prepare("INSERT INTO attempts(unit_id, role, model, started_at) VALUES ('u1', 'implement', 'm', ?)").run(new Date().toISOString());
		ledger.setMeta("open_run", JSON.stringify({ startedAt }));

		record(ledger);
		expect(recordLostRun(ledger, ws)?.units).toEqual([{ unit: "u1", state: "planned" }]);
		expect(fullScans(ledger)).toEqual([]);
	});

	it("which units wait on questions: all units are read only when a question blocks dependents or a module", () => {
		ledger.createUnit({ id: "a", tier: "leaf", symbolIds: [] });
		ledger.createUnit({ id: "b", tier: "leaf", symbolIds: [], deps: ["a"] });
		ledger.createUnit({ id: "c", tier: "leaf", symbolIds: [], deps: ["b"] });
		record(ledger);
		expect(ledger.blockedUnits().size).toBe(0);
		expect(seen.filter((s) => /\bFROM units\b/.test(s.sql))).toEqual([]);

		const q = ledger.askQuestion({ unitId: "a", point: "x", question: "?", blocks: "dependents", askedBy: "test" });
		expect([...ledger.blockedUnits()]).toEqual([["a", [q]], ["b", [q]], ["c", [q]]]);
	});

	it("each scheduling pass picks up placement and area answers without reading every unit's meta", () => {
		// the placement answer join on every unit's meta held the run's thread 2.2 s per pass on a real ledger
		for (const id of ["a", "b", "c"]) ledger.createUnit({ id, tier: "leaf", meta: { files: [`legacy/${id}.php`] }, symbolIds: [] });
		const q = ledger.askQuestion({ unitId: "b", point: "placement", question: "?", blocks: "unit", askedBy: "placement" });
		ledger.updateUnit("b", { meta: { placeQuestion: q } });
		const waiting = ledger.askQuestion({ unitId: "c", point: "placement", question: "?", blocks: "unit", askedBy: "placement" });
		ledger.updateUnit("c", { meta: { placeQuestion: waiting } });
		ledger.answerQuestion(q, "nestjs:agency", "human");

		record(ledger);
		expect(applyPlacementAnswers(ledger, config, ws)).toEqual(["b"]);
		syncTaxonomyAnswers({ ledger, root: ws }); // no area question answered: no unit is read
		expect(JSON.parse(ledger.getUnit("b")!.meta).place).toMatchObject({ stack: "nestjs", area: "agency", source: "answer" });
		expect(fullScans(ledger, ["units"])).toEqual([]);
	});
});
