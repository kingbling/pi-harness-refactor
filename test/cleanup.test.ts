import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { addWorktree, commitAll, ensureRepo } from "../src/git.ts";
import { Ledger } from "../src/ledger/db.ts";
import { exec } from "../src/proc.ts";
import { cleanOnce, createCleaner, recordProblem, type Runner } from "../src/run/cleanup.ts";

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

/** A fake docker: containers and volumes as given; every removal is written down, never run. */
function fakeDocker(containers: any[], volumes: any[], calls: string[][]): Runner {
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
		return "";
	};
}
const container = (name: string, status: string, labels: Record<string, string> | null, volumes: string[] = [], env: string[] = []) => ({
	Id: `id-${name}`,
	Name: `/${name}`,
	State: { Status: status, Running: status === "running" },
	Config: { Labels: labels, Env: env },
	Mounts: volumes.map((v) => ({ Type: "volume", Name: v })),
});
const compose = (project: string, dir: string) => ({ "com.docker.compose.project": project, "com.docker.compose.project.working_dir": dir });

describe("the cleaner", () => {
	it("removes owned, unneeded things and never touches what is not provably ours or still in use", async () => {
		const { root, target, state, config, ledger } = await workspace();
		const ours = join(state, "legacy-env", "app", "docker");
		// ---- docker
		const containers = [
			container("oldproj-db-1", "exited", compose("oldproj", ours), ["oldproj_data"]), // ours, stopped, named by no recipe
			container("ourcopy-db-1", "running", compose("ourcopy", ours), ["ourcopy_data"]), // ours, running
			container("ssp1legacy-db-1", "exited", compose("ssp1legacy", "/Users/someone/otg2/docker")), // another project's
			container("labelled-named", "exited", { "bigrefactor.root": root }), // ours, but a recipe names it
			container("unlabelled-stopped", "exited", null), // no proof at all
			container("otherpg", "running", compose("shared", "/Users/someone/otg2/docker"), [], ["POSTGRES_USER=ssp1"]),
		];
		const volumes = [
			{ Name: "orphan_data", Labels: null }, // unlabelled, unused: never
			{ Name: "ssp1legacy_pg", Labels: { "com.docker.compose.project": "ssp1legacy" } }, // another project's, unused: never
			{ Name: "ourcopy_data", Labels: { "com.docker.compose.project": "ourcopy" } }, // ours, mounted
			{ Name: "labelled_vol", Labels: { "bigrefactor.root": root } }, // ours, unused
			{ Name: "oldproj_data", Labels: { "com.docker.compose.project": "oldproj" } }, // ours, still mounted by the stopped container
		];
		writeFileSync(join(state, "parity", "apps.json"), JSON.stringify({ legacy: { recipe: { start: { cmd: "docker", args: ["compose", "-p", "ourcopy", "up"] } } }, symfony: { recipe: { env: { DATABASE_URL: "postgres://x@localhost/parity_live" } } }, note: "docker start labelled-named" }));
		writeFileSync(
			join(state, "owned.jsonl"),
			[
				{ kind: "database", name: "parity_old", server: "otherpg", drop: ["docker", "exec", "otherpg", "dropdb", "-U", "ssp1", "parity_old"] },
				{ kind: "database", name: "parity_live", server: "otherpg", drop: ["docker", "exec", "otherpg", "dropdb", "-U", "ssp1", "parity_live"] },
				{ kind: "database", name: "ssp1", server: "otherpg", drop: ["docker", "exec", "otherpg", "dropdb", "-U", "ssp1", "ssp1"] },
			].map((r) => JSON.stringify({ ...r, at: "2026-01-01" })).join("\n") + "\n",
		);
		// ---- git: a running lane's worktree, a leftover one, a job's; merged, kept and unmerged branches
		const wt = join(state, "worktrees");
		await addWorktree(target, join(wt, "U1"), "unit/U1");
		await addWorktree(target, join(wt, "U2"), "unit/U2");
		await addWorktree(target, join(wt, "__builder__nestjs"), "builder/nestjs");
		git(target, ["branch", "unit/U3"]); // accepted, merged
		git(target, ["branch", "code/build-1"]); // a finished code job's, merged
		git(target, ["checkout", "-q", "-b", "unit/U4"]);
		writeFileSync(join(target, "b.txt"), "kept\n");
		git(target, ["add", "-A"]);
		git(target, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "wip"]);
		const kept = git(target, ["rev-parse", "HEAD"]);
		git(target, ["checkout", "-q", "-b", "code/refused"]); // not merged, no unit: stays
		git(target, ["checkout", "-q", "migration/main"]);
		ledger.db.prepare("UPDATE units SET meta = json_set(meta, '$.keptWork', ?) WHERE id = 'U4'").run(kept);
		git(target, ["branch", "feature/someone"]); // not the plugin's naming
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

		// docker: only the owned stopped container, the owned unused volume and the recorded database no recipe names
		expect(calls).toEqual([["rm", "-v", "id-oldproj-db-1"], ["volume", "rm", "labelled_vol"], ["exec", "otherpg", "dropdb", "-U", "ssp1", "parity_old"]]);
		// its volume lost its only proof with it: written down first, so a later pass may remove it
		expect(readFileSync(join(state, "owned.jsonl"), "utf8")).toMatch(/"kind":"volume","name":"oldproj_data"/);
		// git: the leftover worktree and the merged plugin branches
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

		// the next pass: the volume, proven by the record, goes once nothing mounts it
		const calls2: string[][] = [];
		await cleanOnce({ config, root, ledger, run: fakeDocker(containers.filter((c) => c.Name !== "/oldproj-db-1"), volumes.filter((v) => v.Name !== "labelled_vol"), calls2), inUse: () => new Set(["U1"]), apply: true });
		expect(calls2).toEqual([["volume", "rm", "oldproj_data"]]);
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

	it("refuses records of things another project owns", async () => {
		const { root, ledger } = await workspace();
		const containers = [container("otherpg", "running", compose("shared", "/Users/someone/otg2/docker"), [], ["POSTGRES_USER=ssp1", "POSTGRES_DB=ssp1"])];
		const volumes = [{ Name: "shared_pg", Labels: { "com.docker.compose.project": "shared" } }];
		const run = fakeDocker(containers, volumes, []);
		expect(await recordProblem(root, { kind: "container", name: "otherpg" }, run)).toMatch(/not to this workspace/);
		expect(await recordProblem(root, { kind: "volume", name: "shared_pg" }, run)).toMatch(/compose volume/);
		expect(await recordProblem(root, { kind: "database", name: "ssp1", server: "otherpg", drop: ["docker", "exec", "otherpg", "dropdb", "ssp1"] }, run)).toMatch(/server's own database/);
		expect(await recordProblem(root, { kind: "database", name: "mine", server: "otherpg", drop: ["rm", "-rf", "/"] }, run)).toMatch(/docker exec/);
		expect(await recordProblem(root, { kind: "database", name: "mine", server: "otherpg", drop: ["docker", "exec", "otherpg", "dropdb", "-U", "ssp1", "mine"] }, run)).toBeUndefined();
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
