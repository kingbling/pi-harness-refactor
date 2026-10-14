import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { saveCommandOverride } from "../src/adapters/command-overrides.ts";
import { exampleProfileJson } from "../src/adapters/source/php.ts";
import { ConfigSchema, type Config } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { FakeModelClient } from "../src/models/fake.ts";
import type { GateInput, GateReport } from "../src/run/gate.ts";
import { LEGACY_DOWN } from "../src/run/legacy-env.ts";
import { runUnit } from "../src/run/unit.ts";
import type { LeafSession } from "../src/sessions/spawn.ts";

/**
 * runUnit wiring around the gate: approved tidy tasks reach the write scope on the first unit after the answer,
 * and a doctor diagnosis becomes a model-phrased question (never code-written question text).
 */
const here = resolve(import.meta.dirname, "..");
let ws: string;
let config: Config;
let ledger: Ledger;
const write = (p: string, s = "x\n") => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, s));
const spawn = async (): Promise<LeafSession> => ({ run: async () => ({ text: "done", toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } }), dispose() {} }) as unknown as LeafSession;
const failing = (output: string): GateReport => ({ ok: false, steps: [{ name: "antigaming_ok", ok: false, ms: 1, output }], changedFiles: ["src/features/agency/agency.service.ts"], failedStep: "antigaming_ok", testFiles: [] });

beforeEach(() => {
	ws = join(here, ".sim", "unit-wiring");
	rmSync(ws, { recursive: true, force: true });
	write(join(ws, "legacy", "app", "behaviour", "commands", "agency", "create.cmd.php"), "<?php\n");
	config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, models: {} });
	write(join(ws, "migrated", "package.json"), "{}");
	mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
	ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
	// the profile model picked the legacy file kinds; the gate gets them through the source adapter
	writeFileSync(join(ws, ".bigrefactor", "framework-profile.json"), JSON.stringify({ ...exampleProfileJson(), legacyWords: ["tpl", "cmd"] }));
	ledger.createUnit({ id: "u1", tier: "T0", deps: [], meta: { files: ["app/behaviour/commands/agency/create.cmd.php"], place: { stack: "nestjs", area: "agency", shared: false, source: "code" } }, symbolIds: [] });
	// truth captured before: the tester is skipped
	write(join(ws, ".bigrefactor", "truth", "u1", "interface.md"), "src/features/agency/agency.service.ts exports AgencyService\n");
	ledger.addEvidence("u1", "truth_green_on_old", {});
});

describe("runUnit wiring", () => {
	it("an approved tidy task is in scope and sanctioned for the first unit after the answer", async () => {
		const q = ledger.askQuestion({ point: "tidy", question: "q", blocks: "none", askedBy: "tidy" });
		ledger.answerQuestion(q, "apply", "human");
		const task = { id: `T${q}`, stack: "nestjs", area: "agency", op: "merge", from: ["src/shared/agency-utils/fmt.ts"], to: ["src/features/agency/lib/fmt.ts"], why: "only agency uses it", questionId: q, status: "asked" };
		ledger.setMeta("tidy_tasks", JSON.stringify([task]));
		const seen: GateInput[] = [];
		const gate = async (g: GateInput): Promise<GateReport> => (seen.push(g), { ok: true, steps: [], changedFiles: [], testFiles: [] });
		await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn, gate, log: () => {} });
		expect(seen[0]!.writeGlobs).toEqual(["src/features/agency/**", "src/shared/agency-utils/fmt.ts", "src/features/agency/lib/fmt.ts"]);
		expect(seen[0]!.sanctioned).toEqual(["src/shared/agency-utils/fmt.ts", "src/features/agency/lib/fmt.ts"]);
		expect(seen[0]!.legacyWords).toContain("tpl");
	});

	it("a generated stack without generated wiring: the files its manifest names for registration are in the implementer's scope", async () => {
		const cmd = { cmd: "true", args: [] };
		const m = {
			id: "go-wire", role: "server", subdir: "api", aliases: [], docs: [], scaffold: { ...cmd, readyFile: "package.json" }, postScaffold: [], build: cmd, lint: cmd, test: cmd,
			toolchain: { ecosystem: "go", packageName: "^[\\w./-]+", packageExamples: [], manifestFiles: ["go.mod"], installed: { file: "", keys: [] }, add: cmd, worktreeLinks: [], ignoredPaths: [] },
			layout: { moduleDir: "internal/{area}", structureDoc: "-", sharedDirs: ["internal/shared/"], testFileGlobs: ["{moduleDir}/*_test.go"], testFileRegex: "_test\\.go$", sourceExtensions: [".go"], langByExtension: {}, skipMarker: "t\\.Skip", interfaceHint: "-", testHint: "-", legacyMarker: "// LEGACY: {why}", dataAccessHint: "", ignoreDirs: [], wiringFiles: ["cmd/server/routes.go"] },
			platform: {}, stackChoices: [], protectedGlobs: [], patternKinds: ["handler"], probeTest: { path: "x_test.go", content: "" }, detect: { file: "go.mod", contains: "module" },
		};
		write(join(ws, ".bigrefactor", "adapters", "go-wire.json"), JSON.stringify(m));
		const goConfig = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["go-wire"] }, models: {} });
		ledger.db.prepare("UPDATE units SET meta = ? WHERE id = 'u1'").run(JSON.stringify({ files: ["app/behaviour/commands/agency/create.cmd.php"], place: { stack: "go-wire", area: "agency", shared: false, source: "code" } }));
		const seen: GateInput[] = [];
		const gate = async (g: GateInput): Promise<GateReport> => (seen.push(g), { ok: true, steps: [], changedFiles: [], testFiles: [] });
		write(join(ws, ".bigrefactor", "truth", "u1", "interface.md"), "internal/agency/agency.go exports Service\n");
		await runUnit({ ledger, config: goConfig, root: ws, unitId: "u1", reuseTruth: true, spawn, gate, log: () => {} });
		expect(seen[0]!.writeGlobs).toEqual(["internal/agency/**", "cmd/server/routes.go"]);
	});

	it("an identical anti-gaming red twice asks the owner once, after the doctor, with the diagnosis phrased by the model", async () => {
		const client = new FakeModelClient({ chat: () => ({ json: { action: "unknown", summary: "the protected globs block the module dir", question: "The gate keeps refusing agency writes: fix the protected globs?", options: [], recommended: "retry", opinion: "Looks like config." } }) });
		const gate = async (): Promise<GateReport> => failing("write outside unit scope: src/features/agency/agency.service.ts");
		const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn, gate, client, log: () => {} });
		const qs = ledger.db.prepare("SELECT point, question, status, context FROM questions WHERE unit_id = 'u1' ORDER BY id").all() as Array<{ point: string; question: string; status: string; context: string }>;
		expect(qs.map((q) => [q.point, q.status])).toEqual([["gate_env", "open"]]);
		expect(qs[0]!.question).toContain("The gate keeps refusing agency writes: fix the protected globs?");
		expect(JSON.parse(qs[0]!.context).diagnosis.summary).toBe("the protected globs block the module dir");
		expect(JSON.parse(ledger.getUnit("u1")!.meta).parked.question).toBe(ledger.openQuestions()[0]!.id);
		expect(r.attempts).toBe(2);
	});

	it("the same reviewer finding after a retest goes to the stronger model, not the tester again; nobody is asked", async () => {
		const roles: string[] = [];
		const spawnRoles = async (opts: { role: string }): Promise<LeafSession> => (roles.push(opts.role), spawn());
		const client = new FakeModelClient({ decide: (req) => (req.questions["cause"] ? { cause: "interface_mismatch" } : undefined) });
		const gate = async (): Promise<GateReport> => ({ ok: false, steps: [{ name: "wired_ok", ok: false, ms: 1, output: "- src/features/agency/agency.service.ts: create() is never called from the controller" }], changedFiles: ["src/features/agency/agency.service.ts"], failedStep: "wired_ok", testFiles: [] });
		const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: spawnRoles as never, gate, client, log: () => {} });
		// one retest after the first red; every later round escalates (the retest changed nothing and the finding stays)
		expect(roles.filter((x) => x === "test")).toHaveLength(1);
		expect(roles.filter((x) => x !== "test")).toEqual(["implement", "implement", "escalate", "escalate", "escalate"]);
		expect(ledger.db.prepare("SELECT count(*) AS n FROM questions").get()).toEqual({ n: 0 });
		expect(r.state).toBe("quarantined");
	});

	it("triage's retest is not dropped when the same step fails again and the doctor says reimplement", async () => {
		const roles: string[] = [];
		let retests = 0;
		// each tester run changes its test: a retest that made progress
		const spawnRoles = async (opts: { role: string }): Promise<LeafSession> => {
			roles.push(opts.role);
			if (opts.role === "test") write(join(ws, "migrated", "src", "features", "agency", "agency.service.spec.ts"), `it('u1 ${++retests}', () => {});\n`);
			return spawn();
		};
		const client = new FakeModelClient({ decide: (req) => (req.questions["cause"] ? { cause: "test_bug" } : undefined), chat: () => ({ json: { action: "reimplement", summary: "create() returns the wrong id", command: "", note: "" } }) });
		// the same step with a different finding each time: never the same finding twice
		let gates = 0;
		const gate = async (): Promise<GateReport> => ({ ok: false, steps: [{ name: "ported_tests_green", ok: false, ms: 1, output: `- src/features/agency/case${++gates}.ts: expected 2, got 3` }], changedFiles: ["src/features/agency/agency.service.ts"], failedStep: "ported_tests_green", testFiles: [] });
		await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: spawnRoles as never, gate, client, log: () => {} });
		// attempt 2 is stuck (same step twice): the doctor runs, and triage's retest still runs before the next attempt
		expect(roles.slice(0, 4)).toEqual(["implement", "test", "implement", "test"]);
	});

	it("the orchestrator's note (a retry's hint and last failure) reaches every implementer attempt, not only the first", async () => {
		const tasks: string[] = [];
		const spawnTasks = async (opts: { role: string }): Promise<LeafSession> => ({ run: async (task: string) => (opts.role !== "test" && tasks.push(task), { text: "done", toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } }), dispose() {} }) as unknown as LeafSession;
		const client = new FakeModelClient({ decide: (req) => (req.questions["cause"] ? { cause: "impl_bug" } : undefined), chat: () => ({ json: { action: "reimplement", summary: "create() returns the wrong id", command: "", note: "return the new row's id" } }) });
		const gate = async (): Promise<GateReport> => ({ ok: false, steps: [{ name: "ported_tests_green", ok: false, ms: 1, output: "", exitCode: 1 }], changedFiles: ["src/features/agency/agency.service.ts"], failedStep: "ported_tests_green", testFiles: [] });
		await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: spawnTasks as never, gate, client, retryNote: "The owner's hint: create() must return the id from the insert", log: () => {} });
		expect(tasks.length).toBeGreaterThan(1);
		for (const t of tasks) expect(t).toMatch(/Note from the orchestrator\nThe owner's hint: create\(\) must return the id/);
	});

	it("a doctor 'reimplement' past its two actions goes to the stronger model and then the cap: no environment question", async () => {
		const roles: string[] = [];
		const spawnRoles = async (opts: { role: string }): Promise<LeafSession> => (roles.push(opts.role), spawn());
		const client = new FakeModelClient({ decide: (req) => (req.questions["cause"] ? { cause: "impl_bug" } : undefined), chat: () => ({ json: { action: "reimplement", summary: "create() returns the wrong id", command: "", note: "return the new row's id" } }) });
		// a tool that printed nothing: triage hands it to the doctor every time
		const gate = async (): Promise<GateReport> => ({ ok: false, steps: [{ name: "ported_tests_green", ok: false, ms: 1, output: "", exitCode: 1 }], changedFiles: ["src/features/agency/agency.service.ts"], failedStep: "ported_tests_green", testFiles: [] });
		const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: spawnRoles as never, gate, client, log: () => {} });
		expect(roles).toEqual(["implement", "implement", "implement", "escalate", "escalate"]);
		expect(ledger.db.prepare("SELECT count(*) AS n FROM questions").get()).toEqual({ n: 0 });
		expect(r.state).toBe("quarantined");
	});

	it("triage's ask_human asks nobody first: the doctor looks, and only when it cannot help one retry/leave question is asked", async () => {
		const client = new FakeModelClient({ decide: (req) => (req.questions["cause"] ? { cause: "env" } : undefined), chat: () => ({ json: { action: "unknown", summary: "the DB container is down", question: "The tests cannot reach the DB: start it?", options: [], recommended: "retry", opinion: "Infra." } }) });
		const gate = async (): Promise<GateReport> => ({ ok: false, steps: [{ name: "ported_tests_green", ok: false, ms: 1, output: "FAIL src/features/agency/agency.service.spec.ts\nconnect ECONNREFUSED 127.0.0.1:5432" }], changedFiles: ["src/features/agency/agency.service.ts"], failedStep: "ported_tests_green", testFiles: ["src/features/agency/agency.service.spec.ts"] });
		await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn, gate, client, log: () => {} });
		const qs = ledger.db.prepare("SELECT point, status, options, context FROM questions WHERE unit_id = 'u1' ORDER BY id").all() as Array<{ point: string; status: string; options: string; context: string }>;
		expect(qs.map((q) => [q.point, q.status])).toEqual([["gate_env", "open"]]);
		expect((JSON.parse(qs[0]!.options) as string[]).map((o) => o.split(" ")[0])).toEqual(["retry", "leave"]);
		expect(JSON.parse(qs[0]!.context).diagnosis.summary).toBe("the DB container is down");
		// the failing ported test is in what Jev saw
		const state = (client.calls.find((c) => c.kind === "decide")!.req as { state: { failing_tests: string[] } }).state;
		expect(state.failing_tests).toContain("src/features/agency/agency.service.spec.ts");
	});

	it("a test file the tester removed after the list was made does not crash the next attempt", async () => {
		const spec = join(ws, "migrated", "src", "features", "agency", "agency.service.spec.ts");
		write(spec, "it('x', () => {});\n");
		let calls = 0;
		const gate = async (g: GateInput): Promise<GateReport> => {
			calls++;
			if (calls > 1) return { ok: true, steps: [], changedFiles: [], testFiles: g.testFiles.map((t) => t.path) };
			rmSync(join(g.targetProjectDir, "src", "features", "agency", "agency.service.spec.ts"), { force: true });
			return { ok: false, steps: [{ name: "ported_tests_green", ok: false, ms: 1, output: "1 failing" }], changedFiles: [], failedStep: "ported_tests_green", testFiles: g.testFiles.map((t) => t.path) };
		};
		const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn, gate, log: () => {} });
		expect(calls).toBeGreaterThan(1);
		expect(r.state).not.toBe("crashed");
	});

	it("truth that stays red gets the old code's environment set up once; the unit then goes on and other units' questions are answered", async () => {
		rmSync(join(ws, ".bigrefactor", "truth", "u1"), { recursive: true, force: true });
		ledger.db.prepare("DELETE FROM evidence").run();
		const other = ledger.askQuestion({ point: "truth_env", question: "old code does not run", askedBy: "orchestrator" });
		const truthDir = join(ws, ".bigrefactor", "truth", "u1");
		const tester = async (opts: { role: string }): Promise<LeafSession> =>
			({
				run: async () => {
					if (opts.role === "test") {
						write(join(truthDir, "cases.php"), "<?php require 'vendor/autoload.php'; require 'app/behaviour/commands/agency/create.cmd.php';\n");
						write(join(truthDir, "cases.php.json"), '[{"symbol":"app/behaviour/commands/agency/create.cmd.php::create","inputs":[],"expected":1}]');
						write(join(truthDir, "interface.md"), "src/features/agency/agency.service.ts exports AgencyService\n");
						write(join(ws, "migrated", "src", "features", "agency", "agency.service.spec.ts"), "it('u1#1 creates', () => {});\n");
					}
					return { text: "done", toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } };
				},
				dispose() {},
			}) as unknown as LeafSession;
		const { legacyRunTool } = await import("../src/run/legacy-env.ts");
		let fixes = 0;
		const legacyFixer = async (o: { root: string; config: Config }) => {
			fixes++;
			await (legacyRunTool(o.root, o.config) as unknown as { execute: (i: string, p: object) => Promise<unknown> }).execute("x", { cmd: "sh", args: ["-c", 'cat "$0.json"', "{script}"], why: "test runner" });
			return "set up the old code's runner";
		};
		const gate = async (g: GateInput): Promise<GateReport> => ({ ok: true, steps: [], changedFiles: [], testFiles: g.testFiles.map((t) => t.path) });
		await runUnit({ ledger, config, root: ws, unitId: "u1", spawn: tester as never, gate, legacyFixer, log: () => {} });
		expect(fixes).toBe(1);
		expect(ledger.hasEvidence("u1", "truth_green_on_old")).toBe(true);
		expect(ledger.getQuestion(other)!.answer).toMatch(/^auto: the old code's environment was set up/);
		expect(ledger.openQuestions().filter((q) => q.point === "truth_env")).toEqual([]);
	});

	it("a gate failure already asked about for another unit waits on that question: no triage, no doctor, no new question", async () => {
		ledger.createUnit({ id: "u0", tier: "T0", deps: [], meta: {}, symbolIds: [] });
		const out = "phpstan: Allowed memory size of 134217728 bytes exhausted";
		const { errorSignature } = await import("../src/run/gate.ts");
		const q = ledger.askQuestion({ unitId: "u0", point: "gate_env", question: "more memory?", context: { sameAs: errorSignature("lint_ok", out) }, askedBy: "t" });
		let calls = 0;
		const client = new FakeModelClient({ chat: () => (calls++, { json: {} }) });
		const gate = async (): Promise<GateReport> => ({ ok: false, steps: [{ name: "lint_ok", ok: false, ms: 1, output: out }], changedFiles: [], failedStep: "lint_ok", testFiles: [] });
		await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn, gate, client, log: () => {} });
		expect(calls).toBe(0);
		expect(ledger.openQuestions().map((x) => x.id)).toEqual([q]);
		expect(ledger.blockedUnits().get("u1")).toEqual([q]);
	});
	it("truth that cannot run on the old code is read from it instead, marked as not run; no question", async () => {
		rmSync(join(ws, ".bigrefactor", "truth", "u1"), { recursive: true, force: true });
		ledger.db.prepare("DELETE FROM evidence").run();
		const truthDir = join(ws, ".bigrefactor", "truth", "u1");
		const prompts: string[] = [];
		const tester = async (opts: { role: string; systemPrompt: string }): Promise<LeafSession> =>
			({
				run: async (task: string) => {
					if (opts.role === "test") {
						prompts.push(opts.systemPrompt);
						write(join(truthDir, "cases.php"), "<?php exit(1);\n"); // never runs green
						if (task.includes("cases.json")) write(join(truthDir, "cases.json"), '[{"symbol":"app/behaviour/commands/agency/create.cmd.php::create","inputs":["Acme"],"expected":{"id":7}}]');
						write(join(truthDir, "interface.md"), "src/features/agency/agency.service.ts exports AgencyService\n");
						write(join(ws, "migrated", "src", "features", "agency", "agency.service.spec.ts"), "it('u1#1 creates', () => {});\n");
					}
					return { text: "done", toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } };
				},
				dispose() {},
			}) as unknown as LeafSession;
		const gate = async (g: GateInput): Promise<GateReport> => ({ ok: true, steps: [], changedFiles: [], testFiles: g.testFiles.map((t) => t.path) });
		await runUnit({ ledger, config, root: ws, unitId: "u1", spawn: tester as never, gate, legacyFixer: false, log: () => {} });
		expect(ledger.hasEvidence("u1", "truth_green_on_old")).toBe(false);
		expect(ledger.hasEvidence("u1", "truth_read")).toBe(true);
		expect(ledger.db.prepare("SELECT verified_on_old, ported_test_path FROM truth_cases WHERE unit_id = 'u1'").all()).toEqual([{ verified_on_old: 0, ported_test_path: "src/features/agency/agency.service.spec.ts" }]);
		expect(prompts.at(-1)).toMatch(/cannot run here/);
		expect(ledger.openQuestions()).toEqual([]);
	});

	it("in read mode the tester still tries a small script for its unit: green on the old code, its cases count as run", async () => {
		rmSync(join(ws, ".bigrefactor", "truth", "u1"), { recursive: true, force: true });
		ledger.db.prepare("DELETE FROM evidence").run();
		// the workspace probe found no way to run the old app; this unit's own file still runs (runner: print the script's .json)
		writeFileSync(join(ws, ".bigrefactor", "legacy-env.json"), JSON.stringify({ root: config.source.path, mode: "read", run: { cmd: "sh", args: ["-c", 'cat "$0.json"', "{script}"] } }));
		const truthDir = join(ws, ".bigrefactor", "truth", "u1");
		const prompts: string[] = [];
		const tester = async (opts: { role: string; systemPrompt: string }): Promise<LeafSession> =>
			({
				run: async () => {
					if (opts.role === "test") {
						prompts.push(opts.systemPrompt);
						write(join(truthDir, "cases.php"), "<?php require 'app/behaviour/commands/agency/create.cmd.php';\n");
						write(join(truthDir, "cases.php.json"), '[{"symbol":"app/behaviour/commands/agency/create.cmd.php::create","inputs":[],"expected":1}]');
						write(join(truthDir, "interface.md"), "src/features/agency/agency.service.ts exports AgencyService\n");
						write(join(ws, "migrated", "src", "features", "agency", "agency.service.spec.ts"), "it('u1#1 creates', () => {});\n");
					}
					return { text: "done", toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } };
				},
				dispose() {},
			}) as unknown as LeafSession;
		const gate = async (g: GateInput): Promise<GateReport> => ({ ok: true, steps: [], changedFiles: [], testFiles: g.testFiles.map((t) => t.path) });
		await runUnit({ ledger, config, root: ws, unitId: "u1", spawn: tester as never, gate, legacyFixer: false, log: () => {} });
		expect(prompts[0]).toMatch(/First try a SMALL script for this unit only/);
		expect(ledger.hasEvidence("u1", "truth_green_on_old")).toBe(true);
		expect(ledger.hasEvidence("u1", "truth_read")).toBe(false);
		expect(ledger.db.prepare("SELECT verified_on_old FROM truth_cases WHERE unit_id = 'u1'").all()).toEqual([{ verified_on_old: 1 }]);
	});

	it("a truth run that fails while the probe fails too is the old code's runtime being down: no read truth, no question, tested again later", async () => {
		rmSync(join(ws, ".bigrefactor", "truth", "u1"), { recursive: true, force: true });
		ledger.db.prepare("DELETE FROM evidence").run();
		// the runtime (a container daemon) is down while the file "down" is in the old code's folder; the probe ran green before
		writeFileSync(join(ws, ".bigrefactor", "legacy-env.json"), JSON.stringify({ root: config.source.path, mode: "run", run: { cmd: "sh", args: ["-c", 'test ! -e down && cat "$0.json"', "{script}"] } }));
		const probe = join(ws, ".bigrefactor", "legacy-env", "probe", "cases.php");
		write(probe, "<?php\n");
		write(`${probe}.json`, '[{"symbol":"probe","inputs":[],"expected":1}]');
		write(join(config.source.path, "down"), "");
		const truthDir = join(ws, ".bigrefactor", "truth", "u1");
		let testers = 0;
		const tester = async (opts: { role: string }): Promise<LeafSession> =>
			({
				run: async () => {
					if (opts.role === "test") {
						testers++;
						write(join(truthDir, "cases.php"), "<?php require 'app/behaviour/commands/agency/create.cmd.php';\n");
						write(join(truthDir, "cases.php.json"), '[{"symbol":"app/behaviour/commands/agency/create.cmd.php::create","inputs":[],"expected":1}]');
						write(join(truthDir, "cases.json"), '[{"symbol":"app/behaviour/commands/agency/create.cmd.php::create","inputs":[],"expected":1}]');
						write(join(truthDir, "interface.md"), "src/features/agency/agency.service.ts exports AgencyService\n");
						write(join(ws, "migrated", "src", "features", "agency", "agency.service.spec.ts"), "it('u1#1 creates', () => {});\n");
					}
					return { text: "done", toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } };
				},
				dispose() {},
			}) as unknown as LeafSession;
		const gate = async (g: GateInput): Promise<GateReport> => ({ ok: true, steps: [], changedFiles: [], testFiles: g.testFiles.map((t) => t.path) });
		const was = { ...LEGACY_DOWN };
		Object.assign(LEGACY_DOWN, { tries: 2, waitMs: 10 });
		try {
			await runUnit({ ledger, config, root: ws, unitId: "u1", spawn: tester as never, gate, legacyFixer: false, log: () => {} });
			expect(testers).toBe(1);
			expect(ledger.hasEvidence("u1", "truth_read")).toBe(false);
			expect(ledger.hasEvidence("u1", "truth_green_on_old")).toBe(false);
			expect(ledger.openQuestions()).toEqual([]);
			// picked up again while it is still down: no tester session is paid for
			await runUnit({ ledger, config, root: ws, unitId: "u1", spawn: tester as never, gate, legacyFixer: false, log: () => {} });
			expect(testers).toBe(1);
			// back up: the truth comes from running the old code
			rmSync(join(config.source.path, "down"));
			await runUnit({ ledger, config, root: ws, unitId: "u1", spawn: tester as never, gate, legacyFixer: false, log: () => {} });
			expect(ledger.hasEvidence("u1", "truth_green_on_old")).toBe(true);
			expect(ledger.hasEvidence("u1", "truth_read")).toBe(false);
		} finally {
			Object.assign(LEGACY_DOWN, was);
		}
	});

	it("in read mode a red script with valid read cases still goes to the setup model with the script's error; fixed, the cases count as run", async () => {
		rmSync(join(ws, ".bigrefactor", "truth", "u1"), { recursive: true, force: true });
		ledger.db.prepare("DELETE FROM evidence").run();
		writeFileSync(join(ws, ".bigrefactor", "legacy-env.json"), JSON.stringify({ root: config.source.path, mode: "read" }));
		const truthDir = join(ws, ".bigrefactor", "truth", "u1");
		const tester = async (opts: { role: string }): Promise<LeafSession> =>
			({
				run: async () => {
					if (opts.role === "test") {
						write(join(truthDir, "cases.php"), "<?php require 'app/behaviour/commands/agency/create.cmd.php'; new CommandBase();\n");
						write(join(truthDir, "cases.php.json"), '[{"symbol":"app/behaviour/commands/agency/create.cmd.php::create","inputs":[],"expected":1}]');
						write(join(truthDir, "cases.json"), '[{"symbol":"app/behaviour/commands/agency/create.cmd.php::create","inputs":[],"expected":1}]');
						write(join(truthDir, "interface.md"), "src/features/agency/agency.service.ts exports AgencyService\n");
						write(join(ws, "migrated", "src", "features", "agency", "agency.service.spec.ts"), "it('u1#1 creates', () => {});\n");
					}
					return { text: "done", toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } };
				},
				dispose() {},
			}) as unknown as LeafSession;
		const { legacyRunTool } = await import("../src/run/legacy-env.ts");
		const problems: string[] = [];
		const legacyFixer = async (o: { root: string; config: Config; problem: string }) => {
			problems.push(o.problem);
			await (legacyRunTool(o.root, o.config) as unknown as { execute: (i: string, p: object) => Promise<unknown> }).execute("x", { cmd: "sh", args: ["-c", 'cat "$0.json"', "{script}"], why: "bootstrap first" });
			return "the framework bootstrap is loaded first";
		};
		// the default runner (php) fails here the way a missing bootstrap does; the fixer's runner makes it green
		writeFileSync(join(ws, ".bigrefactor", "legacy-env.json"), JSON.stringify({ root: config.source.path, mode: "read", run: { cmd: "sh", args: ["-c", "echo 'Class \"CommandBase\" not found' >&2; exit 255", "{script}"] } }));
		const gate = async (g: GateInput): Promise<GateReport> => ({ ok: true, steps: [], changedFiles: [], testFiles: g.testFiles.map((t) => t.path) });
		await runUnit({ ledger, config, root: ws, unitId: "u1", spawn: tester as never, gate, legacyFixer, log: () => {} });
		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatch(/CommandBase/);
		expect(ledger.hasEvidence("u1", "truth_green_on_old")).toBe(true);
		expect(ledger.db.prepare("SELECT verified_on_old FROM truth_cases WHERE unit_id = 'u1'").all()).toEqual([{ verified_on_old: 1 }]);
	});

	it("every truth case needs a test naming its id: the tester adds what is missing, then the unit stops", async () => {
		ledger.db.prepare("INSERT INTO truth_cases(id, unit_id, symbol_id, inputs, expected, verified_on_old, created_at) VALUES ('u1#1','u1','s','[]','1',1,'t'), ('u1#2','u1','s','[]','2',1,'t')").run();
		write(join(ws, "migrated", "src", "features", "agency", "agency.service.spec.ts"), "it('u1#1 a', () => {}); it('u1#12 b', () => {});\n");
		const tasks: string[] = [];
		const tester = async (opts: { role: string }): Promise<LeafSession> => ({ run: async (t: string) => (opts.role === "test" && tasks.push(t), { text: "done", toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } }), dispose() {} }) as unknown as LeafSession;
		let gates = 0;
		const gate = async (): Promise<GateReport> => (gates++, { ok: true, steps: [], changedFiles: [], testFiles: [] });
		const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: tester as never, gate, log: () => {} });
		expect(tasks.length).toBe(2);
		expect(tasks[0]).toMatch(/u1#2/);
		expect(r.state).toBe("quarantined");
		expect(gates).toBe(0);
	});

	it("provider errors count only in a row: a session that works resets the count (error, ok, error, error → no question)", async () => {
		const ok = { text: "done", toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } };
		const err = { text: "", toolCalls: 0, blocked: 0, usage: { input: 0, output: 0, cost: 0 }, error: "provider returned 503" };
		const script = [err, ok, err, err, ok];
		const spawnScripted = async (): Promise<LeafSession> => ({ run: async () => script.shift()!, dispose() {} }) as unknown as LeafSession;
		let gates = 0;
		const gate = async (): Promise<GateReport> => (++gates === 1 ? { ok: false, steps: [{ name: "ported_tests_green", ok: false, ms: 1, output: "1 failing" }], changedFiles: [], failedStep: "ported_tests_green", testFiles: [] } : { ok: true, steps: [], changedFiles: [], testFiles: [] });
		const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: spawnScripted as never, gate, log: () => {} });
		expect(script).toEqual([]);
		expect(gates).toBe(2);
		expect(ledger.db.prepare("SELECT count(*) AS n FROM questions").get()).toEqual({ n: 0 });
		expect(r.state).toBe("review");
		expect(r.attempts).toBe(2);
	});

	it("three provider errors in a row: one provider question, no attempt burned, never quarantined", async () => {
		const err = { text: "", toolCalls: 0, blocked: 0, usage: { input: 0, output: 0, cost: 0 }, error: "provider returned 503" };
		let sessions = 0;
		const spawnErr = async (): Promise<LeafSession> => ({ run: async () => (sessions++, err), dispose() {} }) as unknown as LeafSession;
		let gates = 0;
		const gate = async (): Promise<GateReport> => (gates++, { ok: true, steps: [], changedFiles: [], testFiles: [] });
		const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: spawnErr as never, gate, log: () => {} });
		expect(sessions).toBe(3);
		expect(gates).toBe(0);
		expect(ledger.db.prepare("SELECT point FROM questions WHERE unit_id = 'u1'").all()).toEqual([{ point: "env" }]);
		expect(r.attempts).toBe(0);
		expect(r.state).not.toBe("quarantined");
	});

	it("truth ahead with an interface outside the placement stops after the retests but never quarantines; a real run does", async () => {
		write(join(ws, ".bigrefactor", "truth", "u1", "interface.md"), "src/features/billing/invoice.service.ts exports InvoiceService\n");
		const roles: string[] = [];
		const spawnRoles = async (opts: { role: string }): Promise<LeafSession> => (roles.push(opts.role), spawn());
		let gates = 0;
		const gate = async (): Promise<GateReport> => (gates++, { ok: true, steps: [], changedFiles: [], testFiles: [] });
		const ahead = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, truthOnly: true, spawn: spawnRoles as never, gate, log: () => {} });
		expect(roles).toEqual(["test", "test"]);
		expect(ahead.state).toBe("planned");
		expect(ledger.getUnit("u1")!.state).toBe("planned");
		expect(ledger.transitionsOf("unit", "u1").map((t) => t.to_state)).not.toContain("quarantined");
		expect(gates).toBe(0);
		// the same interface on the unit's real run: implementing against it is refused, the unit is quarantined
		const real = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: spawnRoles as never, gate, log: () => {} });
		expect(real.state).toBe("quarantined");
		expect(gates).toBe(0);
	});

	it("the reviewer's open findings are kept in the unit's meta: every implementer and reviewer gets them; a pass clears them", async () => {
		const tasks: string[] = [];
		// each implementer changes the code (unchanged code would reuse the last verdict)
		const spawnTasks = async (opts: { role: string }): Promise<LeafSession> => ({ run: async (task: string) => (opts.role !== "test" && (tasks.push(task), write(join(ws, "migrated", "src/features/agency/agency.service.ts"), `// ${tasks.length}\n`)), { text: "done", toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } }), dispose() {} }) as unknown as LeafSession;
		const lists = [["- a.ts:1: A → fix A", "- b.ts:2: B → fix B"], ["- b.ts:2: B → fix B"]];
		const seen: Array<string[] | undefined> = [];
		let n = 0;
		const reviewer = async (i: { openFindings?: string[] }) => {
			seen.push(i.openFindings);
			const findings = lists[n++];
			return findings ? { ok: false, judged: true, output: `reviewer findings:\n${findings.join("\n")}`, findings } : { ok: true, judged: true, output: "fine", findings: [] };
		};
		const gate = async (g: GateInput): Promise<GateReport> => {
			const r = await g.review!(["src/features/agency/agency.service.ts"]);
			return { ok: r.ok, steps: [{ name: "wired_ok", ok: r.ok, ms: 1, output: r.output }], changedFiles: ["src/features/agency/agency.service.ts"], failedStep: r.ok ? undefined : "wired_ok", testFiles: [] };
		};
		// each attempt is a new session: only the list kept in the unit's meta carries the earlier findings
		await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: spawnTasks as never, gate, reviewer: reviewer as never, setupFixer: false, log: () => {} });
		expect(seen).toEqual([[], lists[0], lists[1]]);
		expect(tasks[0]).not.toContain("Open reviewer findings");
		expect(tasks[1]).toMatch(/Open reviewer findings for this unit[^\n]*\n- a\.ts:1: A → fix A\n- b\.ts:2: B → fix B/);
		expect(tasks[2]).toMatch(/Open reviewer findings for this unit[^\n]*\n- b\.ts:2: B → fix B/);
		expect(JSON.parse(ledger.getUnit("u1")!.meta).reviewFindings).toEqual([]);
	});

	describe("reviewer findings outside the unit's files", () => {
		const outOfScope = "- the autoload map does not cover src/Agency → add the mapping to the project manifest";
		const reviewer = async () => ({ ok: false, judged: true, output: `outside the unit's files (setup fixer, else the owner):\n${outOfScope}`, outOfScope, outOfScopeSetup: true });
		const gate = async (g: GateInput): Promise<GateReport> => {
			const r = await g.review!(["src/features/agency/agency.service.ts"]);
			return { ok: false, steps: [{ name: "wired_ok", ok: false, ms: 1, output: r.output }], changedFiles: ["src/features/agency/agency.service.ts"], failedStep: "wired_ok", testFiles: [] };
		};

		it("go to the setup fixer first, then one owner question; no second attempt for the implementer", async () => {
			const fixerSaw: string[] = [];
			const setupFixer = async (o: { problem: string }) => void fixerSaw.push(o.problem);
			let reviewIn: { writeGlobs?: string[] } | undefined;
			const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn, gate, reviewer: async (i) => ((reviewIn = i), reviewer()), setupFixer, log: () => {} });
			expect(reviewIn!.writeGlobs).toEqual(["src/features/agency/**"]);
			expect(r.attempts).toBe(1);
			expect(fixerSaw[0]).toContain("autoload map does not cover src/Agency");
			const qs = ledger.db.prepare("SELECT point, status, question FROM questions WHERE unit_id = 'u1'").all() as Array<{ point: string; status: string; question: string }>;
			expect(qs.map((q) => [q.point, q.status])).toEqual([["gate_env", "open"]]);
			expect(qs[0]!.question).toContain("autoload map does not cover src/Agency");
			expect(JSON.parse(ledger.getUnit("u1")!.meta).parked.question).toBe(ledger.openQuestions()[0]!.id);
		});

		it("app code outside the unit (not the setup, says the reviewer) skips the setup fixer: straight to one question", async () => {
			const fixerSaw: string[] = [];
			const setupFixer = async (o: { problem: string }) => void fixerSaw.push(o.problem);
			const appCode = "- the backend has no GET /agency endpoint the screen calls → add it in the api stack";
			const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn, gate, reviewer: async () => ({ ok: false, judged: true, output: appCode, outOfScope: appCode }), setupFixer, log: () => {} });
			expect(r.attempts).toBe(1);
			expect(fixerSaw).toEqual([]);
			expect(ledger.openQuestions().map((q) => q.point)).toEqual(["gate_env"]);
		});

		it("a reviewer that cannot judge burns no attempt: three in a row become one provider question, never quarantine", async () => {
			const down = async () => ({ ok: false, judged: false, output: "not judged: provider down" });
			const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn, gate, reviewer: down, setupFixer: false, log: () => {} });
			expect(r.attempts).toBe(0);
			expect(r.state).not.toBe("quarantined");
			expect(ledger.db.prepare("SELECT point FROM questions WHERE unit_id = 'u1'").all()).toEqual([{ point: "env" }]);
			// truth was kept, so the tester was skipped: the unit still ran as implementing, not planned
			expect(ledger.transitionsOf("unit", "u1")[0]).toMatchObject({ from_state: "planned", to_state: "implementing", reason: "truth ready" });
		});

		it("a setup fix parks the unit for a fresh run without asking anyone", async () => {
			execFileSync("git", ["init", "-q"], { cwd: join(ws, "migrated") });
			// after a fix code checks that the test command can still fail on a wrong probe test: a stand-in runner that does
			saveCommandOverride(ws, "nestjs", "test", { cmd: "sh", args: ["-c", "exit 1"] }, "fixture runner");
			const setupFixer = async () => (write(join(ws, "migrated", "autoload.json"), "{}\n"), "added the autoload mapping");
			const r = await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn, gate, reviewer, setupFixer, log: () => {} });
			expect(r.attempts).toBe(1);
			expect(ledger.openQuestions()).toEqual([]);
			expect(JSON.parse(ledger.getUnit("u1")!.meta).parked.diagnosis.summary).toMatch(/setup was fixed \(added the autoload mapping\)/);
		});
	});
});

describe("runUnit prompt and truth routing", () => {
	const ok = async (g: GateInput): Promise<GateReport> => ({ ok: true, steps: [], changedFiles: [], testFiles: g.testFiles.map((t) => t.path) });

	it("the implementer gets the unit's own tests in full and the area's other tests by path only", async () => {
		const dir = join(ws, "migrated");
		write(join(dir, "src", "features", "agency", "other.spec.ts"), "it('OTHER_UNIT_BODY', () => {});\n");
		execFileSync("git", ["init", "-q"], { cwd: dir });
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: dir });
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "main"], { cwd: dir });
		// the unit's own test: new in its checkout
		write(join(dir, "src", "features", "agency", "agency.service.spec.ts"), "it('OWN_UNIT_BODY', () => {});\n");
		const tasks: string[] = [];
		const spawnTasks = async (opts: { role: string }): Promise<LeafSession> => ({ run: async (task: string) => (opts.role !== "test" && tasks.push(task), { text: "done", toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } }), dispose() {} }) as unknown as LeafSession;
		await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: spawnTasks as never, gate: ok, log: () => {} });
		expect(tasks[0]).toContain("OWN_UNIT_BODY");
		expect(tasks[0]).not.toContain("OTHER_UNIT_BODY");
		expect(tasks[0]).toMatch(/Other tests in this area[^\n]*\n- src\/features\/agency\/other\.spec\.ts/);
	});

	describe("read truth from when the old code could not run", () => {
		beforeEach(() => {
			ledger.db.prepare("DELETE FROM evidence").run();
			ledger.addEvidence("u1", "truth_read", { why: "the old code does not run here" });
		});
		const roles: string[] = [];
		const spawnRoles = async (opts: { role: string }): Promise<LeafSession> => (roles.push(opts.role), spawn());

		it("is not reused once the old code runs here: the tester runs it", async () => {
			roles.length = 0;
			await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: spawnRoles as never, gate: ok, legacyFixer: false, log: () => {} });
			expect(roles[0]).toBe("test");
		});

		it("is reused while it still cannot run", async () => {
			roles.length = 0;
			writeFileSync(join(ws, ".bigrefactor", "legacy-env.json"), JSON.stringify({ root: config.source.path, mode: "read" }));
			await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn: spawnRoles as never, gate: ok, legacyFixer: false, log: () => {} });
			expect(roles).not.toContain("test");
		});
	});

	it("an identical anti-gaming red twice never goes to the setup model, even when the doctor says fix", async () => {
		const client = new FakeModelClient({ chat: () => ({ json: { action: "fix", summary: "re-set the vendor dir", command: "", question: "The gate keeps refusing writes outside the unit: what now?", options: [], recommended: "leave", opinion: "scope" } }) });
		let fixerCalls = 0;
		const setupFixer = async () => (fixerCalls++, "re-set the vendor dir");
		const gate = async (): Promise<GateReport> => failing("write outside unit scope: src/shared/db.ts");
		await runUnit({ ledger, config, root: ws, unitId: "u1", reuseTruth: true, spawn, gate, client, setupFixer, log: () => {} });
		expect(fixerCalls).toBe(0);
		expect(ledger.openQuestions().map((q) => q.point)).toEqual(["gate_env"]);
	});
});
