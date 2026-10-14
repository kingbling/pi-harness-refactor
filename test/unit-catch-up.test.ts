import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import type { GateInput, GateReport } from "../src/run/gate.ts";
import { runUnit } from "../src/run/unit.ts";
import type { LeafSession, SpawnOptions } from "../src/sessions/spawn.ts";
import { nestjsAdapter } from "../src/adapters/target/nestjs.ts";
import { reportMigratedBugTool, type ToolDeps } from "../src/sessions/tools.ts";

/**
 * A unit's worktree is made from main once, but main moves on while it runs (other units, a setup fix). Each attempt
 * starts on the current main: main's new commits come in under the unit's work, which stays uncommitted.
 */
const here = resolve(import.meta.dirname, "..");
const write = (p: string, s = "x\n") => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, s));
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, stdio: "pipe" }).toString().trim();

describe("an attempt starts on the current main", () => {
	it("a setup fix that landed on main after the worktree was made reaches the running unit at its next attempt", async () => {
		const ws = join(here, ".sim", "unit-catch-up");
		rmSync(ws, { recursive: true, force: true });
		const repo = join(ws, "migrated");
		write(join(repo, "package.json"), "{}");
		write(join(repo, "src/features/agency/agency.service.spec.ts"), "it('u1#1 creates an agency', () => {});\n");
		git(repo, "init", "-q");
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "base");
		const wt = join(ws, "worktrees", "u1");
		git(repo, "worktree", "add", "-q", "-b", "unit/u1", wt);
		// the setup fix lands on main; the unit already wrote something in its worktree
		write(join(repo, "setup-fix.txt"), "fixed\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "setup fix");
		write(join(wt, "src/features/agency/agency.service.ts"), "export class AgencyService {}\n");

		write(join(ws, "legacy", "app", "agency", "create.cmd.php"), "<?php\n");
		const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: repo, stacks: ["nestjs"] }, models: {} });
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
		ledger.createUnit({ id: "u1", tier: "T1", deps: [], meta: { files: ["app/agency/create.cmd.php"], place: { stack: "nestjs", area: "agency", shared: false, source: "code" } }, symbolIds: [] });
		write(join(ws, ".bigrefactor", "truth", "u1", "interface.md"), "src/features/agency/agency.service.ts exports AgencyService\n");
		ledger.addEvidence("u1", "truth_green_on_old", {});
		ledger.db.prepare("INSERT INTO truth_cases(id, unit_id, symbol_id, inputs, expected, verified_on_old, created_at) VALUES ('u1#1','u1','s','[]','1',1,'t')").run();

		const spawn = (async (_opts: SpawnOptions): Promise<LeafSession> =>
			({ run: async () => ({ text: "IMPLEMENTER DONE", toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } }), dispose() {} }) as unknown as LeafSession) as never;
		const seen: Array<{ fix: boolean; head: string; status: string }> = [];
		const gate = async (g: GateInput): Promise<GateReport> => {
			seen.push({ fix: existsSync(join(g.targetProjectDir, "setup-fix.txt")), head: git(wt, "rev-parse", "HEAD"), status: git(wt, "status", "--porcelain") });
			return { ok: true, steps: [], changedFiles: [], testFiles: g.testFiles.map((t) => t.path) };
		};
		const lines: string[] = [];
		await runUnit({ ledger, config, root: ws, unitId: "u1", workDir: wt, reuseTruth: true, spawn, gate, log: (l) => lines.push(l) });
		expect(seen).toHaveLength(1);
		expect(seen[0]!.fix).toBe(true);
		expect(seen[0]!.head).toBe(git(repo, "rev-parse", "HEAD"));
		// the unit's code is still its uncommitted work, on top of main
		expect(seen[0]!.status).toMatch(/\?\? src\//);
		expect(readFileSync(join(wt, "src/features/agency/agency.service.ts"), "utf8")).toContain("AgencyService");
		expect(lines.join("\n")).toMatch(/main's 1 new commit\(s\) brought in under the unit's work/);
		ledger.close();
	});
});

/**
 * Main's new commits can clash with the unit's own work (a shared file both changed): the worktree then stays on the
 * older main. The attempt is told so, and a report about code another unit merged since then re-opens nothing.
 */
describe("a worktree that could not take main's new commits", () => {
	const setup = (name: string) => {
		const ws = join(here, ".sim", name);
		rmSync(ws, { recursive: true, force: true });
		const repo = join(ws, "migrated");
		write(join(repo, "package.json"), "{}");
		write(join(repo, "src/shared/port.ts"), "export interface Port {}\n");
		write(join(repo, "src/features/agency/agency.service.spec.ts"), "it('u1#1 creates an agency', () => {});\n");
		git(repo, "init", "-q");
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "base");
		const wt = join(ws, "worktrees", "u1");
		git(repo, "worktree", "add", "-q", "-b", "unit/u1", wt);
		// d1 is accepted after the worktree was made: it adds its file and changes the shared port
		write(join(repo, "src/shared/list.ts"), "export class ListCommand {}\n");
		write(join(repo, "src/shared/port.ts"), "export interface Port { list(): void }\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "d1 accepted");
		const commit = git(repo, "rev-parse", "HEAD");
		write(join(ws, "legacy", "app", "agency", "create.cmd.php"), "<?php\n");
		const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: repo, stacks: ["nestjs"] }, models: {} });
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
		ledger.createUnit({ id: "u1", tier: "T1", deps: [], meta: { files: ["app/agency/create.cmd.php"], place: { stack: "nestjs", area: "agency", shared: false, source: "code" } }, symbolIds: [] });
		ledger.db.prepare("INSERT INTO files(path, hash, lang, updated_at) VALUES ('app/list.php', 'h', 'php', 't')").run();
		ledger.db.prepare("INSERT INTO symbols(id, path, kind, name, state, updated_at) VALUES ('app/list.php::list', 'app/list.php', 'function', 'list', 'accepted', 't')").run();
		ledger.createUnit({ id: "d1", tier: "T0", deps: [], meta: { commit }, symbolIds: ["app/list.php::list"] });
		ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = 'd1'").run();
		ledger.db.prepare("INSERT INTO moves(unit_id, src_symbol, op, target_symbols, why, created_at) VALUES ('d1', 'app/list.php::list', 'moved', '[\"src/shared/list.ts::ListCommand\"]', 'x', 't')").run();
		write(join(ws, ".bigrefactor", "truth", "u1", "interface.md"), "src/features/agency/agency.service.ts exports AgencyService\n");
		ledger.addEvidence("u1", "truth_green_on_old", {});
		ledger.db.prepare("INSERT INTO truth_cases(id, unit_id, symbol_id, inputs, expected, verified_on_old, created_at) VALUES ('u1#1','u1','s','[]','1',1,'t')").run();
		return { ws, repo, wt, config, ledger, commit };
	};
	type Tool = { name: string; execute: (i: string, p: object) => Promise<{ content: Array<{ text: string }> }> };
	const report = { target: "src/shared/list.ts::ListCommand", problem: "ListCommand is absent in this workspace", evidence: "find returns none" };

	it("a clash: the attempt is told its worktree is behind main, and a report of d1's code as missing re-opens nothing", async () => {
		const { ws, repo, wt, config, ledger, commit } = setup("unit-catch-up-clash");
		write(join(wt, "src/shared/port.ts"), "export interface Port { create(): void }\n");
		const tasks: string[] = [];
		const answers: string[] = [];
		const spawn = (async (opts: SpawnOptions): Promise<LeafSession> =>
			({
				run: async (task: string) => {
					if (opts.role !== "test") {
						tasks.push(task);
						answers.push((await (opts.customTools!.find((t) => t.name === "report_migrated_bug") as unknown as Tool).execute("x", report)).content[0]!.text);
					}
					return { text: "IMPLEMENTER DONE", toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } };
				},
				dispose() {},
			}) as unknown as LeafSession) as never;
		const gate = async (g: GateInput): Promise<GateReport> => ({ ok: true, steps: [], changedFiles: [], testFiles: g.testFiles.map((t) => t.path) });
		await runUnit({ ledger, config, root: ws, unitId: "u1", workDir: wt, reuseTruth: true, spawn, gate, log: () => {} });
		expect(tasks[0]).toMatch(/## Your worktree is behind main\nMain has newer commits that clash with your work in src\/shared\/port\.ts/);
		expect(tasks[0]).toContain(`git show ${commit.slice(0, 12)}:<file>`);
		expect(answers[0]).toMatch(/d1's accepted code is on main but not in your worktree because main's new commits clash with your changes in src\/shared\/port\.ts[\s\S]*git show [0-9a-f]{12}:src\/shared\/list\.ts[\s\S]*Nothing was reported/);
		expect(ledger.getUnit("d1")!.state).toBe("accepted");
		expect(ledger.hasEvidence("d1", "bug_reported")).toBe(false);
		expect(git(wt, "rev-parse", "HEAD")).not.toBe(git(repo, "rev-parse", "HEAD"));
		ledger.close();
	});

	it("no clash: the report brings main's commits in and asks to look again; with the owner's code in the worktree a report goes through", async () => {
		const { repo, wt, config, ledger } = setup("unit-catch-up-report");
		const reports: string[] = [];
		const tool = reportMigratedBugTool({ ledger, config, unitId: "u1", root: wt, targetProjectDir: wt, mainDir: repo, adapter: nestjsAdapter, onReport: (r) => reports.push(r.owner) } as ToolDeps) as unknown as Tool;
		expect((await tool.execute("x", report)).content[0]!.text).toMatch(/Main's new commits are now in your worktree: read src\/shared\/list\.ts again[\s\S]*Nothing was reported/);
		expect(existsSync(join(wt, "src/shared/list.ts"))).toBe(true);
		expect(reports).toEqual([]);
		expect((await tool.execute("x", { ...report, problem: "list() skips archived assets" })).content[0]!.text).toMatch(/^reported to d1/);
		expect(reports).toEqual(["d1"]);
		ledger.close();
	});
});
