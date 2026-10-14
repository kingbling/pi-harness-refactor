import pc from "picocolors";
import { getSourceAdapter, registerGeneratedTargets } from "../adapters/registry.ts";
import { healCheckConfig, healWiringFiles } from "../adapters/target/generated.ts";
import type { Config } from "../config.ts";
import { projectDir } from "../init/init.ts";
import { isDbUnitKind } from "../inventory/db.ts";
import { healNotApp, leftOut, loadNotApp } from "../inventory/not-app.ts";
import { inventory } from "../inventory/run.ts";
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
 * - A generated adapter without checkConfigGlobs (the files that decide how the checks run): one question to the
 *   model (healCheckConfig); code jobs may change the other protected files from then on.
 */
const NOT_APP_PENDING = "not_app_heal_pending";

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
		// open questions per unit, read now: a unit the inventory deletes loses the link (unit_id is set to null)
		const open = ledger.db.prepare("SELECT id, unit_id FROM questions WHERE unit_id IS NOT NULL AND status = 'open'").all() as Array<{ id: number; unit_id: string }>;
		const before = new Set(ledger.listUnits().map((u) => u.id));
		await inventory(config, o.root, ledger);
		const gone = new Set([...before].filter((id) => !ledger.getUnit(id)));
		// questions about units that are gone have nothing left to decide
		const q = ledger.db.prepare("UPDATE questions SET status = 'withdrawn', answer = COALESCE(answer || ' — ', '') || ?, answered_at = COALESCE(answered_at, datetime('now')) WHERE id = ? AND status = 'open'");
		for (const r of open) if (gone.has(r.unit_id)) q.run("withdrawn: the unit's files are not app code", r.id);
		o.log(pc.cyan(`  ${gone.size} unit(s) dropped from the plan: their files are not app code`));
		const accepted = units.filter((u) => u.state === "accepted").map((u) => u.id);
		if (accepted.length) o.log(pc.yellow(`  ${accepted.length} accepted unit(s) hold code that is not the app's: ${accepted.slice(0, 20).join(", ")}${accepted.length > 20 ? ", …" : ""} (left as they are)`));
		ledger.setMeta(NOT_APP_PENDING, "0");
	}
	if (o.client) {
		const changed = await healWiringFiles(o.root, { client: o.client, model: config.models.escalate.id, dirOf: (id) => projectDir(config, id), log: (l) => o.log(pc.dim(l)) });
		const checks = await healCheckConfig(o.root, { client: o.client, model: config.models.escalate.id, dirOf: (id) => projectDir(config, id), log: (l) => o.log(pc.dim(l)) });
		if (changed.length || checks.length) registerGeneratedTargets(o.root);
	}
}
