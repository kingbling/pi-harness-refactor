import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { FakeModelClient } from "../src/models/fake.ts";
import type { GateInput, GateReport } from "../src/run/gate.ts";
import { runUnit } from "../src/run/unit.ts";
import type { LeafSession } from "../src/sessions/spawn.ts";

/**
 * runUnit wiring around the gate: approved tidy tasks reach the write scope on the first unit after the answer,
 * and a doctor diagnosis becomes a model-phrased question (never code-written question text).
 */
const here = resolve(import.meta.dirname, "..");
let ws: string;
let config: Config;
let ledger: Ledger;
const write = (p: string, s = "x\n") => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, s));
const spawn = async (): Promise<LeafSession> => ({ run: async () => ({ text: "done", toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } }), dispose() {} }) as unknown as LeafSession;
const failing = (output: string): GateReport => ({ ok: false, steps: [{ name: "antigaming_ok", ok: false, ms: 1, output }], changedFiles: ["src/features/agency/agency.service.ts"], failedStep: "antigaming_ok", testFiles: [] });

beforeEach(() => {
	ws = join(here, ".sim", "unit-wiring");
	rmSync(ws, { recursive: true, force: true });
	write(join(ws, "legacy", "app", "behaviour", "commands", "agency", "create.cmd.php"), "<?php\n");
	config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, models: {} });
	write(join(ws, "migrated", "package.json"), "{}");
	mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
	ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
	ledger.createUnit({ id: "u1", tier: "T0", deps: [], meta: { files: ["app/behaviour/commands/agency/create.cmd.php"], place: { stack: "nestjs", area: "agency", shared: false, source: "code" } }, symbolIds: [] });
	// truth captured before: the tester is skipped
	write(join(ws, ".bigrefactor", "truth", "u1", "interface.md"), "src/features/agency/agency.service.ts exports AgencyService\n");
	ledger.addEvidence("u1", "truth_green_on_old", {});
});

describe("runUnit wiring", () => {
	it("an approved tidy task is in scope and sanctioned for the first unit after the answer", async () => {
		const q = ledger.askQuestion({ point: "tidy", question: "q", blocks: "none", askedBy: "tidy" });
		ledger.answerQuestion(q, "apply", "human");
		const task = { id: `T${q}`, stack: "nestjs", area: "agency", op: "merge", from: ["src/shared/agency-utils/fmt.ts"], to: ["src/features/agency/lib/fmt.ts"], why: "only agency uses it", questionId: q, status: "asked" };
		ledger.setMeta("tidy_tasks", JSON.stringify([task]));
		const seen: GateInput[] = [];
		const gate = async (g: GateInput): Promise<GateReport> => (seen.push(g), { ok: true, steps: [], changedFiles: [], testFiles: [] });
		await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn, gate, log: () => {} });
		expect(seen[0]!.writeGlobs).toEqual(["src/features/agency/**", "src/shared/agency-utils/fmt.ts", "src/features/agency/lib/fmt.ts"]);
		expect(seen[0]!.sanctioned).toEqual(["src/shared/agency-utils/fmt.ts", "src/features/agency/lib/fmt.ts"]);
		expect(seen[0]!.legacyWords).toContain("tpl");
	});

	it("after the doctor, the triage question is withdrawn and asked again with the diagnosis, phrased by the model", async () => {
		const client = new FakeModelClient({ chat: () => ({ json: { action: "unknown", summary: "the protected globs block the module dir", question: "The gate keeps refusing agency writes: fix the protected globs?", options: [], recommended: "fixed", opinion: "Looks like config." } }) });
		const gate = async (): Promise<GateReport> => failing("write outside unit scope: src/features/agency/agency.service.ts");
		const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn, gate, client, log: () => {} });
		const qs = ledger.db.prepare("SELECT point, question, status, context FROM questions WHERE unit_id = 'u1' ORDER BY id").all() as Array<{ point: string; question: string; status: string; context: string }>;
		expect(qs.map((q) => [q.point, q.status])).toEqual([["gate_env", "withdrawn"], ["gate_env", "open"]]);
		expect(qs[1]!.question).toContain("The gate keeps refusing agency writes: fix the protected globs?");
		expect(JSON.parse(qs[1]!.context).diagnosis.summary).toBe("the protected globs block the module dir");
		expect(JSON.parse(ledger.getUnit("u1")!.meta).parked.question).toBe(ledger.openQuestions()[0]!.id);
		expect(r.attempts).toBe(2);
	});
});
