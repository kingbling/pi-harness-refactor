import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import pc from "picocolors";
import { Type } from "typebox";
import { type CommandStep, keepOverrides, linkedDirs, loadCommandOverrides, noteFix, saveCommandOverride, saveWorktreeCopy, withCommandOverrides } from "../adapters/command-overrides.ts";
import type { TargetAdapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import type { Ledger } from "../ledger/db.ts";
import { commitAll, isRepoRoot, whitespaceOnly } from "../git.ts";
import { PLAIN_LANGUAGE } from "../policy.ts";
import { spawnLeaf } from "../sessions/spawn.ts";
import { strayDirs } from "../run/layout-check.ts";
import { projectDir as stackDir, testCannotFail } from "./init.ts";

/**
 * When a setup check fails (gate build/test on a fresh project, stack choices not installed), a model with tools
 * fixes it instead of the owner: it reads the error, runs commands in the new project (install, config) and, when
 * the stack's command itself no longer fits the installed tools (e.g. a flag a new major version removed), sets a
 * workspace override for that command. Code checks again afterwards; the model never decides that it worked.
 */

/** A command that cannot fail proves nothing: the gate would always be green. */
const NO_OP = /^(true|:|echo|exit|printf|sleep|yes)$/;

export function setCommandTool(root: string, stackId: string): ToolDefinition {
	return {
		name: "set_gate_command",
		label: "Set gate command",
		description: `Replace the ${stackId} gate's build, lint or test command for this workspace, when the built-in one does not fit the installed tools. Use "{files}" as one arg where the unit's files go (build/lint: the files to check; test: the test files to run): each unit's gate then checks only its own files. A build or lint command without "{files}" checks the whole project: it is not run per unit but by the builder after merges, now and then. testLenient: the test command with the test runner's own flags (check its --help) so deprecations and notices alone do not fail a run; the flags must reach the runner itself, not a wrapper script that reads every arg as a test file. The gate runs it only after a red test run that mentions deprecations or notices. boot: one command that loads the whole app the way it starts and exits (the framework's own start or container check, from its docs; never a server, watch mode or database), failing when the app cannot start; the builder and the merge check run it on the whole project. It must really build/lint/test/boot: commands that cannot fail are refused.`,
		promptSnippet: "set_gate_command: replace the stack's build/lint/test/boot command for this workspace",
		parameters: Type.Object({ step: Type.Union([Type.Literal("build"), Type.Literal("lint"), Type.Literal("test"), Type.Literal("testLenient"), Type.Literal("boot")]), cmd: Type.String(), args: Type.Array(Type.String()), why: Type.String() }),
		execute: async (_id: string, p: { step: CommandStep; cmd: string; args: string[]; why: string }) => {
			const out = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
			if (NO_OP.test(p.cmd.trim()) || /\|\|\s*(true|exit 0)|--passWithNoTests/.test(p.args.join(" "))) return out("refused: the command must be able to fail");
			saveCommandOverride(root, stackId, p.step, { cmd: p.cmd, args: p.args }, p.why);
			return out(`${p.step} command set to: ${[p.cmd, ...p.args].join(" ")} (the setup check runs again after your session)`);
		},
	} as unknown as ToolDefinition;
}

/** Learned per workspace: a dependency dir every later unit worktree gets as a copy instead of a link. */
export function worktreeCopyTool(root: string, adapter: TargetAdapter): ToolDefinition {
	const dirs = adapter.toolchain.worktreeLinks;
	const copied = loadCommandOverrides(root, adapter.id).worktreeCopy ?? [];
	return {
		name: "set_worktree_copy",
		label: "Copy into worktrees",
		description: `Each migration unit works in its own git worktree; these dependency dirs are linked into it from the main project: ${linkedDirs(adapter, root).join(", ") || "none"}${copied.length ? ` (already a copy: ${copied.join(", ")})` : ""}. When a tool resolves the link to its real path (an autoloader, module resolution) and so loads the main project's code instead of the worktree's, give the dir as a copy (copy-on-write clone) to every later worktree.`,
		promptSnippet: "set_worktree_copy: a linked dependency dir becomes a copy in every later unit worktree",
		parameters: Type.Object({ dir: Type.String(), why: Type.String() }),
		execute: async (_id: string, p: { dir: string; why: string }) => {
			const out = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
			if (!dirs.includes(p.dir)) return out(`refused: ${p.dir} is not a linked dir (${dirs.join(", ") || "none"})`);
			if (!saveWorktreeCopy(root, adapter.id, p.dir, p.why)) return out(`${p.dir} is a copy in every unit worktree already: this changes nothing, the cause is elsewhere`);
			return out(`${p.dir} is copied into every unit worktree from now on`);
		},
	} as unknown as ToolDefinition;
}

/** Returns the model's one-sentence account of what it changed. */
export type SetupFixer = (o: { config: Config; root: string; adapter: TargetAdapter; projectDir: string; problem: string; attempt: number }) => Promise<string | void>;

/** What the setup check runs, for the model: the gate commands and the probe test. */
function checkDoc(adapter: TargetAdapter, projectDir: string): string {
	const b = adapter.build(projectDir);
	const t = adapter.test(projectDir, ["{files}"]);
	const l = adapter.lint(projectDir, ["{files}"]);
	const boot = adapter.boot?.(projectDir);
	const probe = adapter.probeTest?.(projectDir);
	return `The migration tool checks the project with these commands (run in ${projectDir}):
- build: ${[b.cmd, ...b.args].join(" ")}
- lint: ${[l.cmd, ...l.args].join(" ")}
- test: ${[t.cmd, ...t.args].join(" ")}   ({files} = the test files to run)
- boot: ${boot?.cmd ? [boot.cmd, ...boot.args].join(" ") : "none (set_gate_command boot sets one)"}
When a test run where every test passed is still red on deprecations or notices alone, set testLenient (set_gate_command) instead of changing the test command.
${probe ? `The check writes ${probe.path} with this content, runs build, then lint and test with {files} = ${probe.path}:\n${probe.content}\n${probe.failing ? `It also writes this version (wrong expected value) and checks that the test command FAILS on it:\n${probe.failing}\n` : ""}To try it, write that file yourself and delete it afterwards.\n` : ""}When a command is wrong for the installed version (an option removed or renamed, a different runner), replace it with set_gate_command — check the tool's --help first.`;
}

const RULES = "Never make checks pass by skipping or deleting tests, or by commands that cannot fail. Never interactive prompts (use the non-interactive flags), never dev servers or watch modes. The parent folder is a git repo owned by the migration tool: do not init git or commit.";

async function setupSession(o: { config: Config; root: string; adapter: TargetAdapter; projectDir: string; attempt: number }, label: string, task: string, prompt: string): Promise<string> {
	mkdirSync(o.projectDir, { recursive: true });
	const session = await spawnLeaf({
		role: "setup",
		cwd: o.projectDir,
		config: o.config,
		writeGlobs: ["**"],
		// test files may be written to try things: the code's own check writes its probe afresh, so a written test proves
		// nothing; during the run, test files and migrated code are put back after the session (undoMigratedCode)
		protectedGlobs: [".git/**"],
		customTools: [setCommandTool(o.root, o.adapter.id), worktreeCopyTool(o.root, o.adapter)],
		transcriptPath: join(o.root, ".bigrefactor", "sessions", `__setup__.${o.adapter.id}.${label}${o.attempt}.jsonl`),
		systemPrompt: `${task}\n\n${checkDoc(o.adapter, o.projectDir)}\n\n${RULES} Stop when the commands work; end with one sentence saying what you did.\n\n${PLAIN_LANGUAGE}`,
	});
	try {
		const r = await session.run(prompt);
		const said = r.text.trim().split("\n").at(-1) ?? "";
		console.log(pc.dim(`  setup model: ${r.toolCalls} tool calls, $${r.usage.cost.toFixed(4)} — ${said}${r.error ? pc.red(` ERROR: ${r.error}`) : ""}`));
		if (r.error && !r.toolCalls) throw new Error(`the setup model did not start: ${r.error}`);
		return said;
	} finally {
		session.dispose();
	}
}

/** One model session that fixes the setup problem in the new project. */
export const fixSetupWithModel: SetupFixer = async (o) => {
	console.log(pc.cyan(`  ${o.adapter.id}: setup check failed; a model with tools is fixing it (attempt ${o.attempt})`));
	return setupSession(o, "fix", `You set up a ${o.adapter.id} project so a migration tool can build and test code in it. Find the cause of the failure and fix it the way the tool's documentation says: install or configure what is missing, with the project's own package manager. Do not write app code or add source folders (${migratedCodeDirs(o.adapter).join(", ") || "the code folders"} are the migration's units' work; new source files in a new folder are put back unless a config you keep points at them): fix config, dependencies and tool files. When the problem asks for app code (a shared client, helper or module), leave that part: the units write it where the layout says.`, `The setup check failed:\n${o.problem.slice(-4000)}\n\nFix it, then run the failing command yourself to confirm.`);
};

export type ProjectCreator = (o: { config: Config; root: string; adapter: TargetAdapter; projectDir: string; packages: Array<{ choice: string; option: string; packages: string[] }> }) => Promise<string | void>;

/**
 * The new project is created by the setup model with the stack's official tools (the adapter's scaffoldHint says
 * which), with the packages of the owner's stack choices. Nothing is installed by hard-coded commands; code checks
 * the result (ready file, choices, gate commands on a probe).
 */
export const createProjectWithModel: ProjectCreator = async (o) => {
	console.log(pc.cyan(`  ${o.adapter.id}: the setup model creates the project with the official tools`));
	const pk = o.packages.filter((p) => p.packages.length);
	return setupSession({ ...o, attempt: 1 }, "create", `You create a new ${o.adapter.id} project for a migration tool, with the stack's official generator and package manager, at the current versions.${o.adapter.scaffoldHint ? ` How: ${o.adapter.scaffoldHint}` : ""}`, `Create the project in ${o.projectDir} (the folder may already hold a half-finished project from an interrupted run: complete it, do not start over without need).${pk.length ? `\nThen add the packages of the owner's stack choices:\n${pk.map((p) => `- ${p.choice} = ${p.option}: ${p.packages.join(", ")}`).join("\n")}` : ""}\nThen make the check commands work on the fresh project.`);
};

// ---- run time ------------------------------------------------------------------------------------------

const fixing = new Map<string, Promise<string | undefined>>();
const fixes = new Map<string, number>();
/** Fix sessions per problem: a problem the model does not fix in this many tries goes to the owner. */
export const MAX_FIXES_PER_PROBLEM = 2;
/** Fix sessions per stack in one process that changed nothing (a cost guard, not a stop: the run goes on); fixes that worked do not count. */
export const MAX_RUN_FIXES = 20;
/**
 * Setup fixes one unit may be parked on (kept in its meta, so a restart or a requeue does not reset it): a fix that
 * lands but does not help that unit would otherwise park and resubmit it forever. After this many the owner is asked.
 */
export const MAX_SETUP_PARKS = 2;

/**
 * Where the migrated code of a project lives: the feature root (the part of moduleDir before the area) and the
 * shared dirs. A setup fix may touch config, dependencies and tool files, never these: they are the units' work.
 */
function migratedCodeDirs(adapter: TargetAdapter): string[] {
	// (layout.sharedDirs leaves out a shared dir the generator made, such as config/: the framework's, not the units' code)
	const dirs = [...adapter.layout.sharedDirs];
	try {
		const m = adapter.layout.moduleDir("zzarea");
		const i = m.toLowerCase().indexOf("zzarea");
		if (i > 0) dirs.push(m.slice(0, i));
	} catch {
		/* no feature root known: only the shared dirs and test files count */
	}
	return dirs.filter((d) => d && d !== "/" && d !== "./").map((d) => (d.endsWith("/") ? d : `${d}/`));
}

/**
 * After a setup fix on main: put back every test file and every file of migrated code the session changed, as the
 * builder does for tests. Tests are the truth and accepted code is proven by them; a setup fix runs neither.
 * `migrated` (project-relative files the ledger's moves point to) says which existing files hold migrated code: a
 * folder that also holds the stack's own wiring (a config folder) is no reason to put back a feature registration.
 * New source files in the code folders are new app code: put back too, unless a file the fix keeps names them by
 * their path (a tool config loading a bootstrap file): then they are part of the fix, and putting them back would
 * leave main pointing at a missing file. New source files in a folder outside the layout (`src/api/` next to the feature
 * root, see strayDirs) or in a folder the fix made (`config/reports/`) are new app code too: a setup fix makes no
 * source folders. Without the ledger, the folders decide.
 * Returns the paths put back (relative to the repo).
 */
export function undoMigratedCode(repo: string, projectDir: string, adapter: TargetAdapter, migrated?: Set<string>): string[] {
	const proj = relative(repo, projectDir);
	const dirs = migratedCodeDirs(adapter);
	const exts = adapter.layout.sourceExtensions ?? [];
	const stray = strayDirs(projectDir, adapter);
	// folders main already has (repo-relative): a new file outside them sits in a folder the fix made
	let folders: Set<string> | undefined;
	try {
		folders = new Set(execFileSync("git", ["-C", repo, "ls-tree", "-r", "-d", "--name-only", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n").filter(Boolean));
	} catch {
		/* no commit yet: no folder is the fix's own */
	}
	const entries = execFileSync("git", ["-C", repo, "status", "--porcelain", "-z", "-uall"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\0");
	const changes: Array<{ path: string; rel?: string; isNew: boolean; from?: string; undo: "always" | "newCode" | "keep" }> = [];
	const relOf = (p: string) => (!proj ? p : p.startsWith(`${proj}/`) ? p.slice(proj.length + 1) : undefined);
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i]!;
		if (e.length < 4) continue;
		const code = e.slice(0, 2);
		const path = e.slice(3);
		// the old name follows; a rename (`git mv`) is put back by its old path, a copy left the old file alone
		const from = code[0] === "R" ? entries[++i] : code[0] === "C" ? (i++, undefined) : undefined;
		const fromRel = from === undefined ? undefined : relOf(from);
		const rel = relOf(path);
		const isNew = code === "??" || code[0] === "A" || code[0] === "C" || from !== undefined;
		if (rel === undefined) {
			changes.push({ path, isNew, undo: "keep" });
			continue;
		}
		const inCodeDirs = [...dirs, ...stray].some((d) => rel.startsWith(d)) || (isNew && !!folders && path.includes("/") && !folders.has(dirname(path)));
		const newCode = isNew && inCodeDirs && (!exts.length || exts.some((x) => rel.endsWith(x)));
		const guarded = (r: string) => adapter.layout.isTestFile(r) || (migrated ? migrated.has(r) : dirs.some((d) => r.startsWith(d)));
		let undo: "always" | "newCode" | "keep" = guarded(rel) || (fromRel !== undefined && guarded(fromRel)) ? "always" : newCode ? "newCode" : "keep";
		if (undo === "always" && !isNew && whitespaceOnly(repo, path)) undo = "keep"; // a formatter's fix changes no behaviour
		changes.push({ path, rel, isNew, from, undo });
	}
	// what the fix keeps: a new code file one of them names by path belongs to the fix
	const kept = changes.filter((c) => c.undo === "keep").map((c) => {
		try {
			return readFileSync(join(repo, c.path), "utf8");
		} catch {
			return "";
		}
	});
	const undone: string[] = [];
	for (const c of changes) {
		if (c.undo === "keep") continue;
		if (c.undo === "newCode" && kept.some((t) => t.includes(c.rel!) || t.includes(c.path))) continue;
		if (c.isNew) {
			execFileSync("git", ["-C", repo, "rm", "-q", "--cached", "--ignore-unmatch", "--", c.path], { stdio: "pipe" });
			rmSync(join(repo, c.path), { force: true });
			if (c.from) execFileSync("git", ["-C", repo, "checkout", "HEAD", "--", c.from], { stdio: "pipe" });
		} else execFileSync("git", ["-C", repo, "checkout", "HEAD", "--", c.path], { stdio: "pipe" });
		undone.push(c.path);
	}
	return undone;
}

/**
 * The adapter's probe test is the check's own file: a copy the model wrote to try the check (or one an earlier fix
 * committed) is removed, so it never stays in the project as a test.
 */
function removeProbe(adapter: TargetAdapter, projectDir: string): void {
	const probe = adapter.probeTest?.(projectDir);
	if (!probe) return;
	const at = join(projectDir, probe.path);
	let text: string;
	try {
		text = readFileSync(at, "utf8").trim();
	} catch {
		return;
	}
	if ([probe.content, probe.failing].some((c) => c !== undefined && c.trim() === text)) rmSync(at, { force: true });
}

/**
 * A gate failure diagnosed as a setup problem of the new project: the setup model fixes the stack's main project
 * (not the unit's worktree) and the change is committed, so every unit started from now on has it. One fix per
 * stack at a time: units failing meanwhile wait for that fix instead of starting their own. Each different problem
 * (`signature`, the same error in different units) gets its own tries. Changes to test files and migrated code are
 * put back before the commit, and the commit runs under the run's merge lock (`lock`). A fix is logged to the
 * stack's fixes log, which wakes the units parked on a setup problem, and kept in the ledger as a `__setup__`
 * attempt (what changed, what was put back, what the model said). Returns what changed, or undefined when nothing did.
 */
export async function fixRunSetup(o: { config: Config; root: string; adapter: TargetAdapter; projectDir: string; problem: string; signature?: string; fixer?: SetupFixer; ledger?: Ledger; lock?: <T>(fn: () => Promise<T>) => Promise<T>; unitId?: string }): Promise<string | undefined> {
	const key = o.adapter.id;
	const parks = () => (o.unitId && o.ledger ? ((JSON.parse(o.ledger.getUnit(o.unitId)?.meta ?? "{}") as { setupParks?: number }).setupParks ?? 0) : 0);
	if (parks() >= MAX_SETUP_PARKS) return undefined;
	const running = fixing.get(key);
	if (running) return running;
	const problemKey = `${key}|${o.signature ?? o.problem.slice(0, 200)}`;
	if ((fixes.get(problemKey) ?? 0) >= MAX_FIXES_PER_PROBLEM || (fixes.get(key) ?? 0) >= MAX_RUN_FIXES) return undefined;
	fixes.set(problemKey, (fixes.get(problemKey) ?? 0) + 1);
	const wasted = () => fixes.set(key, (fixes.get(key) ?? 0) + 1);
	const p = (async () => {
		// the why text is only a note: a fix that adds to it alone changed nothing
		const settings = () => JSON.stringify({ ...loadCommandOverrides(o.root, key), why: undefined });
		const before = settings();
		const overrides = keepOverrides(o.root, key);
		const attempt = o.ledger?.startAttempt("__setup__", `fix:${key}`, o.config.models.escalate.id);
		const said = await (o.fixer ?? fixSetupWithModel)({ config: o.config, root: o.root, adapter: o.adapter, projectDir: o.projectDir, problem: o.problem, attempt: fixes.get(problemKey)! }).catch((e) => {
			if (attempt !== undefined) o.ledger!.endAttempt(attempt, { outcome: "exception", gateReport: { error: String(e?.message ?? e).slice(0, 2000) } });
			wasted();
			throw e;
		});
		const repo = o.config.target.path;
		const lock = o.lock ?? (<T>(fn: () => Promise<T>) => fn());
		// the target must be its own repo: inside another checkout, undo and commit would act on the parent's files
		if (!isRepoRoot(repo)) {
			if (attempt !== undefined) o.ledger!.endAttempt(attempt, { outcome: "no_change", gateReport: { said, error: `${repo} is not its own git repo: nothing undone or committed` } });
			wasted();
			return undefined;
		}
		const { sha, undone, changed, cannotFail } = await lock(async () => {
			try {
				const migrated = o.ledger ? new Set((o.ledger.db.prepare("SELECT target_symbols FROM moves WHERE op != 'dropped'").all() as Array<{ target_symbols: string }>).flatMap((r) => (JSON.parse(r.target_symbols) as string[]).map((t) => t.split("::")[0]!))) : undefined;
				const undone = undoMigratedCode(repo, o.projectDir, o.adapter, migrated);
				// a fix may change the test command or its config so that nothing can fail any more: the probe test with a
				// wrong expected value must still fail, else the whole fix is put back (it would turn every gate green)
				const cannotFail = await testCannotFail(o.config, withCommandOverrides(o.adapter, o.root)).catch((e) => (console.log(pc.yellow(`  setup fix: could not check that the test command can still fail (${e?.message ?? e})`)), undefined));
				if (cannotFail) {
					overrides.restore(true);
					execFileSync("git", ["-C", repo, "checkout", "HEAD", "--", o.projectDir], { stdio: "pipe" });
					execFileSync("git", ["-C", repo, "clean", "-fdq", "--", o.projectDir], { stdio: "pipe" }); // ignored dirs (installs) stay
					return { sha: undefined, undone, changed: [], cannotFail };
				}
				removeProbe(o.adapter, o.projectDir);
				// another stack's project is never committed by this fix: its changes there are put back unless that
				// stack's own fix is running (whose edits they may be)
				const others = o.config.target.stacks.filter((s) => s !== key).map((s) => ({ s, dir: relative(repo, stackDir(o.config, s)) })).filter((x) => x.dir && !x.dir.startsWith(".."));
				for (const x of others.filter((x) => !fixing.has(x.s))) {
					const there = execFileSync("git", ["-C", repo, "status", "--porcelain", "-uall", "--", x.dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n").filter(Boolean).map((l) => l.slice(3));
					if (!there.length) continue;
					try {
						execFileSync("git", ["-C", repo, "checkout", "HEAD", "--", x.dir], { stdio: "pipe" });
					} catch {
						/* nothing of that project committed yet: only new files to remove */
					}
					execFileSync("git", ["-C", repo, "clean", "-fdq", "--", x.dir], { stdio: "pipe" });
					undone.push(...there);
				}
				const sha = commitAll(repo, `chore(${key}): setup fixed during the run\n\n${said || "setup model"}`, { exclude: others.map((x) => x.dir) });
				const changed = sha ? execFileSync("git", ["-C", repo, "diff-tree", "--no-commit-id", "--name-only", "-r", sha], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n").filter(Boolean) : [];
				// a commit of notes only (.md) fixes nothing a gate runs: it is taken back, the units are not retried for it
				if (changed.length && changed.every((f) => f.endsWith(".md"))) {
					execFileSync("git", ["-C", repo, "reset", "-q", "--keep", "HEAD~1"], { stdio: "pipe" });
					return { sha: undefined, undone: [...undone, ...changed], changed: [], cannotFail: undefined };
				}
				return { sha, undone, changed, cannotFail: undefined };
			} catch (e: any) {
				// a failed put-back or commit (a hook) must not leave the fixer's edits on main for the next commit to sweep up
				try {
					execFileSync("git", ["-C", repo, "reset", "-q", "--hard", "HEAD"], { stdio: "pipe" });
					execFileSync("git", ["-C", repo, "clean", "-fdq"], { stdio: "pipe" });
				} catch {
					/* best effort */
				}
				if (attempt !== undefined) o.ledger!.endAttempt(attempt, { outcome: "exception", gateReport: { said, error: `commit failed, the fix was dropped: ${String(e?.message ?? e).slice(0, 2000)}` } });
				wasted();
				throw e;
			}
		});
		if (cannotFail) {
			console.log(pc.red(`  setup fix put back: ${cannotFail}`));
			if (attempt !== undefined) o.ledger!.endAttempt(attempt, { outcome: "probe_failed", gateReport: { said, error: cannotFail, problem: o.problem.slice(0, 2000) } });
			wasted();
			return undefined;
		}
		if (undone.length) console.log(pc.yellow(`  setup fix: put back ${undone.length} file(s) it changed (tests, migrated code, another stack's project): ${undone.slice(0, 5).join(", ")}${undone.length > 5 ? " …" : ""}`));
		const override = settings() !== before;
		if (attempt !== undefined) o.ledger!.endAttempt(attempt, { outcome: sha || override ? "fixed" : "no_change", gateReport: { said, commit: sha ?? null, changedFiles: changed, undone, override, problem: o.problem.slice(0, 2000) } });
		if (!sha && !override) return (wasted(), undefined);
		const what = said || "the setup was changed";
		noteFix(o.root, key, sha, what);
		if (o.unitId && o.ledger) o.ledger.updateUnit(o.unitId, { meta: { setupParks: parks() + 1 } });
		return what;
	})().finally(() => fixing.delete(key));
	fixing.set(key, p);
	return p;
}
