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
 * Ownership is the hard rule. Docker on this machine is shared with other projects, so nothing is removed on looks:
 * only what code can prove is this workspace's —
 *  - a path inside <root>/.bigrefactor (or the old copy `br init` fresh start left as <root>/.bigrefactor.old-*);
 *  - a worktree of the target repo inside <root>/.bigrefactor/worktrees, a branch with the plugin's own naming;
 *  - a Docker container whose compose working_dir is inside <root>/.bigrefactor, or with the label
 *    bigrefactor.root=<root>, or recorded in owned.jsonl (written by code: the record_owned tool, or the cleaner
 *    itself before it removes a container whose volumes then lose their only proof);
 *  - a volume with that label, of a compose project all of whose containers are ours, or recorded;
 *  - a database recorded with record_owned.
 * Anything else, however unused it looks, is never touched.
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
	now?: number;
	stopped?: () => boolean;
}

/** Branch names the plugin gives (git.ts addWorktree callers: run.ts, builder.ts, code-job.ts, tidy-job.ts, parity.ts). */
const PLUGIN_BRANCH = /^(unit|ahead|builder|code|tidy|parity)\//;
const DAY = 86_400_000;
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
	kind: "container" | "volume" | "database" | "compose-project";
	name: string;
	/** database: the container of the server holding it */
	server?: string;
	/** database: the command that drops it (docker exec <server> …) */
	drop?: string[];
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

async function sizeOf(run: Runner, path: string): Promise<number | undefined> {
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
	if (!o.otherRunLive) await planGit(o, run, state, plan);
	else plan.kept.push("worktrees and branches: another process's run is live (it cleans its own)");
	await planDocker(o, run, plan);
	return plan;
}

async function planFiles(o: CleanOptions, run: Runner, now: number, state: string, plan: CleanPlan): Promise<void> {
	// worktrees moved aside by a process that ended before deleting them
	const trash = join(state, "worktrees", ".trash");
	for (const n of existsSync(trash) ? (await readdir(trash)).filter((x) => !x.startsWith(".")) : []) {
		const pid = Number(/-(\d+)-\d+$/.exec(n)?.[1]);
		if (pid && pidAlive(pid)) continue; // that process is deleting it now
		const p = join(trash, n);
		plan.remove.push({ kind: "trash", name: p, ours: "inside .bigrefactor/worktrees/.trash", unneeded: "a removed worktree whose process ended before deleting it", bytes: await sizeOf(run, p), remove: () => rm(p, { recursive: true, force: true }) });
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
			plan.remove.push({ kind: "old copy", name: p, ours: "the former .bigrefactor of this workspace, moved aside by br init (fresh start)", unneeded: sub === "worktrees" ? "git lists none of these worktrees any more" : "a dead copy of the old app; the live one is .bigrefactor/legacy-env/app", bytes: await sizeOf(run, p), remove: () => rm(p, { recursive: true, force: true }) });
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
						old.push({ p, size: s.isDirectory() ? ((await sizeOf(run, p)) ?? 0) : s.size });
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
	const checkedOut = new Set([...listed.matchAll(/^branch refs\/heads\/(.+)$/gm)].map((m) => m[1]!));
	const wtDir = join(state, "worktrees");
	// a job's worktree (__builder__, __code__, __tidy__, __parity__) is reset by that job on its next use and swept at a
	// run's start; jobs also run outside a run (br parity, br recheck), so the cleaner leaves them alone
	const busy = (n: string) => n.startsWith("__") || !!o.inUse?.().has(n);
	// unit worktree folders: in a live run, the ones no lane uses (left by a crash); with no run live, all (as the run's start sweep)
	for (const n of existsSync(wtDir) ? (await readdir(wtDir)).filter((x) => !x.startsWith(".")) : []) {
		if (busy(n)) {
			plan.kept.push(`worktree ${n}: ${n.startsWith("__") ? "a job's worktree (the job resets it itself)" : "in use by the run"}`);
			continue;
		}
		const p = join(wtDir, n);
		plan.remove.push({
			kind: "worktree",
			name: p,
			ours: "a worktree folder inside .bigrefactor/worktrees",
			unneeded: o.inUse ? "no lane or job of the live run uses it" : "no run is live; a unit's next lane starts from a fresh worktree (its kept code is on its branch)",
			bytes: await sizeOf(run, p),
			remove: () =>
				withRepoLock(repo, async () => {
					// checked again right before the move, in the same tick: a lane starting now finds no folder and makes its own
					if (busy(n) || !existsSync(p)) return;
					const t = join(wtDir, ".trash", `${n}-${process.pid}-${Date.now()}`);
					mkdirSync(join(wtDir, ".trash"), { recursive: true });
					renameSync(p, t);
					await git(["worktree", "prune"]).catch(() => undefined);
					await rm(t, { recursive: true, force: true });
				}),
		});
	}
	// branches the plugin made: gone once all their commits are on main (or their unit is accepted), unless kept code is on them
	const main = await mainBranch(repo, o.config.target.git.branch);
	const heads = new Map<string, string>();
	for (const l of (await git(["for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/heads/"])).split("\n").filter(Boolean)) {
		const [b, sha] = l.split("\t");
		heads.set(b!, sha!);
	}
	const merged = new Set((await git(["branch", "--format=%(refname:short)", "--merged", main]).catch(() => "")).split("\n").map((x) => x.trim()).filter(Boolean));
	const units = new Map((o.ledger.db.prepare("SELECT id, state, json_extract(meta, '$.keptWork') AS kept FROM units").all() as Array<{ id: string; state: string; kept: string | null }>).map((u) => [u.id, u]));
	const keptShas = new Set([...units.values()].map((u) => u.kept).filter((x): x is string => !!x));
	for (const [b, sha] of heads) {
		if (!PLUGIN_BRANCH.test(b) || b === main) continue;
		const id = b.split("/").slice(1).join("/");
		const unit = /^(unit|ahead)\//.test(b) ? units.get(id) : undefined;
		const why =
			checkedOut.has(b) ? "checked out in a worktree"
			: keptShas.has(sha) || unit?.kept ? "holds a unit's kept code (a self-heal or answer goes on from it)"
			: /^(unit|ahead)\//.test(b) && o.inUse?.().has(id) ? "its unit's lane runs"
			: undefined;
		if (why) {
			plan.kept.push(`branch ${b}: ${why}`);
			continue;
		}
		const done = merged.has(b) ? `all its commits are on ${main}` : b.startsWith("unit/") && unit?.state === "accepted" ? "its unit is accepted (merged)" : undefined;
		if (!done) {
			plan.kept.push(`branch ${b}: not merged into ${main}`);
			continue;
		}
		plan.remove.push({
			kind: "branch",
			name: b,
			ours: `in the target repo with the plugin's branch naming (${b.split("/")[0]}/)`,
			unneeded: `${done}; no worktree uses it`,
			bytes: 0,
			// git itself refuses to delete a branch checked out anywhere, so a lane that took it meanwhile keeps it
			remove: () => withRepoLock(repo, () => git(["branch", "-q", "-D", b]).then(() => undefined)),
		});
	}
}

interface DockerContainer {
	Id: string;
	Name: string;
	State: { Status: string; Running: boolean };
	Config: { Labels: Record<string, string> | null; Env?: string[] | null };
	Mounts: Array<{ Type: string; Name?: string }>;
}
interface DockerVolume {
	Name: string;
	Labels: Record<string, string> | null;
}

async function planDocker(o: CleanOptions, run: Runner, plan: CleanPlan): Promise<void> {
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
	const recorded = (kind: OwnedRecord["kind"], name: string) => records.some((r) => r.kind === kind && r.name === name);
	const labels = (x: { Config?: { Labels: Record<string, string> | null }; Labels?: Record<string, string> | null }) => (x.Config ? x.Config.Labels : x.Labels) ?? {};
	const cname = (c: DockerContainer) => c.Name.replace(/^\//, "");
	const project = (l: Record<string, string>) => l["com.docker.compose.project"];
	const ownProof = (c: DockerContainer): string | undefined => {
		const l = labels(c);
		if (l["bigrefactor.root"] === root) return `label bigrefactor.root=${root}`;
		const wd = l["com.docker.compose.project.working_dir"];
		if (wd && inside(wd, state)) return `its compose working_dir ${wd} is inside .bigrefactor`;
		if (recorded("container", cname(c))) return "recorded in .bigrefactor/owned.jsonl when it was made";
		return undefined;
	};
	// a compose project is ours when every container of it is ours (one other container: another project uses the name)
	const projects = new Map<string, boolean>();
	for (const c of containers) {
		const p = project(labels(c));
		if (p) projects.set(p, (projects.get(p) ?? true) && !!ownProof(c));
	}
	for (const r of records) if (r.kind === "compose-project" && !projects.has(r.name)) projects.set(r.name, true);
	const ownProject = (p?: string) => !!p && projects.get(p) === true;
	const text = await recipeText(o.root);
	const named = (...xs: Array<string | undefined>) => xs.find((x) => x && names(text, x));
	let notOurs = 0;

	for (const c of containers) {
		const proof = ownProof(c);
		if (!proof) {
			notOurs++;
			continue;
		}
		const n = cname(c);
		const l = labels(c);
		const use = c.State.Running || !["exited", "created", "dead"].includes(c.State.Status) ? `it is ${c.State.Status}` : named(n, project(l)) ? `the workspace's setup names ${named(n, project(l))}` : undefined;
		if (use) {
			plan.kept.push(`container ${n}: ${use}`);
			continue;
		}
		const vols = c.Mounts.filter((m) => m.Type === "volume" && m.Name).map((m) => m.Name!);
		plan.remove.push({
			kind: "container",
			name: n,
			ours: proof,
			unneeded: "stopped, and no app recipe or setup script of this workspace names it",
			remove: async () => {
				// its volumes are proven ours only through it: written down before it goes, so they stay provable
				for (const v of vols) if (!recorded("volume", v)) await recordOwned(o.root, { kind: "volume", name: v, why: `mounted by our container ${n}` });
				const p = project(l);
				if (p && !recorded("compose-project", p)) await recordOwned(o.root, { kind: "compose-project", name: p, why: `project of our container ${n}` });
				await run("docker", ["rm", "-v", c.Id]);
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
	for (const v of volumes) {
		const l = labels(v);
		const proof =
			l["bigrefactor.root"] === root ? `label bigrefactor.root=${root}`
			: recorded("volume", v.Name) ? "recorded in .bigrefactor/owned.jsonl"
			: ownProject(project(l)) ? `of compose project ${project(l)}, whose containers are all this workspace's`
			: undefined;
		if (!proof) {
			notOurs++;
			continue;
		}
		const use = mounted.has(v.Name) ? "a container uses it" : named(v.Name, project(l)) ? `the workspace's setup names ${named(v.Name, project(l))}` : undefined;
		if (use) {
			plan.kept.push(`volume ${v.Name}: ${use}`);
			continue;
		}
		plan.remove.push({ kind: "volume", name: v.Name, ours: proof, unneeded: "no container uses it and no app recipe or setup script names it", bytes: await volSize(v.Name), remove: () => run("docker", ["volume", "rm", v.Name]).then(() => undefined) });
	}

	// databases only by record (a database inside a shared server has no other proof)
	const running = new Set(containers.filter((c) => c.State.Running).map(cname));
	for (const r of records.filter((x) => x.kind === "database")) {
		const server = containers.find((c) => cname(c) === r.server);
		const serverOwn = (server?.Config.Env ?? []).some((e) => /^(POSTGRES_DB|POSTGRES_USER|MYSQL_DATABASE|MARIADB_DATABASE)=/.test(e) && e.split("=")[1] === r.name);
		const use = serverOwn ? "it is its server's own database (never ours)" : named(r.name) ? "the workspace's setup names it" : !r.server || !running.has(r.server) ? `its server ${r.server ?? "?"} is not running (never started by the cleaner)` : !r.drop?.length ? "no drop command was recorded" : undefined;
		if (use) {
			plan.kept.push(`database ${r.name}: ${use}`);
			continue;
		}
		plan.remove.push({
			kind: "database",
			name: `${r.name} (in ${r.server})`,
			ours: "recorded in .bigrefactor/owned.jsonl by record_owned when it was made",
			unneeded: "no app recipe or setup script names it any more",
			remove: async () => {
				await run(r.drop![0]!, r.drop!.slice(1));
				await appendFile(ownedFile(o.root), JSON.stringify({ kind: "database", name: r.name, removed: true, at: new Date().toISOString() }) + "\n");
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
 * Checks a setup model's record before it is written: the thing exists, and nothing marks it as another project's.
 * Returns why it is refused, or undefined.
 */
export async function recordProblem(root: string, r: { kind: string; name: string; server?: string; drop?: string[] }, run: Runner = realRunner): Promise<string | undefined> {
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
	if (r.kind === "container") {
		const c = await inspect(["inspect", r.name]);
		return !c ? `no container ${r.name}` : foreign(c.Config?.Labels);
	}
	if (r.kind === "volume") {
		const v = await inspect(["volume", "inspect", r.name]);
		if (!v) return `no volume ${r.name}`;
		// a compose volume is proven through its project's containers; a record would skip that check
		if (v.Labels?.["com.docker.compose.project"]) return `it is a compose volume of project ${v.Labels["com.docker.compose.project"]}: label it in the compose file instead (labels: bigrefactor.root)`;
		return foreign(v.Labels);
	}
	if (r.kind === "database") {
		if (!r.server) return "say which container holds the database (server)";
		const c = await inspect(["inspect", r.server]);
		if (!c?.State?.Running) return `no running container ${r.server}`;
		const d = r.drop ?? [];
		if (d[0] !== "docker" || d[1] !== "exec" || !d.includes(r.server) || !d.includes(r.name)) return `drop must be a docker exec command into ${r.server} that names ${r.name}, e.g. ["docker","exec","${r.server}","dropdb","-U","<user>","${r.name}"]`;
		// the server's own database (named in its environment) is the server owner's, never ours
		const env = (c.Config?.Env ?? []) as string[];
		const own = env.filter((e) => /^(POSTGRES_DB|POSTGRES_USER|MYSQL_DATABASE|MARIADB_DATABASE)=/.test(e)).map((e) => e.split("=")[1]);
		if (own.includes(r.name)) return `${r.name} is the server's own database (from its environment), not one you made`;
		return undefined;
	}
	return `unknown kind ${r.kind}`;
}

/** Tool for setup models: write down a Docker thing or a database they made, so the cleaner may later remove it. */
export function recordOwnedTool(root: string): ToolDefinition {
	return {
		name: "record_owned",
		label: "Record what you made",
		description: `Write down a Docker container, a Docker volume or a database YOU made in this session (never one that was there before), so the workspace can remove it once no recipe names it any more. Better than a record: put the label bigrefactor.root=${resolve(root)} on every container and volume you create (docker run --label, docker volume create --label, labels: in a compose file). A database inside a server you did not start has no label: record it here with its server container and the command that drops it.`,
		promptSnippet: "record_owned: write down a container, volume or database you made",
		parameters: Type.Object({
			kind: Type.Union([Type.Literal("container"), Type.Literal("volume"), Type.Literal("database")]),
			name: Type.String(),
			server: Type.Optional(Type.String({ description: "database only: the container of the database server" })),
			drop: Type.Optional(Type.Array(Type.String(), { description: 'database only: the command that drops it, e.g. ["docker","exec","<server>","dropdb","-U","<user>","<name>"]' })),
			why: Type.Optional(Type.String()),
		}),
		execute: async (_id: string, p: { kind: "container" | "volume" | "database"; name: string; server?: string; drop?: string[]; why?: string }) => {
			const bad = await recordProblem(root, p);
			if (!bad) await recordOwned(root, p);
			return { content: [{ type: "text" as const, text: bad ? `refused: ${bad}` : `recorded ${p.kind} ${p.name}` }], details: {} };
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
	const r = await cleanOnce({ ...o, otherRunLive: live, apply: o.apply && !live });
	return [...note, ...renderPlan(r.plan, o.apply && !live ? r : undefined)];
}
