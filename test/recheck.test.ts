import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
function workspace(stacks = ["nestjs"]) {
	const root = mkdtempSync(join(tmpdir(), "br-recheck-"));
	const config = ConfigSchema.parse({ source: { path: join(root, "legacy"), stack: "php" }, target: { path: join(root, "new"), stacks }, models: {} });
	// several stacks: each project in its own folder of the repo, the unit's paths relative to it
	const proj = stacks.length > 1 ? join(root, "new", "api") : join(root, "new");
	const ledger = new Ledger(":memory:");
	ledger.db.prepare("INSERT INTO files(path, hash, lang, updated_at) VALUES ('app/offer.php', 'h', 'php', 't')").run();
	mkdirSync(join(proj, "src", "offer"), { recursive: true });
	for (const id of ["typed", "fine", "stub"]) {
		ledger.db.prepare("INSERT INTO symbols(id, path, kind, name, state, updated_at) VALUES (?, 'app/offer.php', 'function', ?, 'accepted', 't')").run(`app/offer.php::${id}`, id);
		ledger.createUnit({ id, tier: "T1", deps: [], meta: { files: ["app/offer.php"], commit: "abc", place: { stack: "nestjs", area: "offer", shared: false, source: "code" } }, symbolIds: [`app/offer.php::${id}`] });
		ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = ?").run(id);
		ledger.db.prepare("UPDATE symbols SET state = 'accepted' WHERE id = ?").run(`app/offer.php::${id}`);
		ledger.addEvidence(id, "truth_green_on_old", {});
		// the unit's code on main now (moved there by a later tidy) and its ported test
		writeFileSync(join(proj, "src", "offer", `${id}.service.ts`), `export const ${id} = 1; // as it is now`);
		writeFileSync(join(proj, "src", "offer", `${id}.spec.ts`), `it("${id}#1 net", () => {});`);
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
		// its move is still in the ledger: the symbol stays proven (the implementer re-proves only what it changes)
		expect(ledger.getSymbol("app/offer.php::stub")!.state).toBe("mapped");
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

	it("several stacks: tests and files are found in the unit's own project folder, not the repo root", async () => {
		const { root, config, ledger } = workspace(["nestjs", "react"]);
		const seen: ReviewInput[] = [];
		const ran: string[] = [];
		const reviewer: Reviewer = async (o) => (seen.push(o), { ok: true, judged: true, output: "fine" });
		const r = await recheckAccepted({ ledger, config, root, reviewer, runTests: async (_c, _a, cwd) => (ran.push(cwd), { ok: true, output: "ok" }), log: () => {} });
		expect(r.reopened).toEqual(["typed"]); // only the typed-in truth; no "ported tests are gone"
		expect(ledger.getUnit("fine")!.state).toBe("accepted");
		expect(ran.every((d) => d === join(config.target.path, "api"))).toBe(true);
		const fine = seen.find((s) => s.unitId === "fine")!;
		expect(fine.targetProjectDir).toBe(join(config.target.path, "api"));
		expect(fine.changedFiles).toEqual(["src/offer/fine.service.ts"]);
	});

	it("a unit an earlier recheck sent back, with nothing run since, is judged again: clean → accepted again, symbols too; still red → the new findings are its note", async () => {
		const { root, config, ledger } = workspace();
		const { reopenUnit } = await import("../src/run/recheck.ts");
		const { REQUIRED_FOR_ACCEPTED } = await import("../src/ledger/schema.ts");
		for (const id of ["fine", "stub"]) for (const t of REQUIRED_FOR_ACCEPTED) ledger.addEvidence(id, t, {});
		for (const id of ["fine", "stub"]) reopenUnit(ledger, id, "old note: ported tests are gone from the main branch", "recheck: ported tests are gone from the main branch: x");
		ledger.db.prepare("UPDATE units SET meta = json_set(meta, '$.rechecked', 't') WHERE id IN ('fine', 'stub')").run();
		expect(ledger.getSymbol("app/offer.php::fine")!.state).toBe("mapped");
		const reviewer: Reviewer = async (o) => (o.unitId === "stub" ? { ok: false, judged: true, output: "reviewer findings:\n- net() returns 0" } : { ok: true, judged: true, output: "fine" });
		const r = await recheckAccepted({ ledger, config, root, reviewer, runTests: green, log: () => {} });
		expect(r.restored).toEqual(["fine"]);
		expect(ledger.getUnit("fine")!.state).toBe("accepted");
		expect(ledger.getSymbol("app/offer.php::fine")!.state).toBe("accepted");
		expect(JSON.parse(ledger.getUnit("fine")!.meta).retryNote).toBeUndefined();
		expect(ledger.getUnit("stub")!.state).toBe("planned");
		expect(JSON.parse(ledger.getUnit("stub")!.meta).retryNote).toMatch(/net\(\) returns 0/);
		expect(JSON.parse(ledger.getUnit("stub")!.meta).retryNote).not.toMatch(/gone/);
		// stub's last transition is still the old re-open: judged again next time, but never re-opened twice
		expect(ledger.transitionsOf("unit", "stub").filter((t) => t.to_state === "planned")).toHaveLength(1);
	});

	it("a sent-back unit the reviewer could not judge stays planned and is tried again next time", async () => {
		const { root, config, ledger } = workspace();
		const { reopenUnit } = await import("../src/run/recheck.ts");
		const { REQUIRED_FOR_ACCEPTED } = await import("../src/ledger/schema.ts");
		for (const t of REQUIRED_FOR_ACCEPTED) ledger.addEvidence("fine", t, {});
		reopenUnit(ledger, "fine", "old note", "recheck: x");
		ledger.db.prepare("UPDATE units SET meta = json_set(meta, '$.rechecked', 't') WHERE id = 'fine'").run();
		const down: Reviewer = async () => ({ ok: false, judged: false, output: "not judged: provider down" });
		const r = await recheckAccepted({ ledger, config, root, reviewer: down, runTests: green, log: () => {} });
		expect(r.restored).toEqual([]);
		expect(ledger.getUnit("fine")!.state).toBe("planned");
		expect(JSON.parse(ledger.getUnit("fine")!.meta).retryNote).toBe("old note");
		// no version stamp: the next recheck picks it up again
		const again = await recheckAccepted({ ledger, config, root, reviewer: async () => ({ ok: true, judged: true, output: "fine" }), runTests: green, log: () => {} });
		expect(again.restored).toEqual(["fine"]);
	});

	it("a re-opened unit keeps the proofs of symbols whose move is still in the ledger; one without a move must be proven again", async () => {
		const { ledger } = workspace();
		const { reopenUnit } = await import("../src/run/recheck.ts");
		ledger.db.prepare("INSERT INTO symbols(id, path, kind, name, state, unit_id, updated_at) VALUES ('app/offer.php::extra', 'app/offer.php', 'function', 'extra', 'accepted', 'fine', 't')").run();
		reopenUnit(ledger, "fine", "a bug report", "bug reported by u9: x");
		expect(ledger.getSymbol("app/offer.php::fine")!.state).toBe("mapped");
		expect(ledger.getSymbol("app/offer.php::extra")!.state).toBe("clustered");
		expect(ledger.getUnit("fine")!.state).toBe("planned");
	});

	it("bad truth is redone whatever kind it was: no truth evidence is left to skip the tester", async () => {
		const { ledger } = workspace();
		const { reopenUnit } = await import("../src/run/recheck.ts");
		for (const t of ["truth_read", "truth_none", "truth_ahead"] as const) ledger.addEvidence("fine", t, {});
		reopenUnit(ledger, "fine", "note", "recheck: bad truth", true);
		for (const t of ["truth_green_on_old", "truth_read", "truth_none", "truth_ahead"] as const) expect(ledger.hasEvidence("fine", t)).toBe(false);
	});

	it("a ported test a tidy moved is found again by its case id and linked to its new file, not reported gone", async () => {
		const { root, config, ledger } = workspace();
		const { execFileSync } = await import("node:child_process");
		const { renameSync } = await import("node:fs");
		mkdirSync(join(root, "new", "test", "offer"), { recursive: true });
		renameSync(join(root, "new", "src", "offer", "fine.spec.ts"), join(root, "new", "test", "offer", "net-price.spec.ts"));
		execFileSync("git", ["init", "-q"], { cwd: join(root, "new") });
		execFileSync("git", ["add", "-A"], { cwd: join(root, "new") });
		const ran: string[][] = [];
		const reviewer: Reviewer = async () => ({ ok: true, judged: true, output: "fine" });
		const r = await recheckAccepted({ ledger, config, root, reviewer, runTests: async (_c, args) => (ran.push(args), { ok: true, output: "ok" }), log: () => {} });
		expect(r.reopened).toEqual(["typed"]);
		expect(ledger.getUnit("fine")!.state).toBe("accepted");
		expect((ledger.db.prepare("SELECT ported_test_path p FROM truth_cases WHERE id = 'fine#1'").get() as { p: string }).p).toBe("test/offer/net-price.spec.ts");
		expect(ran.some((a) => a.some((x) => x.includes("net-price.spec")))).toBe(true);
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

describe("br recheck: findings outside the unit's files", () => {
	it("keep the unit accepted and become one owner note", async () => {
		const { root, config, ledger } = workspace();
		const reviewer: Reviewer = async () => ({ ok: false, judged: true, output: "outside the unit's files (setup fixer, else the owner):\n- composer.json lacks a mapping → add it", outOfScope: "- composer.json lacks a mapping → add it" });
		const r = await recheckAccepted({ ledger, config, root, reviewer, runTests: green, log: () => {} });
		expect(r.reopened).not.toContain("stub");
		expect(ledger.getUnit("stub")!.state).toBe("accepted");
		expect(ledger.openQuestions().some((q) => q.point === "review_outside" && q.unit_id === "stub")).toBe(true);
	});
});

describe("truth read from the old code, run once it can", () => {
	it("same values → counted as run on the old code; other values → the unit is redone; red → tried again only once the environment changes", async () => {
		const { root, config, ledger } = workspace();
		const { upgradeReadTruth } = await import("../src/run/recheck.ts");
		const source = { id: "shell", truth: { scriptName: "cases.sh", run: (_r: string, s: string) => ({ cmd: "sh", args: [s] }), instructions: "" } } as never;
		mkdirSync(config.source.path, { recursive: true });
		const print = (expected: string) => `# app/offer.php\necho '[{"symbol":"s","inputs":null,"expected":'"${expected}"'}]'\n`;
		for (const [id, script] of [["fine", print("$(printf %s.%s 123 45)")], ["stub", print("99")], ["typed", "exit 1\n"]] as const) {
			ledger.db.prepare("DELETE FROM evidence WHERE unit_id = ?").run(id);
			ledger.db.prepare("UPDATE truth_cases SET verified_on_old = 0 WHERE unit_id = ?").run(id);
			ledger.addEvidence(id, "truth_read", {});
			writeFileSync(join(root, ".bigrefactor", "truth", id, "cases.sh"), script);
		}
		const r = await upgradeReadTruth({ ledger, config, root, source, log: () => {} });
		expect(r).toMatchObject({ upgraded: ["fine"], redone: ["stub"], red: 1 });
		expect(ledger.hasEvidence("fine", "truth_green_on_old")).toBe(true);
		expect(ledger.db.prepare("SELECT verified_on_old v FROM truth_cases WHERE unit_id = 'fine'").get()).toEqual({ v: 1 });
		expect(ledger.getUnit("stub")!.state).toBe("planned");
		expect(JSON.parse(ledger.getUnit("stub")!.meta).retryNote).toMatch(/the old code returns 99/);
		// the same environment: the red one is not run again
		expect((await upgradeReadTruth({ ledger, config, root, source, log: () => {} })).red).toBe(0);
	});

	it("while the old code's runtime is down (the probe does not run either) no unit counts as tried: the next upgrade runs them", async () => {
		const { root, config, ledger } = workspace();
		const { upgradeReadTruth } = await import("../src/run/recheck.ts");
		const source = { id: "shell", truth: { scriptName: "cases.sh", run: (_r: string, s: string) => ({ cmd: "sh", args: [s] }), instructions: "" } } as never;
		mkdirSync(config.source.path, { recursive: true });
		// the runtime: down while the file "down" is there (a container daemon that stopped)
		writeFileSync(join(root, ".bigrefactor", "legacy-env.json"), JSON.stringify({ root: config.source.path, mode: "run", run: { cmd: "sh", args: ["-c", 'test ! -e down && sh "$0"', "{script}"] } }));
		mkdirSync(join(root, ".bigrefactor", "legacy-env", "probe"), { recursive: true });
		writeFileSync(join(root, ".bigrefactor", "legacy-env", "probe", "cases.sh"), `echo '[{"symbol":"probe","inputs":null,"expected":1}]'\n`);
		ledger.db.prepare("DELETE FROM evidence WHERE unit_id = 'fine'").run();
		ledger.db.prepare("UPDATE truth_cases SET verified_on_old = 0 WHERE unit_id = 'fine'").run();
		ledger.addEvidence("fine", "truth_read", { runError: "failed to connect to the runtime" });
		writeFileSync(join(root, ".bigrefactor", "truth", "fine", "cases.sh"), `# app/offer.php\necho '[{"symbol":"s","inputs":null,"expected":'"$(printf %s.%s 123 45)"'}]'\n`);
		writeFileSync(join(config.source.path, "down"), "");
		expect(await upgradeReadTruth({ ledger, config, root, source, log: () => {} })).toMatchObject({ upgraded: [], red: 0 });
		expect(JSON.parse(ledger.getUnit("fine")!.meta).truthUpgradeEnv).toBeUndefined();
		rmSync(join(config.source.path, "down"));
		expect((await upgradeReadTruth({ ledger, config, root, source, log: () => {} })).upgraded).toEqual(["fine"]);
	});
});

describe("truth read from the old code, run once it can: values compared where both sides have them", () => {
	it("a key only one side has proves nothing, so the unit stays; a value both sides hold that differs redoes it", async () => {
		const { root, config, ledger } = workspace();
		const { upgradeReadTruth } = await import("../src/run/recheck.ts");
		const source = { id: "shell", truth: { scriptName: "cases.sh", run: (_r: string, s: string) => ({ cmd: "sh", args: [s] }), instructions: "" } } as never;
		mkdirSync(config.source.path, { recursive: true });
		const print = (expected: string) => `# app/offer.php\necho '[{"symbol":"s","inputs":null,"expected":${expected}}]'\n`;
		// recorded, then what the old code prints when run
		for (const [id, recorded, ran] of [["fine", '{"net":1,"tax":2}', '{"net":1}'], ["stub", '{"net":1}', '{"net":1,"due":3}'], ["typed", '{"net":1}', '{"net":2}']] as const) {
			ledger.db.prepare("DELETE FROM evidence WHERE unit_id = ?").run(id);
			ledger.db.prepare("UPDATE truth_cases SET verified_on_old = 0, expected = ? WHERE unit_id = ?").run(recorded, id);
			ledger.addEvidence(id, "truth_read", {});
			writeFileSync(join(root, ".bigrefactor", "truth", id, "cases.sh"), print(ran));
		}
		const r = await upgradeReadTruth({ ledger, config, root, source, log: () => {} });
		expect(r).toMatchObject({ upgraded: [], redone: ["typed"], red: 0 });
		for (const id of ["fine", "stub"]) {
			expect(ledger.getUnit(id)!.state).toBe("accepted");
			expect(ledger.hasEvidence(id, "truth_green_on_old")).toBe(false);
			expect(ledger.hasEvidence(id, "truth_read")).toBe(true);
		}
		expect(JSON.parse(ledger.getUnit("typed")!.meta).retryNote).toMatch(/the old code returns \{"net":2\}/);
	});
});

describe("a script for truth that was only read, already there but red here", () => {
	it("goes to the tester with the error it gave; a script not run here yet is left to the truth upgrade", async () => {
		const { root, config, ledger } = workspace();
		const { upgradeReadTruth, writeTruthScripts } = await import("../src/run/recheck.ts");
		const source = { id: "shell", truth: { scriptName: "cases.sh", run: (_r: string, s: string) => ({ cmd: "sh", args: [s] }), instructions: "" } } as never;
		mkdirSync(config.source.path, { recursive: true });
		writeFileSync(join(root, ".bigrefactor", "legacy-env.json"), JSON.stringify({ root: config.source.path, mode: "run" }));
		for (const id of ["fine", "stub", "typed"]) {
			ledger.db.prepare("DELETE FROM evidence WHERE unit_id = ?").run(id);
			ledger.db.prepare("UPDATE truth_cases SET verified_on_old = 0 WHERE unit_id = ?").run(id);
			ledger.addEvidence(id, "truth_read", {});
		}
		writeFileSync(join(root, ".bigrefactor", "truth", "fine", "cases.sh"), "echo 'Class Money not found' >&2; exit 1\n");
		await upgradeReadTruth({ ledger, config, root, source, log: () => {} });
		// a red script on a unit the upgrade has not run yet waits for it
		writeFileSync(join(root, ".bigrefactor", "truth", "stub", "cases.sh"), "exit 1\n");
		const told = new Map<string, string | undefined>();
		const writer = async (o: { unitId: string; truthDir: string; failed?: string }) => {
			told.set(o.unitId, o.failed);
			writeFileSync(join(o.truthDir, "cases.sh"), `# app/offer.php\necho '[{"symbol":"s","inputs":null,"expected":'"$(printf %s.%s 123 45)"'}]'\n`);
		};
		const r = await writeTruthScripts({ ledger, config, root, source, cap: 5, writer, log: () => {} });
		expect([...told.keys()].sort()).toEqual(["fine", "typed"]);
		expect(told.get("fine")).toMatch(/Class Money not found/);
		expect(told.get("typed")).toBeUndefined();
		expect(r.upgraded.sort()).toEqual(["fine", "typed"]);
	});
});

describe("a script for truth that was only read", () => {
	it("once the old code runs: the tester writes scripts for a few accepted units per run, never sees the expected values, code judges what they print", async () => {
		const { root, config, ledger } = workspace();
		const { writeTruthScripts } = await import("../src/run/recheck.ts");
		const source = { id: "shell", truth: { scriptName: "cases.sh", run: (_r: string, s: string) => ({ cmd: "sh", args: [s] }), instructions: "" } } as never;
		mkdirSync(config.source.path, { recursive: true });
		const env = join(root, ".bigrefactor", "legacy-env.json");
		for (const id of ["fine", "stub", "typed"]) {
			ledger.db.prepare("DELETE FROM evidence WHERE unit_id = ?").run(id);
			ledger.db.prepare("UPDATE truth_cases SET verified_on_old = 0 WHERE unit_id = ?").run(id);
			ledger.addEvidence(id, "truth_read", {});
		}
		const opts = { ledger, config, root, source, log: () => {} };
		// the old code does not run here: nothing is tried
		writeFileSync(env, JSON.stringify({ root: config.source.path, mode: "read" }));
		expect((await writeTruthScripts({ ...opts, cap: 5, writer: async () => { throw new Error("not called"); } })).tried).toBe(0);
		writeFileSync(env, JSON.stringify({ root: config.source.path, mode: "run" }));
		const seen: string[] = [];
		const writer = async (o: { unitId: string; truthDir: string; cases: unknown[] }) => {
			seen.push(JSON.stringify(o.cases));
			const value = o.unitId === "fine" ? "$(printf %s.%s 123 45)" : "99";
			writeFileSync(join(o.truthDir, "cases.sh"), `# app/offer.php\necho '[{"symbol":"s","inputs":null,"expected":'"${value}"'}]'\n`);
			return "it runs";
		};
		const r = await writeTruthScripts({ ...opts, cap: 2, writer });
		expect(r).toMatchObject({ tried: 2, upgraded: ["fine"], redone: ["stub"], left: 1 });
		expect(seen.join()).not.toMatch(/123\.45/);
		expect(ledger.hasEvidence("fine", "truth_green_on_old")).toBe(true);
		expect(ledger.getUnit("stub")!.state).toBe("planned");
		// the next run takes the rest; a unit already tried in this environment is not tried again
		expect((await writeTruthScripts({ ...opts, cap: 2, writer })).tried).toBe(1);
	});

	it("order: truth a retest changed after the code first, then units never tried, then red scripts tried again", async () => {
		const { ledger } = workspace();
		const { inLine } = await import("../src/run/recheck.ts");
		ledger.updateUnit("fine", { meta: { truthScriptEnv: "old" } });
		ledger.updateUnit("typed", { meta: { truthScriptEnv: "old" } });
		ledger.addEvidence("typed", "truth_changed_after_code", { case: "typed#1" });
		expect(inLine(ledger, ["fine", "stub", "typed"])).toEqual(["typed", "stub", "fine"]);
	});

	it("a script that is red with the old code's runtime up gets one more try with its error (often a bug in the script itself)", async () => {
		const { root, config, ledger } = workspace();
		const { writeTruthScripts } = await import("../src/run/recheck.ts");
		const source = { id: "shell", truth: { scriptName: "cases.sh", run: (_r: string, s: string) => ({ cmd: "sh", args: [s] }), instructions: "" } } as never;
		mkdirSync(config.source.path, { recursive: true });
		writeFileSync(join(root, ".bigrefactor", "legacy-env.json"), JSON.stringify({ root: config.source.path, mode: "run" }));
		ledger.db.prepare("DELETE FROM evidence WHERE unit_id = 'fine'").run();
		ledger.db.prepare("UPDATE truth_cases SET verified_on_old = 0 WHERE unit_id = 'fine'").run();
		ledger.addEvidence("fine", "truth_read", {});
		rmSync(join(root, ".bigrefactor", "truth", "fine", "cases.php"));
		const told: Array<string | undefined> = [];
		const writer = async (o: { truthDir: string; failed?: string }) => {
			told.push(o.failed);
			writeFileSync(join(o.truthDir, "cases.sh"), told.length === 1 ? "echo 'Cannot declare class Status in cases.sh line 3' >&2; exit 1\n" : `# app/offer.php\necho '[{"symbol":"s","inputs":null,"expected":'"$(printf %s.%s 123 45)"'}]'\n`);
		};
		const r = await writeTruthScripts({ ledger, config, root, source, cap: 1, writer, log: () => {} });
		expect(told).toHaveLength(2);
		expect(told[0]).toBeUndefined();
		expect(told[1]).toMatch(/Cannot declare class Status/);
		expect(r.upgraded).toEqual(["fine"]);
	});
});
