import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { renderStatus } from "../src/dashboard/status.ts";
import { describeDiff, judgeRun, MAX_PARITY_REOPENS, MAX_SHARED_JOBS, runSharedJob, sharedCauses, sharedJobText, updateShared, type ParityJudge } from "../src/run/parity-judge.ts";
import { applyParityAnswers, MAX_PARITY_ERRORS, parityAgain, parityOnAccept } from "../src/run/run.ts";
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
				const q = ledger.openQuestions().filter((q) => q.point === "parity");
				expect(q).toHaveLength(1);
				// the problem is where the answers differ: the resolver's tries on other differences of U1 are not its tries
				expect(JSON.parse(q[0]!.context!).sameAs).toBe("parity:U1:GET /invoices/{id} body.total");
			}
		}
	});

	it("a unit that came back from a parity re-open without changing any code is not re-opened again: the question is asked", async () => {
		const { root, config, ledger, run, ids } = workspace();
		const judge = (r: number): ParityJudge => async () => [{ diffs: ids(r), verdict: "bug", unit: "U1", problem: "the session row differs", fix: "save it like the old Session helper" }];
		const first = run([{ step: "one", path: "data.sessions", legacy: "a", target: "b" }]);
		expect((await judgeRun({ ledger, config, root, runId: first, slice: "invoices", judge: judge(first), log: () => {} })).reopened).toEqual(["U1"]);
		// its implementer found nothing to change: accepted again with the same code
		ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = 'U1'").run();
		ledger.db.prepare("INSERT INTO transitions(entity, entity_id, from_state, to_state, reason, created_at) VALUES ('unit', 'U1', 'review', 'accepted', 'merged (no changes)', datetime('now'))").run();
		const again = run([{ step: "one", path: "data.sessions", legacy: "a", target: "b" }]);
		expect((await judgeRun({ ledger, config, root, runId: again, slice: "invoices", judge: judge(again), log: () => {} })).reopened).toEqual([]);
		expect(ledger.getUnit("U1")!.state).toBe("accepted");
		const q = ledger.openQuestions().filter((q) => q.point === "parity");
		expect(q).toHaveLength(1);
		expect(`${q[0]!.question} ${q[0]!.context}`).toMatch(/without changing any code/);
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
		// routes a slice skipped are shown next to its outcome
		ledger.db.prepare("INSERT INTO parity_runs(slice, outcome, skipped, started_at) VALUES ('users', 'same', 3, datetime('now'))").run();
		expect(renderStatus(ledger, { color: false }).split("\n").find((l) => l.startsWith("parity"))).toMatch(/same 1 .*routes skipped 3/);
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

	it("the same setup difference is not judged again, and a run left with only setup differences answers like the old app", async () => {
		const { root, config, ledger, run, ids, status } = workspace();
		saveApp(root, "nestjs", { up: true });
		const r1 = run([{ step: "one", path: "data.sessions", legacy: "a", target: "b" }]);
		await judgeRun({ ledger, config, root, runId: r1, slice: "invoices", judge: async () => [{ diffs: ids(r1), verdict: "setup", unit: "", app: "nestjs", problem: "the session keeps the server address" }], log: () => {} });
		expect(ledger.db.prepare("SELECT outcome, note FROM parity_runs WHERE id = ?").get(r1)).toMatchObject({ outcome: "same", note: expect.stringMatching(/only from the test setup/) });
		saveApp(root, "nestjs", { setupProblem: undefined });
		// the next run: the same difference is setup again without the judge; a new one is still judged
		const r2 = run([{ step: "one", path: "data.sessions", legacy: "a", target: "b" }, { step: "one", path: "body.total", legacy: 10, target: 11 }]);
		const asked: string[] = [];
		const judge: ParityJudge = async (o) => (asked.push(o.facts), [{ diffs: [ids(r2)[1]!], verdict: "bug", unit: "U1", problem: "tax" }]);
		const res = await judgeRun({ ledger, config, root, runId: r2, slice: "invoices", judge, log: () => {} });
		expect(res).toMatchObject({ setup: 1, bugs: 1 });
		expect(status(r2)).toEqual(["setup", "bug"]);
		expect(asked[0]).not.toMatch(/data\.sessions/);
		expect(loadApps(root)["nestjs"]!.setupProblem).toBeUndefined();
		expect(ledger.db.prepare("SELECT outcome FROM parity_runs WHERE id = ?").get(r2)).toEqual({ outcome: "differs" });
		// only the remembered setup difference: no judge at all
		const r3 = run([{ step: "one", path: "data.sessions", legacy: "a", target: "b" }]);
		await judgeRun({ ledger, config, root, runId: r3, slice: "invoices", judge: async () => { throw new Error("not asked"); }, log: () => {} });
		expect(status(r3)).toEqual(["setup"]);
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
		expect(parityAgain(ledger)).toEqual({ checked: new Set(["auth", "users"]), again: new Set(["auth"]), fixed: new Set() });
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

	it("an app that did not start here never counts as an error of the code: such a slice is compared again", () => {
		const { ledger } = workspace();
		const add = (slice: string, outcome: string) => ledger.db.prepare("INSERT INTO parity_runs(slice, outcome, started_at) VALUES (?, ?, datetime('now'))").run(slice, outcome);
		for (let i = 0; i < MAX_PARITY_ERRORS + 2; i++) add("auth", "setup");
		expect(parityAgain(ledger).again.has("auth")).toBe(true);
		// setup runs between real errors neither count nor reset the count
		add("auth", "error");
		add("auth", "setup");
		for (let i = 1; i < MAX_PARITY_ERRORS; i++) add("auth", "error");
		expect(parityAgain(ledger).again.has("auth")).toBe(false);
	});

	it("a fix of a unit the last comparison blamed, accepted after it, is compared: again at run start and on its accept, even after too many errors", () => {
		const { ledger } = workspace();
		const id = Number(ledger.db.prepare("INSERT INTO parity_runs(slice, outcome, started_at, ended_at, commit_sha) VALUES ('invoices', 'differs', '2026-10-14T23:36:00.000Z', '2026-10-14T23:47:00.000Z', 'aaa')").run().lastInsertRowid);
		ledger.db.prepare("INSERT INTO parity_diffs(run_id, slice, step, route, kind, path, legacy, target, status, unit_id) VALUES (?, 'invoices', 's1', 'GET /x', 'status', 'status', '302', '503', 'bug', 'U1')").run(id);
		const accepted = (unit: string, at: string) => ledger.db.prepare("INSERT INTO transitions(entity, entity_id, from_state, to_state, created_at) VALUES ('unit', ?, 'review', 'accepted', ?)").run(unit, at);
		accepted("U1", "2026-10-14T20:00:00.000Z"); // before the comparison: already in it
		accepted("U2", "2026-10-15T01:00:00.000Z"); // not blamed
		expect(parityAgain(ledger).fixed.has("invoices")).toBe(false);
		expect(parityAgain(ledger, "aaa").again.has("invoices")).toBe(false);
		accepted("U1", "2026-10-15T01:21:31.985Z");
		expect(parityAgain(ledger).fixed.has("invoices")).toBe(true);
		expect(parityAgain(ledger, "aaa").again.has("invoices")).toBe(true);
		// the comparisons after the fix errored too often: left alone again, until the next fix
		for (let i = 0; i < MAX_PARITY_ERRORS; i++) ledger.db.prepare("INSERT INTO parity_runs(slice, outcome, started_at) VALUES ('invoices', 'error', ?)").run(`2026-10-15T02:0${i}:00.000Z`);
		expect(parityAgain(ledger).again.has("invoices")).toBe(false);
		expect(parityAgain(ledger).fixed.has("invoices")).toBe(false);
		accepted("U1", "2026-10-15T03:00:00.000Z");
		expect(parityAgain(ledger).again.has("invoices")).toBe(true);
	});

	it("a fix is told from an accept before the comparison when the run's times are in the older space format", () => {
		const { ledger } = workspace();
		// older runs: 'YYYY-MM-DD HH:MM:SS' (UTC); accepts: ISO with a T. Compared as text, every same-day accept looks later
		const id = Number(ledger.db.prepare("INSERT INTO parity_runs(slice, outcome, started_at, ended_at) VALUES ('invoices', 'differs', '2026-10-13 17:30:00', '2026-10-13 17:43:15')").run().lastInsertRowid);
		ledger.db.prepare("INSERT INTO parity_diffs(run_id, slice, step, route, kind, path, legacy, target, status, unit_id) VALUES (?, 'invoices', 's1', 'GET /x', 'status', 'status', '302', '503', 'bug', 'U1')").run(id);
		const accepted = (at: string) => ledger.db.prepare("INSERT INTO transitions(entity, entity_id, from_state, to_state, created_at) VALUES ('unit', 'U1', 'review', 'accepted', ?)").run(at);
		accepted("2026-10-13T09:00:00.000Z");
		expect(parityAgain(ledger).fixed.has("invoices")).toBe(false);
		accepted("2026-10-13T21:50:33.347Z");
		expect(parityAgain(ledger).fixed.has("invoices")).toBe(true);
	});

	it("parityAgain reads each blamed unit's own transitions, not every unit transition per slice (it ran at every accept and held the run a second)", () => {
		const { ledger } = workspace();
		const tr = ledger.db.prepare("INSERT INTO transitions(entity, entity_id, from_state, to_state, created_at) VALUES ('unit', ?, 'planned', ?, '2026-10-15T01:00:00.000Z')");
		ledger.db.exec("BEGIN");
		for (let i = 0; i < 20_000; i++) tr.run(`X${i % 2000}`, i % 3 ? "implementing" : "accepted");
		for (let s = 0; s < 10; s++) {
			const id = Number(ledger.db.prepare("INSERT INTO parity_runs(slice, outcome, started_at, ended_at) VALUES (?, 'differs', '2026-10-14T23:36:00.000Z', '2026-10-14T23:47:00.000Z')").run(`s${s}`).lastInsertRowid);
			ledger.db.prepare("INSERT INTO parity_diffs(run_id, slice, step, route, kind, path, legacy, target, status, unit_id) VALUES (?, ?, 's1', 'GET /x', 'status', 'status', '302', '503', 'bug', 'U1')").run(id, `s${s}`);
		}
		ledger.db.exec("COMMIT");
		const sqls: string[] = [];
		const prepare = ledger.db.prepare.bind(ledger.db);
		ledger.db.prepare = ((sql: string) => (sqls.push(sql), prepare(sql))) as typeof ledger.db.prepare;
		expect(parityAgain(ledger).fixed.size).toBe(0);
		ledger.db.prepare = prepare;
		const plan = (ledger.db.prepare(`EXPLAIN QUERY PLAN ${sqls[0]}`).all() as Array<{ detail: string }>).map((r) => r.detail).filter((l) => /\bt\b/.test(l));
		expect(plan.length).toBeGreaterThan(0);
		for (const l of plan) expect(l).toMatch(/entity=\? AND entity_id=\?/);
	});

	it("an accept queues its slice's comparison: a route owner's, a slice never compared, or a unit the last comparison blamed", () => {
		const { ledger } = workspace();
		// U1 answers the slice's route, U2 is a helper of it
		ledger.db.prepare("INSERT INTO index_routes(side, method, path, handler_symbol) VALUES ('source', 'GET', '/invoices', 'src/U1.php::f')").run();
		const [owner, other] = ["U1", "U2"];
		expect(parityOnAccept(ledger, "invoices", other!)).toBe(true); // never compared
		const id = Number(ledger.db.prepare("INSERT INTO parity_runs(slice, outcome, started_at, ended_at) VALUES ('invoices', 'differs', '2026-10-14T23:36:00.000Z', '2026-10-14T23:47:00.000Z')").run().lastInsertRowid);
		expect(parityOnAccept(ledger, "invoices", other!)).toBe(false);
		expect(parityOnAccept(ledger, "invoices", owner!)).toBe(true);
		ledger.db.prepare("INSERT INTO parity_diffs(run_id, slice, step, route, kind, path, legacy, target, status, unit_id) VALUES (?, 'invoices', 's1', 'GET /x', 'status', 'status', '302', '503', 'bug', ?)").run(id, other!);
		ledger.db.prepare("INSERT INTO transitions(entity, entity_id, from_state, to_state, created_at) VALUES ('unit', ?, 'review', 'accepted', '2026-10-15T01:21:31.985Z')").run(other!);
		expect(parityOnAccept(ledger, "invoices", other!)).toBe(true);
	});

	it("older ledgers get the count of skipped routes on their comparisons (0 for the runs before it)", () => {
		const path = join(mkdtempSync(join(tmpdir(), "br-paritymig-")), "ledger.sqlite");
		const first = new Ledger(path);
		first.db.exec("ALTER TABLE parity_runs DROP COLUMN skipped");
		first.db.prepare("INSERT INTO parity_runs(slice, outcome, started_at) VALUES ('s', 'same', datetime('now'))").run();
		first.close();
		const again = new Ledger(path);
		expect(again.db.prepare("SELECT skipped FROM parity_runs").get()).toMatchObject({ skipped: 0 });
		again.close();
	});

	it("older ledgers: comparisons an app's start or data reset stopped are turned into setup once", () => {
		const path = join(mkdtempSync(join(tmpdir(), "br-paritymig-")), "ledger.sqlite");
		const first = new Ledger(path);
		const add = (note: string) => first.db.prepare("INSERT INTO parity_runs(slice, outcome, note, started_at) VALUES ('s', 'error', ?, datetime('now'))").run(note);
		add("the old app did not start: the data reset failed: …");
		add("the new symfony app did not start: the data reset failed: OrbStack is already running.");
		add("the new symfony app did not start: no answer on http://127.0.0.1:18081/ after 180s");
		add("this slice has no routes of its own to compare");
		first.db.prepare("DELETE FROM meta WHERE key = 'parity_setup_outcome'").run();
		first.close();
		const again = new Ledger(path);
		expect((again.db.prepare("SELECT outcome FROM parity_runs ORDER BY id").all() as Array<{ outcome: string }>).map((r) => r.outcome)).toEqual(["setup", "setup", "error", "error"]);
		again.close();
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
	it("one cause in shared code across slices is recorded once for one code job; no unit is re-opened for it", async () => {
		const { root, config, ledger, run, ids, status, accept } = workspace();
		// the same logged-out redirect differs in a second slice
		const other = () => {
			const id = Number(ledger.db.prepare("INSERT INTO parity_runs(slice, outcome, started_at) VALUES ('dashboard', 'differs', ?)").run(new Date().toISOString()).lastInsertRowid);
			ledger.db.prepare("INSERT INTO parity_diffs(run_id, slice, step, route, kind, path, legacy, target) VALUES (?, 'dashboard', 's1', 'GET /dashboard', 'status', '', '302', '401')").run(id);
			return id;
		};
		const r1 = run([{ step: "one", path: "", legacy: 302, target: 401 }]);
		const first: ParityJudge = async (o) => (expect(o.facts).toMatch(/Shared causes[\s\S]*none known yet/), [{ diffs: ids(r1), verdict: "bug", unit: "U1", problem: "a logged-out request gets 401, the old app redirects to /login", fix: "redirect to /login in the auth layer", shared: "new" }]);
		const res = await judgeRun({ ledger, config, root, runId: r1, slice: "invoices", judge: first, log: () => {}, shared: true });
		expect(res).toMatchObject({ reopened: [], bugs: 1, shared: ["S1"] });
		expect(status(r1)).toEqual(["bug"]);
		expect(ledger.getUnit("U1")!.state).toBe("accepted");
		// the judge of another slice sees the known cause and says it is the same one
		const r2 = other();
		const second: ParityJudge = async (o) => (expect(o.facts).toMatch(/S1 \(slices invoices\): a logged-out request/), [{ diffs: (ledger.db.prepare("SELECT id FROM parity_diffs WHERE run_id = ?").all(r2) as Array<{ id: number }>).map((d) => d.id), verdict: "bug", unit: "U2", problem: "401 instead of the login redirect", shared: "S1" }]);
		expect((await judgeRun({ ledger, config, root, runId: r2, slice: "dashboard", judge: second, log: () => {}, shared: true })).reopened).toEqual([]);
		const [c] = sharedCauses(ledger);
		expect(sharedCauses(ledger)).toHaveLength(1);
		expect(c).toMatchObject({ id: "S1", slices: ["invoices", "dashboard"], status: "open", jobs: 0 });
		expect(sharedJobText(c!)).toMatch(/slices invoices, dashboard[\s\S]*redirect to \/login in the auth layer[\s\S]*dashboard: step s1/);

		// a job landed, yet a later comparison still differs: open for another job; after the last one the units go back
		for (let job = 1; job <= MAX_SHARED_JOBS; job++) {
			updateShared(ledger, "S1", { status: "landed", jobs: job, landedAt: "2000-01-01T00:00:00.000Z" });
			const r = run([{ step: "one", path: "", legacy: 302, target: 401 }]);
			const again: ParityJudge = async () => [{ diffs: ids(r), verdict: "bug", unit: "U1", problem: "still 401", shared: "S1" }];
			const j = await judgeRun({ ledger, config, root, runId: r, slice: "invoices", judge: again, log: () => {}, shared: true });
			if (job < MAX_SHARED_JOBS) expect([j.reopened, sharedCauses(ledger)[0]!.status]).toEqual([[], "open"]);
			else expect([j.reopened, sharedCauses(ledger)[0]!.status]).toEqual([["U1"], "failed"]);
		}
		// after the failure the judge is told S1 failed; a "new" cause for the same slice goes to the unit, no S2 and no more jobs
		accept("U1");
		const r3 = run([{ step: "one", path: "", legacy: 302, target: 401 }]);
		const after: ParityJudge = async (o) => (expect(o.facts).toMatch(/S1 \(slices invoices, dashboard\) FAILED/), [{ diffs: ids(r3), verdict: "bug", unit: "U1", problem: "still 401", shared: "new" }]);
		expect((await judgeRun({ ledger, config, root, runId: r3, slice: "invoices", judge: after, log: () => {}, shared: true })).reopened).toEqual(["U1"]);
		expect(sharedCauses(ledger).map((x) => [x.id, x.status])).toEqual([["S1", "failed"]]);
	});

	it("a shared cause's code job: landed → its slices are compared again; not fixed after the last job → failed, slices compared again for the units", async () => {
		const { ledger } = workspace();
		ledger.setMeta("parity_shared", JSON.stringify([{ id: "S1", problem: "401 for logged-out", slices: ["invoices", "dashboard"], examples: [], status: "open", jobs: 0 }]));
		const seen: number[] = [];
		// the job sees the cause as running, with its job number
		expect(await runSharedJob(ledger, async (c) => (seen.push(c.jobs), expect(sharedCauses(ledger)[0]!.status).toBe("running"), true))).toEqual({ id: "S1", slices: ["invoices", "dashboard"] });
		expect(sharedCauses(ledger)[0]).toMatchObject({ status: "landed", jobs: 1 });
		expect(await runSharedJob(ledger, async () => true)).toBeUndefined(); // none open
		// the judge opened it again (still differs on the fix): a job that merges nothing, then one that throws
		updateShared(ledger, "S1", { status: "open" });
		expect(await runSharedJob(ledger, async (c) => (seen.push(c.jobs), false))).toEqual({ id: "S1", slices: ["invoices", "dashboard"] });
		expect(sharedCauses(ledger)[0]).toMatchObject({ status: "failed", jobs: MAX_SHARED_JOBS });
		expect(seen).toEqual([1, 2]);
		updateShared(ledger, "S1", { status: "open", jobs: 0 });
		const said: string[] = [];
		expect(await runSharedJob(ledger, async () => { throw new Error("boom"); }, (l) => said.push(l))).toEqual({ id: "S1", slices: [] });
		expect([sharedCauses(ledger)[0]!.status, said]).toEqual(["open", ["parity shared cause S1: boom"]]);
	});

	it("without code jobs a shared cause re-opens its unit like any bug", async () => {
		const { root, config, ledger, run, ids } = workspace();
		const r = run([{ step: "one", path: "", legacy: 302, target: 401 }]);
		const judge: ParityJudge = async (o) => (expect(o.facts).not.toMatch(/Shared causes/), [{ diffs: ids(r), verdict: "bug", unit: "U1", problem: "401", shared: "new" }]);
		expect((await judgeRun({ ledger, config, root, runId: r, slice: "invoices", judge, log: () => {} })).reopened).toEqual(["U1"]);
		expect(sharedCauses(ledger)).toEqual([]);
	});
});

describe("a difference in words", () => {
	it("two pages that start the same are shown from where they first differ (U2081: the debug toolbar, not line endings)", () => {
		const head = "<!DOCTYPE html>\n<html>\n  <head>\n" + "    <meta charset=\"UTF-8\">\n".repeat(20);
		const text = describeDiff({ step: "s14", route: "config/players", kind: "body", path: "body", legacy: `${head}    </body>`, target: `${head}    \n<!-- START of Symfony Web Debug Toolbar --></body>` });
		expect(text).toMatch(/the first \d+ characters are the same; from there old …/);
		expect(text).toContain("Web Debug Toolbar");
		// short values as before
		expect(describeDiff({ step: "s1", route: "r", kind: "status", path: "", legacy: "200", target: "404" })).toBe("step s1 (r) status: old 200, new 404");
	});
});
