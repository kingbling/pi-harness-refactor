import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { runCommand } from "../../proc.ts";
import { MissingToolsError } from "../../init/toolchain-install.ts";
import type { ModelClient } from "../../models/types.ts";
import type { StackChoice, TargetAdapter } from "../types.ts";
import { DEFAULT_FORBID_DIRS, normalize, slashed, validateLayoutRules, type LayoutRules } from "../../rules/layout-rules.ts";

/**
 * A target adapter for a stack bigrefactor has no hand-written adapter for, written as DATA by a model that
 * knows the stack's official tooling, and interpreted here. The project is still bootstrapped by the stack's
 * official generator (the manifest names the command), never by model-written code. Before it is used, the
 * manifest is verified on a scratch project: scaffold → build → probe test; failures go back to the model.
 *
 * Optional code hooks of hand-written adapters (symbol index, structure checks, registration wiring) are
 * absent: the gate runs without them, and units register their own wiring.
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
	toolchain: {
		ecosystem: string;
		packageName: string;
		packageExamples: string[];
		manifestFiles: string[];
		/** Where installed package names are listed: a JSON manifest and the object keys holding them. */
		installed: { file: string; keys: string[] };
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
		interfaceHint: string;
		testHint: string;
		/** `{why}` expands. */
		legacyMarker: string;
		dataAccessHint: string;
		ignoreDirs: string[];
		/** The stack's official feature-folder convention as checkable data (proposed at onboarding; see rules/layout-rules.ts). Older manifests have none. */
		rules?: LayoutRules;
	};
	platform: Record<string, string>;
	stackChoices: StackChoice[];
	protectedGlobs: string[];
	patternKinds: string[];
	/** A minimal test proving the toolchain works on a fresh project. */
	probeTest: { path: string; content: string };
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
			installedPackages: (dir) => {
				try {
					const j = JSON.parse(readFileSync(join(dir, m.toolchain.installed.file), "utf8")) as Record<string, Record<string, unknown>>;
					return m.toolchain.installed.keys.flatMap((k) => Object.keys(j[k] ?? {}));
				} catch {
					return [];
				}
			},
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
			interfaceHint: m.layout.interfaceHint,
			testHint: m.layout.testHint,
			legacyMarker: (why) => m.layout.legacyMarker.replace(/\{why\}/g, why),
			dataAccessHint: m.layout.dataAccessHint || undefined,
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
		protectedGlobs: m.protectedGlobs,
		generatedFiles: [],
		patternKinds: m.patternKinds,
		...(layoutRules ? { layoutRules } : {}),
	};
}

// ---- validation: model-written commands run on the owner's machine ------------------------------------

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "cmd", "cmd.exe", "powershell", "pwsh", "eval", "exec", "env", "xargs", "sudo", "su", "doas"]);
/** Every command a manifest would run, for the owner to see before anything runs. */
export function manifestCommands(m: AdapterManifest): string[] {
	return [["scaffold", m.scaffold], ...(m.postScaffold ?? []).map((c, i) => [`after scaffold ${i + 1}`, c] as const), ["build", m.build], ["lint", m.lint], ["test", m.test], ["add packages", m.toolchain.add]].map(([k, c]) => `${k}: ${(c as Cmd).cmd} ${(c as Cmd).args.join(" ")}`);
}
/** Problems that make a manifest unusable; empty = structurally sound (it still has to pass verification). */
export function validateManifest(m: AdapterManifest): string[] {
	const out: string[] = [];
	for (const [k, c] of [["scaffold", m.scaffold], ...(m.postScaffold ?? []).map((c, i) => [`postScaffold[${i}]`, c] as const), ["build", m.build], ["lint", m.lint], ["test", m.test], ["toolchain.add", m.toolchain?.add]] as const) {
		if (!c || typeof c.cmd !== "string" || !Array.isArray(c.args)) {
			out.push(`${k}: needs cmd + args`);
			continue;
		}
		// one executable (a name or a project-relative path), never a shell or a command line
		if (!/^[\w@+.-]+(\/[\w@+.-]+)*$/.test(c.cmd) || c.cmd.includes("..")) out.push(`${k}.cmd "${c.cmd}" must be a single executable name or project-relative path`);
		if (SHELLS.has(basename(c.cmd).toLowerCase())) out.push(`${k}.cmd "${c.cmd}" is a shell/launcher; name the tool itself`);
		if (c.args.some((a) => typeof a !== "string" || /[;&|`$<>\n]/.test(a))) out.push(`${k}.args contain shell syntax; give plain arguments`);
	}
	for (const [k, re] of [["toolchain.packageName", m.toolchain?.packageName], ["layout.testFileRegex", m.layout?.testFileRegex], ["layout.skipMarker", m.layout?.skipMarker]] as const) {
		try {
			new RegExp(re ?? "");
		} catch {
			out.push(`${k} is not a valid regex`);
		}
	}
	if (!/^[a-z0-9][a-z0-9.-]*$/.test(m.subdir ?? "")) out.push("subdir must be a plain folder name");
	for (const k of ["readyFile"] as const) if (!m.scaffold?.[k] || m.scaffold[k].includes("..")) out.push(`scaffold.${k} must be a project-relative file`);
	if (!m.probeTest?.path || m.probeTest.path.startsWith("/") || m.probeTest.path.includes("..")) out.push("probeTest.path must be project-relative");
	if (!m.layout?.sourceExtensions?.length) out.push("layout.sourceExtensions is empty");
	if (!m.patternKinds?.length) out.push("patternKinds is empty");
	if (m.layout?.rules) {
		const r = normalize(m.layout.rules);
		if (r.moduleDir !== m.layout.moduleDir) out.push(`layout.rules.moduleDir "${r.moduleDir}" must equal layout.moduleDir "${m.layout.moduleDir}"`);
		out.push(...validateLayoutRules(r).map((p) => `layout.rules: ${p}`));
	}
	return out;
}

// ---- generation + verification ------------------------------------------------------------------------

export function generatedDir(root: string): string {
	return join(root, ".bigrefactor", "adapters");
}
/**
 * A stack's generated adapter that a fresh start left behind in .bigrefactor.old-<time>/adapters (before fresh
 * starts kept them): copied back, newest first. Returns whether one was found.
 */
export function restoreManifest(root: string, id: string): boolean {
	const olds = existsSync(root) ? readdirSync(root).filter((n) => n.startsWith(".bigrefactor.old-")).sort().reverse() : [];
	for (const old of olds) {
		const from = join(root, old, "adapters");
		if (!existsSync(join(from, `${id}.json`))) continue;
		mkdirSync(generatedDir(root), { recursive: true });
		for (const n of [`${id}.json`, `${id}.seed`]) if (existsSync(join(from, n))) cpSync(join(from, n), join(generatedDir(root), n), { recursive: true });
		return true;
	}
	return false;
}

/** Verified manifests of this workspace (an invalid one, e.g. edited by hand, is skipped, never run). */
export function loadManifests(root: string): AdapterManifest[] {
	const dir = generatedDir(root);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((n) => n.endsWith(".json"))
		.map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")) as AdapterManifest)
		.filter((m) => !validateManifest(m).length);
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
	toolchain: obj({ ecosystem: S, packageName: S, packageExamples: SA, manifestFiles: SA, installed: obj({ file: S, keys: SA }), add: CMD, worktreeLinks: SA, ignoredPaths: SA }),
	layout: obj({ moduleDir: S, structureDoc: S, sharedDirs: SA, testFileGlobs: SA, testFileRegex: S, sourceExtensions: SA, langByExtension: MAP, skipMarker: S, interfaceHint: S, testHint: S, legacyMarker: S, dataAccessHint: S, ignoreDirs: SA, rules: LAYOUT_RULES_SCHEMA }),
	platform: MAP,
	stackChoices: { type: "array", items: obj({ key: S, question: S, default: S, options: { type: "array", items: OPTION } }) },
	protectedGlobs: SA,
	patternKinds: SA,
	probeTest: obj({ path: S, content: S }),
	detect: obj({ file: S, contains: S }),
});

const SYSTEM = [
	"You write a target adapter manifest for an automated legacy migration tool. It is DATA, interpreted by the tool:",
	"- scaffold: the stack's OFFICIAL project generator, non-interactive, run in the parent dir; {name} is the project folder. readyFile appears in a generated project. postScaffold: commands run inside the new project afterwards so build and test work (install dependencies, add the test runner if the generator has none).",
	"- build/lint/test: commands run in the project dir. A {files} argument expands to file paths (may be empty). Build must fail on type/compile errors; test must run only the given files when there are some.",
	"- EVERY command is ONE executable with plain arguments, run without a shell: no sh/bash/cmd -c, no pipes, &&, ;, $, redirects, loops or globs. When the stack has no single build command, use its main static checker as build (e.g. PHP: vendor/bin/phpstan analyse src; Python: mypy or python -m compileall; Ruby: bundle exec rubocop), its linter/formatter check as lint, and its test runner as test with {files} appended (e.g. vendor/bin/phpunit {files}). Tools installed into the project are called by their project-relative path (vendor/bin/…, node_modules/.bin/…, bin/console) and added in postScaffold.",
	"- toolchain.installed: a JSON manifest file in the project and the object keys whose keys are package names. toolchain.packageName: a regex (anchored with ^) matching a package name.",
	"- layout.moduleDir: where one feature area of the app lives ({area}, {Area}, {area_snake} expand); one directory per area, not per layer.",
	"- layout.sharedDirs: usually ONE folder for app code that several feature areas use (e.g. src/Shared/ next to the feature folders), spelled like the feature folders. Never the framework's own folders such as config, templates or tests: those are not shared app code.",
	"- layout.testFileGlobs: where the stack's official convention keeps an area's tests ({moduleDir}, {area}, {Area}, {area_snake} expand). Next to the code ({moduleDir}/…) only where the framework expects that; where the app loads everything under its source dir as app code (service containers, autoloaded apps), tests go in the official tests dir mirrored per area (e.g. tests/{Area}/…), or the app will not start. The FIRST glob must be a place the test command without {files} runs (the tool checks this with the probe test).",
	`- layout.rules: the stack's OFFICIAL feature-folder convention as data the tool enforces. moduleDir equals layout.moduleDir. files: every file a feature folder may hold, as path patterns relative to it ({area} {Area} {area_snake}; {name}/{Name}/{name_snake} any kebab-case/PascalCase/snake_case name, use the one this stack names its files with; {sub} a sub-feature folder named after what it does, spelled like the feature folders; (a|b) either word), each with a short doc. require: only files the framework itself needs to load a feature folder (none when the framework finds the code on its own, e.g. autoloading or service discovery); never an empty class just to have one. place: code that may only live in some files (text = regex on the file, in = patterns). forbidDirs: catch-all folder names this stack's convention does NOT use (consider ${DEFAULT_FORBID_DIRS.join(", ")}; leave out any the official convention uses, e.g. Angular core/). maxLines: 400. source: where the convention comes from (the docs page or generator).`,
	"- platform: concern → what the target stack uses for it (http, routing, orm, rendering, auth, cache, mail, jobs, events, i18n, logging, tests, …).",
	"- stackChoices: the real decisions within this stack (2–4 options each, packages to install per option, default = the idiomatic one).",
	"- probeTest: the smallest passing test file for a FRESH generated project, at a path the test command picks up.",
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
	writeFileSync(join(generatedDir(root), `${m.id}.json`), JSON.stringify(m, null, 2) + "\n");
}

/**
 * Prove every adapter written during the questions (verified: false): build and test a fresh project, kept as
 * the seed setup moves into place. A failure goes back to the model (when there is one) for a fixed manifest,
 * proven the same way. Throws in plain words when an adapter cannot be made to work. Returns the ids proven.
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
		await generateAdapter({ id: m.id, role: m.role, why: "chosen by the owner during onboarding", client: opts.client, model: opts.model, root, previous: { manifest: prev as AdapterManifest, failure }, ensureTools: opts.ensureTools && ((t) => opts.ensureTools!(t, m.id)), log });
		done.push(m.id);
	}
	return done;
}

/** Executables a manifest runs that are not on PATH (project-relative ones appear after scaffolding). */
export function missingTools(m: AdapterManifest): string[] {
	const dirs = (process.env["PATH"] ?? "").split(delimiter).filter(Boolean);
	const cmds = [m.scaffold, ...(m.postScaffold ?? []), m.build, m.lint, m.test, m.toolchain.add].map((c) => c.cmd).filter((c) => !c.includes("/"));
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
		stackChoices: (j.stackChoices ?? []).map((c) => ({ ...c, options: c.options.map((o) => ({ ...o, platform: asMap(o.platform) })) })),
	};
}

/** Scaffold → build → probe test on a scratch project; undefined when all pass, else what failed. */
export async function verifyManifest(m: AdapterManifest, opts: { keepAt?: string } = {}): Promise<string | undefined> {
	// keepAt: the verified project stays there (probe test removed) for setup to reuse; a failed one is removed
	if (opts.keepAt) rmSync(opts.keepAt, { recursive: true, force: true });
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
		const probe = m.probeTest;
		mkdirSync(dirname(join(dir, probe.path)), { recursive: true });
		writeFileSync(join(dir, probe.path), probe.content);
		if (!a.layout.isTestFile(probe.path)) return `probeTest.path ${probe.path} does not match layout.testFileRegex ${m.layout.testFileRegex}`;
		for (const [step, c] of [["build", a.build(dir)], ["test", a.test(dir, [probe.path])]] as const) {
			try {
				await runCommand(c.cmd, c.args, { cwd: dir });
			} catch (e: any) {
				return `${step} failed on the fresh project (${c.cmd} ${c.args.join(" ")}):\n${String(e?.message ?? e)}`;
			}
		}
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
		if (!ok || !opts.keepAt) rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * A test file in the FIRST test glob of an example area (tests/{Area}/**\/*Test.php → tests/Probe/ProbeTest.php):
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
