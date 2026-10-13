import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { renderStatus } from "../src/dashboard/status.ts";
import { judgeRun, MAX_PARITY_REOPENS, type ParityJudge } from "../src/run/parity-judge.ts";
import { applyParityAnswers, MAX_PARITY_ERRORS, parityAgain } from "../src/run/run.ts";
import { RESOLVER } from "../src/jev/resolve.ts";
import { routeOwners } from "../src/run/parity-check.ts";
import { LEGACY, loadApps, saveApp } from "../src/run/parity.ts";

/**
 * The judge sorts each difference into a bug of the new app (the unit is re-opened with it) or a quirk of the old
 * app (the owner decides). There is no "fine"; once the owner dropped a quirk, the same difference is allowed.
 */
function workspace() {
	const root = mkdtempSync(join(tmpdir(), "br-parityjudge-"));
	mkdirSync(join(root, ".bigrefactor"), { recursive: true });
	const config = ConfigSchema.parse({ source: { path: join(root, "legacy"), stack: "php" }, target: { path: join(root, "new"), stacks: ["nestjs"] }, models: {} });
	const ledger = new Ledger(":memory:");
	// accepted as if the gate had passed (the ledger wants the gate's evidence for a real transition)
	const accept = (id: string) => ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = ?").run(id);
	for (const id of ["U1", "U2"]) {
		const file = `src/${id}.php`;
		ledger.upsertFile({ path: file, hash: "h", lang: "php", loc: 10 });
		ledger.upsertSymbol({ id: `${file}::f`, path: file, kind: "function", name: "f" });
		ledger.createUnit({ id, tier: "T0", symbolIds: [`${file}::f`], meta: { files: [file], slice: "invoices" } });
		accept(id);
	}
	const run = (diffs: Array<{ step: string; path: string; legacy: unknown; target: unknown }>) => {
		const id = Number(ledger.db.prepare("INSERT INTO parity_runs(slice, outcome, started_at) VALUES ('invoices', 'differs', datetime('now'))").run().lastInsertRowid);
		for (const d of diffs) ledger.db.prepare("INSERT INTO parity_diffs(run_id, slice, step, route, kind, path, legacy, target) VALUES (?, 'invoices', ?, 'GET /invoices/{id}', 'body', ?, ?, ?)").run(id, d.step, d.path, JSON.stringify(d.legacy), JSON.stringify(d.target));
		return id;
	};
	const ids = (runId: number) => (ledger.db.prepare("SELECT id FROM parity_diffs WHERE run_id = ? ORDER BY id").all(runId) as Array<{ id: number }>).map((r) => r.id);
	const status = (runId: number) => (ledger.db.prepare("SELECT status FROM parity_diffs WHERE run_id = ? ORDER BY id").all(runId) as Array<{ status: string }>).map((r) => r.status);
	return { root, config, ledger, run, ids, status, accept };
}

describe("judging parity differences", () => {
	it("a bug re-opens the unit with the difference as its finding; after a few re-opens the owner is asked instead", async () => {
		const { root, config, ledger, run, ids, status, accept } = workspace();
		for (let i = 0; i <= MAX_PARITY_REOPENS; i++) {
			const r = run([{ step: "one", path: "body.total", legacy: 10, target: 11 }]);
			const judge: ParityJudge = async (o) => (expect(o.facts).toMatch(/body\.total: old 10, new 11/), [{ diffs: ids(r), verdict: "bug", unit: "U1", problem: "the total leaves out the tax", fix: "add the tax like Pricing::total" }]);
			const res = await judgeRun({ ledger, config, root, runId: r, slice: "invoices", judge, log: () => {} });
			expect(status(r)).toEqual(["bug"]);
			if (i < MAX_PARITY_REOPENS) {
				expect(res.reopened).toEqual(["U1"]);
				const u = ledger.getUnit("U1")!;
				expect(u.state).toBe("planned");
				expect(JSON.parse(u.meta).retryNote).toMatch(/body\.total: old 10, new 11[\s\S]*add the tax/);
				accept("U1");
			} else {
				expect(res.reopened).toEqual([]);
				expect(ledger.getUnit("U1")!.state).toBe("accepted");
				expect(ledger.openQuestions().filter((q) => q.point === "parity")).toHaveLength(1);
			}
		}
	});

	it("a quirk goes to the owner, never dropped on the judge's word; once dropped the same difference is allowed, once kept it is a bug", async () => {
		const { root, config, ledger, run, ids, status } = workspace();
		const r1 = run([{ step: "list", path: "body.items[0].name", legacy: "Acme ", target: "Acme" }]);
		const quirk: ParityJudge = async () => [{ diffs: ids(r1), verdict: "quirk", unit: "U2", problem: "the old app keeps a trailing space in names", why: "looks like a missing trim", opinion: "drop" }];
		await judgeRun({ ledger, config, root, runId: r1, slice: "invoices", judge: quirk, log: () => {} });
		expect(status(r1)).toEqual(["quirk"]);
		const q = ledger.db.prepare("SELECT id, status, kind FROM quirks").get() as { id: number; status: string; kind: string };
		expect(q.status).not.toBe("dropped"); // the owner decides
		expect(ledger.getUnit("U2")!.state).toBe("accepted");

		// the owner drops it: the same place differs again → allowed, the judge is not asked
		ledger.db.prepare("UPDATE quirks SET status = 'dropped' WHERE id = ?").run(q.id);
		const r2 = run([{ step: "list", path: "body.items[0].name", legacy: "Acme ", target: "Acme" }]);
		const never: ParityJudge = async () => {
			throw new Error("asked");
		};
		expect(await judgeRun({ ledger, config, root, runId: r2, slice: "invoices", judge: never, log: () => {} })).toMatchObject({ allowed: 1, open: 0 });
		expect(status(r2)).toEqual(["allowed"]);

		// had the owner kept it, the new app must copy it: a bug of that unit
		ledger.db.prepare("UPDATE quirks SET status = 'kept' WHERE id = ?").run(q.id);
		const r3 = run([{ step: "list", path: "body.items[0].name", legacy: "Acme ", target: "Acme" }]);
		const res = await judgeRun({ ledger, config, root, runId: r3, slice: "invoices", judge: never, log: () => {} });
		expect(status(r3)).toEqual(["bug"]);
		expect(res.reopened).toEqual(["U2"]);
		expect(JSON.parse(ledger.getUnit("U2")!.meta).retryNote).toMatch(/the owner kept the old behaviour/);
	});

	it("br status shows each slice's last comparison and what its differences became", async () => {
		const { root, config, ledger, run, ids } = workspace();
		ledger.db.prepare("INSERT INTO parity_runs(slice, outcome, started_at) VALUES ('invoices', 'error', datetime('now'))").run(); // older: replaced below
		const r = run([{ step: "one", path: "body.total", legacy: 10, target: 11 }]);
		await judgeRun({ ledger, config, root, runId: r, slice: "invoices", judge: async () => [{ diffs: ids(r), verdict: "bug", unit: "U1", problem: "tax" }], log: () => {} });
		ledger.db.prepare("INSERT INTO parity_runs(slice, outcome, started_at) VALUES ('auth', 'error', datetime('now'))").run();
		const line = renderStatus(ledger, { color: false }).split("\n").find((l) => l.startsWith("parity"))!;
		expect(line).toMatch(/same 0 +differ 1 +not compared 1 +differences: bugs 1 +quirks 0/);
		expect(line).toMatch(/not compared: auth/);
	});

	it("a difference only the test setup causes re-opens no unit: it goes to that app's parity setup, and the judge sees how each app runs", async () => {
		const { root, config, ledger, run, ids, status } = workspace();
		saveApp(root, LEGACY, { up: true, said: "starts with docker at http://localhost:18080/login" });
		saveApp(root, "nestjs", { up: true, said: "no database snapshot could be loaded" });
		const r = run([{ step: "one", path: "body.total", legacy: 10, target: null }]);
		const judge: ParityJudge = async (o) => (expect(o.facts).toMatch(/nestjs: ready at \?; no database snapshot/), [{ diffs: ids(r), verdict: "setup", unit: "", app: "nestjs", problem: "the new app runs without the snapshot data" }]);
		const res = await judgeRun({ ledger, config, root, runId: r, slice: "invoices", judge, log: () => {} });
		expect(res).toMatchObject({ setup: 1, bugs: 0, reopened: [] });
		expect(status(r)).toEqual(["setup"]);
		expect(ledger.getUnit("U1")!.state).toBe("accepted");
		expect(loadApps(root)["nestjs"]!.setupProblem).toMatch(/body\.total[\s\S]*without the snapshot data/);
	});

	it("a verdict naming an unknown unit or another run's differences changes nothing; what is not judged stays open", async () => {
		const { root, config, ledger, run, ids, status } = workspace();
		const r = run([
			{ step: "a", path: "body.x", legacy: 1, target: 2 },
			{ step: "b", path: "body.y", legacy: 1, target: 2 },
		]);
		const judge: ParityJudge = async () => [
			{ diffs: [ids(r)[0]!], verdict: "bug", unit: "U99", problem: "?" },
			{ diffs: [99999], verdict: "bug", unit: "U1", problem: "?" },
		];
		expect(await judgeRun({ ledger, config, root, runId: r, slice: "invoices", judge, log: () => {} })).toMatchObject({ open: 2, reopened: [] });
		expect(status(r)).toEqual(["open", "open"]);
	});
	it("an owner's leave is remembered: a later comparison that still differs does not ask again", async () => {
		const { root, config, ledger, run, ids } = workspace();
		ledger.updateUnit("U1", { meta: { parityReopens: MAX_PARITY_REOPENS, parityLeft: 7 } });
		const r = run([{ step: "one", path: "body.total", legacy: 10, target: 11 }]);
		const res = await judgeRun({ ledger, config, root, runId: r, slice: "invoices", judge: async () => [{ diffs: ids(r), verdict: "bug", unit: "U1", problem: "tax" }], log: () => {} });
		expect(res.reopened).toEqual([]);
		expect(ledger.openQuestions().filter((q) => q.point === "parity")).toHaveLength(0);
	});

	it("a model's retry gives a unit one more parity re-open; the owner's retry a fresh set", () => {
		const { ledger } = workspace();
		for (const [unit, by] of [["U1", RESOLVER], ["U2", "human"]] as const) {
			ledger.updateUnit(unit, { meta: { parityReopens: MAX_PARITY_REOPENS } });
			const q = ledger.askQuestion({ unitId: unit, point: "parity", question: "still differs", options: ["retry", "leave"], blocks: "none", askedBy: "parity" });
			ledger.answerQuestion(q, "retry", by);
		}
		expect(applyParityAnswers(ledger)).toEqual(["invoices", "invoices"]);
		expect(JSON.parse(ledger.getUnit("U1")!.meta).parityReopens).toBe(MAX_PARITY_REOPENS - 1);
		expect(JSON.parse(ledger.getUnit("U2")!.meta).parityReopens).toBe(0);
		// used once per answer
		expect(applyParityAnswers(ledger)).toEqual([]);
	});

	it("a slice's route owners are the units holding its routes' handlers, not its pages", () => {
		const { ledger } = workspace();
		ledger.db.prepare("INSERT INTO index_routes(side, method, path, handler_symbol) VALUES ('source', 'GET', '/invoices', 'src/U1.php::f')").run();
		ledger.db.prepare("UPDATE units SET state = 'planned' WHERE id = 'U2'").run();
		expect(routeOwners(ledger, "invoices")).toEqual([{ id: "U1", state: "accepted" }]);
	});

	it("at run start: an error is compared again a few times, unjudged differences again, a decided quirk once", () => {
		const { ledger, run, ids } = workspace();
		const add = (slice: string, outcome: string) => ledger.db.prepare("INSERT INTO parity_runs(slice, outcome, started_at) VALUES (?, ?, datetime('now'))").run(slice, outcome);
		add("auth", "error");
		add("users", "same");
		expect(parityAgain(ledger)).toEqual({ checked: new Set(["auth", "users"]), again: new Set(["auth"]) });
		for (let i = 1; i < MAX_PARITY_ERRORS; i++) add("auth", "error");
		expect(parityAgain(ledger).again.has("auth")).toBe(false); // errored too often in a row: left alone
		// differences nobody judged (the judge failed): compared again
		const r = run([{ step: "one", path: "body.total", legacy: 10, target: 11 }]);
		expect(parityAgain(ledger).again.has("invoices")).toBe(true);
		// a quirk the owner decided: compared again once; a later run that judged it is not queued again
		const quirk = Number(ledger.db.prepare("INSERT INTO quirks(unit_id, symbol_id, kind, behaviour, opinion, why, status, created_at) VALUES ('U1', 's', 'suspected_bug', 'b', 'drop', 'w', 'kept', datetime('now'))").run().lastInsertRowid);
		ledger.db.prepare("UPDATE parity_diffs SET status = 'quirk', quirk_id = ? WHERE id = ?").run(quirk, ids(r)[0]!);
		expect(parityAgain(ledger).again.has("invoices")).toBe(true);
		const r2 = run([{ step: "one", path: "body.total", legacy: 10, target: 11 }]);
		ledger.db.prepare("UPDATE parity_diffs SET status = 'bug', quirk_id = ? WHERE id = ?").run(quirk, ids(r2)[0]!);
		expect(parityAgain(ledger).again.has("invoices")).toBe(false);
	});

	it("at run start: a slice compared on an older main is compared again; the same main or an unknown one is not", () => {
		const { ledger } = workspace();
		const add = (slice: string, sha: string | null) => ledger.db.prepare("INSERT INTO parity_runs(slice, outcome, started_at, commit_sha) VALUES (?, 'same', datetime('now'), ?)").run(slice, sha);
		add("invoices", "aaa");
		add("users", "bbb");
		add("auth", null); // from before commits were recorded
		expect(parityAgain(ledger, "bbb").again).toEqual(new Set(["invoices"]));
		expect(parityAgain(ledger).again).toEqual(new Set());
	});
});
