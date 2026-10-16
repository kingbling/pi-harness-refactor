import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { addWorktree, commitAll, ensureRepo } from "../src/git.ts";
import { Ledger } from "../src/ledger/db.ts";
import { exec } from "../src/proc.ts";
import { cleanOnce, createCleaner, planCleanup, recordOwnedChecked, whileSettingUp, type Runner } from "../src/run/cleanup.ts";

/** The cleaner removes only what this workspace provably made and nothing uses; Docker is faked, git is real. */
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const made: string[] = [];
afterAll(() => {
	for (const d of made) rmSync(d, { recursive: true, force: true });
});
const DAY = 86_400_000;
const age = (p: string, days: number) => utimesSync(p, new Date(Date.now() - days * DAY), new Date(Date.now() - days * DAY));

async function workspace() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "br-clean-")));
	made.push(root);
	const target = join(root, "new");
	mkdirSync(target, { recursive: true });
	await ensureRepo(target, "migration/main", []);
	writeFileSync(join(target, "a.txt"), "1\n");
	await commitAll(target, "init");
	const state = join(root, ".bigrefactor");
	mkdirSync(join(state, "parity"), { recursive: true });
	const config = ConfigSchema.parse({ source: { path: root, stack: "php" }, target: { path: target, stacks: ["nestjs"] }, models: {} });
	const ledger = new Ledger(join(state, "ledger.sqlite"));
	for (const [id, st] of [["U1", "planned"], ["U2", "planned"], ["U3", "accepted"], ["U4", "quarantined"]] as const) {
		ledger.createUnit({ id, tier: "leaf", symbolIds: [] });
		ledger.db.prepare("UPDATE units SET state = ? WHERE id = ?").run(st, id);
	}
	return { root, target, state, config, ledger };
}

/** A fake docker: containers and volumes as given; every removal is written down, never run. A CREATE DATABASE of a name in `dbs` fails (it exists). */
function fakeDocker(containers: any[], volumes: any[], calls: string[][], dbs: string[] = []): Runner {
	return async (cmd, args, opts) => {
		if (cmd !== "docker") {
			if (cmd === "git" || cmd === "du") return exec(cmd, args, { cwd: opts?.cwd, maxBuffer: 64 * 1024 * 1024 });
			throw new Error(`unexpected ${cmd}`);
		}
		const a = args.join(" ");
		if (a === "ps -a -q --no-trunc") return containers.map((c) => c.Id).join("\n");
		if (args[0] === "inspect") return JSON.stringify(containers.filter((c) => args.includes(c.Id) || args.includes(c.Name.slice(1))));
		if (a === "volume ls -q") return volumes.map((v) => v.Name).join("\n");
		if (args[0] === "volume" && args[1] === "inspect") return JSON.stringify(volumes.filter((v) => args.includes(v.Name)));
		if (args[0] === "system") throw new Error("df unavailable");
		calls.push(args);
		const create = /CREATE DATABASE "(\w+)"/.exec(a);
		if (create && dbs.includes(create[1]!)) throw new Error(`database "${create[1]}" already exists`);
		return "";
	};
}
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const container = (name: string, status: string, labels: Record<string, string> | null, volumes: string[] = [], env: string[] = [], created = ago(2)) => ({
	Id: `id-${name}`,
	Name: `/${name}`,
	Created: created,
	State: { Status: status, Running: status === "running" },
	Config: { Labels: labels, Env: env },
	Mounts: volumes.map((v) => ({ Type: "volume", Name: v })),
});
const volume = (name: string, labels: Record<string, string> | null, created = ago(2)) => ({ Name: name, CreatedAt: created, Labels: labels });
const compose = (project: string, dir: string) => ({ "com.docker.compose.project": project, "com.docker.compose.project.working_dir": dir });
const PG = ["POSTGRES_USER=ssp1", "PG_VERSION=16"];

describe("the cleaner", () => {
	it("removes owned, unneeded things and never touches what is not provably ours or still in use", async () => {
		const { root, target, state, config, ledger } = await workspace();
		const scratch = join(state, "scratch", "docker");
		const copy = join(state, "legacy-env", "app", "docker");
		mkdirSync(copy, { recursive: true });
		// ---- docker
		const containers = [
			// ours, stopped, named by no recipe; it mounts a volume made with it, one of another project and an older one of its project name
			container("oldproj-db-1", "exited", compose("oldproj", scratch), ["oldproj_data", "ssp1legacy_pg", "oldproj_before"], [], ago(3)),
			container("ourcopy-db-1", "running", compose("ourcopy", copy), ["ourcopy_data"]), // ours, running
			container("copy-doohdb-1", "exited", compose("ssp1copy", copy), ["ssp1copy_mariadb_data"]), // ours, stopped, but the live copy starts it by path
			container("ssp1legacy-db-1", "exited", compose("ssp1legacy", "/Users/someone/otg2/docker")), // another project's
			container("labelled-named", "exited", { "bigrefactor.root": root }), // ours, but a recipe names it
			container("labelled-young", "exited", { "bigrefactor.root": root }, [], [], ago(0.1)), // ours, but made an hour ago
			container("unlabelled-stopped", "exited", null), // no proof at all
			container("otherpg", "running", compose("shared", "/Users/someone/otg2/docker"), [], [...PG, "POSTGRES_DB=ssp1"]),
		];
		const volumes = [
			volume("orphan_data", null), // unlabelled, unused: never
			volume("ssp1legacy_pg", { "com.docker.compose.project": "ssp1legacy" }), // another project's, unused once our container goes: never
			volume("oldproj_before", { "com.docker.compose.project": "oldproj" }, ago(30)), // same project name, there long before our container: never
			volume("docker_pgdata", { "com.docker.compose.project": "docker" }), // a project name an old record calls ours, no containers: never
			volume("ourcopy_data", { "com.docker.compose.project": "ourcopy" }), // mounted
			volume("ssp1copy_mariadb_data", { "com.docker.compose.project": "ssp1copy" }), // mounted by the kept copy container
			volume("labelled_vol", { "bigrefactor.root": root }), // ours, unused
			volume("labelled_young", { "bigrefactor.root": root }, ago(0.1)), // ours, unused, but an hour old
			volume("oldproj_data", { "com.docker.compose.project": "oldproj" }, new Date(Date.parse(ago(3)) - 5000).toISOString()), // made with oldproj-db-1
		];
		writeFileSync(join(state, "parity", "apps.json"), JSON.stringify({ legacy: { recipe: { start: { cmd: "docker", args: ["compose", "-p", "ourcopy", "up"] } } }, symfony: { recipe: { env: { DATABASE_URL: "postgres://x@localhost/parity_live" } } }, note: "docker start labelled-named" }));
		writeFileSync(
			join(state, "owned.jsonl"),
			[
				{ kind: "database", name: "parity_old", server: "otherpg", engine: "postgres", at: ago(2) },
				{ kind: "database", name: "parity_live", server: "otherpg", engine: "postgres", at: ago(2) },
				{ kind: "database", name: "parity_new", server: "otherpg", engine: "postgres", at: ago(0.1) }, // made an hour ago
				{ kind: "database", name: "ssp1", server: "otherpg", engine: "postgres", at: ago(2) },
				{ kind: "database", name: "ssp1_test", server: "otherpg", drop: ["docker", "exec", "otherpg", "dropdb", "ssp1_test"], at: ago(2) }, // a model's word only
				{ kind: "compose-project", name: "docker", at: ago(2) }, // an older kind: no proof any more
			].map((r) => JSON.stringify(r)).join("\n") + "\n",
		);
		// ---- git: a running lane's worktree, a leftover one, a job's; merged, kept and unmerged branches
		const wt = join(state, "worktrees");
		await addWorktree(target, join(wt, "U1"), "unit/U1");
		await addWorktree(target, join(wt, "U2"), "unit/U2");
		await addWorktree(target, join(wt, "__builder__nestjs"), "builder/nestjs");
		const leftBranch = async (n: string, branch: string, commit?: string) => {
			await addWorktree(target, join(wt, n), branch);
			if (commit) {
				writeFileSync(join(wt, n, `${n}.txt`), commit);
				git(join(wt, n), ["add", "-A"]);
				git(join(wt, n), ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", commit]);
			}
			const sha = git(join(wt, n), ["rev-parse", "HEAD"]);
			git(target, ["worktree", "remove", "--force", join(wt, n)]);
			return sha;
		};
		await leftBranch("U3", "unit/U3"); // accepted, merged
		await leftBranch("__code__1", "code/build-1"); // a finished code job's, merged
		const kept = await leftBranch("U4", "unit/U4", "wip"); // kept code
		await leftBranch("__code__2", "code/refused", "refused"); // not merged, no unit: stays
		ledger.db.prepare("UPDATE units SET meta = json_set(meta, '$.keptWork', ?) WHERE id = 'U4'").run(kept);
		git(target, ["branch", "feature/someone"]); // not made by addWorktree
		// ---- files
		mkdirSync(join(wt, ".trash", "U9-99999999-0"), { recursive: true });
		for (const [n, d] of [["a", 5], ["b", 4], ["c", 4.5], ["d", 1]] as const) {
			writeFileSync(join(state, `ledger.before-${n}.sqlite`), "x");
			age(join(state, `ledger.before-${n}.sqlite`), d);
		}
		mkdirSync(join(state, "sessions"), { recursive: true });
		for (const [n, d] of [["U3.implementer.1.jsonl", 10], ["U3.implementer.2.jsonl", 1], ["U4.implementer.1.jsonl", 10]] as const) {
			writeFileSync(join(state, "sessions", n), "{}\n");
			age(join(state, "sessions", n), d);
		}

		const calls: string[][] = [];
		const logs: string[] = [];
		const r = await cleanOnce({ config, root, ledger, run: fakeDocker(containers, volumes, calls), inUse: () => new Set(["U1"]), apply: true, log: (l) => logs.push(l) });
		const removed = r.removed.map((x) => `${x.kind} ${x.name}`);

		// docker: only the owned stopped container, the owned unused volume and the database record_owned created (drop built by code)
		expect(calls).toEqual([["rm", "-v", "id-oldproj-db-1"], ["volume", "rm", "labelled_vol"], ["exec", "otherpg", "psql", "-v", "ON_ERROR_STOP=1", "-U", "ssp1", "-d", "ssp1", "-c", 'DROP DATABASE "parity_old"']]);
		// of its volumes only the one made with it is written down; borrowed and older ones are not
		const owned = readFileSync(join(state, "owned.jsonl"), "utf8");
		expect(owned).toMatch(/"kind":"volume","name":"oldproj_data"/);
		expect(owned).not.toMatch(/"name":"ssp1legacy_pg"|"name":"oldproj_before"/);
		const kept1 = r.plan.kept.join("\n");
		expect(kept1).toMatch(/volume ssp1legacy_pg: mounted by our container oldproj-db-1 but not made with it \(of compose project ssp1legacy\)/);
		expect(kept1).toMatch(/volume oldproj_before: .*existed before the container/);
		expect(kept1).toMatch(/container copy-doohdb-1: its compose files .* start by path/);
		expect(kept1).toMatch(/container labelled-young: made less than a day ago/);
		expect(kept1).toMatch(/volume labelled_young: made less than a day ago/);
		expect(kept1).toMatch(/database parity_new: made less than a day ago/);
		expect(kept1).toMatch(/database ssp1_test: recorded before code created databases itself/);
		// git: the leftover worktree and the merged branches this workspace made
		expect(existsSync(join(wt, "U1"))).toBe(true);
		expect(existsSync(join(wt, "U2"))).toBe(false);
		expect(existsSync(join(wt, "__builder__nestjs"))).toBe(true);
		const branches = git(target, ["branch", "--format=%(refname:short)"]).split("\n");
		expect(branches).toEqual(expect.arrayContaining(["migration/main", "unit/U1", "unit/U4", "code/refused", "feature/someone", "builder/nestjs"]));
		expect(branches).not.toContain("unit/U3");
		expect(branches).not.toContain("code/build-1");
		// files: dead trash, backups older than 3 days but the newest, old transcripts of accepted units
		expect(existsSync(join(wt, ".trash", "U9-99999999-0"))).toBe(false);
		expect(["a", "b", "c", "d"].map((n) => existsSync(join(state, `ledger.before-${n}.sqlite`)))).toEqual([false, false, false, true]);
		expect(["U3.implementer.1.jsonl", "U3.implementer.2.jsonl", "U4.implementer.1.jsonl"].map((n) => existsSync(join(state, "sessions", n)))).toEqual([false, true, true]);
		expect(removed).toContain("database parity_old (in otherpg)");
		// every removal is logged with why it is ours and why it is not needed
		const log = readFileSync(join(state, "cleanup.log"), "utf8");
		expect(log.trim().split("\n")).toHaveLength(r.removed.length);
		expect(log).toMatch(/removed container oldproj-db-1 \| ours: its compose working_dir .* \| not needed: stopped/);
		expect(r.plan.kept.join("\n")).toMatch(/not provably this workspace's: never touched/);
		expect(logs.filter((l) => /could not remove/.test(l))).toEqual([]);

		// the next pass: the volume, proven by its record, goes once nothing mounts it; then its record ends
		const calls2: string[][] = [];
		const left = containers.filter((c) => c.Name !== "/oldproj-db-1");
		await cleanOnce({ config, root, ledger, run: fakeDocker(left, volumes.filter((v) => v.Name !== "labelled_vol"), calls2), inUse: () => new Set(["U1"]), apply: true });
		expect(calls2).toEqual([["volume", "rm", "oldproj_data"]]);
		// another project later makes a volume with that name: no record proves it ours
		const calls3: string[][] = [];
		await cleanOnce({ config, root, ledger, run: fakeDocker(left, [volume("oldproj_data", { "com.docker.compose.project": "oldproj" }, ago(2))], calls3), apply: true });
		expect(calls3).toEqual([]);
		ledger.close();
	});

	it("leaves branches another workspace made on the same repo, even with an accepted unit's name", async () => {
		const { root, target, state, config, ledger } = await workspace();
		// another workspace (same target repo, same unit ids) made unit/U3 (accepted here) with unmerged work, and a merged code/x
		const otherWt = join(root, "..", "other-ws", ".bigrefactor", "worktrees");
		git(target, ["checkout", "-q", "-b", "unit/U3"]);
		writeFileSync(join(target, "other.txt"), "theirs\n");
		git(target, ["add", "-A"]);
		git(target, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "their work"]);
		git(target, ["checkout", "-q", "migration/main"]);
		git(target, ["branch", "code/x"]);
		git(target, ["config", "branch.unit/U3.bigrefactorWorktree", join(otherWt, "U3")]);
		git(target, ["config", "branch.code/x.bigrefactorWorktree", join(otherWt, "__code__")]);
		// a person's merged branch with the plugin's naming and no record
		git(target, ["branch", "parity/foo"]);
		const r = await cleanOnce({ config, root, ledger, run: fakeDocker([], [], []), apply: true });
		expect(r.removed.filter((x) => x.kind === "branch")).toEqual([]);
		expect(git(target, ["branch", "--format=%(refname:short)"]).split("\n")).toEqual(expect.arrayContaining(["unit/U3", "code/x", "parity/foo"]));
		expect(r.plan.kept.join("\n")).toMatch(/2 branch\(es\) made by another workspace/);
		// and our own branch is not removed with unmerged work, even when its unit is accepted
		await addWorktree(target, join(state, "worktrees", "U3b"), "unit/U3b");
		git(join(state, "worktrees", "U3b"), ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "more"]);
		git(target, ["worktree", "remove", "--force", join(state, "worktrees", "U3b")]);
		await cleanOnce({ config, root, ledger, run: fakeDocker([], [], []), apply: true });
		expect(git(target, ["branch", "--format=%(refname:short)"]).split("\n")).toContain("unit/U3b");
		ledger.close();
	});

	it("asks again right before removing a branch or worktree: kept code or a run that started meanwhile keeps them", async () => {
		const { root, target, state, config, ledger } = await workspace();
		const wt = join(state, "worktrees");
		await addWorktree(target, join(wt, "U2"), "unit/U2");
		git(target, ["worktree", "remove", "--force", join(wt, "U2")]); // a leftover merged branch
		await addWorktree(target, join(wt, "U1"), "unit/U1"); // a leftover worktree
		const plan = await planCleanup({ config, root, ledger, run: fakeDocker([], [], []) });
		const branch = plan.remove.find((x) => x.kind === "branch" && x.name === "unit/U2")!;
		const worktree = plan.remove.find((x) => x.kind === "worktree")!;
		expect(branch && worktree).toBeTruthy();
		// a lane for U2 quarantined meanwhile and kept its code on the branch
		ledger.db.prepare("UPDATE units SET meta = json_set(meta, '$.keptWork', 'abc') WHERE id = 'U2'").run();
		await expect(branch.remove()).rejects.toThrow(/kept code/);
		expect(git(target, ["branch", "--format=%(refname:short)"]).split("\n")).toContain("unit/U2");
		// br clean: another process's run started while it planned
		let live = false;
		const plan2 = await planCleanup({ config, root, ledger, run: fakeDocker([], [], []), otherRunNow: () => live });
		live = true;
		await plan2.remove.find((x) => x.kind === "worktree")!.remove();
		expect(existsSync(join(wt, "U1"))).toBe(true);
		ledger.close();
	});

	it("matches a recorded container by its Id and ends the record once it is removed", async () => {
		const { root, state, config, ledger } = await workspace();
		writeFileSync(join(state, "owned.jsonl"), JSON.stringify({ kind: "container", name: "postgres", id: "id-postgres", at: ago(2) }) + "\n");
		const calls: string[][] = [];
		await cleanOnce({ config, root, ledger, run: fakeDocker([container("postgres", "exited", null)], [], calls), apply: true });
		expect(calls).toEqual([["rm", "-v", "id-postgres"]]);
		expect(readFileSync(join(state, "owned.jsonl"), "utf8")).toMatch(/"kind":"container","name":"postgres","removed":true/);
		// weeks later another project makes its own container named postgres
		const calls2: string[][] = [];
		const theirs = { ...container("postgres", "exited", null), Id: "id-theirs" };
		await cleanOnce({ config, root, ledger, run: fakeDocker([theirs], [], calls2), apply: true });
		expect(calls2).toEqual([]);
		// a record of a name whose container was replaced by someone else's (another Id) is no proof either
		writeFileSync(join(state, "owned.jsonl"), JSON.stringify({ kind: "container", name: "postgres", id: "id-ours-gone", at: ago(2) }) + "\n");
		await cleanOnce({ config, root, ledger, run: fakeDocker([theirs], [], calls2), apply: true });
		expect(calls2).toEqual([]);
		ledger.close();
	});

	it("leaves Docker alone while a setup model runs", async () => {
		const { root, config, ledger } = await workspace();
		const calls: string[][] = [];
		const r = await whileSettingUp(() => cleanOnce({ config, root, ledger, run: fakeDocker([container("x", "exited", { "bigrefactor.root": root })], [], calls), apply: true }));
		expect(calls).toEqual([]);
		expect(r.plan.kept.join("\n")).toMatch(/a setup model is running now/);
		ledger.close();
	});

	it("lists only (removes nothing) without --yes, and leaves worktrees and branches to another live run", async () => {
		const { root, target, state, config, ledger } = await workspace();
		await addWorktree(target, join(state, "worktrees", "U2"), "unit/U2");
		const calls: string[][] = [];
		const listed = await cleanOnce({ config, root, ledger, run: fakeDocker([container("x", "exited", { "bigrefactor.root": root })], [], calls), apply: false });
		expect(listed.plan.remove.map((x) => x.kind).sort()).toEqual(["container", "worktree"]);
		expect(calls).toEqual([]);
		expect(existsSync(join(state, "worktrees", "U2"))).toBe(true);
		const other = await cleanOnce({ config, root, ledger, run: fakeDocker([], [], calls), otherRunLive: true, apply: true });
		expect(other.removed).toEqual([]);
		expect(existsSync(join(state, "worktrees", "U2"))).toBe(true);
		ledger.close();
	});

	it("refuses records of things another project owns, and creates a database itself (never records one that existed)", async () => {
		const { root, state, ledger } = await workspace();
		const containers = [container("otherpg", "running", compose("shared", "/Users/someone/otg2/docker"), [], [...PG, "POSTGRES_DB=ssp1"]), container("redis", "running", null)];
		const volumes = [volume("shared_pg", { "com.docker.compose.project": "shared" })];
		const calls: string[][] = [];
		const run = fakeDocker(containers, volumes, calls, ["ssp1_test"]);
		expect(await recordOwnedChecked(root, { kind: "container", name: "otherpg" }, run)).toMatch(/refused: .*not to this workspace/);
		expect(await recordOwnedChecked(root, { kind: "volume", name: "shared_pg" }, run)).toMatch(/refused: .*compose volume/);
		expect(await recordOwnedChecked(root, { kind: "database", name: "ssp1", server: "otherpg" }, run)).toMatch(/refused: .*server's own database/);
		expect(await recordOwnedChecked(root, { kind: "database", name: "x; rm -rf /", server: "otherpg" }, run)).toMatch(/refused: .*plain database name/);
		expect(await recordOwnedChecked(root, { kind: "database", name: "mine", server: "redis" }, run)).toMatch(/refused: .*no Postgres or MySQL/);
		// otg2's database that was already there: the CREATE fails, nothing is recorded
		expect(await recordOwnedChecked(root, { kind: "database", name: "ssp1_test", server: "otherpg" }, run)).toMatch(/refused: could not create ssp1_test/);
		expect(await recordOwnedChecked(root, { kind: "database", name: "mine", server: "otherpg" }, run)).toMatch(/created database mine/);
		expect(calls.map((c) => c.at(-1))).toEqual(['CREATE DATABASE "ssp1_test"', 'CREATE DATABASE "mine"']);
		const owned = readFileSync(join(state, "owned.jsonl"), "utf8");
		expect(owned).toMatch(/"kind":"database","name":"mine","server":"otherpg","engine":"postgres"/);
		expect(owned).not.toMatch(/ssp1_test|"drop"/);
		ledger.close();
	});

	it("runs on the side once soon after the start, never after a stop", async () => {
		const { root, config, ledger } = await workspace();
		const calls: string[][] = [];
		const c = createCleaner({ config, root, ledger, run: fakeDocker([], [], calls), everyMinutes: 30, log: () => {}, firstAfterMs: 0 });
		c.tick();
		await c.idle();
		const off = createCleaner({ config, root, ledger, run: fakeDocker([container("x", "exited", { "bigrefactor.root": root })], [], calls), everyMinutes: 30, log: () => {}, firstAfterMs: 0 });
		await off.stop();
		off.tick();
		await off.idle();
		expect(calls).toEqual([]);
		ledger.close();
	});
});
