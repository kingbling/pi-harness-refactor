import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { init } from "../src/init/init.ts";
import { labelUnits } from "../src/init/label.ts";
import { inventory } from "../src/inventory/run.ts";
import { planSlices } from "../src/inventory/slices.ts";
import { Ledger } from "../src/ledger/db.ts";
import { FakeModelClient } from "../src/models/fake.ts";

/** Judgments that used to be fixed code now come from models; these prove the wiring with a scripted client. */
const here = resolve(import.meta.dirname, "..");
const ws = (name: string) => {
	const d = join(here, ".sim", name);
	rmSync(d, { recursive: true, force: true });
	mkdirSync(join(d, "legacy"), { recursive: true });
	cpSync(join(here, "fixtures", "mini-app"), join(d, "legacy"), { recursive: true });
	return d;
};
const quiet = { text: async (_m: string, i?: string) => i, select: async (_m: string, o: Array<{ value: string }>, i?: string) => i ?? o[0]!.value, log: () => {} };

describe("model judgments", () => {
	it("stack choices: the model recommends among the adapter options after data gathering; deciding updates the config", async () => {
		const d = ws("llm-stack");
		const client = new FakeModelClient({
			chat: (req) => {
				if (!req.schema) return undefined;
				const props = (req.schema as any).properties as Record<string, any>;
				if (props["libraries"]) return { json: { libraries: [], classes: [] } };
				if (props["dimensions"]) return { json: { dimensions: [] } };
				if (props["questions"] || props["decisions"]) return { json: { questions: [], decisions: [] } };
				const out: Record<string, { id: string; reason: string }> = {};
				for (const [k, v] of Object.entries(props)) {
					const ids = v.properties.id.enum as string[];
					out[k] = k === "nestjs__database" ? { id: "mysql", reason: "keep the MySQL family the legacy app uses" } : { id: ids[0]!, reason: "fits" };
				}
				return { json: out };
			},
		});
		// init asks nothing beyond the folders; the stack is provisional
		await init(["--source", join(d, "legacy"), "--stack", "php", "--target", join(d, "migrated"), "--to", "nestjs", "--yes", "--no-docs", "--no-llm"], { root: d, prompter: quiet });
		expect(client.calls.length).toBe(0);
		// --to answers the dimensions directly (no combined "targets" answer)
		const answers = JSON.parse(readFileSync(join(d, ".bigrefactor", "decisions.json"), "utf8")).answers;
		expect(answers["target:server"].answer).toBe("nestjs");
		expect(answers["target:ui"].answer).toBe("none");
		expect(answers["targets"]).toBeUndefined();
		const { loadConfig } = await import("../src/config.ts");
		const config = loadConfig(join(d, "bigrefactor.config.json")).config;
		const ledger = new Ledger(join(d, ".bigrefactor", "ledger.sqlite"));
		await inventory(config, d, ledger);
		const { advise } = await import("../src/init/advise.ts");
		const { openDecisions, applyDecision } = await import("../src/inventory/decisions.ts");
		const { getSourceAdapter, getTargetAdapter } = await import("../src/adapters/registry.ts");
		const source = getSourceAdapter("php");
		const targets = [await getTargetAdapter("nestjs")];
		await advise(config, d, ledger, client, source, targets, () => {});
		const db = openDecisions(ledger, config, source, targets, d).find((x) => x.id === "stack:nestjs.database")!;
		expect(db.recommended).toBe("mysql");
		expect(db.reason).toMatch(/MySQL family/);
		expect(db.options[0]!.value).toBe("mysql"); // recommendation first: Enter takes it
		applyDecision(ledger, config, d, db.id, db.recommended!, "test");
		const cfg = JSON.parse(readFileSync(join(d, "bigrefactor.config.json"), "utf8"));
		expect(cfg.target.choices.nestjs.database).toBe("mysql");
		// every open decision has a recommendation that is one of its options
		for (const x of openDecisions(ledger, loadConfig(join(d, "bigrefactor.config.json")).config, source, targets, d)) expect(x.options.map((o) => o.value)).toContain(x.recommended);
		ledger.close();
	});

	it("init asks only for the two folders and calls no model", async () => {
		const d = ws("llm-stack-off");
		const client = new FakeModelClient();
		const asked: string[] = [];
		const prompter = { text: async (m: string, i?: string) => (asked.push(m), m.startsWith("Old") ? join(d, "legacy") : m.startsWith("New") ? join(d, "migrated") : i), select: async (m: string, o: Array<{ value: string }>, i?: string) => (asked.push(m), i ?? o[0]!.value), log: () => {} };
		await init(["--no-docs"], { root: d, prompter, client });
		expect(asked).toEqual(["Old codebase folder (read-only, never written)", "New codebase folder"]);
		expect(client.calls.length).toBe(0);
		expect(JSON.parse(readFileSync(join(d, "bigrefactor.config.json"), "utf8")).target.choices.nestjs.database).toBe("postgres");
	});

	it("label: Jev labels every unit, hard units route to escalate, unreached units get placed, auth comes from Jev", async () => {
		const d = ws("llm-label");
		mkdirSync(join(d, ".bigrefactor"), { recursive: true });
		// an unreached but alive helper (referenced only by a string) → lands in the dynamic slice before labelling
		const config = ConfigSchema.parse({ source: { path: join(d, "legacy"), stack: "php" }, target: { path: join(d, "migrated"), stacks: ["nestjs"] }, models: {} });
		const ledger = new Ledger(join(d, ".bigrefactor", "ledger.sqlite"));
		await inventory(config, d, ledger);
		const before = planSlices(ledger, {});
		const firstUnit = ledger.listUnits({ state: "planned" })[0]!.id;
		const client = new FakeModelClient({
			decide: (req) => {
				const q = req.questions;
				if (q["kind"]) {
					// facts, not a difficulty judgment: four risk facts → code computes "hard"
					const risky = (req.state as any).summary.includes("class");
					return { kind: "domain_logic", dynamic_refs: risky, raw_sql: risky, global_state: risky, external_io: risky, branching: false };
				}
				if (q["slice"]) return { slice: Object.keys((q["slice"] as any).criteria)[0] };
				// auth battery: every feature question → yes for the first feature only
				const keys = Object.keys(q);
				return Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.95 : 0.05]));
			},
		});
		const r = await labelUnits(config, d, ledger, client, { log: () => {} });
		expect(r.units).toBe(ledger.listUnits({ state: "planned" }).length);
		for (const u of ledger.listUnits({ state: "planned" })) {
			const route = JSON.parse(u.meta).route;
			expect(route?.kind).toBe("domain_logic");
			expect(route.confidence.kind).toBeGreaterThan(0.5); // stored per question
			expect(["mechanical", "moderate", "hard"]).toContain(route.difficulty);
		}
		expect(ledger.listUnits({ state: "planned" }).every((u) => u.kind === "domain_logic")).toBe(true);
		// hard count = units Jev+code rate hard with a probable level
		const hardUnits = ledger.listUnits({ state: "planned" }).filter((u) => { const x = JSON.parse(u.meta).route; return x.difficulty === "hard" && x.difficultyConfidence >= 0.75; });
		expect(r.hard).toBe(hardUnits.length);
		// facts code knows are certain (confidence 1), not asked to Jev
		const any = JSON.parse(ledger.listUnits({ state: "planned" })[0]!.meta).route;
		expect(any.confidence.raw_sql).toBe(1);
		expect(any.confidence.dynamic_refs).toBe(1);
		const n = (ledger.db.prepare("SELECT COUNT(*) n FROM decisions WHERE point = 'label_unit'").get() as { n: number }).n;
		expect(n).toBe(r.units);
		const ov = JSON.parse(readFileSync(join(d, ".bigrefactor", "slices.json"), "utf8"));
		expect(ov.advised).toBeTruthy();
		const after = planSlices(ledger, ov);
		const dynBefore = before.slices.find((s) => s.name === "dynamic")?.units.length ?? 0;
		const dynAfter = after.slices.find((s) => s.name === "dynamic")?.units.length ?? 0;
		expect(dynAfter).toBeLessThanOrEqual(dynBefore);
		expect(dynAfter).toBe(dynBefore - r.placed);
		// second run: nothing left to label, no new calls for units
		const calls = client.calls.length;
		const again = await labelUnits(config, d, ledger, client, { log: () => {} });
		expect(again.units).toBe(0);
		expect(client.calls.length - calls).toBeLessThanOrEqual(dynAfter); // only still-unplaced units are asked again
		expect(firstUnit).toBeTruthy();
		ledger.close();
	});

	it("difficulty: computed by code from facts; confidence is the probability of the level, not the weakest fact", async () => {
		const { unitDifficulty } = await import("../src/jev/questions.ts");
		const certain = unitDifficulty({ dynamic_refs: 1, raw_sql: 1, global_state: 1, external_io: 1, branching: 0 }, { loc: 100, deps: 2, cutDeps: 0 });
		expect(certain).toMatchObject({ level: "hard", confidence: 1 });
		// one uncertain fact that cannot change the level → still certain
		expect(unitDifficulty({ dynamic_refs: 0, raw_sql: 0, global_state: 0, external_io: 0, branching: 0.5 }, { loc: 50, deps: 1, cutDeps: 0 })).toMatchObject({ level: "mechanical", confidence: 1 });
		// one uncertain fact on the boundary → 50/50
		const edge = unitDifficulty({ dynamic_refs: 1, raw_sql: 0, global_state: 0, external_io: 0, branching: 0.5 }, { loc: 50, deps: 1, cutDeps: 0 });
		expect(edge.confidence).toBe(0.5);
		// stats count too
		expect(unitDifficulty({}, { loc: 900, deps: 12, cutDeps: 1 }).level).toBe("moderate");
	});
});
