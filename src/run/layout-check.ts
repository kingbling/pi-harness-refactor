import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { getSourceAdapter, getTargetAdapter } from "../adapters/registry.ts";
import type { TargetAdapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import { projectDir } from "../init/init.ts";
import type { Ledger } from "../ledger/db.ts";
import { stackTagLike } from "../inventory/target.ts";
import { activeRuleFiles, rulesDir, validateRulesLayout } from "../rules/layout.ts";
import { layoutRulesProblem, scaffoldDirs } from "../rules/layout-rules.ts";
import { kebab } from "./areas.ts";
import { placementDir, planPlacements, type Placement } from "./placement.ts";

/**
 * Layout preflight: catches "one folder per legacy file" before a run scales it, and right after (sample pause).
 *
 *   placement  dry run over every unit: area names, ui units on a server stack, areas that look like file names
 *   rules      RULES.md layout section == adapter layout (validateRulesLayout)
 *   tree       the target as it is now: top-level dirs under the source root other than the feature root,
 *              the shared dirs, scaffold dirs (root commit) and dirs without source files
 *   lint       every stack has active ast-grep rules (rules_ok checks something)
 *   drift      the whole tree against structureDoc (checkTree; also recorded after every accept: driftReport)
 *
 * problems block `br run` (unless --force); warnings are shown.
 */
export interface StackTree {
	stackId: string;
	dir: string;
	/** Feature root relative to the project, e.g. the parent of moduleDir(area). */
	moduleRoot: string;
	features: Array<{ area: string; files: number }>;
	/** Files in the shared dirs, relative to the project. */
	shared: string[];
	/** Top-level dirs that are no module root (with source files in them). */
	stray: string[];
	srcRoot: string;
}
export interface LayoutSummary {
	units: number;
	perStack: Record<string, number>;
	/** `stack:area` / `stack:shared/area` → units, biggest first. */
	modules: Array<{ key: string; units: number }>;
	areas: number;
	shared: number;
	unresolved: number;
	openQuestions: number;
	trees: StackTree[];
	/** stack → checkTree findings of the tree as it is now. */
	drift: Record<string, string[]>;
	/** Units whose files render UI (source adapter): [placed on a ui stack, placed elsewhere]. */
	uiUnits: [number, number];
}
export interface LayoutReport {
	problems: string[];
	warnings: string[];
	summary: LayoutSummary;
}

const AREA = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Shape ratios say nothing about a handful of units. */
const MIN_UNITS = 10;
const EX = 6;
const examples = (xs: string[]) => xs.slice(0, EX).join(", ") + (xs.length > EX ? ", …" : "");

export async function checkLayout(config: Config, root: string, ledger: Ledger): Promise<LayoutReport> {
	const problems: string[] = [];
	const warnings: string[] = [];
	const adapters = await Promise.all(config.target.stacks.map((s) => getTargetAdapter(s)));
	const source = getSourceAdapter(config.source.stack);
	const role = new Map(adapters.map((a) => [a.id, a.role]));
	const uiStack = adapters.find((a) => a.role === "ui")?.id;

	// ---- (a) placement dry run (persisted placements win, the rest is code's pick)
	const units = ledger.listUnits();
	const plan = planPlacements(config, units, root);
	const perStack: Record<string, number> = {};
	const mods = new Map<string, number>();
	const badNames = new Set<string>();
	const fileNamed: string[] = [];
	const misplaced: string[] = [];
	/** Units whose files the source adapter calls UI: [on a ui stack, elsewhere]. */
	const uiUnits: [number, number] = [0, 0];
	let unresolved = 0;
	let unasked = 0;
	let shared = 0;
	let placed = 0;
	for (const u of units) {
		const p = plan.get(u.id)!;
		if (!p.stored && p.unsure) {
			unresolved++;
			const q = (JSON.parse(u.meta) as { placeQuestion?: number }).placeQuestion;
			if (!q || ledger.getQuestion(q)?.status !== "open") unasked++;
			continue;
		}
		const { stackId, area } = p.place;
		placed++;
		perStack[stackId] = (perStack[stackId] ?? 0) + 1;
		const key = `${stackId}:${p.place.shared ? "shared/" : ""}${area}`;
		mods.set(key, (mods.get(key) ?? 0) + 1);
		if (p.place.shared) shared++;
		if (!AREA.test(area)) badNames.add(area);
		const files = (JSON.parse(u.meta) as { files?: string[] }).files ?? [];
		if (files.some((f) => stems(f).includes(area))) fileNamed.push(`${u.id} → ${area}`);
		// a human (override, answer) may put ui code on a server stack on purpose
		const isUi = files.length > 0 && files.filter((f) => source.placeFile?.(f, config.source.path)?.surface === "ui").length * 2 > files.length;
		if (isUi) uiUnits[role.get(stackId) === "ui" ? 0 : 1]++;
		if (isUi && uiStack && role.get(stackId) !== "ui" && p.place.source !== "override" && p.place.source !== "answer") misplaced.push(`${u.id} → ${stackId}`);
	}
	const modules = [...mods].map(([key, n]) => ({ key, units: n })).sort((a, b) => b.units - a.units || a.key.localeCompare(b.key));
	const single = modules.filter((m) => m.units === 1);
	if (badNames.size) problems.push(`${badNames.size} area name(s) are not kebab-case (an area is a legacy feature, not a file name): ${examples([...badNames])}`);
	if (placed >= MIN_UNITS && fileNamed.length * 2 > placed) problems.push(`areas look like file names: ${fileNamed.length}/${placed} units sit in an area named after their own file (${examples(fileNamed)})`);
	if (placed >= MIN_UNITS && single.length * 2 > modules.length) problems.push(`areas look like file names: ${single.length}/${modules.length} modules hold a single unit (${examples(single.map((m) => m.key))})`);
	if (misplaced.length) problems.push(`${misplaced.length} unit(s) whose files render UI are placed on a server stack while ${uiStack} exists: ${examples(misplaced)} (br place --force, or a placement.json rule)`);
	const openQuestions = ledger.openQuestions().filter((q) => q.point === "placement").length;
	if (unresolved) warnings.push(`${unresolved} unit(s) without a placement yet, ${unasked} not asked yet (code unsure; they wait, never run on a guess; br place asks Jev, then you)`);
	if (openQuestions) warnings.push(`${openQuestions} placement question(s) open (br questions); only their units wait`);

	// ---- (b) the feature-folder layout is decided and readable; rules layout == adapter layout
	for (const s of config.target.stacks) {
		const bad = layoutRulesProblem(root, s);
		if (bad) problems.push(`${s}: layout.json cannot be used as written (${bad}); fix it or /br rule`);
		else if (!existsSync(join(rulesDir(root, s), "layout.json"))) warnings.push(`${s}: no folder layout decided yet: only the built-in checks apply (br onboard asks; /br rule changes it)`);
	}
	problems.push(...(await validateRulesLayout(root, config)));

	// ---- (c) the target tree as it is now
	const trees = adapters.map((a) => scanTree(config, a));
	for (const [i, t] of trees.entries()) {
		if (t.stray.length) problems.push(`${t.stackId}: ${t.stray.length} folder(s) under ${t.srcRoot}/ outside ${t.moduleRoot} and the shared dirs: ${examples(t.stray.map((d) => `${d}/`))}`);
		const bad = t.features.filter((f) => !isAreaFolder(adapters[i]!.layout, f.area)).map((f) => f.area);
		if (bad.length) problems.push(`${t.stackId}: ${bad.length} feature folder(s) under ${t.moduleRoot} are not area names: ${examples(bad)}`);
	}

	// ---- (d) rules_ok has something to check
	// once RULES.md exists, a stack without a single active rule means rules_ok would pass everything
	for (const s of config.target.stacks) {
		if (activeRuleFiles(root, s).length) continue;
		if (existsSync(join(rulesDir(root, s), "RULES.md"))) problems.push(`${s}: RULES.md exists but no active ast-grep rule: rules_ok would check nothing (br rules)`);
		else warnings.push(`${s}: no active ast-grep rules (rules_ok checks nothing; br rules)`);
	}

	// ---- (e) drift: naming, size, one class per responsibility over the whole tree (stray folders are problems above)
	const drift: Record<string, string[]> = {};
	for (const a of adapters) {
		const lines = (drift[a.id] = checkTree(projectDir(config, a.id), a));
		const own = lines.filter((l) => !l.endsWith(STRAY));
		if (own.length) warnings.push(`${a.id}: ${own.length} drift finding(s) in the tree (${examples(own)})`);
	}

	return { problems, warnings, summary: { units: units.length, perStack, modules, areas: new Set(modules.map((m) => m.key.split(":")[1]!.replace(/^shared\//, ""))).size, shared, unresolved, openQuestions, trees, drift, uiUnits } };
}

/** `a/b/list.view.x` → ["list", "list.view"]: names an area must not have. */
function stems(file: string): string[] {
	const b = basename(file);
	return [kebab(b.split(".")[0]!), b.replace(/\.[^.]+$/, "")];
}

/** One stack's project as it is: feature dirs with file counts, shared files, and dirs that are no module root. */
/** A feature folder is an area when the layout writes some kebab-case area that way (Metadata ← metadata, audit_history ← audit-history). */
export function isAreaFolder(l: { moduleDir(area: string): string }, folder: string): boolean {
	const area = folder.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/_/g, "-").toLowerCase();
	return AREA.test(area) && l.moduleDir(area) === `${moduleRootOf(l)}${folder}`;
}

/** The feature root: what comes before the area in moduleDir, in whatever case the layout writes the area ({area}, {Area}, {area_snake}). */
export function moduleRootOf(l: { moduleDir(area: string): string }): string {
	const probe = l.moduleDir("brprobe");
	const at = probe.toLowerCase().lastIndexOf("brprobe");
	return at >= 0 ? probe.slice(0, at) : probe.replace(/[^/]*$/, "");
}

export function scanTree(config: Config, a: TargetAdapter): StackTree {
	return scanDir(projectDir(config, a.id), a);
}

function scanDir(dir: string, a: TargetAdapter): StackTree {
	const l = a.layout;
	const ig = l.ignoreDirs;
	const moduleRoot = moduleRootOf(l);
	const parts = moduleRoot.split("/").filter(Boolean);
	const srcRoot = parts.slice(0, -1).join("/");
	// feature folders straight under the source root (src/{area}): the shared, data and scaffold folders there are no areas
	const notAreas = new Set<string>();
	if (parts.length === 1) {
		for (const d of [...l.sharedDirs, ...(l.dataDirs ?? [])]) if (d.startsWith(moduleRoot)) notAreas.add(d.slice(moduleRoot.length).split("/")[0]!);
		for (const d of scaffoldDirs(dir, parts[0]!)) notAreas.add(d);
	}
	const features = listDirs(join(dir, moduleRoot), ig).filter((d) => !notAreas.has(d)).map((area) => ({ area, files: walk(join(dir, moduleRoot, area), ig).length }));
	const shared = l.sharedDirs.flatMap((s) => walk(join(dir, s), ig).map((f) => posix.join(s, f)));
	let stray: string[] = [];
	if (srcRoot) {
		const top = (p: string) => (p.startsWith(`${srcRoot}/`) ? p.slice(srcRoot.length + 1).split("/") : []);
		const allowed = new Set<string>([parts.at(-1)!, ...scaffoldDirs(dir, srcRoot)]);
		// shared dirs are dirs with or without a trailing slash; generated entries are files (their folder counts)
		for (const p of l.sharedDirs) {
			const t = top(p.replace(/\/?$/, "/"));
			if (t[0]) allowed.add(t[0]);
		}
		for (const p of a.generatedFiles) {
			const t = top(p);
			if (t.length > 1 && t[0]) allowed.add(t[0]);
		}
		const isSource = (f: string) => l.sourceExtensions.some((e) => f.endsWith(e));
		stray = listDirs(join(dir, srcRoot), ig).filter((d) => !allowed.has(d) && walk(join(dir, srcRoot, d), ig).some(isSource));
	}
	return { stackId: a.id, dir, moduleRoot, features, shared, stray, srcRoot };
}

const STRAY = "outside the feature root, the shared dirs and the scaffold";

/**
 * Whole-tree drift of one stack project, one `<project-relative path>: <finding>` per line: the adapter's findings
 * (naming per structureDoc, size cap, one class per responsibility) + source folders outside the feature root, the
 * shared dirs and the scaffold. `only` limits the adapter's findings to those files (the gate) and skips the folders.
 */
export function checkTree(dir: string, a: TargetAdapter, only?: string[]): string[] {
	const lines = a.layout.checkTree?.(dir, only) ?? [];
	if (only) return lines;
	const t = scanDir(dir, a);
	return [...lines, ...t.stray.map((d) => `${t.srcRoot}/${d}/: ${STRAY}`)];
}

/** After an accept: the stack's drift findings, stored line-oriented in ledger meta `drift:<stackId>` (tidy reads it). */
export function recordDrift(ledger: Ledger, a: TargetAdapter, dir: string): string[] {
	const lines = checkTree(dir, a);
	ledger.setMeta(`drift:${a.id}`, lines.join("\n"));
	ledger.setMeta(`drift_dirs:${a.id}`, JSON.stringify({ moduleRoot: moduleRootOf(a.layout), sharedDirs: a.layout.sharedDirs }));
	return lines;
}

/** Recorded drift of one stack, optionally only the lines about one area (its module dir or shared dir for it). */
export function driftReport(ledger: Ledger, stackId: string, area?: string): string[] {
	const lines = (ledger.getMeta(`drift:${stackId}`) ?? "").split("\n").filter(Boolean);
	if (!area) return lines;
	const d = JSON.parse(ledger.getMeta(`drift_dirs:${stackId}`) ?? "{}") as { moduleRoot?: string; sharedDirs?: string[] };
	const dirs = [d.moduleRoot, ...(d.sharedDirs ?? [])].filter(Boolean).map((r) => `${r}${area}/`);
	return lines.filter((l) => dirs.some((p) => l.startsWith(p)));
}

function listDirs(dir: string, ignore: string[]): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && !e.name.startsWith(".") && !ignore.includes(e.name))
			.map((e) => e.name)
			.sort();
	} catch {
		return [];
	}
}

/** Files under a dir, relative to it (no dot dirs, none of the stack's ignored dirs). */
function walk(dir: string, ignore: string[], rel = ""): string[] {
	let out: string[] = [];
	let names: string[];
	try {
		names = readdirSync(join(dir, rel));
	} catch {
		return out;
	}
	for (const n of names) {
		if (n.startsWith(".") || ignore.includes(n)) continue;
		const r = rel ? `${rel}/${n}` : n;
		let isDir = false;
		try {
			isDir = statSync(join(dir, r)).isDirectory();
		} catch {
			continue;
		}
		if (isDir) out = out.concat(walk(dir, ignore, r));
		else out.push(r);
	}
	return out;
}

/**
 * Sample review facts: every landed module dir with its files and their exported classes (index), and the drift
 * code finds in the whole tree (parallel classes in an area show there). `drift` > 0 = recommend stopping.
 */
export async function sampleFacts(config: Config, ledger: Ledger, landed: Placement[]): Promise<{ lines: string[]; drift: number }> {
	const lines: string[] = [];
	let drift = 0;
	for (const id of config.target.stacks) {
		const a = await getTargetAdapter(id);
		const dir = projectDir(config, id);
		const found = checkTree(dir, a);
		drift += found.length;
		const classes = ledger.db.prepare("SELECT path, kind, name FROM index_symbols WHERE side = 'target' AND tags LIKE '%\"class\"%' AND tags LIKE ?").all(stackTagLike(id)) as Array<{ path: string; kind: string; name: string }>;
		for (const mod of [...new Set(landed.filter((p) => p.stackId === id).map((p) => placementDir(a.layout, p)))].sort()) {
			const files = walk(join(dir, mod), a.layout.ignoreDirs).filter((f) => !a.layout.isTestFile(f)).sort();
			const show = (f: string) => {
				const c = classes.filter((r) => r.path === `${mod}/${f}`).map((r) => `${r.kind} ${r.name}`);
				return c.length ? `${f} [${c.join(", ")}]` : f;
			};
			lines.push(`  ${id} ${mod}/: ${files.slice(0, 30).map(show).join("; ") || "(empty)"}${files.length > 30 ? ` … +${files.length - 30}` : ""}`);
		}
		if (found.length) lines.push(`Drift found by code in ${id} (${found.length}):`, ...found.slice(0, 40).map((l) => `  ${l}`));
	}
	return { lines, drift };
}

/** Per-stack target tree in a few lines (sample review, `br layout`). */
export function renderTrees(trees: StackTree[], max = 30): string[] {
	const L: string[] = [];
	for (const t of trees) {
		const files = t.features.reduce((s, f) => s + f.files, 0);
		L.push(`${t.stackId} (${t.dir}): ${t.features.length} feature folder(s) under ${t.moduleRoot} with ${files} file(s), ${t.shared.length} shared file(s)`);
		const fs = [...t.features].sort((a, b) => b.files - a.files);
		if (fs.length) L.push(`  features: ${fs.slice(0, max).map((f) => `${f.area}(${f.files})`).join(" ")}${fs.length > max ? ` … +${fs.length - max}` : ""}`);
		if (t.shared.length) L.push(`  shared: ${t.shared.slice(0, max).join(" ")}${t.shared.length > max ? ` … +${t.shared.length - max}` : ""}`);
		if (t.stray.length) L.push(`  outside the layout: ${t.stray.slice(0, max).map((d) => `${t.srcRoot}/${d}/`).join(" ")}${t.stray.length > max ? ` … +${t.stray.length - max}` : ""}`);
	}
	return L;
}

/** `br layout` / onboarding / Pi: summary, top areas, problems, warnings. */
export function renderLayout(r: LayoutReport, top = 20): string[] {
	const s = r.summary;
	const L = [`units ${s.units}: ${Object.entries(s.perStack).map(([k, n]) => `${k} ${n}`).join(", ") || "none placed"}${s.unresolved ? `, ${s.unresolved} unplaced` : ""} · ${s.modules.length} modules, ${s.areas} areas, ${s.shared} shared units`];
	if (s.uiUnits[0] + s.uiUnits[1]) L.push(`ui units (files render UI): ${s.uiUnits[0]} on a ui stack, ${s.uiUnits[1]} elsewhere`);
	if (s.modules.length) {
		L.push("top modules:");
		const w = Math.max(...s.modules.slice(0, top).map((m) => m.key.length));
		for (const m of s.modules.slice(0, top)) L.push(`  ${m.key.padEnd(w)}  ${String(m.units).padStart(4)}`);
		if (s.modules.length > top) L.push(`  … ${s.modules.length - top} more (${s.modules.filter((m) => m.units === 1).length} with a single unit)`);
	}
	L.push("target now:", ...renderTrees(s.trees, 12).map((l) => `  ${l}`));
	for (const [stack, all] of Object.entries(s.drift ?? {})) {
		const lines = all.filter((l) => !l.endsWith(STRAY)); // stray folders are listed above
		if (!lines.length) continue;
		L.push(`drift ${stack}: ${lines.length} finding(s)`, ...lines.slice(0, 15).map((l) => `  ${l}`));
		if (lines.length > 15) L.push(`  … ${lines.length - 15} more`);
	}
	for (const w of r.warnings) L.push(`warning: ${w}`);
	for (const p of r.problems) L.push(`problem: ${p}`);
	L.push(r.problems.length ? `${r.problems.length} layout problem(s): br run refuses to start (fix them, or br run --force)` : "layout ok");
	return L;
}
