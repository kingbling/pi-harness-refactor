import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { byValue, upgradeReadTruth, writeTruthScripts } from "../src/run/recheck.ts";

/**
 * Accepted units whose truth was only read from the old code: their scripts run on the old code in capped batches,
 * most useful units first; a script red because of the environment runs again after a setup fix; the script writer
 * takes free lanes; a run that disagrees with the read truth re-opens the unit for its tests.
 */
const source = { id: "shell", truth: { scriptName: "cases.sh", run: (_r: string, s: string) => ({ cmd: "sh", args: [s] }), instructions: "" } } as never;
const green = `# app/offer.php\necho '[{"symbol":"s","inputs":null,"expected":'"$(printf %s.%s 123 45)"'}]'\n`;

function workspace(ids: string[], o: { deps?: Record<string, string[]>; slice?: Record<string, string>; state?: Record<string, string> } = {}) {
	const root = mkdtempSync(join(tmpdir(), "br-truth-up-"));
	const config = ConfigSchema.parse({ source: { path: join(root, "legacy"), stack: "php" }, target: { path: join(root, "new"), stacks: ["nestjs"] }, models: {} });
	mkdirSync(config.source.path, { recursive: true });
	mkdirSync(join(root, ".bigrefactor"), { recursive: true });
	writeFileSync(join(root, ".bigrefactor", "legacy-env.json"), JSON.stringify({ root: config.source.path, mode: "run" }));
	const ledger = new Ledger(":memory:");
	ledger.db.prepare("INSERT INTO files(path, hash, lang, updated_at) VALUES ('app/offer.php', 'h', 'php', 't')").run();
	for (const id of ids) {
		ledger.db.prepare("INSERT INTO symbols(id, path, kind, name, state, updated_at) VALUES (?, 'app/offer.php', 'function', ?, 'accepted', 't')").run(`app/offer.php::${id}`, id);
		ledger.createUnit({ id, tier: "T1", deps: o.deps?.[id] ?? [], meta: { files: ["app/offer.php"], slice: o.slice?.[id] ?? "main" }, symbolIds: [`app/offer.php::${id}`] });
		ledger.db.prepare("UPDATE units SET state = ? WHERE id = ?").run(o.state?.[id] ?? "accepted", id);
		ledger.db.prepare("INSERT INTO truth_cases(id, unit_id, symbol_id, inputs, expected, verified_on_old, created_at) VALUES (?, ?, 's', 'null', '123.45', 0, 't')").run(`${id}#1`, id);
		ledger.addEvidence(id, "truth_read", {});
		mkdirSync(join(root, ".bigrefactor", "truth", id), { recursive: true });
	}
	const script = (id: string, text: string) => writeFileSync(join(root, ".bigrefactor", "truth", id, "cases.sh"), text);
	return { root, config, ledger, script };
}

describe("read-only truth run on the old code", () => {
	it("a script red here runs again after a setup fix of the old code's environment, and counts once it is green", async () => {
		const { root, config, ledger, script } = workspace(["a"]);
		script("a", "echo 'Class Money not found' >&2; exit 1\n");
		const opts = { ledger, config, root, source, log: () => {} };
		expect((await upgradeReadTruth(opts)).red).toBe(1);
		// nothing changed: not run again
		expect((await upgradeReadTruth(opts)).red).toBe(0);
		// a setup fix (it only changed the old code's copy, and wrote its line to the log) makes the script run
		script("a", green);
		appendFileSync(join(root, ".bigrefactor", "legacy-env.log"), "2026-10-15T00:00:00Z .bigrefactor/legacy-env/app loaded Money in the start-up file\n");
		expect((await upgradeReadTruth(opts)).upgraded).toEqual(["a"]);
		expect(ledger.db.prepare("SELECT verified_on_old v FROM truth_cases WHERE unit_id = 'a'").get()).toEqual({ v: 1 });
		expect(ledger.hasEvidence("a", "truth_green_on_old")).toBe(true);
	});

	it("runs only the states asked for, at most `cap` units, the most useful first, and leaves the rest for later", async () => {
		const ids = ["a", "b", "c", "d", "p"];
		const { root, config, ledger, script } = workspace(ids, { deps: { a: ["c"], b: ["c"], d: ["b"] }, slice: { d: "login" }, state: { p: "planned" } });
		ledger.db.prepare("INSERT INTO parity_runs(slice, outcome, compared, started_at) VALUES ('login', 'differs', 3, 't')").run();
		for (const id of ids) script(id, green);
		// d's slice was compared with the old app; c is needed by two units, b by one
		expect(byValue(ledger, ["a", "b", "c", "d"])).toEqual(["d", "c", "b", "a"]);
		const r = await upgradeReadTruth({ ledger, config, root, source, states: ["accepted"], cap: 2, log: () => {} });
		expect(r.upgraded.sort()).toEqual(["c", "d"]);
		expect(r.left).toBe(2);
		expect(ledger.hasEvidence("p", "truth_green_on_old")).toBe(false);
		expect((await upgradeReadTruth({ ledger, config, root, source, states: ["accepted"], cap: 10, log: () => {} })).upgraded.sort()).toEqual(["a", "b"]);
	});

	it("a stop ends the batch between units", async () => {
		const { root, config, ledger, script } = workspace(["a", "b", "c", "d", "e"]);
		for (const id of ["a", "b", "c", "d", "e"]) script(id, green);
		let n = 0;
		const r = await upgradeReadTruth({ ledger, config, root, source, states: ["accepted"], stopped: () => n++ >= 3, log: () => {} });
		expect(r.upgraded.length).toBe(3);
	});

	it("the old code returns other values: the accepted unit goes back to planned for its tests, code kept, with what the old code returned", async () => {
		const { root, config, ledger, script } = workspace(["a"]);
		ledger.db.prepare("INSERT INTO moves(unit_id, src_symbol, op, target_symbols, why, created_at) VALUES ('a', 'app/offer.php::a', 'ported', '[]', 'w', 't')").run();
		script("a", `# app/offer.php\necho '[{"symbol":"s","inputs":null,"expected":99}]'\n`);
		expect((await upgradeReadTruth({ ledger, config, root, source, log: () => {} })).redone).toEqual(["a"]);
		expect(ledger.getUnit("a")!.state).toBe("planned");
		expect(ledger.symbolsOfUnit("a")[0]!.state).toBe("mapped");
		expect(JSON.parse(ledger.getUnit("a")!.meta).retryNote).toMatch(/the old code returns 99/);
		// the read truth is not quietly swapped for the run values: the tester makes it again from running the old code
		expect(ledger.db.prepare("SELECT COUNT(*) n FROM truth_cases WHERE unit_id = 'a'").get()).toEqual({ n: 0 });
		expect(ledger.hasEvidence("a", "truth_read")).toBe(false);
	});

	it("a run that returns another kind of value (the text a template prints for its read behaviour) proves nothing: the unit stays accepted", async () => {
		const { root, config, ledger, script } = workspace(["a"]);
		ledger.db.prepare("UPDATE truth_cases SET expected = ? WHERE unit_id = 'a'").run(JSON.stringify({ cursor: "pointer" }));
		script("a", `# app/offer.php\necho '[{"symbol":"s","inputs":null,"expected":"<style>a { cursor: pointer; }</style>"}]'\n`);
		const r = await upgradeReadTruth({ ledger, config, root, source, log: () => {} });
		expect(r.redone).toEqual([]);
		expect(r.upgraded).toEqual([]);
		expect(ledger.getUnit("a")!.state).toBe("accepted");
	});
});

describe("scripts for read-only truth with none", () => {
	it("are written most useful first, one at a time, and more at once while the run has free lanes", async () => {
		const ids = ["a", "b", "c", "d"];
		const { root, config, ledger } = workspace(ids, { deps: { a: ["d"] } });
		const order: string[] = [];
		let now = 0;
		let most = 0;
		const writer = async (o: { unitId: string; truthDir: string }) => {
			order.push(o.unitId);
			most = Math.max(most, ++now);
			await new Promise((r) => setTimeout(r, 60));
			writeFileSync(join(o.truthDir, "cases.sh"), green);
			now--;
		};
		const opts = { ledger, config, root, source, log: () => {} };
		// no free lane: one at a time
		const one = await writeTruthScripts({ ...opts, cap: 2, writer, freeLanes: () => 0, tickMs: 5 });
		expect(one.upgraded.length).toBe(2);
		expect(order[0]).toBe("d");
		expect(most).toBe(1);
		// two free lanes: up to three at once
		const r = await writeTruthScripts({ ...opts, cap: 10, writer, freeLanes: () => 2, tickMs: 5 });
		expect(r.upgraded.length).toBe(2);
		expect(most).toBeGreaterThan(1);
		expect(most).toBeLessThanOrEqual(3);
	});

	it("a script red while the old code's runtime is down is not counted as tried, and nothing more is written", async () => {
		const { root, config, ledger } = workspace(["a", "b"]);
		writeFileSync(join(root, ".bigrefactor", "legacy-env.json"), JSON.stringify({ root: config.source.path, mode: "run", run: { cmd: "sh", args: ["-c", 'test ! -e down && sh "$0"', "{script}"] } }));
		mkdirSync(join(root, ".bigrefactor", "legacy-env", "probe"), { recursive: true });
		writeFileSync(join(root, ".bigrefactor", "legacy-env", "probe", "cases.sh"), `echo '[{"symbol":"probe","inputs":null,"expected":1}]'\n`);
		writeFileSync(join(config.source.path, "down"), "");
		const seen: string[] = [];
		const writer = async (o: { unitId: string; truthDir: string }) => (seen.push(o.unitId), writeFileSync(join(o.truthDir, "cases.sh"), green));
		const r = await writeTruthScripts({ ledger, config, root, source, cap: 5, writer, log: () => {} });
		expect(seen).toEqual(["a"]);
		expect(r.red).toBe(0);
		expect(r.tried).toBe(0);
		expect(JSON.parse(ledger.getUnit("a")!.meta).truthScriptEnv).toBeUndefined();
		// the upgrade pass says the runtime is down, so the run skips the script writer
		expect((await upgradeReadTruth({ ledger, config, root, source, states: ["accepted"], log: () => {} })).down).toBe(true);
	});
});
