import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "../config.ts";
import type { Ledger } from "../ledger/db.ts";
import type { ModelClient } from "../models/types.ts";
import { TARGET_ROLES } from "../adapters/registry.ts";
import { answerValue, askViaModel } from "../jev/ask.ts";
import { kebab } from "../run/areas.ts";
import { progress } from "../progress.ts";

/**
 * The database lane: only when the survey detected a data store (config.db.from) and the strategy is not
 * "none". Onboarding asks for the DB inputs (schema files, a data dump, a connection URL); the schema is
 * read into tables, and the tables become DB units in their own slice ("data", right after foundation):
 *
 *   keep-schema → migration lane: db_schema per table group (1:1 port, types translated to db.to)
 *   new-schema  → refactor lane:  db_design per table group (new schema + MAPPING.md old → new)
 *   both        → db_data once the schema units landed, when data has to move (engine change, new
 *                 schema, or a dump to load)
 *
 * Code units whose legacy SQL names a table depend on that table's schema unit, so features land on a
 * schema that exists. Which tables are the app's and how they group by business area is judged once by a
 * model (system databases, staging copies and leftovers are not migrated, each with a reason); code checks
 * that judgement, creates and wires the units. Their placement is the server stack's area "db".
 */

export const DB_UNIT_PREFIX = "DB_";
export const isDbUnitKind = (kind: string | null | undefined): boolean => !!kind && kind.startsWith("db_");

/** A DB lane exists: a data store was detected and the owner did not decide "no database". */
export function dbDetected(config: Config): boolean {
	return config.db.from.length > 0 && config.db.strategy !== "none";
}

const SCHEMA_EXT = new Set([".sql", ".prisma", ".dbml"]);
const SQLITE_EXT = new Set([".sqlite", ".sqlite3", ".db"]);
const DUMP_RE = /(dump|backup|snapshot|seed|data)[^/]*\.(sql|sql\.gz|gz|zip|bak|dump)$/i;
const MIGRATION_DIR_RE = /^(migrations?|db|database|schema|sql)$/i;
const SKIP_DIRS = new Set(["node_modules", "vendor", ".git", "dist", "build", "var", "cache", "tmp"]);

/** Candidate DB inputs in the legacy repo: schema files, migration dirs, SQLite files, dumps. Code only. */
export function findDbFiles(sourceRoot: string): { schema: string[]; dumps: string[] } {
	const schema: string[] = [];
	const dumps: string[] = [];
	const visit = (dir: string, depth: number) => {
		if (depth > 6) return;
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const n of names) {
			if (n.startsWith(".") || SKIP_DIRS.has(n)) continue;
			const p = join(dir, n);
			const rel = relative(sourceRoot, p);
			let st;
			try {
				st = statSync(p);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				// a migrations dir is one input (its files are read in order)
				if (MIGRATION_DIR_RE.test(n) && /migration/i.test(n)) {
					schema.push(`${rel}/`);
					continue;
				}
				visit(p, depth + 1);
				continue;
			}
			const ext = extname(n).toLowerCase();
			if (DUMP_RE.test(n) && st.size > 50_000) dumps.push(rel);
			else if (SCHEMA_EXT.has(ext) || SQLITE_EXT.has(ext) || /schema\.(xml|ya?ml|json)$/i.test(n)) schema.push(rel);
		}
	};
	visit(sourceRoot, 0);
	return { schema: schema.sort(), dumps: dumps.sort() };
}

export interface DbPrompter {
	text(message: string, initial: string): Promise<string | undefined>;
	log(line: string): void;
}

/** Engines with a SQL schema (DDL); the others (document/graph stores) get an export path instead. */
export const RELATIONAL = new Set(["mariadb", "mysql", "postgresql", "sqlite", "sqlserver", "oracle"]);
const BIG = 50_000_000;

/** Many files shown as their folders: "app/install/old/ (77 .sql files)"; few files as they are. */
export function summarizePaths(paths: string[], max = 6): string {
	const byDir = new Map<string, string[]>();
	for (const p of paths) {
		const d = p.endsWith("/") ? p : p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "";
		byDir.set(d, [...(byDir.get(d) ?? []), p]);
	}
	const parts = [...byDir.entries()].flatMap(([d, ps]) => (ps.length > 2 && d ? [`${d} (${ps.length} files)`] : ps));
	return parts.length > max ? `${parts.slice(0, max).join(", ")}, … (${paths.length} in all)` : parts.join(", ");
}

type DbInputs = Pick<Config["db"], "schemaFiles" | "snapshot" | "url" | "exports">;

/**
 * Ask for the DB inputs once, in one question for every detected store. What code found is shown short; Enter
 * takes it. Otherwise the owner says it in their own words ("use the dump in ~/dumps/prod.sql", "connect with
 * env:DATABASE_URL", plain paths): plain paths are read by code, anything else by a model that maps it onto
 * schema files, data dump, connection and per-store exports. Code checks every path (a mistyped one is
 * suggested) and keeps passwords out of the config. `--yes` takes what was detected.
 */
export async function askDbInputs(config: Config, ui: DbPrompter, yes: boolean, o: { client?: ModelClient; model?: string } = {}): Promise<DbInputs> {
	const found = findDbFiles(config.source.path);
	const sql = config.db.from.filter((e) => RELATIONAL.has(e.toLowerCase()));
	const docs = config.db.from.filter((e) => !RELATIONAL.has(e.toLowerCase()));
	const detected: DbInputs = { schemaFiles: sql.length ? found.schema : [], snapshot: sql.length ? found.dumps[0] : undefined, url: config.db.url, exports: {} };
	if (yes) return detected;
	const exists = (p: string) => existsSync(abs(config, p.replace(/\/$/, "")));
	// a mistyped path is often the right file under another top folder (php/gyro/… → gyro-php/gyro/…)
	const top = (() => {
		try {
			return readdirSync(config.source.path).filter((n) => !n.startsWith(".") && !SKIP_DIRS.has(n));
		} catch {
			return [];
		}
	})();
	const suggest = (p: string): string | undefined => {
		const segs = p.replace(/\/$/, "").split("/").filter(Boolean);
		for (let k = 0; k < segs.length; k++) {
			const tail = segs.slice(k).join("/");
			if (k && exists(tail)) return tail;
			const hit = top.find((d) => exists(`${d}/${tail}`));
			if (hit) return `${hit}/${tail}`;
		}
		return undefined;
	};
	const foundText = [
		detected.schemaFiles.length ? `schema: ${summarizePaths(detected.schemaFiles)}` : sql.length ? "no schema files found" : "",
		detected.snapshot ? `data dump: ${detected.snapshot}` : "",
		detected.url ? `connection: ${detected.url}` : "",
	].filter(Boolean).join("\n");
	const question = `${config.db.from.join(" + ")}: what should the migration read for the database? Enter takes what was found; or say it in your own words (files, folders, a data dump, a connection as env:VAR${docs.length ? `, an export folder for ${docs.join(", ")}` : ""}).`;
	let problem = "";
	let initial = "";
	for (;;) {
		const v = await ui.text(`${problem}${question}\n${foundText}`, initial);
		if (v === undefined) throw new Error("onboarding cancelled");
		const said = v.trim();
		if (!said) return detected;
		const got = plainPaths(said, exists) ?? (o.client ? await readWords(config, o.client, o.model ?? config.models.escalate.id, said, found, sql, docs) : undefined);
		if (!got) {
			problem = "Without a model only paths (comma-separated) or env:VAR can be read. ";
			initial = said;
			continue;
		}
		const all = [...got.schemaFiles, ...(got.snapshot ? [got.snapshot] : []), ...Object.values(got.exports)];
		const bad = all.filter((p) => !exists(p));
		const issues = bad.map((b) => (suggest(b) ? `${b} (did you mean ${suggest(b)}?)` : b));
		const url = got.url?.trim();
		const secret = !!url && /:\/\/[^/@]*:[^/@]+@/.test(url);
		if (!bad.length && !secret) {
			const out = { ...got, url: url || undefined };
			ui.log(`database inputs: ${[out.schemaFiles.length ? `schema ${summarizePaths(out.schemaFiles)}` : "", out.snapshot ? `dump ${out.snapshot}` : "", out.url ? `connection ${out.url}` : "", ...Object.entries(out.exports).map(([e, p]) => `${e} export ${p}`)].filter(Boolean).join(" · ") || "none"}`);
			return out;
		}
		problem = [issues.length ? `Not found in ${config.source.path}: ${issues.join(", ")}.` : "", secret ? "The connection holds a password, which is never stored: put the URL in an env var (export DATABASE_URL=…) and write env:DATABASE_URL." : ""].filter(Boolean).join(" ") + " Correct it below.\n";
		initial = said;
	}
}

/** "a.sql, migrations/, env:DB_URL" → inputs, when every part looks like a path or env:VAR (checked later); else undefined (words). */
function plainPaths(text: string, exists: (p: string) => boolean): DbInputs | undefined {
	const parts = text.split(/\s*,\s*|\s+/).filter(Boolean);
	const pathLike = (p: string) => /^env:\w+$/.test(p) || exists(p) || /^[\w.~\/@+-]*(\/|\.[a-z0-9]{1,8})$/i.test(p);
	if (!parts.length || !parts.every(pathLike)) return undefined;
	const url = parts.find((p) => p.startsWith("env:"));
	const files = parts.filter((p) => !p.startsWith("env:"));
	const dump = files.find((p) => DUMP_RE.test(p));
	return { schemaFiles: files.filter((p) => p !== dump), snapshot: dump, url, exports: {} };
}

/** The owner's words → DB inputs (a model reads them with what code found); paths are checked by the caller. */
async function readWords(config: Config, client: ModelClient, model: string, said: string, found: { schema: string[]; dumps: string[] }, sql: string[], docs: string[]): Promise<DbInputs | undefined> {
	try {
		const r = await client.chat({
			model,
			effort: "low",
			schema: {
				type: "object",
				additionalProperties: false,
				required: ["schemaFiles", "snapshot", "url", "exports"],
				properties: {
					schemaFiles: { type: "array", items: { type: "string" }, description: "schema files or folders (DDL, migrations dirs, .sqlite, schema.prisma); a full dump also works here" },
					snapshot: { type: "string", description: "data dump for the data migration, or empty" },
					url: { type: "string", description: "connection: env:VAR or a URL exactly as the owner gave it, or empty" },
					exports: { type: "array", items: { type: "object", additionalProperties: false, required: ["engine", "path"], properties: { engine: { type: "string" }, path: { type: "string" } } } },
				},
			},
			messages: [
				{ role: "system", content: "You turn what the owner of a legacy app said about its database into inputs for a migration tool. Paths are relative to the legacy repo or absolute; keep them exactly as said (or as found when the owner refers to found files, e.g. 'the found ones plus …'). Never invent a path." },
				{ role: "user", content: `Stores: ${[...sql, ...docs].join(", ")}\nFound by code — schema: ${found.schema.join(", ") || "none"}; dumps: ${found.dumps.join(", ") || "none"}\nThe owner said: ${said}` },
			],
		});
		const j = r.json as { schemaFiles?: string[]; snapshot?: string; url?: string; exports?: Array<{ engine: string; path: string }> } | undefined;
		if (!j) return undefined;
		return { schemaFiles: j.schemaFiles ?? [], snapshot: j.snapshot || undefined, url: j.url || undefined, exports: Object.fromEntries((j.exports ?? []).filter((e) => e.path && docs.includes(e.engine)).map((e) => [e.engine, e.path])) };
	} catch {
		return undefined;
	}
}

export interface DbTable {
	name: string;
	/** The table's DDL (or the schema snippet that defines it), for the unit's task card. */
	ddl: string;
	/** Where it was defined. */
	from: string;
	/** Databases that define it (`USE x;` or `x.table` in a dump of several databases); empty when the input names none. */
	dbs: string[];
}


const abs = (config: Config, p: string) => (p.startsWith("/") ? p : join(config.source.path, p));

/** Files behind config.db.schemaFiles (dirs expanded in name order, so migrations replay in sequence). */
function schemaPaths(config: Config): string[] {
	const out: string[] = [];
	for (const p of config.db.schemaFiles) {
		const a = abs(config, p.replace(/\/$/, ""));
		if (!existsSync(a)) continue;
		if (statSync(a).isDirectory()) {
			const walk = (d: string): string[] => readdirSync(d).sort().flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
			out.push(...walk(a));
		} else out.push(a);
	}
	return out;
}

/** Parsed tables per schema input, keyed by path + size + mtime: an 18 GB dump is scanned once per process. */
const scanned = new Map<string, DbTable[]>();

/**
 * Tables from the schema inputs. SQL: CREATE TABLE statements (ALTERs are appended to their table), read as a
 * stream so a full data dump of any size works (INSERT lines are skipped without being kept); SQLite:
 * sqlite_master; Prisma: model blocks; migration code: Schema::create / createTable / create_table.
 * Unknown formats yield no tables (the files still reach the units as raw schema text).
 */
export async function readSchema(config: Config, log: (l: string) => void = (l) => progress.log(l)): Promise<DbTable[]> {
	const tables = new Map<string, DbTable>();
	const add = (t: DbTable) => {
		const key = t.name.toLowerCase();
		const prev = tables.get(key);
		if (prev) {
			if (!prev.ddl.includes(t.ddl)) prev.ddl += `\n${t.ddl}`; // a dump of several databases repeats the same CREATE
			for (const d of t.dbs) if (!prev.dbs.includes(d)) prev.dbs.push(d);
		}
		else if (!/^\s*alter\b/i.test(t.ddl)) tables.set(key, { ...t, dbs: [...t.dbs] }); // an ALTER of a table no input creates is no table
	};
	for (const f of schemaPaths(config)) {
		const st = statSync(f);
		const key = `${f}|${st.size}|${st.mtimeMs}`;
		let found = scanned.get(key);
		if (!found) {
			found = await scanFile(f, relative(config.source.path, f), st.size, log);
			scanned.set(key, found);
		}
		for (const t of found) add(t);
	}
	return [...tables.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function scanFile(f: string, rel: string, size: number, log: (l: string) => void): Promise<DbTable[]> {
	const out: DbTable[] = [];
	const ext = extname(f).toLowerCase();
	if (SQLITE_EXT.has(ext)) {
		try {
			const db = new DatabaseSync(f, { readOnly: true });
			try {
				for (const r of db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL").all() as Array<{ name: string; sql: string }>) out.push({ name: r.name, ddl: `${r.sql};`, from: rel, dbs: [] });
			} catch {
				/* not a SQLite file */
			} finally {
				db.close();
			}
		} catch {
			/* not a SQLite file */
		}
		return out;
	}
	if (ext === ".prisma") {
		for (const m of readFileSync(f, "utf8").matchAll(/^model\s+(\w+)\s*\{[\s\S]*?^\}/gm)) out.push({ name: m[1]!, ddl: m[0], from: rel, dbs: [] });
		return out;
	}
	if (ext === ".sql" || size > 2_000_000) {
		await scanSqlDdl(f, size, (name, ddl, db) => out.push({ name, ddl, from: rel, dbs: db ? [db] : [] }), (pct) => log(`  reading ${basename(f)}: ${pct}% of ${(size / 1e9).toFixed(1)} GB (table definitions only)`));
		return out;
	}
	// migration code of common frameworks (Laravel, Phinx, Doctrine, Rails, Knex, Alembic) and small SQL-ish files
	const text = readFileSync(f, "utf8");
	await scanSqlText(text, (name, ddl, db) => out.push({ name, ddl, from: rel, dbs: db ? [db] : [] }));
	const seen = new Set(out.map((t) => t.name.toLowerCase()));
	for (const m of text.matchAll(/(?:Schema::create|createTable|create_table|table)\(\s*['":]?(\w+)['"]?/g)) {
		if (/^(if|function|array)$/i.test(m[1]!) || seen.has(m[1]!.toLowerCase())) continue;
		seen.add(m[1]!.toLowerCase());
		const start = m.index ?? 0;
		out.push({ name: m[1]!, ddl: text.slice(start, start + 1500), from: rel, dbs: [] });
	}
	return out;
}

/** `db`.`table` → m[1] = db (optional), m[2] = table. */
const IDENT = String.raw`[\x60"\[]?(?:(\w+)[\x60"\]]?\.[\x60"\[]?)?(\w+)[\x60"\]]?`;
const DDL_START = new RegExp(String.raw`^\s*(?:create\s+(?:temporary\s+)?table\s+(?:if\s+not\s+exists\s+)?|alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?)${IDENT}`, "i");
/** `USE dbname;`: a dump of several databases switches with it (mysqldump --all-databases / --databases). */
const USE_DB = /^\s*use\s+[\x60"\[]?(\w+)[\x60"\]]?\s*;/i;

type Emit = (table: string, ddl: string, db: string | undefined) => void;

/** Lines of SQL in order → DDL statements emitted whole, with the database they are in. `inStatement`: a statement is open. */
function ddlLines(emit: Emit): { line: (line: string) => void; inStatement: () => boolean } {
	let buf: string | undefined;
	let table = "";
	let db: string | undefined; // from the last USE line
	let stmtDb: string | undefined;
	const line = (line: string) => {
		if (buf === undefined) {
			const u = USE_DB.exec(line);
			if (u) {
				db = u[1]!;
				return;
			}
			const m = DDL_START.exec(line);
			if (!m) return;
			buf = "";
			table = m[2]!;
			stmtDb = m[1] ?? db;
		}
		buf += `${line}\n`;
		if (/;\s*$/.test(line)) {
			emit(table, buf.trimEnd(), stmtDb);
			buf = undefined;
		}
	};
	return { line, inStatement: () => buf !== undefined };
}

async function scanSqlText(text: string, emit: Emit): Promise<void> {
	const { line } = ddlLines(emit);
	for (const l of text.split("\n")) line(l);
}

/**
 * CREATE/ALTER TABLE statements of a SQL file of any size, read in 8 MB chunks. Lines outside a statement
 * (INSERTs of a data dump, often megabytes long) are never accumulated: only a line's first bytes are looked
 * at. Progress is reported every 10% for big files.
 */
async function scanSqlDdl(f: string, size: number, emit: Emit, onProgress: (pct: number) => void): Promise<void> {
	const fh = await open(f, "r");
	const chunk = Buffer.alloc(8 * 1024 * 1024);
	let pos = 0;
	let head = ""; // start of the current line (capped) while it is not known to be DDL
	let skipping = false; // current line is long and not DDL: ignore until its newline
	let lastPct = 0;
	const { line: endLine, inStatement } = ddlLines(emit);
	try {
		for (;;) {
			const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos);
			if (!bytesRead) break;
			pos += bytesRead;
			const text = chunk.toString("utf8", 0, bytesRead);
			let start = 0;
			for (;;) {
				const nl = text.indexOf("\n", start);
				const piece = text.slice(start, nl < 0 ? undefined : nl);
				if (!skipping) {
					head += piece;
					// a long line that is not part of a statement and does not start one: drop it (INSERT data)
					if (!inStatement() && head.length > 4096 && !DDL_START.test(head.slice(0, 4096))) {
						skipping = true;
						head = "";
					}
				}
				if (nl < 0) break;
				if (!skipping) endLine(head);
				head = "";
				skipping = false;
				start = nl + 1;
			}
			const pct = Math.floor((pos / size) * 10) * 10;
			if (size > BIG && pct > lastPct) {
				lastPct = pct;
				onProgress(pct);
			}
		}
		if (head && !skipping) endLine(head);
	} finally {
		await fh.close();
	}
}

/** Table groups for units: by name prefix (`invoice_items` → invoice), small groups merged, ≤ 8 tables each. */
export function groupTables(tables: DbTable[], max = 8): Array<{ name: string; tables: DbTable[] }> {
	const byPrefix = new Map<string, DbTable[]>();
	for (const t of tables) {
		const prefix = t.name.toLowerCase().replace(/^(tbl|t)_/, "").split(/[_.]/)[0]!.replace(/s$/, "") || "misc";
		(byPrefix.get(prefix) ?? byPrefix.set(prefix, []).get(prefix)!).push(t);
	}
	const groups: Array<{ name: string; tables: DbTable[] }> = [];
	let misc: DbTable[] = [];
	const flushMisc = () => {
		if (misc.length) groups.push({ name: groups.some((g) => g.name === "misc") ? `misc${groups.filter((g) => g.name.startsWith("misc")).length + 1}` : "misc", tables: misc });
		misc = [];
	};
	for (const [prefix, ts] of [...byPrefix].sort((a, b) => a[0].localeCompare(b[0]))) {
		if (ts.length === 1) {
			misc.push(ts[0]!);
			if (misc.length >= max) flushMisc();
			continue;
		}
		for (let i = 0; i < ts.length; i += max) groups.push({ name: ts.length > max ? `${prefix}${i / max + 1}` : prefix, tables: ts.slice(i, i + max) });
	}
	flushMisc();
	return groups;
}

/**
 * Which tables are the app's and which business area each belongs to. A dump often holds several databases
 * (production, staging copies, the engine's own `mysql` system database) and app tables often have no name
 * prefix, so neither "every table" nor "group by prefix" works. Code gathers the facts (databases, columns,
 * foreign keys, where the legacy code names the table); one model call judges them; code checks the answer.
 */
export interface TableJudgement {
	databases: Array<{ name: string; include: boolean; sure: boolean; why: string }>;
	tables: Array<{ name: string; area: string; group: string; drop: string }>;
}

export interface TablePlan {
	groups: Array<{ name: string; area?: string; tables: DbTable[] }>;
	dropped: Array<{ table: string; reason: string }>;
}

/** Ledger meta keys: the model's last judgement (reused while the facts stay the same) and the plan the units follow. */
const JUDGED_KEY = "db_tables_judged";
export const TABLE_PLAN_KEY = "db_tables";
const DB_QUESTION = "db_include";

/** One line of facts per table: databases, columns, foreign keys, how often the legacy code names it. */
export function tableFacts(ledger: Ledger, tables: DbTable[]): string[] {
	const want = new Set(tables.map((t) => t.name.toLowerCase()));
	const refs = new Map<string, { files: number; sample: string }>();
	for (const r of ledger.db.prepare("SELECT lower(name) n, COUNT(DISTINCT path) c, MIN(path) p FROM index_literal_refs GROUP BY lower(name)").all() as Array<{ n: string; c: number; p: string }>) {
		if (want.has(r.n)) refs.set(r.n, { files: r.c, sample: r.p });
	}
	const queries = new Map<string, number>();
	for (const r of ledger.db.prepare("SELECT tables FROM index_queries").all() as Array<{ tables: string }>) {
		for (const t of JSON.parse(r.tables) as string[]) queries.set(t.toLowerCase(), (queries.get(t.toLowerCase()) ?? 0) + 1);
	}
	const KEYWORD = /^(primary|key|unique|constraint|index|foreign|fulltext|spatial|check|create|alter|engine)$/i;
	return tables.map((t) => {
		const first = t.ddl.split(/;\s*\n/)[0] ?? "";
		const cols = [...first.matchAll(/^\s*[\x60"\[]?(\w+)[\x60"\]]?\s+\w/gm)].map((m) => m[1]!).filter((c) => !KEYWORD.test(c));
		const fks = [...new Set([...t.ddl.matchAll(/references\s+[\x60"\[]?(?:\w+[\x60"\]]?\.[\x60"\[]?)?(\w+)/gi)].map((m) => m[1]!))];
		const r = refs.get(t.name.toLowerCase());
		const q = queries.get(t.name.toLowerCase()) ?? 0;
		return [
			t.name,
			t.dbs.length ? `db: ${t.dbs.join(",")}` : "",
			`code: ${r ? `${r.files} file(s), e.g. ${r.sample}` : "not named"}${q ? `, ${q} quer${q === 1 ? "y" : "ies"}` : ""}`,
			`columns: ${cols.slice(0, 10).join(",")}${cols.length > 10 ? ",…" : ""}`,
			fks.length ? `fk: ${fks.join(",")}` : "",
		].filter(Boolean).join("  ");
	});
}

/** Business areas of the server stack from areas.json (the curated taxonomy), if there is one. */
function serverAreas(root: string | undefined, config: Config): Array<{ name: string; purpose: string }> {
	const p = root ? join(root, ".bigrefactor", "areas.json") : "";
	if (!p || !existsSync(p)) return [];
	try {
		const j = JSON.parse(readFileSync(p, "utf8")) as { stacks?: Array<{ stack: string; areas: Array<{ name: string; purpose: string }> }> };
		return j.stacks?.find((s) => s.stack === dbStack(config))?.areas ?? [];
	} catch {
		return [];
	}
}

/** The model's judgement of the tables; reused from the ledger while tables, databases and areas are the same. */
async function judgeTables(ledger: Ledger, config: Config, client: ModelClient, root: string | undefined, tables: DbTable[]): Promise<{ judged: TableJudgement; costUsd: number }> {
	const areas = serverAreas(root, config);
	const facts = tableFacts(ledger, tables);
	const key = createHash("sha1").update(JSON.stringify([facts, areas.map((a) => a.name)])).digest("hex").slice(0, 16);
	const prev = ledger.getMeta(JUDGED_KEY);
	if (prev) {
		const p = JSON.parse(prev) as { key: string; judged: TableJudgement };
		if (p.key === key) return { judged: p.judged, costUsd: 0 };
	}
	const dbs = [...new Set(tables.flatMap((t) => t.dbs))].sort();
	const role = config.models.escalate;
	const res = await client.chat({
		model: role.id,
		tier: role.tier as "default" | "flex" | "priority",
		effort: "high",
		schema: {
			type: "object",
			additionalProperties: false,
			required: ["databases", "tables"],
			properties: {
				databases: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "include", "sure", "why"], properties: { name: { type: "string" }, include: { type: "boolean" }, sure: { type: "boolean" }, why: { type: "string" } } } },
				tables: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						required: ["name", "area", "group", "drop"],
						properties: {
							name: { type: "string" },
							area: { type: "string", description: "business area of the app this table belongs to" },
							group: { type: "string", description: "short name of a group of closely related tables, e.g. campaign-stats" },
							drop: { type: "string", description: "empty = migrate it; else why it is no app data (system table, unused leftover)" },
						},
					},
				},
			},
		},
		messages: [
			{
				role: "system",
				content: `You sort the tables of a legacy app's database for its migration to ${config.db.to ?? "a new database"} (${config.target.stacks.join(" + ")}). Rules:
- databases: one entry for EVERY database listed. include = it holds the app's own data that must be migrated. The engine's own system databases (mysql, information_schema, performance_schema, sys) are never included. A staging or test copy of the production database is not included when the production one has the same tables. sure = false only when the facts do not tell; then the owner is asked.
- tables: one entry for EVERY table. drop (with a short reason) the engine's system tables and tables the app clearly does not use any more; else drop is empty. A table the code never names may still be used (names built at run time, reports): keep it unless it is clearly a leftover (backup copy, old_/tmp_ names).
- area: the business area of the app the table belongs to. group: closely related tables (a main table with its detail, link and stats tables) share one group name; 2 to 8 tables per group.
- Names: kebab-case, plain business words, never a technical layer.`,
			},
			{
				role: "user",
				content: `${areas.length ? `Business areas of the new app (use these names):\n${areas.map((a) => `${a.name}: ${a.purpose}`).join("\n")}\n\n` : ""}${dbs.length ? `Databases in the schema input: ${dbs.join(", ")}\n\n` : ""}Tables (name, databases, where the legacy code names it, columns, foreign keys):\n${facts.join("\n")}`,
			},
		],
	});
	const j = (res.json ?? {}) as Partial<TableJudgement>;
	const judged: TableJudgement = { databases: j.databases ?? [], tables: j.tables ?? [] };
	ledger.setMeta(JUDGED_KEY, JSON.stringify({ key, judged, by: res.usage.model, at: new Date().toISOString() }));
	return { judged, costUsd: res.usage.costUsd };
}

/**
 * The model's judgement → table groups, checked by code: every table lands in exactly one group or is dropped
 * with a reason; a group holds at most `max` tables; tables the model left out are grouped by name prefix.
 * `pinned` tables already sit in a started unit and are left alone. A database the model is unsure about
 * follows the owner's answer (`include`); until then its tables wait (dropped, the open question as reason).
 */
export function applyTableJudgement(tables: DbTable[], judged: TableJudgement, o: { pinned?: Set<string>; taken?: Set<string>; include?: boolean; question?: number; max?: number } = {}): TablePlan {
	const max = o.max ?? 8;
	// per database: true = migrated, else the reason its tables are not
	const dbOk = new Map<string, true | string>();
	for (const d of judged.databases) {
		if (dbOk.has(d.name.toLowerCase())) continue;
		const keep = d.sure ? d.include : o.include;
		dbOk.set(d.name.toLowerCase(), keep === true ? true : keep === false ? `database ${d.name} is not migrated: ${d.why}` : `database ${d.name}: waiting for the owner's answer${o.question ? ` (question #${o.question})` : ""}`);
	}
	const byName = new Map<string, TableJudgement["tables"][number]>();
	for (const t of judged.tables) if (!byName.has(t.name.toLowerCase())) byName.set(t.name.toLowerCase(), t);
	const dropped: TablePlan["dropped"] = [];
	const grouped = new Map<string, { name: string; area?: string; tables: DbTable[] }>();
	const leftover: DbTable[] = [];
	for (const t of tables) {
		if (o.pinned?.has(t.name.toLowerCase())) continue;
		// a table counts when one of its databases is migrated (or one the model did not judge)
		const verdicts = t.dbs.map((d) => dbOk.get(d.toLowerCase()) ?? true);
		if (verdicts.length && !verdicts.includes(true)) {
			dropped.push({ table: t.name, reason: verdicts[0] as string });
			continue;
		}
		const j = byName.get(t.name.toLowerCase());
		if (!j) {
			leftover.push(t);
			continue;
		}
		if (j.drop.trim()) {
			dropped.push({ table: t.name, reason: j.drop.trim() });
			continue;
		}
		const name = snake(j.group) || snake(j.area) || "misc";
		(grouped.get(name) ?? grouped.set(name, { name, area: kebab(j.area) || undefined, tables: [] }).get(name)!).tables.push(t);
	}
	const groups: TablePlan["groups"] = [];
	const used = new Set(o.taken); // group names of started units: a new group never takes their id
	const unique = (n: string) => {
		let name = n;
		for (let i = 2; used.has(name); i++) name = `${n}${i}`;
		used.add(name);
		return name;
	};
	for (const g of [...grouped.values(), ...groupTables(leftover, max)]) {
		for (let i = 0; i < g.tables.length; i += max) groups.push({ ...g, name: unique(g.tables.length > max ? `${g.name}${i / max + 1}` : g.name), tables: g.tables.slice(i, i + max) });
	}
	return { groups, dropped };
}

const snake = (s: string) => kebab(s).replace(/-/g, "_");

/**
 * Databases the model is unsure about: the owner's answer (one question for all of them, asked once, phrased by
 * a model). Returns include = the answer, or undefined while it is open; `question` is its id.
 */
async function askAboutDatabases(ledger: Ledger, config: Config, client: ModelClient, root: string | undefined, judged: TableJudgement, tables: DbTable[]): Promise<{ include?: boolean; question?: number; costUsd: number }> {
	const unsure = judged.databases.filter((d) => !d.sure).sort((a, b) => a.name.localeCompare(b.name));
	if (!unsure.length) return { costUsd: 0 };
	const sameAs = unsure.map((d) => d.name).join(",");
	const done = ledger.db.prepare("SELECT id, answer FROM questions WHERE point = ? AND json_extract(context, '$.sameAs') = ? AND status IN ('answered', 'auto') ORDER BY id DESC LIMIT 1").get(DB_QUESTION, sameAs) as { id: number; answer: string } | undefined;
	if (done) return { include: answerValue(done.answer) === "include", question: done.id, costUsd: 0 };
	const facts = unsure.map((d) => {
		const ts = tables.filter((t) => t.dbs.some((x) => x.toLowerCase() === d.name.toLowerCase()));
		return `database ${d.name}: ${ts.length} table(s), e.g. ${ts.slice(0, 8).map((t) => t.name).join(", ")}. Model: ${d.include ? "probably app data" : "probably not app data"}, not sure: ${d.why}`;
	});
	const q = await askViaModel({ ledger, config, root, client }, {
		point: DB_QUESTION,
		facts: `The schema input holds several databases. For these it is unclear whether their tables are the app's data that must be migrated:\n${facts.join("\n")}\nTheir tables wait until this is answered; then run br order.`,
		options: [{ value: "include", facts: `migrate the tables of ${sameAs}` }, { value: "leave-out", facts: `do not migrate ${sameAs}` }],
		recommended: unsure.every((d) => d.include) ? "include" : "leave-out",
		guess: true,
		blocks: "none",
		askedBy: "db lane",
		sameAs,
	});
	return { question: q.id, include: q.decided ? q.decided === "include" : undefined, costUsd: q.costUsd };
}

/** The stack DB units are placed in: the server target (tables live behind the API), else the first stack. */
export function dbStack(config: Config): string {
	return config.target.stacks.find((s) => TARGET_ROLES[s] === "server") ?? config.target.stacks[0]!;
}

export interface DbUnitMeta {
	lane: "db";
	tables: string[];
	group?: string;
	strategy: string;
	from: string[];
	to?: string;
}

/**
 * Create, update and remove the DB units for the current config and schema; then wire code units to the
 * schema units of the tables their SQL names. Idempotent. Units already started are never changed, and their
 * tables stay theirs. With a client, a model judges which tables are the app's and groups them by business
 * area (applyTableJudgement checks it); without one (tests, simulations, --no-llm) tables are grouped by name.
 * Tables not migrated are kept with their reason in the ledger (meta `db_tables`).
 */
export async function planDbLane(ledger: Ledger, config: Config, o: { client?: ModelClient; root?: string; log?: (l: string) => void } = {}): Promise<{ units: string[]; tables: number; dropped: number; wired: number; removed: string[]; costUsd: number }> {
	const existing = ledger.listUnits().filter((u) => isDbUnitKind(u.kind));
	const removeStale = (keep: Set<string>) => {
		const removed: string[] = [];
		for (const u of existing) if (!keep.has(u.id) && u.state === "planned") {
			ledger.db.prepare("DELETE FROM units WHERE id = ?").run(u.id);
			removed.push(u.id);
		}
		return removed;
	};
	if (!dbDetected(config)) {
		const removed = removeStale(new Set());
		return { units: [], tables: 0, dropped: 0, wired: wireDbDeps(ledger), removed, costUsd: 0 };
	}
	const tables = await readSchema(config);
	const refactor = config.db.strategy === "new-schema";
	const kind = refactor ? "db_design" : "db_schema";
	const unitId = (group: string) => `${DB_UNIT_PREFIX}${refactor ? "design" : "schema"}_${group}`;
	const started = existing.filter((u) => u.state !== "planned" && u.kind !== "db_data");
	const pinned = new Set(started.flatMap((u) => ((JSON.parse(u.meta) as DbUnitMeta).tables ?? []).map((t) => t.toLowerCase())));
	const taken = new Set(started.flatMap((u) => (u.id.startsWith(unitId("")) ? [u.id.slice(unitId("").length)] : [])));
	let costUsd = 0;
	let judged: TableJudgement = { databases: [], tables: [] };
	let answer: { include?: boolean; question?: number } = {};
	if (o.client && tables.some((t) => !pinned.has(t.name.toLowerCase()))) {
		const j = await judgeTables(ledger, config, o.client, o.root, tables);
		judged = j.judged;
		const a = await askAboutDatabases(ledger, config, o.client, o.root, judged, tables);
		answer = { include: a.include, question: a.question };
		costUsd += j.costUsd + a.costUsd;
	}
	const plan = applyTableJudgement(tables, judged, { pinned, taken, ...answer });
	ledger.setMeta(TABLE_PLAN_KEY, JSON.stringify({ groups: Object.fromEntries(plan.groups.map((g) => [g.name, { area: g.area, tables: g.tables.map((t) => t.name) }])), dropped: plan.dropped, at: new Date().toISOString() }));
	if (plan.dropped.length) o.log?.(`  ${plan.dropped.length} table(s) not migrated, e.g. ${plan.dropped.slice(0, 5).map((d) => `${d.table} (${d.reason})`).join("; ")}`);
	const place = { stack: dbStack(config), area: "db", shared: false, source: "code" };
	const route = { difficulty: "moderate", needs_db: 1, has_ui: 0, by: "db lane" };
	const base = { lane: "db", strategy: config.db.strategy, from: config.db.from, to: config.db.to, place, route, files: [] as string[], loc: 0 };
	const want: Array<{ id: string; kind: string; deps: string[]; meta: Record<string, unknown> }> = [];
	const groups = tables.length ? plan.groups : [{ name: "all", tables: [] as DbTable[] }];
	for (const g of groups) {
		want.push({ id: unitId(g.name), kind, deps: [], meta: { ...base, group: g.name, ...("area" in g && g.area ? { businessArea: g.area } : {}), tables: g.tables.map((t) => t.name), loc: g.tables.reduce((a, t) => a + t.ddl.split("\n").length, 0) } });
	}
	const engineChange = !!config.db.to && config.db.from.some((f) => f.toLowerCase() !== config.db.to!.toLowerCase());
	const notMigrated = new Set(plan.dropped.map((d) => d.table.toLowerCase()));
	if (refactor || engineChange || config.db.snapshot) want.push({ id: `${DB_UNIT_PREFIX}data`, kind: "db_data", deps: [...started.map((u) => u.id), ...want.map((w) => w.id)], meta: { ...base, tables: tables.filter((t) => !notMigrated.has(t.name.toLowerCase())).map((t) => t.name) } });
	for (const w of want) {
		const u = ledger.getUnit(w.id);
		if (!u) ledger.createUnit({ id: w.id, tier: "T0", kind: w.kind, deps: w.deps, meta: w.meta, symbolIds: [] });
		else if (u.state === "planned") {
			ledger.db.prepare("UPDATE units SET kind = ?, deps = ? WHERE id = ?").run(w.kind, JSON.stringify(w.deps), w.id);
			ledger.updateUnit(w.id, { meta: w.meta });
		}
	}
	const removed = removeStale(new Set(want.map((w) => w.id)));
	return { units: want.map((w) => w.id), tables: tables.length, dropped: plan.dropped.length, wired: wireDbDeps(ledger), removed, costUsd };
}

/**
 * Planned code units depend on the schema units of the tables their legacy code queries — read from the
 * index (index_queries: the tables each indexed query names), never from raw text: a quoted word after
 * "model" in a template (`v-model="countries"`) is no table use. Re-run after every inventory (which rewrites
 * deps). Returns how many code units got a DB dep.
 */
export function wireDbDeps(ledger: Ledger): number {
	const dbUnits = ledger.listUnits().filter((u) => isDbUnitKind(u.kind) && u.kind !== "db_data");
	const ofTable = new Map<string, string>();
	for (const u of dbUnits) for (const t of (JSON.parse(u.meta) as DbUnitMeta).tables ?? []) ofTable.set(t.toLowerCase(), u.id);
	const allTables = dbUnits.length === 1 && !ofTable.size ? dbUnits[0]!.id : undefined; // schema without parsed tables: one unit holds it all
	// tables per legacy file, from the indexed queries (a query belongs to a symbol `path::…` or to the file itself)
	const tablesOf = new Map<string, Set<string>>();
	for (const q of ledger.db.prepare("SELECT symbol_id, tables FROM index_queries").all() as Array<{ symbol_id: string; tables: string }>) {
		const path = q.symbol_id.split("::")[0]!;
		const set = tablesOf.get(path) ?? tablesOf.set(path, new Set()).get(path)!;
		for (const t of JSON.parse(q.tables) as string[]) set.add(t.toLowerCase());
	}
	let wired = 0;
	for (const u of ledger.listUnits({ state: "planned" })) {
		if (isDbUnitKind(u.kind)) continue;
		const meta = JSON.parse(u.meta) as { files?: string[]; queries?: number; route?: { needs_db?: number } };
		const deps = (JSON.parse(u.deps) as string[]).filter((d) => !d.startsWith(DB_UNIT_PREFIX));
		const add = new Set<string>();
		if (allTables && ((meta.queries ?? 0) > 0 || (meta.route?.needs_db ?? 0) >= 0.5)) add.add(allTables);
		else if (ofTable.size)
			for (const f of meta.files ?? [])
				for (const t of tablesOf.get(f) ?? []) {
					const id = ofTable.get(t);
					if (id) add.add(id);
				}
		const next = [...deps, ...[...add].sort()];
		if (JSON.stringify(next) !== u.deps) ledger.db.prepare("UPDATE units SET deps = ? WHERE id = ?").run(JSON.stringify(next), u.id);
		if (add.size) wired++;
	}
	return wired;
}

/** The schema text a DB unit works from: its tables' DDL, else the small raw schema inputs (truncated). */
export async function schemaTextFor(config: Config, tables: string[], budget = 30_000): Promise<string> {
	const all = await readSchema(config);
	const want = new Set(tables.map((t) => t.toLowerCase()));
	const picked = want.size ? all.filter((t) => want.has(t.name.toLowerCase())) : all;
	let out = picked.map((t) => `-- ${t.name} (${t.from})\n${t.ddl}`).join("\n\n");
	if (!out) {
		for (const f of schemaPaths(config)) {
			if (out.length >= budget) break;
			if (SQLITE_EXT.has(extname(f).toLowerCase()) || statSync(f).size > 2_000_000) continue; // never read a dump whole
			try {
				out += `\n-- ${relative(config.source.path, f)}\n${readFileSync(f, "utf8").slice(0, budget - out.length)}`;
			} catch {
				/* unreadable */
			}
		}
	}
	return out.length > budget ? `${out.slice(0, budget)}\n-- … truncated` : out;
}
