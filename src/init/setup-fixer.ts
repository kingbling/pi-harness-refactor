import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import pc from "picocolors";
import { Type } from "typebox";
import { saveCommandOverride, saveWorktreeCopy } from "../adapters/command-overrides.ts";
import type { TargetAdapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import type { Ledger } from "../ledger/db.ts";
import { PLAIN_LANGUAGE } from "../policy.ts";
import { spawnLeaf } from "../sessions/spawn.ts";

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
		description: `Replace the ${stackId} gate's build, lint or test command for this workspace, when the built-in one does not fit the installed tools. Use "{files}" as one arg where the unit's files go (build/lint: the files to check; test: the test files to run): each unit's gate then checks only its own files. A build or lint command without "{files}" checks the whole project: it is not run per unit but by the builder after merges, now and then. It must really build/lint/test: commands that cannot fail are refused.`,
		promptSnippet: "set_gate_command: replace the stack's build/lint/test command for this workspace",
		parameters: Type.Object({ step: Type.Union([Type.Literal("build"), Type.Literal("lint"), Type.Literal("test")]), cmd: Type.String(), args: Type.Array(Type.String()), why: Type.String() }),
		execute: async (_id: string, p: { step: "build" | "lint" | "test"; cmd: string; args: string[]; why: string }) => {
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
	return {
		name: "set_worktree_copy",
		label: "Copy into worktrees",
		description: `Each migration unit works in its own git worktree; these dependency dirs are linked into it from the main project: ${dirs.join(", ") || "none"}. When a tool resolves the link to its real path (an autoloader, module resolution) and so loads the main project's code instead of the worktree's, give the dir as a copy (copy-on-write clone) to every later worktree.`,
		promptSnippet: "set_worktree_copy: a linked dependency dir becomes a copy in every later unit worktree",
		parameters: Type.Object({ dir: Type.String(), why: Type.String() }),
		execute: async (_id: string, p: { dir: string; why: string }) => {
			const out = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
			if (!dirs.includes(p.dir)) return out(`refused: ${p.dir} is not a linked dir (${dirs.join(", ") || "none"})`);
			saveWorktreeCopy(root, adapter.id, p.dir, p.why);
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
	const probe = adapter.probeTest?.(projectDir);
	return `The migration tool checks the project with these commands (run in ${projectDir}):
- build: ${[b.cmd, ...b.args].join(" ")}
- lint: ${[l.cmd, ...l.args].join(" ")}
- test: ${[t.cmd, ...t.args].join(" ")}   ({files} = the test files to run)
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
	return setupSession(o, "fix", `You set up a ${o.adapter.id} project so a migration tool can build and test code in it. Find the cause of the failure and fix it the way the tool's documentation says: install or configure what is missing, with the project's own package manager.`, `The setup check failed:\n${o.problem.slice(-4000)}\n\nFix it, then run the failing command yourself to confirm.`);
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
/** Fix sessions per stack in one process, all problems together (a cost guard, not a stop: the run goes on). */
export const MAX_RUN_FIXES = 20;

/**
 * Where the migrated code of a project lives: the feature root (the part of moduleDir before the area) and the
 * shared dirs. A setup fix may touch config, dependencies and tool files, never these: they are the units' work.
 */
function migratedCodeDirs(adapter: TargetAdapter): string[] {
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
 * Returns the paths put back (relative to the repo).
 */
export function undoMigratedCode(repo: string, projectDir: string, adapter: TargetAdapter): string[] {
	const proj = relative(repo, projectDir);
	const dirs = migratedCodeDirs(adapter);
	const entries = execFileSync("git", ["-C", repo, "status", "--porcelain", "-z", "-uall"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\0");
	const undone: string[] = [];
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i]!;
		if (e.length < 4) continue;
		const code = e.slice(0, 2);
		const path = e.slice(3);
		if (code[0] === "R" || code[0] === "C") i++; // the old name follows
		const rel = !proj ? path : path.startsWith(`${proj}/`) ? path.slice(proj.length + 1) : undefined;
		if (rel === undefined || !(adapter.layout.isTestFile(rel) || dirs.some((d) => rel.startsWith(d)))) continue;
		if (code === "??" || code[0] === "A") {
			execFileSync("git", ["-C", repo, "rm", "-q", "--cached", "--ignore-unmatch", "--", path], { stdio: "pipe" });
			rmSync(join(repo, path), { force: true });
		} else execFileSync("git", ["-C", repo, "checkout", "HEAD", "--", path], { stdio: "pipe" });
		undone.push(path);
	}
	return undone;
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
export async function fixRunSetup(o: { config: Config; root: string; adapter: TargetAdapter; projectDir: string; problem: string; signature?: string; fixer?: SetupFixer; ledger?: Ledger; lock?: <T>(fn: () => Promise<T>) => Promise<T> }): Promise<string | undefined> {
	const key = o.adapter.id;
	const running = fixing.get(key);
	if (running) return running;
	const problemKey = `${key}|${o.signature ?? o.problem.slice(0, 200)}`;
	if ((fixes.get(problemKey) ?? 0) >= MAX_FIXES_PER_PROBLEM || (fixes.get(key) ?? 0) >= MAX_RUN_FIXES) return undefined;
	fixes.set(problemKey, (fixes.get(problemKey) ?? 0) + 1);
	fixes.set(key, (fixes.get(key) ?? 0) + 1);
	const p = (async () => {
		const { commitAll } = await import("../git.ts");
		const { loadCommandOverrides, setupLogPath } = await import("../adapters/command-overrides.ts");
		const before = JSON.stringify(loadCommandOverrides(o.root, key));
		const attempt = o.ledger?.startAttempt("__setup__", `fix:${key}`, o.config.models.escalate.id);
		const said = await (o.fixer ?? fixSetupWithModel)({ config: o.config, root: o.root, adapter: o.adapter, projectDir: o.projectDir, problem: o.problem, attempt: fixes.get(problemKey)! }).catch((e) => {
			if (attempt !== undefined) o.ledger!.endAttempt(attempt, { outcome: "exception", gateReport: { error: String(e?.message ?? e).slice(0, 2000) } });
			throw e;
		});
		const repo = o.config.target.path;
		const lock = o.lock ?? (<T>(fn: () => Promise<T>) => fn());
		const { isRepoRoot } = await import("../git.ts");
		// the target must be its own repo: inside another checkout, undo and commit would act on the parent's files
		if (!isRepoRoot(repo)) {
			if (attempt !== undefined) o.ledger!.endAttempt(attempt, { outcome: "no_change", gateReport: { said, error: `${repo} is not its own git repo: nothing undone or committed` } });
			return undefined;
		}
		const { sha, undone, changed } = await lock(async () => {
			const undone = undoMigratedCode(repo, o.projectDir, o.adapter);
			const sha = commitAll(repo, `chore(${key}): setup fixed during the run\n\n${said || "setup model"}`);
			const changed = sha ? execFileSync("git", ["-C", repo, "diff-tree", "--no-commit-id", "--name-only", "-r", sha], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n").filter(Boolean) : [];
			return { sha, undone, changed };
		});
		if (undone.length) console.log(pc.yellow(`  setup fix: put back ${undone.length} test or migrated-code file(s) it changed: ${undone.slice(0, 5).join(", ")}${undone.length > 5 ? " …" : ""}`));
		const override = JSON.stringify(loadCommandOverrides(o.root, key)) !== before;
		if (attempt !== undefined) o.ledger!.endAttempt(attempt, { outcome: sha || override ? "fixed" : "no_change", gateReport: { said, commit: sha ?? null, changedFiles: changed, undone, override, problem: o.problem.slice(0, 2000) } });
		if (!sha && !override) return undefined;
		const what = said || "the setup was changed";
		mkdirSync(dirname(setupLogPath(o.root, key)), { recursive: true });
		appendFileSync(setupLogPath(o.root, key), `${new Date().toISOString()} ${sha ?? "override"} ${what.replace(/\s+/g, " ")}\n`);
		return what;
	})().finally(() => fixing.delete(key));
	fixing.set(key, p);
	return p;
}
