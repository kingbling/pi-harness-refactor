import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getSourceAdapter } from "../src/adapters/registry.ts";
import { exampleProfileJson } from "../src/adapters/source/php.ts";
import { ConfigSchema } from "../src/config.ts";
import { uncheckedDead } from "../src/init/dead.ts";
import { findSchemaUpdates, readSchema, refreshTablePlanReasons, TABLE_PLAN_KEY } from "../src/inventory/db.ts";
import { leftOut } from "../src/inventory/not-app.ts";
import { inventory } from "../src/inventory/run.ts";
import { routeSyntax } from "../src/inventory/switches.ts";
import { Ledger } from "../src/ledger/db.ts";
import { healStackKnowledge } from "../src/run/stack-heal.ts";
import { giantRouteGroups } from "../src/sessions/taskcard.ts";
import type { LeafSession, SpawnOptions } from "../src/sessions/spawn.ts";

/**
 * How the framework loads app files decides what is alive: the framework stays indexed even when the profile calls
 * it a vendored copy; a model reads what the app switches off and on; dropped files get the tool-using check at run
 * start; schema update scripts newer than the dump reach the DB units.
 */
const here = resolve(import.meta.dirname, "..");
const ok = (cost = 0) => ({ text: "done", toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost } });
type Exec = { execute: (i: string, p: object) => Promise<unknown> };
/** A scripted session: calls `tools[name]` with its args when the session has that tool; otherwise does nothing. */
const scripted = (tools: Record<string, (task: string) => object>, seen: Array<{ opts: SpawnOptions; task?: string }> = []) =>
	(async (opts: SpawnOptions): Promise<LeafSession> => {
		const row: { opts: SpawnOptions; task?: string } = { opts };
		seen.push(row);
		return {
			run: async (task: string) => {
				row.task = task;
				for (const t of opts.customTools ?? []) if (tools[t.name]) await (t as unknown as Exec).execute("x", tools[t.name]!(task));
				return ok(0.01);
			},
			dispose() {},
		} as unknown as LeafSession;
	}) as never;

function workspace(name: string, profile: Record<string, unknown>, db?: Record<string, unknown>) {
	const ws = join(here, ".sim", name);
	rmSync(ws, { recursive: true, force: true });
	mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
	cpSync(join(here, "fixtures", "mini-app"), join(ws, "legacy"), { recursive: true });
	process.env["BR_WORKSPACE"] = ws;
	writeFileSync(join(ws, ".bigrefactor", "framework-profile.json"), JSON.stringify({ ...exampleProfileJson(), ...profile }));
	getSourceAdapter("php").reloadProfile?.();
	const put = (p: string, s: string) => (mkdirSync(join(ws, "legacy", p, ".."), { recursive: true }), writeFileSync(join(ws, "legacy", p), s));
	const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, models: {}, ...(db ? { db } : {}) });
	return { ws, put, config, ledger: new Ledger(join(ws, ".bigrefactor", "ledger.sqlite")) };
}
const unitOf = (ledger: Ledger, file: string) => ledger.listUnits().find((u) => (JSON.parse(u.meta).files ?? []).includes(file))?.id;
const deadOf = (ledger: Ledger, p: string) => (ledger.db.prepare("SELECT dead_code FROM files WHERE path = ?").get(p) as { dead_code: number } | undefined)?.dead_code;

describe("the framework stays indexed when the profile calls it vendored", () => {
	it("an app template the framework renders by name is alive; a notApp folder inside the framework is still left out", async () => {
		const { put, config, ledger } = workspace("load-fw-vendored", { frameworkDirs: ["fw/"], notApp: [{ path: "fw/", kind: "vendored", name: "fw", why: "the framework as a submodule" }, { path: "fw/tests/", kind: "tests", why: "its tests" }] });
		put("fw/controller/base/user.base.php", "<?php\nclass UserBase { function action_dashboard() { return ViewFactory::create_view(1, 'users/dashboard'); } }\n");
		put("fw/view/templates/default/users/dashboard.tpl.php", "<?php function fw_dashboard_box() { return 1; }\n");
		put("fw/tests/UserTest.php", "<?php class UserTest { function t() { return 1; } }\n");
		put("app/view/templates/default/users/dashboard.tpl.php", "<?php function app_dashboard_box() { return DashboardService::stats(); }\n");
		put("app/dashboard/DashboardService.php", "<?php class DashboardService { static function stats() { return 1; } }\n");
		await inventory(config, join(config.source.path, ".."), ledger);
		expect(deadOf(ledger, "app/view/templates/default/users/dashboard.tpl.php")).toBe(0);
		expect(deadOf(ledger, "app/dashboard/DashboardService.php")).toBe(0);
		expect((ledger.db.prepare("SELECT disposition FROM files WHERE path = 'fw/controller/base/user.base.php'").get() as { disposition: string }).disposition).toBe("framework");
		expect(deadOf(ledger, "fw/tests/UserTest.php")).toBeUndefined();
		// the rule itself
		const folders = [{ path: "fw/", kind: "vendored" as const, why: "x" }, { path: "lib/x/", kind: "vendored" as const, why: "y" }];
		expect(leftOut("fw/a.php", folders, undefined, ["fw/"])).toBe(false);
		expect(leftOut("lib/x/a.php", folders, undefined, ["fw/"])).toBe(true);
		ledger.close();
	});
});

describe("run start: what the app switches off and on", () => {
	it("switched-off app code leaves the plan with its reason (accepted units stay, reported); a switched-on framework feature becomes a unit; keep brings the code back", async () => {
		const { ws, put, config, ledger } = workspace("load-switches", { frameworkDirs: ["fw/"], notApp: [] });
		put("app/modules.php", "<?php\nLoad::enable_module('hijack');\n//Load::enable_module('webauthn');\n");
		put("app/modules/webauthn/enabled.inc.php", "<?php\n$a = new WebAuthnCbor(); $b = new WebAuthnTpm(); $c = new WebAuthnCfg();\n");
		put("app/modules/webauthn/Cbor.php", "<?php class WebAuthnCbor { function d() { return 1; } }\n");
		put("app/modules/webauthn/Tpm.php", "<?php class WebAuthnTpm { function d() { return 2; } }\n");
		put("app/modules/webauthn/Cfg.php", "<?php class WebAuthnCfg { function d() { return 3; } }\n");
		put("fw/hijack/controller/hijack.controller.php", "<?php class HijackController { function action_hijack() { return 1; } }\n");
		await inventory(config, ws, ledger);
		const [cbor, tpm, cfg] = ["app/modules/webauthn/Cbor.php", "app/modules/webauthn/Tpm.php", "app/modules/webauthn/Cfg.php"].map((f) => unitOf(ledger, f));
		expect(cbor && tpm && cfg).toBeTruthy();
		expect(unitOf(ledger, "fw/hijack/controller/hijack.controller.php")).toBeUndefined();
		ledger.transitionUnit(tpm!, "truth", "t");
		ledger.transitionUnit(tpm!, "implementing", "t");
		ledger.transitionUnit(tpm!, "quarantined", "t");
		ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = ?").run(cfg!);

		const seen: Array<{ opts: SpawnOptions; task?: string }> = [];
		const spawn = scripted({
			record_switches: () => ({
				off: [{ path: "app/modules/webauthn", why: "app/modules.php:3 has the enable line commented out" }, { path: "app/nowhere/", why: "x" }],
				features: [{ path: "fw/hijack/", what: "an admin logs in as another user", why: "app/modules.php:2 enables it" }],
				routeSyntax: "A trailing ! after a part makes it optional; * at the end takes the rest of the path.",
			}),
		}, seen);
		const log: string[] = [];
		await healStackKnowledge({ ledger, config, root: ws, spawn, log: (l) => log.push(l) });

		expect(seen.find((s) => s.opts.customTools?.some((t) => t.name === "record_switches"))!.opts).toMatchObject({ role: "review", cwd: config.source.path, writeGlobs: [] });
		const saved = JSON.parse(readFileSync(join(ws, ".bigrefactor", "framework-profile.json"), "utf8")).switches;
		expect(saved.off.map((f: { path: string }) => f.path)).toEqual(["app/modules/webauthn/"]);
		expect(routeSyntax(ws)).toMatch(/optional/);
		// the planned and the stuck unit leave the plan, with the reason kept; the accepted one stays and is reported
		expect(ledger.getUnit(cbor!)).toBeUndefined();
		expect(ledger.getUnit(tpm!)).toBeUndefined();
		const removed = ledger.db.prepare("SELECT reason FROM transitions WHERE entity = 'unit' AND entity_id = ? AND to_state = 'removed'").get(tpm!) as { reason: string };
		expect(removed.reason).toMatch(/switched off: app\/modules\.php:3/);
		expect(ledger.getUnit(cfg!)!.state).toBe("accepted");
		expect(log.join("\n")).toMatch(/1 accepted unit\(s\) hold code the app switches off/);
		const sym = ledger.db.prepare("SELECT state, reason FROM symbols WHERE path = 'app/modules/webauthn/Cbor.php' LIMIT 1").get() as { state: string; reason: string };
		expect(sym).toMatchObject({ state: "dropped", reason: expect.stringMatching(/^left out: switched off/) });
		expect(ledger.checkInvariants().ok).toBe(true);
		// the framework feature is not migrated before the owner answers port (a live run got 126 framework units by default)
		expect(unitOf(ledger, "fw/hijack/controller/hijack.controller.php")).toBeUndefined();
		const qs = ledger.openQuestions();
		const offQ = qs.find((q) => q.point === "switched_off")!;
		expect(offQ.blocks).toBe("none");
		const featureQ = qs.find((q) => q.point === "framework_feature")!;
		expect(featureQ.blocks).toBe("none");

		// once: the next run start asks no model about it
		const again: Array<{ opts: SpawnOptions }> = [];
		await healStackKnowledge({ ledger, config, root: ws, spawn: scripted({}, again), log: () => {} });
		expect(again.some((s) => s.opts.customTools?.some((t) => t.name === "record_switches"))).toBe(false);
		expect(unitOf(ledger, "fw/hijack/controller/hijack.controller.php")).toBeUndefined();

		// port: the next run start migrates it like app code; taking it back removes the planned unit again
		ledger.answerQuestion(featureQ.id, "port — migrate it");
		await healStackKnowledge({ ledger, config, root: ws, spawn: scripted({}, []), log: () => {} });
		expect(unitOf(ledger, "fw/hijack/controller/hijack.controller.php")).toBeTruthy();
		ledger.db.prepare("UPDATE questions SET answer = 'leave-out — no' WHERE id = ?").run(featureQ.id);
		await healStackKnowledge({ ledger, config, root: ws, spawn: scripted({}, []), log: () => {} });
		expect(unitOf(ledger, "fw/hijack/controller/hijack.controller.php")).toBeUndefined();

		// the owner keeps the module: its code is planned again
		ledger.answerQuestion(offQ.id, "keep — migrate it anyway");
		await inventory(config, ws, ledger);
		expect(unitOf(ledger, "app/modules/webauthn/Cbor.php")).toBeTruthy();
		expect((ledger.db.prepare("SELECT state FROM symbols WHERE path = 'app/modules/webauthn/Cbor.php' LIMIT 1").get() as { state: string }).state).toBe("clustered");
		expect(ledger.checkInvariants().ok).toBe(true);
		ledger.close();
	});

	it("symbols of a unit removed because its folder is not app code are dropped with that reason, not left clustered", async () => {
		const { ws, put, config, ledger } = workspace("load-orphans", { frameworkDirs: [], notApp: [] });
		put("app/3rdparty/lib/Lib.php", "<?php class VendLib { function x() { return 1; } }\n");
		put("index.php", "<?php $l = new VendLib(); $l->x();\n");
		await inventory(config, ws, ledger);
		expect(unitOf(ledger, "app/3rdparty/lib/Lib.php")).toBeTruthy();
		writeFileSync(join(ws, ".bigrefactor", "framework-profile.json"), JSON.stringify({ ...exampleProfileJson(), frameworkDirs: [], notApp: [{ path: "app/3rdparty/lib/", kind: "vendored", name: "lib", why: "a copied library" }] }));
		await inventory(config, ws, ledger);
		expect(unitOf(ledger, "app/3rdparty/lib/Lib.php")).toBeUndefined();
		expect(ledger.db.prepare("SELECT COUNT(*) n FROM symbols WHERE unit_id IS NULL AND state = 'clustered'").get()).toEqual({ n: 0 });
		expect((ledger.db.prepare("SELECT reason FROM symbols WHERE path = 'app/3rdparty/lib/Lib.php' LIMIT 1").get() as { reason: string }).reason).toBe("left out: a copied library");
		ledger.close();
	});
});

describe("run start: the dead-code check catches up", () => {
	it("dropped files no session looked at are checked once; the ones still running come back; framework files at the same place are named", async () => {
		const { ws, put, config, ledger } = workspace("load-dead-catchup", { frameworkDirs: ["fw/"], notApp: [] });
		put("fw/view/templates/default/users/lost_password.tpl.php", "<?php function fw_lost() { return 1; }\n");
		put("app/view/templates/default/users/lost_password.tpl.php", "<?php function app_lost() { return 1; }\n");
		await inventory(config, ws, ledger);
		expect(uncheckedDead(ledger, ws)).toContain("app/view/templates/default/users/lost_password.tpl.php");
		// a dead mark left on a file the index no longer holds (a library now left out) is not asked about
		ledger.upsertFile({ path: "app/3rdparty/old/Example.php", hash: "x", lang: "php", loc: 3 });
		ledger.markDeadCode("app/3rdparty/old/Example.php", "no inbound references");
		expect(uncheckedDead(ledger, ws)).not.toContain("app/3rdparty/old/Example.php");
		const seen: Array<{ opts: SpawnOptions; task?: string }> = [];
		const spawn = scripted({ judge_files: (task) => ({ files: [...task.matchAll(/^ {2}(\S+\.php)/gm)].map((m) => ({ path: m[1]!, verdict: m[1]!.includes("lost_password") ? "alive" : "dead", evidence: m[1]!.includes("lost_password") ? "the framework's lost-password route renders users/lost_password" : "nothing names it" })) }) }, seen);
		const log: string[] = [];
		await healStackKnowledge({ ledger, config, root: ws, spawn, log: (l) => log.push(l) });
		const dead = seen.find((s) => s.opts.customTools?.some((t) => t.name === "judge_files"))!;
		expect(dead.task).toMatch(/lost_password\.tpl\.php.*same place as fw\/view\/templates\/default\/users\/lost_password\.tpl\.php/);
		expect(dead.opts.systemPrompt).toMatch(/framework's own code \(fw\/\) loads app files too/);
		expect(deadOf(ledger, "app/view/templates/default/users/lost_password.tpl.php")).toBe(0);
		expect(log.join("\n")).toMatch(/still run and are migrated again/);
		expect(uncheckedDead(ledger, ws)).toEqual([]);
		// nothing new: no second session
		const again: Array<{ opts: SpawnOptions }> = [];
		await healStackKnowledge({ ledger, config, root: ws, spawn: scripted({}, again), log: () => {} });
		expect(again.some((s) => s.opts.customTools?.some((t) => t.name === "judge_files"))).toBe(false);
		ledger.close();
	});

	it("a framework file judged dead stays dropped without an owner question; an app file judged dead is asked about", async () => {
		const { ws, put, config, ledger } = workspace("load-dead-fw", { frameworkDirs: ["fw/"], notApp: [] });
		put("fw/contrib/countries/doxygen.php", "<?php function fw_doc() { return 1; }\n");
		put("app/old/export.php", "<?php function app_export() { return 1; }\n");
		await inventory(config, ws, ledger);
		for (const p of ["fw/contrib/countries/doxygen.php", "app/old/export.php"]) ledger.markDeadCode(p, "no inbound references");
		const seen: Array<{ opts: SpawnOptions; task?: string }> = [];
		const spawn = scripted({ judge_files: (task) => ({ files: [...task.matchAll(/^ {2}(\S+\.php)/gm)].map((m) => ({ path: m[1]!, verdict: "dead", evidence: "nothing names it" })) }) }, seen);
		await healStackKnowledge({ ledger, config, root: ws, spawn, log: () => {} });
		expect(seen.find((s) => s.opts.customTools?.some((t) => t.name === "judge_files"))!.task).toMatch(/fw\/contrib\/countries\/doxygen\.php/);
		const asked = ledger.openQuestions().filter((q) => q.point === "dead_code").map((q) => q.question);
		expect(asked.join("\n")).toMatch(/app\/old/);
		expect(asked.join("\n")).not.toMatch(/fw\/contrib/);
		ledger.close();
	});
});

describe("schema updates newer than the dump", () => {
	it("a model lists them once; their ALTERs reach the tables; done DB units are flagged and re-opened when the owner says redo", async () => {
		const { ws, put, config, ledger } = workspace("load-schema-updates", { frameworkDirs: [], notApp: [] }, { from: ["mariadb"], schemaFiles: ["db/dump.sql"] });
		put("db/dump.sql", "CREATE TABLE rmsformats (\n  id int NOT NULL,\n  name varchar(40)\n);\n");
		put("app/install/updates/0268_formats_version.sql", "ALTER TABLE rmsformats ADD COLUMN version int NOT NULL DEFAULT 1;\n");
		put("app/install/updates/0001_old.sql", "-- already in the dump\n");
		const seen: Array<{ opts: SpawnOptions; task?: string }> = [];
		const spawn = scripted({ record_schema_updates: () => ({ files: [{ path: "app/install/updates/0268_formats_version.sql", why: "adds rmsformats.version; the dump has no such column" }, { path: "db/dump.sql", why: "x" }, { path: "../etc/passwd", why: "x" }] }) }, seen);
		expect((await findSchemaUpdates(config, ws, { spawn }))?.files.map((f) => f.path)).toEqual(["app/install/updates/0268_formats_version.sql"]);
		expect(seen[0]!.opts).toMatchObject({ role: "review", cwd: config.source.path, writeGlobs: [] });
		expect(await findSchemaUpdates(config, ws, { spawn: (async () => { throw new Error("not again"); }) as never })).toBeUndefined();
		const t = (await readSchema(config, () => {}, ws)).find((x) => x.name === "rmsformats")!;
		expect(t.ddl).toMatch(/ADD COLUMN version/);

		ledger.createUnit({ id: "DB_schema_rms", tier: "T0", kind: "db_schema", meta: { lane: "db", tables: ["rmsformats"] }, symbolIds: [] });
		ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = 'DB_schema_rms'").run();
		const nope = (async () => { throw new Error("no session"); }) as never;
		await healStackKnowledge({ ledger, config, root: ws, spawn: nope, log: () => {} });
		expect(JSON.parse(ledger.getUnit("DB_schema_rms")!.meta)).toMatchObject({ stale: true, staleReason: expect.stringContaining("0268_formats_version.sql") });
		const q = ledger.openQuestions().find((x) => x.point === "schema_update")!;
		expect(q.blocks).toBe("none");
		ledger.answerQuestion(q.id, "redo — add the changes");
		await healStackKnowledge({ ledger, config, root: ws, spawn: nope, log: () => {} });
		expect(ledger.getUnit("DB_schema_rms")!.state).toBe("planned");
		expect(JSON.parse(ledger.getUnit("DB_schema_rms")!.meta).stale).toBeUndefined();
		// asked once
		await healStackKnowledge({ ledger, config, root: ws, spawn: nope, log: () => {} });
		expect(ledger.db.prepare("SELECT COUNT(*) n FROM questions WHERE point = 'schema_update'").get()).toEqual({ n: 1 });
		ledger.close();
	});

	it("a table plan reason that waits for an answer says what the owner decided once it is answered", () => {
		const ledger = new Ledger(":memory:");
		const q = ledger.askQuestion({ point: "db_include", question: "migrate staging_test?", options: ["include", "leave-out"], blocks: "none", askedBy: "db lane" });
		ledger.setMeta(TABLE_PLAN_KEY, JSON.stringify({ groups: {}, dropped: [{ table: "passwordrules", reason: `database staging_test: waiting for the owner's answer (question #${q})` }] }));
		expect(refreshTablePlanReasons(ledger)).toBe(0);
		ledger.answerQuestion(q, "leave-out — do not migrate staging_test");
		expect(refreshTablePlanReasons(ledger)).toBe(1);
		expect(JSON.parse(ledger.getMeta(TABLE_PLAN_KEY)!).dropped[0].reason).toBe(`database staging_test is not migrated: the owner answered leave-out (question #${q})`);
	});
});

describe("big units: one route group at a time", () => {
	it("groups a big unit's routes by their first path parts; small units get no groups", () => {
		const routes = [...Array(6)].map((_, i) => ({ path: `advertising/deals/{id}/edit${i}` })).concat([...Array(5)].map((_, i) => ({ path: `/advertising/flights/x${i}` })), [{ path: "https://partners/list" }]);
		expect(giantRouteGroups(5000, routes)).toEqual(["advertising/deals (6 routes)", "advertising/flights (5 routes)", "partners/list (1 route)"]);
		expect(giantRouteGroups(800, routes)).toBeUndefined();
		expect(giantRouteGroups(5000, routes.slice(0, 3))).toBeUndefined();
	});
});
