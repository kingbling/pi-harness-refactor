import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import type { GateInput, GateReport } from "../src/run/gate.ts";
import type { Reviewer } from "../src/run/review.ts";
import { runUnit } from "../src/run/unit.ts";
import type { LeafSession, SpawnOptions } from "../src/sessions/spawn.ts";

/**
 * A stop reaches a running unit: it gives its lane back at the next step (no review, tester round or next try),
 * goes back to planned, and its next run goes on counting its tries.
 */
const here = resolve(import.meta.dirname, "..");
let ws: string;
let config: Config;
let ledger: Ledger;
const write = (p: string, s = "x\n") => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, s));
const SPEC = "src/features/agency/agency.service.spec.ts";
const CODE = "src/features/agency/agency.service.ts";
const usage = { input: 0, output: 0, cost: 0 };
const sessions = (calls: string[], impl: (n: number) => void) => {
	let n = 0;
	return (async (opts: SpawnOptions): Promise<LeafSession> =>
		({
			run: async () => {
				calls.push(opts.role);
				if (opts.role !== "test") impl(++n);
				return { text: opts.role === "test" ? "TESTER DONE 1 cases" : "IMPLEMENTER DONE", toolCalls: 1, blocked: 0, usage };
			},
			dispose() {},
		}) as unknown as LeafSession) as never;
};
const reviewGate = async (g: GateInput): Promise<GateReport> => {
	const r = await g.review!([CODE]);
	return { ok: r.ok, steps: [{ name: "wired_ok", ok: r.ok, ms: 1, output: r.output }], changedFiles: [CODE], failedStep: r.ok ? undefined : "wired_ok", testFiles: g.testFiles.map((t) => t.path) };
};

beforeEach(() => {
	ws = join(here, ".sim", "stop-reaches-unit");
	rmSync(ws, { recursive: true, force: true });
	write(join(ws, "legacy", "app", "agency", "create.cmd.php"), "<?php\n");
	config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, models: {}, run: { maxImplementAttempts: 2, maxEscalateAttempts: 1 } });
	write(join(ws, "migrated", "package.json"), "{}");
	write(join(ws, "migrated", SPEC), "it('u1#1 creates', () => {});\n");
	execFileSync("git", ["init", "-q"], { cwd: join(ws, "migrated") });
	mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
	ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
	ledger.createUnit({ id: "u1", tier: "T1", deps: [], meta: { files: ["app/agency/create.cmd.php"], place: { stack: "nestjs", area: "agency", shared: false, source: "code" } }, symbolIds: [] });
	write(join(ws, ".bigrefactor", "truth", "u1", "interface.md"), `${CODE} exports AgencyService\n`);
	ledger.addEvidence("u1", "truth_green_on_old", {});
	ledger.db.prepare("INSERT INTO truth_cases(id, unit_id, symbol_id, inputs, expected, verified_on_old, created_at) VALUES ('u1#1','u1','s','[]','1',1,'t')").run();
});

describe("a stop reaches a running unit", () => {
	it("stopped during an implement try: no review, no tester, no next try; back to planned, the try not judged is not counted", async () => {
		let stop = false;
		const calls: string[] = [];
		const spawn = sessions(calls, (n) => {
			write(join(ws, "migrated", CODE), `export class AgencyService {} // ${n}\n`);
			stop = true; // /br stop while the implementer works
		});
		let reviews = 0;
		const reviewer: Reviewer = async () => (reviews++, { ok: false, judged: true, output: "red", findings: ["fix it"] });
		const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn, gate: reviewGate, reviewer, stopped: () => stop, log: () => {} });
		expect(r).toMatchObject({ state: "planned", attempts: 1, stopped: true });
		expect(calls).toEqual(["implement"]);
		expect(reviews).toBe(0);
		expect(ledger.db.prepare("SELECT outcome FROM attempts WHERE unit_id = 'u1' ORDER BY id").all()).toEqual([{ outcome: "stopped" }]);
		expect(ledger.transitionsOf("unit", "u1").at(-1)!.reason).toMatch(/^run stopped after 0 try/);
		expect(JSON.parse(ledger.getUnit("u1")!.meta)).toMatchObject({ triesUsed: 0, retryNote: expect.stringMatching(/run was stopped/) });

		// the review never judged that try: the next run has all three tries
		stop = false;
		calls.length = 0;
		const again = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: sessions(calls, () => {}), gate: reviewGate, reviewer, stopped: () => stop, log: () => {} });
		expect(again.attempts).toBe(3);
		expect(calls.filter((c) => c !== "test")).toHaveLength(3);
		expect(JSON.parse(ledger.getUnit("u1")!.meta).triesUsed ?? 0).toBe(0);
	});

	it("stopped before it starts its tries: back to planned without an implement session", async () => {
		const calls: string[] = [];
		const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: sessions(calls, () => {}), gate: reviewGate, stopped: () => true, log: () => {} });
		expect(r).toMatchObject({ state: "planned", attempts: 0, stopped: true });
		expect(calls.filter((c) => c !== "test")).toEqual([]);
	});
});
