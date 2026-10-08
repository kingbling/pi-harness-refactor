import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { renderStatus } from "../src/dashboard/status.ts";
import { Ledger } from "../src/ledger/db.ts";
import { recheckAccepted } from "../src/run/recheck.ts";
import type { Reviewer, ReviewInput } from "../src/run/review.ts";

/**
 * br recheck: units accepted under the old, weaker checks meet the new ones. Typed-in truth, red ported tests or
 * reviewer findings send a unit back to planned with its code kept and the findings as its next note; a clean
 * one stays accepted. The reviewer sees the unit's files as they are now on main, not its old commit.
 */
function workspace() {
	const root = mkdtempSync(join(tmpdir(), "br-recheck-"));
	const config = ConfigSchema.parse({ source: { path: join(root, "legacy"), stack: "php" }, target: { path: join(root, "new"), stacks: ["nestjs"] }, models: {} });
	const ledger = new Ledger(":memory:");
	ledger.db.prepare("INSERT INTO files(path, hash, lang, updated_at) VALUES ('app/offer.php', 'h', 'php', 't')").run();
	mkdirSync(join(root, "new", "src", "offer"), { recursive: true });
	for (const id of ["typed", "fine", "stub"]) {
		ledger.db.prepare("INSERT INTO symbols(id, path, kind, name, state, updated_at) VALUES (?, 'app/offer.php', 'function', ?, 'accepted', 't')").run(`app/offer.php::${id}`, id);
		ledger.createUnit({ id, tier: "T1", deps: [], meta: { files: ["app/offer.php"], commit: "abc", place: { stack: "nestjs", area: "offer", shared: false, source: "code" } }, symbolIds: [`app/offer.php::${id}`] });
		ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = ?").run(id);
		ledger.db.prepare("UPDATE symbols SET state = 'accepted' WHERE id = ?").run(`app/offer.php::${id}`);
		ledger.addEvidence(id, "truth_green_on_old", {});
		// the unit's code on main now (moved there by a later tidy) and its ported test
		writeFileSync(join(root, "new", "src", "offer", `${id}.service.ts`), `export const ${id} = 1; // as it is now`);
		writeFileSync(join(root, "new", "src", "offer", `${id}.spec.ts`), `it("${id}#1 net", () => {});`);
		ledger.db.prepare("INSERT INTO moves(unit_id, src_symbol, op, target_symbols, why, created_at) VALUES (?, ?, 'ported', ?, 'w', 't')").run(id, `app/offer.php::${id}`, JSON.stringify([`src/offer/${id}.service.ts::${id}`]));
		ledger.db.prepare("INSERT INTO truth_cases(id, unit_id, symbol_id, inputs, expected, verified_on_old, ported_test_path, created_at) VALUES (?, ?, 's', 'null', '123.45', 1, ?, 't')").run(`${id}#1`, id, `src/offer/${id}.spec.ts`);
		mkdirSync(join(root, ".bigrefactor", "truth", id), { recursive: true });
		writeFileSync(join(root, ".bigrefactor", "truth", id, "cases.php"), id === "typed" ? "<?php require 'app/offer.php'; echo json_encode([['symbol'=>'s','inputs'=>null,'expected'=>123.45]]);" : "<?php require 'app/offer.php'; echo json_encode([['symbol'=>'s','inputs'=>null,'expected'=>net()]]);");
	}
	return { root, config, ledger };
}
const green = async () => ({ ok: true, output: "ok" });

describe("br recheck", () => {
	it("re-opens what fails the newer checks, code kept, findings as the next note; keeps the rest", async () => {
		const { root, config, ledger } = workspace();
		const reviewer: Reviewer = async (o) => (o.unitId === "stub" ? { ok: false, judged: true, output: "reviewer findings:\n- src/offer/offer.service.ts:4: net() returns 0 → port the discount rules" } : { ok: true, judged: true, output: "fine" });
		const r = await recheckAccepted({ ledger, config, root, reviewer, runTests: green, log: () => {} });
		expect(r.reopened.sort()).toEqual(["stub", "typed"]);
		expect(ledger.getUnit("fine")!.state).toBe("accepted");
		expect(ledger.getUnit("stub")!.state).toBe("planned");
		expect(JSON.parse(ledger.getUnit("stub")!.meta).retryNote).toMatch(/code stays on the branch[\s\S]*port the discount rules/);
		expect(ledger.getSymbol("app/offer.php::stub")!.state).toBe("clustered");
		// typed-in truth is redone; truth of a unit that only failed the review is kept
		expect(ledger.hasEvidence("typed", "truth_green_on_old")).toBe(false);
		expect(ledger.hasEvidence("stub", "truth_green_on_old")).toBe(true);
		// once per unit unless --again
		expect((await recheckAccepted({ ledger, config, root, reviewer, runTests: green, log: () => {} })).checked).toBe(0);
	});

	it("the reviewer judges the unit's files as they are now on main, with its ported tests", async () => {
		const { root, config, ledger } = workspace();
		const seen: ReviewInput[] = [];
		const reviewer: Reviewer = async (o) => (seen.push(o), { ok: true, judged: true, output: "fine" });
		await recheckAccepted({ ledger, config, root, reviewer, runTests: green, log: () => {} });
		const fine = seen.find((s) => s.unitId === "fine")!;
		// the commit "abc" does not exist: only the file its move points to, as it is on main now
		expect(fine.changedFiles).toEqual(["src/offer/fine.service.ts"]);
		expect(fine.targetProjectDir).toBe(config.target.path);
		expect(fine.recheck).toBe(true);
		expect(fine.testFiles).toEqual(["src/offer/fine.spec.ts"]);
	});

	it("re-runs the ported tests on main: red ones send the unit back, code kept", async () => {
		const { root, config, ledger } = workspace();
		const ran: Array<{ args: string[]; cwd: string }> = [];
		const runTests = async (_cmd: string, args: string[], cwd: string) => (ran.push({ args, cwd }), args.some((a) => a.includes("fine.spec")) ? { ok: false, output: "fine#1 net: expected 123.45, got 0" } : { ok: true, output: "ok" });
		const reviewer: Reviewer = async () => ({ ok: true, judged: true, output: "fine" });
		const r = await recheckAccepted({ ledger, config, root, reviewer, runTests, log: () => {} });
		expect(r.reopened.sort()).toEqual(["fine", "typed"]);
		expect(ran.every((x) => x.cwd === config.target.path)).toBe(true);
		expect(JSON.parse(ledger.getUnit("fine")!.meta).retryNote).toMatch(/ported tests fail on the main branch[\s\S]*expected 123.45, got 0/);
		expect(ledger.getUnit("stub")!.state).toBe("accepted");
	});

	it("status counts the accepted units not rechecked yet", async () => {
		const { root, config, ledger } = workspace();
		expect(renderStatus(ledger, { color: false })).toMatch(/3 accepted units not rechecked since the checks changed/);
		await recheckAccepted({ ledger, config, root, reviewer: async () => ({ ok: true, judged: true, output: "fine" }), runTests: green, log: () => {} });
		expect(renderStatus(ledger, { color: false })).not.toMatch(/not rechecked/);
	});
});
