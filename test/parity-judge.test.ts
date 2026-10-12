import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { renderStatus } from "../src/dashboard/status.ts";
import { judgeRun, MAX_PARITY_REOPENS, type ParityJudge } from "../src/run/parity-judge.ts";

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
});
