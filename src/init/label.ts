import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../config.ts";
import { decide } from "../jev/decide.ts";
import { ROUTE_UNIT, unitDifficulty, type Battery } from "../jev/questions.ts";
import type { Ledger } from "../ledger/db.ts";
import type { ModelClient } from "../models/types.ts";
import { planSlices, type SliceOverrides } from "../inventory/slices.ts";

/**
 * `br label` (onboarding step): Jev judges what the inventory can only guess.
 *  1. every planned unit: difficulty, kind, needs_db, has_ui, dynamic_refs (ROUTE_UNIT) → `meta.route`.
 *     The scheduler starts a unit on the escalate model when Jev rates it Hard with confidence; kind
 *     replaces the adapter's path heuristic when Jev is confident.
 *  2. feature slices: which ones are authentication/session (they go first) → `slices.json → advised.auth`.
 *  3. units no entry point reaches (`dynamic` slice): which feature they belong to → `advised.units`.
 * Advice never overrides a human: explicit `overrides` in slices.json win. Every call lands in the
 * decisions table for calibration. Cheap: Jev ≈ $0.00004 per call.
 */
const ACT = 0.75;
/** Literal, language-agnostic text signals (code facts, certain): SQL keywords in strings, superglobals/globals. */
const SQL_TEXT = /["'`]\s*(SELECT\s.+\sFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i;
const GLOBAL_TEXT = /\$_SESSION|\$_COOKIE|\$GLOBALS|^\s*global\s+\$|\bsession_(start|id|destroy)\(/m;
const LEVELS = ["mechanical", "moderate", "hard"] as const;

export async function labelUnits(config: Config, root: string, ledger: Ledger, client: ModelClient, opts: { concurrency?: number; log?: (l: string) => void; onProgress?: (detail: string) => void } = {}): Promise<{ units: number; hard: number; auth: string[]; placed: number; costUsd: number }> {
	const log = opts.log ?? console.log;
	const model = config.models.decide.id;
	let cost = 0;
	const units = ledger.listUnits({ state: "planned" }).filter((u) => !JSON.parse(u.meta).route);
	const excerpt = (files: string[]) => {
		let out = "";
		for (const f of files) {
			if (out.length > 2400) break;
			try {
				out += `// ${f}\n${readFileSync(join(config.source.path, f), "utf8").slice(0, 2400 - out.length)}\n`;
			} catch {
				/* unreadable: path only */
			}
		}
		return out;
	};
	const readSources = (files: string[]) => files.map((f) => { try { return readFileSync(join(config.source.path, f), "utf8"); } catch { return ""; } }).join("\n");
	let hard = 0;
	let next = 0;
	let done = 0;
	const worker = async () => {
		for (;;) {
			const u = units[next++];
			if (!u) return;
			const meta = JSON.parse(u.meta) as { files: string[]; loc: number; queries: number; dynamic_markers?: unknown[]; cutDeps?: string[] };
			const state = { summary: excerpt(meta.files), path: meta.files[0] };
			try {
				const r = await decide({ client, ledger, model }, "label_unit", state, ROUTE_UNIT, ["kind"], u.id);
				cost += r.costUsd;
				const a = r.answers;
				const kind = a["kind"]?.type === "choice" ? a["kind"] : undefined;
				const facts: Record<string, number | undefined> = {};
				const confidence: Record<string, number> = {};
				for (const [k, v] of Object.entries(a)) {
					if (v.type === "noul") {
						facts[k] = Math.round(v.noul * 100) / 100;
						confidence[k] = Math.round(Math.abs(v.noul - 0.5) * 200) / 100;
					} else if (v.type === "choice") confidence[k] = Math.round(v.confidence * 100) / 100;
				}
				// facts code knows for certain: the indexer's dynamic markers and queries, plus a literal text match
				const src = readSources(meta.files);
				facts["dynamic_refs"] = (meta.dynamic_markers ?? []).length > 0 ? 1 : 0;
				facts["raw_sql"] = meta.queries > 0 || SQL_TEXT.test(src) ? 1 : 0;
				facts["global_state"] = GLOBAL_TEXT.test(src) ? 1 : 0;
				for (const k of ["dynamic_refs", "raw_sql", "global_state"]) confidence[k] = 1;
				const diff = unitDifficulty(facts, { loc: meta.loc, deps: JSON.parse(u.deps).length, cutDeps: (meta.cutDeps ?? []).length });
				const route = { difficulty: diff.level, difficultyFactors: diff.factors, difficultyConfidence: diff.confidence, kind: kind?.choice, kindConfidence: kind?.confidence, ...facts, confidence, decision: r.decisionId };
				if (route.difficulty === "hard" && route.difficultyConfidence >= ACT) hard++;
				if (++done % 25 === 0 || done === units.length) opts.onProgress?.(`${done}/${units.length} units rated, ${hard} hard`);
				ledger.updateUnit(u.id, { meta: { route }, ...(kind && kind.choice !== "other" && kind.confidence >= ACT ? { kind: kind.choice } : {}) });
			} catch (e) {
				log(`  label ${u.id}: ${(e as Error).message.split("\n")[0]}`);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 16) }, worker));
	if (units.length) log(`  labelled ${units.length} units via Jev (${hard} hard → start on the escalate model), $${cost.toFixed(4)}`);

	// ---- slices: auth features + placement of unreached units
	const p = join(root, ".bigrefactor", "slices.json");
	const ov = (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {}) as SliceOverrides;
	const plan = planSlices(ledger, ov);
	const features = plan.slices.filter((s) => s.kind === "feature" || s.kind === "auth");
	const advised = (ov.advised ??= {});
	let auth: string[] = advised.auth ?? [];
	if (features.length && !advised.auth) {
		const battery: Battery = Object.fromEntries(features.map((s) => [s.name.replace(/[^A-Za-z0-9_]/g, "_"), { type: "noul", instructions: `Is the feature slice "${s.name}" (entry points: ${s.entryPoints.slice(0, 12).join(", ")}) about authentication, login, sessions or user identity, so that other features depend on it?` }]));
		const r = await decide({ client, ledger, model }, "label_auth", { app: config.source.framework ?? config.source.stack }, battery, Object.keys(battery));
		cost += r.costUsd;
		auth = features.filter((s) => { const a = r.answers[s.name.replace(/[^A-Za-z0-9_]/g, "_")]; return a?.type === "noul" && a.noul >= ACT; }).map((s) => s.name);
		advised.auth = auth;
	}
	const dyn = plan.slices.find((s) => s.name === "dynamic")?.units ?? [];
	const placedBefore = Object.keys(advised.units ?? {}).length;
	const targets = features.map((s) => s.name);
	let byCode = 0;
	if (dyn.length && targets.length) {
		const key = (n: string) => n.replace(/[^A-Za-z0-9_]/g, "_");
		// evidence from the index: which slice the unit's folder neighbours (same dir, then parent dir) belong to
		const sliceOf = new Map<string, string>();
		for (const sl of plan.slices) if (sl.name !== "dynamic") for (const id of sl.units) sliceOf.set(id, sl.name);
		const dirUnits = new Map<string, string[]>();
		const fileOfUnit = new Map<string, string>();
		for (const u of ledger.listUnits()) {
			const f = (JSON.parse(u.meta).files ?? [])[0] as string | undefined;
			if (!f) continue;
			fileOfUnit.set(u.id, f);
			for (const d of [dirname(f), dirname(dirname(f))]) (dirUnits.get(d) ?? dirUnits.set(d, []).get(d)!).push(u.id);
		}
		const votes = (id: string) => {
			const f = fileOfUnit.get(id);
			if (!f) return { dir: "", tally: [] as Array<[string, number]> };
			for (const d of [dirname(f), dirname(dirname(f))]) {
				const t: Record<string, number> = {};
				for (const n of dirUnits.get(d) ?? []) {
					const sl = n !== id ? sliceOf.get(n) : undefined;
					if (sl) t[sl] = (t[sl] ?? 0) + 1;
				}
				const tally = Object.entries(t).sort((a, b) => b[1] - a[1]);
				if (tally.length) return { dir: d, tally };
			}
			return { dir: "", tally: [] as Array<[string, number]> };
		};
		const units2 = dyn.filter((id) => !(advised.units ?? {})[id] && !(ov.overrides ?? {})[id]);
		let i = 0;
		const work = async () => {
			for (;;) {
				const id = units2[i++];
				if (!id) return;
				const u = ledger.getUnit(id);
				if (!u) continue;
				const meta = JSON.parse(u.meta) as { files: string[] };
				const v = votes(id);
				const total = v.tally.reduce((a, [, n]) => a + n, 0);
				// 1. code: the folder's units agree (≥ 3 votes, ≥ 80% one slice) → same slice, no model call
				if (total >= 3 && v.tally[0]![1] / total >= 0.8) {
					(advised.units ??= {})[id] = v.tally[0]![0];
					byCode++;
					continue;
				}
				// 2. Jev with the evidence, choosing only among plausible slices (neighbours' + foundation), else all
				const plausible = v.tally.length ? features.filter((sl) => v.tally.some(([n]) => n === sl.name)) : features;
				const criteria: Record<string, string | null> = { ...Object.fromEntries(plausible.map((sl) => [key(sl.name), `feature "${sl.name}" (entry points: ${sl.entryPoints.slice(0, 6).join(", ")})`])), foundation: "shared code many features use", other: null };
				const battery: Battery = { slice: { type: "choice", instructions: "No route reaches the code in `summary`. `neighbours` lists which feature the other files in its folder belong to. Which feature slice should it be migrated with?", criteria } };
				try {
					const r = await decide({ client, ledger, model }, "label_slice", { summary: excerpt(meta.files), path: meta.files[0], neighbours: { folder: v.dir, slices: Object.fromEntries(v.tally) } }, battery, ["slice"], id);
					cost += r.costUsd;
					const a = r.answers["slice"];
					if (a?.type === "choice" && a.choice !== "other" && a.confidence >= ACT) {
						const name = a.choice === "foundation" ? "foundation" : features.find((sl) => key(sl.name) === a.choice)?.name;
						if (name) (advised.units ??= {})[id] = name;
					}
				} catch {
					/* stays dynamic */
				}
			}
		};
		await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 16) }, work));
	}
	writeFileSync(p, JSON.stringify(ov, null, 2) + "\n");
	const placed = Object.keys(advised.units ?? {}).length - placedBefore;
	if (features.length) log(`  slices: auth = ${auth.join(", ") || "none"}; ${placed}/${dyn.length} unreached units placed (${byCode} by folder neighbours, ${placed - byCode} by Jev)`);
	return { units: units.length, hard, auth, placed, costUsd: cost };
}
