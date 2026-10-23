import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { commitAll, ensureRepo, isDirty } from "../src/git.ts";
import { legacyCopyTool } from "../src/run/legacy-env.ts";
import { appBootTools, fixtureGaps, LEGACY, loadApps, probeApp, type AppFixer, type AppState } from "../src/run/parity.ts";
import { loadScope, oldFailures, recordFixture, recordOldFailures, scopeIfValid, scopePath } from "../src/run/parity-scope.ts";

/**
 * Strict parity replays every slice on both apps from the same starting data. The setup models make that: a reset
 * loading a small fixture, its files recorded in scope.json, the old app's config overlays declared.
 */
async function workspace() {
	const root = mkdtempSync(join(tmpdir(), "br-fixture-"));
	const legacy = join(root, "legacy");
	mkdirSync(legacy, { recursive: true });
	writeFileSync(join(legacy, "server.js"), "require('http').createServer((q, s) => s.end('ok')).listen(Number(process.argv[2]));\n");
	writeFileSync(join(legacy, "config.php"), "<?php $db = 'production';\n");
	await ensureRepo(legacy);
	await commitAll(legacy, "legacy app");
	const config = ConfigSchema.parse({ source: { path: legacy, stack: "php" }, target: { path: join(root, "new"), stacks: ["nestjs"] }, models: {}, db: { strategy: "keep-schema", from: ["mariadb"], to: "postgresql" } });
	return { root, legacy, config };
}

async function freePort(): Promise<number> {
	return new Promise((res) => {
		const s = createServer().listen(0, () => {
			const p = (s.address() as { port: number }).port;
			s.close(() => res(p));
		});
	});
}

const call = (t: unknown, p: object) => (t as { execute: (id: string, p: object) => Promise<{ content: Array<{ text: string }> }> }).execute("x", p).then((r) => r.content[0]!.text);
const tool = (tools: unknown[], name: string) => tools.find((t) => (t as { name: string }).name === name);
const recipe = (port: number) => ({ dir: ".", cmd: process.execPath, args: ["server.js", String(port)], ready: `http://localhost:${port}/`, dumpCmd: process.execPath, dumpArgs: ["-e", "process.stdout.write('{}')"] });
const fixtureFile = (root: string, name: string, text: string) => {
	mkdirSync(join(root, ".bigrefactor/parity/fixture"), { recursive: true });
	writeFileSync(join(root, ".bigrefactor/parity/fixture", name), text);
	return `.bigrefactor/parity/fixture/${name}`;
};

describe("the strict parity fixture", () => {
	it("records each app's files in scope.json; the old app's fixture counts as changed only when its content changes", async () => {
		const { root } = await workspace();
		expect(recordFixture(root, LEGACY, ["missing.sql"])).toMatch(/missing.sql is not a file/);
		mkdirSync(join(root, ".bigrefactor/worktrees/__parity__/nestjs"), { recursive: true });
		writeFileSync(join(root, ".bigrefactor/worktrees/__parity__/nestjs/.env.local"), "DB=fixture\n");
		expect(recordFixture(root, "nestjs", [".bigrefactor/worktrees/__parity__/nestjs/.env.local"])).toMatch(/inside a temporary worktree/);
		const seed = fixtureFile(root, "seed.sql", "INSERT INTO users VALUES (1);\n");
		expect(recordFixture(root, LEGACY, [seed], [{ path: "config.php", why: "the local database" }])).toBeUndefined();
		const first = loadScope(root);
		expect(first).toMatchObject({ fixture: { files: [seed] }, legacyOverrides: [{ path: "config.php" }], by: { legacy: [seed] } });
		// recorded again unchanged: the new app need not load it again; overrides left out are kept
		expect(recordFixture(root, LEGACY, [seed])).toBeUndefined();
		expect(loadScope(root)).toMatchObject({ legacyAt: first.legacyAt, legacyOverrides: [{ path: "config.php" }] });
		const reset = fixtureFile(root, "reset-pg.sh", "psql < seed.sql\n");
		expect(recordFixture(root, "nestjs", [reset])).toBeUndefined();
		expect(loadScope(root)).toMatchObject({ fixture: { files: [seed, reset] }, legacyAt: first.legacyAt });
		await new Promise((r) => setTimeout(r, 5));
		writeFileSync(join(root, seed), "INSERT INTO users VALUES (1), (2);\n");
		expect(recordFixture(root, LEGACY, [seed], [])).toBeUndefined();
		const changed = loadScope(root);
		expect(changed.legacyAt).not.toBe(first.legacyAt);
		expect(changed.legacyOverrides).toBeUndefined();
	});

	it("a new app follows the old app's fixture: nothing is asked before it exists, then its reset must load the same data", async () => {
		const { root, config } = await workspace();
		const app: AppState = { up: true, recipe: { dir: ".", start: { cmd: "node", args: [] }, ready: "http://localhost:1/", reset: { cmd: "sh", args: ["reset.sh"] } } };
		expect(await fixtureGaps(config, root, "nestjs", app)).toEqual([]);
		expect(await fixtureGaps(ConfigSchema.parse({ ...config, db: { strategy: "none" } }), root, LEGACY, app)).toEqual([]);
		recordFixture(root, LEGACY, [fixtureFile(root, "seed.sql", "INSERT INTO users VALUES (1);\n")]);
		const gaps = await fixtureGaps(config, root, "nestjs", app);
		expect(gaps.join("\n")).toMatch(/not recorded \(set_fixture_files\)/);
		expect(gaps.join("\n")).toMatch(/the old app's fixture \(.bigrefactor\/parity\/fixture\/seed.sql\) is newer than this app's data setup/);
		recordFixture(root, "nestjs", [fixtureFile(root, "reset.sh", "psql\n")]);
		expect(await fixtureGaps(config, root, "nestjs", { ...app, fixtureFor: scopeIfValid(root)!.legacyAt })).toEqual([]);
		// a recorded file that is gone (or was in the temporary worktree, from an older plugin) is recorded again
		const scope = JSON.parse(readFileSync(scopePath(root), "utf8"));
		scope.by.nestjs.push(".bigrefactor/worktrees/__parity__/nestjs/.env");
		writeFileSync(scopePath(root), JSON.stringify(scope));
		expect((await fixtureGaps(config, root, "nestjs", { ...app, fixtureFor: scopeIfValid(root)!.legacyAt })).join("\n")).toMatch(/cannot be fingerprinted: .*temporary worktree/);
	});

	it("steps the old app fails on after its reset are a gap of its fixture until the fixture changes", async () => {
		const { root, config } = await workspace();
		const seed = fixtureFile(root, "seed.json", '{"users":[{"id":726}]}\n');
		recordFixture(root, LEGACY, [seed]);
		const app: AppState = { up: true, recipe: { dir: ".", start: { cmd: "node", args: [] }, ready: "http://localhost:1/", reset: { cmd: "sh", args: ["reset.sh"] } } };
		recordOldFailures(root, "rms", ["s1 GET /rms/requests (the old app: status 503)"]);
		recordOldFailures(root, "login", []);
		recordOldFailures(root, "logout", ["s4 GET /user/edit (the old app sends it to the login page: the login before it did not hold)"]);
		expect(Object.keys(oldFailures(root))).toEqual(["rms", "logout"]);
		recordOldFailures(root, "logout", []);
		expect(oldFailures(root)).toEqual({ rms: ["s1 GET /rms/requests (the old app: status 503)"] });
		const gaps = (await fixtureGaps(config, root, LEGACY, app)).join("\n");
		expect(gaps).toMatch(/fails 1 step\(s\) \(a server error[\s\S]*rms s1 GET \/rms\/requests \(the old app: status 503\)[\s\S]*the test account needs/);
		// the new apps are not asked about the old app's failures
		expect((await fixtureGaps(config, root, "nestjs", { ...app, fixtureFor: scopeIfValid(root)!.legacyAt })).join("\n")).not.toMatch(/server error/);
		// once the fixture changes, the failures were seen on an older one: the slices must be checked again first
		await new Promise((r) => setTimeout(r, 5));
		writeFileSync(join(root, seed), '{"users":[{"id":726}],"agencies":[{"id":1}]}\n');
		recordFixture(root, LEGACY, [seed]);
		expect(oldFailures(root)).toEqual({});
		expect((await fixtureGaps(config, root, LEGACY, app)).join("\n")).not.toMatch(/server error/);
		recordOldFailures(root, "rms", []);
		expect(oldFailures(root)).toEqual({});
	});

	it("the old app's setup adds a reset, records the fixture and declares the config it changed in its copy; then nothing more is asked", async () => {
		const { root, legacy, config } = await workspace();
		const port = await freePort();
		const first: AppFixer = async (o) => (await call(legacyCopyTool(o.root, o.config), { why: "copy" }), await call(tool(appBootTools(o.config, o.root, o.side), "set_app_boot"), recipe(port)), "node serves it");
		expect(await probeApp({ config, root, side: LEGACY, fixer: first, log: () => {} })).toBe(true);
		// the copy points at a local database: a tracked file that differs from the pinned source
		const copy = loadApps(root)[LEGACY] && join(root, ".bigrefactor/legacy-env/app");
		writeFileSync(join(copy!, "config.php"), "<?php $db = 'local';\n");
		const problems: string[] = [];
		const fixture: AppFixer = async (o) => {
			problems.push(o.problem);
			const seed = fixtureFile(o.root, "seed.json", '{"users":[{"id":1}]}\n');
			const tools = appBootTools(o.config, o.root, o.side);
			await call(tool(tools, "set_app_boot"), { ...recipe(port), resetCmd: process.execPath, resetArgs: ["-e", "0"] });
			expect(await call(tool(tools, "set_fixture_files"), { files: [seed], overrides: [{ path: "config.php", why: "points at the local fixture database" }] })).toMatch(/recorded 1 fixture file/);
			return "the reset loads the seed";
		};
		expect(await probeApp({ config, root, side: LEGACY, fixer: fixture, log: () => {} })).toBe(true);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatch(/it has no data reset[\s\S]*not recorded[\s\S]*config\.php[\s\S]*Declare each that is local config/);
		expect(loadApps(root)[LEGACY]).toMatchObject({ fixtureProbes: 1, recipe: { reset: { cmd: process.execPath } } });
		expect(JSON.parse(readFileSync(scopePath(root), "utf8"))).toMatchObject({ legacyOverrides: [{ path: "config.php" }] });
		expect(await fixtureGaps(config, root, LEGACY, loadApps(root)[LEGACY]!)).toEqual([]);
		expect(await probeApp({ config, root, side: LEGACY, fixer: fixture, log: () => {} })).toBe(true);
		expect(problems).toHaveLength(1);
		// an untracked file in the read-only legacy repo is no change to it; a tracked one is
		writeFileSync(join(legacy, "editor.tmp"), "");
		expect(await isDirty(legacy, { untracked: false })).toBe(false);
		expect(await isDirty(legacy)).toBe(true);
		writeFileSync(join(legacy, "config.php"), "<?php $db = 'changed';\n");
		expect(await isDirty(legacy, { untracked: false })).toBe(true);
	});
});

describe("a check the old app cannot complete", () => {
	it("goes back to preparation until it is rewritten, and leaves the record once it completes", async () => {
		const { brokenChecks, recordBrokenChecks } = await import("../src/run/parity-check.ts");
		const root = mkdtempSync(join(tmpdir(), "br-broken-"));
		const dir = join(root, ".bigrefactor/parity/slices/foundation");
		mkdirSync(join(dir, "checks"), { recursive: true });
		writeFileSync(join(dir, "checks/tests.cjs"), "run the old test suite\n");
		const check = { id: "tests", kind: "command" as const, covers: [], why: "x", command: { cmd: "node", args: [".bigrefactor/parity/slices/foundation/checks/tests.cjs"] }, inputs: [".bigrefactor/parity/slices/foundation/checks/tests.cjs"] };
		const file = { steps: [], checks: [check] };
		recordBrokenChecks(root, "foundation", [check], [[{ id: "tests", error: "Refusing to run db tests: lane not in the allowlist" }], [{ id: "tests", error: "Refusing to run db tests" }]]);
		expect(brokenChecks(root, "foundation", file).join("\n")).toMatch(/check tests does not complete on the old app[\s\S]*allowlist/);
		// the same check with its driver rewritten is a new one
		writeFileSync(join(dir, "checks/tests.cjs"), "read the records both apps keep\n");
		expect(brokenChecks(root, "foundation", file)).toEqual([]);
		// a later comparison where it completes clears the record
		writeFileSync(join(dir, "checks/tests.cjs"), "run the old test suite\n");
		expect(brokenChecks(root, "foundation", file)).toHaveLength(1);
		recordBrokenChecks(root, "foundation", [check], [[{ id: "tests", observations: { rows: 1 } }], [{ id: "tests", observations: { rows: 1 } }]]);
		expect(brokenChecks(root, "foundation", file)).toEqual([]);
	});
});
