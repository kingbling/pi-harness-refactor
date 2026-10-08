import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { StructureContext, TargetAdapter } from "../adapters/types.ts";

/**
 * The feature-folder layout of one stack as DATA: `.bigrefactor/rules/<stack>/layout.json`. Decided at onboarding
 * from the framework's own conventions (the adapter proposes, the owner confirms or changes it in plain words) and
 * changed mid-run with `/br rule`. One plain checker enforces it in the gate (structure_ok) and in the whole-tree
 * drift check; no model decides pass or fail. The file is read when a check runs, so a rule saved mid-run applies
 * to the next unit. Without a layout.json a stack keeps its built-in checks, plus the banned folder names.
 *
 * Path patterns (relative to the feature folder):
 *   {area} {Area} {area_snake}  the unit's area (kebab, Pascal, snake case)
 *   {name} {Name}               any kebab-case / PascalCase name
 *   {sub}                       one folder named after what the code does, spelled like the area folders ({area} → kebab,
 *                               {Area} → Pascal, {area_snake} → snake); the same value where it repeats; never a banned
 *                               name or a folder another pattern names literally (dto, entities …)
 *   (a|b)                       either word
 */
export interface LayoutRules {
	/** Feature folder of one area, relative to the project; the area placeholder is its last part (src/{area}). */
	moduleDir: string;
	/** The only files allowed inside a feature folder. */
	files: Array<{ path: string; doc: string }>;
	/** Files every feature folder has. */
	require: string[];
	/** Folder names never allowed inside a feature folder or as a shared topic. */
	forbidDirs: string[];
	/** Code (a regex on the file text) that may only live in some files. */
	place: Array<{ text: string; in: string[]; doc: string }>;
	/** Line cap per source file (stacks with their own per-file checks keep theirs). */
	maxLines?: number;
	/** Where the layout comes from, shown to the owner ("NestJS docs: nest g resource", "owner"). */
	source?: string;
}

/** Banned folder names on every stack: names that say nothing about what the code does. */
/** Catch-all folder names the layout writer is told to consider banning; a stack whose convention uses one (Angular core/) keeps it. */
export const DEFAULT_FORBID_DIRS = ["extended", "misc", "common", "helpers", "utils", "other", "core"];

const KEBAB = "[a-z0-9]+(?:-[a-z0-9]+)*";
const PASCAL = "[A-Z][A-Za-z0-9]*";
const SNAKE = "[a-z0-9]+(?:_[a-z0-9]+)*";

/** How a {sub} folder is spelled: like the layout's own area folders (src/{Area} → Pascal sub-folders). */
export interface SubStyle { re: string; sample: string; word: string }
const SUB_STYLES: Record<string, SubStyle> = {
	area: { re: KEBAB, sample: "billing", word: "kebab-case" },
	Area: { re: PASCAL, sample: "Billing", word: "PascalCase" },
	area_snake: { re: SNAKE, sample: "billing", word: "snake_case" },
};
export function subStyle(moduleDir: string): SubStyle {
	const last = /\{(area|Area|area_snake)\}\/?$/.exec(moduleDir)?.[1] ?? "area";
	return SUB_STYLES[last]!;
}
const GROUP: Record<string, string> = { name: "n", Name: "N", sub: "sub" };
const PLACEHOLDERS = new Set(["area", "Area", "area_snake", "name", "Name", "sub"]);
const pascal = (s: string) => s.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function layoutRulesPath(root: string, stackId: string): string {
	return join(root, ".bigrefactor", "rules", stackId, "layout.json");
}

// ---- patterns ----------------------------------------------------------------------------------------------

type Matcher = { test(rel: string): boolean; pattern: string };

/** A path pattern for one area → matcher. Throws on an unknown placeholder or a malformed group. */
export function compilePattern(pattern: string, area: string, reserved: Set<string> = new Set(), sub: SubStyle = SUB_STYLES["area"]!): Matcher {
	let src = "";
	const seen = new Set<string>(); // {name} {Name} {sub} repeated in one path = the same value
	for (const m of pattern.matchAll(/\{([^}]*)\}|\(([^)]*)\)|([^{(]+)|(.)/g)) {
		if (m[1] !== undefined) {
			if (!PLACEHOLDERS.has(m[1])) throw new Error(`unknown placeholder {${m[1]}} in "${pattern}" (use ${[...PLACEHOLDERS].map((p) => `{${p}}`).join(" ")})`);
			if (m[1] === "area") src += esc(area);
			else if (m[1] === "Area") src += esc(pascal(area));
			else if (m[1] === "area_snake") src += esc(area.replace(/-/g, "_"));
			else src += seen.has(m[1]) ? `\\k<${GROUP[m[1]]}>` : (seen.add(m[1]), `(?<${GROUP[m[1]]}>${m[1] === "Name" ? PASCAL : m[1] === "sub" ? sub.re : KEBAB})`);
		} else if (m[2] !== undefined) {
			const words = m[2].split("|");
			if (words.some((w) => !/^[A-Za-z0-9_.-]+$/.test(w))) throw new Error(`"(${m[2]})" in "${pattern}": only plain words separated by |`);
			src += `(?:${words.map(esc).join("|")})`;
		} else if (m[3] !== undefined) src += esc(m[3]);
		else throw new Error(`unbalanced "${m[4]}" in "${pattern}"`);
	}
	const re = new RegExp(`^${src}$`);
	return {
		pattern,
		test: (rel) => {
			const x = re.exec(rel);
			return !!x && !(x.groups?.["sub"] && reserved.has(x.groups["sub"].toLowerCase()));
		},
	};
}

/** A concrete example path for a pattern (area invoice, name sample, sub billing in the layout's spelling). */
export function samplePath(pattern: string, area = "invoice", sub = "billing"): string {
	return pattern
		.replace(/\{area\}/g, area)
		.replace(/\{Area\}/g, pascal(area))
		.replace(/\{area_snake\}/g, area.replace(/-/g, "_"))
		.replace(/\{name\}/g, "sample")
		.replace(/\{Name\}/g, "Sample")
		.replace(/\{sub\}/g, sub)
		.replace(/\(([^)|]*)(\|[^)]*)?\)/g, "$1");
}

/** `src/{area}` → `src/invoice`. */
export function expandModuleDir(r: LayoutRules, area: string): string {
	return r.moduleDir.replace(/\{area\}/g, area).replace(/\{Area\}/g, pascal(area)).replace(/\{area_snake\}/g, area.replace(/-/g, "_"));
}

/** Banned folder names compare without case (Extended/ is as bad as extended/). */
const banned = (r: LayoutRules, d: string) => r.forbidDirs.some((b) => b.toLowerCase() === d.toLowerCase());
const KEBAB_RE = new RegExp(`^${KEBAB}$`);

/** First folders other patterns name literally (dto, entities …) plus the banned names: never a {sub} (lower case). */
function reservedSubs(r: LayoutRules): Set<string> {
	const out = new Set(r.forbidDirs.map((d) => d.toLowerCase()));
	for (const f of r.files) {
		const first = f.path.split("/")[0]!;
		if (f.path.includes("/") && /^[A-Za-z0-9_.-]+$/.test(first)) out.add(first.toLowerCase());
	}
	return out;
}

/** A pattern of these rules for one area ({sub} spelled like the rules' area folders). */
const compileFor = (r: LayoutRules, pattern: string, area: string) => compilePattern(pattern, area, reservedSubs(r), subStyle(r.moduleDir));
const sampleFor = (r: LayoutRules, pattern: string, area?: string) => samplePath(pattern, area, subStyle(r.moduleDir).sample);

/** Problems that make the rules unusable; empty = sound. Checked by code before a layout.json is written. */
export function validateLayoutRules(r: LayoutRules): string[] {
	const out: string[] = [];
	if (!r || typeof r.moduleDir !== "string" || !Array.isArray(r.files)) return ["layout rules need moduleDir and files"];
	const last = r.moduleDir.replace(/\/$/, "").split("/").at(-1) ?? "";
	if (!/^\{(area|Area|area_snake)\}$/.test(last)) out.push(`moduleDir "${r.moduleDir}" must end with {area}, {Area} or {area_snake}`);
	const parents = r.moduleDir.replace(/\/$/, "").split("/").slice(0, -1);
	if (!parents.length) out.push(`moduleDir "${r.moduleDir}" needs a parent folder (e.g. src/{area})`);
	if (parents.some((d) => /[{(]/.test(d))) out.push(`moduleDir "${r.moduleDir}": only the last folder may be a placeholder`);
	if (r.moduleDir.startsWith("/") || r.moduleDir.includes("..")) out.push(`moduleDir "${r.moduleDir}" must be a relative path inside the project`);
	if (!r.files.length) out.push("files: list the files a feature folder may hold");
	const ok: Matcher[] = [];
	for (const f of r.files) {
		if (f.path.startsWith("/") || f.path.includes("..")) out.push(`files: "${f.path}" must stay inside the feature folder`);
		try {
			const m = compileFor(r, f.path, "invoice");
			if (!m.test(sampleFor(r, f.path))) out.push(`files: the example ${sampleFor(r, f.path)} does not match its own pattern "${f.path}"`);
			ok.push(m);
		} catch (e: any) {
			out.push(`files: ${e.message}`);
		}
	}
	const allowed = (p: string) => ok.some((m) => m.test(p));
	for (const q of r.require ?? []) if (!allowed(sampleFor(r, q))) out.push(`require: "${q}" is not an allowed file (add it to files)`);
	for (const p of r.place ?? []) {
		try {
			new RegExp(p.text);
		} catch {
			out.push(`place: "${p.text}" is not a valid regex`);
		}
		for (const i of p.in) if (!allowed(sampleFor(r, i))) out.push(`place: "${i}" is not an allowed file (add it to files)`);
	}
	// a literal folder that is also banned would reject its own allowed files
	for (const x of [...r.files.map((f) => f.path), ...(r.require ?? []), ...(r.place ?? []).flatMap((p) => p.in)]) {
		const d = x.split("/").slice(0, -1).find((d) => !/[{(]/.test(d) && banned(r, d));
		if (d) out.push(`"${x}" uses the banned folder "${d}"; rename the folder or drop it from forbidDirs`);
	}
	// a folder that may be any name is a catch-all: a sub-feature folder is {sub} (named after what it does, never a banned name)
	for (const f of r.files) if (f.path.split("/").slice(0, -1).some((d) => /^\{(name|Name)\}$/.test(d) && !f.path.split("/").at(-1)!.startsWith(d))) out.push(`files: "${f.path}" allows a folder with any name; use {sub} for a sub-feature folder, a fixed folder name, or a folder named like its file ({Name}/{Name}.tsx)`);
	return out;
}

// ---- checks -------------------------------------------------------------------------------------------------

/** Problems of files relative to one feature folder (no I/O). */
function checkFiles(rels: string[], area: string, r: LayoutRules): string[] {
	const allowed = r.files.map((f) => compileFor(r, f.path, area));
	const out: string[] = [];
	for (const rel of rels) {
		const dirs = rel.split("/").slice(0, -1);
		const bad = dirs.find((d) => banned(r, d));
		if (bad) out.push(`folder "${bad}" is not allowed (banned names: ${r.forbidDirs.join(", ")}); name the folder after what the code does (e.g. creation/, tracking/)`);
		else if (!allowed.some((m) => m.test(rel))) out.push(`not an allowed file in the feature folder; allowed: ${r.files.map((f) => show(f.path, area)).join(" | ")}`);
	}
	return out;
}

const show = (pattern: string, area: string) => pattern.replace(/\{area\}/g, area).replace(/\{Area\}/g, pascal(area)).replace(/\{area_snake\}/g, area.replace(/-/g, "_")).replace(/\{(\w+)\}/g, "<$1>");

export interface LayoutCheckOptions {
	sharedDirs: string[];
	dataDirs?: string[];
	isTestFile(path: string): boolean;
	sourceExtensions?: string[];
	/** Stack-specific per-file findings (size, one class per file) that do not depend on the folder layout. */
	fileFindings?(projectDir: string, file: string, moduleDir?: string, area?: string): string[];
}

/** The gate: files a unit wrote (project-relative) against the rules. One `<path>: <problem>; <what to do>` per line. */
export function checkLayoutRules(files: string[], moduleDir: string, area: string, projectDir: string, r: LayoutRules, o: LayoutCheckOptions, ctx: StructureContext = {}, checkRequire = true): string[] {
	const mod = `${moduleDir.replace(/\/$/, "")}/`;
	const isNew = (f: string) => ctx.isNew?.(f) === true;
	const out: string[] = [];
	let touched = false;
	for (const f of files) {
		if (o.dataDirs?.some((d) => f.startsWith(d))) continue;
		const legacy = legacyWord(f, ctx.legacyWords);
		if (legacy && !o.isTestFile(f)) {
			out.push(`${f}: "${legacy}" is a legacy file kind; name files and classes after what they do, never after the legacy file`);
			continue;
		}
		const shared = o.sharedDirs.map(slashed).find((d) => f.startsWith(d));
		if (shared) {
			const parts = f.slice(shared.length).split("/");
			// a banned topic only for new files: shared code that is already there keeps working
			const bad = isNew(f) ? parts.slice(0, -1).find((d) => banned(r, d)) : undefined;
			if (parts.length < 2) out.push(`${f}: shared files go in ${shared}<topic>/<name>; put it in a topic folder named after what it does`);
			else if (bad) out.push(`${f}: shared topic "${bad}" is not allowed (banned names: ${r.forbidDirs.join(", ")}); name the topic after what the code does`);
			continue;
		}
		// tests go where the stack's test runner finds them (the adapter's test globs), inside the feature folder or not
		if (!f.startsWith(mod) && o.isTestFile(f)) continue;
		if (!f.startsWith(mod)) {
			out.push(`${f}: outside this unit's feature folder ${mod} and the shared dirs (${o.sharedDirs.join(", ")})`);
			continue;
		}
		touched = true;
		if (o.isTestFile(f) && !/\.d\.ts$/.test(f)) {
			const bad = f.slice(mod.length).split("/").slice(0, -1).find((d) => banned(r, d));
			if (bad) out.push(`${f}: folder "${bad}" is not allowed (banned names: ${r.forbidDirs.join(", ")}); name the folder after what the code does`);
			continue;
		}
		const shape = checkFiles([f.slice(mod.length)], area, r);
		for (const p of shape) out.push(`${f}: ${p}`);
		if (!shape.length && isNew(f) && !ctx.sanctioned?.includes(f)) {
			const p = parallelFile(projectDir, f, mod, area, r.maxLines ?? 400);
			if (p) out.push(p);
		}
		out.push(...placeProblems(projectDir, f, mod, area, r));
	}
	// the gate asks for the required files when a unit starts a feature folder; for older folders it is drift (tidy)
	const startsFolder = !ctx.isNew || listFiles(join(projectDir, mod)).every((x) => isNew(mod + x));
	if (touched && checkRequire && startsFolder) out.push(...missingRequired(projectDir, mod, area, r, files));
	return out;
}

/**
 * A NEW second file of a kind (`<area>-<x>.<kind>.<ext>`, flat in the feature folder) next to the area's main file
 * `<area>.<kind>.<ext>` needs a reason: both would not fit under the line cap, or a tidy task names it.
 */
function parallelFile(projectDir: string, f: string, mod: string, area: string, cap: number): string | undefined {
	// a sub-feature folder (creation/, tracking/) is its own responsibility; only a flat second file needs a reason
	if (f.slice(mod.length).includes("/")) return undefined;
	const m = new RegExp(`^${esc(area)}-${KEBAB}\\.([a-z]+)\\.([a-z]+)$`).exec(f.split("/").at(-1)!);
	if (!m) return undefined;
	const main = `${mod}${area}.${m[1]}.${m[2]}`;
	const lines = (x: string) => read(projectDir, x).replace(/\n$/, "").split("\n").length;
	if (!existsSync(join(projectDir, main))) return undefined;
	const n = lines(main);
	if (n + lines(f) > cap) return undefined;
	return `${f}: a parallel ${m[1]} next to ${main} (${n} lines); extend ${main} instead. A second ${m[1]} file only when both would not fit under ${cap} lines, or an approved cleanup task names it`;
}

/** `place`: code that may only live in some files (a Dto class outside dto/, a controller outside the controller file). */
function placeProblems(projectDir: string, f: string, mod: string, area: string, r: LayoutRules): string[] {
	if (!r.place?.length) return [];
	const text = read(projectDir, f);
	if (!text) return [];
	const rel = f.slice(mod.length);
	const out: string[] = [];
	for (const p of r.place) {
		const m = new RegExp(p.text, "m").exec(text);
		if (!m || p.in.some((i) => compileFor(r, i, area).test(rel))) continue;
		out.push(`${f}: "${m[0].trim()}" belongs in ${p.in.map((i) => show(i, area)).join(" or ")} (${p.doc}); move it there`);
	}
	return out;
}

/** Every feature folder has the required files (on disk or written by this unit). */
function missingRequired(projectDir: string, mod: string, area: string, r: LayoutRules, written: string[]): string[] {
	if (!r.require?.length) return [];
	const have = new Set([...listFiles(join(projectDir, mod)), ...written.filter((f) => f.startsWith(mod)).map((f) => f.slice(mod.length))]);
	return r.require.filter((q) => ![...have].some((h) => compileFor(r, q, area).test(h))).map((q) => `${mod}: missing ${show(q, area)} (every feature folder has ${r.require.map((x) => show(x, area)).join(", ")}); create it`);
}

/**
 * Whole tree (drift): every feature folder under the module root against the rules, the shared topics, and the
 * stack's per-file findings. `only` limits the findings to those files (the gate). Lines `<path>: <finding>`.
 */
export function checkLayoutTree(projectDir: string, r: LayoutRules, o: LayoutCheckOptions, only?: string[], notAreas: string[] = []): string[] {
	// files that came with the generated project (its first commit) are the framework's, never drift
	const scaffold = new Set(scaffoldFiles(projectDir));
	const want = only && new Set(only);
	const root = r.moduleDir.replace(/\/$/, "").split("/").slice(0, -1).join("/");
	const placeholder = r.moduleDir.replace(/\/$/, "").split("/").at(-1)!;
	const skip = new Set([...notAreas, ...[...o.sharedDirs, ...(o.dataDirs ?? [])].map((d) => topUnder(d, root)).filter((x): x is string => !!x)]);
	const out: string[] = [];
	const dirs = listDirs(join(projectDir, root)).filter((d) => !skip.has(d));
	for (const d of dirs) {
		const area = placeholder === "{area}" ? d : d.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/_/g, "-").toLowerCase();
		const mod = expandModuleDir(r, area);
		if (mod.split("/").at(-1) !== d || !KEBAB_RE.test(area) || banned(r, d)) {
			if (!want || [...want].some((f) => f.startsWith(`${root}/${d}/`))) out.push(`${root}/${d}/: folder "${d}" does not follow ${r.moduleDir}`);
			continue;
		}
		const files = listFiles(join(projectDir, mod)).map((f) => `${mod}/${f}`).filter((f) => !scaffold.has(f));
		const checked = want ? files.filter((f) => want.has(f)) : files;
		if (!checked.length) continue;
		out.push(...checkLayoutRules(checked, mod, area, projectDir, r, o, {}, !want));
		for (const f of checked.filter((f) => isSource(f, o) && !o.isTestFile(f))) out.push(...perFile(projectDir, f, mod, area, r, o));
	}
	const shared = o.sharedDirs.map(slashed).flatMap((s) => listFiles(join(projectDir, s)).map((f) => s + f)).filter((f) => !scaffold.has(f) && (!want || want.has(f)));
	out.push(...checkLayoutRules(shared, "\0none", "", projectDir, r, o));
	for (const f of shared.filter((f) => isSource(f, o) && !o.isTestFile(f))) out.push(...perFile(projectDir, f, undefined, undefined, r, o));
	return [...new Set(out)];
}

function perFile(projectDir: string, f: string, mod: string | undefined, area: string | undefined, r: LayoutRules, o: LayoutCheckOptions): string[] {
	if (o.fileFindings) return o.fileFindings(projectDir, f, mod, area);
	if (!r.maxLines) return [];
	const n = read(projectDir, f).replace(/\n$/, "").split("\n").length;
	return n > r.maxLines ? [`${f}: ${n} lines (cap ${r.maxLines}); split it by responsibility`] : [];
}

const isSource = (f: string, o: LayoutCheckOptions) => !o.sourceExtensions?.length || o.sourceExtensions.some((e) => f.endsWith(e));

/** `src/shared/` under root `src` → "shared". */
function topUnder(dir: string, root: string): string | undefined {
	const prefix = root ? `${root}/` : "";
	if (!dir.startsWith(prefix)) return undefined;
	return dir.slice(prefix.length).split("/")[0] || undefined;
}

/**
 * The binding layout text agents and RULES.md read, rendered from the same rules the checker uses. `testGlobs`: where
 * the stack's test runner finds an area's tests (the adapter's test globs, for the example area invoice).
 */
export function renderLayoutDoc(r: LayoutRules, sharedDirs: string[], testGlobs: string[] = []): string {
	const d = (p: string) => p.replace(/\{(\w+)\}/g, "<$1>");
	const lines = [`One feature folder per legacy area: ${d(r.moduleDir)}/${r.source ? ` (from ${r.source})` : ""}. Inside it only:`];
	for (const f of r.files) lines.push(`- ${d(f.path)} — ${f.doc}`);
	if (r.require.length) lines.push(`Every feature folder has: ${r.require.map(d).join(", ")}.`);
	for (const p of r.place ?? []) lines.push(`Placement: ${p.doc} (only in ${p.in.map(d).join(" or ")}).`);
	const sub = subStyle(r.moduleDir);
	lines.push(`<sub> is one ${sub.word} folder named after what the code does (e.g. ${sub.sample}/). Never a folder named ${r.forbidDirs.join(", ")}.`);
	if (testGlobs.length) lines.push(`Tests of an area go where the test runner finds them: ${testGlobs.join(" or ")} (for the area invoice).`);
	if (sharedDirs.length) lines.push(`Code used by several areas: ${sharedDirs.map((x) => `${slashed(x)}<topic>/<name>`).join(" or ")} (topic named after what it does).`);
	if (r.maxLines) lines.push(`A file stays under ${r.maxLines} lines.`);
	return lines.join("\n");
}

// ---- loading ------------------------------------------------------------------------------------------------

const cache = new Map<string, { mtimeMs: number; rules?: LayoutRules; problem?: string }>();

/** The stack's layout.json (read when it changed), or undefined. A broken file keeps the last good rules. */
export function loadLayoutRules(root: string, stackId: string): LayoutRules | undefined {
	const p = layoutRulesPath(root, stackId);
	let mtimeMs: number;
	try {
		mtimeMs = statSync(p).mtimeMs;
	} catch {
		cache.delete(p);
		return undefined;
	}
	const hit = cache.get(p);
	if (hit && hit.mtimeMs === mtimeMs) return hit.rules;
	try {
		const r = normalize(JSON.parse(readFileSync(p, "utf8")));
		const problems = validateLayoutRules(r);
		if (problems.length) throw new Error(problems.join("; "));
		cache.set(p, { mtimeMs, rules: r });
		return r;
	} catch (e: any) {
		cache.set(p, { mtimeMs, rules: hit?.rules, problem: `${p}: ${e?.message ?? e}` });
		return hit?.rules;
	}
}

/** Why the stack's layout.json is not used as written (preflight shows it), or undefined. */
export function layoutRulesProblem(root: string, stackId: string): string | undefined {
	loadLayoutRules(root, stackId);
	return cache.get(layoutRulesPath(root, stackId))?.problem;
}

export function saveLayoutRules(root: string, stackId: string, r: LayoutRules): string {
	const problems = validateLayoutRules(r);
	if (problems.length) throw new Error(`layout rules for ${stackId} are not usable: ${problems.join("; ")}`);
	const p = layoutRulesPath(root, stackId);
	mkdirSync(join(p, ".."), { recursive: true });
	writeFileSync(p, JSON.stringify(r, null, 2) + "\n");
	return p;
}

export function normalize(r: Partial<LayoutRules>): LayoutRules {
	return { moduleDir: r.moduleDir ?? "", files: r.files ?? [], require: r.require ?? [], forbidDirs: [...new Set(r.forbidDirs ?? [])], place: r.place ?? [], ...(r.maxLines ? { maxLines: r.maxLines } : {}), ...(r.source ? { source: r.source } : {}) };
}

/**
 * Every adapter goes through this: with a layout.json the folder layout, the structure doc and both checks come from
 * it (read at call time); without one the adapter's own checks stay and the banned folder names are added.
 */
export function withLayoutRules(adapter: TargetAdapter, root: string | undefined): TargetAdapter {
	const base = { ...adapter.layout, sharedDirs: adapter.layout.sharedDirs.map(slashed) };
	const rules = () => (root ? loadLayoutRules(root, adapter.id) : undefined);
	const opts: LayoutCheckOptions = { sharedDirs: base.sharedDirs, dataDirs: base.dataDirs, isTestFile: (f) => base.isTestFile(f), sourceExtensions: base.sourceExtensions, fileFindings: base.fileFindings };
	const layout = {
		...base,
		moduleDir: (area: string) => {
			const r = rules();
			return r ? expandModuleDir(r, area) : base.moduleDir(area);
		},
		checkStructure: (files: string[], moduleDir: string, area: string, projectDir: string, ctx?: StructureContext) => {
			const r = rules();
			if (r) return checkLayoutRules(files, moduleDir, area, projectDir, r, opts, ctx);
			const own = base.checkStructure?.(files, moduleDir, area, projectDir, ctx) ?? [];
			return own;
		},
		checkTree: (projectDir: string, only?: string[]) => {
			const r = rules();
			return r ? checkLayoutTree(projectDir, r, opts, only, scaffoldDirs(projectDir, r.moduleDir.split("/").slice(0, -1).join("/"))) : (base.checkTree?.(projectDir, only) ?? []);
		},
	};
	// the adapter's own notes stay next to the layout written from layout.json
	const doc = (r: LayoutRules) => [renderLayoutDoc(r, base.sharedDirs, base.testFileGlobs(expandModuleDir(r, "invoice"))), base.structureDoc.trim() && `Notes for this stack (where they name other folders or files than the layout above, the layout above wins):\n${base.structureDoc.trim()}`].filter(Boolean).join("\n\n");
	Object.defineProperty(layout, "structureDoc", { enumerable: true, get: () => (rules() ? doc(rules()!) : base.structureDoc) });
	return { ...adapter, layout };
}

// ---- helpers ------------------------------------------------------------------------------------------------

/** A folder path with exactly one trailing slash (`src/Shared` → `src/Shared/`), so folder + file never run together. */
export const slashed = (d: string) => d.replace(/\/*$/, "/");

/**
 * Files of the project's first commit (what the official generator made) still as generated, relative to `dir`:
 * never drift. A scaffold file a unit changed is checked like any other.
 */
export function scaffoldFiles(dir: string): string[] {
	try {
		const git = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		const first = git(["rev-list", "--max-parents=0", "HEAD"]).trim().split("\n").at(-1)!;
		const changed = new Set(git(["diff", "--name-only", "--relative", first]).split("\n").filter(Boolean));
		return git(["ls-tree", "-r", "--name-only", first]).split("\n").filter((f) => f && !changed.has(f));
	} catch {
		return [];
	}
}

/** Dirs under `srcRoot` in the project's first commit (what the official generator made): never feature folders. */
export function scaffoldDirs(dir: string, srcRoot: string): string[] {
	try {
		const first = execFileSync("git", ["-C", dir, "rev-list", "--max-parents=0", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").at(-1)!;
		return execFileSync("git", ["-C", dir, "ls-tree", "-d", "--name-only", first, `${srcRoot}/`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
			.split("\n")
			.filter(Boolean)
			.map((p) => p.split("/").at(-1)!);
	} catch {
		return [];
	}
}

/**
 * A legacy file kind in the file name's dotted parts (Create.cmd.php → cmd). Folders and words inside a name
 * (translations/, AccessTokenHandler) are never judged, nor the file's own extension (the target language).
 */
function legacyWord(f: string, words?: string[]): string | undefined {
	if (!words?.length) return undefined;
	const parts = f.split("/").at(-1)!.split(".").slice(1, -1).map((p) => p.toLowerCase());
	return words.find((w) => parts.includes(w.toLowerCase()));
}

function read(projectDir: string, f: string): string {
	try {
		return readFileSync(join(projectDir, f), "utf8");
	} catch {
		return "";
	}
}

function listDirs(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules").map((e) => e.name).sort();
	} catch {
		return [];
	}
}

function listFiles(dir: string, prefix = ""): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((n) => !n.startsWith(".") && n !== "node_modules")
		.sort()
		.flatMap((n) => (statSync(join(dir, n)).isDirectory() ? listFiles(join(dir, n), `${prefix}${n}/`) : [`${prefix}${n}`]));
}
