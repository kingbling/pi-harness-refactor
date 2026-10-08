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
 * rule covers are left to Jev, one unit at a time. The result is kept in `.bigrefactor/areas.json` for review.
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

type Meta = { files?: string[]; lane?: string; route?: { has_ui?: number }; place?: { stack: string; area: string; shared: boolean; source: string }; exclude?: { question: number; why: string }; taxonomyQuestion?: number; taxonomyKeep?: number };

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

export async function curateAreas(d: Deps, opts: { log?: (s: string) => void } = {}): Promise<{ applied: number; moved: number; asked: number; areas: Record<string, string[]>; costUsd: number }> {
	const log = opts.log ?? (() => {});
	const none = { applied: 0, moved: 0, asked: 0, areas: {}, costUsd: 0 };
	if (!d.client) return none;
	const units = (d.ledger.db.prepare("SELECT id, state, deps, meta FROM units").all() as Array<{ id: string; state: string; deps: string; meta: string }>)
		.map((u) => ({ ...u, m: JSON.parse(u.meta) as Meta }))
		.filter((u) => u.m.files?.length && u.m.lane !== "db" && !u.m.exclude); // the DB lane is no feature area
	if (!units.length) return none;
	const areas = currentAreas(d.ledger);
	// idempotent: when every feature area is already in the curated set (and no area question is pending), nothing to do
	const prev = existsSync(areasPath(d.root)) ? (JSON.parse(readFileSync(areasPath(d.root), "utf8")) as { stacks?: Array<{ stack: string; areas: Array<{ name: string }> }> }) : undefined;
	const curated = new Set((prev?.stacks ?? []).flatMap((s) => s.areas.map((a) => `${s.stack}:${kebab(a.name)}`)));
	if (prev && areas.every((a) => a.shared || a.fixed || curated.has(`${a.stack}:${a.area}`))) return { ...none, areas: Object.fromEntries((prev.stacks ?? []).map((s) => [s.stack, s.areas.map((a) => a.name)])) };
	const source = getSourceAdapter(d.config.source.stack);
	const surfaceOf = (f: string) => source.placeFile?.(f, d.config.source.path)?.surface;
	const brief = await repoBrief(d);
	const role = d.config.models.escalate;
	const res = await d.client.chat({
		model: role.id,
		tier: role.tier as "default" | "flex" | "priority",
		effort: "high",
		schema: {
			type: "object",
			additionalProperties: false,
			required: ["stacks", "rules"],
			properties: {
				stacks: { type: "array", items: { type: "object", additionalProperties: false, required: ["stack", "areas"], properties: { stack: { type: "string" }, areas: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "purpose"], properties: { name: { type: "string" }, purpose: { type: "string" } } } } } } },
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
- Utilities, base classes, formatting, pagination, clocks, HTTP helpers → "shared" with a topic (dates, http, formatting, pagination, errors …).
- Server logic (models, data access, commands, jobs, mail rendering) belongs on the server stack; pages, templates, widgets and client scripts on the UI stack. Where the tree shows a ui/server fact for a folder, that fact decides the stack; your stack is used only where it shows none.
- Answer with prefix rules. A prefix ending in "/" covers the whole folder; any other prefix covers the files whose name starts with it up to a "." (\`app/model/classes/campaign\` covers campaign.model.php and campaign.facade.php, not campaigns.model.php). The longest matching prefix wins: a folder rule plus file rules for the exceptions is enough.
- Folders that hold one kind of file for all features (models, components, helpers, controllers) need file rules: use the names and the "used from" counts (which folders' code uses the file, ×n) to put each file with the feature that uses it; used by many features → shared.
- Write a rule only where you are sure; another model places the files no rule covers one at a time.
- "exclude" only for things that are not application behaviour to migrate (static-analysis stubs, entry/bootstrap scripts the new framework replaces); these are confirmed by the owner.
- Areas placed so far are listed with their units; FIXED areas stay as they are (keep their files there), others may be renamed or merged. confidence = how sure you are (0–1).`,
			},
			{ role: "user", content: `Repo brief:\n${brief.brief.slice(0, 6000)}\n\nLegacy folder tree (folder, files, ui/server fact; then each file name up to its first dot, ← used from folder ×n):\n${treeFacts(units, surfaceOf)}\n\nAreas placed so far (key, units, sample files):\n${areas.map((a) => `${a.key}  ${a.units}  ${a.files.join(", ")}${a.fixed ? `  FIXED (${a.fixed})` : ""}`).join("\n") || "none yet"}` },
		],
	});
	let cost = brief.costUsd + res.usage.costUsd;
	const j = (res.json ?? {}) as { stacks?: Array<{ stack: string; areas: Array<{ name: string; purpose: string }> }>; rules?: AreaRule[] };
	const files = units.flatMap((u) => u.m.files!);
	// guards: a rule must cover a real file of the inventory and name a target stack
	const rules = (j.rules ?? []).map((r) => ({ ...r, prefix: r.prefix.replace(/^\.\//, ""), area: kebab(r.area) })).filter((r) => r.prefix && (r.area || r.to === "exclude") && d.config.target.stacks.includes(r.stack) && files.some((f) => covers(r.prefix, f)));
	const out = { stacks: j.stacks ?? [], rules, at: new Date().toISOString(), by: res.usage.model };
	mkdirSync(dirname(areasPath(d.root)), { recursive: true });
	writeFileSync(areasPath(d.root), JSON.stringify(out, null, 2) + "\n");

	// confident rules: code applies them; the stack only where the adapter knows no surface for the covered files
	const write: PlacementRule[] = rules
		.filter((r) => r.to !== "exclude" && r.confidence >= ACT)
		.map((r) => ({ prefix: r.prefix, area: r.area, ...(files.some((f) => covers(r.prefix, f) && surfaceOf(f)) ? {} : { stack: r.stack }), ...(r.to === "shared" ? { shared: true } : {}) }));
	setTaxonomyRules(d.root, write);

	// planned units the rules now cover move there; answers, owner keeps, open questions and FIXED areas stay
	const fixed = new Set(areas.filter((a) => a.fixed).map((a) => a.key));
	let moved = 0;
	for (const u of units) {
		const p = u.m.place;
		if (u.state !== "planned" || !p || p.source === "answer" || u.m.taxonomyKeep || u.m.taxonomyQuestion || fixed.has(`${p.stack}:${p.shared ? "shared/" : ""}${p.area}`)) continue;
		const c = codePlace(d.config, { files: u.m.files, route: u.m.route }, d.root);
		if (c.unsure || c.place.source !== "override" || (c.place.stackId === p.stack && c.place.area === p.area && c.place.shared === p.shared)) continue;
		d.ledger.updateUnit(u.id, { meta: { place: { stack: c.place.stackId, area: c.place.area, shared: c.place.shared, source: "taxonomy" } } });
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
	log(`areas: ${rules.length} rules from the folder tree, ${write.length} applied, ${moved} unit(s) moved, ${asked} asked; ${(j.stacks ?? []).map((s) => `${s.stack} ${s.areas.length} areas`).join(", ")}`);
	return { applied: write.length, moved, asked, areas: Object.fromEntries((j.stacks ?? []).map((s) => [s.stack, s.areas.map((a) => a.name)])), costUsd: cost };
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

function addPlacementRules(root: string, add: Array<{ prefix: string; area: string; stack?: string; shared?: boolean }>): void {
	if (!add.length) return;
	const file = join(root, ".bigrefactor", "placement.json");
	const cur = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { rules?: Array<{ prefix: string }> }).rules ?? [] : [];
	const byPrefix = new Map(cur.map((r) => [r.prefix, r]));
	for (const r of add) byPrefix.set(r.prefix, r);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify({ rules: [...byPrefix.values()] }, null, 2) + "\n");
}
