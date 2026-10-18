import pc from "picocolors";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { builtinTarget, getSourceAdapter, getTargetAdapter, registerGeneratedTargets } from "../adapters/registry.ts";
import { loadCommandOverrides } from "../adapters/command-overrides.ts";
import { healBuiltinWiring } from "../adapters/wiring.ts";
import { healBoot, healCheckConfig, healMigrateFresh, healSkipMarker, healWiringFiles } from "../adapters/target/generated.ts";
import { fixRunSetup } from "../init/setup-fixer.ts";
import type { DbUnitMeta } from "../inventory/db.ts";
import { ENGINE_SEMANTICS, ENGINE_SEMANTICS_OPTIONS, namesFileOf } from "./db-unit.ts";
import { run } from "./gate.ts";
import { placeUnit } from "./placement.ts";
import type { Config } from "../config.ts";
import { projectDir } from "../init/init.ts";
import { confirmDeadCode, uncheckedDead } from "../init/dead.ts";
import { dbDetected, findSchemaUpdates, isDbUnitKind, refreshTablePlanReasons, schemaUpdateDrift } from "../inventory/db.ts";
import { healSwitches, switchedOff } from "../inventory/switches.ts";
import { answerValue, askViaModel } from "../jev/ask.ts";
import { reopenUnit } from "./recheck.ts";
import { healNotApp, leftOut, loadNotApp } from "../inventory/not-app.ts";
import { inventory } from "../inventory/run.ts";
import { ROUTE_SUBCLASSES } from "../inventory/route-forms.ts";
import type { Ledger } from "../ledger/db.ts";
import type { ModelClient } from "../models/types.ts";
import type { spawnLeaf } from "../sessions/spawn.ts";
import { requeueUnits } from "./run.ts";

/**
 * Run start: stack knowledge written before the plugin asked for it gets just the missing part, from a model.
 * - A framework profile without notApp: a session lists the folders that are not the app (healNotApp), then the
 *   inventory runs again, so planned units there drop out and a vendored folder becomes a library decision. Units
 *   started there that merged nothing go back to planned first, so they drop out too.
 * - A generated adapter without wiringFiles, or naming one the project no longer has (a setup fix moved it): one
 *   question to the model (healWiringFiles); the rest stays.
 * - A generated adapter without a boot command (the app's own start check): one question to the model, the command
 *   tried on main's project (healBoot), so the builder and the tidy and code-job checks catch an app that no longer starts.
 * - A generated adapter without checkConfigGlobs (the files that decide how the checks run): one question to the
 *   model (healCheckConfig); code jobs may change the other protected files from then on.
 * - A source index built before the app's own subclasses of the profile's route classes counted as routes: the
 *   inventory runs again once (no model), so those routes reach slices and parity steps.
 * - A generated adapter whose skip marker was never checked against the test runner: one question to the model
 *   (healSkipMarker); accepted units whose own tests skip or leave tests incomplete then go back for the tester.
 * - A generated adapter without migrateFresh: one question to the model, tried on main's project, or a tool the setup
 *   model adds (healMigrateFresh). Then, at every start, the migrations run on an empty database from main's project:
 *   the accepted database work whose migration fails goes back, and green gives the accepted ones their verdict.
 * - Database work that ports tables to another engine: how behaviour the new engine cannot copy exactly is treated is
 *   asked once (the run decides it from the owner's goals when it can), and the database work and its reviewer follow it.
 */
const NOT_APP_PENDING = "not_app_heal_pending";

/** The inventory again; open questions about units it drops are withdrawn (nothing left to decide). The dropped ids. */
async function inventoryAgain(o: { ledger: Ledger; config: Config; root: string }, why: string): Promise<Set<string>> {
	// read now: a unit the inventory deletes loses the link (unit_id is set to null)
	const open = o.ledger.db.prepare("SELECT id, unit_id FROM questions WHERE unit_id IS NOT NULL AND status = 'open'").all() as Array<{ id: number; unit_id: string }>;
	const before = new Set(o.ledger.listUnits().map((u) => u.id));
	await inventory(o.config, o.root, o.ledger);
	const gone = new Set([...before].filter((id) => !o.ledger.getUnit(id)));
	const q = o.ledger.db.prepare("UPDATE questions SET status = 'withdrawn', answer = COALESCE(answer || ' — ', '') || ?, answered_at = COALESCE(answered_at, ?) WHERE id = ? AND status = 'open'");
	for (const r of open) if (gone.has(r.unit_id)) q.run(why, new Date().toISOString(), r.id);
	return gone;
}

const SWITCHES_PENDING = "switches_heal_pending";
/** Ledger meta: the owner question about done tables that schema updates change ({id, units, applied}). */
const SCHEMA_UPDATE_Q = "schema_update_question";

/**
 * Accepted DB units built from a schema older than the app's update scripts: one owner question (blocking nothing)
 * lists them; "redo" re-opens them (code kept) so the columns the code uses get added, once.
 */
async function redoForSchemaUpdates(o: { ledger: Ledger; config: Config; root: string; client?: ModelClient; log: (l: string) => void }): Promise<void> {
	const { ledger } = o;
	const prev = JSON.parse(ledger.getMeta(SCHEMA_UPDATE_Q) || "null") as { id: number; units: string[]; applied?: boolean } | null;
	if (prev) {
		const q = ledger.getQuestion(prev.id);
		if (!prev.applied && q && q.status !== "open" && answerValue(q.answer) === "redo") {
			for (const id of prev.units) {
				if (ledger.getUnit(id)?.state !== "accepted") continue;
				ledger.clearStale(id);
				reopenUnit(ledger, id, `The app's schema update scripts change this unit's tables after the dump it was built from (see the schema text): add those changes.`, `re-opened: schema updates newer than the dump (question #${prev.id})`);
			}
			ledger.setMeta(SCHEMA_UPDATE_Q, JSON.stringify({ ...prev, applied: true }));
			o.log(pc.cyan(`↻ ${prev.units.length} DB unit(s) re-opened for schema updates newer than the dump (question #${prev.id})`));
		}
		return;
	}
	const drift = await schemaUpdateDrift(ledger, o.config, o.root);
	if (!drift.length) return;
	const q = await askViaModel({ ledger, config: o.config, root: o.root, client: o.client }, {
		point: "schema_update",
		facts: `The database schema was read from ${o.config.db.schemaFiles.join(", ")}, but the app's own update scripts change it after that, and these tables are already done without the changes:\n${drift.map((d) => `- ${d.tables.join(", ")} (done in ${d.unit}): changed by ${d.files.join(", ")}`).join("\n").slice(0, 3000)}\nCode that uses the new columns fails on the new database until they are added.`,
		options: [{ value: "redo", facts: "add the changes: those tables are done again, their code kept" }, { value: "leave", facts: "keep the tables as they are" }],
		recommended: "redo",
		blocks: "none",
		askedBy: "db lane",
	});
	ledger.setMeta(SCHEMA_UPDATE_Q, JSON.stringify({ id: q.id, units: drift.map((d) => d.unit) }));
	o.log(pc.yellow(`schema updates newer than the dump change ${drift.length} done DB unit(s): question #${q.id}`));
}

export async function healStackKnowledge(o: { ledger: Ledger; config: Config; root: string; client?: ModelClient; spawn?: typeof spawnLeaf; log: (l: string) => void }): Promise<void> {
	const { ledger, config } = o;
	// the profile keeps notApp as soon as the session wrote it; a requeue + inventory that did not finish (stopped,
	// threw) is redone from that list on the next run start
	const pending = ledger.getMeta(NOT_APP_PENDING) === "1";
	const notApp = (await healNotApp({ config, root: o.root, ledger, spawn: o.spawn, log: o.log })) ?? (pending ? loadNotApp(o.root) : undefined);
	if (notApp) {
		ledger.setMeta(NOT_APP_PENDING, "1");
		o.log(pc.cyan(`↻ the framework profile now names ${notApp.length} folder(s) that are not app code: ${notApp.map((f) => f.path).join(", ") || "none"}`));
		const source = getSourceAdapter(config.source.stack);
		source.reloadProfile?.();
		const outside = (u: { meta: string }) => {
			const files = (JSON.parse(u.meta).files ?? []) as string[];
			return files.length > 0 && files.every((f) => leftOut(f, notApp, (p) => !!source.isEntryPoint?.(p)));
		};
		const units = ledger.listUnits().filter((u) => u.state !== "planned" && !isDbUnitKind(u.kind) && outside(u));
		const started = units.filter((u) => u.state !== "accepted").map((u) => u.id);
		if (started.length) await requeueUnits(ledger, config, o.root, started, "run start: their files are not app code");
		const gone = await inventoryAgain(o, "withdrawn: the unit's files are not app code");
		o.log(pc.cyan(`  ${gone.size} unit(s) dropped from the plan: their files are not app code`));
		const accepted = units.filter((u) => u.state === "accepted").map((u) => u.id);
		if (accepted.length) o.log(pc.yellow(`  ${accepted.length} accepted unit(s) hold code that is not the app's: ${accepted.slice(0, 20).join(", ")}${accepted.length > 20 ? ", …" : ""} (left as they are)`));
		ledger.setMeta(NOT_APP_PENDING, "0");
	}
	// an index built before the app's own route classes counted misses the routes they declare: built again once
	if (ledger.getMeta("inventory_at") && ledger.getMeta(ROUTE_SUBCLASSES) === undefined && getSourceAdapter(config.source.stack).routeClassTest?.()) {
		const count = () => (ledger.db.prepare("SELECT COUNT(*) n FROM index_routes WHERE side = 'source'").get() as { n: number }).n;
		const before = count();
		// a throw is logged, not passed on: the heals below still run, and the next run start tries again
		await inventoryAgain(o, "withdrawn: the unit was regrouped when the app's own route classes were indexed")
			.then((gone) => o.log(pc.cyan(`↻ the source index now counts the app's own route classes: ${before} → ${count()} routes (${JSON.parse(ledger.getMeta(ROUTE_SUBCLASSES) ?? "[]").join(", ") || "none"})${gone.size ? `; ${gone.size} planned unit(s) regrouped` : ""}`)))
			.catch((e) => o.log(pc.yellow(`the source index could not be rebuilt with the app's own route classes: ${e?.message ?? e} (tried again next run start)`)));
	}
	// an index built while a notApp "vendored" entry left the framework itself out: the framework's loading of app files
	// (a template it renders by name, a folder it scans) was lost, and those app files looked dead. Built again once.
	{
		const dirs = getSourceAdapter(config.source.stack).frameworkDirs?.(config.source.path) ?? [];
		const has = (sql: string) => dirs.some((d) => !!ledger.db.prepare(sql).get(`${d}%`));
		if (ledger.getMeta("inventory_at") && has("SELECT 1 FROM files WHERE disposition = 'framework' AND path LIKE ? LIMIT 1") && !has("SELECT 1 FROM index_symbols WHERE side = 'source' AND path LIKE ? LIMIT 1"))
			await inventoryAgain(o, "withdrawn: the unit was regrouped when the framework was indexed again")
				.then((gone) => o.log(pc.cyan(`↻ the framework (${dirs.join(", ")}) is indexed again, so the app files it loads count as used${gone.size ? `; ${gone.size} planned unit(s) regrouped` : ""}`)))
				.catch((e) => o.log(pc.yellow(`the framework could not be indexed again: ${e?.message ?? e} (tried again next run start)`)));
	}
	// what the framework turns on and off (once, a model reads it): switched-off app folders leave the plan like notApp
	// folders (accepted units there stay, reported); switched-on framework features become units
	if (o.client || o.spawn) {
		const dirs = getSourceAdapter(config.source.stack).frameworkDirs?.(config.source.path) ?? [];
		const got = await healSwitches({ config, root: o.root, ledger, client: o.client, spawn: o.spawn, frameworkDirs: dirs, log: (l) => o.log(pc.dim(l)) }).catch((e) => (o.log(pc.yellow(`switched-off parts not read: ${e?.message ?? e}`)), undefined));
		if (got && (got.switches.off.length || got.switches.features.length)) ledger.setMeta(SWITCHES_PENDING, "1");
	}
	if (ledger.getMeta(SWITCHES_PENDING) === "1") {
		const off = switchedOff(o.root, ledger);
		const source = getSourceAdapter(config.source.stack);
		const outside = (u: { meta: string }) => {
			const files = (JSON.parse(u.meta).files ?? []) as string[];
			return files.length > 0 && files.every((f) => leftOut(f, off, (p) => !!source.isEntryPoint?.(p)));
		};
		const units = ledger.listUnits().filter((u) => u.state !== "planned" && !isDbUnitKind(u.kind) && outside(u));
		const started = units.filter((u) => u.state !== "accepted").map((u) => u.id);
		if (started.length) await requeueUnits(ledger, config, o.root, started, "run start: the app switches their code off");
		const gone = await inventoryAgain(o, "withdrawn: the app switches the unit's code off");
		o.log(pc.cyan(`↻ switched-off app code: ${off.map((f) => f.path).join(", ") || "none"}; ${gone.size} unit(s) left the plan (br why <unit> says why)`));
		const accepted = units.filter((u) => u.state === "accepted").map((u) => u.id);
		if (accepted.length) o.log(pc.yellow(`  ${accepted.length} accepted unit(s) hold code the app switches off: ${accepted.slice(0, 20).join(", ")}${accepted.length > 20 ? ", …" : ""} (left as they are)`));
		ledger.setMeta(SWITCHES_PENDING, "0");
	}
	// files the reachability walk dropped that no dead-code session looked at yet (a run onboarded before the check
	// existed, or files a later inventory dropped): checked now; the ones still running become units again
	if ((o.client || o.spawn) && uncheckedDead(ledger, o.root).length) {
		const r = await confirmDeadCode(config, o.root, ledger, o.client, { spawn: o.spawn, log: (l) => o.log(pc.dim(l)) }).catch((e) => (o.log(pc.yellow(`dead code not checked: ${e?.message ?? e}`)), undefined));
		if (r?.alive.length) {
			await inventoryAgain(o, "withdrawn: the unit was regrouped when dropped files came alive");
			o.log(pc.cyan(`↻ ${r.alive.length} dropped file(s) still run and are migrated again: ${r.alive.slice(0, 8).join(", ")}${r.alive.length > 8 ? ", …" : ""}`));
		}
	}
	// the database: schema change scripts newer than the schema inputs (once per inputs); accepted DB units built from
	// the older schema are flagged and the owner is asked once whether to redo them
	if (dbDetected(config)) {
		if (o.client || o.spawn) await findSchemaUpdates(config, o.root, { spawn: o.spawn, log: (l) => o.log(pc.dim(l)) }).catch((e) => o.log(pc.yellow(`schema updates not looked up: ${e?.message ?? e}`)));
		await redoForSchemaUpdates(o).catch((e) => o.log(pc.yellow(`schema updates not checked against done tables: ${e?.message ?? e}`)));
		refreshTablePlanReasons(ledger);
	}
	if (o.client) {
		const changed = await healWiringFiles(o.root, { client: o.client, model: config.models.escalate.id, dirOf: (id) => projectDir(config, id), log: (l) => o.log(pc.dim(l)) });
		const booted = await healBoot(o.root, { client: o.client, model: config.models.escalate.id, dirOf: (id) => projectDir(config, id), hasOwn: (id) => !!loadCommandOverrides(o.root, id).boot, log: (l) => o.log(pc.dim(l)) });
		const checks = await healCheckConfig(o.root, { client: o.client, model: config.models.escalate.id, dirOf: (id) => projectDir(config, id), log: (l) => o.log(pc.dim(l)) });
		const skips = await healSkipMarker(o.root, { client: o.client, model: config.models.escalate.id, log: (l) => o.log(pc.dim(l)) });
		for (const id of skips) ledger.setMeta(skipRecheckKey(id), "1");
		const fresh = await healMigrateFresh(o.root, {
			client: o.client,
			model: config.models.escalate.id,
			dirOf: (id) => projectDir(config, id),
			hasOwn: (id) => !!loadCommandOverrides(o.root, id).migrateFresh,
			// the setup model adds the tool and sets it as this workspace's command; code reads it from there
			writeTool: async (id, problem) => {
				await fixRunSetup({ config, root: o.root, adapter: await getTargetAdapter(id), projectDir: projectDir(config, id), problem, ledger });
				return !!loadCommandOverrides(o.root, id).migrateFresh;
			},
			log: (l) => o.log(pc.dim(l)),
		});
		if (changed.length || booted.length || checks.length || skips.length || fresh.length) registerGeneratedTargets(o.root);
		// a built-in stack that registers features by hand: the project's wiring files, found once by a model
		for (const id of config.target.stacks) {
			const adapter = await builtinTarget(id);
			if (adapter) await healBuiltinWiring(o.root, adapter, projectDir(config, id), { client: o.client, model: config.models.escalate.id, log: (l) => o.log(pc.dim(l)) });
		}
	}
	for (const id of config.target.stacks) {
		if (ledger.getMeta(skipRecheckKey(id)) !== "1") continue;
		const back = await reopenSkippedTests({ ledger, config, root: o.root, stackId: id });
		if (back.length) o.log(pc.yellow(`${back.length} accepted unit(s) of ${id} have tests that are skipped or left incomplete: back to planned (code kept) so the tester makes them run: ${back.slice(0, 20).join(", ")}${back.length > 20 ? ", …" : ""}`));
		ledger.setMeta(skipRecheckKey(id), "0");
	}
	await checkMigrationsOnMain({ ledger, config, root: o.root, log: o.log });
	await askEngineSemantics({ ledger, config, root: o.root, client: o.client, log: o.log });
}

/** Ledger meta: the stack's skip marker was just checked; its accepted units' tests are looked at once (kept across a stop). */
const skipRecheckKey = (stackId: string) => `skip_recheck:${stackId}`;

/**
 * Accepted units of the stack whose own ported tests skip a test or leave it incomplete (the stack's checked skip
 * marker): those tests never proved anything. Back to planned with their code kept; the gate then sends the tests to
 * the tester to make them run. Returns the unit ids.
 */
export async function reopenSkippedTests(o: { ledger: Ledger; config: Config; root: string; stackId: string; adapterOf?: typeof getTargetAdapter }): Promise<string[]> {
	let adapter;
	try {
		adapter = await (o.adapterOf ?? getTargetAdapter)(o.stackId);
	} catch {
		return [];
	}
	const dir = projectDir(o.config, o.stackId);
	const tests = o.ledger.db.prepare("SELECT DISTINCT ported_test_path p FROM truth_cases WHERE unit_id = ? AND ported_test_path IS NOT NULL");
	const out: string[] = [];
	for (const u of o.ledger.listUnits()) {
		if (u.state !== "accepted" || isDbUnitKind(u.kind) || placeUnit(o.config, u.meta, o.root).stackId !== o.stackId) continue;
		const skipping = (tests.all(u.id) as Array<{ p: string }>).map((r) => r.p).filter((f) => existsSync(join(dir, f)) && adapter.layout.skipMarker.test(readFileSync(join(dir, f), "utf8")));
		if (!skipping.length) continue;
		reopenUnit(o.ledger, u.id, `This unit's tests skip tests or leave them incomplete (${skipping.join(", ")}), so they never proved the behaviour. Its code stays on the branch: the tester makes those tests run against it, then the code is checked as usual.`, "its tests skip or leave tests incomplete: back for the tester");
		out.push(u.id);
	}
	return out;
}

/**
 * Every migration of main's project on an empty database (the stack's migrateFresh), at run start. Green: accepted
 * database work that never had this check gets it. Red: the accepted database work whose migration the error names
 * goes back to planned with its code kept and the error as its note (one fails until it is fixed, so each start
 * looks again). The rest of the run does not wait for it.
 */
export async function checkMigrationsOnMain(o: { ledger: Ledger; config: Config; root: string; log: (l: string) => void; run?: typeof run; adapterOf?: typeof getTargetAdapter }): Promise<void> {
	const exec = o.run ?? run;
	for (const id of o.config.target.stacks) {
		let c: { cmd: string; args: string[] } | undefined;
		const dir = projectDir(o.config, id);
		try {
			c = (await (o.adapterOf ?? getTargetAdapter)(id)).migrateFresh?.(dir);
		} catch {
			continue;
		}
		if (!c?.cmd || !existsSync(dir)) continue;
		const units = o.ledger.listUnits().filter((u) => u.state === "accepted" && isDbUnitKind(u.kind) && u.kind !== "db_data" && placeUnit(o.config, u.meta, o.root).stackId === id);
		if (!units.length) continue;
		const r = await exec(c.cmd, c.args, dir, 240_000);
		if (r.ok) {
			const judged = units.filter((u) => !o.ledger.hasEvidence(u.id, "migrate_ok"));
			for (const u of judged) o.ledger.addEvidence(u.id, "migrate_ok", { by: "run start", note: "every migration of main applied to an empty database" });
			if (judged.length) o.log(pc.dim(`${id}: every migration applies to an empty database; ${judged.length} accepted database unit(s) now have that check`));
			continue;
		}
		const owners = units.filter((u) => namesFileOf(o.ledger, u.id, r.output));
		for (const u of owners) reopenUnit(o.ledger, u.id, `The project's migrations fail on a new empty database, and the error names a migration of this unit. Fix it so every migration applies in order (a migration runs after every migration that creates a table it references; give it a later version when it must). The error:\n${r.output.slice(-3000)}`, "its migration fails on an empty database: back to fix it");
		const first = r.output.split("\n").find((l) => /error|fail|exception/i.test(l))?.trim().slice(0, 200) ?? "";
		o.log(pc.yellow(`${id}: the migrations fail on an empty database${first ? ` (${first})` : ""}; ${owners.length ? `back to planned: ${owners.map((u) => u.id).join(", ")}` : "the error names no accepted database unit's migration"}`));
	}
}

/**
 * Database work that ports tables to another engine meets behaviour the new engine cannot copy exactly (collation,
 * trailing spaces, case-insensitive enums, zero dates). How to treat it is asked once, for the whole project; the run
 * decides it itself from the owner's goals when it can (askViaModel), else the owner answers. Nothing waits on it:
 * until it is answered, such differences are written down and are not defects (engineSemantics).
 */
export async function askEngineSemantics(o: { ledger: Ledger; config: Config; root: string; client?: ModelClient; log: (l: string) => void }): Promise<void> {
	if (o.ledger.db.prepare("SELECT 1 FROM questions WHERE point = ? LIMIT 1").get(ENGINE_SEMANTICS)) return;
	const moves = o.ledger
		.listUnits()
		.filter((u) => u.kind === "db_schema" || u.kind === "db_design")
		.map((u) => JSON.parse(u.meta) as DbUnitMeta)
		.filter((m) => m.to && m.from?.some((f) => f !== m.to));
	if (!moves.length) return;
	const pairs = [...new Set(moves.map((m) => `${m.from.join(" + ")} → ${m.to}`))].join(", ");
	const r = await askViaModel(
		{ ledger: o.ledger, config: o.config, root: o.root, client: o.client },
		{
			point: ENGINE_SEMANTICS,
			facts: `The database tables move to another engine (${pairs}). Some legacy behaviour cannot be copied exactly there: collation rules (case-insensitive comparison, trailing spaces ignored in comparisons), case-insensitive enum values, zero dates, time zones. Without one rule for the whole project, the database reviewer judges each table on its own and has sent ports back again and again for these differences.`,
			options: ENGINE_SEMANTICS_OPTIONS.map((x) => ({ value: x.value, facts: x.label })),
			recommended: ENGINE_SEMANTICS_OPTIONS[0]!.value,
			guess: true,
			blocks: "none",
			askedBy: "orchestrator",
		},
	).catch((e) => (o.log(pc.yellow(`the database engine question could not be asked: ${e?.message ?? e}`)), undefined));
	if (r) o.log(pc.dim(r.decided ? `database behaviour the new engine cannot copy exactly: decided from your goals (${r.decided})` : `question #${r.id}: how database behaviour the new engine cannot copy exactly is treated (nothing waits on it)`));
}
