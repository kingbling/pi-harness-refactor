import { appendFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../src/config.ts";
import { FakeModelClient } from "../src/models/fake.ts";
import { askDbInputs, dbDetected, findDbFiles, groupTables, planDbLane, readSchema } from "../src/inventory/db.ts";
import { inventory } from "../src/inventory/run.ts";
import { applySlicePlan, planSlices } from "../src/inventory/slices.ts";
import { Ledger } from "../src/ledger/db.ts";
import type { GateInput, GateReport } from "../src/run/gate.ts";
import { runUnit } from "../src/run/unit.ts";
import type { LeafSession } from "../src/sessions/spawn.ts";

/**
 * The DB lane: only with a detected data store; schema inputs → tables → DB units in their own slice right
 * after foundation; code units whose SQL names a table wait for that table's schema unit; the units run
 * their own implement → gate loop inside the stack's data dirs.
 */
const here = resolve(import.meta.dirname, "..");
const FIXTURE = resolve(here, "fixtures/mini-app");
let ws: string;
const write = (p: string, s = "x\n") => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, s));
const SCHEMA = `
CREATE TABLE invoices (id INT PRIMARY KEY, customer TEXT, customer_type VARCHAR(20), lines TEXT, created_at DATETIME);
CREATE TABLE \`invoice_lines\` (id INT PRIMARY KEY, invoice_id INT, amount DECIMAL(10,2));
ALTER TABLE invoice_lines ADD CONSTRAINT fk_inv FOREIGN KEY (invoice_id) REFERENCES invoices(id);
CREATE TABLE IF NOT EXISTS customers (id INT PRIMARY KEY, name TEXT);
CREATE TABLE audit_log (id INT, msg TEXT);
`;
const cfg = (db: Record<string, unknown>): Config => ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, db, models: {} });

beforeEach(() => {
	ws = join(here, ".sim", "db-lane");
	rmSync(ws, { recursive: true, force: true });
	cpSync(FIXTURE, join(ws, "legacy"), { recursive: true });
	write(join(ws, "legacy", "db", "schema.sql"), SCHEMA);
});

describe("DB lane", () => {
	it("is only there when a data store was detected", () => {
		expect(dbDetected(cfg({ from: [] }))).toBe(false);
		expect(dbDetected(cfg({ from: ["mysql"], strategy: "none" }))).toBe(false);
		expect(dbDetected(cfg({ from: ["mysql"] }))).toBe(true);
	});

	it("one question for every store: Enter takes what was found; plain paths are read by code, own words by a model; paths are checked", async () => {
		mkdirSync(join(ws, "legacy", "database", "migrations"), { recursive: true });
		write(join(ws, "legacy", "dumps", "arango"), "x");
		expect(findDbFiles(join(ws, "legacy")).schema).toEqual(["database/migrations/", "db/schema.sql"]);
		const ask = async (answers: Array<string | undefined>, o = {}) => {
			const asked: Array<[string, string]> = [];
			const got = await askDbInputs(cfg({ from: ["mariadb", "arangodb"] }), { text: async (m, i) => (asked.push([m, i]), answers.shift()), log: () => {} }, false, o);
			return { asked, got };
		};
		// Enter: what code found
		const a = await ask([""]);
		expect(a.asked[0]![0]).toMatch(/^mariadb \+ arangodb: what should the migration read/);
		expect(a.asked[0]![0]).toContain("schema: database/migrations/, db/schema.sql");
		expect(a.got.schemaFiles).toEqual(["database/migrations/", "db/schema.sql"]);
		// plain paths, a mistyped one is suggested; the typed text stays to be corrected
		const b = await ask(["schema.sql, env:DB_URL", "db/schema.sql, env:DB_URL"]);
		expect(b.asked[1]![0]).toMatch(/^Not found in .*: schema.sql \(did you mean db\/schema.sql\?\)/);
		expect(b.asked[1]![1]).toBe("schema.sql, env:DB_URL");
		expect(b.got).toEqual({ schemaFiles: ["db/schema.sql"], snapshot: undefined, url: "env:DB_URL", exports: {} });
		// own words without a model: asked again; with a model: mapped, a password is refused
		const c = await ask(["use the arango dump please", ""]);
		expect(c.asked[1]![0]).toMatch(/^Without a model only paths/);
		const client = new FakeModelClient({ chat: () => ({ json: { schemaFiles: ["db/schema.sql"], snapshot: "", url: "mysql://root:secret@localhost/app", exports: [{ engine: "arangodb", path: "dumps/arango" }] } }) });
		const d = await ask(["the schema file, the arango dump, and mysql://root:secret@localhost/app", ""], { client, model: "m" });
		expect(d.asked[1]![0]).toMatch(/password, which is never stored/);
		const client2 = new FakeModelClient({ chat: () => ({ json: { schemaFiles: ["db/schema.sql"], snapshot: "", url: "env:DATABASE_URL", exports: [{ engine: "arangodb", path: "dumps/arango" }] } }) });
		const e = await ask(["the schema file, the arango dump, connect with env:DATABASE_URL"], { client: client2, model: "m" });
		expect(e.got).toEqual({ schemaFiles: ["db/schema.sql"], snapshot: undefined, url: "env:DATABASE_URL", exports: { arangodb: "dumps/arango" } });
		const yes = await askDbInputs(cfg({ from: ["mysql"] }), { text: async () => { throw new Error("--yes asks nothing"); }, log: () => {} }, true);
		expect(yes.schemaFiles).toEqual(["database/migrations/", "db/schema.sql"]);
	});

	it("a full data dump of any size works as schema input: only CREATE/ALTER TABLE are kept, INSERT lines are skipped", async () => {
		const dump = join(ws, "big-dump.sql");
		const row = `(1,'${"x".repeat(1_000_000)}')`;
		const insert = `INSERT INTO \`invoices\` VALUES ${Array(6).fill(row).join(",")};\n`; // ~6 MB per line, as mysqldump writes them
		writeFileSync(dump, `-- MariaDB dump\nCREATE TABLE \`invoices\` (\n  \`id\` int(11) NOT NULL,\n  PRIMARY KEY (\`id\`)\n) ENGINE=InnoDB;\n`);
		for (let i = 0; i < 10; i++) appendFileSync(dump, insert);
		appendFileSync(dump, "CREATE TABLE `customers` (\n  `id` int NOT NULL\n);\nALTER TABLE `invoices` ADD KEY `k` (`id`);\nALTER TABLE `ghost` ADD KEY `k` (`id`);\n");
		const progress: string[] = [];
		const t = await readSchema(cfg({ from: ["mariadb"], schemaFiles: [dump] }), (l) => progress.push(l));
		expect(t.map((x) => x.name)).toEqual(["customers", "invoices"]); // the ALTER of an unknown table is no table
		expect(t.find((x) => x.name === "invoices")!.ddl).toMatch(/ENGINE=InnoDB;\nALTER TABLE `invoices` ADD KEY/);
		expect(t.find((x) => x.name === "invoices")!.ddl).not.toContain("INSERT");
		expect(progress.at(-1)).toMatch(/reading big-dump\.sql: 100% of 0\.1 GB/);
	});

	it("reads tables from SQL (ALTERs joined to their table) and from SQLite files; groups by name prefix", async () => {
		const t = await readSchema(cfg({ from: ["mysql"], schemaFiles: ["db/schema.sql"] }));
		expect(t.map((x) => x.name)).toEqual(["audit_log", "customers", "invoice_lines", "invoices"]);
		expect(t.find((x) => x.name === "invoice_lines")!.ddl).toContain("FOREIGN KEY");
		expect(groupTables(t).map((g) => [g.name, g.tables.map((x) => x.name)])).toEqual([["invoice", ["invoice_lines", "invoices"]], ["misc", ["audit_log", "customers"]]]);

		const db = new DatabaseSync(join(ws, "legacy", "app.sqlite"));
		db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)");
		db.close();
		expect((await readSchema(cfg({ from: ["sqlite"], schemaFiles: ["app.sqlite"] }))).map((x) => x.name)).toEqual(["users"]);
	});

	it("migration lane: schema units + data unit, code units wait on their tables, data slice right after foundation; survives re-inventory", async () => {
		const config = cfg({ from: ["mysql"], to: "postgresql", schemaFiles: ["db/schema.sql"] });
		const ledger = new Ledger(":memory:");
		await inventory(config, ws, ledger);
		const r = await planDbLane(ledger, config);
		expect(r.units).toEqual(["DB_schema_invoice", "DB_schema_misc", "DB_data"]);
		expect(ledger.getUnit("DB_schema_invoice")!.kind).toBe("db_schema");
		expect(JSON.parse(ledger.getUnit("DB_data")!.deps)).toEqual(["DB_schema_invoice", "DB_schema_misc"]); // engine change: data moves
		expect(JSON.parse(ledger.getUnit("U003_src_InvoiceRepo")!.deps)).toContain("DB_schema_invoice");

		const plan = planSlices(ledger);
		const byName = Object.fromEntries(plan.slices.map((s) => [s.name, s]));
		expect(byName["data"]).toMatchObject({ kind: "data", rank: 1, units: expect.arrayContaining(["DB_schema_invoice", "DB_schema_misc", "DB_data"]) });
		expect(byName["foundation"]!.rank).toBe(0);
		expect(byName["invoices"]!.rank).toBe(3); // 0 foundation, 1 data, 2 auth (empty), 3 first feature
		applySlicePlan(ledger, plan);

		// inventory rewrites code deps and drops units it did not produce: the DB lane stays, deps are wired again
		await inventory(config, ws, ledger);
		expect(ledger.getUnit("DB_schema_invoice")).toBeDefined();
		expect(JSON.parse(ledger.getUnit("U003_src_InvoiceRepo")!.deps)).toContain("DB_schema_invoice");
	});

	it("refactor lane for new-schema; same engine keep-schema needs no data unit; 'no database' removes the lane", async () => {
		const ledger = new Ledger(":memory:");
		await inventory(cfg({ from: ["mysql"] }), ws, ledger);
		expect((await planDbLane(ledger, cfg({ from: ["mysql"], strategy: "new-schema", to: "postgresql", schemaFiles: ["db/schema.sql"] }))).units).toEqual(["DB_design_invoice", "DB_design_misc", "DB_data"]);
		expect((await planDbLane(ledger, cfg({ from: ["mysql"], to: "mysql", schemaFiles: ["db/schema.sql"] }))).units).toEqual(["DB_schema_invoice", "DB_schema_misc"]);
		expect(ledger.getUnit("DB_design_invoice")).toBeUndefined();
		const gone = await planDbLane(ledger, cfg({ from: ["mysql"], strategy: "none" }));
		expect(gone.removed.sort()).toEqual(["DB_schema_invoice", "DB_schema_misc"]);
		expect(JSON.parse(ledger.getUnit("U003_src_InvoiceRepo")!.deps).some((d: string) => d.startsWith("DB_"))).toBe(false);
	});

	it("a DB unit runs its own loop inside the data dirs, with the tests it wrote as proof", async () => {
		const config = cfg({ from: ["mysql"], to: "postgresql", schemaFiles: ["db/schema.sql"] });
		write(join(ws, "migrated", "package.json"), "{}");
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
		await planDbLane(ledger, config);
		const prompts: string[] = [];
		const spawn = async (): Promise<LeafSession> =>
			({
				run: async (p: string) => {
					prompts.push(p);
					write(join(ws, "migrated", "src", "db", "invoice.entity.spec.ts"), "it('x', () => {});\n");
					return { text: "done", toolCalls: 3, blocked: 0, usage: { input: 0, output: 0, cost: 0 } };
				},
				dispose() {},
			}) as unknown as LeafSession;
		const seen: GateInput[] = [];
		const gate = async (g: GateInput): Promise<GateReport> => (seen.push(g), { ok: true, steps: [], changedFiles: [], testFiles: g.testFiles.map((t) => t.path) });
		const r = await runUnit({ ledger, config, root: ws, unitId: "DB_schema_invoice", spawn, gate, log: () => {} });
		expect(r.state).toBe("review");
		expect(seen[0]!.writeGlobs).toContain("src/db/**");
		expect(seen[0]!.writeGlobs.every((g) => /^(src\/db|prisma|drizzle|migrations)\//.test(g))).toBe(true);
		expect(seen[0]!.testFiles.map((t) => t.path)).toEqual(["src/db/invoice.entity.spec.ts"]);
		expect(prompts[0]).toContain("CREATE TABLE invoices");
		expect(prompts[0]).not.toContain("audit_log");
		expect(prompts[0]).toContain("Migration lane (keep-schema)");
	});
});
