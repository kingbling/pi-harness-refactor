import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nestjsAdapter } from "../src/adapters/target/nestjs.ts";
import type { TargetAdapter } from "../src/adapters/types.ts";
import { ConfigSchema } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { runGate } from "../src/run/gate.ts";
import { reviewWithModel } from "../src/run/review.ts";
import type { LeafSession, SpawnOptions } from "../src/sessions/spawn.ts";

/**
 * wired_ok is judged by a reviewer model with tools, not by pattern lists: its findings fail the gate and go back
 * to the implementer; a session without a verdict passes as "not judged"; the review never holds a CPU slot.
 */
const tick = { cmd: "true", args: [] as string[] };
const adapter: TargetAdapter = { ...nestjsAdapter, build: () => tick, lint: () => tick, test: () => tick };

function project() {
	const dir = mkdtempSync(join(tmpdir(), "br-review-"));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	mkdirSync(join(dir, "src", "features", "campaign"), { recursive: true });
	writeFileSync(join(dir, "src", "features", "campaign", "campaign.service.ts"), "export class CampaignService {\n  changes() { return []; } // TODO\n}\n");
	const ledger = new Ledger(":memory:");
	ledger.createUnit({ id: "u1", tier: "T1", deps: [], meta: {}, symbolIds: [] });
	const config = ConfigSchema.parse({ source: { path: dir, stack: "php" }, target: { path: dir, stacks: ["nestjs"] }, models: {} });
	return { dir, ledger, config };
}

/** A fake session that calls review_verdict with `verdict` (or never, when undefined). */
const reviewerSession = (verdict: object | undefined, seen: SpawnOptions[] = []) =>
	(async (opts: SpawnOptions): Promise<LeafSession> => {
		seen.push(opts);
		return {
			run: async (task: string) => {
				expect(task).toMatch(/new file src\/features\/campaign\/campaign\.service\.ts[\s\S]*TODO/);
				if (verdict) await (opts.customTools!.find((t) => t.name === "review_verdict") as unknown as { execute: (i: string, p: object) => Promise<unknown> }).execute("x", verdict);
				return { text: "done", toolCalls: 2, blocked: 0, usage: { input: 0, output: 0, cost: 0.01 } };
			},
			dispose() {},
		} as unknown as LeafSession;
	}) as never;

describe("wired_ok: the reviewer model", () => {
	it("judges read-only on the escalate model; its findings fail the gate with file, problem and fix", async () => {
		const { dir, ledger, config } = project();
		const seen: SpawnOptions[] = [];
		const finding = { file: "src/features/campaign/campaign.service.ts", line: 2, problem: "changes() returns [] where the legacy code lists every changed field", fix: "port the field comparison from mailchanges.cmd.php" };
		const review = (changedFiles: string[]) => reviewWithModel({ ledger, config, root: dir, unitId: "u1", adapter, targetProjectDir: dir, moduleDir: "src/features/campaign", legacyFiles: ["campaign/mailchanges.cmd.php"], changedFiles, spawn: reviewerSession({ ok: false, findings: [finding] }, seen) });
		const g = await runGate({ ledger, unitId: "u1", adapter, targetProjectDir: dir, writeGlobs: ["src/features/campaign/**"], testFiles: [], review });
		expect(g.failedStep).toBe("wired_ok");
		expect(g.steps.find((s) => s.name === "wired_ok")!.output).toMatch(/campaign\.service\.ts:2: changes\(\) returns \[\].*→ port the field comparison/);
		expect(seen[0]!.role).toBe("review");
		expect(seen[0]!.writeGlobs).toEqual([]);
	});

	it("no verdict (provider down, session cut) passes as not judged, marked in the evidence", async () => {
		const { dir, ledger, config } = project();
		const review = (changedFiles: string[]) => reviewWithModel({ ledger, config, root: dir, unitId: "u1", adapter, targetProjectDir: dir, moduleDir: "src/features/campaign", legacyFiles: [], changedFiles, spawn: reviewerSession(undefined) });
		const g = await runGate({ ledger, unitId: "u1", adapter, targetProjectDir: dir, writeGlobs: ["src/features/campaign/**"], testFiles: [], review });
		expect(g.ok).toBe(true);
		const ev = ledger.db.prepare("SELECT payload FROM evidence WHERE unit_id = 'u1' AND type = 'wired_ok'").get() as { payload: string };
		expect(JSON.parse(ev.payload)).toMatchObject({ judged: false });
	});

	it("the review runs outside the CPU slot; the commands inside it", async () => {
		const { dir, ledger } = project();
		let inSlot = false;
		const slotted: boolean[] = [];
		const slot = async <T,>(fn: () => Promise<T>) => ((inSlot = true), await fn().finally(() => (inSlot = false)));
		const review = async () => (slotted.push(inSlot), { ok: true, output: "fine", judged: true });
		const g = await runGate({ ledger, unitId: "u1", adapter, targetProjectDir: dir, writeGlobs: ["src/features/campaign/**"], testFiles: [], review, slot });
		expect(g.ok).toBe(true);
		expect(slotted).toEqual([false]);
	});
});
