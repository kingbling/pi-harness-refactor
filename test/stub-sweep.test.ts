import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger/db.ts";
import { ConfigSchema } from "../src/config.ts";
import type { LeafSession, SpawnOptions } from "../src/sessions/spawn.ts";
import { createStubSweep, markOwner, resolveOwnersWithModel, stubNames, SWEEP_BATCH, SWEEP_TRIES } from "../src/run/stub-sweep.ts";

/**
 * Stub marks already on main whose owner is accepted or names no unit: no unit replaces them, so after a merge a code
 * job gets them, a few times while they stay; then the owner is asked once. Marks of units still to run stay theirs,
 * also when they name the unit loosely (a short id, a legacy file name a model maps to the unit).
 */
let ws: string;
let ledger: Ledger;
const write = (rel: string, body: string) => {
	mkdirSync(dirname(join(ws, rel)), { recursive: true });
	writeFileSync(join(ws, rel), body);
};
const commit = () => {
	execFileSync("git", ["add", "-A"], { cwd: ws });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "main"], { cwd: ws });
};

beforeEach(() => {
	ws = mkdtempSync(join(tmpdir(), "br-stub-sweep-"));
	execFileSync("git", ["init", "-q"], { cwd: ws });
	ledger = new Ledger(":memory:");
	ledger.createUnit({ id: "U1708_agency", tier: "T0", symbolIds: [] });
	ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = 'U1708_agency'").run();
	ledger.createUnit({ id: "U2000_open", tier: "T0", symbolIds: [] });
});
afterEach(() => {
	ledger.close();
	rmSync(ws, { recursive: true, force: true });
});

describe("loose owner names, decided by a model with ledger lookups", () => {
	it("finds units by a part of their id or legacy files; an id that is no unit is sent back", async () => {
		ledger.updateUnit("U2000_open", { meta: { files: ["app/controller/sales.controller.php"] } });
		let lookedUp = "";
		const spawn = (async (opts: SpawnOptions): Promise<LeafSession> => {
			const tool = (n: string) => opts.customTools!.find((t) => t.name === n) as unknown as { execute: (i: string, p: object) => Promise<{ content: Array<{ text: string }> }> };
			return {
				run: async () => {
					lookedUp = (await tool("unit_lookup").execute("1", { query: "sales.controller" })).content[0]!.text;
					const wrong = (await tool("stub_owners").execute("2", { owners: [{ name: "sales.controller", unit: "U2000", why: "short" }] })).content[0]!.text;
					expect(wrong).toMatch(/no such unit: U2000/);
					await tool("stub_owners").execute("3", { owners: [{ name: "sales.controller", unit: "U2000_open", why: "its legacy file" }, { name: "x", unit: "U1708_agency", why: "not asked" }] });
					return { text: "", toolCalls: 3, blocked: 0, usage: { input: 0, output: 0, cost: 0 } };
				},
				dispose() {},
			} as unknown as LeafSession;
		}) as never;
		const config = ConfigSchema.parse({ source: { path: ws, stack: "php" }, target: { path: ws, stacks: ["nestjs"] }, models: {} });
		const got = await resolveOwnersWithModel({ ledger, config, spawn })(["sales.controller", "rms controller"]);
		expect(lookedUp).toContain("U2000_open [planned] app/controller/sales.controller.php");
		expect(got).toEqual({ "sales.controller": "U2000_open" });
	});
});

describe("stub sweep", () => {
	it("hands the marks of accepted owners and of no unit to a code job; marks still there are handed again, up to the tries, then once to the other stacks and once more here; no question to the owner", async () => {
		write("src/agency/lookup.ts", "export const lookup = () => []; // TODO(br:U1708_agency)\n");
		write("src/campaign/editor.ts", "// TODO(br:campaign editor owner) stub\nexport const e = 1;\n");
		write("src/open/x.ts", "export const x = 0; // TODO(br:U2000_open)\n");
		commit();
		const jobs: Array<{ stack: string; what: string }> = [];
		const make = () => createStubSweep({ ledger, dirOf: () => ws, codeJob: async (stack, what) => void jobs.push({ stack, what }), otherStacks: (s) => ["symfony", "nestjs"].filter((x) => x !== s), log: () => {} });
		const sweep = make();
		await sweep.afterMerge("nestjs");
		expect(jobs).toHaveLength(1);
		expect(jobs[0]!.what).toContain("src/agency/lookup.ts:1  TODO(br:U1708_agency) (U1708_agency is accepted)");
		expect(jobs[0]!.what).toContain("src/campaign/editor.ts:1  TODO(br:campaign editor owner) (names no unit)");
		expect(jobs[0]!.what).not.toContain("U2000_open");
		// the job did not remove them: tried again (a new run counts on), until the tries are used up
		for (let i = 1; i < SWEEP_TRIES; i++) await make().afterMerge("nestjs");
		expect(jobs.map((j) => j.stack)).toEqual(Array(SWEEP_TRIES).fill("nestjs"));
		// spent: the other stack adds what they wait for, then one more try here, then they stay (finish check)
		await make().afterMerge("nestjs");
		expect(jobs[SWEEP_TRIES]!.stack).toBe("symfony");
		expect(jobs[SWEEP_TRIES]!.what).toMatch(/Do not edit the nestjs project/);
		await make().afterMerge("nestjs");
		expect(jobs[SWEEP_TRIES + 1]!.stack).toBe("nestjs");
		for (let i = 0; i < 3; i++) await make().afterMerge("nestjs");
		expect(jobs).toHaveLength(SWEEP_TRIES + 2);
		expect(ledger.db.prepare("SELECT COUNT(*) n FROM questions WHERE point = 'stub_sweep'").get()).toEqual({ n: 0 });
	});

	it("an owner's retry to a question from an earlier version still gives the marks new tries", async () => {
		write("src/agency/lookup.ts", "export const lookup = () => []; // TODO(br:U1708_agency)\n");
		commit();
		const k = "nestjs\0U1708_agency\0src/agency/lookup.ts";
		ledger.setMeta("stub_sweep_handed", JSON.stringify({ [k]: SWEEP_TRIES }));
		ledger.setMeta("stub_sweep_backed", JSON.stringify({ [k]: 1 }));
		const q = ledger.askQuestion({ point: "stub_sweep", question: "q", options: ["retry", "leave"], blocks: "none", askedBy: "t" });
		ledger.setMeta("stub_sweep_asked", JSON.stringify({ [k]: q }));
		ledger.answerQuestion(q, "retry — give them to a code job again", "owner");
		const jobs: string[] = [];
		await createStubSweep({ ledger, dirOf: () => ws, codeJob: async (_s, what) => void jobs.push(what), log: () => {} }).afterMerge("nestjs");
		expect(jobs).toHaveLength(1);
	});

	it("an open question an earlier version asked is withdrawn: the other stacks' job takes it over", async () => {
		write("src/agency/lookup.ts", "export const lookup = () => []; // TODO(br:U1708_agency)\n");
		commit();
		const k = "nestjs\0U1708_agency\0src/agency/lookup.ts";
		ledger.setMeta("stub_sweep_handed", JSON.stringify({ [k]: SWEEP_TRIES }));
		const q = ledger.askQuestion({ point: "stub_sweep", question: "q", options: ["retry", "leave"], blocks: "none", askedBy: "t" });
		ledger.setMeta("stub_sweep_asked", JSON.stringify({ [k]: q }));
		const jobs: string[] = [];
		await createStubSweep({ ledger, dirOf: () => ws, codeJob: async (s) => void jobs.push(s), otherStacks: () => ["symfony"], log: () => {} }).afterMerge("nestjs");
		expect(ledger.getQuestion(q)!.status).toBe("withdrawn");
		expect(jobs).toEqual(["symfony"]);
	});

	it("an older ledger's handed list counts as one try each", async () => {
		write("src/agency/lookup.ts", "export const lookup = () => []; // TODO(br:U1708_agency)\n");
		commit();
		ledger.setMeta("stub_sweep_handed", JSON.stringify(["nestjs\0U1708_agency\0src/agency/lookup.ts"]));
		const jobs: string[] = [];
		await createStubSweep({ ledger, dirOf: () => ws, codeJob: async (_s, what) => void jobs.push(what), log: () => {} }).afterMerge("nestjs");
		expect(jobs).toHaveLength(1);
		expect(JSON.parse(ledger.getMeta("stub_sweep_handed")!)).toEqual({ "nestjs\0U1708_agency\0src/agency/lookup.ts": 2 });
	});

	it("many marks go in batches of whole files; marks no job has had come before ones tried already", async () => {
		for (let i = 0; i < SWEEP_BATCH + 5; i++) write(`src/s${String(i).padStart(2, "0")}.ts`, `export const s${i} = 0; // TODO(br:gone_unit)\n`);
		commit();
		const jobs: string[] = [];
		const sweep = createStubSweep({ ledger, dirOf: () => ws, codeJob: async (_s, what) => void jobs.push(what), log: () => {} });
		await sweep.afterMerge("nestjs");
		await sweep.afterMerge("nestjs");
		const count = (w: string) => w.split("\n").filter((l) => l.startsWith("- ")).length;
		expect(jobs.map(count)).toEqual([SWEEP_BATCH, 5]);
		expect(jobs[1]).toContain(`src/s${SWEEP_BATCH}.ts`);
	});

	it("loose owner names: a short id of a unit still to come is its mark; a model maps legacy names once; only names of no unit or of accepted units are swept", async () => {
		ledger.createUnit({ id: "U2210_controller_sales_controller", tier: "T0", symbolIds: [] });
		write("src/a.ts", "export const a = 0; // TODO(br:U2000)\n");
		write("src/b.ts", "export const b = 0; // TODO(br:sales.controller)\n");
		write("src/c.ts", "export const c = 0; // TODO(br:basedata controller)\n");
		write("src/d.ts", "export const d = 0; // TODO(br:U1708)\n");
		commit();
		const asked: string[][] = [];
		const jobs: string[] = [];
		const resolveOwners = async (names: string[]) => (asked.push(names), { "sales.controller": "U2210_controller_sales_controller", "basedata controller": null });
		const sweep = createStubSweep({ ledger, dirOf: () => ws, codeJob: async (_s, what) => void jobs.push(what), resolveOwners, log: () => {} });
		await sweep.afterMerge("nestjs");
		expect(asked).toEqual([["sales.controller", "basedata controller"]]);
		expect(markOwner(ledger, "U2000")).toBe("U2000_open");
		expect(markOwner(ledger, "sales.controller")).toBe("U2210_controller_sales_controller");
		expect(stubNames(ledger, "U2210_controller_sales_controller")).toEqual(["U2210_controller_sales_controller", "U2210", "sales.controller"]);
		expect(jobs[0]).not.toContain("src/a.ts");
		expect(jobs[0]).not.toContain("src/b.ts");
		expect(jobs[0]).toContain("src/c.ts:1  TODO(br:basedata controller) (names no unit)");
		expect(jobs[0]).toContain("src/d.ts:1  TODO(br:U1708) (U1708_agency is accepted)");
		// the model is not asked again about names it answered
		await createStubSweep({ ledger, dirOf: () => ws, codeJob: async () => {}, resolveOwners, log: () => {} }).afterMerge("nestjs");
		expect(asked).toHaveLength(1);
	});
});
