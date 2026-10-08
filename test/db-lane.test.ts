import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../src/config.ts";
import { FakeModelClient } from "../src/models/fake.ts";
import { applyTableJudgement, askDbInputs, dbDetected, findDbFiles, foundTablesPath, groupTables, planDbLane, readSchema, TABLE_PLAN_KEY, type TableJudgement } from "../src/inventory/db.ts";
import { inventory } from "../src/inventory/run.ts";
import { applySlicePlan, planSlices } from "../src/inventory/slices.ts";
import { Ledger } from "../src/ledger/db.ts";
import type { GateInput, GateReport } from "../src/run/gate.ts";
import { placeUnit } from "../src/run/placement.ts";
import { runUnit } from "../src/run/unit.ts";
import { commitAll, ensureRepo } from "../src/git.ts";
import type { LeafSession, SpawnOptions } from "../src/sessions/spawn.ts";

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

	it("a dump of several databases: each table knows its databases (USE lines, db.table names)", async () => {
		write(join(ws, "legacy", "db", "all.sql"), "USE `app`;\nCREATE TABLE `agency` (\n  `id` int NOT NULL\n);\nUSE `mysql`;\nCREATE TABLE `help_topic` (id int);\nCREATE TABLE `app_staging`.`agency` (\n  `id` int NOT NULL\n);\n");
		const t = await readSchema(cfg({ from: ["mariadb"], schemaFiles: ["db/all.sql"] }));
		expect(t.map((x) => [x.name, x.dbs])).toEqual([["agency", ["app", "app_staging"]], ["help_topic", ["mysql"]]]);
	});

	it("code guards on the model's table judgement: every table once or not migrated with a reason, at most 8 per group, left-out tables grouped by name", () => {
		const t = (name: string, dbs = ["app"]) => ({ name, ddl: `CREATE TABLE ${name} (id int);`, from: "x.sql", dbs });
		const tables = [...Array.from({ length: 10 }, (_, i) => t(`campaign${i}`)), t("agency"), t("agencyextras"), t("old_agency"), t("invoice_a"), t("invoice_b"), t("help_topic", ["mysql"]), t("archived", ["archive"])];
		const judged: TableJudgement = {
			databases: [{ name: "app", include: true, sure: true, why: "the app" }, { name: "mysql", include: false, sure: true, why: "engine system database" }, { name: "archive", include: false, sure: false, why: "maybe old data" }],
			tables: [
				...Array.from({ length: 10 }, (_, i) => ({ name: `campaign${i}`, area: "campaigns", group: "campaigns", drop: "" })),
				{ name: "agency", area: "agencies", group: "agencies", drop: "" },
				{ name: "AgencyExtras", area: "agencies", group: "agencies", drop: "" },
				{ name: "agencyextras", area: "users", group: "other", drop: "" }, // twice: the first counts
				{ name: "old_agency", area: "agencies", group: "agencies", drop: "backup copy of agency" },
				{ name: "ghost", area: "x", group: "x", drop: "" }, // not in the schema: ignored
			],
		};
		const plan = applyTableJudgement(tables, judged, { question: 7 });
		expect(plan.groups.map((g) => [g.name, g.area, g.tables.length])).toEqual([["campaigns1", "campaigns", 8], ["campaigns2", "campaigns", 2], ["agencies", "agencies", 2], ["invoice", undefined, 2]]);
		expect(plan.dropped).toEqual([
			{ table: "old_agency", reason: "backup copy of agency" },
			{ table: "help_topic", reason: "database mysql is not migrated: engine system database" },
			{ table: "archived", reason: "database archive: waiting for the owner's answer (question #7)" },
		]);
		const all = [...plan.groups.flatMap((g) => g.tables.map((x) => x.name)), ...plan.dropped.map((d) => d.table)];
		expect(all.sort()).toEqual(tables.map((x) => x.name).sort());
		// the owner's answer includes the unclear database; tables in a started unit stay there; its name stays taken
		const again = applyTableJudgement(tables, judged, { include: true, pinned: new Set(["agency", "agencyextras"]), taken: new Set(["invoice"]) });
		expect(again.groups.map((g) => g.name)).toEqual(["campaigns1", "campaigns2", "invoice2", "misc"]);
	});

	it("with a model: system databases and staging copies get no units, app tables are grouped by business area, one question for an unclear database", async () => {
		write(join(ws, "legacy", "db", "all.sql"), [
			"USE `app`;", "CREATE TABLE `agency` (`id` int);", "CREATE TABLE `agencyextras` (", "  `id` int,", "  `agency_id` int REFERENCES agency(id)", ");", "CREATE TABLE `campaign` (`id` int);",
			"USE `app_staging`;", "CREATE TABLE `agency` (`id` int);",
			"USE `mysql`;", "CREATE TABLE `help_topic` (`id` int);", "CREATE TABLE `time_zone` (`id` int);",
			"USE `reports_old`;", "CREATE TABLE `monthly` (`id` int);", "",
		].join("\n"));
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		writeFileSync(join(ws, ".bigrefactor", "areas.json"), JSON.stringify({ stacks: [{ stack: "nestjs", areas: [{ name: "agencies", purpose: "agency accounts" }, { name: "campaigns", purpose: "campaigns" }] }] }));
		const config = cfg({ from: ["mariadb"], to: "postgresql", schemaFiles: ["db/all.sql"] });
		const ledger = new Ledger(":memory:");
		ledger.db.prepare("INSERT INTO index_literal_refs(name, path, line) VALUES ('agencyextras', 'app/model/agencyextras.php', 3)").run();
		const prompts: string[] = [];
		const client = new FakeModelClient({
			chat: (req) => {
				if (!JSON.stringify(req.schema ?? {}).includes('"databases"')) return undefined; // the question's phrasing: stays unphrased
				prompts.push(req.messages.map((m) => m.content).join("\n"));
				return { json: {
					databases: [{ name: "app", include: true, sure: true, why: "production" }, { name: "app_staging", include: false, sure: true, why: "staging copy of app" }, { name: "mysql", include: false, sure: true, why: "engine system database" }, { name: "reports_old", include: false, sure: false, why: "no code names its tables" }],
					tables: [{ name: "agency", area: "agencies", group: "agencies", drop: "" }, { name: "agencyextras", area: "agencies", group: "agencies", drop: "" }, { name: "campaign", area: "campaigns", group: "campaigns", drop: "" }, { name: "help_topic", area: "x", group: "x", drop: "system table" }, { name: "time_zone", area: "x", group: "x", drop: "system table" }, { name: "monthly", area: "reports", group: "reports", drop: "" }],
				} };
			},
		});
		const r = await planDbLane(ledger, config, { client, root: ws });
		expect(r.units).toEqual(["DB_schema_agencies", "DB_schema_campaigns", "DB_data"]);
		expect(JSON.parse(ledger.getUnit("DB_schema_agencies")!.meta)).toMatchObject({ tables: ["agency", "agencyextras"], businessArea: "agencies" });
		// the DB unit sits in its business area, but DB units still run one at a time (they share the data dir)
		expect(placeUnit(config, ledger.getUnit("DB_schema_agencies")!.meta)).toMatchObject({ area: "agencies", moduleKey: "nestjs:db" });
		expect(placeUnit(config, ledger.getUnit("DB_data")!.meta)).toMatchObject({ area: "db", moduleKey: "nestjs:db" });
		expect(JSON.parse(ledger.getUnit("DB_data")!.meta).tables).toEqual(["agency", "agencyextras", "campaign"]);
		// facts by code in the one model call: databases, code references, columns, foreign keys, the areas
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("agencyextras  db: app  code: 1 file(s), e.g. app/model/agencyextras.php  columns: id,agency_id  fk: agency");
		expect(prompts[0]).toContain("agency  db: app,app_staging");
		expect(prompts[0]).toContain("agencies: agency accounts");
		const dropped = JSON.parse(ledger.getMeta(TABLE_PLAN_KEY)!).dropped as Array<{ table: string; reason: string }>;
		expect(dropped.map((d) => d.table)).toEqual(["help_topic", "monthly", "time_zone"]);
		expect(dropped.find((d) => d.table === "monthly")!.reason).toMatch(/^database reports_old: waiting for the owner's answer \(question #\d+\)/);
		const asked = ledger.openQuestions().filter((q) => q.point === "db_include");
		expect(asked).toHaveLength(1);

		// asked once; the judgement is reused; the owner's answer brings the database in
		await planDbLane(ledger, config, { client, root: ws });
		expect(ledger.openQuestions().filter((q) => q.point === "db_include")).toHaveLength(1);
		expect(prompts).toHaveLength(1);
		ledger.answerQuestion(asked[0]!.id, "include — migrate them");
		expect((await planDbLane(ledger, config, { client, root: ws })).units).toEqual(["DB_schema_agencies", "DB_schema_campaigns", "DB_schema_reports", "DB_data"]);

		// without a model (tests, --no-llm): every table, grouped by name as before
		const offline = await planDbLane(new Ledger(":memory:"), config);
		expect(offline.tables).toBe(6);
		expect(offline.dropped).toBe(0);
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
		// no ORM assumed: the schema is written the way this stack accesses data
		expect(prompts[0]).not.toContain("ORM schema/entities");
		expect(prompts[0]).toContain("this stack's data-access approach");
	});
});

describe("DB lane: a failed gate is read by the triage model", () => {
	it("a setup failure goes to the setup model, not another schema attempt; the unit waits for a fresh worktree", async () => {
		const config = cfg({ from: ["mysql"], to: "postgresql", schemaFiles: ["db/schema.sql"] });
		write(join(ws, "migrated", "package.json"), "{}");
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
		await planDbLane(ledger, config);
		let sessions = 0;
		const spawn = async (): Promise<LeafSession> =>
			({
				run: async () => {
					sessions++;
					write(join(ws, "migrated", "src", "db", "invoice.entity.spec.ts"), "it('x', () => {});\n");
					return { text: "done", toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } };
				},
				dispose() {},
			}) as unknown as LeafSession;
		const gate = async (g: GateInput): Promise<GateReport> => ({ ok: false, failedStep: "ported_tests_green", steps: [{ name: "ported_tests_green", ok: false, ms: 1, output: 'Error in bootstrap script: Unable to read the ".env" environment file.' }], changedFiles: [], testFiles: g.testFiles.map((t) => t.path) });
		const client = new FakeModelClient({ decide: (req) => (req.questions["cause"] ? { cause: "env" } : undefined) });
		// the setup model commits its fix to the target repo: the target must be its own repo
		ensureRepo(join(ws, "migrated"), "main", []);
		commitAll(join(ws, "migrated"), "init");
		const problems: string[] = [];
		const setupFixer = async (f: { problem: string }) => (problems.push(f.problem), write(join(ws, "migrated", ".gitignore"), "vendor/\n"), "the .env file is now tracked");
		const r = await runUnit({ ledger, config, root: ws, unitId: "DB_schema_invoice", spawn, gate, client, setupFixer: setupFixer as never, log: () => {} });
		expect(sessions).toBe(1); // no blind second attempt at the schema
		expect(problems[0]).toContain("Unable to read the \".env\" environment file");
		expect(r.state).not.toBe("quarantined");
		expect(JSON.parse(ledger.getUnit("DB_schema_invoice")!.meta).parked.diagnosis.summary).toContain("the .env file is now tracked");
	});
});

describe("DB lane: tables no parser reads are found by a model with tools", () => {
	it("Rails schema.rb: a read-only session records tables with file + line; code checks the files, stores them, reads the definitions", async () => {
		write(join(ws, "legacy", "db", "schema.rb"), 'ActiveRecord::Schema.define do\n  create_table "invoices", force: :cascade do |t|\n    t.string "customer"\n  end\n\n  create_table "customers" do |t|\n    t.string "name"\n  end\nend\n');
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		const config = cfg({ from: ["postgresql"], schemaFiles: ["db/schema.rb"] });
		// the certain parsers find nothing in Ruby code
		expect(await readSchema(config, () => {}, undefined)).toEqual([]);
		const seen: { opts?: SpawnOptions; task?: string; runs: number } = { runs: 0 };
		const spawn = (async (opts: SpawnOptions): Promise<LeafSession> => {
			seen.opts = opts;
			return {
				run: async (task: string) => {
					seen.task = task;
					seen.runs++;
					const rec = opts.customTools!.find((t) => t.name === "record_tables") as unknown as { execute: (i: string, p: object) => Promise<unknown> };
					await rec.execute("x", { tables: [{ name: "invoices", file: "db/schema.rb", line: 2 }, { name: "customers", file: "./db/schema.rb", line: 6 }, { name: "ghost", file: "db/nope.rb", line: 1 }, { name: "escape", file: "../etc/passwd", line: 1 }] });
					return { text: "done", toolCalls: 2, blocked: 0, usage: { input: 0, output: 0, cost: 0.01 } };
				},
				dispose() {},
			} as unknown as LeafSession;
		}) as never;
		const ledger = new Ledger(":memory:");
		const r = await planDbLane(ledger, config, { root: ws, spawn });
		expect(seen.opts).toMatchObject({ role: "review", cwd: config.source.path, writeGlobs: [] });
		expect(seen.task).toContain("db/schema.rb");
		expect(r.tables).toBe(2); // ghost (no such file) and escape (outside the repo) are not recorded
		const stored = JSON.parse(readFileSync(foundTablesPath(ws), "utf8"));
		expect(stored.tables.map((t: { name: string }) => t.name)).toEqual(["customers", "invoices"]);
		// the definition comes from the file itself, so the unit's task card shows real source
		const t = await readSchema(config, () => {}, ws);
		expect(t.find((x) => x.name === "invoices")).toMatchObject({ from: "db/schema.rb:2" });
		expect(t.find((x) => x.name === "invoices")!.ddl).toMatch(/^ {2}create_table "invoices"/);
		// asked once per set of schema inputs
		await planDbLane(ledger, config, { root: ws, spawn });
		expect(seen.runs).toBe(1);
	});

	it("without models (no client, no session) nothing is asked: the raw schema text stays the fallback", async () => {
		write(join(ws, "legacy", "db", "schema.rb"), 'create_table "invoices" do |t|\nend\n');
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		const r = await planDbLane(new Ledger(":memory:"), cfg({ from: ["postgresql"], schemaFiles: ["db/schema.rb"] }), { root: ws });
		expect(r.units).toEqual(["DB_schema_all"]);
		expect(existsSync(foundTablesPath(ws))).toBe(false);
	});
});
