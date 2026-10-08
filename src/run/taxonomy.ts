import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Config } from "../config.ts";
import { answerValue, askViaModel, repoBrief } from "../jev/ask.ts";
import type { Ledger } from "../ledger/db.ts";
import type { ModelClient } from "../models/types.ts";
import { kebab } from "./areas.ts";
import { getSourceAdapter } from "../adapters/registry.ts";
import { loadDecisions } from "../inventory/decisions.ts";
import { codePlace, covers, setTaxonomyRules, type PlacementRule } from "./placement.ts";

/**
 * Area taxonomy: which legacy files make up which business area of the new codebase. Names alone do not tell
 * (a word list guessed one area per legacy file name: `metadataids`, `clock`), so one model pass looks at the whole
 * legacy folder tree (file counts, the ui/server fact the source adapter knows, which folders use which file) plus
 * the repo brief and the areas placed so far, and returns, per stack, a curated area set and prefix rules:
 *   area     → the files under the prefix belong to that business area
 *   shared   → cross-cutting code, lives in the stack's shared dir under a topic
 *   exclude  → not application code to migrate (tooling stubs, entry scripts, framework bootstrap) — always asked
 * Confident area/shared rules go into `.bigrefactor/placement.json` (by "taxonomy", replacing its earlier ones);
 * code only applies them (placement.ts). Planned units they now cover are moved there (source "taxonomy"). Files no
 * rule covers are left to Jev, one unit at a time; when the area set changes, Jev's earlier picks are made again
 * against it. One domain has one home: the model merges overlapping areas/topics itself, and what it cannot merge
 * becomes one owner question. DB table groups are mapped onto the areas too. Kept in `.bigrefactor/areas.json`.
 */
export interface AreaRule {
	prefix: string;
	to: "area" | "shared" | "exclude";
	stack: string;
	area: string; // business area, or shared topic
	confidence: number;
	why: string;
}
/** An older area question's context: a mapping of a whole placed area (`from` = "<stack>:<area>"). */
export interface AreaMapping extends Omit<AreaRule, "prefix"> {
	from: string;
}

interface Deps {
	ledger: Ledger;
	config: Config;
	root: string;
	client?: ModelClient;
}

type Meta = { files?: string[]; lane?: string; group?: string; businessArea?: string; tables?: string[]; route?: { has_ui?: number }; place?: { stack: string; area: string; shared: boolean; source: string }; exclude?: { question: number; why: string }; taxonomyQuestion?: number; taxonomyKeep?: number };

/** Areas or topics of one stack that hold the same domain (topics as `shared/<topic>`); `into` is the name to keep. */
export interface Overlap {
	stack: string;
	names: string[];
	into: string;
	why: string;
}
/** `.bigrefactor/areas.json` */
interface AreasFile {
	stacks?: Array<{ stack: string; areas: Array<{ name: string; purpose: string }>; topics?: Array<{ name: string; purpose: string }> }>;
	rules?: AreaRule[];
	overlaps?: Overlap[];
	/** The owner question about `overlaps`, and the last one applied. */
	overlapQuestion?: number;
	overlapDone?: number;
	/** Overlaps the owner keeps apart: never raised again. */
	overlapsKept?: Overlap[];
	at?: string;
	by?: string;
}
const readAreas = (root: string): AreasFile | undefined => (existsSync(areasPath(root)) ? (JSON.parse(readFileSync(areasPath(root), "utf8")) as AreasFile) : undefined);
const writeAreas = (root: string, f: AreasFile) => (mkdirSync(dirname(areasPath(root)), { recursive: true }), writeFileSync(areasPath(root), JSON.stringify(f, null, 2) + "\n"));
/** Every area and topic name of a curated set, `stack:area` / `stack:shared/topic`. */
const namesOf = (f: AreasFile | undefined) => new Set((f?.stacks ?? []).flatMap((s) => [...s.areas.map((a) => `${s.stack}:${kebab(a.name)}`), ...(s.topics ?? []).map((t) => `${s.stack}:shared/${kebab(t.name)}`)]));
const overlapKey = (o: Overlap) => `${o.stack}:${[...o.names].sort().join("+")}`;
const areaName = (n: string) => (n.startsWith("shared/") ? `shared/${kebab(n.slice(7))}` : kebab(n));

const ACT = 0.8;

export function areasPath(root: string): string {
	return join(root, ".bigrefactor", "areas.json");
}

/**
 * Areas as placed now. `fixed` = not to be re-curated: some unit already started or landed there (relabelling would
 * split migrated code from the ledger), the owner answered keep, or an area question about it is still open.
 */
export function currentAreas(ledger: Ledger): Array<{ key: string; stack: string; area: string; shared: boolean; units: number; files: string[]; fixed?: string }> {
	const rows = ledger.db.prepare("SELECT state, meta FROM units").all() as Array<{ state: string; meta: string }>;
	const by = new Map<string, { key: string; stack: string; area: string; shared: boolean; units: number; files: string[]; fixed?: string }>();
	for (const r of rows) {
		const m = JSON.parse(r.meta) as Meta;
		if (!m.place?.area || m.exclude || m.lane === "db") continue; // the DB lane is no feature area
		const key = `${m.place.stack}:${m.place.shared ? "shared/" : ""}${m.place.area}`;
		const e = by.get(key) ?? by.set(key, { key, stack: m.place.stack, area: m.place.area, shared: m.place.shared, units: 0, files: [] }).get(key)!;
		e.units++;
		if (r.state !== "planned") e.fixed ??= "has migrated or running units";
		else if (m.taxonomyKeep) e.fixed ??= `owner kept it (question #${m.taxonomyKeep})`;
		else if (m.taxonomyQuestion && ledger.getQuestion(m.taxonomyQuestion)?.status === "open") e.fixed ??= `question #${m.taxonomyQuestion} open`;
		if (e.files.length < 4) e.files.push(...(m.files ?? []).slice(0, 4 - e.files.length));
	}
	return [...by.values()].sort((a, b) => b.units - a.units);
}

export async function curateAreas(d: Deps, opts: { log?: (s: string) => void } = {}): Promise<{ applied: number; moved: number; asked: number; areas: Record<string, string[]>; cleared: string[]; costUsd: number }> {
	const log = opts.log ?? (() => {});
	const none = { applied: 0, moved: 0, asked: 0, areas: {}, cleared: [] as string[], costUsd: 0 };
	if (!d.client) return none;
	const units = (d.ledger.db.prepare("SELECT id, state, deps, meta FROM units").all() as Array<{ id: string; state: string; deps: string; meta: string }>)
		.map((u) => ({ ...u, m: JSON.parse(u.meta) as Meta }))
		.filter((u) => u.m.files?.length && u.m.lane !== "db" && !u.m.exclude); // the DB lane is no feature area
	if (!units.length) return none;
	const areas = currentAreas(d.ledger);
	// idempotent: when every feature area is already in the curated set (and no area question is pending), nothing to do
	const prev = readAreas(d.root);
	const curated = new Set((prev?.stacks ?? []).flatMap((s) => s.areas.map((a) => `${s.stack}:${kebab(a.name)}`)));
	if (prev && areas.every((a) => a.shared || a.fixed || curated.has(`${a.stack}:${a.area}`))) return { ...none, areas: Object.fromEntries((prev.stacks ?? []).map((s) => [s.stack, s.areas.map((a) => a.name)])) };
	const source = getSourceAdapter(d.config.source.stack);
	const surfaceOf = (f: string) => source.placeFile?.(f, d.config.source.path)?.surface;
	const brief = await repoBrief(d);
	const role = d.config.models.escalate;
	const dbUnits = (d.ledger.db.prepare("SELECT id, state, meta FROM units").all() as Array<{ id: string; state: string; meta: string }>).map((u) => ({ ...u, m: JSON.parse(u.meta) as Meta })).filter((u) => u.m.lane === "db" && u.m.group);
	const kept = prev?.overlapsKept ?? [];
	const res = await d.client.chat({
		model: role.id,
		tier: role.tier as "default" | "flex" | "priority",
		effort: "high",
		schema: {
			type: "object",
			additionalProperties: false,
			required: ["stacks", "rules", "overlaps", "db"],
			properties: {
				overlaps: { type: "array", description: "areas or topics that hold the same domain which you could NOT merge yourself (a FIXED one is involved, or you are unsure); the owner decides", items: { type: "object", additionalProperties: false, required: ["stack", "names", "into", "why"], properties: { stack: { type: "string" }, names: { type: "array", items: { type: "string" }, description: "area names; shared topics as shared/<topic>" }, into: { type: "string", description: "the one of names to keep" }, why: { type: "string" } } } },
				db: { type: "array", description: "each database table group → the one area of yours its tables belong to", items: { type: "object", additionalProperties: false, required: ["group", "area"], properties: { group: { type: "string" }, area: { type: "string" } } } },
				stacks: { type: "array", items: { type: "object", additionalProperties: false, required: ["stack", "areas", "topics"], properties: { stack: { type: "string" }, areas: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "purpose"], properties: { name: { type: "string" }, purpose: { type: "string" } } } }, topics: { type: "array", description: "the shared topics of this stack", items: { type: "object", additionalProperties: false, required: ["name", "purpose"], properties: { name: { type: "string" }, purpose: { type: "string", description: "one line: what code goes there" } } } } } } },
				rules: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						required: ["prefix", "to", "stack", "area", "confidence", "why"],
						properties: {
							prefix: { type: "string", description: "a folder ending in / or a folder + file name start, exactly as in the tree" },
							to: { type: "string", enum: ["area", "shared", "exclude"] },
							stack: { type: "string", enum: d.config.target.stacks },
							area: { type: "string", description: "business area name, or shared topic; kebab-case" },
							confidence: { type: "number" },
							why: { type: "string" },
						},
					},
				},
			},
		},
		messages: [
			{
				role: "system",
				content: `You design the feature-module structure of the NEW codebase (${d.config.target.stacks.join(" + ")}) a legacy app is migrated into, and say which legacy files go into which area. A new developer must find code by business concept. Rules:
- Areas are business domains of THIS app (campaigns, flights, players, billing …), kebab-case, plural nouns where natural, consistent naming. Never a legacy file name, class name, technical layer or tool name.
- Per stack, aim for roughly 12–40 areas; an area with fewer than 3 units must be a genuinely separate domain, otherwise merge it.
- Utilities, base classes, formatting, pagination, clocks, HTTP helpers → "shared" with a topic (dates, http, formatting, pagination, errors …). List each stack's shared topics with a one-line purpose; like areas, a topic is a concept, never a legacy file name.
- Server logic (models, data access, commands, jobs, mail rendering) belongs on the server stack; pages, templates, widgets and client scripts on the UI stack. Where the tree shows a ui/server fact for a folder, that fact decides the stack; your stack is used only where it shows none.
- Answer with prefix rules. A prefix ending in "/" covers the whole folder; any other prefix covers the files whose name starts with it up to a "." (\`app/model/classes/campaign\` covers campaign.model.php and campaign.facade.php, not campaigns.model.php). The longest matching prefix wins: a folder rule plus file rules for the exceptions is enough.
- Folders that hold one kind of file for all features (models, components, helpers, controllers) need file rules: use the names and the "used from" counts (which folders' code uses the file, ×n) to put each file with the feature that uses it; used by many features → shared.
- Write a rule only where you are sure; another model places the files no rule covers one at a time.
- "exclude" only for things that are not application behaviour to migrate (static-analysis stubs, entry/bootstrap scripts the new framework replaces); these are confirmed by the owner.
- One domain, one home: an area and a shared topic, or two areas, for the same concept (documents next to file-storage, dashboards next to dashboard-layout) become one name in your areas, topics and rules. List in overlaps only those you cannot merge yourself; never one the owner keeps apart.
- Map each database table group onto one of your areas in db (by what its tables hold).
- Areas placed so far are listed with their units; FIXED areas stay as they are (keep their files there), others may be renamed or merged. confidence = how sure you are (0–1).`,
			},
			{ role: "user", content: `Repo brief:\n${brief.brief.slice(0, 6000)}\n\nLegacy folder tree (folder, files, ui/server fact; then each file name up to its first dot, ← used from folder ×n):\n${treeFacts(units, surfaceOf)}\n\nAreas placed so far (key, units, sample files):\n${areas.map((a) => `${a.key}  ${a.units}  ${a.files.join(", ")}${a.fixed ? `  FIXED (${a.fixed})` : ""}`).join("\n") || "none yet"}${dbUnits.length ? `\n\nDatabase table groups (group, business area the table model named, tables):\n${dbUnits.map((u) => `${u.m.group}  ${u.m.businessArea ?? "-"}  ${(u.m.tables ?? []).slice(0, 6).join(", ")}`).join("\n")}` : ""}${kept.length ? `\n\nThe owner keeps these apart: ${kept.map((o) => `${o.stack}: ${o.names.join(" + ")}`).join("; ")}` : ""}` },
		],
	});
	let cost = brief.costUsd + res.usage.costUsd;
	const j = (res.json ?? {}) as { stacks?: AreasFile["stacks"]; rules?: AreaRule[]; overlaps?: Overlap[]; db?: Array<{ group: string; area: string }> };
	const files = units.flatMap((u) => u.m.files!);
	// guards: a rule must cover a real file of the inventory and name a target stack
	const rules = (j.rules ?? []).map((r) => ({ ...r, prefix: r.prefix.replace(/^\.\//, ""), area: kebab(r.area) })).filter((r) => r.prefix && (r.area || r.to === "exclude") && d.config.target.stacks.includes(r.stack) && files.some((f) => covers(r.prefix, f)));
	const out: AreasFile = { stacks: j.stacks ?? [], rules, at: new Date().toISOString(), by: res.usage.model, ...(kept.length ? { overlapsKept: kept } : {}) };
	const changed = !prev || [...namesOf(prev)].sort().join() !== [...namesOf(out)].sort().join();

	// confident rules: code applies them; the stack only where the adapter knows no surface for the covered files
	const write: PlacementRule[] = rules
		.filter((r) => r.to !== "exclude" && r.confidence >= ACT)
		.map((r) => ({ prefix: r.prefix, area: r.area, ...(files.some((f) => covers(r.prefix, f) && surfaceOf(f)) ? {} : { stack: r.stack }), ...(r.to === "shared" ? { shared: true } : {}) }));
	setTaxonomyRules(d.root, write);

	// planned units the rules now cover move there; answers, owner keeps, open questions and FIXED areas stay.
	// A unit Jev placed against another area set is placed again against this one (the caller does that): its pick was a guess.
	const fixed = new Set(areas.filter((a) => a.fixed).map((a) => a.key));
	let moved = 0;
	const cleared: string[] = [];
	for (const u of units) {
		const p = u.m.place;
		if (u.state !== "planned" || !p || p.source === "answer" || u.m.taxonomyKeep || u.m.taxonomyQuestion || fixed.has(`${p.stack}:${p.shared ? "shared/" : ""}${p.area}`)) continue;
		const c = codePlace(d.config, { files: u.m.files, route: u.m.route }, d.root);
		if (c.unsure || c.place.source !== "override") {
			if (changed && p.source === "model") (d.ledger.updateUnit(u.id, { meta: { place: undefined } }), cleared.push(u.id));
			continue;
		}
		if (c.place.stackId === p.stack && c.place.area === p.area && c.place.shared === p.shared) continue;
		d.ledger.updateUnit(u.id, { meta: { place: { stack: c.place.stackId, area: c.place.area, shared: c.place.shared, source: "taxonomy" } } });
		moved++;
	}
	// DB table groups go to the area the model mapped them to (an owner's answer stays)
	for (const m of j.db ?? []) {
		const u = dbUnits.find((x) => x.m.group === m.group);
		const area = kebab(m.area ?? "");
		if (!u || !area || u.state !== "planned" || u.m.place?.source === "answer" || u.m.place?.area === area) continue;
		d.ledger.updateUnit(u.id, { meta: { place: { stack: u.m.place?.stack ?? d.config.target.stacks[0]!, area, shared: false, source: "taxonomy" } } });
		moved++;
	}

	// exclusions are the owner's call: one question per rule; its units wait for the answer
	let asked = 0;
	for (const r of rules.filter((x) => x.to === "exclude")) {
		const hit = units.filter((u) => u.state === "planned" && !u.m.taxonomyKeep && !u.m.taxonomyQuestion && u.m.files!.every((f) => covers(r.prefix, f)));
		if (!hit.length) continue;
		const sample = hit.flatMap((u) => u.m.files!).slice(0, 4);
		const options = [{ value: "exclude", facts: "do not migrate these units" }, { value: "keep", facts: "migrate them like the rest" }];
		const q = await askViaModel(d, {
			point: "area_taxonomy",
			facts: `Area review of the new codebase: ${r.prefix} (${hit.length} unit(s), e.g. ${sample.join(", ")}) should not be migrated. Reason: ${r.why}. Model confidence ${r.confidence.toFixed(2)}.`,
			options,
			recommended: "exclude",
			agentOpinion: r.why,
			blocks: "none",
			askedBy: "taxonomy",
			context: { mapping: { ...r, from: r.prefix } },
		});
		cost += q.costUsd;
		asked++;
		// the units wait for the answer: placement treats a unit with an open taxonomy question as unplaced
		for (const u of hit) d.ledger.updateUnit(u.id, { meta: { taxonomyQuestion: q.id } });
	}
	// overlaps the model could not merge: one owner question for all of them (not while an earlier one is open)
	const overlaps = (j.overlaps ?? [])
		.map((o) => ({ ...o, names: [...new Set(o.names.map(areaName).filter(Boolean))], into: areaName(o.into) }))
		.filter((o) => d.config.target.stacks.includes(o.stack) && o.names.length > 1 && o.names.includes(o.into) && !kept.some((k) => overlapKey(k) === overlapKey(o)));
	const openBefore = prev?.overlapQuestion && d.ledger.getQuestion(prev.overlapQuestion)?.status === "open" ? prev.overlapQuestion : undefined;
	if (openBefore) Object.assign(out, { overlaps: prev!.overlaps, overlapQuestion: openBefore });
	else if (overlaps.length) {
		const q = await askViaModel(d, {
			point: "area_overlap",
			facts: `Area review of the new codebase: these areas/topics look like one domain each, but the area model could not merge them on its own:\n${overlaps.map((o) => `- ${o.stack}: ${o.names.join(" + ")} → keep ${o.into} (${o.why})`).join("\n")}\nmerge = their planned units and rules move to the kept name (units already migrated stay where they are); keep = they stay apart and are not raised again.`,
			options: [{ value: "merge", facts: "one home per domain: merge as listed" }, { value: "keep", facts: "keep them apart" }],
			recommended: "merge",
			blocks: "none",
			askedBy: "taxonomy",
			context: { overlaps },
		});
		cost += q.costUsd;
		asked++;
		Object.assign(out, { overlaps, overlapQuestion: q.id });
	} else if (prev?.overlapQuestion) Object.assign(out, { overlaps: prev.overlaps, overlapQuestion: prev.overlapQuestion });
	if (prev?.overlapDone) out.overlapDone = prev.overlapDone;
	writeAreas(d.root, out);
	syncOverlapAnswer(d);
	log(`areas: ${rules.length} rules from the folder tree, ${write.length} applied, ${moved} unit(s) moved, ${cleared.length} Jev pick(s) to redo, ${asked} asked; ${(j.stacks ?? []).map((s) => `${s.stack} ${s.areas.length} areas`).join(", ")}`);
	return { applied: write.length, moved, asked, cleared, areas: Object.fromEntries((j.stacks ?? []).map((s) => [s.stack, s.areas.map((a) => a.name)])), costUsd: cost };
}

/**
 * The owner's answer on overlapping areas: merge moves the planned units and the rules of the other names to the
 * kept one and drops those names from the curated set; keep remembers them so they are never raised again.
 */
export function syncOverlapAnswer(d: Pick<Deps, "ledger" | "root">): boolean {
	const f = readAreas(d.root);
	if (!f?.overlapQuestion || f.overlapDone === f.overlapQuestion) return false;
	const q = d.ledger.getQuestion(f.overlapQuestion);
	if (!q || (q.status !== "answered" && q.status !== "auto")) return false;
	const overlaps = f.overlaps ?? [];
	if (answerValue(q.answer) === "merge") {
		const split = (n: string) => (n.startsWith("shared/") ? { area: n.slice(7), shared: true } : { area: n, shared: false });
		const rows = d.ledger.db.prepare("SELECT id, state, meta FROM units").all() as Array<{ id: string; state: string; meta: string }>;
		const file = join(d.root, ".bigrefactor", "placement.json");
		const rules = existsSync(file) ? ((JSON.parse(readFileSync(file, "utf8")) as { rules?: PlacementRule[] }).rules ?? []) : [];
		for (const o of overlaps) {
			const into = split(o.into);
			const gone = o.names.filter((n) => n !== o.into).map(split);
			for (const r of rows) {
				const p = (JSON.parse(r.meta) as Meta).place;
				if (r.state === "planned" && p && p.stack === o.stack && gone.some((g) => g.area === p.area && g.shared === p.shared)) d.ledger.updateUnit(r.id, { meta: { place: { stack: o.stack, area: into.area, shared: into.shared, source: "taxonomy" } } });
			}
			for (const r of rules) {
				if ((r.stack && r.stack !== o.stack) || !gone.some((g) => g.area === r.area && g.shared === !!r.shared)) continue;
				r.area = into.area;
				if (into.shared) r.shared = true;
				else delete r.shared;
			}
			const s = f.stacks?.find((x) => x.stack === o.stack);
			if (s) {
				s.areas = s.areas.filter((a) => !gone.some((g) => !g.shared && g.area === kebab(a.name)));
				s.topics = (s.topics ?? []).filter((t) => !gone.some((g) => g.shared && g.area === kebab(t.name)));
			}
		}
		if (rules.length) writeFileSync(file, JSON.stringify({ rules }, null, 2) + "\n");
	} else f.overlapsKept = [...(f.overlapsKept ?? []), ...overlaps];
	f.overlapDone = f.overlapQuestion;
	writeAreas(d.root, f);
	return true;
}

/** A shared topic named in an answer joins the curated set, so the next units can be placed there too. */
export function recordTopic(root: string, stack: string, name: string, purpose: string): void {
	const f = readAreas(root);
	if (!f?.stacks) return; // nothing curated yet: the first curation sees the topic among the placed areas
	let s = f.stacks.find((x) => x.stack === stack);
	if (!s) f.stacks.push((s = { stack, areas: [], topics: [] }));
	if ((s.topics ?? []).some((t) => kebab(t.name) === name)) return;
	s.topics = [...(s.topics ?? []), { name, purpose }];
	writeAreas(root, f);
}

/**
 * Not application code (the owner said so): the unit's files are accounted as dropped with the reason, the unit never
 * runs, and the disposition is kept with the owner's decisions so a re-inventory keeps it.
 */
export function excludeUnit(d: Pick<Deps, "ledger" | "root">, unitId: string, files: string[], question: number, why: string): void {
	const reason = `excluded by the owner (question #${question}): ${why}`;
	for (const f of files) d.ledger.markRegenerated(f, reason);
	d.ledger.updateUnit(unitId, { meta: { taxonomyQuestion: undefined, placeQuestion: undefined, exclude: { question, why } } });
	if (!files.length) return;
	const p = join(d.root, ".bigrefactor", "decisions.json");
	const file = loadDecisions(d.root) as ReturnType<typeof loadDecisions> & { excluded?: Record<string, string> };
	file.excluded = { ...file.excluded, ...Object.fromEntries(files.map((f) => [f, reason])) };
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, JSON.stringify(file, null, 2) + "\n");
}

/**
 * The legacy folder tree as the area model sees it: per folder the file count and the surface facts; per file name
 * (up to its first dot) which other folders' code uses it (from unit deps). Long trees are cut, never silently.
 */
function treeFacts(units: Array<{ id: string; deps: string; m: Meta }>, surfaceOf: (f: string) => "server" | "ui" | undefined, max = 120_000): string {
	const filesOf = new Map(units.map((u) => [u.id, u.m.files!]));
	const stemOf = (f: string) => `${dirname(f)}/${basename(f).split(".")[0]}`;
	const usedFrom = new Map<string, Map<string, number>>(); // dir/stem → using folder → count
	for (const u of units) {
		const from = new Set(u.m.files!.map(dirname));
		for (const dep of JSON.parse(u.deps) as string[]) {
			for (const f of filesOf.get(dep) ?? []) {
				for (const dir of from) {
					if (dir === dirname(f)) continue;
					const t = usedFrom.get(stemOf(f)) ?? usedFrom.set(stemOf(f), new Map()).get(stemOf(f))!;
					t.set(dir, (t.get(dir) ?? 0) + 1);
				}
			}
		}
	}
	const dirs = new Map<string, { files: number; ui: number; server: number; stems: Map<string, number> }>();
	for (const f of new Set(units.flatMap((u) => u.m.files!))) {
		const d = dirs.get(dirname(f)) ?? dirs.set(dirname(f), { files: 0, ui: 0, server: 0, stems: new Map() }).get(dirname(f))!;
		d.files++;
		const s = surfaceOf(f);
		if (s) d[s]++;
		d.stems.set(stemOf(f), (d.stems.get(stemOf(f)) ?? 0) + 1);
	}
	const lines: string[] = [];
	let size = 0;
	const sorted = [...dirs].sort((a, b) => a[0].localeCompare(b[0]));
	for (const [i, [dir, d]] of sorted.entries()) {
		const facts = [d.ui ? `ui ${d.ui}` : "", d.server ? `server ${d.server}` : ""].filter(Boolean).join(", ");
		const block = [`${dir}/  ${d.files} file(s)${facts ? `  [${facts}]` : ""}`];
		const stems = [...d.stems].sort((a, b) => a[0].localeCompare(b[0]));
		for (const [stem, n] of stems.slice(0, 150)) {
			const from = [...(usedFrom.get(stem) ?? [])].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f, c]) => `${f} ×${c}`);
			block.push(`  ${basename(stem)}${n > 1 ? ` (${n})` : ""}${from.length ? `  ← ${from.join(", ")}` : ""}`);
		}
		if (stems.length > 150) block.push(`  … ${stems.length - 150} more file names not shown`);
		const text = block.join("\n");
		if (size + text.length > max) {
			lines.push(`… ${sorted.length - i} more folder(s) not shown (tree too long)`);
			break;
		}
		lines.push(text);
		size += text.length + 1;
	}
	return lines.join("\n");
}

/** Answered taxonomy questions → placement (apply), unchanged (keep) or excluded units. */
export function syncTaxonomyAnswers(d: Pick<Deps, "ledger" | "root">): number {
	const rows = d.ledger.db.prepare("SELECT id, meta FROM units WHERE json_extract(meta,'$.taxonomyQuestion') IS NOT NULL").all() as Array<{ id: string; meta: string }>;
	let n = syncOverlapAnswer(d) ? 1 : 0;
	const rules: Array<{ prefix: string; area: string; stack?: string; shared?: boolean }> = [];
	for (const r of rows) {
		const meta = JSON.parse(r.meta) as Meta & { taxonomyQuestion: number };
		const q = d.ledger.getQuestion(meta.taxonomyQuestion);
		if (!q || (q.status !== "answered" && q.status !== "auto")) continue;
		const m = (JSON.parse(q.context ?? "{}") as { mapping?: AreaMapping }).mapping;
		const v = answerValue(q.answer);
		const started = d.ledger.getUnit(r.id)!.state !== "planned";
		if (m && started) {
			// the unit started while the question was open: its placement is what landed, the answer is moot for it
			d.ledger.updateUnit(r.id, { meta: { taxonomyQuestion: undefined } });
		} else if (m && v === "apply") {
			d.ledger.updateUnit(r.id, { meta: { taxonomyQuestion: undefined, place: { stack: m.stack, area: m.area, shared: m.to === "shared", source: "taxonomy" } } });
			for (const f of meta.files ?? []) rules.push({ prefix: f, area: m.area, stack: m.stack, ...(m.to === "shared" ? { shared: true } : {}) });
		} else if (m && v === "exclude") {
			// not application behaviour: a file disposition (symbols accounted as dropped with the owner's reason), never scheduled
			excludeUnit(d, r.id, meta.files ?? [], q.id, m.why);
		}
		else d.ledger.updateUnit(r.id, { meta: { taxonomyQuestion: undefined, taxonomyKeep: q.id } }); // keep is remembered: never re-asked
		n++;
	}
	addPlacementRules(d.root, rules);
	return n;
}

/** Why a unit may not run because of the taxonomy (undefined = free to run). */
export function taxonomyHold(metaJson: string): string | undefined {
	const m = JSON.parse(metaJson) as Meta & { taxonomyQuestion?: number };
	if (m.exclude) return `excluded from the migration (question #${m.exclude.question}: ${m.exclude.why})`;
	if (m.taxonomyQuestion) return `waits for area question #${m.taxonomyQuestion}`;
	return undefined;
}

function addPlacementRules(root: string, add: Array<{ prefix: string; area: string; stack?: string; shared?: boolean }>): void {
	if (!add.length) return;
	const file = join(root, ".bigrefactor", "placement.json");
	const cur = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { rules?: Array<{ prefix: string }> }).rules ?? [] : [];
	const byPrefix = new Map(cur.map((r) => [r.prefix, r]));
	for (const r of add) byPrefix.set(r.prefix, r);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify({ rules: [...byPrefix.values()] }, null, 2) + "\n");
}
