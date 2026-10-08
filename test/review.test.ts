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

	it("judges against the facts: write scope, policy, decided quirks, truth, planned owners, legacy callers, packages; out-of-scope asks are not findings", async () => {
		const { dir, ledger, config } = project();
		const sym = (unit: string, file: string, name: string, kind = "class") => {
			ledger.upsertFile({ path: file, hash: "h", lang: "php", loc: 10 });
			ledger.upsertSymbol({ id: `${file}::${name}`, path: file, kind, name });
			ledger.createUnit({ id: unit, tier: "T1", deps: [], meta: { files: [file] }, symbolIds: [`${file}::${name}`] });
		};
		sym("U10", "app/Campaign.php", "Campaign");
		sym("U20", "app/Mailer.php", "Mailer");
		sym("U30", "app/Factory.php", "Factory");
		ledger.db.prepare("INSERT INTO index_deps(from_id, to_id, kind) VALUES (?, ?, ?)").run("app/Campaign.php::Campaign", "app/Mailer.php::Mailer", "new");
		ledger.db.prepare("INSERT INTO index_deps(from_id, to_id, kind) VALUES (?, ?, ?)").run("app/Factory.php::Factory", "app/Campaign.php::Campaign", "new");
		ledger.db.prepare("INSERT INTO index_literal_refs(name, path, line) VALUES (?, ?, ?)").run("Campaign", "app/registry.php", 4);
		ledger.db.prepare("INSERT INTO truth_cases(id, unit_id, symbol_id, inputs, expected, verified_on_old, created_at) VALUES ('U10#1', 'U10', 'app/Campaign.php::Campaign', '[]', '1', 1, 'now')").run();
		ledger.db.prepare("INSERT INTO quirks(unit_id, symbol_id, kind, behaviour, opinion, why, status, decided_by, created_at) VALUES ('U10', 'app/Campaign.php::Campaign', 'language_artifact', 'loose in_array matches \"1\" and 1', 'drop', 'type juggling only', 'dropped', 'tester', 'now')").run();
		ledger.setMeta("framework_plan", JSON.stringify({ libraries: [{ name: "acme/mail", verdict: "replace", successor: "symfony/mailer" }] }));
		let task = "";
		let system = "";
		const spawn = (async (opts: SpawnOptions) => {
			system = opts.systemPrompt ?? "";
			return {
				run: async (t: string) => {
					task = t;
					await (opts.customTools!.find((x) => x.name === "review_verdict") as unknown as { execute: (i: string, p: object) => Promise<unknown> }).execute("x", { ok: false, findings: [], outOfScope: [{ problem: "the manifest does not map the Campaign namespace", fix: "add the mapping" }] });
					return { text: "done", toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } };
				},
				dispose() {},
			} as unknown as LeafSession;
		}) as never;
		const r = await reviewWithModel({ ledger, config, root: dir, unitId: "U10", adapter, targetProjectDir: dir, moduleDir: "src/features/campaign", legacyFiles: ["app/Campaign.php"], changedFiles: ["src/features/campaign/campaign.service.ts"], writeGlobs: ["src/features/campaign/**"], spawn });
		expect(task).toContain("The implementer may write only: src/features/campaign/**");
		expect(task).toMatch(/Behaviour policy:[\s\S]*not pinned/);
		expect(task).toMatch(/loose in_array .* → dropped/);
		expect(task).toContain("app/Campaign.php::Campaign: 1 case(s)");
		expect(task).toMatch(/app\/Mailer\.php::Mailer \(unit U20, planned, app\/Mailer\.php\)/);
		expect(task).toMatch(/Can the new code be reached the way these callers reached the old code\?\n- app\/Factory\.php::Factory \(new, unit U30\)\n- app\/registry\.php names "Campaign"/);
		expect(task).toContain("- acme/mail: replace → symfony/mailer");
		expect(system).toMatch(/goes in outOfScope, never in findings/);
		expect(r).toMatchObject({ ok: false, judged: true, outOfScope: "- the manifest does not map the Campaign namespace → add the mapping" });
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
