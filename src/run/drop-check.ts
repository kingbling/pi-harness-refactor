import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getTargetAdapter } from "../adapters/registry.ts";
import type { Config } from "../config.ts";
import { projectDir } from "../init/init.ts";
import { isDbUnitKind } from "../inventory/db.ts";
import type { Ledger } from "../ledger/db.ts";
import type { ModelClient } from "../models/types.ts";
import { PLAIN_LANGUAGE } from "../policy.ts";
import { exec } from "../proc.ts";
import { spawnLeaf } from "../sessions/spawn.ts";
import { findCapabilityTool, readFunctionTool, sourceSymbolBody, targetLookup, whoCalls } from "../sessions/tools.ts";
import { onlyComments } from "./gate.ts";
import { placementDir, placeUnit } from "./placement.ts";
import { reopenUnit } from "./recheck.ts";

/**
 * Accepted units checked again for what their gate did not see before:
 * - Drops. An implementer could prove real behaviour "dropped: not implemented" (or "deferred", "owner will do it"),
 *   and no reviewer saw the drops. To keep the cost down, one cheap text-only read of all drop reasons picks the
 *   drops that read like work not done; then, a few units per run, a model with the legacy and the target code
 *   judges those. A drop that is needed behaviour the target lacks opens its symbol again, and the unit goes back
 *   to planned with its code kept. Each unit once per DROP_CHECK_VERSION.
 * - Files with only comments (a "deferral" note, a test file with no test). The gate refuses them now; one an
 *   accepted unit added is still on main. Code finds them; the unit that added them goes back to planned.
 */

/** Bump when the drop check changes: every accepted unit with drops is looked at once more. */
export const DROP_CHECK_VERSION = 1;
/** Units whose suspect drops a model judges per run (each is a session with tools). */
export const DROP_CHECKS_PER_RUN = 20;
/** Drop reasons per text-only read. */
const READ_BATCH = 80;

type DropRow = { unit_id: string; src_symbol: string; why: string };
type DropMeta = { v: number; suspects?: string[]; judged?: boolean };

export type DropJudge = (o: { ledger: Ledger; config: Config; root: string; unitId: string; drops: DropRow[] }) => Promise<Array<{ symbol: string; needed: boolean; why: string }> | undefined>;

/** Picks the drops whose reasons read like work not done (text only, one call per batch). */
export async function suspectDrops(client: ModelClient, model: string, drops: DropRow[]): Promise<Set<string>> {
	const out = new Set<string>();
	for (let i = 0; i < drops.length; i += READ_BATCH) {
		const batch = drops.slice(i, i + READ_BATCH);
		const res = await client.chat({
			model,
			effort: "low",
			schema: { type: "object", additionalProperties: false, required: ["suspects"], properties: { suspects: { type: "array", items: { type: "string" } } } },
			messages: [
				{ role: "system", content: `In a code migration, an implementer marked legacy symbols "dropped" with a reason. A drop is right only when the new system does not need the code: it is dead, the target framework does it, or the owner decided it. List the symbols whose reason says or suggests the behaviour was simply not done: not implemented, not ported, deferred or left for later, left to another unit or to the owner, missing a contract or a dependency. Leave out the reasons that give a real cause the code is not needed.` },
				{ role: "user", content: batch.map((d) => `${d.src_symbol}: ${d.why.slice(0, 300)}`).join("\n") },
			],
		});
		for (const s of ((res.json ?? {}) as { suspects?: string[] }).suspects ?? []) if (batch.some((d) => d.src_symbol === s)) out.add(s);
	}
	return out;
}

/** A model with the legacy code and the target code judges each drop: needed behaviour the target lacks, or fine. */
export const judgeDropsWithModel = (spawn: typeof spawnLeaf = spawnLeaf): DropJudge => async (o) => {
	const unit = o.ledger.getUnit(o.unitId)!;
	const place = placeUnit(o.config, unit.meta, o.root);
	const adapter = await getTargetAdapter(place.stackId);
	const dir = projectDir(o.config, place.stackId);
	const deps = { ledger: o.ledger, config: o.config, unitId: o.unitId, root: o.root, targetProjectDir: dir, adapter, moduleDir: placementDir(adapter.layout, place) };
	let verdict: Array<{ symbol: string; needed: boolean; why: string }> | undefined;
	const tool = {
		name: "drop_verdict",
		label: "Drop verdict",
		description: "Your verdict, one entry per drop: needed = true when the legacy behaviour is used and the target code does not do it anywhere; false when the code is dead, the target framework does it, the owner decided it, or other target code already does it (say where).",
		parameters: Type.Object({ drops: Type.Array(Type.Object({ symbol: Type.String(), needed: Type.Boolean(), why: Type.String() })) }),
		execute: async (_id: string, p: { drops: Array<{ symbol: string; needed: boolean; why: string }> }) => {
			verdict = p.drops;
			return { content: [{ type: "text" as const, text: "verdict recorded; stop here" }], details: {} };
		},
	} as unknown as ToolDefinition;
	const session = await spawn({
		role: "review",
		cwd: dir,
		config: o.config,
		writeGlobs: [],
		customTools: [tool, sourceSymbolBody(deps), readFunctionTool(deps), whoCalls(deps), targetLookup(deps), findCapabilityTool(deps)],
		transcriptPath: join(o.root, ".bigrefactor", "sessions", `${o.unitId}.drops.jsonl`),
		systemPrompt: `Unit ${o.unitId} of a code migration was accepted with some legacy symbols marked "dropped". Check each drop below against the legacy code (source_symbol_body, read_function, who_calls) and the target code (target_lookup, find_capability, and the files of ${dir}): is it behaviour the app needs that the target does not do anywhere? Then call drop_verdict once, one entry per drop.\n\n${PLAIN_LANGUAGE}`,
	});
	try {
		await session.run(o.drops.map((d) => `- ${d.src_symbol}: ${d.why}`).join("\n"));
	} finally {
		session.dispose();
	}
	return verdict;
};

/**
 * The drop check (see above): reads every accepted unit's drop reasons not read for this version, then judges the
 * suspect drops of up to `cap` units. The units sent back to planned.
 */
export async function checkAcceptedDrops(o: { ledger: Ledger; config: Config; root: string; client?: ModelClient; judge?: DropJudge; cap?: number; stopped?: () => boolean; log: (l: string) => void }): Promise<string[]> {
	const { ledger } = o;
	const metaOf = (id: string) => ((JSON.parse(ledger.getUnit(id)!.meta) as { dropCheck?: DropMeta }).dropCheck ?? { v: 0 }) as DropMeta;
	const setMeta = (id: string, d: DropMeta) => ledger.updateUnit(id, { meta: { dropCheck: d } });
	const rows = (ledger.db.prepare("SELECT m.unit_id, m.src_symbol, m.why FROM moves m JOIN units u ON u.id = m.unit_id WHERE m.op = 'dropped' AND u.state = 'accepted' ORDER BY m.unit_id, m.src_symbol").all() as DropRow[]).filter((r) => !isDbUnitKind(ledger.getUnit(r.unit_id)!.kind));
	const byUnit = new Map<string, DropRow[]>();
	for (const r of rows) byUnit.set(r.unit_id, [...(byUnit.get(r.unit_id) ?? []), r]);
	// 1. read: the drops of units not read for this version
	const unread = [...byUnit.keys()].filter((id) => metaOf(id).v !== DROP_CHECK_VERSION);
	if (unread.length) {
		const drops = unread.flatMap((id) => byUnit.get(id)!);
		// no model client: every drop is a suspect (the judge's cap bounds the cost)
		const suspects = o.client ? await suspectDrops(o.client, o.config.models.implement.id, drops) : new Set(drops.map((d) => d.src_symbol));
		for (const id of unread) {
			const mine = byUnit.get(id)!.filter((d) => suspects.has(d.src_symbol)).map((d) => d.src_symbol);
			setMeta(id, mine.length ? { v: DROP_CHECK_VERSION, suspects: mine } : { v: DROP_CHECK_VERSION, judged: true });
		}
		o.log(pc.cyan(`drop check: ${drops.length} drop(s) of ${unread.length} accepted unit(s) read; ${suspects.size} read like work not done`));
	}
	// 2. judge: the units with suspect drops, most first, up to the cap
	const waiting = [...byUnit.keys()].filter((id) => metaOf(id).v === DROP_CHECK_VERSION && !metaOf(id).judged && metaOf(id).suspects?.length).sort((a, b) => metaOf(b).suspects!.length - metaOf(a).suspects!.length);
	const judge = o.judge ?? judgeDropsWithModel();
	const reopened: string[] = [];
	for (const id of waiting.slice(0, o.cap ?? DROP_CHECKS_PER_RUN)) {
		if (o.stopped?.()) break;
		const suspects = metaOf(id).suspects!;
		const drops = byUnit.get(id)!.filter((d) => suspects.includes(d.src_symbol));
		const verdict = await judge({ ledger, config: o.config, root: o.root, unitId: id, drops }).catch((e) => (o.log(pc.yellow(`drop check ${id}: not judged (${e?.message ?? e})`)), undefined));
		// no verdict: judged again next run
		if (!verdict) continue;
		setMeta(id, { v: DROP_CHECK_VERSION, judged: true });
		const needed = verdict.filter((v) => v.needed && drops.some((d) => d.src_symbol === v.symbol));
		if (!needed.length || ledger.getUnit(id)?.state !== "accepted") continue;
		// those symbols open again: their move goes, so the implementer proves them anew
		for (const n of needed) {
			ledger.db.prepare("DELETE FROM moves WHERE unit_id = ? AND src_symbol = ?").run(id, n.symbol);
			ledger.transitionSymbol(n.symbol, "in_progress", "drop check: needed behaviour");
			ledger.transitionSymbol(n.symbol, "clustered", "drop check: needed behaviour");
		}
		reopenUnit(ledger, id, `This unit was accepted before, and its code stays on the branch. A later check found legacy behaviour it marked dropped that the app needs and the target does not do. Port it (or prove it merged_into the code that does it), keep what works:\n${needed.map((n) => `- ${n.symbol}: ${n.why}`).join("\n")}`, `drop check: ${needed.length} dropped symbol(s) are needed behaviour`);
		reopened.push(id);
		o.log(pc.yellow(`↺ ${id}: back to planned (code kept) — ${needed.length} drop(s) are needed behaviour`));
	}
	if (waiting.length) o.log(pc.cyan(`drop check: ${Math.min(waiting.length, o.cap ?? DROP_CHECKS_PER_RUN)} unit(s) judged, ${reopened.length} back to planned${waiting.length > (o.cap ?? DROP_CHECKS_PER_RUN) ? `, ${waiting.length - (o.cap ?? DROP_CHECKS_PER_RUN)} left for the next runs` : ""}`));
	return reopened;
}

/** Per run start: units back to planned at most, so a big find does not empty the accepted list at once. */
export const COMMENT_ONLY_PER_RUN = 20;

/**
 * Accepted units that added a source file with only comments, still on main: back to planned with their code kept,
 * told which file. The unit is found by the commit that added the file ("bigrefactor: unit <id>"). The units sent back.
 */
export async function reopenCommentOnly(o: { ledger: Ledger; config: Config; log: (l: string) => void; cap?: number }): Promise<string[]> {
	const files = new Map<string, string[]>();
	for (const stackId of o.config.target.stacks) {
		const dir = projectDir(o.config, stackId);
		const adapter = await getTargetAdapter(stackId).catch(() => undefined);
		if (!adapter || !existsSync(dir)) continue;
		let tracked: string[];
		try {
			tracked = (await exec("git", ["ls-files"], { cwd: dir, maxBuffer: 64 * 1024 * 1024 })).split("\n").filter((f) => f && adapter.layout.sourceExtensions.some((e) => f.endsWith(e)));
		} catch {
			continue; // not a repo yet
		}
		for (const f of tracked) {
			if (!existsSync(join(dir, f)) || !onlyComments(readFileSync(join(dir, f), "utf8"))) continue;
			const log = await exec("git", ["log", "--diff-filter=A", "--format=%B", "--", f], { cwd: dir }).catch(() => "");
			const unit = /bigrefactor: unit ([^\s,]+)/.exec(log)?.[1];
			if (unit && o.ledger.getUnit(unit)?.state === "accepted") files.set(unit, [...(files.get(unit) ?? []), f]);
		}
	}
	const units = [...files.keys()].slice(0, o.cap ?? COMMENT_ONLY_PER_RUN);
	for (const id of units) {
		const fs = files.get(id)!;
		// the gate checks those files on its next pass, and the unit may edit or remove them (like stubs left for it)
		const stubFiles = (JSON.parse(o.ledger.getUnit(id)!.meta) as { stubFiles?: string[] }).stubFiles ?? [];
		o.ledger.updateUnit(id, { meta: { commentOnly: fs, stubFiles: [...new Set([...stubFiles, ...fs])] } });
		reopenUnit(o.ledger, id, `This unit was accepted before, and its code stays on the branch. It added files that hold only comments, no code: ${fs.join(", ")}. Write the code they stand for (a test file: the tests), or remove them when the code lives elsewhere.`, `files with only comments: ${fs.slice(0, 3).join(", ")}`);
		o.log(pc.yellow(`↺ ${id}: back to planned (code kept) — files with only comments: ${fs.slice(0, 3).join(", ")}`));
	}
	return units;
}
