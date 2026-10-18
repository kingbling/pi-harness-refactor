import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { exec, outputCaptured, runCommand } from "../../proc.ts";
import { progress } from "../../progress.ts";
import { MissingToolsError } from "../../init/toolchain-install.ts";
import type { ModelClient } from "../../models/types.ts";
import type { StackChoice, TargetAdapter } from "../types.ts";
import { DEFAULT_FORBID_DIRS, loadLayoutRules, normalize, saveLayoutRules, slashed, validateLayoutRules, type LayoutRules } from "../../rules/layout-rules.ts";

/**
 * A target adapter for a stack bigrefactor has no hand-written adapter for, written as DATA by a model that
 * knows the stack's official tooling, and interpreted here. The project is still bootstrapped by the stack's
 * official generator (the manifest names the command), never by model-written code. Before it is used, the
 * manifest is verified on a scratch project: scaffold → build → probe test; failures go back to the model.
 *
 * Optional code hooks of hand-written adapters (symbol index, structure checks, registration wiring) are
 * absent: the gate runs without them, and units register their own wiring in the files layout.wiringFiles names.
 */
export interface Cmd { cmd: string; args: string[] }
export interface AdapterManifest {
	id: string;
	role: "server" | "ui";
	subdir: string;
	aliases: string[];
	docs: Array<{ name: string; url: string }>;
	/** Official generator, run in the PARENT of the project dir; `{name}` = project folder name. */
	scaffold: Cmd & { readyFile: string };
	/** Run in the new project after the generator (e.g. install dependencies); may be empty. */
	postScaffold: Cmd[];
	/** `{files}` expands to the files to check / the related test files (may expand to nothing). */
	build: Cmd;
	lint: Cmd;
	test: Cmd;
	/** Applies every migration, in order, to a new empty throwaway database (a DB lane gate step). Older manifests and stacks without migrations have none. */
	migrateFresh?: Cmd;
	/** Loads the whole app the way it starts and exits, failing when it cannot start (a whole-project step). Older manifests have none. */
	boot?: Cmd;
	toolchain: {
		ecosystem: string;
		packageName: string;
		packageExamples: string[];
		manifestFiles: string[];
		/**
		 * Where installed package names are listed: a JSON manifest and the object keys holding them, or (stacks without
		 * a JSON manifest) a command printing them, one per line, with a regex whose first group is the name. Older manifests have no list.
		 */
		installed: { file: string; keys: string[]; list?: Cmd; listPattern?: string };
		add: Cmd;
		worktreeLinks: string[];
		ignoredPaths: string[];
	};
	layout: {
		/** `{area}` kebab, `{Area}` PascalCase, `{area_snake}`. */
		moduleDir: string;
		structureDoc: string;
		sharedDirs: string[];
		/** `{moduleDir}` expands. */
		testFileGlobs: string[];
		testFileRegex: string;
		sourceExtensions: string[];
		langByExtension: Record<string, string>;
		skipMarker: string;
		/** One line of test code per skip, focus and incomplete form of the test runner (from its docs): skipMarker must match each. Older manifests have none (healSkipMarker asks once). */
		skipSamples?: string[];
		/** Older manifests have none. */
		suppressMarker?: string;
		interfaceHint: string;
		testHint: string;
		/** `{why}` expands. */
		legacyMarker: string;
		dataAccessHint: string;
		ignoreDirs: string[];
		/** Folders (trailing slash) where this stack keeps database code: schema/models, migrations, seeds. Older manifests have none. */
		dataDirs?: string[];
		/** Files (globs) where a feature is registered (route table, main module); empty when the framework finds features itself. Older manifests have none. */
		wiringFiles?: string[];
		/** The stack's official feature-folder convention as checkable data (proposed at onboarding; see rules/layout-rules.ts). Older manifests have none. */
		rules?: LayoutRules;
	};
	platform: Record<string, string>;
	stackChoices: StackChoice[];
	protectedGlobs: string[];
	/** The files that decide how the checks run (older manifests have none; healCheckConfig asks once). */
	checkConfigGlobs?: string[];
	patternKinds: string[];
	/** A minimal test proving the toolchain works on a fresh project; `failing` is the same test with a wrong expected value (older manifests have none). */
	probeTest: { path: string; content: string; failing?: string };
	/** File (relative to a project root) that only this stack's projects have, and text it contains. */
	detect: { file: string; contains: string };
	/** false = written but not proven yet (verification runs after the owner's questions); absent = verified. */
	verified?: boolean;
	/** The project verification built (scaffold + packages, probe test removed): setup moves it into place instead of building again. */
	seedProject?: string;
}

const expand = (c: Cmd, vars: Record<string, string | string[]>): Cmd => ({
	cmd: c.cmd,
	args: c.args.flatMap((a) => {
		const whole = /^\{(\w+)\}$/.exec(a)?.[1];
		if (whole && Array.isArray(vars[whole])) return vars[whole] as string[];
		return [a.replace(/\{(\w+)\}/g, (m, k) => (typeof vars[k] === "string" ? (vars[k] as string) : m))];
	}),
});
const pascal = (s: string) => s.split(/[-_\s]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");

export function fromManifest(m: AdapterManifest): TargetAdapter {
	const layoutRules = m.layout.rules ? normalize(m.layout.rules) : undefined;
	const testRe = new RegExp(m.layout.testFileRegex);
	const moduleDir = (area: string) => m.layout.moduleDir.replace(/\{area\}/g, area).replace(/\{Area\}/g, pascal(area)).replace(/\{area_snake\}/g, area.replace(/-/g, "_"));
	// test globs may name the area outside the module (tests/{Area}/…): read the area back from the module dir
	const moduleRe = new RegExp(`^${m.layout.moduleDir.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{(area|Area|area_snake)\\?\}/g, "([^/]+)")}$`);
	const testGlobs = (dir: string) => {
		// a shared folder (src/Shared/FileStorage) is not a module dir: its last folder names the area
		const seg = moduleRe.exec(dir)?.[1] ?? dir.split("/").pop();
		const kebab = seg?.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/_/g, "-").toLowerCase();
		return m.layout.testFileGlobs.map((g) => {
			const out = g.replace(/\{moduleDir\}/g, dir);
			return kebab ? out.replace(/\{area\}/g, kebab).replace(/\{Area\}/g, pascal(kebab)).replace(/\{area_snake\}/g, kebab.replace(/-/g, "_")) : out;
		});
	};
	return {
		id: m.id,
		role: m.role,
		subdir: m.subdir,
		seedProject: m.verified === false ? undefined : m.seedProject,
		aliases: m.aliases,
		docs: m.docs,
		platform: m.platform,
		stackChoices: m.stackChoices,
		toolchain: {
			ecosystem: m.toolchain.ecosystem,
			packageName: new RegExp(m.toolchain.packageName),
			packageExamples: m.toolchain.packageExamples,
			isProjectReady: (dir) => existsSync(join(dir, m.scaffold.readyFile)),
			manifestFiles: m.toolchain.manifestFiles,
			installedPackages: (dir) => installedPackages(m, dir),
			addPackages: (_dir, packages) => expand(m.toolchain.add, { packages }),
			worktreeLinks: m.toolchain.worktreeLinks,
			ignoredPaths: m.toolchain.ignoredPaths,
		},
		layout: {
			moduleDir,
			structureDoc: m.layout.structureDoc,
			sharedDirs: (m.layout.sharedDirs ?? []).map(slashed),
			testFileGlobs: testGlobs,
			isTestFile: (p) => testRe.test(p),
			sourceExtensions: m.layout.sourceExtensions,
			lang: (p) => Object.entries(m.layout.langByExtension).find(([ext]) => p.endsWith(ext))?.[1],
			skipMarker: new RegExp(m.layout.skipMarker),
			...(m.layout.suppressMarker ? { suppressMarker: new RegExp(m.layout.suppressMarker) } : {}),
			interfaceHint: m.layout.interfaceHint,
			testHint: m.layout.testHint,
			legacyMarker: (why) => m.layout.legacyMarker.replace(/\{why\}/g, why),
			dataAccessHint: m.layout.dataAccessHint || undefined,
			...(m.layout.dataDirs?.length ? { dataDirs: m.layout.dataDirs.map(slashed) } : {}),
			// [] = the stack registers nothing by hand; absent = an older manifest that was never asked
			...(m.layout.wiringFiles ? { wiringFiles: m.layout.wiringFiles } : {}),
			ignoreDirs: m.layout.ignoreDirs,
		},
		probeTest: () => m.probeTest,
		async detect(root) {
			const f = join(root, m.detect.file);
			if (!existsSync(f)) return { confidence: 0 };
			return { confidence: readFileSync(f, "utf8").includes(m.detect.contains) ? 0.9 : 0.1 };
		},
		scaffoldHint: [m.scaffold, ...(m.postScaffold ?? [])].map((c) => `${c.cmd} ${c.args.join(" ")}`).join(", then ") + ` (run in the parent folder; {name} = the project folder name; the project is ready when ${m.scaffold.readyFile} exists)`,
		async scaffoldProject(root) {
			if (existsSync(join(root, m.scaffold.readyFile))) return;
			mkdirSync(dirname(root), { recursive: true });
			const c = expand(m.scaffold, { name: basename(root) });
			await runCommand(c.cmd, c.args, { cwd: dirname(root) });
			for (const p of m.postScaffold ?? []) {
				const e = expand(p, { name: basename(root) });
				await runCommand(e.cmd, e.args, { cwd: root });
			}
		},
		build: (root, files = []) => expand(m.build, { dir: root, files }),
		lint: (root, files) => expand(m.lint, { dir: root, files }),
		test: (root, related) => expand(m.test, { dir: root, files: related }),
		...(m.migrateFresh?.cmd ? { migrateFresh: (root: string) => expand(m.migrateFresh!, { dir: root }) } : {}),
		...(m.boot?.cmd ? { boot: (root: string) => expand(m.boot!, { dir: root }) } : {}),
		protectedGlobs: m.protectedGlobs,
		...(m.checkConfigGlobs ? { checkConfigGlobs: m.checkConfigGlobs } : {}),
		generatedFiles: [],
		patternKinds: m.patternKinds,
		...(layoutRules ? { layoutRules } : {}),
	};
}

/** Package names the project has: from the JSON manifest when the stack has one, else from the list command's output. */
async function installedPackages(m: AdapterManifest, dir: string): Promise<string[]> {
	const inst = m.toolchain.installed;
	if (inst.file && inst.keys?.length) {
		try {
			const j = JSON.parse(readFileSync(join(dir, inst.file), "utf8")) as Record<string, Record<string, unknown>>;
			return inst.keys.flatMap((k) => Object.keys(j[k] ?? {}));
		} catch {
			/* not JSON: the list command, if any */
		}
	}
	if (!inst.list?.cmd) return [];
	let stdout = "";
	try {
		stdout = await exec(inst.list.cmd, inst.list.args, { cwd: dir, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
	} catch {
		return [];
	}
	if (!stdout) return [];
	// the model's pattern names the package in group 1; without one, the package-name regex's match is the name
	const re = new RegExp(inst.listPattern || m.toolchain.packageName);
	const names = stdout.split("\n").map((l) => {
		const x = re.exec(l.trim());
		return inst.listPattern ? x?.[1] : x?.[0];
	});
	return [...new Set(names.filter((x): x is string => !!x))];
}

// ---- validation: model-written commands run on the owner's machine ------------------------------------

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "cmd", "cmd.exe", "powershell", "pwsh", "eval", "exec", "env", "xargs", "sudo", "su", "doas"]);
/** Every command a manifest would run, for the owner to see before anything runs. */
export function manifestCommands(m: AdapterManifest): string[] {
	return [["scaffold", m.scaffold], ...(m.postScaffold ?? []).map((c, i) => [`after scaffold ${i + 1}`, c] as const), ["build", m.build], ["lint", m.lint], ["test", m.test], ...(m.migrateFresh?.cmd ? [["migrate fresh", m.migrateFresh] as const] : []), ...(m.boot?.cmd ? [["boot", m.boot] as const] : []), ["add packages", m.toolchain.add], ...(m.toolchain.installed?.list?.cmd ? [["list packages", m.toolchain.installed.list] as const] : [])].map(([k, c]) => `${k}: ${(c as Cmd).cmd} ${(c as Cmd).args.join(" ")}`);
}
/** Problems that make a manifest unusable; empty = structurally sound (it still has to pass verification). */
export function validateManifest(m: AdapterManifest): string[] {
	const out: string[] = [];
	for (const [k, c] of [["scaffold", m.scaffold], ...(m.postScaffold ?? []).map((c, i) => [`postScaffold[${i}]`, c] as const), ["build", m.build], ["lint", m.lint], ["test", m.test], ...(m.migrateFresh?.cmd ? [["migrateFresh", m.migrateFresh] as const] : []), ...(m.boot?.cmd ? [["boot", m.boot] as const] : []), ["toolchain.add", m.toolchain?.add], ...(m.toolchain?.installed?.list?.cmd ? [["toolchain.installed.list", m.toolchain.installed.list] as const] : [])] as const) {
		if (!c || typeof c.cmd !== "string" || !Array.isArray(c.args)) {
			out.push(`${k}: needs cmd + args`);
			continue;
		}
		// one executable (a name or a project-relative path), never a shell or a command line
		if (!/^[\w@+.-]+(\/[\w@+.-]+)*$/.test(c.cmd) || c.cmd.includes("..")) out.push(`${k}.cmd "${c.cmd}" must be a single executable name or project-relative path`);
		if (SHELLS.has(basename(c.cmd).toLowerCase())) out.push(`${k}.cmd "${c.cmd}" is a shell/launcher; name the tool itself`);
		if (c.args.some((a) => typeof a !== "string" || /[;&|`$<>\n]/.test(a))) out.push(`${k}.args contain shell syntax; give plain arguments`);
	}
	for (const [k, re] of [["toolchain.packageName", m.toolchain?.packageName], ["layout.testFileRegex", m.layout?.testFileRegex], ["layout.skipMarker", m.layout?.skipMarker], ["layout.suppressMarker", m.layout?.suppressMarker], ["toolchain.installed.listPattern", m.toolchain?.installed?.listPattern]] as const) {
		try {
			new RegExp(re ?? "");
		} catch {
			out.push(`${k} is not a valid regex`);
		}
	}
	if (!/^[a-z0-9][a-z0-9.-]*$/.test(m.subdir ?? "")) out.push("subdir must be a plain folder name");
	for (const k of ["readyFile"] as const) if (!m.scaffold?.[k] || m.scaffold[k].includes("..")) out.push(`scaffold.${k} must be a project-relative file`);
	if (!m.probeTest?.path || m.probeTest.path.startsWith("/") || m.probeTest.path.includes("..")) out.push("probeTest.path must be project-relative");
	if (m.probeTest?.failing !== undefined && m.probeTest.failing.trim() === (m.probeTest.content ?? "").trim()) out.push("probeTest.failing must differ from probeTest.content (the same test with a wrong expected value)");
	if (!m.layout?.sourceExtensions?.length) out.push("layout.sourceExtensions is empty");
	out.push(...skipProblems(m.layout?.skipMarker ?? "", m.layout?.skipSamples));
	for (const [k, ps] of [["layout.dataDirs", m.layout?.dataDirs], ["layout.wiringFiles", m.layout?.wiringFiles]] as const) for (const p of ps ?? []) if (!p || p.startsWith("/") || p.includes("..")) out.push(`${k} "${p}" must be project-relative`);
	if (!m.patternKinds?.length) out.push("patternKinds is empty");
	if (m.layout?.rules) {
		const r = normalize(m.layout.rules);
		if (r.moduleDir !== m.layout.moduleDir) out.push(`layout.rules.moduleDir "${r.moduleDir}" must equal layout.moduleDir "${m.layout.moduleDir}"`);
		out.push(...validateLayoutRules(r).map((p) => `layout.rules: ${p}`));
	}
	return out;
}

/** The skip samples the skip marker does not match (none when there are no samples: an older manifest). */
export function skipProblems(marker: string, samples: string[] | undefined): string[] {
	if (!samples) return [];
	if (!samples.length) return ["layout.skipSamples is empty: give one line of test code per skip, focus and incomplete form of the test runner"];
	let re: RegExp;
	try {
		re = new RegExp(marker);
	} catch {
		return []; // reported as an invalid regex
	}
	const missed = samples.filter((x) => !re.test(x));
	return missed.length ? [`layout.skipMarker ${marker} does not match these skip samples: ${missed.join(" | ")}`] : [];
}

/**
 * What a newly written manifest must get right about its stack, checked when it is written (an older saved manifest
 * keeps working): one test home per area, and a wiring file that registers the files the layout requires in every
 * feature folder. A problem goes back to the model, which picks.
 */
export function stackProblems(m: AdapterManifest): string[] {
	const out: string[] = [];
	const a = fromManifest(m);
	const homes = [...new Set(a.layout.testFileGlobs(a.layout.moduleDir("probe")).map(globHome))];
	if (homes.length > 1) out.push(`layout.testFileGlobs gives one area ${homes.length} test homes (${homes.join(", ")}): pick ONE, where the stack's official convention keeps tests (see the layout.testFileGlobs rule), and give only globs under it`);
	const require = m.layout.rules?.require ?? [];
	if (require.length && !m.layout.wiringFiles?.length) out.push(`layout.rules.require makes every feature folder hold ${require.join(", ")}, but layout.wiringFiles is empty, so nothing registers them: name the file where the framework registers them (from its docs) in layout.wiringFiles, or make require [] when the framework finds them on its own`);
	return out;
}
/** The folder a test glob starts in, before its first wildcard (tests/probe/**\/*.test.x → tests/probe). */
const globHome = (glob: string) => {
	const parts = glob.split("/").slice(0, -1);
	const wild = parts.findIndex((p) => /[*?[{]/.test(p));
	return (wild < 0 ? parts : parts.slice(0, wild)).join("/");
};

// ---- generation + verification ------------------------------------------------------------------------

export function generatedDir(root: string): string {
	return join(root, ".bigrefactor", "adapters");
}
/**
 * A stack's generated adapter that a fresh start left behind in .bigrefactor.old-<time>/adapters (before fresh
 * starts kept them): copied back, newest first. Returns whether one was found.
 */
export async function restoreManifest(root: string, id: string): Promise<boolean> {
	const olds = existsSync(root) ? readdirSync(root).filter((n) => n.startsWith(".bigrefactor.old-")).sort().reverse() : [];
	for (const old of olds) {
		const from = join(root, old, "adapters");
		if (!existsSync(join(from, `${id}.json`))) continue;
		mkdirSync(generatedDir(root), { recursive: true });
		for (const n of [`${id}.json`, `${id}.seed`]) if (existsSync(join(from, n))) await cp(join(from, n), join(generatedDir(root), n), { recursive: true });
		return true;
	}
	return false;
}

const warnedManifests = new Set<string>();
/** Verified manifests of this workspace (an invalid one, e.g. edited by hand, is skipped, never run). */
export function loadManifests(root: string): AdapterManifest[] {
	const dir = generatedDir(root);
	if (!existsSync(dir)) return [];
	const out: AdapterManifest[] = [];
	for (const n of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
		try {
			const m = JSON.parse(readFileSync(join(dir, n), "utf8")) as AdapterManifest;
			if (!validateManifest(m).length) out.push(m);
		} catch (e: any) {
			// one broken file must not take every other stack down with it; said once, not on every load
			const msg = `skipping adapter manifest ${join(dir, n)}: ${e?.message ?? e}`;
			if (!warnedManifests.has(msg)) (outputCaptured() ? progress.log(`  ${msg}`) : console.warn(msg));
			warnedManifests.add(msg);
		}
	}
	return out;
}

const S = { type: "string" } as const;
const SA = { type: "array", items: S } as const;
const CMD = { type: "object", additionalProperties: false, required: ["cmd", "args"], properties: { cmd: S, args: SA } } as const;
const obj = (props: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(props), properties: props });
/** layout.json as a JSON schema (generated manifests, /br rule drafts). */
export const LAYOUT_RULES_SCHEMA = obj({
	source: S,
	moduleDir: S,
	files: { type: "array", items: obj({ path: S, doc: S }) },
	require: SA,
	forbidDirs: SA,
	place: { type: "array", items: obj({ text: S, in: SA, doc: S }) },
	maxLines: { type: "integer" },
});
// strict structured output has no open maps: maps travel as [{key, value}] and are folded back (asMap)
const MAP = { type: "array", items: obj({ key: S, value: S }) } as const;
const OPTION = obj({ id: S, label: S, hint: S, platform: MAP, packages: SA, docs: { type: "array", items: obj({ name: S, url: S }) } });
export const MANIFEST_SCHEMA = obj({
	id: S,
	role: { type: "string", enum: ["server", "ui"] },
	subdir: S,
	aliases: SA,
	docs: { type: "array", items: obj({ name: S, url: S }) },
	scaffold: obj({ cmd: S, args: SA, readyFile: S }),
	postScaffold: { type: "array", items: CMD },
	build: CMD,
	lint: CMD,
	test: CMD,
	migrateFresh: CMD,
	boot: CMD,
	toolchain: obj({ ecosystem: S, packageName: S, packageExamples: SA, manifestFiles: SA, installed: obj({ file: S, keys: SA, list: CMD, listPattern: S }), add: CMD, worktreeLinks: SA, ignoredPaths: SA }),
	layout: obj({ moduleDir: S, structureDoc: S, sharedDirs: SA, testFileGlobs: SA, testFileRegex: S, sourceExtensions: SA, langByExtension: MAP, skipMarker: S, skipSamples: SA, suppressMarker: S, interfaceHint: S, testHint: S, legacyMarker: S, dataAccessHint: S, ignoreDirs: SA, dataDirs: SA, wiringFiles: SA, rules: LAYOUT_RULES_SCHEMA }),
	platform: MAP,
	stackChoices: { type: "array", items: obj({ key: S, question: S, default: S, options: { type: "array", items: OPTION } }) },
	protectedGlobs: SA,
	checkConfigGlobs: SA,
	patternKinds: SA,
	probeTest: obj({ path: S, content: S, failing: S }),
	detect: obj({ file: S, contains: S }),
});

const SYSTEM = [
	"You write a target adapter manifest for an automated legacy migration tool. It is DATA, interpreted by the tool:",
	"- scaffold: the stack's OFFICIAL project generator, non-interactive, run in the parent dir; {name} is the project folder. readyFile appears in a generated project. postScaffold: commands run inside the new project afterwards so build and test work (install dependencies, add the test runner if the generator has none).",
	"- build/lint/test: commands run in the project dir. A {files} argument expands to file paths (may be empty). Build must fail on type/compile errors; test must run only the given files when there are some.",
	"- EVERY command is ONE executable with plain arguments, run without a shell: no sh/bash/cmd -c, no pipes, &&, ;, $, redirects, loops or globs. When the stack has no single build command, use its main static checker as build (e.g. PHP: vendor/bin/phpstan analyse src; Python: mypy or python -m compileall; Ruby: bundle exec rubocop), its linter/formatter check as lint, and its test runner as test with {files} appended (e.g. vendor/bin/phpunit {files}). Tools installed into the project are called by their project-relative path (vendor/bin/…, node_modules/.bin/…, bin/console) and added in postScaffold.",
	"- toolchain.installed: how the tool reads which packages the project has. When the stack's package manifest is JSON (package.json, composer.json): file = that manifest, keys = the object keys whose keys are package names, list = {cmd: \"\", args: []}, listPattern = \"\". Otherwise file = \"\", keys = [], list = the stack's own command that prints the installed packages one per line (one executable with plain args, e.g. go list -m all, pip list --format=freeze, bundle list), listPattern = a regex whose first group is the package name on one such line. toolchain.packageName: a regex (anchored with ^) matching a package name.",
	"- layout.moduleDir: where one feature area of the app lives ({area}, {Area}, {area_snake} expand); one directory per area, not per layer.",
	"- layout.sharedDirs: usually ONE folder for app code that several feature areas use (e.g. src/Shared/ next to the feature folders), spelled like the feature folders. Never the framework's own folders such as config, templates or tests: those are not shared app code.",
	"- layout.testFileGlobs: where the stack's official convention keeps an area's tests ({moduleDir}, {area}, {Area}, {area_snake} expand). Next to the code ({moduleDir}/…) only where the framework expects that; where the app loads everything under its source dir as app code (service containers, autoloaded apps), tests go in the official tests dir mirrored per area (e.g. tests/{Area}/…), or the app will not start. The FIRST glob must be a place the test command without {files} runs (the tool checks this with the probe test).",
	`- layout.rules: the stack's OFFICIAL feature-folder convention as data the tool enforces. moduleDir equals layout.moduleDir. files: every file a feature folder may hold, as path patterns relative to it ({area} {Area} {area_snake}; {name}/{Name}/{name_snake} any kebab-case/PascalCase/snake_case name, use the one this stack names its files with; {sub} a sub-feature folder named after what it does, spelled like the feature folders; (a|b) either word), each with a short doc. require: only files the framework itself needs to load a feature folder (none when the framework finds the code on its own, e.g. autoloading or service discovery); never an empty class just to have one. place: code that may only live in some files (text = regex on the file, in = patterns). forbidDirs: catch-all folder names this stack's convention does NOT use (consider ${DEFAULT_FORBID_DIRS.join(", ")}; leave out any the official convention uses, e.g. Angular core/). maxLines: 400. source: where the convention comes from (the docs page or generator).`,
	"- layout.dataDirs: the folders (project-relative, trailing slash) where this stack's official docs keep database code: schema/models/entities, migrations, seed scripts (e.g. a Spring project with Flyway: src/main/resources/db/migration/ plus the entity package folder). Database work may write only there. layout.dataAccessHint: one line on how data access is written in this stack (ORM entities, query builder, SQL with generated code, …).",
	"- layout.wiringFiles: the files (project-relative paths or globs) where this stack registers a new feature by hand (router/route table, main module, URL config), from the official docs; [] when the framework finds handlers on its own (annotations, file-system routing). A file layout.rules.require names is registered somewhere: that file belongs here. Units edit these files to wire what they add.",
	"- layout.skipMarker: a regex matching a test that is skipped, focused or left incomplete in this stack: every skip, only and incomplete call or annotation its test runner has (from its docs), so a placeholder test is caught. layout.skipSamples: one line of test code for each of those forms, written the way a test file uses it (the runner's own calls and annotations, never a marker of your own); the tool checks that skipMarker matches every sample.",
	"- layout.suppressMarker: a regex matching a comment or annotation that silences this stack's type checker, compiler warnings or linter for a line or a file (every such form the tools have, from their docs), so code that hides an error instead of fixing it is caught.",
	"- migrateFresh: one command that applies every migration of the project, in order, to a NEW EMPTY throwaway database (in-memory, or a temporary one the command itself points at; never the dev, legacy or production database), and fails when a migration cannot be applied. {cmd: \"\", args: []} when the stack has no migrations.",
	"- boot: one command that loads the whole app the way it starts and then exits (the framework's own start, config or container check from its docs), and fails when the app cannot start (a missing folder in config, a service or route that cannot be built). Never a server, watch mode or database. {cmd: \"\", args: []} when the stack has no such check.",
	"- checkConfigGlobs: the files (project-relative paths or globs) that decide how the build, lint, test and boot commands run and what they check: the tools' own config files, the dependency manifests and lock files, env files. Not the app's own config or entry files that new code is registered in: a model writing app code may change those, never these.",
	"- platform: concern → what the target stack uses for it (http, routing, orm, rendering, auth, cache, mail, jobs, events, i18n, logging, tests, …).",
	"- stackChoices: the real decisions within this stack (2–4 options each, packages to install per option, default = the idiomatic one).",
	"- probeTest: the smallest passing test file for a FRESH generated project, at a path the test command picks up. failing: the same file with only the expected value made wrong (e.g. 1 + 1 expected to equal 3), so the test runs and FAILS; the tool checks that the test command fails on it.",
	"Use only commands and packages that exist. Answer only with the JSON object.",
].join("\n");

/**
 * Has a model write the manifest for `id`, then proves it on a scratch project. Each failure (command
 * output) goes back to the model, up to `repairs` times. Returns the verified manifest, or throws with
 * the last failure (e.g. the stack's toolchain is not installed on this machine).
 */
export async function generateAdapter(
	opts: {
		id: string;
		role: "server" | "ui";
		why: string;
		client: ModelClient;
		model: string;
		root: string;
		repairs?: number;
		verify?: (m: AdapterManifest) => Promise<string | undefined>;
		/** Shown the commands before they run; false stops generation. */
		confirm?: (commands: string[]) => Promise<boolean>;
		/** Save the manifest unverified (verified: false) and return: verification runs later (verifyPendingAdapters). */
		deferVerify?: boolean;
		/** A manifest that failed verification, with the failure: the model starts from it instead of from scratch. */
		previous?: { manifest: AdapterManifest; failure: string };
		/**
		 * Tools the manifest runs are missing on this machine: get them installed (owner dialog). true = all present
		 * now, generation goes on; false = the owner picks another stack. Without it a missing tool stops generation.
		 */
		ensureTools?: (missing: string[]) => Promise<boolean>;
		log?: (l: string) => void;
	},
): Promise<AdapterManifest> {
	const log = opts.log ?? (() => {});
	const keepAt = seedDir(opts.root, opts.id);
	const verify = opts.verify ?? ((m: AdapterManifest) => verifyManifest(m, { keepAt }));
	const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
		{ role: "system", content: SYSTEM },
		{ role: "user", content: `Stack: ${opts.id} (role ${opts.role}). Why it was chosen for this migration: ${opts.why}\nWrite its manifest. id must be "${opts.id}"; subdir is the folder name of this project inside the target repo.` },
	];
	if (opts.previous) messages.push({ role: "assistant", content: JSON.stringify({ ...opts.previous.manifest, verified: undefined, seedProject: undefined }) }, { role: "user", content: `Verification failed:\n${opts.previous.failure.slice(-3000)}\nFix the manifest. If a tool is missing on the machine, keep the official command anyway.` });
	let failure = "";
	for (let attempt = 0; attempt <= (opts.repairs ?? 3); attempt++) {
		const res = await opts.client.chat({ model: opts.model, messages, schema: MANIFEST_SCHEMA, effort: "medium" });
		const m = fromModel(res.json, opts.id, opts.role);
		const invalid = validateManifest(m);
		if (!invalid.length) invalid.push(...stackProblems(m));
		let problem: string | undefined = invalid.length ? `invalid manifest:\n${invalid.join("\n")}` : undefined;
		// a tool missing on this machine is not the model's to fix (nor a manifest problem): the owner installs it
		// (offered by ensureTools), then the same manifest goes on to verification
		const missing = invalid.length ? [] : missingTools(m);
		if (missing.length) {
			if (!opts.ensureTools) throw new MissingToolsError(opts.id, missing);
			if (!(await opts.ensureTools(missing))) throw new Error(`generating the ${opts.id} adapter was declined (tools missing: ${missing.join(", ")})`);
			const still = missingTools(m);
			if (still.length) throw new MissingToolsError(opts.id, still);
		}
		if (!problem) {
			if (opts.confirm && !(await opts.confirm(manifestCommands(m)))) throw new Error(`generating the ${opts.id} adapter was declined`);
			if (opts.deferVerify) {
				// the owner's questions go on now; the slow trial build runs after them (verifyPendingAdapters)
				saveManifest(opts.root, { ...m, verified: false });
				log(`  adapter ${opts.id}: written; it is built and tested once all questions are answered`);
				return { ...m, verified: false };
			}
			log(`  adapter ${opts.id}: manifest written (attempt ${attempt + 1}), verifying on a scratch project…`);
			problem = await verify(m).catch((e: any) => String(e?.message ?? e));
		}
		if (!problem) {
			if (!opts.verify && existsSync(join(keepAt, m.subdir || "project"))) m.seedProject = join(keepAt, m.subdir || "project");
			saveManifest(opts.root, { ...m, verified: undefined });
			log(`  adapter ${opts.id}: verified (scaffold, build, probe test)`);
			return m;
		}
		failure = problem;
		// one readable line: the reason, not just its heading (the widget shows one line per entry)
		log(`  adapter ${opts.id}: attempt ${attempt + 1} rejected — ${problem.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 4).join("; ").replace(/:;/, ":")}${attempt < (opts.repairs ?? 3) ? " (the model fixes it)" : ""}`);
		messages.push({ role: "assistant", content: JSON.stringify(m) }, { role: "user", content: `Verification failed:\n${problem.slice(-3000)}\nFix the manifest. If a tool is missing on the machine, keep the official command anyway.` });
	}
	throw new Error(`no working ${opts.id} adapter could be generated: ${failure.split("\n").slice(0, 6).join("\n")}`);
}

function saveManifest(root: string, m: AdapterManifest): void {
	mkdirSync(generatedDir(root), { recursive: true });
	// temp file + rename: a cut-off write never leaves half a manifest behind
	const file = join(generatedDir(root), `${m.id}.json`);
	writeFileSync(`${file}.tmp`, JSON.stringify(m, null, 2) + "\n");
	renameSync(`${file}.tmp`, file);
}

/**
 * A saved manifest written before wiringFiles was asked for, whose layout requires files in every feature folder
 * that no wiring file registers, or that names a wiring file the project no longer has (a setup fix moved it) gets
 * that one question. Only wiringFiles changes (and the require, dropped when the model says the framework registers
 * nothing by hand); the rest of the manifest stays as it is. `dirOf` gives a stack's project dir: without it, or
 * before the project exists, missing files are not looked for. Returns the ids changed.
 */
export async function healWiringFiles(root: string, opts: { client: ModelClient; model: string; dirOf?: (stackId: string) => string; log?: (l: string) => void }): Promise<string[]> {
	const done: string[] = [];
	for (const m of loadManifests(root)) {
		const own = loadLayoutRules(root, m.id);
		const require = (own ?? m.layout.rules)?.require ?? [];
		const dir = opts.dirOf?.(m.id);
		// gone only when git shows the project once had it: a file a unit creates later (or a dir without git) is not stale
		const gone: string[] = [];
		if (dir && existsSync(dir)) for (const w of m.layout.wiringFiles ?? []) if (!/[*?[{]/.test(w) && !existsSync(join(dir, w)) && (await wasTracked(dir, w))) gone.push(w);
		if (m.layout.wiringFiles && (m.layout.wiringFiles.length || !require.length) && !gone.length) continue;
		const ask = gone.length
			? `The ${m.id} manifest names wiring files the project no longer has: ${gone.join(", ")} (layout.wiringFiles now: ${m.layout.wiringFiles!.join(", ")}). The project's files tracked near them:\n${await trackedNear(dir!, gone)}\n\nName the files where the project registers features now (it may have moved them); keep the entries that still hold. Its layout: moduleDir ${m.layout.moduleDir}; files every feature folder must hold (layout.rules.require): ${require.join(", ") || "none"}.`
			: `The ${m.id} manifest has no layout.wiringFiles yet. Its layout: moduleDir ${m.layout.moduleDir}; files every feature folder must hold (layout.rules.require): ${require.join(", ") || "none"}; structure doc:\n${m.layout.structureDoc}`;
		const res = await opts.client.chat({
			model: opts.model,
			effort: "medium",
			schema: obj({ wiringFiles: SA }),
			messages: [
				{ role: "system", content: SYSTEM },
				{ role: "user", content: `${ask}\n\nAnswer only layout.wiringFiles, as the rule above says.` },
			],
		});
		const wiring = (((res.json ?? {}) as { wiringFiles?: string[] }).wiringFiles ?? []).filter((p) => p && !p.startsWith("/") && !p.includes(".."));
		// a moved file with no answer: the working list and its require stay (only the never-asked case drops them)
		if (gone.length && !wiring.length) {
			opts.log?.(`  adapter ${m.id}: wiring files ${gone.join(", ")} are gone and the model named none: list kept`);
			continue;
		}
		m.layout.wiringFiles = wiring;
		// nothing registers the required files: the framework finds them itself, so no folder must hold them
		if (!wiring.length && require.length) {
			if (own) saveLayoutRules(root, m.id, { ...own, require: [] });
			if (m.layout.rules) m.layout.rules = { ...m.layout.rules, require: [] };
		}
		saveManifest(root, m);
		opts.log?.(`  adapter ${m.id}: wiring files ${wiring.join(", ") || "none"}${!wiring.length && require.length ? ` (required ${require.join(", ")} dropped: nothing registers them)` : ""}`);
		done.push(m.id);
	}
	return done;
}

/**
 * A saved manifest written before boot was asked for (or whose model named none) gets that one question: the command
 * that loads the whole app and exits, which the builder and the tidy and code-job checks run so a change that keeps
 * the app from starting does not land. The model names it from the project's files; code runs it on main's project
 * (`dirOf`). A command that fails there goes back to the model once with the output: it fixes the command, or answers
 * the same one when the app itself does not start (main is broken, and the check should say so). No command: an empty
 * one is saved, so it is asked once. A stack whose workspace already sets a boot command (`hasOwn`, the setup fixer's)
 * or whose project is not there yet is left alone. Returns the ids changed.
 */
export async function healBoot(root: string, opts: { client: ModelClient; model: string; dirOf: (stackId: string) => string; hasOwn?: (stackId: string) => boolean; log?: (l: string) => void }): Promise<string[]> {
	const done: string[] = [];
	for (const m of loadManifests(root)) {
		const dir = opts.dirOf(m.id);
		if ("boot" in m || opts.hasOwn?.(m.id) || !existsSync(dir)) continue;
		const files = await exec("git", ["-C", dir, "ls-files"]).then(
			(out) => out.split("\n").filter((f) => f && f.split("/").length <= 2),
			() => readdirSync(dir),
		);
		const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
			{ role: "system", content: SYSTEM },
			{ role: "user", content: `The ${m.id} manifest has no boot command yet (build: ${[m.build.cmd, ...m.build.args].join(" ")}; test: ${[m.test.cmd, ...m.test.args].join(" ")}). The project's tracked files, two folders deep:\n${files.slice(0, 400).join("\n")}${files.length > 400 ? `\n… ${files.length - 400} more` : ""}\n\nAnswer only boot, as the rule above says.` },
		];
		let boot: Cmd = { cmd: "", args: [] };
		for (let round = 0; round < 2; round++) {
			const res = await opts.client.chat({ model: opts.model, effort: "medium", schema: obj({ boot: CMD }), messages });
			const said = ((res.json ?? {}) as { boot?: Cmd }).boot;
			const c: Cmd = said?.cmd ? { cmd: said.cmd, args: said.args ?? [] } : { cmd: "", args: [] };
			// the same command again after its failure: the model says the app itself does not start
			if (!c.cmd || (round > 0 && c.cmd === boot.cmd && c.args.join("\0") === boot.args.join("\0"))) {
				boot = c;
				break;
			}
			boot = c;
			const bad = validateManifest({ ...m, boot: c }).filter((p) => p.startsWith("boot"));
			const failed = bad.length ? bad.join("\n") : await commandFails(fromManifest({ ...m, boot: c }).boot!(dir)!, dir);
			if (failed === undefined) break;
			if (round > 0) boot = { cmd: "", args: [] }; // still failing with a new command: none rather than a wrong one
			messages.push({ role: "assistant", content: JSON.stringify({ boot: c }) }, { role: "user", content: `That command failed in the project (${dir}):\n${failed.slice(-3000)}\nFix the command, or answer the same one if it is right and the app itself does not start.` });
		}
		m.boot = boot;
		saveManifest(root, m);
		opts.log?.(`  adapter ${m.id}: boot ${boot.cmd ? [boot.cmd, ...boot.args].join(" ") : "none"}`);
		done.push(m.id);
	}
	return done;
}

/**
 * A saved manifest written before checkConfigGlobs was asked for: one question to the model, which files of the
 * project decide how the checks run. Code jobs may then change the rest of the protected files (app config, entry
 * files) and never these. Only checkConfigGlobs changes. Returns the stack ids healed.
 */
export async function healCheckConfig(root: string, opts: { client: ModelClient; model: string; dirOf?: (stackId: string) => string; log?: (l: string) => void }): Promise<string[]> {
	const done: string[] = [];
	for (const m of loadManifests(root)) {
		if (m.checkConfigGlobs) continue;
		const dir = opts.dirOf?.(m.id);
		const cmd = (c?: Cmd) => (c?.cmd ? [c.cmd, ...c.args].join(" ") : "none");
		// the files near the project root, where tools keep their config
		const files = dir && existsSync(dir) ? await exec("git", ["-C", dir, "ls-files", "--", "."]).then((o) => o.split("\n").filter((f) => f && f.split("/").length <= 3), () => [] as string[]) : [];
		const res = await opts.client.chat({
			model: opts.model,
			effort: "medium",
			schema: obj({ checkConfigGlobs: SA }),
			messages: [
				{ role: "system", content: SYSTEM },
				{ role: "user", content: `The ${m.id} manifest has no checkConfigGlobs yet. Its commands: build ${cmd(m.build)}; lint ${cmd(m.lint)}; test ${cmd(m.test)}; boot ${cmd(m.boot)}. Its protectedGlobs: ${m.protectedGlobs.join(", ")}. Dependency manifests: ${m.toolchain.manifestFiles.join(", ") || "none"}.\nThe project's tracked files near its root:\n${files.slice(0, 400).join("\n") || "(none)"}${files.length > 400 ? `\n… ${files.length - 400} more` : ""}\n\nAnswer only checkConfigGlobs, as the rule above says.` },
			],
		});
		const globs = (((res.json ?? {}) as { checkConfigGlobs?: string[] }).checkConfigGlobs ?? []).filter((p) => p && !p.startsWith("/") && !p.includes(".."));
		// no answer: the protected list stays the lock, asked again at the next start
		if (!globs.length) {
			opts.log?.(`  adapter ${m.id}: the model named no files that decide how the checks run; the protected list stays the lock`);
			continue;
		}
		m.checkConfigGlobs = globs;
		saveManifest(root, m);
		opts.log?.(`  adapter ${m.id}: files that decide how the checks run: ${globs.join(", ")}`);
		done.push(m.id);
	}
	return done;
}

/**
 * A saved manifest written before skipSamples was asked for: its skip marker was never checked (one written as a
 * marker of the model's own let every skipped and incomplete PHPUnit test through). One question to the model: the
 * marker and one line of test code per skip, focus and incomplete form of the runner; code checks that the marker
 * matches each, and a miss goes back to the model once. Only the marker and its samples change. Returns the ids healed.
 */
export async function healSkipMarker(root: string, opts: { client: ModelClient; model: string; log?: (l: string) => void }): Promise<string[]> {
	const done: string[] = [];
	for (const m of loadManifests(root)) {
		if (m.layout.skipSamples) continue;
		const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
			{ role: "system", content: SYSTEM },
			{ role: "user", content: `The ${m.id} manifest's layout.skipMarker is ${JSON.stringify(m.layout.skipMarker)} and was never checked against the test runner. Its test command: ${[m.test.cmd, ...m.test.args].join(" ")}; its tests: ${m.layout.testHint}\n\nAnswer only layout.skipMarker and layout.skipSamples, as the rule above says.` },
		];
		let healed: { skipMarker: string; skipSamples: string[] } | undefined;
		for (let round = 0; round < 2 && !healed; round++) {
			const res = await opts.client.chat({ model: opts.model, effort: "medium", schema: obj({ skipMarker: S, skipSamples: SA }), messages });
			const a = (res.json ?? {}) as { skipMarker?: string; skipSamples?: string[] };
			const samples = (a.skipSamples ?? []).filter((x) => typeof x === "string" && x.trim());
			const bad = a.skipMarker ? skipProblems(a.skipMarker, samples) : ["no layout.skipMarker given"];
			try {
				new RegExp(a.skipMarker ?? "");
			} catch {
				bad.push("layout.skipMarker is not a valid regex");
			}
			if (!bad.length) healed = { skipMarker: a.skipMarker!, skipSamples: samples };
			else messages.push({ role: "assistant", content: JSON.stringify(a) }, { role: "user", content: `${bad.join("\n")}\nFix the marker so it matches every sample.` });
		}
		// no working answer: the old marker stays, asked again at the next start
		if (!healed) {
			opts.log?.(`  adapter ${m.id}: no skip marker that matches the runner's skip forms; the old one stays`);
			continue;
		}
		m.layout = { ...m.layout, ...healed };
		saveManifest(root, m);
		opts.log?.(`  adapter ${m.id}: skipped and incomplete tests are found by ${healed.skipMarker}`);
		done.push(m.id);
	}
	return done;
}

/**
 * A saved manifest written before migrateFresh was asked for: the database work's check that every migration applies,
 * in order, to an empty database never ran. One question to the model (with the project's files): the command, and
 * the folders that hold database code when the manifest names none. Code runs the command on main's project (`dirOf`);
 * a failure goes back to the model once: it fixes the command, or answers the same one when the migrations themselves
 * fail (the check should say so). When no command exists yet but the project has migrations, `writeTool` (the setup
 * model) may add one to the project and set it as the workspace's command. None is saved as an empty command, so it
 * is asked once. A stack whose workspace already sets one (`hasOwn`) or whose project is not there yet is left alone.
 * Returns the ids changed.
 */
export async function healMigrateFresh(root: string, opts: { client: ModelClient; model: string; dirOf: (stackId: string) => string; hasOwn?: (stackId: string) => boolean; writeTool?: (stackId: string, problem: string) => Promise<boolean>; log?: (l: string) => void }): Promise<string[]> {
	const done: string[] = [];
	for (const m of loadManifests(root)) {
		const dir = opts.dirOf(m.id);
		if ("migrateFresh" in m || opts.hasOwn?.(m.id) || !existsSync(dir)) continue;
		const files = await exec("git", ["-C", dir, "ls-files"]).then(
			(out) => out.split("\n").filter((f) => f && f.split("/").length <= 2),
			() => readdirSync(dir),
		);
		const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
			{ role: "system", content: SYSTEM },
			{ role: "user", content: `The ${m.id} manifest has no migrateFresh command yet${m.layout.dataDirs?.length ? "" : " and no layout.dataDirs"} (test: ${[m.test.cmd, ...m.test.args].join(" ")}; data access: ${m.layout.dataAccessHint || "not said"}). The project's tracked files, two folders deep:\n${files.slice(0, 400).join("\n")}${files.length > 400 ? `\n… ${files.length - 400} more` : ""}\n\nAnswer migrateFresh and layout.dataDirs as the rules above say (dataDirs: keep the folders that already hold the project's database code), and hasMigrations: whether the project keeps database migrations at all.` },
		];
		const schema = obj({ migrateFresh: CMD, dataDirs: SA, hasMigrations: { type: "boolean" } });
		let fresh: Cmd = { cmd: "", args: [] };
		let said: { migrateFresh?: Cmd; dataDirs?: string[]; hasMigrations?: boolean } = {};
		let failed: string | undefined;
		for (let round = 0; round < 2; round++) {
			const res = await opts.client.chat({ model: opts.model, effort: "medium", schema, messages });
			said = { ...said, ...((res.json ?? {}) as typeof said) };
			const c: Cmd = said.migrateFresh?.cmd ? { cmd: said.migrateFresh.cmd, args: said.migrateFresh.args ?? [] } : { cmd: "", args: [] };
			// the same command again after its failure: the model says the migrations themselves fail
			if (!c.cmd || (round > 0 && c.cmd === fresh.cmd && c.args.join("\0") === fresh.args.join("\0"))) {
				fresh = c;
				break;
			}
			fresh = c;
			const bad = validateManifest({ ...m, migrateFresh: c }).filter((p) => p.startsWith("migrateFresh"));
			failed = bad.length ? bad.join("\n") : await commandFails(fromManifest({ ...m, migrateFresh: c }).migrateFresh!(dir)!, dir);
			if (failed === undefined) break;
			if (round > 0) fresh = { cmd: "", args: [] }; // still failing with a new command: none rather than a wrong one
			messages.push({ role: "assistant", content: JSON.stringify(said) }, { role: "user", content: `That command failed in the project (${dir}):\n${failed.slice(-3000)}\nFix the command, or answer the same one if it is right and the migrations themselves fail.` });
		}
		const dataDirs = (said.dataDirs ?? []).filter((p) => p && !p.startsWith("/") && !p.includes("..")).map(slashed);
		const newDirs = !m.layout.dataDirs?.length && dataDirs.length > 0;
		if (newDirs) m.layout = { ...m.layout, dataDirs };
		// migrations but no command for them: the setup model adds one to the project and sets it for this workspace
		const tool = !fresh.cmd && said.hasMigrations && opts.writeTool
			? await opts.writeTool(m.id, `The database work's check needs one command that applies every migration of the project, in order, to a new empty throwaway database and fails when one cannot be applied; the project has none.${failed ? ` The command tried last failed:\n${failed.slice(-2000)}` : ""}\nAdd a small tool script to the project that does this (it makes its own empty database, applies the migrations with the project's migration tool, and removes the database again; several checks may run it at once) and set it with set_gate_command step migrateFresh. Do not change the migrations: a migration that fails is what the check is for.`).catch(() => false)
			: false;
		m.migrateFresh = fresh;
		saveManifest(root, m);
		opts.log?.(`  adapter ${m.id}: migrations on an empty database: ${fresh.cmd ? [fresh.cmd, ...fresh.args].join(" ") : tool ? "a command the setup model set for this workspace" : "none"}${newDirs ? `; database code in ${dataDirs.join(", ")}` : ""}`);
		done.push(m.id);
	}
	return done;
}

/** Runs a command in `dir`: undefined when it exits 0, else its output (it must exit by itself within minutes). */
function commandFails(c: Cmd, dir: string): Promise<string | undefined> {
	return new Promise((res) =>
		execFile(c.cmd, c.args, { cwd: dir, timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, CI: "1" } }, (e, out, err) => res(e ? `${String(out)}\n${String(err)}${e.killed ? "\n[timed out]" : ""}`.trim() || String(e.message) : undefined)),
	);
}

/** git has a commit that touched `file` in the project dir (false without git). */
async function wasTracked(dir: string, file: string): Promise<boolean> {
	try {
		return !!(await exec("git", ["-C", dir, "log", "-1", "--format=%h", "--", file])).trim();
	} catch {
		return false;
	}
}

/** The tracked files in the nearest folder that still holds each missing path (the project root at worst), capped. */
async function trackedNear(dir: string, missing: string[]): Promise<string> {
	const near = (p: string): string => (p === "." || existsSync(join(dir, p)) ? p : near(dirname(p)));
	const dirs = [...new Set(missing.map((p) => near(dirname(p))))];
	const files = await exec("git", ["-C", dir, "ls-files", "--", ...dirs]).then(
		(out) => out.split("\n").filter(Boolean),
		() => [],
	);
	return files.length ? `${files.slice(0, 300).join("\n")}${files.length > 300 ? `\n… ${files.length - 300} more` : ""}` : "(none tracked)";
}

/** A generated adapter that could not be made to work: its manifest is gone, the stack choice should be asked again. */
export class AdapterGaveUpError extends Error {
	constructor(readonly id: string, readonly role: "server" | "ui", message: string) {
		super(message);
	}
}

/**
 * Prove every adapter written during the questions (verified: false): build and test a fresh project, kept as
 * the seed setup moves into place. A failure goes back to the model (when there is one) for a fixed manifest,
 * proven the same way. Throws in plain words when an adapter cannot be made to work: after the model's repairs
 * also failed, the manifest is removed (AdapterGaveUpError) so the stack is asked again instead of paid for again
 * on every resume. Returns the ids proven.
 */
export async function verifyPendingAdapters(
	root: string,
	opts: { client?: ModelClient; model: string; log?: (l: string) => void; ensureTools?: (missing: string[], stack: string) => Promise<boolean> },
): Promise<string[]> {
	const log = opts.log ?? (() => {});
	const done: string[] = [];
	for (const m of loadManifests(root).filter((x) => x.verified === false)) {
		const missing = missingTools(m);
		if (missing.length && !(opts.ensureTools && (await opts.ensureTools(missing, m.id)) && !missingTools(m).length)) throw new MissingToolsError(m.id, missingTools(m));
		log(`  adapter ${m.id}: building and testing a fresh ${m.id} project (official generator, packages, build, a probe test); it becomes your new project`);
		const keepAt = seedDir(root, m.id);
		const failure = await verifyManifest(m, { keepAt }).catch((e: any) => String(e?.message ?? e));
		if (!failure) {
			saveManifest(root, { ...m, verified: undefined, seedProject: join(keepAt, m.subdir || "project") });
			log(`  adapter ${m.id}: works (build and test pass on a fresh project)`);
			done.push(m.id);
			continue;
		}
		log(`  adapter ${m.id}: the check failed — ${failure.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3).join("; ")}`);
		if (!opts.client) throw new Error(`the ${m.id} setup does not work yet: ${failure.split("\n").slice(0, 4).join(" ")}`);
		const { verified: _v, seedProject: _s, ...prev } = m;
		try {
			await generateAdapter({ id: m.id, role: m.role, why: "chosen by the owner during onboarding", client: opts.client, model: opts.model, root, previous: { manifest: prev as AdapterManifest, failure }, ensureTools: opts.ensureTools && ((t) => opts.ensureTools!(t, m.id)), log });
		} catch (e: any) {
			if (e instanceof MissingToolsError) throw e; // the owner installs them and resumes: the choice stands
			for (const n of [`${m.id}.json`, `${m.id}.seed`]) await rm(join(generatedDir(root), n), { recursive: true, force: true });
			throw new AdapterGaveUpError(m.id, m.role, String(e?.message ?? e));
		}
		done.push(m.id);
	}
	return done;
}

/** Executables a manifest runs that are not on PATH (project-relative ones appear after scaffolding). */
export function missingTools(m: AdapterManifest): string[] {
	const dirs = (process.env["PATH"] ?? "").split(delimiter).filter(Boolean);
	const cmds = [m.scaffold, ...(m.postScaffold ?? []), m.build, m.lint, m.test, ...(m.migrateFresh?.cmd ? [m.migrateFresh] : []), ...(m.boot?.cmd ? [m.boot] : []), m.toolchain.add, ...(m.toolchain.installed?.list?.cmd ? [m.toolchain.installed.list] : [])].map((c) => c.cmd).filter((c) => !c.includes("/"));
	return [...new Set(cmds)].filter((c) => !dirs.some((d) => existsSync(join(d, c))));
}

type KV = Array<{ key: string; value: string }>;
const asMap = (x: unknown): Record<string, string> => (Array.isArray(x) ? Object.fromEntries((x as KV).map((e) => [e.key, e.value])) : ((x ?? {}) as Record<string, string>));
/** The model's JSON (maps as key/value lists) → a manifest. */
function fromModel(json: unknown, id: string, role: "server" | "ui"): AdapterManifest {
	const j = (json ?? {}) as AdapterManifest;
	return {
		...j,
		id,
		role,
		postScaffold: j.postScaffold ?? [],
		platform: asMap(j.platform),
		layout: { ...j.layout, langByExtension: asMap(j.layout?.langByExtension) },
		// asked and answered: none is saved as an empty command, so the run-start heal does not ask again
		migrateFresh: j.migrateFresh?.cmd ? j.migrateFresh : { cmd: "", args: [] },
		boot: j.boot?.cmd ? j.boot : undefined,
		stackChoices: (j.stackChoices ?? []).map((c) => ({ ...c, options: c.options.map((o) => ({ ...o, platform: asMap(o.platform) })) })),
	};
}

/** Scaffold → build → probe test on a scratch project; undefined when all pass, else what failed. */
export async function verifyManifest(m: AdapterManifest, opts: { keepAt?: string } = {}): Promise<string | undefined> {
	// keepAt: the verified project stays there (probe test removed) for setup to reuse; a failed one is removed
	if (opts.keepAt) await rm(opts.keepAt, { recursive: true, force: true });
	const scratch = opts.keepAt ?? mkdtempSync(join(tmpdir(), `br-adapter-${m.id}-`));
	mkdirSync(scratch, { recursive: true });
	const a = fromManifest(m);
	const dir = join(scratch, m.subdir || "project");
	let ok = false;
	try {
		try {
			await a.scaffoldProject(dir);
		} catch (e: any) {
			return `scaffold failed (${m.scaffold.cmd} ${m.scaffold.args.join(" ")}):\n${String(e?.message ?? e)}`;
		}
		if (!a.toolchain.isProjectReady(dir)) return `scaffold ran but ${m.scaffold.readyFile} is missing in the generated project (files: ${existsSync(dir) ? readdirSync(dir).join(", ") : "none"})`;
		// the run counts a shared dir the generator made as the framework's (layout-rules generatorDirs): never shared app code
		const made = (m.layout.sharedDirs ?? []).filter((d) => existsSync(join(dir, d)));
		if (made.length) return `layout.sharedDirs ${made.join(", ")}: the generator already made ${made.length > 1 ? "these folders" : "this folder"}, so ${made.length > 1 ? "they are" : "it is"} the framework's own, not shared app code. Give one folder for app code that several feature areas use, next to the feature folders (e.g. src/Shared/).`;
		const probe = m.probeTest;
		mkdirSync(dirname(join(dir, probe.path)), { recursive: true });
		writeFileSync(join(dir, probe.path), probe.content);
		if (!a.layout.isTestFile(probe.path)) return `probeTest.path ${probe.path} does not match layout.testFileRegex ${m.layout.testFileRegex}`;
		for (const [step, c] of [["build", a.build(dir)], ["test", a.test(dir, [probe.path])], ...(a.migrateFresh ? [["migrateFresh", a.migrateFresh(dir)!] as const] : []), ...(a.boot ? [["boot", a.boot(dir)!] as const] : [])] as const) {
			try {
				await runCommand(c.cmd, c.args, { cwd: dir });
			} catch (e: any) {
				return `${step} failed on the fresh project (${c.cmd} ${c.args.join(" ")}):\n${String(e?.message ?? e)}`;
			}
		}
		// a test command that cannot fail proves nothing: the probe with a wrong expected value must make it fail
		if (!probe.failing) return "probeTest.failing is missing: give the same test with a wrong expected value";
		writeFileSync(join(dir, probe.path), probe.failing);
		const t = a.test(dir, [probe.path]);
		const passed = await runCommand(t.cmd, t.args, { cwd: dir }).then(
			() => true,
			() => false,
		);
		writeFileSync(join(dir, probe.path), probe.content);
		if (passed) return `the test command (${t.cmd} ${t.args.join(" ")}) passes probeTest.failing, a test with a wrong expected value: the command does not run the given test file, or probeTest.failing does not fail`;
		// the whole-project test run (no files) must find tests where the layout puts them: a broken copy of the
		// probe at the first test glob has to make it fail
		const at = firstGlobFile(a, probe.path);
		if (!at) return `layout.testFileGlobs gives no place for a test file (first glob: ${m.layout.testFileGlobs[0] ?? "none"})`;
		if (!a.layout.isTestFile(at)) return `${at} (the first layout.testFileGlobs place) does not match layout.testFileRegex ${m.layout.testFileRegex}`;
		mkdirSync(dirname(join(dir, at)), { recursive: true });
		writeFileSync(join(dir, at), `${probe.content}\n)))}}}]]] this line breaks the file on purpose\n`);
		const all = a.test(dir, []);
		const missed = await runCommand(all.cmd, all.args, { cwd: dir }).then(
			() => true,
			() => false,
		);
		rmSync(join(dir, at), { force: true });
		if (missed) return `the test command without files (${all.cmd} ${all.args.join(" ")}) does not run tests at ${at}, the first layout.testFileGlobs place (a broken test file there did not make it fail). Fix layout.testFileGlobs or the test command so the whole-project test run includes the tests where the layout puts them.`;
		rmSync(join(dir, probe.path), { force: true });
		ok = true;
		return undefined;
	} finally {
		if (!ok || !opts.keepAt) await rm(scratch, { recursive: true, force: true });
	}
}

/**
 * A test file in the FIRST test glob of an example area (tests/{Area}/**\/*.spec.ext → tests/probe/probe.spec.ext):
 * the probe's own file name when the glob allows it, else the glob's name with "Probe" for the wildcard.
 */
export function firstGlobFile(a: TargetAdapter, probePath: string): string | undefined {
	const glob = a.layout.testFileGlobs(a.layout.moduleDir("probe"))[0];
	if (!glob) return undefined;
	const parts = glob.split("/");
	const last = parts.pop()!;
	const wild = parts.findIndex((p) => /[*?[{]/.test(p));
	const dir = (wild < 0 ? parts : parts.slice(0, wild)).join("/");
	const re = new RegExp(`^${last.replace(/[.+^$()|\\]/g, "\\$&").replace(/\{([^}]*)\}/g, (_, x: string) => `(${x.split(",").join("|")})`).replace(/\*+/g, ".*").replace(/\?/g, ".")}$`);
	const own = basename(probePath);
	const name = re.test(own) ? own : last.replace(/\{([^},]*)[^}]*\}/g, "$1").replace(/\*+/g, "Probe").replace(/\?/g, "x");
	return dir ? `${dir}/${name}` : name;
}

/** Where a workspace keeps the project an adapter's verification built. */
export const seedDir = (root: string, id: string) => join(generatedDir(root), `${id}.seed`);
