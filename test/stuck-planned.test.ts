import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getSourceAdapter, getTargetAdapter } from "../src/adapters/registry.ts";
import { ConfigSchema } from "../src/config.ts";
import { applyDecision } from "../src/inventory/decisions.ts";
import { inventory } from "../src/inventory/run.ts";
import { Ledger } from "../src/ledger/db.ts";
import { decisionGate } from "../src/run/decisions-gate.ts";
import { requeueUnits, runScheduler } from "../src/run/run.ts";

/**
 * Planned units that nothing would ever start and nobody would be asked about: a stale flag left on a unit back in
 * the queue, a dependency on a unit that is gone or excluded, a requeue that leaves the old question open.
 */
const here = resolve(import.meta.dirname, "..");

async function setup(name: string) {
	const ws = join(here, ".sim", name);
	rmSync(ws, { recursive: true, force: true });
	cpSync(join(here, "fixtures", "mini-app"), join(ws, "legacy"), { recursive: true });
	mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
	const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, models: {} });
	writeFileSync(join(ws, "bigrefactor.config.json"), JSON.stringify(config, null, 2));
	process.env["BR_WORKSPACE"] = ws;
	const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
	await inventory(config, ws, ledger);
	const source = getSourceAdapter("php");
	const targets = [await getTargetAdapter("nestjs")];
	for (const d of decisionGate(ledger, config, source, targets, ws).global) applyDecision(ledger, config, ws, d.id, d.recommended!, "test");
	// every unit placed, so only deps and flags decide what is ready
	for (const u of ledger.listUnits()) ledger.updateUnit(u.id, { meta: { place: { stack: "nestjs", area: "app", shared: false, source: "answer" } } });
	const readyNow = async () => {
		const logs: string[] = [];
		await runScheduler({ ledger, config, root: ws, dry: true, log: (l) => logs.push(l), handleSigint: false });
		return logs.find((l) => l.includes("ready now"))!;
	};
	return { ws, config, ledger, readyNow };
}

describe("planned units that could never start", () => {
	it("a dependency on a unit that is gone or excluded does not hold its dependents", async () => {
		const { ledger, readyNow } = await setup("stuck-planned-deps");
		const [a, b] = ledger.listUnits().map((u) => u.id) as [string, string];
		ledger.db.prepare("UPDATE units SET deps = ? WHERE id = ?").run(JSON.stringify(["gone-unit"]), a);
		expect(await readyNow()).toContain(a!);
		ledger.db.prepare("UPDATE units SET deps = ? WHERE id = ?").run(JSON.stringify([b]), a);
		expect(await readyNow()).not.toContain(a!);
		ledger.updateUnit(b!, { meta: { exclude: { question: 1, why: "not app code" } } });
		expect(await readyNow()).toContain(a!);
		ledger.close();
	});

	it("a stale unit that goes back to planned runs again", async () => {
		const { ledger, readyNow } = await setup("stuck-planned-stale");
		const id = ledger.listUnits().find((u) => JSON.parse(u.deps).length === 0)!.id;
		ledger.transitionUnit(id, "quarantined", "t");
		ledger.updateUnit(id, { meta: { stale: true, staleReason: "changed upstream" } });
		ledger.transitionUnit(id, "planned", "requeued");
		expect(JSON.parse(ledger.getUnit(id)!.meta).stale).toBeUndefined();
		expect(await readyNow()).toContain(id);
		ledger.close();
	});

	it("a requeue closes the unit's open question; a person's requeue also lets a later quarantine be healed or asked about", async () => {
		const { ws, config, ledger } = await setup("stuck-planned-requeue");
		const id = ledger.listUnits()[0]!.id;
		ledger.transitionUnit(id, "quarantined", "gate red");
		const q = ledger.askQuestion({ unitId: id, point: "quarantine", question: "stuck?", options: ["retry", "leave"], blocks: "unit", askedBy: "orchestrator" });
		ledger.updateUnit(id, { meta: { healQuestion: 0, stuck: true, autoHeals: 2 } });
		expect(requeueUnits(ledger, config, ws, [id], "self-heal")).toEqual([`${id}: requeued`]);
		expect(ledger.getQuestion(q)!.status).toBe("withdrawn");
		expect(JSON.parse(ledger.getUnit(id)!.meta)).toMatchObject({ healQuestion: 0, stuck: true, autoHeals: 2 }); // automatic: caps kept
		ledger.transitionUnit(id, "quarantined", "gate red again");
		requeueUnits(ledger, config, ws, [id], "owner", { human: true });
		const meta = JSON.parse(ledger.getUnit(id)!.meta);
		expect([meta.healQuestion, meta.stuck, meta.autoHeals]).toEqual([undefined, undefined, undefined]);
		ledger.close();
	});
});
