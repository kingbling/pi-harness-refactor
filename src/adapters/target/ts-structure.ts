import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { StructureContext } from "../types.ts";
import type { LayoutRules } from "../../rules/layout-rules.ts";
import { tsLayoutBase } from "./ts-index.ts";

/**
 * Layout of the TypeScript stacks, from ONE table per role: the structureDoc agents and RULES.md read, the gate's
 * structure check on the files a unit wrote (structure_ok) and the whole-tree drift check after every accept are
 * all derived from SHAPES below, so they cannot disagree. Lines starting with "warning:" do not fail the gate.
 *
 * - every production file lives in its area's module dir or a shared dir (`<shared>/<topic>/<file>`)
 * - every folder is kebab-case without dots (no `list.tpl/`, `players.facade/`)
 * - file names match the role's shapes; at most one *.module.ts per area; no legacy file kind in a name
 * - a second file of a kind (`<area>-<sub>.<kind>.ts`) is new only with a reason code can check: the code would not
 *   fit under MAX_LINES in the area's main file, or an approved tidy task names it
 * - tree only: files over MAX_LINES, more than one exported service/controller/repository class per file, such a
 *   class outside `<area>[-<sub>].<kind>.ts` or not named after its file, several of one kind in an area
 */
export const TS_FEATURE_ROOT = "src/features/";
export const tsModuleDir = (area: string) => `${TS_FEATURE_ROOT}${area}`;
/** Files longer than this are a drift finding (split by responsibility). */
export const MAX_LINES = 400;

const KEBAB = "[a-z0-9]+(?:-[a-z0-9]+)*";
const PASCAL = "[A-Z][A-Za-z0-9]*";
type Role = "server" | "ui";
/** `re(a, A)`: regex source for a path inside the module (a = escaped area, A = PascalCase area); `doc` uses <area>/<Area>. */
type Shape = { re: (a: string, A: string) => string; doc: string; what: string; split?: true };

const SPLIT = `a second file of a kind, only when the code would not fit under ${MAX_LINES} lines in the area's main file (or a tidy task names it); a different responsibility, never one per legacy file or unit`;
const SHAPES: Record<Role, Shape[]> = {
	server: [
		{ re: (a) => `${a}\\.module\\.ts`, doc: "<area>.module.ts", what: "the one Nest module of the area (imports, providers, controllers, exports)" },
		{ re: (a) => `${a}\\.controller\\.ts`, doc: "<area>.controller.ts", what: "HTTP endpoints of the area (<Area>Controller)" },
		{ re: (a) => `${a}\\.service\\.ts`, doc: "<area>.service.ts", what: "the area's business logic: ONE service class (<Area>Service); every unit of the area extends it" },
		{ re: (a) => `${a}\\.repository\\.ts`, doc: "<area>.repository.ts", what: "data access of the area (<Area>Repository)" },
		{ re: (a) => `${a}-${KEBAB}\\.(service|controller|repository|types|constants)\\.ts`, doc: "<area>-<sub>.<kind>.ts (class <Area><Sub><Kind>)", what: SPLIT, split: true },
		{ re: (a) => `${a}\\.(types|constants)\\.ts`, doc: "<area>.types.ts, <area>.constants.ts", what: "types and constants the area's files share" },
		{ re: (a) => `${a}(-${KEBAB})?\\.(guard|pipe|interceptor)\\.ts`, doc: "<area>.guard.ts (also .pipe.ts, .interceptor.ts)", what: "access checks and request plumbing of the area" },
		{ re: () => `dto/${KEBAB}\\.dto\\.ts`, doc: "dto/<name>.dto.ts", what: "request/response shapes per operation (create-agency.dto.ts, list-agencies-response.dto.ts)" },
		{ re: () => `entities/${KEBAB}\\.entity\\.ts`, doc: "entities/<record>.entity.ts", what: "persisted records" },
		{ re: () => `lib/${KEBAB}\\.ts`, doc: "lib/<name>.ts", what: "helper functions only this area uses (no service/controller/repository classes)" },
	],
	ui: [
		{ re: (_a, A) => `pages/${A}(${PASCAL})?Page(\\.tsx|\\.module\\.css)`, doc: "pages/<Area>Page.tsx (+ .module.css)", what: "a routed page of the area (more pages: pages/<Area><View>Page.tsx, e.g. pages/AgencyEditPage.tsx)" },
		{ re: () => `components/(?:(${PASCAL})/\\1|${PASCAL})(\\.tsx|\\.module\\.css)`, doc: "components/<Name>.tsx + components/<Name>.module.css (or components/<Name>/<Name>.tsx)", what: "presentational pieces, PascalCase, one component per file" },
		{ re: () => `hooks/use-${KEBAB}\\.tsx?`, doc: "hooks/use-<x>.ts", what: "state and behaviour hooks (use-agency-filters.ts)" },
		{ re: (a) => `api/${a}\\.api\\.ts`, doc: "api/<area>.api.ts", what: "the area's API client (data hooks of the chosen data library over the typed fetch client); ONE file per area, every unit extends it" },
		{ re: (a) => `api/${a}-${KEBAB}\\.api\\.ts`, doc: "api/<area>-<sub>.api.ts", what: SPLIT, split: true },
		{ re: (a) => `${a}\\.routes\\.tsx`, doc: "<area>.routes.tsx", what: "the area's routes (mirroring the legacy URLs)" },
		{ re: (a) => `${a}\\.(types|constants)\\.ts`, doc: "<area>.types.ts, <area>.constants.ts", what: "types and constants the area's files share" },
		{ re: (a) => `${a}-${KEBAB}\\.(types|constants)\\.ts`, doc: "<area>-<sub>.types.ts, <area>-<sub>.constants.ts", what: SPLIT, split: true },
		{ re: () => `lib/${KEBAB}\\.ts`, doc: "lib/<name>.ts", what: "helper functions only this area uses" },
	],
};
const TESTS: Record<Role, string> = { server: "specs beside the source they test: <file>.spec.ts", ui: "tests beside the source they test: <file>.test.tsx / <file>.test.ts" };
const REUSE: Record<Role, string> = { server: "reuse and extend the area's existing classes", ui: "reuse and extend the area's existing components and hooks" };

/** The binding layout text for a role (structureDoc), rendered from the same table the checks use. */
export function tsStructureDoc(role: Role): string {
	const shared = tsLayoutBase().sharedDirs[0]!;
	return [
		`One feature dir per legacy area: ${TS_FEATURE_ROOT}<area>/ (kebab-case). Inside it:`,
		...SHAPES[role].map((s) => `- ${s.doc} — ${s.what}`),
		`- ${TESTS[role]}`,
		`Code used by several areas: ${shared}<topic>/<name>.ts (kebab-case topic and name); only shared units or tidy tasks start a new topic.`,
		`No folder or file named after a legacy file or its kind; ${REUSE[role]}. A file stays under ${MAX_LINES} lines; one exported service/controller/repository class per file, named after it (<area>-billing.service.ts → <Area>BillingService).`,
	].join("\n");
}

function shapes(role: Role, area: string): Array<{ re: RegExp; doc: string; split?: true }> {
	const a = area.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const A = pascal(area);
	return SHAPES[role].map((s) => ({ re: new RegExp(`^${s.re(a, A)}$`), doc: s.doc.replaceAll("<area>", area).replaceAll("<Area>", A), split: s.split }));
}
const pascal = (kebabName: string) => kebabName.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");

/** Shared helpers: `<shared>/<topic>/<name>[.<kind>].<ext>`, name kebab-case or PascalCase (components). */
const SHARED_FILE = new RegExp(`^${KEBAB}(/${KEBAB})*/(${KEBAB}|${PASCAL})(\\.[a-z]+)?\\.(ts|tsx|css)$`);
const DIR = new RegExp(`^${KEBAB}$`);
const PASCAL_DIR = new RegExp(`^${PASCAL}$`);

export function tsCheckStructure(files: string[], moduleDir: string, area: string, projectDir: string, role: Role = tsRole(projectDir), ctx: StructureContext = {}): string[] {
	const base = tsLayoutBase();
	const mod = `${moduleDir.replace(/\/$/, "")}/`;
	const out: string[] = [];
	const own = shapes(role, area);
	for (const f of files) {
		const dirs = f.split("/").slice(0, -1);
		const badDir = dirs.find((d, i) => !DIR.test(d) && d !== "__tests__" && !(dirs[i - 1] === "components" && PASCAL_DIR.test(d)));
		if (badDir) {
			out.push(`${f}: folder "${badDir}" is not kebab-case (no dots, no folder per legacy file); the area's files belong in ${mod}`);
			continue;
		}
		if (base.isTestFile(f)) continue;
		const legacy = legacyWord(f, ctx.legacyWords);
		if (legacy) {
			out.push(`${f}: "${legacy}" is a legacy file kind; name files and classes after what they do, never after the legacy file`);
			continue;
		}
		const shared = base.sharedDirs.find((d) => f.startsWith(d));
		if (shared) {
			if (!SHARED_FILE.test(f.slice(shared.length))) out.push(`${f}: shared files go in ${shared}<topic>/<name>.ts (kebab-case topic and name)`);
			continue;
		}
		if (!f.startsWith(mod)) {
			out.push(`${f}: outside this unit's module ${mod} and the shared dirs (${base.sharedDirs.join(", ")})`);
			continue;
		}
		const s = own.find((x) => x.re.test(f.slice(mod.length)));
		if (!s) out.push(`${f}: not a file of the area module; allowed in ${mod}: ${own.map((x) => x.doc).join(" | ")}`);
		else if (s.split) {
			const p = splitProblem(projectDir, f, area, ctx);
			if (p) out.push(p);
		}
	}
	if (!base.sharedDirs.some((d) => mod.startsWith(d))) {
		const modules = new Set([...files.filter((f) => f.startsWith(mod)), ...listFiles(join(projectDir, mod)).map((f) => mod + f)].filter((f) => /\.module\.ts$/.test(f)));
		if (modules.size > 1) out.push(`${mod}: ${modules.size} module files (${[...modules].join(", ")}); one area has exactly one ${area}.module.ts`);
	}
	return out;
}

/** A NEW `<area>-<sub>.<kind>` file needs a reason: the main file plus it would not fit under MAX_LINES, or a tidy task. */
function splitProblem(projectDir: string, f: string, area: string, ctx: StructureContext): string | undefined {
	if (!ctx.isNew?.(f) || ctx.sanctioned?.includes(f)) return undefined;
	const main = f.replace(new RegExp(`(^|/)${area}-${KEBAB}\\.`), `$1${area}.`);
	const n = lineCount(projectDir, main);
	if (n === undefined) return `${f}: a second file of its kind, but ${main} does not exist; put the code in ${main}`;
	if (n + (lineCount(projectDir, f) ?? 0) > MAX_LINES) return undefined;
	return `${f}: a parallel file next to ${main} (${n} lines); extend ${main} (add methods to its class). A second file of a kind only when the code would not fit under ${MAX_LINES} lines in one, or an approved tidy task names it`;
}

/** First path part (dirs, file name, PascalCase humps) that is a legacy file kind. */
function legacyWord(f: string, words?: string[]): string | undefined {
	if (!words?.length) return undefined;
	// the file's own extension is the target language (a PHP → Symfony migration writes .php files), never a legacy kind
	const parts = f.replace(/\.[A-Za-z0-9]+$/, "").split(/[^A-Za-z0-9]+/).flatMap((p) => p.split(/(?<=[a-z0-9])(?=[A-Z])/)).map((p) => p.toLowerCase());
	return words.find((w) => parts.includes(w));
}

/**
 * Whole-tree check (drift): every feature dir and shared file against the same shapes, plus per-file size and
 * one-class-per-responsibility, and (whole tree only) several same-kind classes in one area, anchored at the
 * module dir. `only` limits the per-file findings to those files (the gate: files a unit touched).
 * Lines are `<project-relative path>: <finding>`; warnings are left out (they are no drift).
 */
export function tsCheckTree(projectDir: string, role: Role = tsRole(projectDir), only?: string[]): string[] {
	const base = tsLayoutBase();
	const want = only && new Set(only);
	const out: string[] = [];
	const featureRoot = join(projectDir, TS_FEATURE_ROOT);
	const areas = existsSync(featureRoot) ? readdirSync(featureRoot).filter((n) => !n.startsWith(".") && statSync(join(featureRoot, n)).isDirectory()).sort() : [];
	for (const area of areas) {
		const mod = tsModuleDir(area);
		if (!DIR.test(area)) {
			if (!want || [...want].some((f) => f.startsWith(`${mod}/`))) out.push(`${mod}/: folder "${area}" is not kebab-case (no dots, no folder per legacy file)`);
			continue;
		}
		const files = listFiles(join(projectDir, mod)).map((f) => `${mod}/${f}`);
		if (!want) {
			const byKind = new Map<string, string[]>();
			for (const f of files) if (/\.tsx?$/.test(f) && !base.isTestFile(f)) for (const c of kindClasses(read(projectDir, f))) byKind.set(c.kind, [...(byKind.get(c.kind) ?? []), c.name]);
			for (const [k, names] of byKind) if (names.length > 1) out.push(`${mod}/: ${names.length} ${k} classes (${names.join(", ")}); one per area: extend ${area}.${k}.ts, a second only past the size cap`);
		}
		const checked = want ? files.filter((f) => want.has(f)) : files;
		if (!checked.length) continue;
		out.push(...tsCheckStructure(checked, mod, area, projectDir, role).filter((l) => !l.startsWith("warning:")));
	}
	const shared = base.sharedDirs.flatMap((d) => listFiles(join(projectDir, d)).map((f) => d + f)).filter((f) => !want || want.has(f));
	out.push(...tsCheckStructure(shared, `${base.sharedDirs[0]!}x`, "x", projectDir, role).filter((l) => !l.startsWith("warning:")));
	const prod = [...areas.filter((a) => DIR.test(a)).flatMap((a) => listFiles(join(projectDir, tsModuleDir(a))).map((f) => `${tsModuleDir(a)}/${f}`)), ...base.sharedDirs.flatMap((d) => listFiles(join(projectDir, d)).map((f) => d + f))]
		.filter((f) => (!want || want.has(f)) && /\.tsx?$/.test(f) && !base.isTestFile(f));
	for (const f of prod) out.push(...fileFindings(projectDir, f));
	return [...new Set(out)];
}

const KIND_CLASS = /^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_]+?(Service|Controller|Repository))\b/gm;
const kindClasses = (text: string) => [...text.matchAll(KIND_CLASS)].map((m) => ({ name: m[1]!, Kind: m[2]!, kind: m[2]!.toLowerCase() }));
const read = (projectDir: string, f: string) => {
	try {
		return readFileSync(join(projectDir, f), "utf8");
	} catch {
		return "";
	}
};
/** Lines of a file (a trailing newline ends the last line, it does not start another); undefined = missing. */
function lineCount(projectDir: string, f: string): number | undefined {
	if (!existsSync(join(projectDir, f))) return undefined;
	return read(projectDir, f).replace(/\n$/, "").split("\n").length;
}

/** Size and one-class-per-responsibility of one file; `moduleDir`/`area` place the class-home check (default: the built-in feature root). */
export function tsFileFindings(projectDir: string, f: string, moduleDir?: string, area?: string): string[] {
	return fileFindings(projectDir, f, moduleDir, area);
}

function fileFindings(projectDir: string, f: string, moduleDir?: string, areaOf?: string): string[] {
	if (!existsSync(join(projectDir, f))) return [];
	const text = read(projectDir, f);
	const out: string[] = [];
	const lines = lineCount(projectDir, f)!;
	if (lines > MAX_LINES) out.push(`${f}: ${lines} lines (cap ${MAX_LINES}); split it by responsibility`);
	const classes = kindClasses(text);
	if (classes.length > 1) {
		const kinds = new Set(classes.map((c) => c.kind));
		out.push(`${f}: ${classes.length} exported ${kinds.size === 1 ? `${[...kinds][0]} ` : "service/controller/repository "}classes (${classes.map((c) => c.name).join(", ")}); one class per file`);
	}
	const area = areaOf ?? (f.startsWith(TS_FEATURE_ROOT) ? f.slice(TS_FEATURE_ROOT.length).split("/")[0]! : undefined);
	const mod = moduleDir ?? (area ? tsModuleDir(area) : "");
	for (const c of classes) {
		if (!area) continue;
		// <area>[-<sub>].<kind>.ts at the feature root, or <sub>/<area>-<sub>.<kind>.ts in a sub-feature folder
		const home = new RegExp(`^${mod.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(?:${KEBAB}/)?(${area}(?:-${KEBAB})?)\\.${c.kind}\\.ts$`).exec(f);
		if (!home) out.push(`${f}: ${c.name} is a ${c.kind} class outside ${area}[-<sub>].${c.kind}.ts; same-kind classes of an area live in those files`);
		else if (c.name !== pascal(home[1]!) + c.Kind) out.push(`${f}: class ${c.name} must be named ${pascal(home[1]!)}${c.Kind} after its file (never after a legacy file or another area)`);
	}
	return out;
}

/** Role when the adapter did not pass one: a project with React and without Nest is the ui stack. */
function tsRole(projectDir: string): Role {
	try {
		const p = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
		return p.dependencies?.react && !p.dependencies["@nestjs/core"] ? "ui" : "server";
	} catch {
		return "server";
	}
}

function listFiles(dir: string, prefix = ""): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((n) => !n.startsWith(".") && n !== "node_modules")
		.sort()
		.flatMap((n) => (statSync(join(dir, n)).isDirectory() ? listFiles(join(dir, n), `${prefix}${n}/`) : [`${prefix}${n}`]));
}

/**
 * The frameworks' own feature-folder conventions, proposed at onboarding (the owner confirms or changes them; the
 * answer is the stack's layout.json). NestJS: what `nest g resource <name>` generates, one folder per feature.
 */
export const NEST_LAYOUT: LayoutRules = {
	source: "NestJS docs (nest g resource)",
	moduleDir: "src/{area}",
	files: [
		{ path: "{area}.module.ts", doc: "the one Nest module of the feature ({Area}Module)" },
		{ path: "{area}.controller.ts", doc: "HTTP endpoints of the feature ({Area}Controller)" },
		{ path: "{area}.service.ts", doc: "business logic of the feature ({Area}Service); every unit of the area extends it" },
		{ path: "{area}.repository.ts", doc: "data access of the feature ({Area}Repository)" },
		{ path: "{area}.(types|constants).ts", doc: "types and constants the feature's files share" },
		{ path: "{area}.(guard|pipe|interceptor).ts", doc: "access checks and request plumbing of the feature" },
		{ path: "{area}-{name}.(service|controller|repository|types|constants).ts", doc: `a second file of a kind, only when the code would not fit under ${MAX_LINES} lines in the main one` },
		{ path: "lib/{name}.ts", doc: "helper functions only this feature uses (no service/controller/repository classes)" },
		{ path: "dto/{name}.dto.ts", doc: "request/response classes, one per operation (create-campaign.dto.ts)" },
		{ path: "entities/{name}.entity.ts", doc: "persisted records" },
		{ path: "{sub}/{area}-{sub}.(service|controller|repository|types|constants).ts", doc: "a sub-feature in a folder named after what it does (creation/campaign-creation.service.ts)" },
		{ path: "{sub}/dto/{name}.dto.ts", doc: "request/response classes of a sub-feature" },
	],
	require: ["{area}.module.ts", "{area}.controller.ts", "{area}.service.ts"],
	forbidDirs: [],
	place: [
		{ text: "^\\s*(?:export\\s+(?:default\\s+)?)?(?:abstract\\s+)?class\\s+\\w+(?:Dto|Request|Response)\\b", in: ["dto/{name}.dto.ts", "{sub}/dto/{name}.dto.ts"], doc: "request/response classes live in dto/" },
		{ text: "@Controller\\(", in: ["{area}.controller.ts", "{area}-{name}.controller.ts", "{sub}/{area}-{sub}.controller.ts"], doc: "controllers only in controller files" },
		{ text: "@Module\\(", in: ["{area}.module.ts"], doc: "one module per feature" },
		{ text: "@Entity\\(", in: ["entities/{name}.entity.ts"], doc: "persisted records live in entities/" },
	],
};

/** React: one folder per feature (the feature-folder convention of the React docs' "thinking in components" + bulletproof-react). */
export const REACT_LAYOUT: LayoutRules = {
	source: "React feature folders",
	moduleDir: "src/features/{area}",
	files: [
		{ path: "pages/{Area}Page.(tsx|module.css)", doc: "the routed page of the feature (+ its CSS module)" },
		{ path: "pages/{Area}{Name}Page.(tsx|module.css)", doc: "more pages of the feature (AgencyEditPage.tsx)" },
		{ path: "components/{Name}.(tsx|module.css)", doc: "presentational pieces, one component per file" },
		{ path: "components/{Name}/{Name}.(tsx|module.css)", doc: "a component with its own folder" },
		{ path: "hooks/use-{name}.(ts|tsx)", doc: "state and behaviour hooks (use-agency-filters.ts)" },
		{ path: "api/{area}.api.ts", doc: "the feature's API client; every unit extends it" },
		{ path: "api/{area}-{name}.api.ts", doc: `a second API file, only when the code would not fit under ${MAX_LINES} lines in the main one` },
		{ path: "{area}-{name}.(types|constants).ts", doc: `a second types/constants file, only past ${MAX_LINES} lines` },
		{ path: "{area}.routes.tsx", doc: "the feature's routes (mirroring the legacy URLs)" },
		{ path: "{area}.(types|constants).ts", doc: "types and constants the feature's files share" },
		{ path: "lib/{name}.ts", doc: "helper functions only this feature uses" },
	],
	require: [],
	forbidDirs: [],
	place: [],
};
