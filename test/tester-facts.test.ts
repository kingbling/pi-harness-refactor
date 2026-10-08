import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { nestjsAdapter } from "../src/adapters/target/nestjs.ts";
import { ConfigSchema, type Config } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { FakeModelClient } from "../src/models/fake.ts";
import { noBehaviour, runGate, type GateInput, type GateReport } from "../src/run/gate.ts";
import { loadReadTruth, NO_BEHAVIOUR_FILE, verifyTruthOnOld } from "../src/run/legacy-env.ts";
import { mentionsCase } from "../src/run/ported.ts";
import { quirksOf, recordQuirk, sameQuirk } from "../src/run/quirks.ts";
import { reviewWithModel } from "../src/run/review.ts";
import { runUnit } from "../src/run/unit.ts";
import { blockedHint, type LeafSession, type SpawnOptions } from "../src/sessions/spawn.ts";
import { checkPortedTestsTool, recordQuirkTool, testerTools } from "../src/sessions/tools.ts";
import { getSourceAdapter } from "../src/adapters/registry.ts";

/**
 * The tester is told facts instead of guessing: where the legacy code and the target project are, exactly where it
 * may write; it can run the orchestrator's own checks on its tests; retests for coverage/lint/placement leave the
 * truth cases alone; a quirk is recorded once; a unit with nothing to run says so with a reason.
 */
const here = resolve(import.meta.dirname, "..");
let ws: string;
let config: Config;
let ledger: Ledger;
const write = (p: string, s = "x\n") => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, s));
const SPEC = "src/features/agency/agency.service.spec.ts";
const ok = { toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } };
const green = (g: GateInput): GateReport => ({ ok: true, steps: [], changedFiles: [], testFiles: g.testFiles.map((t) => t.path) });
const exec = (t: unknown, p: object = {}) => (t as { execute: (i: string, p: object) => Promise<{ content: Array<{ text: string }>; details: any }> }).execute("x", p);

beforeEach(() => {
	ws = join(here, ".sim", "tester-facts");
	rmSync(ws, { recursive: true, force: true });
	write(join(ws, "legacy", "app", "agency", "create.cmd.php"), "<?php\n");
	config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, models: {} });
	write(join(ws, "migrated", "package.json"), "{}");
	mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
	ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
	ledger.createUnit({ id: "u1", tier: "T1", deps: [], meta: { files: ["app/agency/create.cmd.php"], place: { stack: "nestjs", area: "agency", shared: false, source: "code" } }, symbolIds: [] });
	write(join(ws, ".bigrefactor", "truth", "u1", "interface.md"), "src/features/agency/agency.service.ts exports AgencyService\n");
});

describe("the tester knows where things are", () => {
	it("the prompt and the card name the legacy root, the target dir and exactly the globs the write gate gets (absolute)", async () => {
		ledger.addEvidence("u1", "truth_green_on_old", {});
		ledger.db.prepare("INSERT INTO truth_cases(id, unit_id, symbol_id, inputs, expected, verified_on_old, created_at) VALUES ('u1#1','u1','s','[]','1',1,'t')").run();
		let seen: { opts: SpawnOptions; task: string } | undefined;
		const spawn = async (opts: SpawnOptions): Promise<LeafSession> =>
			({
				run: async (task: string) => {
					if (opts.role === "test") {
						seen ??= { opts, task };
						write(join(ws, "migrated", SPEC), "it('u1#1 creates', () => {});\n");
					}
					return { text: "done", ...ok };
				},
				dispose() {},
			}) as unknown as LeafSession;
		// no test yet: the coverage retest runs the tester
		await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: spawn as never, gate: async (g) => green(g), log: () => {} });
		const { opts, task } = seen!;
		expect(opts.cwd).toBe(ws);
		for (const g of opts.writeGlobs) {
			expect(opts.systemPrompt).toContain(join(ws, g));
			expect(task).toContain(join(ws, g));
		}
		expect(opts.systemPrompt).toContain(config.source.path);
		expect(opts.systemPrompt).toContain(`cd ${join(ws, "migrated")} && `);
		expect(opts.systemPrompt).toMatch(/check_ported_tests/);
		expect(task).toContain(`relative to ${config.source.path}`);
		// the retest note says where it searched
		expect(task).toContain(join(ws, "migrated", "src/features/agency/**/*.spec.ts"));
	});

	it("a blocked write lists this session's own allowed paths and never a tool it does not have", () => {
		const tester = blockedHint("outside this unit's scope: src/x.ts", { cwd: "/ws", writeGlobs: [".bigrefactor/truth/u1/**", "migrated/src/a/**/*.spec.ts"], customTools: testerTools({ ledger, config, unitId: "u1", root: ws, targetProjectDir: ws, adapter: nestjsAdapter }) });
		expect(tester).toContain("You may write only: /ws/.bigrefactor/truth/u1/**, /ws/migrated/src/a/**/*.spec.ts");
		expect(tester).not.toMatch(/ledger_prove/);
		expect(blockedHint("x", { cwd: "/t", writeGlobs: ["src/a/**"], customTools: [{ name: "ledger_prove" } as never] })).toMatch(/ledger_prove/);
		expect(blockedHint("x", { cwd: "/t", writeGlobs: [] })).toMatch(/may not write files/);
	});
});

describe("check_ported_tests", () => {
	it("reports missing case ids (exact text only), where it searched, and the lint output from the target dir", async () => {
		const target = join(ws, "migrated");
		write(join(target, SPEC), "it('u1#1 creates', () => {}); it('u1-2 other spelling', () => {});\n");
		const adapter = { ...nestjsAdapter, lint: () => ({ cmd: "sh", args: ["-c", "pwd; echo 'spec: bad indent' >&2; exit 1"] }) };
		const tool = checkPortedTestsTool({ ledger, config, unitId: "u1", root: ws, targetProjectDir: target, adapter, moduleDir: "src/features/agency", currentTruth: () => ({ ok: true, cases: [{ symbol: "s", inputs: [], expected: 1 }, { symbol: "s", inputs: [], expected: 2 }] }) });
		const r = await exec(tool);
		const out = r.content[0]!.text;
		expect(r.details.missing).toEqual(["u1#2"]);
		expect(out).toContain("src/features/agency/**/*.spec.ts");
		expect(out).toContain(SPEC);
		expect(out).toMatch(/LINT FAILED[\s\S]*spec: bad indent/);
		expect(out).toContain(target); // ran from the target dir (pwd)
		expect(mentionsCase("u1-2", "u1#2")).toBe(false);
	});

	it("falls back to the recorded case ids when the truth does not load, and says why", async () => {
		ledger.db.prepare("INSERT INTO truth_cases(id, unit_id, symbol_id, inputs, expected, verified_on_old, created_at) VALUES ('u1#1','u1','s','[]','1',1,'t')").run();
		const tool = checkPortedTestsTool({ ledger, config, unitId: "u1", root: ws, targetProjectDir: join(ws, "migrated"), adapter: nestjsAdapter, moduleDir: "src/features/agency", currentTruth: () => ({ ok: false, cases: [], error: "cases.php: syntax error" }) });
		const r = await exec(tool);
		expect(r.details.missing).toEqual(["u1#1"]);
		expect(r.content[0]!.text).toMatch(/do not load yet: cases.php: syntax error/);
	});
});

describe("retests for coverage leave the truth cases alone", () => {
	it("the tester only adds tests: cases keep their ids and rows, a changed truth file is put back", async () => {
		const truthDir = join(ws, ".bigrefactor", "truth", "u1");
		const cases = '[{"symbol":"s","inputs":[],"expected":1},{"symbol":"s","inputs":[],"expected":2}]';
		write(join(truthDir, "cases.json"), cases);
		ledger.addEvidence("u1", "truth_read", {});
		ledger.db.prepare("INSERT INTO truth_cases(id, unit_id, symbol_id, inputs, expected, verified_on_old, created_at) VALUES ('u1#1','u1','s','[]','1',0,'t0'), ('u1#2','u1','s','[]','2',0,'t0')").run();
		write(join(ws, "migrated", SPEC), "it('u1#1 a', () => {});\n");
		const tasks: string[] = [];
		const protectedSeen: string[][] = [];
		const spawn = async (opts: SpawnOptions): Promise<LeafSession> =>
			({
				run: async (task: string) => {
					if (opts.role === "test") {
						tasks.push(task);
						protectedSeen.push(opts.protectedGlobs ?? []);
						write(join(truthDir, "cases.json"), '[{"symbol":"s","inputs":[],"expected":99}]'); // drifts: must not count
						write(join(ws, "migrated", SPEC), "it('u1#1 a', () => {}); it('u1#2 b', () => {});\n");
					}
					return { text: "done", ...ok };
				},
				dispose() {},
			}) as unknown as LeafSession;
		const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: spawn as never, gate: async (g) => green(g), log: () => {} });
		expect(tasks.length).toBe(1);
		expect(tasks[0]).toMatch(/stay exactly as they are/);
		expect(protectedSeen[0]).toContain(".bigrefactor/truth/u1/cases.json");
		expect(readFileSync(join(truthDir, "cases.json"), "utf8")).toBe(cases);
		expect(ledger.db.prepare("SELECT id, expected, created_at, ported_test_path FROM truth_cases WHERE unit_id = 'u1' ORDER BY id").all()).toEqual([
			{ id: "u1#1", expected: "1", created_at: "t0", ported_test_path: SPEC },
			{ id: "u1#2", expected: "2", created_at: "t0", ported_test_path: SPEC },
		]);
		expect(r.state).not.toBe("quarantined");
	});
});

describe("a full tester pass with the same cases", () => {
	it("keeps the recorded rows (ids, links) instead of deleting and re-inserting them", async () => {
		writeFileSync(join(ws, ".bigrefactor", "legacy-env.json"), JSON.stringify({ root: config.source.path, mode: "read" }));
		const truthDir = join(ws, ".bigrefactor", "truth", "u1");
		write(join(truthDir, "cases.json"), '[{"symbol":"s","inputs":[],"expected":1}]');
		ledger.addEvidence("u1", "truth_read", {});
		ledger.db.prepare("INSERT INTO truth_cases(id, unit_id, symbol_id, inputs, expected, verified_on_old, created_at) VALUES ('u1#1','u1','s','[]','1',0,'t0')").run();
		write(join(ws, "migrated", SPEC), "it('u1#1 a', () => {});\n");
		const spawn = async (): Promise<LeafSession> => ({ run: async () => ({ text: "done", ...ok }), dispose() {} }) as unknown as LeafSession;
		await runUnit({ ledger, config, root: ws, unitId: "u1", spawn: spawn as never, gate: async (g) => green(g), log: () => {} });
		expect(ledger.db.prepare("SELECT id, created_at FROM truth_cases WHERE unit_id = 'u1'").all()).toEqual([{ id: "u1#1", created_at: "t0" }]);
		expect(ledger.evidenceOf("u1").filter((e) => e.type === "truth_read").length).toBe(1);
	});
});

describe("quirks are recorded once", () => {
	const root = () => ws;
	it("the same behaviour in other spacing/case is the existing quirk; the model judges other wording", async () => {
		const a = recordQuirk({ ledger, root: root() }, { unitId: "u1", symbolId: "app/x.php::total", kind: "intentional", behaviour: "Returns '0' for an empty list", opinion: "keep", why: "callers compare strings" });
		const b = recordQuirk({ ledger, root: root() }, { unitId: "u1", symbolId: "app/x.php::total", kind: "edge_case", behaviour: "returns 0 for an empty list.", opinion: "keep", why: "same" });
		expect(b).toMatchObject({ id: a.id, duplicate: true });
		expect(quirksOf({ ledger }, "u1").length).toBe(1);
		// another wording on another symbol: the decision model says it is the same behaviour
		const client = new FakeModelClient({ decide: (req) => ("same" in req.questions ? { same: { type: "choice", choice: `q${a.id}`, probabilities: {}, confidence: 0.9 } } : {}) });
		const same = await sameQuirk({ ledger, config, client }, { unitId: "u1", symbolId: "app/x.php::sum", behaviour: "an empty input gives the string zero" });
		expect(same.row?.id).toBe(a.id);
		const none = await sameQuirk({ ledger, config }, { unitId: "u1", symbolId: "app/x.php::sum", behaviour: "an empty input gives the string zero" });
		expect(none.row).toBeUndefined();
	});

	it("record_quirk returns the existing quirk instead of a near-duplicate and lists the unit's quirks", async () => {
		ledger.upsertFile({ path: "app/x.php", hash: "h", lang: "php", loc: 1 });
		ledger.upsertSymbol({ id: "app/x.php::total", name: "total", kind: "function", path: "app/x.php" });
		ledger.db.prepare("UPDATE symbols SET unit_id = 'u1', state = 'clustered' WHERE id = ?").run("app/x.php::total");
		const client = new FakeModelClient({ decide: (req) => ("same" in req.questions ? { same: { type: "choice", choice: Object.keys((req.questions as any).same.criteria).find((k) => k !== "none")!, probabilities: {}, confidence: 0.9 } } : {}) });
		const tool = recordQuirkTool({ ledger, config, unitId: "u1", root: ws, targetProjectDir: ws, adapter: nestjsAdapter, client });
		const first = await exec(tool, { symbolId: "app/x.php::total", kind: "suspected_bug", behaviour: "rounds half down", opinion: "drop", why: "bug" });
		expect(first.content[0]!.text).toMatch(/Quirks of u1 so far:\n- #\d+ app\/x.php::total/);
		const second = await exec(tool, { symbolId: "app/x.php::total", kind: "suspected_bug", behaviour: "VAT rounding goes half-down", opinion: "drop", why: "bug" });
		expect(second.content[0]!.text).toMatch(/already recorded as quirk #/);
		expect(quirksOf({ ledger }, "u1").length).toBe(1);
		expect((recordQuirkTool({ ledger, config, unitId: "u1", root: ws, targetProjectDir: ws, adapter: nestjsAdapter }) as unknown as { description: string }).description).toMatch(/is a test case, not a quirk/);
	});
});

describe("a unit with no runtime behaviour", () => {
	it("the gate's test step passes without tests only with the tester's reason", async () => {
		const dir = mkdtempSync(join(tmpdir(), "br-none-"));
		execFileSync("git", ["init", "-q"], { cwd: dir });
		write(join(dir, "src", "features", "agency", "agency.repository.ts"), "export interface AgencyRepository {\n  find(id: number): string;\n}\n");
		const tick = { cmd: "true", args: [] as string[] };
		const adapter = { ...nestjsAdapter, build: () => tick, lint: () => tick, test: () => ({ cmd: "false", args: [] as string[] }) };
		const gate = () => runGate({ ledger, unitId: "u1", adapter, targetProjectDir: dir, writeGlobs: ["src/features/agency/**"], testFiles: [] });
		expect((await gate()).failedStep).toBe("ported_tests_green");
		ledger.addEvidence("u1", "truth_none", { reason: "only the repository contract" });
		const g = await gate();
		expect(g.ok).toBe(true);
		expect(g.steps.find((s) => s.name === "ported_tests_green")!.output).toMatch(/no runtime behaviour to pin.*only the repository contract/);
	});

	it("an empty case list is accepted only with the tester's reason", () => {
		const dir = join(ws, ".bigrefactor", "truth", "u1");
		expect(loadReadTruth(dir).ok).toBe(false);
		write(join(dir, NO_BEHAVIOUR_FILE), JSON.stringify({ reason: "only declares the AgencyRepository contract" }));
		expect(loadReadTruth(dir)).toMatchObject({ ok: true, cases: [], none: "only declares the AgencyRepository contract" });
		expect(verifyTruthOnOld(dir, config, getSourceAdapter("php"), ws)).toMatchObject({ ok: true, none: "only declares the AgencyRepository contract" });
	});

	it("the tester declares it; it is recorded as evidence, needs no tests, stands in for truth, and the reviewer sees the reason", async () => {
		const truthDir = join(ws, ".bigrefactor", "truth", "u1");
		rmSync(truthDir, { recursive: true, force: true });
		ledger.upsertFile({ path: "app/agency/create.cmd.php", hash: "h", lang: "php", loc: 1 });
		ledger.upsertSymbol({ id: "app/agency/create.cmd.php::Repo", name: "Repo", kind: "interface", path: "app/agency/create.cmd.php" });
		ledger.db.prepare("UPDATE symbols SET unit_id = 'u1', state = 'clustered' WHERE id = ?").run("app/agency/create.cmd.php::Repo");
		const spawn = async (opts: SpawnOptions): Promise<LeafSession> =>
			({
				run: async () => {
					if (opts.role === "test") {
						write(join(truthDir, "interface.md"), "src/features/agency/agency.repository.ts exports AgencyRepository\n");
						await exec(opts.customTools!.find((t) => t.name === "no_behaviour_to_pin"), { reason: "only declares the repository contract" });
					}
					return { text: "done", ...ok };
				},
				dispose() {},
			}) as unknown as LeafSession;
		let gateTests: string[] | undefined;
		await runUnit({ ledger, config, root: ws, unitId: "u1", spawn: spawn as never, gate: async (g) => ((gateTests = g.testFiles.map((t) => t.path)), green(g)), legacyFixer: false, log: () => {} });
		expect(ledger.hasEvidence("u1", "truth_none")).toBe(true);
		expect(noBehaviour(ledger, "u1")).toBe("only declares the repository contract");
		expect(ledger.db.prepare("SELECT COUNT(*) n FROM truth_cases WHERE unit_id = 'u1'").get()).toEqual({ n: 0 });
		expect(gateTests).toEqual([]);
		expect(existsSync(join(truthDir, NO_BEHAVIOUR_FILE))).toBe(true);
		// truth_none stands in for truth on the old code when a symbol becomes tested
		ledger.prove({ unitId: "u1", srcSymbol: "app/agency/create.cmd.php::Repo", op: "moved", targetSymbols: ["src/features/agency/agency.repository.ts::AgencyRepository"], why: "contract" });
		ledger.addEvidence("u1", "ported_tests_green", {});
		expect(() => ledger.transitionSymbol("app/agency/create.cmd.php::Repo", "tested")).not.toThrow();
		// the reviewer is told the reason
		let facts = "";
		const reviewSpawn = async (): Promise<LeafSession> => ({ run: async (t: string) => ((facts = t), { text: "", ...ok }), dispose() {} }) as unknown as LeafSession;
		await reviewWithModel({ ledger, config, root: ws, unitId: "u1", adapter: nestjsAdapter, targetProjectDir: join(ws, "migrated"), moduleDir: "src/features/agency", legacyFiles: [], changedFiles: [], spawn: reviewSpawn as never });
		expect(facts).toMatch(/no runtime behaviour to pin[\s\S]*only declares the repository contract/);
	});
});
