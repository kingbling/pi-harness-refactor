import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getTargetAdapter } from "../src/adapters/registry.ts";
import { ConfigSchema } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import type { GateInput, GateReport } from "../src/run/gate.ts";
import { keepPortedTests, requeueUnits } from "../src/run/run.ts";
import { runUnit } from "../src/run/unit.ts";
import type { LeafSession, SpawnOptions } from "../src/sessions/spawn.ts";

/**
 * A quarantined unit that runs again keeps its truth: its ported tests are kept when its worktree goes, and the
 * next run puts them back instead of having the tester write the truth and the tests again.
 */
const here = resolve(import.meta.dirname, "..");
const write = (p: string, s = "x\n") => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, s));
const SPEC = "src/features/agency/agency.service.spec.ts";

describe("a requeue keeps the truth", () => {
	it("the quarantined worktree's tests are kept; the next run uses them and the truth cases, without a tester session", async () => {
		const ws = join(here, ".sim", "requeue-truth");
		rmSync(ws, { recursive: true, force: true });
		write(join(ws, "legacy", "app", "agency", "create.cmd.php"), "<?php\n");
		const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, models: {} });
		write(join(ws, "migrated", "package.json"), "{}");
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
		ledger.createUnit({ id: "u1", tier: "T1", deps: [], meta: { files: ["app/agency/create.cmd.php"], place: { stack: "nestjs", area: "agency", shared: false, source: "code" } }, symbolIds: [] });
		write(join(ws, ".bigrefactor", "truth", "u1", "interface.md"), "src/features/agency/agency.service.ts exports AgencyService\n");
		ledger.addEvidence("u1", "truth_green_on_old", {});
		ledger.db.prepare("INSERT INTO truth_cases(id, unit_id, symbol_id, inputs, expected, verified_on_old, created_at) VALUES ('u1#1','u1','s','[]','1',1,'t')").run();
		ledger.transitionUnit("u1", "truth", "t");
		ledger.transitionUnit("u1", "implementing", "t");
		ledger.transitionUnit("u1", "quarantined", "gate still red after 5 attempts (wired_ok)");

		// the quarantined unit's worktree has the tests its tester wrote; they are kept before it goes
		const old = join(ws, "worktrees", "u1-old");
		write(join(old, SPEC), "it('u1#1 creates an agency with its id', () => {});\n");
		const layout = (await getTargetAdapter("nestjs")).layout;
		expect(keepPortedTests(config, ws, "u1", ledger.getUnit("u1")!.meta, old, layout)).toEqual([SPEC]);
		rmSync(old, { recursive: true, force: true });
		expect(requeueUnits(ledger, config, ws, ["u1"], "self-heal")).toEqual(["u1: requeued"]);

		// the next run starts from a fresh worktree without the tests
		const fresh = join(ws, "worktrees", "u1");
		write(join(fresh, "package.json"), "{}");
		const roles: string[] = [];
		const spawn = (async (opts: SpawnOptions): Promise<LeafSession> =>
			({
				run: async () => (roles.push(opts.role), { text: "IMPLEMENTER DONE", toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } }),
				dispose() {},
			}) as unknown as LeafSession) as never;
		const gate = async (g: GateInput): Promise<GateReport> => ({ ok: true, steps: [], changedFiles: [], testFiles: g.testFiles.map((t) => t.path) });
		await runUnit({ ledger, config, root: ws, unitId: "u1", workDir: fresh, reuseTruth: true, spawn, gate, log: () => {} });
		expect(roles).toEqual(["implement"]);
		expect(readFileSync(join(fresh, SPEC), "utf8")).toContain("u1#1 creates an agency");
		expect(ledger.db.prepare("SELECT id FROM truth_cases WHERE unit_id = 'u1'").all()).toEqual([{ id: "u1#1" }]);
		expect(existsSync(join(ws, ".bigrefactor", "truth", "u1", "ported", SPEC))).toBe(true);
		ledger.close();
	});
});
