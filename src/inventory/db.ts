import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "../config.ts";
import type { Ledger } from "../ledger/db.ts";
import type { ModelClient } from "../models/types.ts";
import { TARGET_ROLES } from "../adapters/registry.ts";
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
 * schema that exists. DB units are created and wired by code (same schema → same units), never labelled
 * by a model; their placement is the server stack's area "db".
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
		}
		else if (!/^\s*alter\b/i.test(t.ddl)) tables.set(key, { ...t }); // an ALTER of a table no input creates is no table
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
				for (const r of db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL").all() as Array<{ name: string; sql: string }>) out.push({ name: r.name, ddl: `${r.sql};`, from: rel });
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
		for (const m of readFileSync(f, "utf8").matchAll(/^model\s+(\w+)\s*\{[\s\S]*?^\}/gm)) out.push({ name: m[1]!, ddl: m[0], from: rel });
		return out;
	}
	if (ext === ".sql" || size > 2_000_000) {
		await scanSqlDdl(f, size, (name, ddl) => out.push({ name, ddl, from: rel }), (pct) => log(`  reading ${basename(f)}: ${pct}% of ${(size / 1e9).toFixed(1)} GB (table definitions only)`));
		return out;
	}
	// migration code of common frameworks (Laravel, Phinx, Doctrine, Rails, Knex, Alembic) and small SQL-ish files
	const text = readFileSync(f, "utf8");
	await scanSqlText(text, (name, ddl) => out.push({ name, ddl, from: rel }));
	const seen = new Set(out.map((t) => t.name.toLowerCase()));
	for (const m of text.matchAll(/(?:Schema::create|createTable|create_table|table)\(\s*['":]?(\w+)['"]?/g)) {
		if (/^(if|function|array)$/i.test(m[1]!) || seen.has(m[1]!.toLowerCase())) continue;
		seen.add(m[1]!.toLowerCase());
		const start = m.index ?? 0;
		out.push({ name: m[1]!, ddl: text.slice(start, start + 1500), from: rel });
	}
	return out;
}

const IDENT = String.raw`[\x60"\[]?(?:\w+[\x60"\]]?\.[\x60"\[]?)?(\w+)[\x60"\]]?`;
const DDL_START = new RegExp(String.raw`^\s*(?:create\s+(?:temporary\s+)?table\s+(?:if\s+not\s+exists\s+)?|alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?)${IDENT}`, "i");

async function scanSqlText(text: string, emit: (table: string, ddl: string) => void): Promise<void> {
	let buf: string | undefined;
	let table = "";
	for (const line of text.split("\n")) {
		if (buf === undefined) {
			const m = DDL_START.exec(line);
			if (!m) continue;
			buf = "";
			table = m[1]!;
		}
		buf += `${line}\n`;
		if (/;\s*$/.test(line)) {
			emit(table, buf.trimEnd());
			buf = undefined;
		}
	}
}

/**
 * CREATE/ALTER TABLE statements of a SQL file of any size, read in 8 MB chunks. Lines outside a statement
 * (INSERTs of a data dump, often megabytes long) are never accumulated: only a line's first bytes are looked
 * at. Progress is reported every 10% for big files.
 */
async function scanSqlDdl(f: string, size: number, emit: (table: string, ddl: string) => void, onProgress: (pct: number) => void): Promise<void> {
	const fh = await open(f, "r");
	const chunk = Buffer.alloc(8 * 1024 * 1024);
	let pos = 0;
	let head = ""; // start of the current line (capped) while it is not known to be DDL
	let skipping = false; // current line is long and not DDL: ignore until its newline
	let buf: string | undefined; // current DDL statement
	let table = "";
	let lastPct = 0;
	const endLine = (line: string) => {
		if (buf === undefined) {
			const m = DDL_START.exec(line);
			if (!m) return;
			buf = "";
			table = m[1]!;
		}
		buf += `${line}\n`;
		if (/;\s*$/.test(line)) {
			emit(table, buf.trimEnd());
			buf = undefined;
		}
	};
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
					if (buf === undefined && head.length > 4096 && !DDL_START.test(head.slice(0, 4096))) {
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
 * schema units of the tables their SQL names. Idempotent. Units already started are never changed.
 */
export async function planDbLane(ledger: Ledger, config: Config): Promise<{ units: string[]; tables: number; wired: number; removed: string[] }> {
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
		return { units: [], tables: 0, wired: wireDbDeps(ledger, config), removed };
	}
	const tables = await readSchema(config);
	const refactor = config.db.strategy === "new-schema";
	const kind = refactor ? "db_design" : "db_schema";
	const place = { stack: dbStack(config), area: "db", shared: false, source: "code" };
	const route = { difficulty: "medium", needs_db: 1, has_ui: 0, by: "db lane" };
	const base = { lane: "db", strategy: config.db.strategy, from: config.db.from, to: config.db.to, place, route, files: [] as string[], loc: 0 };
	const want: Array<{ id: string; kind: string; deps: string[]; meta: Record<string, unknown> }> = [];
	const groups = tables.length ? groupTables(tables) : [{ name: "all", tables: [] as DbTable[] }];
	for (const g of groups) {
		want.push({ id: `${DB_UNIT_PREFIX}${refactor ? "design" : "schema"}_${g.name}`, kind, deps: [], meta: { ...base, group: g.name, tables: g.tables.map((t) => t.name), loc: g.tables.reduce((a, t) => a + t.ddl.split("\n").length, 0) } });
	}
	const engineChange = !!config.db.to && config.db.from.some((f) => f.toLowerCase() !== config.db.to!.toLowerCase());
	if (refactor || engineChange || config.db.snapshot) want.push({ id: `${DB_UNIT_PREFIX}data`, kind: "db_data", deps: want.map((w) => w.id), meta: { ...base, tables: tables.map((t) => t.name) } });
	for (const w of want) {
		const u = ledger.getUnit(w.id);
		if (!u) ledger.createUnit({ id: w.id, tier: "T0", kind: w.kind, deps: w.deps, meta: w.meta, symbolIds: [] });
		else if (u.state === "planned") {
			ledger.db.prepare("UPDATE units SET kind = ?, deps = ? WHERE id = ?").run(w.kind, JSON.stringify(w.deps), w.id);
			ledger.updateUnit(w.id, { meta: w.meta });
		}
	}
	const removed = removeStale(new Set(want.map((w) => w.id)));
	return { units: want.map((w) => w.id), tables: tables.length, wired: wireDbDeps(ledger, config), removed };
}

/**
 * Planned code units depend on the schema units of the tables their legacy SQL names (FROM/JOIN/INTO/
 * UPDATE/TABLE <name>, or the name as a quoted string next to an ORM call). Re-run after every inventory
 * (which rewrites deps). Returns how many code units got a DB dep.
 */
export function wireDbDeps(ledger: Ledger, config: Config): number {
	const dbUnits = ledger.listUnits().filter((u) => isDbUnitKind(u.kind) && u.kind !== "db_data");
	const ofTable = new Map<string, string>();
	for (const u of dbUnits) for (const t of (JSON.parse(u.meta) as DbUnitMeta).tables ?? []) ofTable.set(t.toLowerCase(), u.id);
	const allTables = dbUnits.length === 1 && !ofTable.size ? dbUnits[0]!.id : undefined; // schema without parsed tables: one unit holds it all
	let wired = 0;
	for (const u of ledger.listUnits({ state: "planned" })) {
		if (isDbUnitKind(u.kind)) continue;
		const meta = JSON.parse(u.meta) as { files?: string[]; queries?: number; route?: { needs_db?: number } };
		const deps = (JSON.parse(u.deps) as string[]).filter((d) => !d.startsWith(DB_UNIT_PREFIX));
		const add = new Set<string>();
		if (allTables && ((meta.queries ?? 0) > 0 || (meta.route?.needs_db ?? 0) >= 0.5)) add.add(allTables);
		else if (ofTable.size) {
			for (const f of meta.files ?? []) {
				let text: string;
				try {
					text = readFileSync(join(config.source.path, f), "utf8");
				} catch {
					continue;
				}
				for (const m of text.matchAll(/\b(?:from|join|into|update|table)\s+[`"[]?(\w+)/gi)) {
					const id = ofTable.get(m[1]!.toLowerCase());
					if (id) add.add(id);
				}
				for (const m of text.matchAll(/['"](\w+)['"]/g)) {
					const id = ofTable.get(m[1]!.toLowerCase());
					if (id && /table|query|repository|model|entity|getRepository|DB::/i.test(text.slice(Math.max(0, (m.index ?? 0) - 60), m.index))) add.add(id);
				}
			}
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
