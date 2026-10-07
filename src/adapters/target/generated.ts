import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { runCommand } from "../../proc.ts";
import type { ModelClient } from "../../models/types.ts";
import type { StackChoice, TargetAdapter } from "../types.ts";

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
	};
	platform: Record<string, string>;
	stackChoices: StackChoice[];
	protectedGlobs: string[];
	patternKinds: string[];
	/** A minimal test proving the toolchain works on a fresh project. */
	probeTest: { path: string; content: string };
	/** File (relative to a project root) that only this stack's projects have, and text it contains. */
	detect: { file: string; contains: string };
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
	const testRe = new RegExp(m.layout.testFileRegex);
	const moduleDir = (area: string) => m.layout.moduleDir.replace(/\{area\}/g, area).replace(/\{Area\}/g, pascal(area)).replace(/\{area_snake\}/g, area.replace(/-/g, "_"));
	return {
		id: m.id,
		role: m.role,
		subdir: m.subdir,
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
			sharedDirs: m.layout.sharedDirs,
			testFileGlobs: (dir) => m.layout.testFileGlobs.map((g) => g.replace(/\{moduleDir\}/g, dir)),
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
		build: (root) => expand(m.build, { dir: root, files: [] }),
		lint: (root, files) => expand(m.lint, { dir: root, files }),
		test: (root, related) => expand(m.test, { dir: root, files: related }),
		protectedGlobs: m.protectedGlobs,
		generatedFiles: [],
		patternKinds: m.patternKinds,
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
	return out;
}

// ---- generation + verification ------------------------------------------------------------------------

export function generatedDir(root: string): string {
	return join(root, ".bigrefactor", "adapters");
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
	layout: obj({ moduleDir: S, structureDoc: S, sharedDirs: SA, testFileGlobs: SA, testFileRegex: S, sourceExtensions: SA, langByExtension: MAP, skipMarker: S, interfaceHint: S, testHint: S, legacyMarker: S, dataAccessHint: S, ignoreDirs: SA }),
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
	"- toolchain.installed: a JSON manifest file in the project and the object keys whose keys are package names. toolchain.packageName: a regex (anchored with ^) matching a package name.",
	"- layout.moduleDir: where one feature area of the app lives ({area}, {Area}, {area_snake} expand); one directory per area, not per layer. testFileGlobs use {moduleDir}.",
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
		log?: (l: string) => void;
	},
): Promise<AdapterManifest> {
	const log = opts.log ?? (() => {});
	const verify = opts.verify ?? verifyManifest;
	const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
		{ role: "system", content: SYSTEM },
		{ role: "user", content: `Stack: ${opts.id} (role ${opts.role}). Why it was chosen for this migration: ${opts.why}\nWrite its manifest. id must be "${opts.id}"; subdir is the folder name of this project inside the target repo.` },
	];
	let failure = "";
	for (let attempt = 0; attempt <= (opts.repairs ?? 2); attempt++) {
		const res = await opts.client.chat({ model: opts.model, messages, schema: MANIFEST_SCHEMA, effort: "medium" });
		const m = fromModel(res.json, opts.id, opts.role);
		const invalid = validateManifest(m);
		let problem: string | undefined = invalid.length ? `invalid manifest:\n${invalid.join("\n")}` : undefined;
		// a tool missing on this machine is not the model's to fix: say what to install, stop
		const missing = invalid.length ? [] : missingTools(m);
		if (missing.length) throw new Error(`the ${opts.id} toolchain needs ${missing.join(", ")} on this machine (not found on PATH); install it and pick ${opts.id} again`);
		if (!problem) {
			if (opts.confirm && !(await opts.confirm(manifestCommands(m)))) throw new Error(`generating the ${opts.id} adapter was declined`);
			log(`  adapter ${opts.id}: manifest written (attempt ${attempt + 1}), verifying on a scratch project…`);
			problem = await verify(m).catch((e: any) => String(e?.message ?? e));
		}
		if (!problem) {
			mkdirSync(generatedDir(opts.root), { recursive: true });
			writeFileSync(join(generatedDir(opts.root), `${opts.id}.json`), JSON.stringify(m, null, 2) + "\n");
			log(`  adapter ${opts.id}: verified (scaffold, build, probe test)`);
			return m;
		}
		failure = problem;
		log(`  adapter ${opts.id}: ${problem.split("\n")[0]}`);
		messages.push({ role: "assistant", content: JSON.stringify(m) }, { role: "user", content: `Verification failed:\n${problem.slice(-3000)}\nFix the manifest. If a tool is missing on the machine, keep the official command anyway.` });
	}
	throw new Error(`no working ${opts.id} adapter could be generated: ${failure.split("\n").slice(0, 6).join("\n")}`);
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
export async function verifyManifest(m: AdapterManifest): Promise<string | undefined> {
	const scratch = mkdtempSync(join(tmpdir(), `br-adapter-${m.id}-`));
	const a = fromManifest(m);
	const dir = join(scratch, m.subdir || "project");
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
		return undefined;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}
