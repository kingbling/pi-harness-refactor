import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import type { GateInput, GateReport } from "../src/run/gate.ts";
import { runUnit } from "../src/run/unit.ts";
import type { LeafSession, SpawnOptions } from "../src/sessions/spawn.ts";

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
