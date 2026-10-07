import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../config.ts";
import { answerValue, askViaModel, repoBrief } from "../jev/ask.ts";
import type { Ledger } from "../ledger/db.ts";
import type { ModelClient } from "../models/types.ts";
import { kebab } from "./areas.ts";
import { getSourceAdapter } from "../adapters/registry.ts";
import { loadDecisions } from "../inventory/decisions.ts";

/**
 * Area taxonomy. Placement derives an area per file, which on a real repo yields one area per legacy file name
 * (`metadataids`, `clock`, `catch400http`) and utilities posing as features. A tidy target needs a deliberate set
 * of business areas, so after placement one model pass looks at ALL areas at once (unit counts, sample files,
 * repo brief) and returns, per stack, a curated area set and a mapping for every current area:
 *   area     → merge into a business area (same or other stack)
 *   shared   → cross-cutting code, lives in the stack's shared dir under a topic
 *   exclude  → not application code to migrate (tooling stubs, entry scripts, framework bootstrap) — always asked
 * Confident mappings (no stack change against a surface the source adapter knows) are applied (source "taxonomy") as `.bigrefactor/placement.json` rules (placement's override mechanism) and
 * on the units' `meta.place`; the rest become questions (phrased by a model; only those units wait). The result
 * is kept in `.bigrefactor/areas.json` for review.
 */
export interface AreaMapping {
	from: string; // "<stack>:<area>"
	to: "area" | "shared" | "exclude";
	stack: string;
	area: string; // business area, or shared topic
	confidence: number;
	why: string;
}

interface Deps {
	ledger: Ledger;
	config: Config;
	root: string;
	client?: ModelClient;
}

type Meta = { files?: string[]; place?: { stack: string; area: string; shared: boolean; source: string }; exclude?: { question: number; why: string }; taxonomyQuestion?: number; taxonomyKeep?: number };

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
		if (!m.place?.area || m.exclude) continue;
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

export async function curateAreas(d: Deps, opts: { log?: (s: string) => void } = {}): Promise<{ applied: number; asked: number; areas: Record<string, string[]>; costUsd: number }> {
	const log = opts.log ?? (() => {});
	const none = { applied: 0, asked: 0, areas: {}, costUsd: 0 };
	if (!d.client) return none;
	const areas = currentAreas(d.ledger);
	if (!areas.length) return none;
	// idempotent: when every feature area is already in the curated set (and no area question is pending), nothing to do
	const prev = existsSync(areasPath(d.root)) ? (JSON.parse(readFileSync(areasPath(d.root), "utf8")) as { stacks?: Array<{ stack: string; areas: Array<{ name: string }> }> }) : undefined;
	const curated = new Set((prev?.stacks ?? []).flatMap((s) => s.areas.map((a) => `${s.stack}:${kebab(a.name)}`)));
	if (prev && areas.every((a) => a.shared || a.fixed || curated.has(`${a.stack}:${a.area}`))) return { ...none, areas: Object.fromEntries((prev.stacks ?? []).map((s) => [s.stack, s.areas.map((a) => a.name)])) };
	const brief = await repoBrief(d);
	const role = d.config.models.escalate;
	const res = await d.client.chat({
		model: role.id,
		tier: role.tier as "default" | "flex" | "priority",
		effort: "high",
		schema: {
			type: "object",
			additionalProperties: false,
			required: ["stacks", "mappings"],
			properties: {
				stacks: { type: "array", items: { type: "object", additionalProperties: false, required: ["stack", "areas"], properties: { stack: { type: "string" }, areas: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "purpose"], properties: { name: { type: "string" }, purpose: { type: "string" } } } } } } },
				mappings: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						required: ["from", "to", "stack", "area", "confidence", "why"],
						properties: {
							from: { type: "string" },
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
				content: `You design the feature-module structure of the NEW codebase (${d.config.target.stacks.join(" + ")}) a legacy app is migrated into. A new developer must find code by business concept. Rules:
- Areas are business domains of THIS app (campaigns, flights, players, billing …), kebab-case, plural nouns where natural, consistent naming. Never a legacy file name, class name, technical layer or tool name.
- Per stack, aim for roughly 12–40 areas; an area with fewer than 3 units must be a genuinely separate domain, otherwise merge it.
- Utilities, base classes, formatting, pagination, clocks, HTTP helpers → "shared" with a topic (dates, http, formatting, pagination, errors …).
- Server logic (models, data access, commands, jobs, mail rendering) belongs on the server stack; pages, templates, widgets and client scripts on the UI stack. Move a mapping to the other stack when the current one is wrong.
- "exclude" only for things that are not application behaviour to migrate (static-analysis stubs, entry/bootstrap scripts the new framework replaces); these are confirmed by the owner.
- Return a mapping for EVERY current area (also ones that stay as they are). confidence = how sure you are (0–1).`,
			},
			{ role: "user", content: `Repo brief:\n${brief.brief.slice(0, 6000)}\n\nCurrent areas (key, units, sample files; FIXED areas stay as they are — map others into them where they fit):\n${areas.map((a) => `${a.key}  ${a.units}  ${a.files.join(", ")}${a.fixed ? `  FIXED (${a.fixed})` : ""}`).join("\n")}` },
		],
	});
	let cost = brief.costUsd + res.usage.costUsd;
	const j = (res.json ?? {}) as { stacks?: Array<{ stack: string; areas: Array<{ name: string; purpose: string }> }>; mappings?: AreaMapping[] };
	const mappings = (j.mappings ?? []).map((m) => ({ ...m, area: kebab(m.area) })).filter((m) => m.area && areas.some((a) => a.key === m.from) && d.config.target.stacks.includes(m.stack));
	const out = { stacks: j.stacks ?? [], mappings, at: new Date().toISOString(), by: res.usage.model };
	mkdirSync(dirname(areasPath(d.root)), { recursive: true });
	writeFileSync(areasPath(d.root), JSON.stringify(out, null, 2) + "\n");

	const source = getSourceAdapter(d.config.source.stack);
	const rule = (f: string, m: AreaMapping) => ({ prefix: f, area: m.area, ...(source.placeFile?.(f, d.config.source.path)?.surface ? {} : { stack: m.stack }), ...(m.to === "shared" ? { shared: true } : {}) });
	let applied = 0;
	let asked = 0;
	const rules: Array<{ prefix: string; area: string; stack?: string; shared?: boolean }> = [];
	for (const m of mappings) {
		const cur = areas.find((a) => a.key === m.from)!;
		const unchanged = m.to !== "exclude" && m.stack === cur.stack && m.area === cur.area && (m.to === "shared") === cur.shared;
		if (unchanged || cur.fixed) continue;
		const units = unitsOf(d.ledger, m.from);
		// a stack change against a surface the source adapter knows is the rare exception: always asked
		const surfaceKnown = units.some((u) => ((JSON.parse(u.meta) as Meta).files ?? []).some((f) => !!source.placeFile?.(f, d.config.source.path)?.surface));
		const stackChange = m.stack !== cur.stack && surfaceKnown;
		if (m.to !== "exclude" && m.confidence >= ACT && !stackChange) {
			for (const u of units) {
				const meta = JSON.parse(u.meta) as Meta;
				d.ledger.updateUnit(u.id, { meta: { place: { stack: m.stack, area: m.area, shared: m.to === "shared", source: "taxonomy" } } });
				for (const f of meta.files ?? []) rules.push(rule(f, m));
			}
			applied++;
			continue;
		}
		const options = m.to === "exclude"
			? [{ value: "exclude", facts: "do not migrate these units" }, { value: "keep", facts: `keep them in ${cur.key}` }]
			: [{ value: "apply", facts: `${m.to === "shared" ? "shared topic" : "area"} ${m.stack}:${m.area}` }, { value: "keep", facts: `keep ${cur.key}` }];
		const q = await askViaModel(d, {
			point: "area_taxonomy",
			facts: `Area review of the new codebase: ${cur.key} (${units.length} unit(s), e.g. ${cur.files.join(", ")}) should ${m.to === "exclude" ? "not be migrated" : `become ${m.to === "shared" ? "the shared topic" : "part of area"} ${m.stack}:${m.area}`}. Reason: ${m.why}. Model confidence ${m.confidence.toFixed(2)}.`,
			options,
			recommended: options[0]!.value,
			agentOpinion: m.why,
			blocks: "none",
			askedBy: "taxonomy",
			context: { mapping: m },
		});
		cost += q.costUsd;
		asked++;
		// the units wait for the answer: placement treats a unit with an open taxonomy question as unplaced
		for (const u of units) d.ledger.updateUnit(u.id, { meta: { taxonomyQuestion: q.id } });
	}
	addPlacementRules(d.root, rules);
	log(`areas: ${mappings.length} mapped, ${applied} applied, ${asked} asked; ${(j.stacks ?? []).map((s) => `${s.stack} ${s.areas.length} areas`).join(", ")}`);
	return { applied, asked, areas: Object.fromEntries((j.stacks ?? []).map((s) => [s.stack, s.areas.map((a) => a.name)])), costUsd: cost };
}

/** Answered taxonomy questions → placement (apply), unchanged (keep) or excluded units. */
export function syncTaxonomyAnswers(d: Pick<Deps, "ledger" | "root">): number {
	const rows = d.ledger.db.prepare("SELECT id, meta FROM units WHERE json_extract(meta,'$.taxonomyQuestion') IS NOT NULL").all() as Array<{ id: string; meta: string }>;
	let n = 0;
	const rules: Array<{ prefix: string; area: string; stack?: string; shared?: boolean }> = [];
	const excluded: Record<string, string> = {};
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
			const why = `excluded by the owner (question #${q.id}): ${m.why}`;
			for (const f of meta.files ?? []) {
				d.ledger.markRegenerated(f, why);
				excluded[f] = why;
			}
			d.ledger.updateUnit(r.id, { meta: { taxonomyQuestion: undefined, exclude: { question: q.id, why: m.why } } });
		}
		else d.ledger.updateUnit(r.id, { meta: { taxonomyQuestion: undefined, taxonomyKeep: q.id } }); // keep is remembered: never re-asked
		n++;
	}
	addPlacementRules(d.root, rules);
	if (Object.keys(excluded).length) {
		// persisted with the owner's decisions so a re-inventory keeps the disposition
		const p = join(d.root, ".bigrefactor", "decisions.json");
		const file = loadDecisions(d.root) as ReturnType<typeof loadDecisions> & { excluded?: Record<string, string> };
		file.excluded = { ...file.excluded, ...excluded };
		writeFileSync(p, JSON.stringify(file, null, 2) + "\n");
	}
	return n;
}

/** Why a unit may not run because of the taxonomy (undefined = free to run). */
export function taxonomyHold(metaJson: string): string | undefined {
	const m = JSON.parse(metaJson) as Meta & { taxonomyQuestion?: number };
	if (m.exclude) return `excluded from the migration (question #${m.exclude.question}: ${m.exclude.why})`;
	if (m.taxonomyQuestion) return `waits for area question #${m.taxonomyQuestion}`;
	return undefined;
}

function unitsOf(ledger: Ledger, key: string): Array<{ id: string; meta: string }> {
	const [stack, rest] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
	const shared = rest.startsWith("shared/");
	const area = shared ? rest.slice(7) : rest;
	// only units that have not started move: migrated code is never relabelled behind the ledger's back
	return ledger.db.prepare("SELECT id, meta FROM units WHERE state = 'planned' AND json_extract(meta,'$.place.stack') = ? AND json_extract(meta,'$.place.area') = ? AND COALESCE(json_extract(meta,'$.place.shared'), 0) = ?").all(stack, area, shared ? 1 : 0) as Array<{ id: string; meta: string }>;
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
