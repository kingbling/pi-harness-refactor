import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getSourceAdapter } from "../adapters/registry.ts";
import type { Config } from "../config.ts";
import { decide } from "../jev/decide.ts";
import { JEV_ACT as ACT, ROUTE_UNIT, unitDifficulty, type Battery } from "../jev/questions.ts";
import type { Ledger } from "../ledger/db.ts";
import type { ModelClient } from "../models/types.ts";
import { functionsInFiles } from "../inventory/codemap.ts";
import { authWord, planSlices, type SliceOverrides } from "../inventory/slices.ts";
import { resolvePlacements } from "../run/placement.ts";

/**
 * `br label` (onboarding step): Jev judges what the inventory can only guess.
 *  1. every planned unit: needs_db, has_ui, external_io, branching (ROUTE_UNIT) plus code facts → difficulty
 *     → `meta.route`. The scheduler starts a unit on the escalate model when it rates Hard with confidence.
 *  2. feature slices: which one is login/authentication (it goes first) → `slices.json → advised.auth`; an unsure
 *     answer is not stored, so it is asked again on the next `br label`.
 *  3. units no entry point reaches (`dynamic` slice): which feature uses them (all slices offered, with how many
 *     files of each name the unit) → `advised.units`.
 *  4. placement: every planned unit's target stack + legacy area (code, Jev where code is unsure, else a question).
 * Advice never overrides a human: explicit `overrides` in slices.json win. Every call lands in the
 * decisions table for calibration. Cheap: Jev ≈ $0.00004 per call.
 */
/** Literal, language-agnostic text signal (code fact, certain): SQL keywords in strings. Global state is the adapter's. */
const SQL_TEXT = /["'`]\s*(SELECT\s.+\sFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i;
const LEVELS = ["mechanical", "moderate", "hard"] as const;
/** Size of the code Jev sees per unit. */
const EXCERPT_CHARS = 2400;

/**
 * What Jev reads about a unit: the code map first (every function's signature, grouped by class, with its
 * first doc line), so a long file is seen whole; the room left goes to the start of the file text,
 * which is all a file without functions (a template) has. Capped at EXCERPT_CHARS.
 */
export function codeMapExcerpt(ledger: Ledger, sourceRoot: string, files: string[], max = EXCERPT_CHARS): string {
	const fns = functionsInFiles(ledger, files);
	const map: string[] = [];
	for (const f of files) {
		const own = fns.filter((x) => x.path === f);
		if (!own.length) continue;
		map.push(`// ${f}: ${own.length} function${own.length === 1 ? "" : "s"}`);
		let container: string | null | undefined;
		for (const x of own) {
			if (x.container !== container) {
				container = x.container;
				if (container) map.push(`${container}:`);
			}
			const doc = (JSON.parse(x.comments) as Array<{ kind: string; body: string }>).find((c) => c.kind === "doc");
			const note = doc?.body.split("\n")[0]!.slice(0, 100) ?? "";
			map.push(`${container ? "  " : ""}${(x.signature ?? `${x.name}()`).replace(/\s+/g, " ").trim()}${note ? `  // ${note}` : ""}`);
		}
	}
	let out = map.length ? `${map.join("\n")}\n`.slice(0, max) : "";
	for (const f of files) {
		if (out.length >= max - 80) break;
		try {
			out += `// ${f} (start)\n${readFileSync(join(sourceRoot, f), "utf8").slice(0, max - out.length)}\n`;
		} catch {
			/* unreadable: path only */
		}
	}
	return out;
}

/** The unit's functions call (code map, resolved) functions in files that run indexed queries. */
export function callsDataAccess(ledger: Ledger, files: string[]): boolean {
	if (!files.length) return false;
	const marks = files.map(() => "?").join(",");
	const row = ledger.db
		.prepare(
			`SELECT 1 FROM code_calls c JOIN code_functions f ON f.id = c.from_id JOIN code_functions t ON t.id = c.to_id
			 WHERE f.path IN (${marks}) AND c.resolution = 'code' AND t.path NOT IN (${marks})
			   AND EXISTS (SELECT 1 FROM index_queries q WHERE q.symbol_id = t.id OR q.symbol_id = t.path) LIMIT 1`,
		)
		.get(...files, ...files);
	return !!row;
}

/** Per feature slice, how many of its files mention one of `names` (a file name or a class name). A code fact for Jev. */
function mentionCounts(sourceRoot: string, filesBySlice: Map<string, string[]>, names: Map<string, string[]>): Map<string, Record<string, number>> {
	const out = new Map<string, Record<string, number>>();
	const all = [...new Set([...names.values()].flat())].filter((n) => n.length >= 3);
	if (!all.length) return out;
	const re = new RegExp(`\\b(${all.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "g");
	const unitsOf = new Map<string, string[]>();
	for (const [id, ns] of names) for (const n of ns) (unitsOf.get(n) ?? unitsOf.set(n, []).get(n)!).push(id);
	for (const [slice, files] of filesBySlice)
		for (const f of files) {
			let text: string;
			try {
				text = readFileSync(join(sourceRoot, f), "utf8");
			} catch {
				continue;
			}
			const hit = new Set<string>();
			for (const m of text.match(re) ?? []) for (const id of unitsOf.get(m) ?? []) hit.add(id);
			for (const id of hit) {
				const c = out.get(id) ?? out.set(id, {}).get(id)!;
				c[slice] = (c[slice] ?? 0) + 1;
			}
		}
	return out;
}

export async function labelUnits(config: Config, root: string, ledger: Ledger, client: ModelClient, opts: { concurrency?: number; log?: (l: string) => void; onProgress?: (detail: string) => void } = {}): Promise<{ units: number; hard: number; auth: string[]; placed: number; areas: { placed: number; asked: number }; costUsd: number }> {
	const log = opts.log ?? console.log;
	const model = config.models.decide.id;
	let cost = 0;
	const units = ledger.listUnits({ state: "planned" }).filter((u) => !JSON.parse(u.meta).route);
	const excerpt = (files: string[]) => codeMapExcerpt(ledger, config.source.path, files);
	const globalState = getSourceAdapter(config.source.stack).traits?.globalState;
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
				const r = await decide({ client, ledger, model }, "label_unit", state, ROUTE_UNIT, Object.keys(ROUTE_UNIT), u.id);
				cost += r.costUsd;
				const a = r.answers;
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
				for (const k of ["dynamic_refs", "raw_sql"]) confidence[k] = 1;
				// the code map proves database use when the unit queries, or calls code that does
				if (facts["raw_sql"] || callsDataAccess(ledger, meta.files)) [facts["needs_db"], confidence["needs_db"]] = [1, 1];
				// only the language knows what global state looks like; a match is certain, no match leaves Jev's judgement
				if (globalState?.test(src)) [facts["global_state"], confidence["global_state"]] = [1, 1];
				const diff = unitDifficulty(facts, { loc: meta.loc, deps: JSON.parse(u.deps).length, cutDeps: (meta.cutDeps ?? []).length });
				const route = { difficulty: diff.level, difficultyFactors: diff.factors, difficultyConfidence: diff.confidence, ...facts, confidence, decision: r.decisionId };
				if (route.difficulty === "hard" && route.difficultyConfidence >= ACT) hard++;
				if (++done % 25 === 0 || done === units.length) opts.onProgress?.(`${done}/${units.length} units rated, ${hard} hard`);
				ledger.updateUnit(u.id, { meta: { route } });
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
	const key = (n: string) => n.replace(/[^A-Za-z0-9_]/g, "_");
	let auth: string[] = advised.auth ?? [];
	if (features.length && !advised.auth) {
		// one choice among all slices: a yes/no per slice let the least sure slice sink the whole answer.
		// A name match is one fact for Jev (it also hits `authors`, `sessions` of a training app); Jev decides
		const fact = (s: (typeof features)[number]) => { const w = authWord(s.name, s.entryPoints); return w ? `; its name or an entry point contains "${w}" (a word match only, not a verdict)` : ""; };
		const criteria: Record<string, string | null> = { ...Object.fromEntries(features.map((s) => [key(s.name), `feature "${s.name}" (entry points: ${s.entryPoints.slice(0, 12).join(", ")})${fact(s)}`])), none: "no slice is about login or authentication" };
		const battery: Battery = { auth: { type: "choice", instructions: "Which feature slice is the login / authentication / session one, that other features depend on?", criteria } };
		const r = await decide({ client, ledger, model, second: config.models.escalate.id }, "label_auth", { app: config.source.framework ?? config.source.stack }, battery, ["auth"]);
		cost += r.costUsd;
		const a = r.answers["auth"];
		// only a sure answer is stored; an unsure one stays undecided (the name match stands in) and is asked again next time
		if (a?.type === "choice" && a.confidence >= ACT) {
			auth = a.choice === "none" ? [] : features.filter((s) => key(s.name) === a.choice).map((s) => s.name);
			advised.auth = auth;
		}
	}
	const dyn = plan.slices.find((s) => s.name === "dynamic")?.units ?? [];
	const placedBefore = Object.keys(advised.units ?? {}).length;
	const targets = features.map((s) => s.name);
	let byCode = 0;
	if (dyn.length && targets.length) {
		// evidence from the index: which slice the unit's folder neighbours (same dir, then parent dir) belong to
		const sliceOf = new Map<string, string>();
		for (const sl of plan.slices) if (sl.name !== "dynamic") for (const id of sl.units) sliceOf.set(id, sl.name);
		const dirUnits = new Map<string, string[]>();
		const fileOfUnit = new Map<string, string>();
		const filesOfUnit = new Map<string, string[]>();
		for (const u of ledger.listUnits()) {
			filesOfUnit.set(u.id, JSON.parse(u.meta).files ?? []);
			const f = filesOfUnit.get(u.id)![0];
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
		// evidence from the code: per slice, how many of its files name this unit's file or classes (who uses it)
		const filesBySlice = new Map(plan.slices.filter((sl) => sl.kind !== "dynamic").map((sl) => [sl.name, sl.units.flatMap((id) => filesOfUnit.get(id) ?? [])]));
		const classes = ledger.db.prepare("SELECT DISTINCT name FROM symbols WHERE unit_id = ? AND kind IN ('class','interface','trait')");
		const names = new Map(units2.map((id) => [id, [...(filesOfUnit.get(id) ?? []).flatMap((f) => [basename(f), `${basename(dirname(f))}/${basename(f).split(".")[0]}`]), ...(classes.all(id) as Array<{ name: string }>).map((c) => c.name)]]));
		const usedBy = mentionCounts(config.source.path, filesBySlice, names);
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
				// 2. Jev with the evidence, choosing among every feature slice (the folder alone often misses the right one)
				const criteria: Record<string, string | null> = { ...Object.fromEntries(features.map((sl) => [key(sl.name), `feature "${sl.name}" (entry points: ${sl.entryPoints.slice(0, 6).join(", ")})`])), foundation: "shared code several features use", other: null };
				const battery: Battery = { slice: { type: "choice", instructions: "No route reaches the code in `summary`. `usedBy` counts, per slice, the files that name this file or its classes; `neighbours` lists which slice the other files in its folder belong to. Which feature uses this code, so it should be migrated with it? Pick foundation when several features use it.", criteria } };
				try {
					const r = await decide({ client, ledger, model, second: config.models.escalate.id }, "label_slice", { summary: excerpt(meta.files), path: meta.files[0], usedBy: usedBy.get(id) ?? {}, neighbours: { folder: v.dir, slices: Object.fromEntries(v.tally) } }, battery, ["slice"], id);
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
	if (features.length) log(`  slices: auth = ${advised.auth ? auth.join(", ") || "none" : "undecided (Jev unsure; asked again next br label)"}; ${placed}/${dyn.length} unreached units placed (${byCode} by folder neighbours, ${placed - byCode} by Jev)`);
	// after the labels: Jev's has_ui decides the surface where the source adapter cannot tell
	const areas = await resolvePlacements({ ledger, config, root, client, log, concurrency: opts.concurrency, curate: true });
	cost += areas.costUsd;
	return { units: units.length, hard, auth, placed, areas: { placed: areas.placed, asked: areas.asked }, costUsd: cost };
}
