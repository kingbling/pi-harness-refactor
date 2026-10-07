import { runCommand } from "../proc.ts";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { CONFIG_FILE, ConfigSchema, saveConfig, type Config } from "../config.ts";
import { getSourceAdapter, getTargetAdapter, knownSources, TARGET_SUBDIRS, targetIdFor } from "../adapters/registry.ts";
import type { TargetAdapter } from "../adapters/types.ts";
import { commitAll, ensureRepo, headOf } from "../git.ts";
import { fetchDocs } from "./docs.ts";
import { libraryPlan, parseChoiceFlag, parseReplaceFlag, renderStackPlan, resolveChoices } from "./stack.ts";
import { loadDecisions, recordEarlyDecision } from "../inventory/decisions.ts";

export interface PromptOption {
	value: string;
	label: string;
	hint?: string;
}

/**
 * The interview's UI surface. The CLI answers with @clack/prompts on the terminal; the Pi extension
 * answers with Pi's own dialogs. `undefined` from any prompt means the user cancelled.
 */
export interface InitPrompter {
	text(message: string, initial: string): Promise<string | undefined>;
	select(message: string, options: PromptOption[], initial?: string): Promise<string | undefined>;
	/** Checkboxes plus a free-text note (`other` is the hint of the note field). */
	multi?(message: string, options: PromptOption[], initial: string[], other: string): Promise<{ values: string[]; note: string } | undefined>;
	log(line: string): void;
}

export interface InitOptions {
	/** Workspace directory that receives bigrefactor.config.json. Defaults to process.cwd(). */
	root?: string;
	/** Defaults to the terminal (clack) prompter. */
	prompter?: InitPrompter;
	/** Called from `br onboard`: no "next: br setup …" hint, the orchestrator continues itself. */
	embedded?: boolean;
	/** Model client for stack advice; default: OpenRouter when a key resolves. `--no-llm` disables. */
	client?: import("../models/types.ts").ModelClient;
}

/** Terminal prompter: @clack/prompts, cancel exits the process like before. */
export const terminalPrompter: InitPrompter = {
	// default shown as placeholder, taken on Enter; typing replaces it instead of appending to it
	text: async (message, initial) => str(await p.text({ message, placeholder: initial, defaultValue: initial })),
	select: async (message, options, initialValue) => str(await p.select({ message, options, initialValue })),
	multi: async (message, options, initialValues, other) => {
		const v = await p.multiselect({ message, options, initialValues, required: false });
		if (p.isCancel(v)) return undefined;
		const note = await p.text({ message: "Anything else? (your own words, optional)", placeholder: other, defaultValue: "" });
		if (p.isCancel(note)) return undefined;
		return { values: v as string[], note: String(note ?? "").trim() };
	},
	log: (line) => console.log(line),
};

function saveSurvey(root: string, rec: { targets: string[]; dbStrategy: string; dbFrom: string[]; why: string[] }): void {
	const d = loadDecisions(root);
	d.survey = { targets: rec.targets, dbStrategy: rec.dbStrategy, dbFrom: rec.dbFrom, why: rec.why };
	mkdirSync(join(root, ".bigrefactor"), { recursive: true });
	writeFileSync(join(root, ".bigrefactor", "decisions.json"), JSON.stringify(d, null, 2) + "\n");
}

/** Target engine = the api target's "database" stack choice (adapter-defined), resolved against the legacy engines. */
function dbTarget(choices: Config["target"]["choices"], from: string[]): string | undefined {
	for (const c of Object.values(choices)) if (c["database"]) {
		const id = c["database"];
		return id === "postgres" ? "postgresql" : id === "mysql" ? (from.includes("mariadb") ? "mariadb" : "mysql") : id === "legacy" ? from[0] : id;
	}
	return undefined;
}

export async function init(args: string[], opts: InitOptions = {}): Promise<string> {
	const flag = (n: string) => {
		const i = args.indexOf(n);
		return i >= 0 ? args[i + 1] : undefined;
	};
	const yes = args.includes("--yes");
	const root = resolve(opts.root ?? process.cwd());
	const ui = opts.prompter ?? terminalPrompter;
	const terminal = ui === terminalPrompter;
	const cancelled = () => new Error("init cancelled");
	if (existsSync(resolve(root, CONFIG_FILE)) && !args.includes("--force")) {
		throw new Error(`${CONFIG_FILE} already exists here; use --force to overwrite`);
	}

	let sourcePath = flag("--source");
	let stack = flag("--stack");
	let targetPath = flag("--target");
	let to = flag("--to") ? parseTargets(flag("--to")!).ids : undefined;
	let db = flag("--db") as Config["db"]["strategy"] | undefined;
	// Survey before asking: every default below comes from what the legacy repo contains.
	const runSurvey = async (src: string) => {
		const { surveySource, recommend, renderSurvey } = await import("./survey.ts");
		const abs = resolve(root, src);
		const guesses = await Promise.all(knownSources().map(async (id) => ({ id, c: (await getSourceAdapter(id).detect(abs)).confidence })));
		const best = guesses.sort((a, b) => b.c - a.c)[0];
		const adapterId = stack ?? (best && best.c > 0 ? best.id : undefined);
		// no adapter recognises the repo: say so instead of reading it as the first language we happen to support
		if (!adapterId) throw new Error(`no source adapter recognises ${src} (have: ${knownSources().join(", ")}); pass the stack explicitly or add an adapter`);
		const survey = await surveySource(abs, getSourceAdapter(adapterId));
		const rec = recommend(survey, src);
		ui.log(renderSurvey(survey, rec));
		return { survey, rec };
	};
	let surveyed!: Awaited<ReturnType<typeof runSurvey>>;

	// Only the two folders are asked. Everything else is gathered first and decided afterwards, from data
	// (`br onboard`: inventory → profile → frameworks → advise → decide). The config written here holds the
	// survey's recommendations as provisional values so data gathering can run; `br decide` confirms them.
	if (!yes) {
		if (terminal) p.intro(pc.bgCyan(pc.black(" bigrefactor init ")));
		let problem = sourcePath && !isDir(resolve(root, sourcePath)) ? `${sourcePath} is not a directory` : undefined;
		if (!sourcePath) {
			// pick from folders used before and nearby folders an adapter recognises, or type one
			const found = await sourceCandidates(root);
			if (found.length) {
				const pick = await ui.select("Old codebase folder (read-only, never written)", [...found, { value: TYPE_PATH, label: "type a path…" }], found[0]!.value);
				if (pick === undefined) throw cancelled();
				if (pick !== TYPE_PATH) sourcePath = pick;
			}
		}
		while (!sourcePath || problem) {
			sourcePath = await ui.text(problem ? `Old codebase folder (${problem})` : "Old codebase folder (read-only, never written)", sourcePath ?? "../legacy");
			if (sourcePath === undefined) throw cancelled();
			problem = isDir(resolve(root, sourcePath)) ? undefined : `${sourcePath} is not a directory`;
		}
		surveyed = await runSurvey(sourcePath!);
		targetPath ??= await ui.text("New codebase folder", defaultTargetPath(sourcePath!));
		if (targetPath === undefined) throw cancelled();
	}
	if (!stack) {
		// Detection runs in both modes: `--yes` without `--stack` is fine when the repo is unambiguous.
		const guesses = await Promise.all(knownSources().map(async (id) => ({ id, ...(await getSourceAdapter(id).detect(resolve(root, sourcePath ?? "."))) })));
		const best = guesses.sort((a, b) => b.confidence - a.confidence)[0];
		const label = (g: typeof best) => (g ? `${g.id}${g.framework ? "/" + g.framework : ""}${g.version ? " " + g.version : ""}` : "");
		if (best && best.confidence >= 0.7) {
			stack = best.id;
			ui.log(`source stack: ${pc.cyan(label(best))} ${pc.dim(`(detected, confidence ${best.confidence})`)}`);
		} else if (!yes) {
			stack = await ui.select(
				best && best.confidence > 0 ? `Source stack (${label(best)} likely, confidence ${best.confidence})` : `Source stack (nothing recognised in ${sourcePath})`,
				knownSources().map((id) => ({ value: id, label: id })),
				best && best.confidence > 0 ? best.id : undefined,
			);
			if (stack === undefined) throw cancelled();
		}
	}

	// ---- provisional stack: survey recommendation + adapter defaults; flags count as decided
	if (sourcePath && isDir(resolve(root, sourcePath))) {
		surveyed ??= await runSurvey(sourcePath);
		targetPath ??= defaultTargetPath(sourcePath);
	}
	const flagged = { targets: !!to?.length, db: !!db };
	to ??= surveyed?.rec.targets.length ? surveyed.rec.targets : undefined;
	db ??= surveyed?.rec.dbStrategy;
	if (!sourcePath || !stack || !targetPath || !to?.length) throw new Error("init needs the old and the new folder (--source, --target), plus --stack when the source stack cannot be detected");
	const targets = await Promise.all(to.map((id) => getTargetAdapter(id)));
	const choices = parseChoiceFlag(flag("--choose"));
	for (const t of targets)
		for (const c of t.stackChoices ?? []) {
			const chosen = choices[t.id]?.[c.key];
			if (chosen && !c.options.some((o) => o.id === chosen)) throw new Error(`--choose ${t.id}.${c.key}=${chosen}: options are ${c.options.map((o) => o.id).join(", ")}`);
			if (chosen) recordEarlyDecision(root, `stack:${t.id}.${c.key}`, chosen, "init flag");
			else (choices[t.id] ??= {})[c.key] = c.default;
		}
	if (surveyed) saveSurvey(root, surveyed.rec);
	// --to answers the server/ui dimensions (no ui stack given = no separate ui codebase)
	if (flagged.targets) for (const role of ["server", "ui"] as const) recordEarlyDecision(root, `target:${role}`, targets.find((t) => t.role === role)?.id ?? "none", "init flag");
	if (flagged.db) recordEarlyDecision(root, "db-strategy", db!, "init flag");
	const sourceAdapter = getSourceAdapter(stack);
	for (const [id, answer] of Object.entries(parseReplaceFlag(flag("--replace")))) recordEarlyDecision(resolve(root), id, answer, "init flag");

	const absSource = resolve(root, sourcePath);
	const absTarget = resolve(root, targetPath);
	// The workspace holds every migration artifact (ledger, docs, rules, truth, sessions). It must sit
	// outside both repos: nothing migration-related may land in the source or the target tree.
	for (const [name, p] of [["source", absSource], ["target", absTarget]] as const)
		if (root === p || root.startsWith(p + "/")) throw new Error(`run br init from a workspace directory outside the ${name} repo (${p}); migration files never live inside a repo`);
	const detected = await getSourceAdapter(stack).detect(absSource);
	// Pin the legacy repo. It is never written to; later `br inventory` runs report drift against this commit.
	const commit = headOf(absSource);
	const config = ConfigSchema.parse({
		source: { path: sourcePath, stack, framework: detected.framework, version: detected.version, commit },
		target: { path: targetPath, stacks: to, choices },
		db: { strategy: db ?? surveyed?.rec.dbStrategy ?? "keep-schema", from: surveyed?.rec.dbFrom ?? [], to: dbTarget(choices, surveyed?.rec.dbFrom ?? []) },
		models: {},
	});
	const path = saveConfig(root, config);
	rememberSource(absSource);
	ui.log(`wrote ${path}${commit ? pc.dim(`  (source pinned at ${commit.slice(0, 7)})`) : pc.yellow("  (source is not a git repo: no commit pin)")}`);
	if (!opts.embedded) ui.log(renderStackPlan(targets, choices, libraryPlan(sourceAdapter, absSource, loadDecisions(root).libraries).libraries));

	if (!args.includes("--no-docs") && !opts.embedded) {
		ui.log(pc.bold("fetching official docs for every technology…"));
		const entries = await fetchDocs(config, root, { log: (l) => ui.log(l) });
		config.docs.fetchedAt = new Date().toISOString();
		saveConfig(root, config);
		ui.log(pc.dim(`  ${entries.length} docs → .bigrefactor/docs/`));
	}
	const next = `next: ${pc.cyan("br setup")} (bootstrap the target with each stack's official CLI) → ${pc.cyan("br inventory")} → ${pc.cyan("br simulate --level 1")}   (or just ${pc.cyan("br onboard")})`;
	if (opts.embedded) { /* the orchestrator continues */ }
	else if (!yes && terminal) p.outro(next);
	else if (!yes) ui.log(next);
	return path;
}

/**
 * `br setup`: bootstrap the destination with each technology's own generator (nest new, create vite),
 * put it under git, commit. Nothing here is model-generated. With several stacks, each lives in its own
 * sub-project (`api/`, `web/`) inside the target repo.
 */
export async function setup(config: Config, root: string): Promise<void> {
	const target = config.target.path;
	mkdirSync(target, { recursive: true });
	const adapters = await Promise.all(config.target.stacks.map((id) => getTargetAdapter(id)));
	ensureRepo(target, config.target.git.branch, [...new Set(adapters.flatMap((a) => a.toolchain.ignoredPaths))]);
	for (const adapter of adapters) {
		const id = adapter.id;
		const dir = projectDir(config, id);
		console.log(pc.bold(`bootstrapping ${id} → ${dir}`));
		// the project the adapter check already built (generator + packages, probe test removed) is moved, not built again
		if (adapter.seedProject && existsSync(adapter.seedProject) && !adapter.toolchain.isProjectReady(dir)) {
			mkdirSync(dirname(dir), { recursive: true });
			if (existsSync(dir) && !readdirSync(dir).length) rmSync(dir, { recursive: true });
			try {
				renameSync(adapter.seedProject, dir);
			} catch {
				cpSync(adapter.seedProject, dir, { recursive: true }); // another disk: copy instead
				rmSync(adapter.seedProject, { recursive: true, force: true });
			}
			console.log(pc.dim(`  reused the ${id} project built by the adapter check (no second download)`));
		}
		await adapter.scaffoldProject(dir);
		// the stack choices made at init (ORM, validation, router…) bring their packages; the generator alone does not know them
		const packages = resolveChoices(adapter, config.target.choices).flatMap((c) => c.option.packages ?? []);
		if (packages.length && adapter.toolchain.isProjectReady(dir)) {
			const installed = new Set(adapter.toolchain.installedPackages(dir));
			const missing = packages.filter((p) => !installed.has(p));
			if (missing.length) {
				console.log(pc.dim(`  adding chosen packages: ${missing.join(", ")}`));
				const add = adapter.toolchain.addPackages(dir, missing);
				await runCommand(add.cmd, add.args, { cwd: dir });
			}
		}
	}
	// Guarantee, before any unit runs: the project matches every stack choice, and the gate's own build and
	// test commands pass on a probe test written the way agents will write theirs.
	for (const id of config.target.stacks) await checkToolchain(config, await getTargetAdapter(id));
	const sha = commitAll(target, `chore: bootstrap ${config.target.stacks.join(" + ")} with official generators\n\nsource: ${config.source.stack} @ ${config.source.commit ?? "unpinned"}`);
	console.log(sha ? pc.green(`committed ${sha.slice(0, 7)} on ${config.target.git.branch}`) : pc.dim("nothing new to commit"));
	void root;
}

/** Where a stack's project lives inside the target repo. Single stack → the target root itself. */
export function projectDir(config: Config, stackId: string): string {
	return config.target.stacks.length === 1 ? config.target.path : join(config.target.path, subdirOf(stackId));
}

/** Adapter-declared sub-directory; resolved synchronously from the registry's static table so callers stay sync. */
function subdirOf(stackId: string): string {
	return TARGET_SUBDIRS[stackId] ?? stackId;
}

/** "nest + react", "nestjs,react", "NestJS and React" → known target ids (deduped) plus whatever was not recognised. */
export function parseTargets(text: string): { ids: string[]; unknown: string[] } {
	const ids: string[] = [];
	const unknown: string[] = [];
	for (const raw of text.split(/[\s,+&/]+|\band\b/i).map((t) => t.trim().toLowerCase()).filter(Boolean)) {
		const id = targetIdFor(raw);
		if (!id) unknown.push(raw);
		else if (!ids.includes(id)) ids.push(id);
	}
	return { ids, unknown };
}

function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function str(v: unknown): string {
	if (p.isCancel(v)) {
		p.cancel("cancelled");
		process.exit(1);
	}
	return String(v);
}

/** Setup check: choices installed, runner as chosen, gate build + test green on a probe spec. Throws with the fix. */
export async function checkToolchain(config: Config, adapter: TargetAdapter): Promise<void> {
	const dir = projectDir(config, adapter.id);
	if (!adapter.toolchain.isProjectReady(dir)) return;
	const chosen = resolveChoices(adapter, config.target.choices).map((c) => ({ key: c.choice.key, id: c.option.id, packages: c.option.packages }));
	const problems = adapter.verifyChoices?.(dir, chosen) ?? [];
	if (problems.length) throw new Error(`${adapter.id}: the project does not match the stack choices:\n  ${problems.map((p) => `${p.text}${p.fix ? ` (fix: ${p.fix})` : ""}`).join("\n  ")}\nchange the choice with \`br decide\` (or install what is missing) and rerun setup`);
	const probe = adapter.probeTest?.(dir);
	if (!probe) return;
	const probePath = join(dir, probe.path);
	writeFileSync(probePath, probe.content);
	try {
		for (const [step, c] of [["build", adapter.build(dir)], ["test", adapter.test(dir, [probe.path])]] as const) {
			try {
				await runCommand(c.cmd, c.args, { cwd: dir });
			} catch (e: any) {
				throw new Error(`${adapter.id}: the gate's ${step} command fails on a fresh project (${c.cmd} ${c.args.join(" ")}):\n${String(e?.message ?? e).split("\n").slice(-8).join("\n")}`);
			}
		}
		console.log(pc.green(`  ${adapter.id}: toolchain verified (choices installed; gate build + test pass on a probe spec)`));
	} finally {
		rmSync(probePath, { force: true });
	}
}

const TYPE_PATH = "\u0000type";

/** The new code goes next to the old folder: `<old>-new`. */
export function defaultTargetPath(sourcePath: string): string {
	const clean = sourcePath.replace(/\/+$/, "") || ".";
	return join(dirname(clean), `${basename(resolve(clean))}-new`);
}

/** Source folders of earlier setups on this machine (newest first), kept outside any workspace. */
const RECENT = () => join(process.env["BR_HOME"] ?? join(homedir(), ".bigrefactor"), "recent-sources.json");

export function recentSources(): string[] {
	try {
		return (JSON.parse(readFileSync(RECENT(), "utf8")) as string[]).filter((d) => isDir(d));
	} catch {
		return [];
	}
}

function rememberSource(abs: string): void {
	try {
		mkdirSync(dirname(RECENT()), { recursive: true });
		writeFileSync(RECENT(), JSON.stringify([abs, ...recentSources().filter((d) => d !== abs)].slice(0, 10), null, 1));
	} catch {
		/* a convenience only */
	}
}

/**
 * Old-folder choices: folders used before, then folders in the workspace and next to it that a source adapter
 * recognises (best match first). A workspace sits outside both repos, so the old code is usually a sibling.
 */
export async function sourceCandidates(root: string): Promise<PromptOption[]> {
	const rel = (d: string) => (relative(root, d).startsWith("..") ? relative(root, d) : `./${relative(root, d)}`);
	const out: PromptOption[] = recentSources().filter((d) => d !== root).map((d) => ({ value: rel(d), label: rel(d), hint: "used before" }));
	const seen = new Set(out.map((o) => resolve(root, o.value)));
	const dirs: string[] = [];
	for (const base of [root, dirname(root)])
		try {
			for (const e of readdirSync(base, { withFileTypes: true }))
				if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules" && !e.name.endsWith("-new")) dirs.push(join(base, e.name));
		} catch {
			/* unreadable folder */
		}
	const scored: Array<{ dir: string; id: string; c: number }> = [];
	for (const dir of dirs.slice(0, 80)) {
		if (dir === root || seen.has(dir)) continue;
		let best = { id: "", c: 0 };
		for (const id of knownSources()) {
			const c = (await getSourceAdapter(id).detect(dir).catch(() => ({ confidence: 0 }))).confidence;
			if (c > best.c) best = { id, c };
		}
		if (best.c > 0) scored.push({ dir, ...best });
	}
	for (const s of scored.sort((a, b) => b.c - a.c).slice(0, 8)) out.push({ value: rel(s.dir), label: rel(s.dir), hint: `${s.id} (${Math.round(s.c * 100)}%)` });
	return out;
}
