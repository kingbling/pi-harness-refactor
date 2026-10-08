import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { recheckAccepted } from "../src/run/recheck.ts";
import type { Reviewer } from "../src/run/review.ts";

/**
 * br recheck: units accepted under the old, weaker checks meet the new ones. Typed-in truth or reviewer findings
 * send a unit back to planned with its code kept and the findings as its next note; a clean one stays accepted.
 */
function workspace() {
	const root = mkdtempSync(join(tmpdir(), "br-recheck-"));
	const config = ConfigSchema.parse({ source: { path: join(root, "legacy"), stack: "php" }, target: { path: join(root, "new"), stacks: ["nestjs"] }, models: {} });
	const ledger = new Ledger(":memory:");
	ledger.db.prepare("INSERT INTO files(path, hash, lang, updated_at) VALUES ('app/offer.php', 'h', 'php', 't')").run();
	for (const id of ["typed", "fine", "stub"]) {
		ledger.db.prepare("INSERT INTO symbols(id, path, kind, name, state, updated_at) VALUES (?, 'app/offer.php', 'function', ?, 'accepted', 't')").run(`app/offer.php::${id}`, id);
		ledger.createUnit({ id, tier: "T1", deps: [], meta: { files: ["app/offer.php"], commit: "abc", place: { stack: "nestjs", area: "offer", shared: false, source: "code" } }, symbolIds: [`app/offer.php::${id}`] });
		ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = ?").run(id);
		ledger.db.prepare("UPDATE symbols SET state = 'accepted' WHERE id = ?").run(`app/offer.php::${id}`);
		ledger.addEvidence(id, "truth_green_on_old", {});
		ledger.db.prepare("INSERT INTO truth_cases(id, unit_id, symbol_id, inputs, expected, verified_on_old, created_at) VALUES (?, ?, 's', 'null', '123.45', 1, 't')").run(`${id}#1`, id);
		mkdirSync(join(root, ".bigrefactor", "truth", id), { recursive: true });
		writeFileSync(join(root, ".bigrefactor", "truth", id, "cases.php"), id === "typed" ? "<?php require 'app/offer.php'; echo json_encode([['symbol'=>'s','inputs'=>null,'expected'=>123.45]]);" : "<?php require 'app/offer.php'; echo json_encode([['symbol'=>'s','inputs'=>null,'expected'=>net()]]);");
	}
	return { root, config, ledger };
}

describe("br recheck", () => {
	it("re-opens what fails the newer checks, code kept, findings as the next note; keeps the rest", async () => {
		const { root, config, ledger } = workspace();
		const reviewer: Reviewer = async (o) => (o.unitId === "stub" ? { ok: false, judged: true, output: "reviewer findings:\n- src/offer/offer.service.ts:4: net() returns 0 → port the discount rules" } : { ok: true, judged: true, output: "fine" });
		const r = await recheckAccepted({ ledger, config, root, reviewer, log: () => {} });
		expect(r.reopened.sort()).toEqual(["stub", "typed"]);
		expect(ledger.getUnit("fine")!.state).toBe("accepted");
		expect(ledger.getUnit("stub")!.state).toBe("planned");
		expect(JSON.parse(ledger.getUnit("stub")!.meta).retryNote).toMatch(/code stays on the branch[\s\S]*port the discount rules/);
		expect(ledger.getSymbol("app/offer.php::stub")!.state).toBe("clustered");
		// typed-in truth is redone; truth of a unit that only failed the review is kept
		expect(ledger.hasEvidence("typed", "truth_green_on_old")).toBe(false);
		expect(ledger.hasEvidence("stub", "truth_green_on_old")).toBe(true);
		// once per unit unless --again
		expect((await recheckAccepted({ ledger, config, root, reviewer, log: () => {} })).checked).toBe(0);
	});
});
