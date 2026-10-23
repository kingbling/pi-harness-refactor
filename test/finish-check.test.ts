import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TargetAdapter } from "../src/adapters/types.ts";
import { ConfigSchema, type Config } from "../src/config.ts";
import { commitAll, ensureRepo } from "../src/git.ts";
import { Ledger } from "../src/ledger/db.ts";
import { FINISH_PASSES, finishCheck, finishDue, finishPrompt, lastFinish, notProven, renderFinishLine, type FinishFinder } from "../src/run/finish-check.ts";

/**
 * The finish check: when no unit is left to run, the app as a whole is checked for work no unit will do. Code counts
 * the stub marks and runs the migrations on an empty database; a model finds the rest; gaps go to code jobs, and only
 * what a person must settle to the owner.
 */
let root: string;
let target: string;
let config: Config;
let ledger: Ledger;
const adapter = (o: { migrate?: { cmd: string; args: string[] } } = {}) => ({ id: "web", role: "ui", ...(o.migrate ? { migrateFresh: () => o.migrate } : {}) }) as unknown as TargetAdapter;

beforeEach(async () => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "br-finish-")));
	target = join(root, "new");
	mkdirSync(join(target, "src"), { recursive: true });
	writeFileSync(join(target, "src", "main.tsx"), "render(<App />)\n");
	writeFileSync(join(target, "src", "App.tsx"), "export const App = () => null; // TODO(br:U1_done)\n// TODO(br:U2_open) later\n// TODO(br:prefs.controller) no unit\n");
	await ensureRepo(target, "migration/main", []);
	await commitAll(target, "init");
	config = ConfigSchema.parse({ source: { path: root, stack: "php" }, target: { path: target, stacks: ["web"], git: { branch: "migration/main" } }, models: {} });
	ledger = new Ledger(":memory:");
	ledger.createUnit({ id: "U1_done", tier: "T0", symbolIds: [] });
	ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = 'U1_done'").run();
	ledger.createUnit({ id: "U2_open", tier: "T0", symbolIds: [] });
});
afterEach(() => {
	ledger.close();
	rmSync(root, { recursive: true, force: true });
});

describe("finish check", () => {
	it("counts the marks, hands the model's gaps and a failing migration to one code job per stack, asks the owner only what a person must settle", async () => {
		let facts = "";
		let cwd = "";
		const finder: FinishFinder = async (o) => {
			facts = o.facts;
			cwd = o.dir;
			return [
				{ stack: "web", problem: "src/App.tsx: loadPreferences is never passed by src/main.tsx", fix: "pass the preferences loader in src/main.tsx" },
				{ stack: "web", problem: "the frontend calls /user/auth/sidebar-context; no backend route serves it", fix: "call /user/auth/dashboard-context" },
				{ stack: "web", problem: "production serving of the built frontend", fix: "nginx config", human: "which web server runs in production is the owner's" },
				{ stack: "nope", problem: "not a stack", fix: "x" },
			];
		};
		const jobs: Array<[string, string]> = [];
		const swept: string[] = [];
		const asked: string[] = [];
		const r = await finishCheck({ ledger, config, root, adapters: new Map([["web", adapter({ migrate: { cmd: "sh", args: ["-c", "echo table users exists; exit 1"] } })]]), linkAll: () => {}, log: () => {}, finder, codeJob: async (s, what) => (jobs.push([s, what]), true), sweep: async (s) => void swept.push(s), ask: async (f) => (asked.push(f), 7) });
		expect(r.marks).toBe(3);
		expect(r.deadMarks).toBe(2); // the accepted owner and the one that names no unit
		// the model looked at main in a worktree of its own, and was told which work is still open
		expect(cwd).not.toBe(target);
		expect(existsSync(cwd)).toBe(false);
		expect(facts).toContain("U2_open (planned)");
		expect(facts).toContain("- web: ./ (ui)");
		expect(swept).toEqual(["web"]);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]![1]).toContain("loadPreferences is never passed by src/main.tsx");
		expect(jobs[0]![1]).toContain("/user/auth/sidebar-context");
		expect(jobs[0]![1]).toContain("the migrations fail on a new empty database");
		expect(jobs[0]![1]).toContain("table users exists");
		expect(jobs[0]![1]).not.toContain("nginx");
		expect(r.items.some((i) => i.stack === "nope")).toBe(false);
		expect(asked).toHaveLength(1);
		expect(asked[0]).toContain("which web server runs in production");
		expect(r).toMatchObject({ acted: true, handed: 3, merged: 3, asked: 7 });
		expect(lastFinish(ledger)?.head).toBe(r.head);
		expect(renderFinishLine(r)).toContain("stub marks 3 (2 no unit will replace)");
		expect(renderFinishLine(r)).toContain("for you 1");
	});

	it("on demand it only reports: nothing is handed on, so the run still acts on that commit; a finder that fails leaves the rest of the report", async () => {
		const r = await finishCheck({ ledger, config, root, adapters: new Map([["web", adapter()]]), linkAll: () => {}, log: () => {}, finder: async () => Promise.reject(new Error("model down")) });
		expect(r).toMatchObject({ acted: false, handed: 0, marks: 3, notJudged: "model down" });
		expect(renderFinishLine(r)).toContain("not judged: model down");
	});

	it("the run checks each main commit once it acted on (also after a restart), a few passes a run; an on-demand report does not count", async () => {
		expect(finishDue(ledger, "abc", 0)).toBe(true);
		expect(finishDue(ledger, undefined, 0)).toBe(false);
		const shown = await finishCheck({ ledger, config, root, adapters: new Map([["web", adapter()]]), linkAll: () => {}, log: () => {}, finder: async () => [] });
		expect(finishDue(ledger, shown.head, 0)).toBe(true);
		const acted = await finishCheck({ ledger, config, root, adapters: new Map([["web", adapter()]]), linkAll: () => {}, log: () => {}, finder: async () => [], codeJob: async () => false });
		expect(finishDue(ledger, acted.head, 0)).toBe(false);
		expect(finishDue(ledger, "a-newer-main", 0)).toBe(true);
		expect(finishDue(ledger, "a-newer-main", FINISH_PASSES)).toBe(false);
	});

	it("says what accepted does not prove: expected values only read, slices never compared with the old app", () => {
		ledger.updateUnit("U1_done", { meta: { slice: "booking" } });
		ledger.addEvidence("U1_done", "truth_read", {});
		expect(notProven(ledger)).toEqual({ readNotRun: 1, neverCompared: ["booking"] });
		ledger.addEvidence("U1_done", "truth_none", { reason: "checked declaration supersedes the earlier read capture" });
		expect(notProven(ledger).readNotRun).toBe(0);
	});

	it("the finder is told to follow the app from its entry, match frontend calls with backend routes and check the stacks are joined", () => {
		const p = finishPrompt(config);
		expect(p).toMatch(/entry point/);
		expect(p).toMatch(/no backend route serves/);
		expect(p).toMatch(/proxy/);
	});
});
