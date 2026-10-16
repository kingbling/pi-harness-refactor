import { existsSync, mkdirSync, renameSync } from "node:fs";
import { appendFile, readdir, readFile, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import pc from "picocolors";
import { Type } from "typebox";
import type { Config } from "../config.ts";
import type { Ledger } from "../ledger/db.ts";
import { mainBranch, withRepoLock } from "../git.ts";
import { exec } from "../proc.ts";

/**
 * The cleaner: removes what this workspace made and no longer needs (left-over worktrees and branches, old ledger
 * backups, old transcripts, stopped Docker containers and unused volumes and databases it made).
 *
 * Ownership is the hard rule. Docker and the target repo on this machine are shared with other projects and other
 * workspaces, so nothing is removed on looks: only what code can prove is this workspace's —
 *  - a path inside <root>/.bigrefactor (or the old copy `br init` fresh start left as <root>/.bigrefactor.old-*);
 *  - a worktree folder inside <root>/.bigrefactor/worktrees; a branch whose git config record
 *    (branch.<name>.bigrefactorWorktree, written by addWorktree) points inside it, and only once merged into main;
 *  - a Docker container whose compose working_dir is inside <root>/.bigrefactor, or with the label
 *    bigrefactor.root=<root>, or recorded in owned.jsonl (by record_owned, matched by its Id);
 *  - a volume with that label, or recorded: by record_owned, or by the cleaner before it removes our container,
 *    and then only a volume of that container's own compose project made with it (never one that existed before);
 *  - a database that record_owned itself created (it refuses one that already existed).
 * Anything else, however unused it looks, is never touched. Docker things younger than a day are left alone (a
 * setup model may still be building them), and Docker is not looked at while a setup model runs in this process.
 */

/** Runs a command and resolves with its stdout (tests pass a fake). */
export type Runner = (cmd: string, args: string[], opts?: { cwd?: string; timeout?: number; maxBuffer?: number }) => Promise<string>;
const realRunner: Runner = (cmd, args, opts) => exec(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: 120_000, ...opts });

export interface CleanItem {
	kind: "worktree" | "trash" | "branch" | "backup" | "old copy" | "transcripts" | "container" | "volume" | "database";
	name: string;
	/** why code knows it is this workspace's */
	ours: string;
	/** why nothing needs it any more */
	unneeded: string;
	bytes?: number;
	remove: () => Promise<void>;
}
export interface CleanPlan {
	remove: CleanItem[];
	/** things looked at and left alone, with why (not ours, or still needed) */
	kept: string[];
}

export interface CleanOptions {
	config: Config;
	root: string;
	ledger: Ledger;
	run?: Runner;
	/**
	 * Inside a live run: names of worktree folders its lanes use now (a unit id, or <id>-ahead). Its jobs' worktrees
	 * (__builder__, __code__, …) are always in use then: each job resets its own. Undefined: no run is live.
	 */
	inUse?: () => Set<string>;
	/** Another process's run is live (`br clean` while `br run` goes): worktrees and branches are not looked at. */
	otherRunLive?: boolean;
	/** Asked again right before each worktree or branch removal: another process's run started meanwhile. */
	otherRunNow?: () => boolean;
	now?: number;
	stopped?: () => boolean;
}

const DAY = 86_400_000;
/** A Docker thing (or a database record) younger than this is left alone: a setup model may still be building it. */
const MIN_DOCKER_AGE = DAY;
/** A compose volume counts as made with our container when it is at most this much older (compose makes volumes first). */
const VOLUME_BEFORE_CONTAINER = 10 * 60_000;
const DB_NAME = /^[A-Za-z0-9_]{1,63}$/;

/** Setup models (the parity setup model) running in this process now: Docker is not looked at meanwhile. */
let settingUp = 0;
export async function whileSettingUp<T>(fn: () => Promise<T>): Promise<T> {
	settingUp++;
	try {
		return await fn();
	} finally {
		settingUp--;
	}
}
/** Ledger backups are kept this long (the newest always). */
const BACKUP_DAYS = 3;
/** Transcripts of accepted units are kept this long. No code reads them back; people do, to debug a fresh unit. */
const TRANSCRIPT_DAYS = 7;

const inside = (child: string, parent: string) => {
	const c = resolve(child);
	const p = resolve(parent);
	return c.startsWith(p.endsWith(sep) ? p : p + sep);
};
export const ownedFile = (root: string) => join(root, ".bigrefactor", "owned.jsonl");

export interface OwnedRecord {
	kind: "container" | "volume" | "database";
	name: string;
	/** container: its Id (a later container with the same name is not ours) */
	id?: string;
	/** volume: its CreatedAt (a later volume with the same name is not ours) */
	created?: string;
	/** database: the container of the server holding it */
	server?: string;
	/** database: the server's kind; code builds the drop command from it (records without it are never dropped) */
	engine?: "postgres" | "mysql";
	why?: string;
	at: string;
	removed?: boolean;
}

/** The workspace's record of things it made outside its folder; a later `removed` line ends a record. */
export async function readOwned(root: string): Promise<OwnedRecord[]> {
	let text = "";
	try {
		text = await readFile(ownedFile(root), "utf8");
	} catch {
		return [];
	}
	const live = new Map<string, OwnedRecord>();
	for (const l of text.split("\n")) {
		try {
			const r = JSON.parse(l) as OwnedRecord;
			if (!["container", "volume", "database"].includes(r.kind)) continue; // an older kind no code proves by now
			const key = `${r.kind}:${r.name}`;
			if (r.removed) live.delete(key);
			else live.set(key, r);
		} catch {
			/* blank or torn line */
		}
	}
	return [...live.values()];
}
export async function recordOwned(root: string, r: Omit<OwnedRecord, "at">): Promise<void> {
	mkdirSync(join(root, ".bigrefactor"), { recursive: true });
	await appendFile(ownedFile(root), JSON.stringify({ ...r, at: new Date().toISOString() }) + "\n");
}

/**
 * The text of the workspace's setup records (app recipes, their scripts, the legacy runner, the config): a Docker
 * thing or a database they name is in use, even when nothing runs it right now. Logs are history, not use.
 */
async function recipeText(root: string): Promise<string> {
	const parts: string[] = [];
	const add = async (p: string) => {
		try {
			const s = await stat(p);
			if (s.isDirectory()) {
				for (const n of await readdir(p)) await add(join(p, n));
			} else if (s.size < 2_000_000 && !p.endsWith(".log")) parts.push(await readFile(p, "utf8"));
		} catch {
			/* gone */
		}
	};
	await add(join(root, ".bigrefactor", "parity"));
	await add(join(root, ".bigrefactor", "legacy-env.json"));
	await add(join(root, "bigrefactor.config.json"));
	return parts.join("\n");
}
/** Whole-name match: `ssp1copy` does not name `ssp1copy2`. */
const names = (text: string, name: string) => !!name && new RegExp(`(^|[^A-Za-z0-9_.-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_-])`).test(text);

async function sizeOf(o: CleanOptions, run: Runner, path: string): Promise<number | undefined> {
	if (o.stopped?.()) return undefined; // a stop does not wait for du
	try {
		return Number((await run("du", ["-sk", path])).split(/\s/)[0]) * 1024;
	} catch {
		return undefined;
	}
}
export const human = (b?: number) => (b === undefined ? "size unknown" : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
const pidAlive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e: any) {
		return e?.code === "EPERM";
	}
};

/** What the cleaner would remove now, and what it looked at and left. Changes nothing. */
export async function planCleanup(o: CleanOptions): Promise<CleanPlan> {
	const run = o.run ?? realRunner;
	const now = o.now ?? Date.now();
	const plan: CleanPlan = { remove: [], kept: [] };
	const state = join(o.root, ".bigrefactor");
	await planFiles(o, run, now, state, plan);
	if (o.stopped?.()) return plan;
	if (!o.otherRunLive) await planGit(o, run, state, plan);
	else plan.kept.push("worktrees and branches: another process's run is live (it cleans its own)");
	if (o.stopped?.()) return plan;
	if (settingUp) plan.kept.push("Docker and databases: a setup model is running now (it may be building them); looked at on a later pass");
	else await planDocker(o, run, now, plan);
	return plan;
}

async function planFiles(o: CleanOptions, run: Runner, now: number, state: string, plan: CleanPlan): Promise<void> {
	// worktrees moved aside by a process that ended before deleting them
	const trash = join(state, "worktrees", ".trash");
	for (const n of existsSync(trash) ? (await readdir(trash)).filter((x) => !x.startsWith(".")) : []) {
		const pid = Number(/-(\d+)-\d+$/.exec(n)?.[1]);
		if (pid && pidAlive(pid)) continue; // that process is deleting it now
		const p = join(trash, n);
		plan.remove.push({ kind: "trash", name: p, ours: "inside .bigrefactor/worktrees/.trash", unneeded: "a removed worktree whose process ended before deleting it", bytes: await sizeOf(o, run, p), remove: () => rm(p, { recursive: true, force: true }) });
	}
	// ledger backups (ledger.<anything>.sqlite): the newest stays, the others go after a few days
	const all = existsSync(state) ? await readdir(state) : [];
	const backups: Array<{ n: string; m: number; size: number }> = [];
	for (const n of all) {
		if (!/^ledger\..+\.sqlite$/.test(n)) continue;
		const s = await stat(join(state, n));
		backups.push({ n, m: s.mtimeMs, size: s.size });
	}
	backups.sort((a, b) => b.m - a.m);
	for (const b of backups.slice(1)) {
		if (now - b.m < BACKUP_DAYS * DAY) continue;
		const p = join(state, b.n);
		plan.remove.push({ kind: "backup", name: p, ours: "a ledger copy inside .bigrefactor", unneeded: `older than ${BACKUP_DAYS} days and a newer backup exists; no code reads backups`, bytes: b.size, remove: async () => { for (const x of [p, `${p}-wal`, `${p}-shm`]) await rm(x, { force: true }); } });
	}
	// the old workspace a fresh start (`br init`) moved aside: its worktrees and app copy are dead (only adapters/ is read back)
	const rootEntries = existsSync(o.root) ? await readdir(o.root) : [];
	let listed = "";
	try {
		listed = await run("git", ["-C", o.config.target.path, "worktree", "list", "--porcelain"]);
	} catch {
		/* no repo */
	}
	for (const n of rootEntries.filter((x) => x.startsWith(".bigrefactor.old-"))) {
		for (const sub of ["worktrees", join("legacy-env", "app")]) {
			const p = join(o.root, n, sub);
			if (!existsSync(p)) continue;
			if (listed.split("\n").some((l) => l.startsWith("worktree ") && inside(l.slice(9), p))) {
				plan.kept.push(`${p}: git still lists a worktree in it`);
				continue;
			}
			plan.remove.push({ kind: "old copy", name: p, ours: "the former .bigrefactor of this workspace, moved aside by br init (fresh start)", unneeded: sub === "worktrees" ? "git lists none of these worktrees any more" : "a dead copy of the old app; the live one is .bigrefactor/legacy-env/app", bytes: await sizeOf(o, run, p), remove: () => rm(p, { recursive: true, force: true }) });
		}
	}
	// transcripts and check logs of units accepted a while ago: no code reads them back (br why reads the ledger)
	const sessions = join(state, "sessions");
	if (existsSync(sessions)) {
		const accepted = new Set((o.ledger.db.prepare("SELECT id FROM units WHERE state = 'accepted'").all() as Array<{ id: string }>).map((r) => r.id));
		const entries = await readdir(sessions);
		const old: Array<{ p: string; size: number }> = [];
		for (let i = 0; i < entries.length; i += 200) {
			if (o.stopped?.()) return;
			await Promise.all(
				entries.slice(i, i + 200).map(async (n) => {
					const unit = n.split(".")[0]!;
					if (!accepted.has(unit)) return;
					const p = join(sessions, n);
					try {
						const s = await stat(p);
						if (now - s.mtimeMs < TRANSCRIPT_DAYS * DAY) return;
						old.push({ p, size: s.isDirectory() ? ((await sizeOf(o, run, p)) ?? 0) : s.size });
					} catch {
						/* gone */
					}
				}),
			);
		}
		if (old.length)
			plan.remove.push({
				kind: "transcripts",
				name: `${old.length} transcript(s)/log(s) in .bigrefactor/sessions`,
				ours: "inside .bigrefactor/sessions",
				unneeded: `their units are accepted and they are older than ${TRANSCRIPT_DAYS} days; no code reads transcripts back`,
				bytes: old.reduce((a, x) => a + x.size, 0),
				remove: async () => {
					for (let i = 0; i < old.length; i += 100) await Promise.all(old.slice(i, i + 100).map((x) => rm(x.p, { recursive: true, force: true })));
				},
			});
	}
}

async function planGit(o: CleanOptions, run: Runner, state: string, plan: CleanPlan): Promise<void> {
	const repo = o.config.target.path;
	const git = (args: string[]) => run("git", ["-C", repo, ...args]);
	let listed: string;
	try {
		listed = await git(["worktree", "list", "--porcelain"]);
	} catch {
		return; // no target repo yet
	}
	const checkedOutIn = (text: string) => new Set([...text.matchAll(/^branch refs\/heads\/(.+)$/gm)].map((m) => m[1]!));
	const checkedOut = checkedOutIn(listed);
	const wtDir = join(state, "worktrees");
	// a job's worktree (__builder__, __code__, __tidy__, __parity__) is reset by that job on its next use and swept at a
	// run's start; jobs also run outside a run (br parity, br recheck), so the cleaner leaves them alone
	const busy = (n: string) => n.startsWith("__") || !!o.inUse?.().has(n) || !!o.otherRunNow?.();
	// unit worktree folders: in a live run, the ones no lane uses (left by a crash); with no run live, all (as the run's start sweep)
	for (const n of existsSync(wtDir) ? (await readdir(wtDir)).filter((x) => !x.startsWith(".")) : []) {
		if (busy(n)) {
			plan.kept.push(`worktree ${n}: ${n.startsWith("__") ? "a job's worktree (the job resets it itself)" : o.otherRunNow?.() ? "another process's run is live" : "in use by the run"}`);
			continue;
		}
		const p = join(wtDir, n);
		plan.remove.push({
			kind: "worktree",
			name: p,
			ours: "a worktree folder inside .bigrefactor/worktrees",
			unneeded: o.inUse ? "no lane or job of the live run uses it" : "no run is live; a unit's next lane starts from a fresh worktree (its kept code is on its branch)",
			bytes: await sizeOf(o, run, p),
			remove: async () => {
				// moved aside and forgotten by git under the lock (checked again right before, in the same tick: a lane starting
				// now finds no folder and makes its own); the files are deleted after the lock is released, so lanes never wait on it
				const t = await withRepoLock(repo, async () => {
					if (busy(n) || !existsSync(p)) return undefined;
					const t = join(wtDir, ".trash", `${n}-${process.pid}-${Date.now()}`);
					mkdirSync(join(wtDir, ".trash"), { recursive: true });
					renameSync(p, t);
					await git(["worktree", "prune"]).catch(() => undefined);
					return t;
				});
				if (t) await rm(t, { recursive: true, force: true });
			},
		});
	}
	// branches: only the ones this workspace's addWorktree made (git config branch.<name>.bigrefactorWorktree points into
	// its worktrees folder; another workspace on the same repo writes its own folder there), once all their commits are on
	// main, and never while they hold a unit's kept code. The same unit ids exist in every workspace of a repo: a name is no proof.
	const main = await mainBranch(repo, o.config.target.git.branch);
	const made = new Map<string, string>();
	for (const l of (await git(["config", "--get-regexp", "^branch\\..*\\.bigrefactorworktree$"]).catch(() => "")).split("\n").filter(Boolean)) {
		const m = /^branch\.(.+)\.bigrefactorworktree (.+)$/i.exec(l);
		if (m) made.set(m[1]!, m[2]!);
	}
	const heads = new Map<string, string>();
	for (const l of (await git(["for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/heads/"])).split("\n").filter(Boolean)) {
		const [b, sha] = l.split("\t");
		heads.set(b!, sha!);
	}
	const merged = new Set((await git(["branch", "--format=%(refname:short)", "--merged", main]).catch(() => "")).split("\n").map((x) => x.trim()).filter(Boolean));
	const keptOf = (id: string) => (o.ledger.db.prepare("SELECT json_extract(meta, '$.keptWork') AS kept FROM units WHERE id = ?").get(id) as { kept: string | null } | undefined)?.kept ?? undefined;
	const allKept = () => new Set((o.ledger.db.prepare("SELECT json_extract(meta, '$.keptWork') AS kept FROM units").all() as Array<{ kept: string | null }>).map((u) => u.kept).filter((x): x is string => !!x));
	const keptShas = allKept();
	/** Why a branch must stay now (asked at planning and again under the lock right before its removal). */
	const holds = (b: string, sha: string, checked: Set<string>, kept: Set<string>) => {
		const id = /^(unit|ahead)\//.test(b) ? b.split("/").slice(1).join("/") : undefined;
		return checked.has(b) ? "checked out in a worktree"
			: kept.has(sha) || (id && keptOf(id)) ? "holds a unit's kept code (a self-heal or answer goes on from it)"
			: id && o.inUse?.().has(id) ? "its unit's lane runs"
			: o.otherRunNow?.() ? "another process's run is live"
			: undefined;
	};
	let others = 0;
	for (const [b, sha] of heads) {
		if (b === main) continue;
		const wt = made.get(b);
		if (!wt || !inside(wt, wtDir)) {
			if (wt) others++;
			continue; // not made by this workspace: never looked at
		}
		const why = holds(b, sha, checkedOut, keptShas);
		if (why) {
			plan.kept.push(`branch ${b}: ${why}`);
			continue;
		}
		if (!merged.has(b)) {
			plan.kept.push(`branch ${b}: not merged into ${main}`);
			continue;
		}
		plan.remove.push({
			kind: "branch",
			name: b,
			ours: `made by this workspace's worktree ${wt} (git config branch.${b}.bigrefactorWorktree)`,
			unneeded: `all its commits are on ${main}; no worktree uses it`,
			bytes: 0,
			remove: () =>
				withRepoLock(repo, async () => {
					// asked again now: a lane may have taken it, kept code on it or moved it since the plan was made
					const why = holds(b, sha, checkedOutIn(await git(["worktree", "list", "--porcelain"])), allKept());
					if (why) throw new Error(`left: ${why}`);
					// deleted only while it still points where it pointed when it was found merged (git checks that itself)
					await git(["update-ref", "-d", `refs/heads/${b}`, sha]);
					await git(["config", "--remove-section", `branch.${b}`]).catch(() => undefined);
				}),
		});
	}
	if (others) plan.kept.push(`${others} branch(es) made by another workspace on this repo: never touched`);
}

interface DockerContainer {
	Id: string;
	Name: string;
	Created?: string;
	State: { Status: string; Running: boolean };
	Config: { Labels: Record<string, string> | null; Env?: string[] | null };
	Mounts: Array<{ Type: string; Name?: string }>;
}
interface DockerVolume {
	Name: string;
	CreatedAt?: string;
	Labels: Record<string, string> | null;
}

/** The kind of database server a container runs, from the variables its official image sets, and how code talks to it. */
function dbServer(env: string[]): { engine: "postgres" | "mysql"; sql: (server: string, statement: string) => string[]; own: string[] } | undefined {
	const v = (k: string) => env.find((e) => e.startsWith(`${k}=`))?.slice(k.length + 1);
	const own = env.filter((e) => /^(POSTGRES_DB|POSTGRES_USER|MYSQL_DATABASE|MARIADB_DATABASE)=/.test(e)).map((e) => e.split("=")[1]!);
	if (env.some((e) => /^(PG_VERSION|POSTGRES_[A-Z_]+)=/.test(e))) {
		const user = v("POSTGRES_USER") || "postgres";
		const maint = v("POSTGRES_DB") || user;
		return { engine: "postgres", own: [...own, "postgres", "template0", "template1"], sql: (server, st) => ["docker", "exec", server, "psql", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", maint, "-c", st] };
	}
	if (env.some((e) => /^(MYSQL|MARIADB)_[A-Z_]+=/.test(e)))
		return {
			engine: "mysql",
			own: [...own, "mysql", "information_schema", "performance_schema", "sys"],
			sql: (server, st) => ["docker", "exec", server, "sh", "-c", `exec "$(command -v mariadb || command -v mysql)" -uroot -p"\${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}" -e '${st}'`],
		};
	return undefined;
}
const quoteDb = (engine: "postgres" | "mysql", name: string) => (engine === "postgres" ? `"${name}"` : `\`${name}\``);

async function planDocker(o: CleanOptions, run: Runner, now: number, plan: CleanPlan): Promise<void> {
	let containers: DockerContainer[] = [];
	let volumes: DockerVolume[] = [];
	try {
		const ids = (await run("docker", ["ps", "-a", "-q", "--no-trunc"])).split("\n").filter(Boolean);
		if (ids.length) containers = JSON.parse(await run("docker", ["inspect", ...ids])) as DockerContainer[];
		const vols = (await run("docker", ["volume", "ls", "-q"])).split("\n").filter(Boolean);
		if (vols.length) volumes = JSON.parse(await run("docker", ["volume", "inspect", ...vols])) as DockerVolume[];
	} catch {
		return; // no docker here, or it is down: nothing to look at
	}
	const root = resolve(o.root);
	const state = join(root, ".bigrefactor");
	const records = await readOwned(o.root);
	const containerRecord = (c: DockerContainer) => records.find((r) => r.kind === "container" && r.name === cname(c) && (!r.id || r.id === c.Id));
	const volumeRecord = (v: DockerVolume) => records.find((r) => r.kind === "volume" && r.name === v.Name && (!r.created || r.created === v.CreatedAt));
	const labels = (x: { Config?: { Labels: Record<string, string> | null }; Labels?: Record<string, string> | null }) => (x.Config ? x.Config.Labels : x.Labels) ?? {};
	const cname = (c: DockerContainer) => c.Name.replace(/^\//, "");
	const project = (l: Record<string, string>) => l["com.docker.compose.project"];
	const time = (t?: string) => (t ? Date.parse(t) : NaN);
	// unknown age counts as young: left alone
	const young = (t?: string) => !(now - time(t) >= MIN_DOCKER_AGE);
	const ownProof = (c: DockerContainer): string | undefined => {
		const l = labels(c);
		if (l["bigrefactor.root"] === root) return `label bigrefactor.root=${root}`;
		const wd = l["com.docker.compose.project.working_dir"];
		if (wd && inside(wd, state)) return `its compose working_dir ${wd} is inside .bigrefactor`;
		if (containerRecord(c)) return "recorded in .bigrefactor/owned.jsonl when it was made";
		return undefined;
	};
	// the live legacy copy and the parity worktree are started by path from their recipes (compose files there, a
	// network, a hostname): a container whose compose files are there is in use while that folder exists
	const startedByPath = (wd?: string) => !!wd && [join(state, "legacy-env", "app"), join(state, "worktrees", "__parity__")].some((d) => (wd === d || inside(wd, d)) && existsSync(wd));
	const text = await recipeText(o.root);
	const named = (...xs: Array<string | undefined>) => xs.find((x) => x && names(text, x));
	const volumeByName = new Map(volumes.map((v) => [v.Name, v]));
	const retire = (r: OwnedRecord) => appendFile(ownedFile(o.root), JSON.stringify({ kind: r.kind, name: r.name, removed: true, at: new Date().toISOString() }) + "\n");
	let notOurs = 0;

	for (const c of containers) {
		const proof = ownProof(c);
		if (!proof) {
			notOurs++;
			continue;
		}
		const n = cname(c);
		const l = labels(c);
		const wd = l["com.docker.compose.project.working_dir"];
		const use =
			c.State.Running || !["exited", "created", "dead"].includes(c.State.Status) ? `it is ${c.State.Status}`
			: young(c.Created) ? "made less than a day ago (a setup model may still be building it)"
			: startedByPath(wd) ? `its compose files (${wd}) are in the live legacy copy or parity worktree, which its recipes start by path`
			: named(n, project(l)) ? `the workspace's setup names ${named(n, project(l))}`
			: undefined;
		if (use) {
			plan.kept.push(`container ${n}: ${use}`);
			continue;
		}
		// its named volumes are proven ours only through it, so they are written down before it goes — but only a volume
		// of its own compose project made with it: a volume it borrowed (external, another project's, older than it) is not
		const record: DockerVolume[] = [];
		for (const name of c.Mounts.filter((m) => m.Type === "volume" && m.Name).map((m) => m.Name!)) {
			const v = volumeByName.get(name);
			if (!v || labels(v)["bigrefactor.root"] === root || volumeRecord(v)) continue;
			const vp = project(labels(v));
			if (vp && vp === project(l) && time(v.CreatedAt) >= time(c.Created) - VOLUME_BEFORE_CONTAINER) record.push(v);
			else plan.kept.push(`volume ${name}: mounted by our container ${n} but not made with it (${vp ? (vp === project(l) ? "it existed before the container" : `of compose project ${vp}`) : "no compose project label"}): not recorded as ours`);
		}
		plan.remove.push({
			kind: "container",
			name: n,
			ours: proof,
			unneeded: "stopped for more than a day, and no app recipe or setup script of this workspace names it",
			remove: async () => {
				for (const v of record) await recordOwned(o.root, { kind: "volume", name: v.Name, created: v.CreatedAt, why: `made with our container ${n} (compose project ${project(l)})` });
				await run("docker", ["rm", "-v", c.Id]);
				// the record ends with it: a later container with this name is not ours
				const r = containerRecord(c);
				if (r) await retire(r);
			},
		});
	}

	const mounted = new Set(containers.flatMap((c) => c.Mounts.filter((m) => m.Type === "volume" && m.Name).map((m) => m.Name!)));
	let sizes: Map<string, number> | undefined;
	const volSize = async (n: string) => {
		if (!sizes) {
			sizes = new Map();
			try {
				for (const l of (await run("docker", ["system", "df", "-v", "--format", "{{range .Volumes}}{{.Name}}\t{{.Size}}\n{{end}}"])).split("\n")) {
					const [name, s] = l.split("\t");
					const m = /^([\d.]+)\s*([kMGT]?B)$/.exec(s?.trim() ?? "");
					if (name && m) sizes.set(name, Number(m[1]) * ({ B: 1, kB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 } as Record<string, number>)[m[2]!]!);
				}
			} catch {
				/* sizes unknown */
			}
		}
		return sizes.get(n);
	};
	// volumes only by our label or by a record of that very volume (a compose project name is no proof: names repeat)
	for (const v of volumes) {
		const l = labels(v);
		const r = volumeRecord(v);
		const proof = l["bigrefactor.root"] === root ? `label bigrefactor.root=${root}` : r ? "recorded in .bigrefactor/owned.jsonl" : undefined;
		if (!proof) {
			notOurs++;
			continue;
		}
		const use =
			mounted.has(v.Name) ? "a container uses it"
			: young(v.CreatedAt) ? "made less than a day ago (a setup model may still be building it)"
			: named(v.Name, project(l)) ? `the workspace's setup names ${named(v.Name, project(l))}`
			: undefined;
		if (use) {
			plan.kept.push(`volume ${v.Name}: ${use}`);
			continue;
		}
		plan.remove.push({
			kind: "volume",
			name: v.Name,
			ours: proof,
			unneeded: "no container uses it and no app recipe or setup script names it",
			bytes: await volSize(v.Name),
			remove: async () => {
				await run("docker", ["volume", "rm", v.Name]);
				if (r) await retire(r);
			},
		});
	}

	// databases only by a record of one record_owned created itself; the drop command is built by code here
	const running = new Set(containers.filter((c) => c.State.Running).map(cname));
	for (const r of records.filter((x) => x.kind === "database")) {
		const server = containers.find((c) => cname(c) === r.server);
		const db = dbServer(server?.Config.Env ?? []);
		const use =
			!r.engine ? "recorded before code created databases itself (no proof it made it)"
			: !DB_NAME.test(r.name) ? "its name is not a plain database name"
			: !r.server || !running.has(r.server) || !db ? `its server ${r.server ?? "?"} is not running (never started by the cleaner)`
			: db.engine !== r.engine ? `its server ${r.server} is no ${r.engine} server now`
			: db.own.includes(r.name) ? "it is its server's own database (never ours)"
			: young(r.at) ? "made less than a day ago (a setup model may still be using it)"
			: named(r.name) ? "the workspace's setup names it"
			: undefined;
		if (use) {
			plan.kept.push(`database ${r.name}: ${use}`);
			continue;
		}
		const drop = db!.sql(r.server!, `DROP DATABASE ${quoteDb(r.engine!, r.name)}`);
		plan.remove.push({
			kind: "database",
			name: `${r.name} (in ${r.server})`,
			ours: "created by record_owned (it refuses a database that already existed)",
			unneeded: "no app recipe or setup script names it any more",
			remove: async () => {
				await run(drop[0]!, drop.slice(1));
				await retire(r);
			},
		});
	}
	if (notOurs) plan.kept.push(`${notOurs} Docker container(s)/volume(s) are not provably this workspace's: never touched`);
}

/**
 * One pass: plan, then (when `apply`) remove each item, writing every removal to .bigrefactor/cleanup.log
 * (what, why it is ours, why it is not needed, bytes freed). A failing item is said and skipped.
 */
export async function cleanOnce(o: CleanOptions & { apply: boolean; log?: (l: string) => void }): Promise<{ plan: CleanPlan; removed: CleanItem[]; freed: number }> {
	const plan = await planCleanup(o);
	const removed: CleanItem[] = [];
	let freed = 0;
	if (!o.apply) return { plan, removed, freed };
	const logFile = join(o.root, ".bigrefactor", "cleanup.log");
	for (const it of plan.remove) {
		if (o.stopped?.()) break;
		try {
			await it.remove();
		} catch (e: any) {
			o.log?.(pc.yellow(`cleanup: could not remove ${it.kind} ${it.name}: ${String(e?.message ?? e).split("\n")[0]}`));
			continue;
		}
		removed.push(it);
		freed += it.bytes ?? 0;
		await appendFile(logFile, `${new Date().toISOString()} removed ${it.kind} ${it.name} | ours: ${it.ours} | not needed: ${it.unneeded} | freed ${human(it.bytes)}\n`).catch(() => undefined);
	}
	return { plan, removed, freed };
}

/** The plan as lines for `br clean`. */
export function renderPlan(plan: CleanPlan, applied?: { removed: CleanItem[]; freed: number }): string[] {
	const lines = plan.remove.map((it) => `${applied ? (applied.removed.includes(it) ? "removed" : "FAILED ") : "would remove"} ${it.kind} ${it.name} (${human(it.bytes)})\n    ours: ${it.ours}\n    not needed: ${it.unneeded}`);
	if (!plan.remove.length) lines.push("nothing to remove");
	const total = plan.remove.reduce((a, x) => a + (x.bytes ?? 0), 0);
	lines.push(applied ? `freed about ${human(applied.freed)} (logged in .bigrefactor/cleanup.log)` : plan.remove.length ? `about ${human(total)} in all; br clean --yes removes it` : "");
	if (plan.kept.length) lines.push("", "left alone:", ...plan.kept.map((k) => `  ${k}`));
	return lines.filter((l, i) => l || i > 0);
}

/**
 * The run's cleaner on the side: once soon after the start, then every run.cleanEveryMinutes (0 = off). One pass at
 * a time; a stop ends it between items and no pass starts after.
 */
export function createCleaner(o: CleanOptions & { everyMinutes: number; log: (l: string) => void; firstAfterMs?: number }): { tick(): void; stop(): Promise<void>; idle(): Promise<void> } {
	let stopped = false;
	let running: Promise<void> | undefined;
	const every = o.everyMinutes * 60_000;
	let next = Date.now() + (o.firstAfterMs ?? 60_000);
	return {
		tick() {
			if (stopped || running || !every || Date.now() < next) return;
			running = cleanOnce({ ...o, apply: true, stopped: () => stopped })
				.then((r) => {
					if (r.removed.length) o.log(pc.dim(`cleanup: removed ${r.removed.length} item(s) (${[...new Set(r.removed.map((x) => x.kind))].join(", ")}), freed about ${human(r.freed)}; see .bigrefactor/cleanup.log`));
				})
				.catch((e) => o.log(pc.yellow(`cleanup failed: ${e?.message ?? e}`)))
				.finally(() => {
					running = undefined;
					next = Date.now() + every;
				});
		},
		async stop() {
			stopped = true;
			await running;
		},
		async idle() {
			await running;
		},
	};
}

/**
 * record_owned's work: checks a setup model's record (the thing exists, nothing marks it as another project's) and
 * writes it. A database is created here by code (CREATE DATABASE fails when it already exists), so a database that
 * was there before is never recorded. Returns what happened, starting with "refused:" when nothing was written.
 */
export async function recordOwnedChecked(root: string, r: { kind: string; name: string; server?: string; why?: string }, run: Runner = realRunner): Promise<string> {
	const inspect = async (args: string[]) => {
		try {
			return (JSON.parse(await run("docker", args)) as any[])[0];
		} catch {
			return undefined;
		}
	};
	const foreign = (l: Record<string, string> | null | undefined) => {
		const own = l?.["bigrefactor.root"];
		if (own && own !== resolve(root)) return `it carries bigrefactor.root=${own}: another workspace's`;
		const wd = l?.["com.docker.compose.project.working_dir"];
		if (wd && !inside(wd, join(root, ".bigrefactor"))) return `it belongs to the compose project in ${wd}, not to this workspace`;
		return undefined;
	};
	const refused = (why: string) => `refused: ${why}`;
	if (r.kind === "container") {
		const c = await inspect(["inspect", r.name]);
		if (!c) return refused(`no container ${r.name}`);
		const bad = foreign(c.Config?.Labels);
		if (bad) return refused(bad);
		await recordOwned(root, { kind: "container", name: r.name, id: c.Id, why: r.why });
		return `recorded container ${r.name}`;
	}
	if (r.kind === "volume") {
		const v = await inspect(["volume", "inspect", r.name]);
		if (!v) return refused(`no volume ${r.name}`);
		// a compose volume may be another project's with the same project name: it is labelled in the compose file instead
		if (v.Labels?.["com.docker.compose.project"]) return refused(`it is a compose volume of project ${v.Labels["com.docker.compose.project"]}: label it in the compose file instead (labels: bigrefactor.root)`);
		const bad = foreign(v.Labels);
		if (bad) return refused(bad);
		await recordOwned(root, { kind: "volume", name: r.name, created: v.CreatedAt, why: r.why });
		return `recorded volume ${r.name}`;
	}
	if (r.kind === "database") {
		if (!r.server) return refused("say which container holds the database (server)");
		if (!DB_NAME.test(r.name)) return refused("use a plain database name (letters, digits, _)");
		const c = await inspect(["inspect", r.server]);
		if (!c?.State?.Running) return refused(`no running container ${r.server}`);
		const db = dbServer((c.Config?.Env ?? []) as string[]);
		if (!db) return refused(`${r.server} is no Postgres or MySQL/MariaDB server this tool knows: start your own labelled container instead`);
		if (db.own.includes(r.name)) return refused(`${r.name} is the server's own database, not one you made`);
		const create = db.sql(r.server, `CREATE DATABASE ${quoteDb(db.engine, r.name)}`);
		try {
			await run(create[0]!, create.slice(1));
		} catch (e: any) {
			return refused(`could not create ${r.name} (a database that already exists is never recorded): ${String(e?.message ?? e).split("\n")[0]}`);
		}
		await recordOwned(root, { kind: "database", name: r.name, server: r.server, engine: db.engine, why: r.why });
		return `created database ${r.name} in ${r.server} and recorded it`;
	}
	return refused(`unknown kind ${r.kind}`);
}

/** Tool for setup models: write down a Docker thing they made, or create a database and write it down, so the cleaner may later remove it. */
export function recordOwnedTool(root: string): ToolDefinition {
	return {
		name: "record_owned",
		label: "Record what you made",
		description: `Write down a Docker container or volume YOU made in this session (never one that was there before), so the workspace can remove it once no recipe names it any more. Better than a record: put the label bigrefactor.root=${resolve(root)} on every container and volume you create (docker run --label, docker volume create --label, labels: in a compose file). A database inside a server you did not start has no label: do not create it yourself; call this with kind database, its name and the server container, and the tool creates it (it refuses a name that already exists).`,
		promptSnippet: "record_owned: write down a container or volume you made, or create a database in a running server",
		parameters: Type.Object({
			kind: Type.Union([Type.Literal("container"), Type.Literal("volume"), Type.Literal("database")]),
			name: Type.String(),
			server: Type.Optional(Type.String({ description: "database only: the container of the running Postgres or MySQL/MariaDB server" })),
			why: Type.Optional(Type.String()),
		}),
		execute: async (_id: string, p: { kind: "container" | "volume" | "database"; name: string; server?: string; why?: string }) => {
			return { content: [{ type: "text" as const, text: await recordOwnedChecked(root, p) }], details: {} };
		},
	} as unknown as ToolDefinition;
}

/**
 * `br clean [--yes]` / `/br clean`: lists what would go; `apply` removes it. While a run is live it only lists
 * (the run cleans by itself; two cleaners would race), and leaves worktrees and branches to the run.
 */
export async function cleanCommand(o: { config: Config; root: string; ledger: Ledger; apply: boolean; log?: (l: string) => void; run?: Runner }): Promise<string[]> {
	const { liveRun } = await import("./run-lock.ts");
	const pid = liveRun(o.root);
	const live = pid !== undefined && pid !== process.pid;
	const note = live ? [`a run is going in this workspace (pid ${pid}): it removes these by itself every ${o.config.run.cleanEveryMinutes || "(off)"} minutes; nothing removed now`, ""] : [];
	// asked again before each worktree and branch removal: a run started while this one plans is seen
	const otherRunNow = () => {
		const p = liveRun(o.root);
		return p !== undefined && p !== process.pid;
	};
	const r = await cleanOnce({ ...o, otherRunLive: live, otherRunNow, apply: o.apply && !live });
	return [...note, ...renderPlan(r.plan, o.apply && !live ? r : undefined)];
}
