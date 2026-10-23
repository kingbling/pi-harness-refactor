import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../src/config.ts";
import type { TargetAdapter } from "../src/adapters/types.ts";
import { commitAll, ensureRepo, git, headOf } from "../src/git.ts";
import { Ledger } from "../src/ledger/db.ts";
import { REQUIRED_FOR_ACCEPTED } from "../src/ledger/schema.ts";
import { checkSlice, compareRuns, paritySliceReady, runSteps, type Step, type StepsFile } from "../src/run/parity-check.ts";
import { contractProblems, retainedScenarioProblems, runContracts, strictSuiteProblems, type ParityContract } from "../src/run/parity-contracts.ts";
import { FINISH_META } from "../src/run/finish-check.ts";
import { loadApps, saveApp } from "../src/run/parity.ts";
import { migrationProblems, renderVerification, verifyParity, VERIFICATION_META, verificationPath } from "../src/run/parity-verification.ts";
import { validateParityProjects } from "../src/run/parity-project-checks.ts";
import { parityCommand } from "../src/run/parity-cli.ts";
import { oldFailures } from "../src/run/parity-scope.ts";
import { notePrepare, prepareTries } from "../src/run/run.ts";

const step: Step = { id: "value", route: "GET /value", compare: "data", method: "GET", path: "/value" };
const freePort = () => new Promise<number>((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); }); });

let root: string, source: string, target: string, runtime: string, config: Config, ledger: Ledger;
const write = (p: string, value: unknown) => writeFileSync(p, JSON.stringify(value));
const suitePath = (slice: string) => join(root, ".bigrefactor/parity/slices", slice, "steps.json");
const finish = async () => ledger.setMeta(FINISH_META, JSON.stringify({ head: await headOf(target), at: new Date().toISOString(), marks: 0, deadMarks: 0, items: [], acted: false, handed: 0, merged: 0, readNotRun: 0, neverCompared: [] }));
const adapter = {
	id: "nestjs", layout: { sourceExtensions: [".cjs", ".json"], isTestFile: (p: string) => p.endsWith(".test.cjs"), skipMarker: /\.skip\(/ },
	build: () => ({ cmd: process.execPath, args: ["--check", "server.cjs"] }),
	lint: () => ({ cmd: process.execPath, args: ["--check", "behavior.test.cjs"] }),
	test: (_dir: string, files: string[]) => ({ cmd: process.execPath, args: files }),
} as unknown as TargetAdapter;
const verify = (reportOnly = false) => verifyParity({ ledger, config, root, serverStack: "nestjs", linkAll: () => {}, log: () => {}, reportOnly, validateProjects: () => validateParityProjects({ config, root, adapters: new Map([["nestjs", adapter]]), linkAll: () => {} }) });

function databaseFixture(legacy: unknown, target: unknown) {
	config.db.strategy = "keep-schema";
	for (const [side, data] of [["legacy", legacy], ["nestjs", target]] as const) {
		const input = join(root, `seed-${side}.json`), state = join(root, `database-${side}.json`);
		write(input, data); write(state, data);
		const app = loadApps(root)[side]!.recipe!;
		saveApp(root, side, { recipe: { ...app, env: { ...app.env, SEED_INPUT: input, SEED_STATE: state },
			reset: { cmd: process.execPath, args: ["-e", "require('node:fs').copyFileSync(process.env.SEED_INPUT,process.env.SEED_STATE)"] },
			dump: { cmd: process.execPath, args: ["-e", "process.stdout.write(require('node:fs').readFileSync(process.env.SEED_STATE))"] },
		} });
	}
	write(join(root, ".bigrefactor/parity/scope.json"), { version: 1, fixture: { name: "isolated JSON database fixture", files: ["seed-legacy.json", "seed-nestjs.json"] } });
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "br-strict-parity-"));
	source = join(root, "source"); target = join(root, "target"); runtime = join(root, "runtime");
	mkdirSync(source); mkdirSync(target);
	writeFileSync(join(source, "server.cjs"), `require('node:http').createServer((q,s)=>{s.setHeader('content-type','application/json');if(q.url==='/down'){s.statusCode=503;return s.end('{}')}s.end(process.env.RAW_JSON??JSON.stringify({value:Number(process.env.VALUE||10)}))}).listen(Number(process.env.PORT),'127.0.0.1');`);
	write(join(source, "behavior.json"), { result: 42 });
	writeFileSync(join(source, "behavior.test.cjs"), "// http#1 foundation#1\nrequire('node:assert/strict').equal(require('./behavior.json').result,42);console.log('1 test passed');");
	cpSync(source, target, { recursive: true }); cpSync(source, runtime, { recursive: true });
	await ensureRepo(source, "main"); await commitAll(source, "legacy snapshot");
	cpSync(join(source, ".gitignore"), join(runtime, ".gitignore"));
	await ensureRepo(target, "main"); await commitAll(target, "migrated snapshot");
	config = ConfigSchema.parse({ source: { path: source, stack: "php", commit: await headOf(source) }, target: { path: target, stacks: ["nestjs"], git: { branch: "main" } }, db: { strategy: "none" }, models: {} });
	ledger = new Ledger(":memory:");
	for (const slice of ["http", "foundation"]) {
		ledger.createUnit({ id: slice, tier: "T0", symbolIds: [], meta: { slice, files: slice === "http" ? ["server.cjs"] : ["behavior.json"] } });
		for (const type of REQUIRED_FOR_ACCEPTED) ledger.addEvidence(slice, type, {});
		ledger.addEvidence(slice, "truth_green_on_old", {});
		ledger.db.prepare("INSERT INTO truth_cases(id,unit_id,symbol_id,inputs,expected,verified_on_old,ported_test_path,created_at) VALUES (?,?,'behavior','[]','42',1,'behavior.test.cjs','t0')").run(`${slice}#1`, slice);
		ledger.db.prepare("UPDATE units SET state='accepted' WHERE id=?").run(slice);
		mkdirSync(join(root, ".bigrefactor/parity/slices", slice), { recursive: true });
	}
	ledger.db.prepare("INSERT INTO index_routes(id,side,method,path,handler_symbol) VALUES ('route','source','GET','/value','server.cjs::handler')").run();
	write(join(root, ".bigrefactor/legacy-env.json"), { root: runtime, mode: "run" });
	const recipe = async () => ({ dir: ".", start: { cmd: process.execPath, args: ["server.cjs"] }, ready: `http://127.0.0.1:${await freePort()}/value` });
	const old = await recipe(), neu = await recipe();
	write(join(root, ".bigrefactor/parity/apps.json"), { legacy: { up: true, recipe: { ...old, env: { PORT: new URL(old.ready).port } } }, nestjs: { up: true, recipe: { ...neu, env: { PORT: new URL(neu.ready).port } } } });
	write(join(root, "seed.json"), { fixture: "stateless stable values" });
	write(join(root, ".bigrefactor/parity/scope.json"), { version: 1, fixture: { name: "stable fixture", files: ["seed.json"] } });
	writeFileSync(join(root, "observe.cjs"), `const fs=require('node:fs');process.stdout.write(fs.readFileSync(require('node:path').join(process.env.BR_PARITY_APP_DIR,'behavior.json')));`);
	const check: ParityContract = { id: "behavior", kind: "command", covers: [], why: "execute non-HTTP behavior against each app", command: { cmd: process.execPath, args: ["observe.cjs"] }, inputs: ["observe.cjs"] };
	write(suitePath("http"), { steps: [step] });
	write(suitePath("foundation"), { steps: [], checks: [check] });
	ledger.db.prepare("UPDATE truth_cases SET numeric_version=1").run();
	await finish();
});
afterEach(() => { ledger?.close(); rmSync(root, { recursive: true, force: true }); });

describe("strict parity evidence", () => {
	it("supplies the frozen slice context through both legacy resets and the target, including route-less initial data", async () => {
		databaseFixture({ records: [{ id: 1 }] }, { records: [{ id: 1 }] });
		const contextLog = join(root, "dump-context.jsonl"), contractLog = join(root, "contract-context.jsonl");
		const capture = (path: string) => `require('node:fs').appendFileSync(${JSON.stringify(path)},JSON.stringify(Object.fromEntries(['SIDE','SLICE','PHASE','STEP'].map(k=>[k,process.env['BR_PARITY_'+k]])))+'\\n');`;
		for (const side of ["legacy", "nestjs"]) {
			const recipe = loadApps(root)[side]!.recipe!;
			saveApp(root, side, { recipe: { ...recipe, env: { ...recipe.env, BR_PARITY_SIDE: "spoof", BR_PARITY_SLICE: "spoof", BR_PARITY_PHASE: "spoof", BR_PARITY_STEP: "spoof" },
				dump: { cmd: process.execPath, args: ["-e", capture(contextLog) + "process.stdout.write(require('node:fs').readFileSync(process.env.SEED_STATE));"] },
			} });
		}
		writeFileSync(join(root, "observe.cjs"), capture(contractLog) + readFileSync(join(root, "observe.cjs"), "utf8"));
		const result = await verify();
		expect(result.status).toBe("passed");
		const contexts = readFileSync(contextLog, "utf8").trim().split("\n").map(line=>JSON.parse(line));
		expect(contexts).toHaveLength(9);
		for (const side of ["legacy", "target"]) {
			const repeats = side === "legacy" ? 2 : 1;
			for (const [slice, phase, step] of [["http","initial",""],["http","step","value"],["foundation","initial",""]])
				expect(contexts.filter(c=>c.SIDE===side&&c.SLICE===slice&&c.PHASE===phase&&c.STEP===step)).toHaveLength(repeats);
		}
		const contracts = readFileSync(contractLog,"utf8").trim().split("\n").map(line=>JSON.parse(line));
		expect(contracts).toEqual([{ SIDE:"legacy",SLICE:"foundation",PHASE:"contract",STEP:"" },{ SIDE:"legacy",SLICE:"foundation",PHASE:"contract",STEP:"" },{ SIDE:"target",SLICE:"foundation",PHASE:"contract",STEP:"" }]);
	}, 30_000);

	it("detects exact-number differences in a full frozen replay and preserves them in saved evidence", async () => {
		for (const [side, raw] of [["legacy", '{"value":9007199254740992}'], ["nestjs", '{"value":9007199254740993}']] as const) {
			const recipe = loadApps(root)[side]!.recipe!;
			saveApp(root, side, { recipe: { ...recipe, env: { ...recipe.env, RAW_JSON: raw } } });
		}
		const result = await verify();
		expect(result.status).toBe("failed");
		expect(result.problems.join("\n")).toContain("differs at body.value");
		const run = result.runs.find((r) => r.slice === "http")!;
		const saved = readFileSync(join(root, run.evidence!), "utf8");
		expect(saved).toContain("9007199254740992");
		expect(saved).toContain("9007199254740993");
	}, 30_000);

	it("rejects historical legacy truth without exact-number provenance even when all cases are marked verified", async () => {
		ledger.db.prepare("UPDATE truth_cases SET numeric_version=0").run();
		const result = await verify(true);
		expect(result.problems.join("\n")).toContain("legacy truth cases predate exact JSON parsing");
		expect(result.status).toBe("blocked");
	});

	it("rejects a silent test command that exits successfully without execution evidence", async () => {
		const result = await validateParityProjects({ config, root, adapters: new Map([["nestjs", { ...adapter, test: () => ({ cmd: process.execPath, args: ["-e", ""] }) }]]), linkAll: () => {} });
		expect(result.problems).toContain("nestjs: test command reported no tests executed");
		expect(result.checks.find((s) => s.step === "test")).toMatchObject({ ok: false, output: "" });
	});
	it("compares initial keep-schema data before any requests, including route-less suites", async () => {
		databaseFixture({ users: [{ name: "B", id: 2 }, { name: "A", id: 1 }] }, { users: [{ id: 1, name: "A" }, { id: 2, name: "B" }] });
		const r = await verify();
		expect(r.status).toBe("passed");
		expect(r.problems).toEqual([]);
		for (const run of r.runs) {
			const evidence = JSON.parse(readFileSync(join(root, run.evidence!), "utf8"));
			expect(evidence.fixture).toEqual({ legacy: [{ users: [{ id: 1, name: "A" }, { id: 2, name: "B" }] }, { users: [{ id: 1, name: "A" }, { id: 2, name: "B" }] }], target: { users: [{ id: 1, name: "A" }, { id: 2, name: "B" }] } });
		}
	}, 30_000);

	it("rejects matching partial dumps that omit an inventoried database table", async () => {
		databaseFixture({ users: [{ id: 1, name: "A" }] }, { users: [{ id: 1, name: "A" }] });
		ledger.createUnit({ id: "DB_schema_orders", kind: "db_schema", tier: "T0", symbolIds: [], meta: { slice: "foundation", files: [], tables: ["users", "orders"] } });
		for (const type of REQUIRED_FOR_ACCEPTED) ledger.addEvidence("DB_schema_orders", type, {});
		ledger.db.prepare("UPDATE units SET state='accepted' WHERE id='DB_schema_orders'").run();
		const r = await verify();
		expect(r.status).toBe("failed");
		expect(r.problems.join("\n")).toContain("initial database dump omits inventoried table orders");
	}, 30_000);

	it("accepts inventoried tables with complete empty observations", async () => {
		databaseFixture({ users: [{ id: 1 }], orders: [] }, { users: [{ id: 1 }], orders: [] });
		ledger.createUnit({ id: "DB_schema_orders", kind: "db_schema", tier: "T0", symbolIds: [], meta: { slice: "foundation", files: [], tables: ["users", "orders"] } });
		for (const type of REQUIRED_FOR_ACCEPTED) ledger.addEvidence("DB_schema_orders", type, {});
		ledger.db.prepare("UPDATE units SET state='accepted' WHERE id='DB_schema_orders'").run();
		const r = await verify();
		expect(r.status, r.problems.join("\n")).toBe("passed");
		expect(r.problems).toEqual([]);
	}, 30_000);

	it("rejects a database unit without table declarations instead of treating its coverage as empty", async () => {
		databaseFixture({ users: [] }, { users: [] });
		ledger.createUnit({ id: "DB_schema_unknown", kind: "db_schema", tier: "T0", symbolIds: [], meta: { slice: "foundation", files: [], tables: [] } });
		for (const type of REQUIRED_FOR_ACCEPTED) ledger.addEvidence("DB_schema_unknown", type, {});
		ledger.db.prepare("UPDATE units SET state='accepted' WHERE id='DB_schema_unknown'").run();
		const r = await verify();
		expect(r.status).toBe("failed");
		expect(r.problems.join("\n")).toContain("database unit DB_schema_unknown has no valid inventoried table declarations");
	}, 30_000);

	it("fails a seed mismatch even when every HTTP response, executable observation and per-request delta matches", async () => {
		databaseFixture({ users: [{ id: 1, name: "Original" }] }, { users: [{ id: 1, name: "Incorrect migration" }] });
		const r = await verify();
		expect(r.status).toBe("failed");
		expect(r.problems.join("\n")).toContain("fixture: differs at data.users[0].name");
		const evidence = JSON.parse(readFileSync(join(root, r.runs.find((r) => r.slice === "http")!.evidence!), "utf8"));
		expect(evidence.legacy[0][0].body).toEqual(evidence.target[0].body);
		expect(evidence.legacy[0][0].data).toEqual({});
		expect(evidence.target[0].data).toEqual({});
	}, 30_000);

	it("verifies an explicitly decided data correction using complete initial-data expectations", async () => {
		const old = { users: [{ id: 1, name: "Old bug" }] }, intended = { users: [{ id: 1, name: "Correct label" }] };
		databaseFixture(old, intended);
		const id = Number(ledger.db.prepare("INSERT INTO quirks(unit_id,symbol_id,kind,behaviour,opinion,why,status,applied,decided_by,created_at) VALUES ('foundation','data','suspected_bug','stores the old label','drop','correct the stored label','dropped','drop','human','t0')").run().lastInsertRowid);
		for (const slice of ["http", "foundation"]) write(suitePath(slice), { ...JSON.parse(readFileSync(suitePath(slice), "utf8")), changes: [{ id: "correct-label", quirkId: id, why: "saved data correction decision", expected: [{ step: "fixture", kind: "data", legacy: old, target: intended }] }] });
		const r = await verify();
		expect(r.problems).toEqual([]);
		expect(r.status).toBe("passed");
		expect(r.runs.map((r) => r.outcome)).toEqual(["accepted-changes", "accepted-changes"]);
	}, 30_000);

	it("rejects a broken reset that leaves different starting data on the second legacy run", async () => {
		databaseFixture({ users: [{ id: 1, visits: 0 }] }, { users: [{ id: 1, visits: 0 }] });
		const code = "if(process.env.SEED_STATE){const fs=require('node:fs');const data=JSON.parse(fs.readFileSync(process.env.SEED_STATE));data.users[0].visits++;fs.writeFileSync(process.env.SEED_STATE,JSON.stringify(data));}\n" + readFileSync(join(source, "server.cjs"), "utf8");
		for (const dir of [source, target, runtime]) writeFileSync(join(dir, "server.cjs"), code);
		await commitAll(source, "record startup data effect"); await commitAll(target, "record startup data effect");
		config.source.commit = await headOf(source); await finish();
		const app = loadApps(root).legacy!.recipe!;
		saveApp(root, "legacy", { recipe: { ...app, reset: { cmd: process.execPath, args: ["-e", "// deliberately broken reset"] } } });
		const r = await verify();
		expect(r.status).toBe("failed");
		expect(r.problems.join("\n")).toContain("fixture: legacy seed data differs between resets");
	}, 30_000);

	it("verifies exact declared HTTP and executable behavior changes while retaining fresh raw differences", async () => {
		write(join(target, "behavior.json"), { result: 99 });
		writeFileSync(join(target, "behavior.test.cjs"), "// http#1 foundation#1\nrequire('node:assert/strict').equal(require('./behavior.json').result,99);console.log('1 test passed');");
		await commitAll(target, "apply decided behavior change"); await finish();
		const app = loadApps(root).nestjs!.recipe!;
		saveApp(root, "nestjs", { recipe: { ...app, env: { ...app.env, VALUE: "11" } } });
		const insert = ledger.db.prepare("INSERT INTO quirks(unit_id,symbol_id,kind,behaviour,opinion,why,status,applied,decided_by,created_at) VALUES (?,'behavior','suspected_bug','legacy result','drop','intended result','dropped','drop','human','t0')");
		const http = Number(insert.run("http").lastInsertRowid), nonHttp = Number(insert.run("foundation").lastInsertRowid);
		const add = (slice: string, quirkId: number, step: string, legacy: unknown, target: unknown) => write(suitePath(slice), { ...JSON.parse(readFileSync(suitePath(slice), "utf8")), changes: [{ id: `fix-${slice}`, quirkId, why: "verify the saved behavior decision", expected: [{ step, kind: "body", legacy, target }] }] });
		add("http", http, "value", { value: 10 }, { value: 11 });
		add("foundation", nonHttp, "check:behavior", { result: 42 }, { result: 99 });
		const r = await verify();
		expect(r.problems).toEqual([]);
		expect(r.status).toBe("passed");
		expect(r.runs.map((r) => r.outcome)).toEqual(["accepted-changes", "accepted-changes"]);
		expect(r.runs.map((r) => r.changes?.[0]?.decision.decided_by)).toEqual(["human", "human"]);
		expect(renderVerification(r).join("\n")).toContain("2 recorded behavior change(s) verified");
		expect(ledger.db.prepare("SELECT COUNT(*) n FROM parity_diffs WHERE kind='body'").get()).toEqual({ n: 2 });
		expect(JSON.parse(readFileSync(join(root, r.runs[0]!.evidence!), "utf8")).checks.target[0].observations).toEqual({ result: 99 });
		expect(JSON.parse(readFileSync(join(root, r.runs[0]!.evidence!), "utf8")).checks.legacy[0][0].observations).toEqual({ result: 42 });
	}, 30_000);

	it("blocks an expectation linked to a kept decision before starting replay", async () => {
		const id = Number(ledger.db.prepare("INSERT INTO quirks(unit_id,symbol_id,kind,behaviour,opinion,why,status,decided_by,created_at) VALUES ('http','behavior','intentional','old value','keep','needed','kept','human','t0')").run().lastInsertRowid);
		write(suitePath("http"), { steps: [step], changes: [{ id: "invalid", quirkId: id, why: "cannot override a keep decision", expected: [{ step: "value", kind: "body", legacy: { value: 10 }, target: { value: 11 } }] }] });
		const r = await verify();
		expect(r.status).toBe("blocked");
		expect(r.runs).toEqual([]);
		expect(r.problems.join("\n")).toContain("needs a recorded DROP decision");
	});
	it("does not certify accepted units with pending or unapplied behavior decisions", async () => {
		const insert = ledger.db.prepare("INSERT INTO quirks(unit_id,symbol_id,kind,behaviour,opinion,why,status,applied,created_at) VALUES ('http','behavior','intentional','legacy behavior','keep','reason',?,?,'t0')");
		insert.run("pending", "keep"); insert.run("kept", "drop"); insert.run("dropped", "keep");
		expect(migrationProblems(ledger, await headOf(target)).join("\n")).toContain("3 quirk decisions are unresolved or not applied to tests");
	});

	it("fingerprints behavior decisions so changing their meaning during replay invalidates the proof", async () => {
		ledger.db.prepare("INSERT INTO quirks(unit_id,symbol_id,kind,behaviour,opinion,why,status,applied,decided_by,created_at) VALUES ('http','behavior','suspected_bug','original meaning','drop','intended result','dropped','drop','human','t0')").run();
		const r = await verifyParity({ ledger, config, root, serverStack: "nestjs", linkAll: () => {}, log: () => {}, validateProjects: async () => {
			const result = await validateParityProjects({ config, root, adapters: new Map([["nestjs", adapter]]), linkAll: () => {} });
			ledger.db.prepare("UPDATE quirks SET behaviour='changed meaning' WHERE unit_id='http'").run();
			return result;
		} });
		expect(r.runs.every((r) => r.outcome === "same")).toBe(true);
		expect(r.status).toBe("failed");
		expect(r.problems.join("\n")).toContain("verification inputs, migration evidence or code changed during replay");
	}, 30_000);

	it("passes HTTP and non-HTTP suites on one commit, retaining executable observations and proof inputs", async () => {
		const r = await verify();
		expect(r.problems).toEqual([]);
		expect(r.status).toBe("passed");
		expect(r.runs).toHaveLength(2);
		expect(r.snapshot?.targetCommit).toBe(await headOf(target));
		expect(r.snapshot?.fixture["seed.json"]).toHaveLength(64);
		expect(r.snapshot?.engine.code.files["src/run/parity-check.ts"]).toHaveLength(64);
		expect(r.snapshot?.workspaceInputs.files[".bigrefactor/legacy-env.json"]).toHaveLength(64);
		expect(r.projectValidation?.checks.find((c) => c.step === "test")).toMatchObject({ ok: true, tests: ["behavior.test.cjs"] });
		const foundation = r.runs.find((s) => s.slice === "foundation")!;
		const evidence = JSON.parse(readFileSync(join(root, foundation.evidence!), "utf8"));
		expect(evidence.checks).toEqual({ legacy: [[{ id: "behavior", observations: { result: 42 } }], [{ id: "behavior", observations: { result: 42 } }]], target: [{ id: "behavior", observations: { result: 42 } }] });
		expect(JSON.parse(readFileSync(verificationPath(root), "utf8")).status).toBe("passed");
		expect(JSON.parse(ledger.getMeta(VERIFICATION_META)!).suites).toBe(2);
		expect(existsSync(join(root, ".bigrefactor/run.lock"))).toBe(false);
	}, 30_000);

	it("invalidates a matching replay when workspace validation commands change during verification", async () => {
		const r = await verifyParity({ ledger, config, root, serverStack: "nestjs", linkAll: () => {}, log: () => {}, validateProjects: async () => {
			const result = await validateParityProjects({ config, root, adapters: new Map([["nestjs", adapter]]), linkAll: () => {} });
			mkdirSync(join(root, ".bigrefactor/commands"), { recursive: true });
			write(join(root, ".bigrefactor/commands/nestjs.json"), { test: { cmd: "different-test-command", args: [] } });
			return result;
		} });
		expect(r.runs).toHaveLength(2);
		expect(r.runs.every((r) => r.outcome === "same")).toBe(true);
		expect(r.status).toBe("failed");
		expect(r.problems.join("\n")).toContain("verification inputs, migration evidence or code changed during replay");
	}, 30_000);

	it("replays a source containing a pinned framework submodule and a tracked symlink", async () => {
		const framework = join(root, "framework-repo"); mkdirSync(framework);
		writeFileSync(join(framework, "library.cjs"), "module.exports=42;\n");
		await ensureRepo(framework, "main"); await commitAll(framework, "framework snapshot");
		await git(source, ["-c", "protocol.file.allow=always", "submodule", "add", framework, "vendor"]);
		symlinkSync("vendor", join(source, "framework-link"));
		await commitAll(source, "source with pinned framework");
		config.source.commit = await headOf(source);
		rmSync(runtime, { recursive: true, force: true });
		cpSync(source, runtime, { recursive: true, verbatimSymlinks: true });
		const r = await verify();
		expect(r.problems).toEqual([]);
		expect(r.status).toBe("passed");
		expect(r.snapshot?.sourceSubmodules).toEqual({ vendor: await headOf(framework) });
		expect(r.snapshot!.legacyFiles).toBeGreaterThan(5);
	}, 30_000);

	it("invalidates identical legacy file bytes when the runtime environment moves to a different root during replay", async () => {
		const r = await verifyParity({ ledger, config, root, serverStack: "nestjs", linkAll: () => {}, log: () => {}, validateProjects: async () => {
			const result = await validateParityProjects({ config, root, adapters: new Map([["nestjs", adapter]]), linkAll: () => {} });
			const copy = join(root, "other-runtime");
			cpSync(runtime, copy, { recursive: true });
			write(join(root, ".bigrefactor/legacy-env.json"), { root: copy, mode: "run" });
			return result;
		} });
		expect(r.runs).toHaveLength(2);
		expect(r.runs.every((r) => r.outcome === "same")).toBe(true);
		expect(r.status).toBe("failed");
		expect(r.problems.join("\n")).toContain("verification inputs, migration evidence or code changed during replay");
	}, 30_000);

	it("fails real output differences, including a non-HTTP contract; historical allowances do not suppress new differences", async () => {
		write(join(target, "behavior.json"), { result: 99 }); await commitAll(target, "introduce regression"); await finish();
		const app = loadApps(root).nestjs!.recipe!;
		saveApp(root, "nestjs", { recipe: { ...app, env: { ...app.env, VALUE: "11" } } });
		const oldRun = Number(ledger.db.prepare("INSERT INTO parity_runs(slice,outcome,started_at) VALUES ('http','differs','t0')").run().lastInsertRowid);
		ledger.db.prepare("INSERT INTO parity_diffs(run_id,slice,step,route,kind,path,legacy,target,status) VALUES (?,'http','value','GET /value','body','body.value','10','11','allowed')").run(oldRun);
		const r = await verify();
		expect(r.status).toBe("failed");
		expect(r.problems.join("\n")).toMatch(/check behavior: differs at result/);
		expect(r.runs.find((s) => s.slice === "http")?.outcome).toBe("differs");
		expect(ledger.db.prepare("SELECT COUNT(*) n FROM parity_diffs WHERE kind = 'body' AND status = 'open'").get()).toEqual({ n: 2 });
	});

	it("rejects 503 exclusions instead of labelling the remaining passing requests same", async () => {
		write(suitePath("http"), { steps: [step, { ...step, id: "unavailable", path: "/down" }] });
		const r = await checkSlice({ ledger, config, root, slice: "http", serverStack: "nestjs", linkAll: () => {}, log: () => {} });
		expect(r).toMatchObject({ outcome: "error", compared: 1, diffs: [] });
		expect(r.note).toContain("not compared: unavailable (the old app: status 503)");
		// the old app's setup model is told which steps fail on its fixture
		expect(oldFailures(root)).toEqual({ http: [expect.stringMatching(/^unavailable GET \/down \(the old app: status 503\)$/)] });
	});

	it("keeps readiness reporting read-only and treats a live workspace holder as a blocker", async () => {
		writeFileSync(join(root, ".bigrefactor/run.lock"), String(process.pid));
		const r = await verify(true);
		expect(r.status).toBe("blocked");
		expect(r.problems.join("\n")).toMatch(/held by a live run/);
		expect(ledger.getMeta(VERIFICATION_META)).toBeUndefined();
		expect(existsSync(verificationPath(root))).toBe(false);
		expect(readFileSync(join(root, ".bigrefactor/run.lock"), "utf8")).toBe(String(process.pid));
		// br run's own replay at its end: the lock it holds is not a blocker
		const own = await verifyParity({ ledger, config, root, serverStack: "nestjs", linkAll: () => {}, log: () => {}, reportOnly: true, runHolds: true });
		expect(own.problems.join("\n")).not.toMatch(/held by a live run/);
	});

	it("returns machine-readable readiness and failure status without creating a model client or running checks", async () => {
		let passed: boolean | undefined;
		const lines = await parityCommand({ ledger, config, root, args: ["--verify", "--report", "--json"], onVerification: (value) => { passed = value; } });
		const r = JSON.parse(lines[0]!);
		expect(r).toMatchObject({ status: "blocked", requiredSlices: ["foundation", "http"], runs: [] });
		expect(passed).toBe(false);
		expect(ledger.getMeta(VERIFICATION_META)).toBeUndefined();
	});

	it("refuses stale finish evidence, dirty code, missing fixture provenance and unit-state shortcuts", async () => {
		writeFileSync(join(target, "server.cjs"), "changed");
		ledger.setMeta(FINISH_META, JSON.stringify({ head: "old", items: [], marks: 0 }));
		ledger.db.prepare("UPDATE units SET state='quarantined' WHERE id='http'").run();
		rmSync(join(root, ".bigrefactor/parity/scope.json"));
		const r = await verify();
		expect(r.status).toBe("blocked");
		expect(r.runs).toEqual([]);
		expect(r.problems.join("\n")).toMatch(/not accepted/);
		expect(r.problems.join("\n")).toMatch(/no finish check for the target commit/);
		expect(r.problems.join("\n")).toMatch(/target checkout has uncommitted changes/);
		expect(r.problems.join("\n")).toMatch(/fixture provenance/);
	});

	it("rejects unowned source routes and runtime copies that silently changed the legacy behavior", async () => {
		ledger.db.prepare("INSERT INTO index_routes(id,side,method,path) VALUES ('orphan','source','POST','/hidden')").run();
		expect(migrationProblems(ledger, await headOf(target)).join("\n")).toMatch(/source routes have no inventoried unit owner/);
		ledger.db.prepare("DELETE FROM index_routes WHERE id='orphan'").run();
		write(join(runtime, "behavior.json"), { result: 99 });
		const r = await verify();
		expect(r.status).toBe("blocked");
		expect(r.problems.join("\n")).toMatch(/runtime copy differs from pinned source/);
	});
	it("verifies an explicitly covered framework endpoint without creating an app migration unit for its implementation", async () => {
		ledger.db.prepare("INSERT INTO index_routes(id,side,method,path,handler_symbol) VALUES ('platform','source','GET','/platform','framework/router.php::handler')").run();
		write(suitePath("http"), { steps: [step, { ...step, id: "platform", route: "GET /platform", path: "/platform" }] });
		const r = await verify();
		expect(r.status).toBe("passed");
		expect(r.problems).toEqual([]);
		const http = r.runs.find((r) => r.slice === "http")!;
		const evidence = JSON.parse(readFileSync(join(root, http.evidence!), "utf8"));
		expect(evidence.steps.map((s: Step) => s.id)).toEqual(["value", "platform"]);
		expect(evidence.legacy[0][1].status).toBe(200);
		expect(evidence.target[1].body).toEqual({ value: 10 });
	});
	it("requires every indexed method for an endpoint without a source unit; setup and skip declarations do not cover it", async () => {
		ledger.db.prepare("INSERT INTO index_routes(id,side,method,path,handler_symbol) VALUES ('platform','source','GET|POST','/platform','framework/router.php::handler')").run();
		const get: Step = { ...step, id: "platform-get", route: "GET /platform", path: "/platform" };
		const post: Step = { ...get, id: "platform-post", route: "POST /platform", method: "POST" };
		const head = await headOf(target);
		expect(migrationProblems(ledger, head, [get]).join("\n")).toContain("source routes have no inventoried unit owner");
		expect(migrationProblems(ledger, head, [get, { ...post, compare: "none" }]).join("\n")).toContain("source routes have no inventoried unit owner");
		expect(migrationProblems(ledger, head, [get, post])).toEqual([]);
	});

	it("detects fixture/check changes during replay even when observations still match", async () => {
		writeFileSync(join(root, "observe.cjs"), `const fs=require('node:fs');fs.writeFileSync('seed.json',JSON.stringify({changed:process.env.BR_PARITY_SIDE}));process.stdout.write(fs.readFileSync(require('node:path').join(process.env.BR_PARITY_APP_DIR,'behavior.json')));`);
		const r = await verify();
		expect(r.runs.every((s) => s.outcome === "same")).toBe(true);
		expect(r.status).toBe("failed");
		expect(r.problems.join("\n")).toMatch(/inputs, migration evidence or code changed/);
	});

	it("detects a target commit moving during replay and does not reuse a previous passing report", async () => {
		const result = await verify(); expect(result.status).toBe("passed");
		writeFileSync(join(root, "observe.cjs"), `const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');if(process.env.BR_PARITY_SIDE==='target'){const t=${JSON.stringify(target)};fs.writeFileSync(path.join(t,'new.txt'),'new commit');cp.execFileSync('git',['-C',t,'add','.']);cp.execFileSync('git',['-C',t,'-c','user.name=t','-c','user.email=t@t','commit','-qm','changed']);}process.stdout.write(fs.readFileSync(path.join(process.env.BR_PARITY_APP_DIR,'behavior.json')));`);
		const r = await verify();
		expect(r.status).toBe("failed");
		expect(r.problems.join("\n")).toMatch(/commit changed during verification|different source\/target commit/);
		expect(JSON.parse(readFileSync(verificationPath(root), "utf8")).status).toBe("failed");
	}, 30_000);

	it("prepares executable coverage for a route-less slice and sends its differences through the ordinary resolver loop", async () => {
		const saved = JSON.parse(readFileSync(suitePath("foundation"), "utf8"));
		rmSync(suitePath("foundation"));
		write(join(target, "behavior.json"), { result: 55 }); await commitAll(target, "different non-HTTP result");
		let writes = 0;
		const r = await checkSlice({ ledger, config, root, slice: "foundation", serverStack: "nestjs", linkAll: () => {}, prepare: true, log: () => {}, writer: async (o) => {
			writes++;
			expect(o.problem).toContain("Prepare for strict parity");
			expect(o.problem).toContain("needs executable checks");
			write(suitePath("foundation"), saved);
		} });
		expect(writes).toBe(1);
		expect(r.outcome).toBe("differs");
		expect(r.diffs).toEqual([{ step: "check:behavior", route: "check:behavior", kind: "body", path: "result", legacy: 42, target: 55 }]);
		expect(r.evidence?.checks.target[0]?.observations).toEqual({ result: 55 });
	});

	it("failed preparation preserves the original scenarios and drivers and retries from that baseline", async () => {
		const original = JSON.stringify({ steps: [{ ...step, compare: "page" }] }, null, 2) + "\n";
		writeFileSync(suitePath("http"), original);
		const checks = join(root, ".bigrefactor/parity/slices/http/checks"); mkdirSync(checks);
		writeFileSync(join(checks, "existing.cjs"), "// original driver\n");
		const before: string[] = [], models: boolean[] = [];
		const r = await checkSlice({ ledger, config, root, slice: "http", serverStack: "nestjs", linkAll: () => {}, prepare: true, log: () => {}, writer: async (o) => {
			before.push(readFileSync(suitePath("http"), "utf8")); models.push(!!o.stronger);
			write(suitePath("http"), { steps: [{ ...step, id: "replacement" }] });
			writeFileSync(join(checks, "existing.cjs"), "// weakened driver\n");
			writeFileSync(join(checks, "new.cjs"), "// unfinished driver\n");
		} });
		// the suite that worked before still compares; why the checks were not written is kept for the run
		expect(r.outcome).toBe("same");
		expect(r.unprepared).toMatch(/retain the legacy scenario value/);
		expect(r.note).toMatch(/missing checks not written/);
		expect(models).toEqual([false, true]);
		expect(before).toEqual([original, original]);
		expect(readFileSync(suitePath("http"), "utf8")).toBe(original);
		expect(readFileSync(join(checks, "existing.cjs"), "utf8")).toBe("// original driver\n");
		expect(existsSync(join(checks, "new.cjs"))).toBe(false);
	});

	it("keeps a preparation's best try when it leaves fewer gaps, and the next try goes on from it", async () => {
		const before = existsSync(suitePath("http")) ? readFileSync(suitePath("http"), "utf8") : undefined;
		const pages = [{ ...step, id: "p1", compare: "page" as const }, { ...step, id: "p2", compare: "page" as const }];
		write(suitePath("http"), { steps: pages });
		const check = (covers: string[]) => ({ id: "pages", kind: "browser", covers, why: "the pages show the value", command: { cmd: process.execPath, args: ["-e", "console.log(JSON.stringify({shown:1}))"] }, inputs: [".bigrefactor/parity/slices/http/steps.json"] });
		const seen: string[] = [];
		const r = await checkSlice({ ledger, config, root, slice: "http", serverStack: "nestjs", linkAll: () => {}, prepare: true, log: () => {}, writer: async (o) => {
			seen.push(readFileSync(suitePath("http"), "utf8"));
			// the cheap try covers one page; the stronger one drops a scenario, which is no step forward
			write(suitePath("http"), o.stronger ? { steps: [pages[0]], checks: [check(["p1"])] } : { steps: pages, checks: [check(["p1"])] });
		} });
		expect(r.prepareProgress).toBe(true);
		expect(r.unprepared).toMatch(/page p2: needs a browser check/);
		expect(r.unprepared).not.toMatch(/page p1/);
		expect(JSON.parse(seen[1]!)).toMatchObject({ checks: [{ covers: ["p1"] }] });
		expect(JSON.parse(readFileSync(suitePath("http"), "utf8"))).toMatchObject({ steps: pages, checks: [{ covers: ["p1"] }] });
		// a try that left fewer gaps uses none of the slice's tries
		notePrepare(ledger, "http", "v1", r.unprepared, r.prepareProgress);
		expect(prepareTries(ledger, "http", "v1")).toBe(0);
		notePrepare(ledger, "http", "v1", r.unprepared);
		expect(prepareTries(ledger, "http", "v1")).toBe(1);
		notePrepare(ledger, "http", "v1", undefined);
		if (before !== undefined) writeFileSync(suitePath("http"), before);
	});

	it("uses the stronger second preparation to produce real executable coverage", async () => {
		const saved = JSON.parse(readFileSync(suitePath("foundation"), "utf8")); rmSync(suitePath("foundation"));
		const models: boolean[] = [];
		const r = await checkSlice({ ledger, config, root, slice: "foundation", serverStack: "nestjs", linkAll: () => {}, prepare: true, log: () => {}, writer: async (o) => {
			models.push(!!o.stronger);
			write(suitePath("foundation"), o.stronger ? saved : { steps: [] });
		} });
		expect(models).toEqual([false, true]);
		expect(r.outcome).toBe("same");
		expect(r.evidence?.checks.target[0]?.observations).toEqual({ result: 42 });
		expect(JSON.parse(readFileSync(suitePath("foundation"), "utf8"))).toEqual(saved);
	});

	it("replays prepared non-HTTP checks through the migration run path and detects a later regression", async () => {
		expect(paritySliceReady(ledger, "foundation")).toBe(true);
		const replay = () => checkSlice({ ledger, config, root, slice: "foundation", serverStack: "nestjs", linkAll: () => {}, onlyAccepted: true, log: () => {}, writer: async () => { throw new Error("prepared checks must be retained"); } });
		const first = await replay();
		expect(first.outcome).toBe("same");
		expect(first.evidence?.checks.target[0]?.observations).toEqual({ result: 42 });
		write(join(target, "behavior.json"), { result: 55 }); await commitAll(target, "non-HTTP regression");
		const second = await replay();
		expect(second.outcome).toBe("differs");
		expect(second.diffs).toEqual([{ step: "check:behavior", route: "check:behavior", kind: "body", path: "result", legacy: 42, target: 55 }]);
	});

	it("refuses a redirect-only scenario that hides a successful JSON response", async () => {
		write(suitePath("http"), { steps: [{ ...step, compare: "redirect" }] });
		const r = await checkSlice({ ledger, config, root, slice: "http", serverStack: "nestjs", linkAll: () => {}, strict: true, log: () => {} });
		expect(r.outcome).toBe("error");
		expect(r.evidence?.problems.join("\n")).toMatch(/did not exercise a redirect/);
	});

	it("fails a final snapshot whose test suite is red even when every replayed workflow matches", async () => {
		writeFileSync(join(target, "behavior.test.cjs"), "throw new Error('regression in accepted behavior');");
		await commitAll(target, "broken accepted tests"); await finish();
		const r = await verify();
		expect(r.runs.every((s) => s.outcome === "same")).toBe(true);
		expect(r.status).toBe("failed");
		expect(r.projectValidation?.checks.find((c) => c.step === "test")?.ok).toBe(false);
		expect(r.problems.join("\n")).toMatch(/test failed on the final target snapshot/);
	});

	it("requires recorded truth ids to remain present in the tests actually run on the final snapshot", async () => {
		writeFileSync(join(target, "behavior.test.cjs"), "// foundation#1\nrequire('node:assert/strict').equal(require('./behavior.json').result,42);console.log('1 test passed');");
		await commitAll(target, "lost a truth case association"); await finish();
		const r = await verify();
		expect(r.projectValidation?.checks.every((c) => c.ok)).toBe(true);
		expect(r.status).toBe("failed");
		expect(r.problems.join("\n")).toMatch(/1 linked truth cases were not present/);
	});

	it("does not accept a test runner that exits successfully after executing no tests", async () => {
		const noTests = { ...adapter, test: () => ({ cmd: process.execPath, args: ["-e", "console.log('No tests found')"] }) };
		const r = await validateParityProjects({ config, root, adapters: new Map([["nestjs", noTests]]), linkAll: () => {} });
		expect(r.problems).toContain("nestjs: test command reported no tests executed");
		expect(r.checks.find((c) => c.step === "test")?.ok).toBe(false);
	});
});

describe("coverage and observation safeguards", () => {
	it("requires browser journeys for pages, executable checks for route-less slices, and every indexed method", () => {
		expect(strictSuiteProblems({ steps: [{ ...step, compare: "page" }] }, ["GET /value"], root).join("\n")).toMatch(/needs a browser check/);
		expect(strictSuiteProblems({ steps: [] }, [], root)).toEqual(["this slice has no HTTP routes: add an executable data/command/browser/effects check"]);
		expect(strictSuiteProblems({ steps: [step], skipped: { "POST /value": "not ready" } }, ["GET|POST /value"], root).join("\n")).toMatch(/POST value/);
	});

	it("when the new app has a UI app, a page's browser check must run there: the server stack alone never shows the pages", () => {
		const page = { ...step, compare: "page" as const };
		const browser = { id: "pages", kind: "browser" as const, covers: [page.id], why: "the page shows the value", command: { cmd: process.execPath, args: ["-e", "0"] }, inputs: ["steps.json"].map((f) => relative(root, suitePath("http")).replace(/steps\.json$/, f)) };
		const onServer = strictSuiteProblems({ steps: [page], checks: [browser] }, ["GET /value"], root, "react");
		expect(onServer.join("\n")).toMatch(/the new app's pages are its react app: list "react" in stacks and open the pages at BR_PARITY_URLS.react/);
		expect(strictSuiteProblems({ steps: [page], checks: [browser], stacks: ["react"] }, ["GET /value"], root, "react")).toEqual([]);
		// without a UI app, or without pages, nothing more is asked
		expect(strictSuiteProblems({ steps: [page], checks: [browser] }, ["GET /value"], root)).toEqual([]);
		expect(strictSuiteProblems({ steps: [step] }, ["GET /value"], root, "react")).toEqual([]);
	});

	it("preparation cannot remove or weaken legacy scenarios while adding coverage", () => {
		expect(retainedScenarioProblems({ steps: [step] }, { steps: [{ ...step, id: "new-id" }] }).join("\n")).toMatch(/retain the legacy scenario value/);
		expect(retainedScenarioProblems({ steps: [step] }, { steps: [{ ...step, compare: "page" }] }).join("\n")).toMatch(/retain the legacy scenario value/);
		expect(retainedScenarioProblems({ steps: [step] }, { steps: [{ ...step, target: { path: "/api/value" } }, { ...step, id: "extra" }] })).toEqual([]);
	});

	it("rejects malformed contracts and failed, empty or nondeterministic observations", () => {
		const file = JSON.parse(readFileSync(suitePath("foundation"), "utf8")) as StepsFile;
		const checks = file.checks!;
		expect(strictSuiteProblems({ ...file, checks: [{ ...checks[0]!, covers: ["absent"] }] }, [], root).join("\n")).toMatch(/compared step ids/);
		expect(contractProblems(checks, [{ id: "behavior", observations: { value: 1 } }], [{ id: "behavior", observations: { value: 2 } }], [{ id: "behavior", observations: { value: 2 } }]).join("\n")).toMatch(/not repeatable/);
		expect(contractProblems(checks, [], [], [{ id: "behavior", error: "driver failed" }]).join("\n")).toMatch(/did not complete/);
	});

	it("strict mode exposes unstable legacy fields that exploratory comparisons mask", () => {
		const r = compareRuns([step], [{ status: 200, body: { n: 1 } }], [{ status: 200, body: { n: 2 } }], [{ status: 200, body: { n: 99 } }], false, true);
		expect(r.diffs).toEqual([]);
		expect(r.unstable).toEqual(["value: legacy differs at body.n"]);
	});

	it("bounds driver execution and rejects empty, invalid, or unsuccessful observations", async () => {
		const check: ParityContract = { id: "driver", kind: "command", why: "observe actual behavior", covers: [], inputs: ["observe.cjs"], command: { cmd: process.execPath, args: [] } };
		const opts = { root, config, side: "legacy" as const, appDir: runtime, urls: {}, timeoutMs: 500 };
		for (const code of ["console.log('{}')", "console.log('not JSON')", "console.log('{\"ok\":true}');process.exit(7)", "setInterval(()=>{},1000)"]) {
			const result = await runContracts([{ ...check, command: { cmd: process.execPath, args: ["-e", code] } }], opts);
			expect(result[0]?.error).toBeTruthy();
			expect(result[0]?.observations).toBeUndefined();
		}
	});

	it("captures mutations made by GET requests when strict database comparison is enabled", async () => {
		const server = createServer((_q, r) => r.end("ok")).listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		let reads = 0;
		try {
			const result = await runSteps([step], { side: "legacy", base: () => `http://127.0.0.1:${(server.address() as { port: number }).port}`, strict: true, dump: () => ({ rows: reads++ ? [{ id: 1 }] : [] }) });
			expect(result[0]?.data).toEqual({ rows: { added: [{ id: 1 }], removed: [] } });
		} finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
	});

	it("compares download bytes without lossy UTF-8 decoding, plus response content headers", async () => {
		const server = createServer((q, r) => { r.setHeader("content-type", "application/octet-stream"); r.setHeader("content-disposition", "attachment; filename=x.bin"); r.end(q.url === "/a" ? Buffer.from([255, 0, 13, 10]) : Buffer.from([254, 0, 13, 10])); }).listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
		try {
			const a = await runSteps([{ ...step, path: "/a" }], { side: "legacy", base: () => base, strict: true });
			const b = await runSteps([{ ...step, path: "/b" }], { side: "target", base: () => base, strict: true });
			expect(a[0]!.body).toEqual({ base64: "/wANCg==" });
			expect(compareRuns([step], a, a, b, false, true).diffs).toMatchObject([{ kind: "body", path: "body.base64" }]);
			b[0]!.body = a[0]!.body; b[0]!.headers!["content-disposition"] = "attachment; filename=wrong.bin";
			expect(compareRuns([step], a, a, b, false, true).diffs).toMatchObject([{ path: "headers.content-disposition" }]);
		} finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
	});
});
