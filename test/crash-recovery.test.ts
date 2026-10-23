import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../src/config.ts";
import { addWorktree, commitAll, ensureRepo, git } from "../src/git.ts";
import { Ledger } from "../src/ledger/db.ts";
import { recoverCrashedAttempts, restoreKeptWork, worktreeDir } from "../src/run/run.ts";

describe("preserving interrupted migration work", () => {
	let root: string, target: string, wt: string, config: Config, ledger: Ledger;
	const code = "src/features/billing/service.ts";
	const test = "src/features/billing/service.spec.ts";
	const write = (p: string, text: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "br-crash-recovery-")); target = join(root, "target");
		write(join(target, code), "export const value = 1;\n");
		write(join(target, test), "// U1#1 baseline test\n");
		await ensureRepo(target); await commitAll(target, "baseline");
		config = ConfigSchema.parse({ source: { path: join(root, "legacy"), stack: "php" }, target: { path: target, stacks: ["nestjs"] }, models: {} });
		ledger = new Ledger(":memory:");
		ledger.createUnit({ id: "U1", tier: "T0", symbolIds: [], meta: { files: ["legacy.php"], place: { stack: "nestjs", area: "billing", source: "code", shared: false } } });
		ledger.transitionUnit("U1", "implementing", "in progress");
		ledger.startAttempt("U1", "implement");
		ledger.startAttempt("U1", "test");
		ledger.addEvidence("U1", "truth_green_on_old", { cases: 1 });
		write(join(root, ".bigrefactor/truth/U1/cases.json"), '[{"expected":1}]');
		wt = worktreeDir(root, "U1"); await addWorktree(target, wt, "unit/U1");
	});
	afterEach(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
	it("keeps tracked edits, new files and ported tests, then restores them on the next unit start", async () => {
		write(join(wt, code), "export const value = 2;\n");
		write(join(wt, "src/features/billing/new.ts"), "export const added = true;\n");
		write(join(wt, test), "// U1#1 stronger interrupted test\n");
		const r = await recoverCrashedAttempts({ ledger, config, root });
		expect(r).toEqual({ attempts: 2, preserved: ["U1"] });
		expect(ledger.getUnit("U1")!.state).toBe("planned");
		expect(ledger.db.prepare("SELECT outcome FROM attempts").all()).toEqual([{ outcome: "aborted:crash" }, { outcome: "aborted:crash" }]);
		expect(existsSync(wt)).toBe(false);
		expect(readFileSync(join(target, code), "utf8")).toContain("value = 1");
		expect(readFileSync(join(root, ".bigrefactor/truth/U1/ported", test), "utf8")).toContain("stronger interrupted test");
		expect(readFileSync(join(root, ".bigrefactor/truth/U1/cases.json"), "utf8")).toBe('[{"expected":1}]');
		expect(ledger.hasEvidence("U1", "truth_green_on_old")).toBe(true);
		await addWorktree(target, wt, "unit/U1");
		expect(await restoreKeptWork(ledger, wt, "U1")).toEqual([]);
		expect(readFileSync(join(wt, code), "utf8")).toContain("value = 2");
		expect(readFileSync(join(wt, "src/features/billing/new.ts"), "utf8")).toContain("added = true");
		expect(readFileSync(join(wt, test), "utf8")).toContain("stronger interrupted test");
	});
	it("keeps a clean unit commit that had not reached main before the crash", async () => {
		write(join(wt, code), "export const value = 3;\n");
		const sha = await commitAll(wt, "unit commit before crash");
		expect((await recoverCrashedAttempts({ ledger, config, root })).preserved).toEqual(["U1"]);
		expect(JSON.parse(ledger.getUnit("U1")!.meta).keptWork).toBe(sha);
	});
	it("retains the worktree and open attempts if its snapshot cannot be committed", async () => {
		write(join(wt, code), "export const value = 4;\n");
		const hook = join(target, ".git/hooks/pre-commit"); writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		await expect(recoverCrashedAttempts({ ledger, config, root })).rejects.toThrow(/cannot preserve interrupted work/);
		expect(existsSync(wt)).toBe(true);
		expect(readFileSync(join(wt, code), "utf8")).toContain("value = 4");
		expect(ledger.getUnit("U1")!.state).toBe("implementing");
		expect(ledger.db.prepare("SELECT COUNT(*) n FROM attempts WHERE ended_at IS NULL").get()).toEqual({ n: 2 });
	});
	it("closes dangling attempts without reopening an accepted unit", async () => {
		ledger.db.prepare("UPDATE units SET state='accepted' WHERE id='U1'").run();
		expect(await recoverCrashedAttempts({ ledger, config, root })).toEqual({ attempts: 2, preserved: [] });
		expect(ledger.getUnit("U1")!.state).toBe("accepted");
		expect(existsSync(wt)).toBe(true);
	});
	it("is idempotent and does not save an unchanged branch as new work", async () => {
		expect(await recoverCrashedAttempts({ ledger, config, root })).toEqual({ attempts: 2, preserved: [] });
		expect(JSON.parse(ledger.getUnit("U1")!.meta).keptWork).toBeUndefined();
		expect(await recoverCrashedAttempts({ ledger, config, root })).toEqual({ attempts: 0, preserved: [] });
		expect(await git(target, ["status", "--porcelain"])).toBe("");
	});
});
