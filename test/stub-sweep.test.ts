import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger/db.ts";
import { createStubSweep, SWEEP_BATCH } from "../src/run/stub-sweep.ts";

/**
 * Stub marks already on main whose owner is accepted or names no unit: no unit replaces them, so after a merge a code
 * job gets them, each once. Marks of units still to run stay theirs.
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

describe("stub sweep", () => {
	it("hands the marks of accepted owners and of no unit to one code job, once; a still open unit keeps its marks", async () => {
		write("src/agency/lookup.ts", "export const lookup = () => []; // TODO(br:U1708_agency)\n");
		write("src/campaign/editor.ts", "// TODO(br:campaign editor owner) stub\nexport const e = 1;\n");
		write("src/open/x.ts", "export const x = 0; // TODO(br:U2000_open)\n");
		commit();
		const jobs: string[] = [];
		const sweep = createStubSweep({ ledger, dirOf: () => ws, codeJob: async (_s, what) => void jobs.push(what), log: () => {} });
		await sweep.afterMerge("nestjs");
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toContain("src/agency/lookup.ts:1  TODO(br:U1708_agency) (U1708_agency is accepted)");
		expect(jobs[0]).toContain("src/campaign/editor.ts:1  TODO(br:campaign editor owner) (names no unit)");
		expect(jobs[0]).not.toContain("U2000_open");
		// the job did not remove them: they are not handed again after every merge
		await sweep.afterMerge("nestjs");
		expect(jobs).toHaveLength(1);
		// a new run (same ledger) does not hand them again either; a mark new on main is handed
		write("src/agency/more.ts", "export const more = 0; // TODO(br:U1708_agency)\n");
		commit();
		const again = createStubSweep({ ledger, dirOf: () => ws, codeJob: async (_s, what) => void jobs.push(what), log: () => {} });
		await again.afterMerge("nestjs");
		expect(jobs).toHaveLength(2);
		expect(jobs[1]).toContain("src/agency/more.ts:1");
		expect(jobs[1]).not.toContain("src/agency/lookup.ts");
	});

	it("many marks go in batches of whole files, the rest after the next merge", async () => {
		for (let i = 0; i < SWEEP_BATCH + 5; i++) write(`src/s${i}.ts`, `export const s${i} = 0; // TODO(br:gone_unit)\n`);
		commit();
		const jobs: string[] = [];
		const sweep = createStubSweep({ ledger, dirOf: () => ws, codeJob: async (_s, what) => void jobs.push(what), log: () => {} });
		await sweep.afterMerge("nestjs");
		await sweep.afterMerge("nestjs");
		await sweep.afterMerge("nestjs");
		expect(jobs).toHaveLength(2);
		const count = (w: string) => w.split("\n").filter((l) => l.startsWith("- ")).length;
		expect(jobs.map(count)).toEqual([SWEEP_BATCH, 5]);
	});
});
