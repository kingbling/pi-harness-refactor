import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getSourceAdapter, TARGET_ROLES } from "../adapters/registry.ts";
import type { TargetLayout } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import { answerValue, askViaModel, type AskOption } from "../jev/ask.ts";
import { decide } from "../jev/decide.ts";
import { noulConfidence, type Battery } from "../jev/questions.ts";
import type { Ledger, UnitRow } from "../ledger/db.ts";
import type { ModelClient } from "../models/types.ts";
import { genericArea, kebab, SHARED_AREA } from "./areas.ts";
import { areasPath, curateAreas, syncTaxonomyAnswers, taxonomyHold } from "./taxonomy.ts";

/**
 * Where a unit lands in the target: which stack, which legacy area (one area = one feature module per stack),
 * and whether it is shared (cross-cutting, lives in the stack's shared dir). Pipeline (resolvePlacements):
 *
 *   code      the source adapter places each file (area + surface); the unit takes the majority.
 *             `.bigrefactor/placement.json` rules override per file: { "rules": [{ "prefix", "area"?, "stack"?, "shared"? }] },
 *             longest prefix wins.
 *   shared    a unit whose same-stack dependents span ≥ 2 other feature areas is shared (no question), unless its
 *             own area is a feature module (other units there): then the others import it from that module.
 *   model     code unsure (adapter has no answer, tied files, unknown surface) → Jev picks among candidate areas.
 *   ask       Jev below ACT → one ledger question (phrased by askViaModel); only that unit waits. The answer is
 *             persisted on the unit and as a prefix rule so similar files are not asked again.
 *
 * Results are persisted in unit `meta.place`; placeUnit reads them first.
 */
export type PlaceSource = "override" | "code" | "model" | "answer" | "taxonomy";
export interface Placement {
	stackId: string;
	area: string;
	/** `${stackId}:${area}`: the scheduler runs one unit per key at a time. */
	moduleKey: string;
	shared: boolean;
	source: PlaceSource;
}
interface StoredPlace {
	stack: string;
	area: string;
	shared: boolean;
	source: PlaceSource;
	confidence?: number;
	decision?: number;
}
interface PlacementRule {
	prefix: string;
	area?: string;
	stack?: string;
	shared?: boolean;
}
type UnitMeta = { files?: string[]; route?: { has_ui?: number }; place?: StoredPlace; placeQuestion?: number };

const ACT = 0.75;
const POINT = "placement";

export function placeUnit(config: Config, metaJson: string, root?: string): Placement {
	const meta = JSON.parse(metaJson) as UnitMeta;
	const p = meta.place;
	if (p?.area && config.target.stacks.includes(p.stack)) return mk(p.stack, p.area, p.shared, p.source);
	return codePlace(config, meta, root).place;
}

/** Directory of a placement inside its project: the feature dir, or the shared dir + area. */
export function placementDir(layout: TargetLayout, p: Placement): string {
	if (!p.shared) return layout.moduleDir(p.area);
	if (!layout.sharedDirs[0]) throw new Error(`shared unit in area ${p.area}, but the target layout has no shared dir`);
	return `${layout.sharedDirs[0].replace(/\/?$/, "/")}${p.area}`;
}

/** Why a unit may not run yet: no persisted placement and code is unsure (the model/question step has not placed it). */
export function unplacedReason(config: Config, metaJson: string, root?: string): string | undefined {
	const hold = taxonomyHold(metaJson); // open area question or excluded by the owner: never runs on a guess
	if (hold) return hold;
	const meta = JSON.parse(metaJson) as UnitMeta;
	if (meta.place?.area && config.target.stacks.includes(meta.place.stack)) return undefined;
	return codePlace(config, meta, root).unsure;
}

/** A rule prefix covers a file only up to a name boundary: `a/list.` never matches `a/listing.x`, `a/sso` not `a/ssox`. */
function covers(prefix: string, f: string): boolean {
	if (!f.startsWith(prefix)) return false;
	return f.length === prefix.length || /[./]$/.test(prefix) || f[prefix.length] === "." || f[prefix.length] === "/";
}

const mk = (stackId: string, area: string, shared: boolean, source: PlaceSource): Placement => ({ stackId, area, moduleKey: `${stackId}:${area}`, shared, source });

/** Code's placement of a unit, and why code is unsure (undefined = sure). */
export function codePlace(config: Config, meta: UnitMeta, root?: string): { place: Placement; unsure?: string; surfaceKnown: boolean } {
	const source = getSourceAdapter(config.source.stack);
	const rules = loadRules(root);
	const labelled = labelSurface(meta.route);
	const files = meta.files?.length ? meta.files : [];
	const why: string[] = [];
	let fromRule = false;
	let shared = false;
	const votes = files.map((f) => {
		const rule = rules.filter((r) => covers(r.prefix, f)).sort((a, b) => b.prefix.length - a.prefix.length)[0];
		if (rule?.stack && !config.target.stacks.includes(rule.stack)) throw new Error(`placement.json: rule "${rule.prefix}" names stack "${rule.stack}", not one of ${config.target.stacks.join(", ")}`);
		const p = source.placeFile?.(f, config.source.path);
		if (rule) fromRule = true;
		if (rule?.shared) shared = true;
		if (!p?.area && !rule?.area) why.push(`no adapter area for ${f}`);
		const surface = p?.surface ?? labelled;
		return { area: kebab(rule?.area ?? p?.area ?? genericArea(f)) || SHARED_AREA, stack: rule?.stack ?? (surface ? stackFor(config, surface) : undefined) };
	});
	const area = majority(votes.map((v) => v.area));
	const stacks = votes.map((v) => v.stack).filter((s): s is string => !!s);
	const stack = majority(stacks);
	if (area.tied) why.push(`files split between areas ${area.tied.join(", ")}`);
	if (stack.tied) why.push(`files split between stacks ${stack.tied.join(", ")}`);
	if (!stacks.length && config.target.stacks.length > 1) why.push("surface unknown");
	const a = area.value ?? SHARED_AREA;
	return {
		place: mk(stack.value ?? stackFor(config, "server"), a, shared || a === SHARED_AREA, fromRule ? "override" : "code"),
		unsure: why.length ? why.join("; ") : undefined,
		surfaceKnown: stacks.length > 0 && !stack.tied,
	};
}

/** Jev's label as a surface when the adapter cannot tell: clear yes/no only. */
function labelSurface(route: UnitMeta["route"]): "server" | "ui" | undefined {
	const p = route?.has_ui;
	return p === undefined ? undefined : p >= 0.75 ? "ui" : p <= 0.25 ? "server" : undefined;
}

/** The stack owning a surface: ui → first "ui" stack, else the "server" stack, else the first. */
export function stackFor(config: Config, surface: "server" | "ui"): string {
	const s = config.target.stacks;
	const role = (id: string) => TARGET_ROLES[id] ?? "server";
	return s.find((id) => role(id) === surface) ?? s.find((id) => role(id) === "server") ?? s[0]!;
}

/** Most frequent value; `tied` lists the values sharing the top count when there is more than one. */
function majority(xs: string[]): { value?: string; tied?: string[] } {
	const n = new Map<string, number>();
	for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
	const top = Math.max(0, ...n.values());
	const best = [...n].filter(([, c]) => c === top).map(([x]) => x);
	return { value: best[0], tied: best.length > 1 ? best : undefined };
}

// ---- pipeline -------------------------------------------------------------------------------------------

export interface PlacementDeps {
	ledger: Ledger;
	config: Config;
	root: string;
	client?: ModelClient;
	log?: (l: string) => void;
	/** Recompute units that already have a placement (planned ones only). */
	force?: boolean;
	/** Curate the whole area set (escalate model, taxonomy.ts) between the code and the model pass: label / br place only. */
	curate?: boolean;
	concurrency?: number;
}

export interface Planned {
	place: Placement;
	/** Why code is unsure (→ model); undefined = sure. */
	unsure?: string;
	surfaceKnown: boolean;
	/** Taken from the unit's persisted placement. */
	stored: boolean;
}

/** Sources a forced re-placement keeps: decided by the owner or the curated area set, not recomputed by code. */
const KEPT = new Set<PlaceSource>(["answer", "taxonomy"]);

/** Code + shared placement of every unit (nothing written); persisted placements win (with force: answers + taxonomy). */
export function planPlacements(config: Config, units: Array<Pick<UnitRow, "id" | "meta" | "deps">>, root?: string, force = false): Map<string, Planned> {
	const out = new Map<string, Planned>();
	for (const u of units) {
		const meta = JSON.parse(u.meta) as UnitMeta;
		if (meta.place && (!force || KEPT.has(meta.place.source))) out.set(u.id, { place: placeUnit(config, u.meta, root), surfaceKnown: true, stored: true });
		else out.set(u.id, { ...codePlace(config, meta, root), stored: false });
	}
	// shared: dependents in the same stack span ≥ 2 feature areas other than the unit's own, and its own area is
	// no feature module (no other unit there). A feature's entity/service used elsewhere stays in its module and
	// is imported from there: one legacy area stays one module.
	const dependents = new Map<string, string[]>();
	for (const u of units) for (const d of JSON.parse(u.deps) as string[]) (dependents.get(d) ?? dependents.set(d, []).get(d)!).push(u.id);
	const size = new Map<string, number>();
	for (const p of out.values()) size.set(p.place.moduleKey, (size.get(p.place.moduleKey) ?? 0) + 1);
	for (const [id, p] of out) {
		if (p.stored || p.place.shared || (size.get(p.place.moduleKey) ?? 0) > 1) continue;
		const areas = new Set<string>();
		for (const d of dependents.get(id) ?? []) {
			const q = out.get(d)?.place;
			if (q && !q.shared && q.stackId === p.place.stackId && q.area !== p.place.area) areas.add(q.area);
		}
		if (areas.size >= 2) p.place = { ...p.place, shared: true };
	}
	return out;
}

/**
 * Places every planned unit that has no placement yet: code, shared, then Jev for units code is unsure about,
 * then a question for what Jev is unsure about. Applies answered placement questions first.
 */
export async function resolvePlacements(d: PlacementDeps): Promise<{ placed: number; byModel: number; asked: number; shared: number; costUsd: number }> {
	const log = d.log ?? (() => {});
	applyPlacementAnswers(d.ledger, d.config, d.root);
	syncTaxonomyAnswers({ ledger: d.ledger, root: d.root });
	const all = d.ledger.listUnits();
	const plan = planPlacements(d.config, all, d.root, d.force);
	const todo = all.filter((u) => {
		const m = JSON.parse(u.meta) as UnitMeta;
		return u.state === "planned" && !plan.get(u.id)!.stored && !openQuestion(d.ledger, m.placeQuestion) && !taxonomyHold(u.meta);
	});
	const res = { placed: 0, byModel: 0, asked: 0, shared: 0, costUsd: 0 };
	const save = (id: string, p: Placement, extra: Partial<StoredPlace> = {}) => {
		d.ledger.updateUnit(id, { meta: { place: { stack: p.stackId, area: p.area, shared: p.shared, source: p.source, ...extra } satisfies StoredPlace } });
		res.placed++;
		if (p.shared) res.shared++;
	};
	let unsure: UnitRow[] = [];
	for (const u of todo) {
		const p = plan.get(u.id)!;
		if (!p.unsure) save(u.id, p.place);
		else {
			unsure.push(u);
			if (d.force) d.ledger.updateUnit(u.id, { meta: { place: undefined } }); // a stale guess must not feed the taxonomy
		}
	}
	if (d.curate && d.client && todo.length) {
		// only when this pass placed something (re-runs stay free); the whole area set at once: business areas per stack; its rules may now place units code was unsure about
		const t = await curateAreas({ ledger: d.ledger, config: d.config, root: d.root, client: d.client }, { log });
		res.costUsd += t.costUsd;
		unsure = unsure.filter((u) => {
			const row = d.ledger.getUnit(u.id)!;
			if ((JSON.parse(row.meta) as UnitMeta).place || taxonomyHold(row.meta)) return false;
			const c = codePlace(d.config, JSON.parse(row.meta) as UnitMeta, d.root);
			if (c.unsure) return true;
			save(u.id, c.place);
			return false;
		});
	}
	const curatedBefore = curatedAreas(d.root);
	if (unsure.length) {
		// after curation: placements as they are now (curated areas), so candidates come from the curated set
		const ctx = candidateContext(d.config, d.root, d.ledger.listUnits(), planPlacements(d.config, d.ledger.listUnits(), d.root));
		let next = 0;
		// code unsure → Jev; Jev unsure, failing or absent → a question (only that unit waits, never a code guess)
		const work = async () => {
			for (let u = unsure[next++]; u; u = unsure[next++]) {
				const code = plan.get(u.id)!;
				try {
					const r = d.client ? await modelPlace(d, u, code, ctx).catch((e) => (log(`  place ${u.id}: Jev failed (${(e as Error).message.split("\n")[0]}); asking`), undefined)) : undefined;
					res.costUsd += r?.costUsd ?? 0;
					if (r?.place) (save(u.id, r.place, { confidence: r.confidence, decision: r.decision }), res.byModel++);
					else if (r) res.asked++;
					else (res.costUsd += await askPlacement(d, u, code, ctx), res.asked++);
				} catch (e) {
					log(`  place ${u.id}: ${(e as Error).message.split("\n")[0]}`);
				}
			}
		};
		await Promise.all(Array.from({ length: Math.max(1, d.concurrency ?? 16) }, work));
	}
	// areas outside the curated set (code-sure units of a new area, answers naming a new area): curate once more
	if (d.curate && d.client && curatedBefore && outsideCurated(d.ledger, curatedBefore).length) {
		const t = await curateAreas({ ledger: d.ledger, config: d.config, root: d.root, client: d.client }, { log });
		res.costUsd += t.costUsd;
	}
	if (todo.length) log(`  placed ${res.placed}/${todo.length} units (${res.byModel} by Jev, ${res.shared} shared), ${res.asked} placement question(s), $${res.costUsd.toFixed(4)}`);
	return res;
}

function openQuestion(ledger: Ledger, id: number | undefined): boolean {
	return !!id && ledger.getQuestion(id)?.status === "open";
}

/** The curated business areas per stack (`.bigrefactor/areas.json`, written by the taxonomy), name → purpose. */
function curatedAreas(root: string): Map<string, Map<string, string>> | undefined {
	try {
		const j = JSON.parse(readFileSync(areasPath(root), "utf8")) as { stacks?: Array<{ stack: string; areas: Array<{ name: string; purpose?: string }> }> };
		if (!j.stacks?.length) return undefined;
		return new Map(j.stacks.map((s) => [s.stack, new Map(s.areas.map((a) => [kebab(a.name), a.purpose ?? ""]))]));
	} catch {
		return undefined;
	}
}

/** Feature-area placements (stack:area) that the curated set does not contain. */
function outsideCurated(ledger: Ledger, curated: Map<string, Map<string, string>>): string[] {
	const out = new Set<string>();
	for (const u of ledger.listUnits()) {
		const p = (JSON.parse(u.meta) as UnitMeta).place;
		if (p && !p.shared && !curated.get(p.stack)?.has(p.area)) out.add(`${p.stack}:${p.area}`);
	}
	return [...out];
}

/**
 * What Jev may choose from: per stack, the curated feature areas (or, before any curation, the areas code placed
 * units in for sure) and the shared topics in use. Never the unit's own file name: that is how file-named areas
 * (clock, uuid, metadataids) were born.
 */
function candidateContext(config: Config, root: string, units: UnitRow[], plan: Map<string, Planned>) {
	const curated = curatedAreas(root);
	const byDir = new Map<string, string[]>();
	const count = new Map<string, number>();
	const features = new Map<string, Map<string, string>>(); // stack → area → purpose
	const topics = new Map<string, Set<string>>(); // stack → shared topics in use
	for (const s of config.target.stacks) (features.set(s, new Map(curated?.get(s) ?? [])), topics.set(s, new Set()));
	for (const u of units) {
		const p = plan.get(u.id)!;
		if (p.unsure) continue;
		const key = `${p.place.stackId}:${p.place.area}`;
		count.set(key, (count.get(key) ?? 0) + 1);
		if (p.place.shared) topics.get(p.place.stackId)?.add(p.place.area);
		else if (!curated) features.get(p.place.stackId)?.set(p.place.area, "");
		for (const f of (JSON.parse(u.meta) as UnitMeta).files ?? []) (byDir.get(dirname(f)) ?? byDir.set(dirname(f), []).get(dirname(f))!).push(p.place.area);
	}
	return { byDir, count, features, topics, deps: new Map(units.map((u) => [u.id, JSON.parse(u.deps) as string[]])), plan };
}

/** Areas around a unit (same folder, what it uses, what uses it) and Jev's candidates: known areas only, nearest first (max 8). */
function around(u: UnitRow, code: Planned, ctx: ReturnType<typeof candidateContext>, stacks: string[]) {
	const files = (JSON.parse(u.meta) as UnitMeta).files ?? [];
	const areaOf = (id: string) => ctx.plan.get(id)?.place.area;
	const tally = (xs: Array<string | undefined>) => {
		const t = new Map<string, number>();
		for (const x of xs) if (x && x !== SHARED_AREA) t.set(x, (t.get(x) ?? 0) + 1);
		return [...t].sort((a, b) => b[1] - a[1]);
	};
	const neighbours = tally(files.flatMap((f) => ctx.byDir.get(dirname(f)) ?? []));
	const uses = tally((ctx.deps.get(u.id) ?? []).map(areaOf));
	const usedBy = tally([...ctx.deps].filter(([, ds]) => ds.includes(u.id)).map(([id]) => areaOf(id)));
	const known = new Map(stacks.flatMap((s) => [...(ctx.features.get(s) ?? [])]));
	const byCount = [...known.keys()].sort((a, b) => stacks.reduce((n, s) => n + (ctx.count.get(`${s}:${b}`) ?? 0) - (ctx.count.get(`${s}:${a}`) ?? 0), 0));
	const near = [code.place.area, ...neighbours.map(([a]) => a), ...uses.map(([a]) => a), ...usedBy.map(([a]) => a)];
	const cands = [...new Set([...near.filter((a) => known.has(a)), ...byCount])].slice(0, 8);
	const topics = [...new Set(stacks.flatMap((s) => [...(ctx.topics.get(s) ?? [])]))].slice(0, 6);
	return { files, neighbours, uses, usedBy, cands, topics, purpose: (a: string) => known.get(a) ?? "" };
}

async function modelPlace(d: PlacementDeps, u: UnitRow, code: Planned, ctx: ReturnType<typeof candidateContext>): Promise<{ place?: Placement; confidence?: number; decision?: number; costUsd: number }> {
	const stacks = code.surfaceKnown ? [code.place.stackId] : d.config.target.stacks;
	const { files, neighbours, uses, usedBy, cands, topics, purpose } = around(u, code, ctx, stacks);
	const key = (a: string) => a.replace(/-/g, "_");
	const topicKey = (t: string) => `shared__${key(t)}`;
	const battery: Battery = {
		area: {
			type: "choice",
			instructions: "Which existing feature area of the app does the code in `summary` belong to, or which shared topic if it is cross-cutting code several features use? `neighbours` are the areas of the files in the same folder, `uses` the areas of the code it depends on, `used_by` the areas of the code that depends on it. Pick `other` when none fits.",
			criteria: {
				...Object.fromEntries(cands.map((a) => [key(a), `feature "${a}"${purpose(a) ? `: ${purpose(a)}` : ""}`])),
				...Object.fromEntries(topics.map((t) => [topicKey(t), `shared topic "${t}" (cross-cutting code)`])),
				other: null,
			},
		},
	};
	if (!code.surfaceKnown && d.config.target.stacks.length > 1) battery["ui"] = { type: "noul", instructions: "Does the code in `summary` render HTML, templates, or browser-side scripts or styles?" };
	const r = await decide({ client: d.client!, ledger: d.ledger, model: d.config.models.decide.id }, POINT, { summary: excerpt(d.config, files), path: files[0], neighbours: Object.fromEntries(neighbours), uses: Object.fromEntries(uses), used_by: Object.fromEntries(usedBy) }, battery, Object.keys(battery), u.id);
	const a = r.answers["area"];
	const choice = a?.type === "choice" ? a.choice : "other";
	const ui = r.answers["ui"];
	const stackId = ui?.type === "noul" ? stackFor(d.config, ui.noul >= 0.5 ? "ui" : "server") : code.place.stackId;
	const topic = topics.find((t) => topicKey(t) === choice);
	const picked = topic ?? cands.find((c) => key(c) === choice);
	const shared = !!topic;
	if (picked && r.confidence >= ACT) return { place: mk(stackId, picked, shared, "model"), confidence: r.confidence, decision: r.decisionId, costUsd: r.costUsd };
	const jev = `Jev: ${choice} at confidence ${r.confidence.toFixed(2)}${ui?.type === "noul" ? `, renders UI p=${ui.noul.toFixed(2)} (confidence ${noulConfidence(ui.noul).toFixed(2)})` : ""}`;
	return { costUsd: r.costUsd + (await askPlacement(d, u, code, ctx, picked ? { stackId, area: picked, shared, facts: jev, decision: r.decisionId } : { stackId, facts: jev, decision: r.decisionId })) };
}

/** One placement question (phrased by a model) offering the known areas; only this unit waits. `pick` = Jev's unsure pick, if Jev ran. */
async function askPlacement(d: PlacementDeps, u: UnitRow, code: Planned, ctx: ReturnType<typeof candidateContext>, pick?: { stackId: string; area?: string; shared?: boolean; facts: string; decision?: number }): Promise<number> {
	const stacks = code.surfaceKnown ? [code.place.stackId] : d.config.target.stacks;
	const { files, neighbours, uses, usedBy, cands, topics, purpose } = around(u, code, ctx, stacks);
	const stackId = pick?.stackId ?? code.place.stackId;
	const value = (stack: string, area: string, sh: boolean) => `${stack}:${sh ? "shared/" : ""}${area}`;
	const options: AskOption[] = [];
	if (pick?.area) options.push({ value: value(stackId, pick.area, !!pick.shared), facts: "Jev's pick (below the confidence to act alone)" });
	for (const s of stacks) {
		for (const c of cands) {
			const v = value(s, c, false);
			if ((ctx.features.get(s)?.has(c) ?? false) && !options.some((o) => o.value === v)) options.push({ value: v, facts: `${purpose(c) ? `${purpose(c)}; ` : ""}${ctx.count.get(`${s}:${c}`) ?? 0} units already placed there` });
		}
		for (const t of ctx.topics.get(s) ?? []) if (topics.includes(t) && !options.some((o) => o.value === value(s, t, true))) options.push({ value: value(s, t, true), facts: "shared topic in use (cross-cutting code)" });
		// cross-cutting is always an answer, even before any shared topic exists (another topic name can be typed)
		if (!options.some((o) => o.value.startsWith(`${s}:shared/`))) options.push({ value: value(s, SHARED_AREA, true), facts: "the stack's shared dir (cross-cutting code); type <stack>:shared/<topic> for a named topic" });
	}
	const recommended = options[0]?.value ?? value(stackId, SHARED_AREA, true);
	if (!options.length) options.push({ value: recommended, facts: "no known area yet: the stack's shared dir" });
	const facts = [
		`unit ${u.id}, files: ${files.join(", ")}`,
		`code could not place it (${code.unsure}); it never names an area after a single legacy file`,
		pick?.facts ?? "Jev did not place it (no model, or the call failed)",
		`areas of files in the same folder: ${JSON.stringify(Object.fromEntries(neighbours))}; it uses: ${JSON.stringify(Object.fromEntries(uses))}; used by: ${JSON.stringify(Object.fromEntries(usedBy))}`,
		`options are the curated business areas (<stack>:<area>) and the shared topics in use (<stack>:shared/<topic>); a typed area name is taken as a new area on ${stackId}`,
	].join("\n");
	const q = await askViaModel({ ledger: d.ledger, config: d.config, root: d.root, client: d.client }, { point: POINT, unitId: u.id, facts, options: options.slice(0, 10), recommended, blocks: "unit", askedBy: "placement", context: { files, defaultStack: stackId }, decisionId: pick?.decision });
	d.ledger.updateUnit(u.id, { meta: { placeQuestion: q.id } });
	return q.costUsd;
}

function excerpt(config: Config, files: string[]): string {
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
}

/**
 * Answered placement questions → the unit's placement + a prefix rule in placement.json for similar files.
 * Cheap (one query); the scheduler calls it before every scheduling pass so an answer re-plans its unit.
 */
export function applyPlacementAnswers(ledger: Ledger, config: Config, root: string): string[] {
	const rows = ledger.db
		.prepare("SELECT u.id, u.meta, q.answer, q.context FROM units u JOIN questions q ON q.id = json_extract(u.meta, '$.placeQuestion') WHERE json_extract(u.meta, '$.place') IS NULL AND q.status IN ('answered', 'auto')")
		.all() as Array<{ id: string; meta: string; answer: string | null; context: string | null }>;
	const done: string[] = [];
	for (const r of rows) {
		const ctx = (r.context ? JSON.parse(r.context) : {}) as { defaultStack?: string };
		const v = answerValue(r.answer);
		const m = /^([\w-]+):(shared\/)?([\w-]+)$/.exec(v);
		const stack = m && config.target.stacks.includes(m[1]!) ? m[1]! : (ctx.defaultStack ?? stackFor(config, "server"));
		const area = kebab(m ? m[3]! : v);
		if (!area) {
			ledger.updateUnit(r.id, { meta: { placeQuestion: undefined } }); // unusable answer: the next placement pass asks again
			continue;
		}
		const shared = !!m?.[2] || area === SHARED_AREA;
		ledger.updateUnit(r.id, { meta: { place: { stack, area, shared, source: "answer" } satisfies StoredPlace } });
		// similar files (same dir + stem) follow the answer's area; its stack only where the adapter cannot tell the surface
		const source = getSourceAdapter(config.source.stack);
		addRules(root, ((JSON.parse(r.meta) as UnitMeta).files ?? []).map((f) => ({ prefix: similarPrefix(f), area, ...(source.placeFile?.(f, config.source.path)?.surface ? {} : { stack }), ...(shared ? { shared } : {}) })));
		done.push(r.id);
	}
	if (done.length) placeCoveredWaiting(ledger, config, root);
	return done;
}

/** Units still waiting on a placement question that the new rules now place for sure: placed, their question withdrawn. */
function placeCoveredWaiting(ledger: Ledger, config: Config, root: string): void {
	const rows = ledger.db
		.prepare("SELECT u.id, u.meta, q.id qid FROM units u JOIN questions q ON q.id = json_extract(u.meta, '$.placeQuestion') WHERE json_extract(u.meta, '$.place') IS NULL AND q.status = 'open'")
		.all() as Array<{ id: string; meta: string; qid: number }>;
	for (const r of rows) {
		const c = codePlace(config, JSON.parse(r.meta) as UnitMeta, root);
		if (c.unsure || c.place.source !== "override") continue;
		ledger.updateUnit(r.id, { meta: { place: { stack: c.place.stackId, area: c.place.area, shared: c.place.shared, source: "override" } satisfies StoredPlace } });
		ledger.withdrawQuestion(r.qid, `placed by the rule from an answer to a similar file: ${c.place.moduleKey}`);
	}
}

/** `lib/x/sso.client.src` → `lib/x/sso.`: the file's directory + name up to the first dot, ending at that dot (same stem only). */
function similarPrefix(file: string): string {
	return `${join(dirname(file), basename(file).split(".")[0]!)}.`;
}

const rulesFile = (root: string) => join(root, ".bigrefactor", "placement.json");
let rulesCache: { file: string; mtime: number; rules: PlacementRule[] } | undefined;
function loadRules(root?: string): PlacementRule[] {
	if (!root) return [];
	const file = rulesFile(root);
	let mtime: number;
	try {
		mtime = statSync(file).mtimeMs;
	} catch {
		return [];
	}
	if (rulesCache?.file === file && rulesCache.mtime === mtime) return rulesCache.rules;
	let rules: PlacementRule[];
	try {
		rules = ((JSON.parse(readFileSync(file, "utf8")) as { rules?: PlacementRule[] }).rules ?? []).filter((r) => typeof r.prefix === "string");
	} catch (e) {
		throw new Error(`invalid ${file}: ${(e as Error).message}`);
	}
	rulesCache = { file, mtime, rules };
	return rules;
}
function addRules(root: string, add: PlacementRule[]): void {
	const file = rulesFile(root);
	const rules = loadRules(root).filter((r) => !add.some((a) => a.prefix === r.prefix));
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify({ rules: [...rules, ...add] }, null, 2) + "\n");
	rulesCache = undefined;
}
