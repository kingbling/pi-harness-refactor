import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import pc from "picocolors";
import { keepOverrides } from "../adapters/command-overrides.ts";
import type { TargetAdapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import { addWorktree, mainBranch, removeWorktree, whitespaceOnly, deleteBranch, wsBranch } from "../git.ts";
import { projectDir } from "../init/init.ts";
import { placeUnit } from "./placement.ts";
import type { Ledger } from "../ledger/db.ts";
import type { ModelClient } from "../models/types.ts";
import { PLAIN_LANGUAGE } from "../policy.ts";
import { globToRegExp, spawnLeaf } from "../sessions/spawn.ts";
import { mentionsCase } from "./ported.ts";
import { reopenUnit } from "./recheck.ts";
import { errorSignature, trackedFiles, wholeProjectSteps } from "./gate.ts";
import { exec } from "../proc.ts";
import { rm } from "node:fs/promises";
import { setStep } from "./watchdog.ts";

/**
 * The builder: whole-project checks (a type check of everything, a linter that cannot take files, all tests) do not run in
 * every unit's gate, they grew with the project. One builder runs them on the side, now and then after merges, in
 * its own worktree of main. When they fail (units that each passed on their own, together they do not), the big
 * model fixes the code there, code re-runs the checks, and the fix is merged like a unit. Lanes wait for it only to merge on a red main.
 * What it cannot fix goes to a code job (which may fix test code too; it merges when main gets fewer errors and no new
 * ones); after MAX_BUILD_CODE_JOBS of those in a row that merged nothing the stack is parked quietly (br status shows
 * it), never a "fix or ignore" question to the owner. Errors only in files a code job may not change (those that decide
 * how the checks run) go to the setup model instead. A unit never waits for the repair: on a red main its merge lands
 * only when it adds no error (the merge check), and a green main gives the accepted units whose build the gate
 * deferred their verdict. (Waiting held every lane for hours while repairs that each fixed part of main ran.)
 */

/** The builder's lines are kept here too (the live log scrolls away): checks, error counts, repairs, code jobs and why they were not merged. */
export const builderLogPath = (root: string) => join(root, ".bigrefactor", "builder.log");
const BUILDER_LOG_MAX = 512 * 1024;

/** Appends one builder line with its time; past BUILDER_LOG_MAX only the newer half is kept. Never throws. */
export function keepBuilderLine(root: string, line: string): void {
	try {
		const f = builderLogPath(root);
		appendFileSync(f, `${new Date().toISOString()} ${line.replace(/\x1b\[[0-9;]*m/g, "")}\n`);
		if (statSync(f).size > BUILDER_LOG_MAX) {
			const text = readFileSync(f, "utf8");
			writeFileSync(f, text.slice(text.indexOf("\n", text.length - BUILDER_LOG_MAX / 2) + 1));
		}
	} catch {
		/* a missing folder or full disk: the live log still has it */
	}
}

/** Returns the model's one-sentence account of what it changed. */
export type Repairer = (o: { config: Config; root: string; adapter: TargetAdapter; dir: string; problem: string; attempt: number }) => Promise<string | void>;

const MAX_REPAIRS = 2;
/** Code jobs one build cycle runs in a row on one stack while each makes progress (a backstop, not a budget). */
const MAX_JOBS_PER_CYCLE = 25;

/**
 * What a model is told about a red main: each failing command with the start of its output (a tail would be mostly
 * the test runner's summary), and to run the commands itself for the full output.
 */
export function brief(problem: string, perStep = 1500): string {
	const parts = problem.split(/\n(?=\$ )/).filter((p) => p.trim());
	return `${parts.map((p) => (p.length > perStep ? `${p.slice(0, perStep)}\n… (more: run the command)` : p)).join("\n\n")}\n\nRun these commands yourself and read their full output: what is shown here is only the start.`;
}
/** How often the builder may send one accepted unit back for its own failing tests before it asks instead. */
export const MAX_BUILD_REOPENS = 2;
/** Code jobs without progress a red main gets in a row before the builder stops paying for it (until it is green again or fails with other errors; a restart keeps it). */
export const MAX_BUILD_CODE_JOBS = 3;
/** Ledger meta: why a stack's main stays red with nobody working on it; br status shows it, cleared once it is green. */
export const buildParkedKey = (stackId: string) => `build_parked:${stackId}`;
/**
 * Ledger meta: the code jobs paid on a red main without progress, with the errors main had then. A restart keeps the
 * count; a main whose check fails with other errors (its code changed where it matters) starts a new count.
 */
export const buildJobsKey = (stackId: string) => `build_jobs:${stackId}`;
/** Ledger meta: main fails the stack's whole-project checks (when, first error line); cleared once it is green. Merges wait for the builder's repair while it is set. */
export const buildRedKey = (stackId: string) => `build_red:${stackId}`;

/**
 * Main passed the stack's whole-project checks: accepted units whose build_ok / lint_ok the gate deferred to them
 * get their verdict. Only units accepted before the check started (`before`): a later one was not in the tree checked.
 */
export function judgeDeferred(ledger: Ledger, config: Config, root: string, stackId: string, before: string): string[] {
	const rows = ledger.db
		.prepare("SELECT u.id, u.meta FROM units u WHERE u.state = 'accepted' AND u.updated_at < ? AND EXISTS (SELECT 1 FROM evidence e WHERE e.id IN ((SELECT max(id) FROM evidence WHERE unit_id = u.id AND type = 'build_ok'), (SELECT max(id) FROM evidence WHERE unit_id = u.id AND type = 'lint_ok')) AND json_extract(e.payload, '$.judged') = 0)")
		.all(before) as Array<{ id: string; meta: string }>;
	const out: string[] = [];
	for (const r of rows) {
		if (placeUnit(config, r.meta, root).stackId !== stackId) continue;
		for (const u of ledger.unjudged(r.id)) if (u.type === "build_ok" || u.type === "lint_ok") ledger.addEvidence(r.id, u.type, { by: "builder", note: "main passed the whole-project checks" });
		out.push(r.id);
	}
	return out;
}

/** Files of the project (tracked, relative to `dir`) the error lines of a check name. */
export function errorFiles(output: string, dir: string, tracked: string[]): string[] {
	const known = new Set(tracked);
	const out = new Set<string>();
	for (const { line } of errorKeys(output, dir)) for (const [t] of line.matchAll(/[^\s'"`(),]+/g)) {
		const f = t.replace(/^\.\//, "").replace(/(:\d+)+:?$/, "");
		if (known.has(f)) out.add(f);
	}
	return [...out];
}

/** Accepted units whose ported tests (named by their case id) fail in `problem`: back to planned, code kept. */
export function reopenBroken(ledger: Ledger, problem: string): string[] {
	const cases = ledger.db.prepare("SELECT tc.id, tc.unit_id, u.meta FROM truth_cases tc JOIN units u ON u.id = tc.unit_id WHERE u.state = 'accepted'").all() as Array<{ id: string; unit_id: string; meta: string }>;
	const failing = new Map<string, string[]>();
	for (const c of cases) if (problem.includes(c.id) && mentionsCase(problem, c.id)) failing.set(c.unit_id, [...(failing.get(c.unit_id) ?? []), c.id]);
	const out: string[] = [];
	for (const [unitId, ids] of failing) {
		const n = (JSON.parse(ledger.getUnit(unitId)!.meta) as { buildReopens?: number }).buildReopens ?? 0;
		if (n >= MAX_BUILD_REOPENS) continue;
		reopenUnit(ledger, unitId, `This unit was accepted, and its code stays on the branch. After later merges the whole-project tests fail on main, and your tests ${ids.join(", ")} are among them:\n${problem.slice(-2000)}\nFix your code. If the cause is in another unit's code, call report_migrated_bug.`, `builder: tests ${ids.slice(0, 3).join(", ")} fail on main after later merges`);
		ledger.updateUnit(unitId, { meta: { buildReopens: n + 1 } });
		out.push(unitId);
	}
	return out;
}

export const repairWithModel: Repairer = async (o) => {
	const session = await spawnLeaf({
		role: "setup", // bash + the big model
		cwd: o.dir,
		config: o.config,
		writeGlobs: ["**"],
		protectedGlobs: [".git/**", ...o.adapter.protectedGlobs],
		transcriptPath: join(o.root, ".bigrefactor", "sessions", `__builder__.${o.adapter.id}.${Date.now()}.${o.attempt}.jsonl`),
		systemPrompt: `You are the BUILDER of an automated migration to ${o.adapter.id}. Many units were migrated separately and each passed its own checks; the whole-project checks now fail. Fix the CODE so they pass: imports, types, signatures and calls between modules, missing exports. A failing test is behaviour of an accepted unit that a later change broke: find that change and fix the code, not the test. Keep behaviour. Never edit tests (test changes are thrown away), never weaken the checks (no excluded paths, lower levels, ignore comments, baseline files, config changes that hide errors). Never interactive prompts or servers. Run the failing commands yourself to confirm. End with one sentence saying what you fixed.\n\n${PLAIN_LANGUAGE}`,
	});
	try {
		const r = await session.run(`The whole-project checks fail:\n${brief(o.problem)}\n\nFix the code, then run the commands again.`);
		return r.text.trim().split("\n").at(-1) ?? "";
	} finally {
		session.dispose();
	}
};

/** `max`: the output's tail kept; comparing two outputs line by line needs all of it. `signal` kills the command. */
export function runCmd(cmd: string, args: string[], cwd: string, max = 8000, signal?: AbortSignal): Promise<string | undefined> {
	return new Promise((res) => {
		execFile(cmd, args, { cwd, timeout: 20 * 60_000, maxBuffer: 32 * 1024 * 1024, signal }, (err, stdout, stderr) => res(err ? `${stdout}\n${stderr}`.trim().slice(-max) || String(err.message) : undefined));
	});
}
/** All of a check's output, for comparing it with main's line by line. */
export const FULL_OUTPUT = 4 * 1024 * 1024;

/**
 * The lines of a check's output (run in `dir`) that the other output (run in `otherDir`) does not have: the run dir
 * and line and column numbers are dropped, and a line without a file of its own keeps the file named above it
 * (eslint and PHPStan print the file once over its errors). Counted per line, so a second copy of an error is new too.
 */
export function newErrorLines(output: string, dir: string, other: string, otherDir: string): string[] {
	const seen = new Map<string, number>();
	for (const { key } of errorKeys(other, otherDir)) seen.set(key, (seen.get(key) ?? 0) + 1);
	return errorKeys(output, dir).flatMap(({ key, line }) => {
		const n = seen.get(key) ?? 0;
		seen.set(key, n - 1);
		return n > 0 ? [] : [line];
	});
}

/** The files with one of `exts` that a check's output names, relative to `dir` (where it ran); the echoed command does not count. */
export function filesNamed(output: string, dir: string, exts: string[]): string[] {
	const dirs = [dir, ...(existsSync(dir) ? [realpathSync(dir)] : [])].map((d) => `${d.replace(/\/$/, "")}/`);
	const out = new Set<string>();
	for (const line of output.replace(/\x1b\[[0-9;]*m/g, "").split("\n")) {
		if (line.startsWith("$ ")) continue;
		for (const [t] of line.matchAll(/[^\s'"`():,]+/g)) if (exts.some((e) => t.endsWith(e))) out.add(dirs.reduce((f, d) => (f.startsWith(d) ? f.slice(d.length) : f), t).replace(/^\.\//, ""));
	}
	return [...out];
}

/** The comparable lines of a check's output (see newErrorLines). */
export function errorKeys(output: string, dir: string): Array<{ key: string; line: string }> {
	const dirs = [dir, ...(existsSync(dir) ? [realpathSync(dir)] : [])].map((d) => `${d.replace(/\/$/, "")}/`);
	let file = "";
	const out: Array<{ key: string; line: string }> = [];
	for (const raw of output.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
		const line = dirs.reduce((l, d) => l.split(d).join(""), raw).trim();
		if (!line || line.startsWith("$ ")) continue;
		const header = /^(?:Line\s+)?([^\s:()'"]+\.[A-Za-z0-9]+)$/.exec(line)?.[1];
		if (header) file = header;
		const key = line.replace(/\b\d+\b/g, "N").replace(/\s+/g, " ");
		out.push({ key: header || /[^\s'"`]+\.[A-Za-z0-9]+[:(]/.test(line) ? key : `${file} ${key}`, line });
	}
	return out;
}

export interface Builder {
	/** A unit of this stack was merged into main. */
	afterMerge(stackId: string): void;
	/** The stack's new app did not start on main (parity found it): a main problem, built once per main tree. */
	appDown(stackId: string, error: string): Promise<void>;
	/** At the end of the run: one last build of what was merged since the last one. */
	finish(): Promise<void>;
	/**
	 * At a stop: nothing new starts, a running check is killed (the next run checks main again), a running repair or
	 * code job finishes and is merged as usual. Resolves when the builder is done, so the run ends after it.
	 */
	stop(): Promise<void>;
}

/** Thrown inside the builder when a stop killed its check. */
class BuilderStopped extends Error {}

export function createBuilder(o: {
	config: Config;
	root: string;
	ledger: Ledger;
	adapters: Map<string, TargetAdapter>;
	client?: ModelClient;
	log: (l: string) => void;
	/** Links the dependency dirs into a fresh worktree, like for units. */
	linkAll: (wt: string) => void | Promise<void>;
	/** Commits the worktree's changes and merges them into main (under the merge lock). */
	mergeFix: (wt: string, branch: string, what: string) => Promise<string | undefined>;
	repair?: Repairer | false;
	/** Hands a red main to a code job (writes app and test code on main); returns what it changed, undefined when nothing merged. */
	codeJob?: (stackId: string, what: string) => Promise<string | undefined>;
	/** Hands a red main whose errors are all in files a code job may not change to the setup model; returns what changed. */
	fixSetup?: (stackId: string, problem: string) => Promise<string | undefined>;
	every?: { units: number; minutes: number };
}): Builder {
	const log = (l: string) => (o.log(l), keepBuilderLine(o.root, l));
	const every = o.every ?? { units: o.config.run.buildEveryUnits, minutes: o.config.run.buildEveryMinutes };
	const merged = new Map<string, number>();
	// repairs paid per problem: the same problem is not repaired again on every build cycle
	const tried = new Map<string, number>();
	// code jobs per stack since main was last green or a job made progress, kept in the ledger (a restart keeps the park)
	const jobs = {
		get: (stackId: string, errors: string) => {
			const j = JSON.parse(o.ledger.getMeta(buildJobsKey(stackId)) || "{}") as { n?: number; errors?: string };
			return j.errors === errors ? (j.n ?? 0) : 0;
		},
		set: (stackId: string, errors: string, n: number) => o.ledger.setMeta(buildJobsKey(stackId), JSON.stringify({ n, errors })),
		delete: (stackId: string) => o.ledger.setMeta(buildJobsKey(stackId), ""),
	};
	// how many error lines main had when the stack's last code job started: the next job in the same cycle needs fewer
	const jobFrom = new Map<string, number>();
	// the new app did not start on main, per stack; and the main trees that was already handed over for
	const down = new Map<string, string>();
	const downTrees = new Set<string>();
	const ignored = (sig: string) =>
		// instr() first: json_extract on every build question's context held Pi's thread for ~0.2 s
		(o.ledger.db.prepare("SELECT answer FROM questions WHERE point = 'build' AND status IN ('answered', 'auto') AND instr(context, ?) > 0 AND json_extract(context, '$.sameAs') = ? ORDER BY id DESC LIMIT 1").get(JSON.stringify(sig).slice(1, -1), sig) as { answer: string } | undefined)?.answer === "ignore";
	let last = Date.now();
	let running: Promise<void> | undefined;
	let stopped = false;
	const kill = new AbortController();

	const start = (force: boolean) => {
		if (running || stopped) return;
		const total = [...merged.values()].reduce((a, b) => a + b, 0);
		if (!total || (!force && total < every.units && Date.now() - last < every.minutes * 60_000)) return;
		const stacks = [...merged.keys()];
		merged.clear();
		running = (async () => {
			// a code job that made progress is followed by the next one at once, until main is green or a job makes none
			for (const s of stacks) for (let i = 0; i < MAX_JOBS_PER_CYCLE && !stopped && (await buildStack(s, i > 0).catch((e) => (e instanceof BuilderStopped || log(pc.yellow(`builder ${s}: ${e?.message ?? e}`)), false))); i++);
		})().finally(() => {
			running = undefined;
			last = Date.now();
			// a new app that did not start, reported while this build ran
			if (down.size) start(true);
		});
	};

	/** True when a code job made main better and the stack should be checked again right away. */
	const buildStack = async (stackId: string, again = false): Promise<boolean> => {
		const appDown = down.get(stackId);
		setStep(`builder ${stackId}: whole-project check on main`);
		down.delete(stackId);
		const adapter = o.adapters.get(stackId);
		if (!adapter) return false;
		const wt = join(o.root, ".bigrefactor", "worktrees", `__builder__${stackId}`);
		const branch = wsBranch(o.root, `builder/${stackId}`);
		const reset = async () => {
			await removeWorktree(o.config.target.path, wt);
			try {
				await deleteBranch(o.config.target.path, branch);
			} catch {
				/* no branch */
			}
		};
		await reset();
		// units accepted before this moment are in the tree checked below
		const checkStart = new Date().toISOString();
		await addWorktree(o.config.target.path, wt, branch);
		try {
			await o.linkAll(wt);
			const dir = join(wt, relative(o.config.target.path, projectDir(o.config, stackId)));
			// every accepted unit's tests too: later units, tidy and repairs change accepted code, and a unit's gate
			// only runs the tests of its own area
			// the test files found are named to the runner: a run without files may skip folders its config does not
			// list, and "no tests ran" would pass
			const tests = (await trackedFiles(dir)).filter((f) => adapter.layout.isTestFile(f) && adapter.layout.sourceExtensions.some((e) => f.endsWith(e)));
			const steps: Array<{ step: string; cmd: string; args: string[] }> = [...wholeProjectSteps(adapter, dir), ...(tests.length ? [{ step: "test", ...adapter.test(dir, tests) }] : [])];
			if (!steps.length && !appDown) return false;
			// `killable`: a stop kills it; the check after a repair is part of that repair and runs to its end
			const check = async (killable = false) => {
				const out: string[] = [];
				for (const s of steps) {
					if (killable && stopped) throw new BuilderStopped();
					const err = await runCmd(s.cmd, s.args, dir, undefined, killable ? kill.signal : undefined);
					if (killable && stopped) throw new BuilderStopped();
					if (err !== undefined) out.push(`$ ${[s.cmd, ...s.args].join(" ")}   (${s.step})\n${err}`);
				}
				return out.length ? out.join("\n\n") : undefined;
			};
			log(pc.dim(`builder ${stackId}: whole-project ${steps.map((s) => s.step).join(" + ")} on main`));
			let problem = await check(true);
			// a boot step shows a new app that does not start itself; without one, what parity saw is the problem
			if (appDown && !steps.some((s) => s.step === "boot")) problem = [problem, `$ (the new ${stackId} app, started for the parity check)   (boot)\n${appDown}`].filter(Boolean).join("\n\n");
			const green = () => {
				jobs.delete(stackId);
				o.ledger.setMeta(buildParkedKey(stackId), "");
				o.ledger.setMeta(buildRedKey(stackId), "");
				const judged = judgeDeferred(o.ledger, o.config, o.root, stackId, checkStart);
				if (judged.length) log(pc.dim(`builder ${stackId}: ${judged.length} accepted unit(s) whose whole-project build was not judged yet now have it`));
			};
			if (!problem) return green(), log(pc.green(`builder ${stackId}: whole project ok`)), false;
			// red: merges of this stack land only when they add no error (the merge check), while the repair below runs
			if (!o.ledger.getMeta(buildRedKey(stackId))) o.ledger.setMeta(buildRedKey(stackId), `${new Date().toISOString()} ${(problem.split("\n").find((l) => l.trim() && !l.startsWith("$ ")) ?? "").slice(0, 200)}`);
			const errors = errorKeys(problem, dir).length;
			keepBuilderLine(o.root, `builder ${stackId}: whole-project check fails: ${errors} error line(s); first: ${(problem.split("\n").find((l) => l.trim() && !l.startsWith("$ ")) ?? "").slice(0, 200)}`);
			if (again && errors >= (jobFrom.get(stackId) ?? Infinity)) return log(pc.yellow(`builder ${stackId}: main has no fewer errors after the last code job (${errors}); the next one after the next merges`)), false;
			const sig = errorSignature(`build:${stackId}`, problem);
			// main's errors as a key (numbers left out): the park holds while main fails the same way
			const errorsKey = createHash("sha1").update([...new Set(errorKeys(problem, dir).map((e) => e.key))].sort().join("\n")).digest("hex").slice(0, 16);
			const parked = jobs.get(stackId, errorsKey) >= MAX_BUILD_CODE_JOBS;
			if (!parked && o.ledger.getMeta(buildParkedKey(stackId))) o.ledger.setMeta(buildParkedKey(stackId), "");
			// a problem already with the owner (open, or answered "leave it"), parked, or already repaired in vain: no more paid repairs
			const skip = parked || o.ledger.openQuestionFor("build", sig) !== undefined || ignored(sig) || (tried.get(sig) ?? 0) >= MAX_REPAIRS;
			// with a code job the repair is skipped: it may not touch tests, and errors in test files are most of a red main
			const repair = o.repair === false || skip || o.codeJob ? undefined : (o.repair ?? repairWithModel);
			const protectedRes = adapter.protectedGlobs.map(globToRegExp);
			const isProtected = (rel: string) => protectedRes.some((r) => r.test(rel));
			let said = "";
			for (let i = 1; problem && repair && !stopped && i <= MAX_REPAIRS; i++) {
				tried.set(sig, i);
				log(pc.cyan(`builder ${stackId}: whole-project check fails; the big model fixes it (try ${i})`));
				const overrides = keepOverrides(o.root, stackId);
				said = (await repair({ config: o.config, root: o.root, adapter, dir, problem, attempt: i }).finally(() => overrides.restore() && log(pc.yellow(`builder ${stackId}: the repair changed the gate commands file; put back`)))) || "";
				// tests are the truth and protected config (tsconfig, test and lint config, manifests) holds the checks:
				// a repair never changes them, also not through bash, which the write gate does not see
				const status = (await exec("git", ["-C", wt, "status", "--porcelain", "-uall"])).split("\n").filter(Boolean).map((l) => ({ added: l.startsWith("??"), f: l.slice(3).trim() }));
				const proj = relative(o.config.target.path, projectDir(o.config, stackId));
				const inProj = (f: string) => (proj && f.startsWith(`${proj}/`) ? f.slice(proj.length + 1) : f);
				// a formatter's whitespace fix in a test stays (it cannot change what the test checks)
				const tests: typeof status = [];
				for (const t of status) if (adapter.layout.isTestFile(inProj(t.f)) && (t.added || !(await whitespaceOnly(wt, t.f)))) tests.push(t);
				const configFiles = status.filter(({ f }) => !tests.some((t) => t.f === f) && isProtected(inProj(f)));
				const undo = [...tests, ...configFiles];
				const tracked = undo.filter((u) => !u.added).map((u) => u.f);
				if (tracked.length) await exec("git", ["-C", wt, "checkout", "--", ...tracked]);
				// a new file is not in git, so checkout cannot undo it: it is deleted
				for (const u of undo.filter((u) => u.added)) await rm(join(wt, u.f), { recursive: true, force: true });
				if (configFiles.length) log(pc.yellow(`builder ${stackId}: the repair changed protected config; undone: ${configFiles.map((u) => u.f).slice(0, 5).join(", ")}`));
				problem = await check();
			}
			if (!problem) {
				green();
				const sha = await o.mergeFix(wt, branch, `fix(${stackId}): whole-project check after merges\n\n${said || "builder"}`);
				log(pc.green(`builder ${stackId}: fixed and merged${sha ? ` ${sha.slice(0, 7)}` : ""} — ${said}`));
				return false;
			}
			if (stopped) return false;
			// a failing test names its case id: that accepted unit's behaviour broke on main, so it goes back to work
			// (its code stays) instead of a vague question. Capped per unit: its own gate runs only its area's tests
			const reopened = reopenBroken(o.ledger, problem);
			if (reopened.length) log(pc.yellow(`builder ${stackId}: re-opened ${reopened.join(", ")}, whose tests fail on main`));
			if (reopened.length) return false;
			if (parked) return false;
			const first = problem.split("\n").find((l) => l.trim() && !l.startsWith("$ ")) ?? problem.split("\n")[0]!;
			const park = (why: string) => {
				jobs.set(stackId, errorsKey, MAX_BUILD_CODE_JOBS);
				o.ledger.setMeta(buildParkedKey(stackId), `${new Date().toISOString()} main fails its whole-project checks; ${why}, the builder stops until main fails differently or is green: ${first.slice(0, 200)}`);
				log(pc.yellow(`builder ${stackId}: whole project still fails; parked, no question (br status)`));
				return false;
			};
			// every error is in files a code job may not change (those that decide how the checks run): no code job can fix
			// it, the setup model can
			const { lockedForCodeJobs } = await import("./code-job.ts");
			const named = errorFiles(problem, dir, await trackedFiles(dir));
			if (named.length && named.every((f) => lockedForCodeJobs(adapter, f))) {
				log(pc.cyan(`builder ${stackId}: every error is in files that decide how the checks run (${named.slice(0, 5).join(", ")}); the setup model fixes it`));
				const fixed = o.fixSetup ? await o.fixSetup(stackId, problem).catch((e) => (log(pc.yellow(`builder ${stackId}: setup fix failed: ${e?.message ?? e}`)), undefined)) : undefined;
				if (fixed) return jobs.delete(stackId), log(pc.cyan(`builder ${stackId}: the setup model changed main: ${fixed.split("\n")[0]!.slice(0, 160)}; checked again now`)), true;
				return park("its errors are in files only the setup model may change, and it changed nothing");
			}
			// a code job fixes it on main (it may change test code, the repair may not); the owner is never asked
			// "fix or ignore": after MAX_BUILD_CODE_JOBS jobs in a row main stays red quietly, br status says so
			const n = jobs.get(stackId, errorsKey) + 1;
			jobs.set(stackId, errorsKey, n);
			jobFrom.set(stackId, errors);
			const changedMain = o.codeJob
				? await o.codeJob(stackId, `The whole ${stackId} project fails its checks on main after merges of units that each passed their own checks. Fix the code so these commands pass: types, imports, signatures and calls between modules, also in test files (type errors there), without changing what a test checks. Never weaken the checks (no excluded paths, ignore comments, config changes). Fixing part of the errors is fine: it is merged when main has fewer errors and no new ones, and the next job goes on from there. Run the failing commands again before you stop.\n${brief(problem)}`).catch((e) => (log(pc.yellow(`builder ${stackId}: code job failed: ${e?.message ?? e}`)), undefined))
				: undefined;
			// a merged job made main better (green, or fewer errors and none new): only jobs in a row without progress lead to the park
			if (changedMain) return jobs.delete(stackId), log(pc.cyan(`builder ${stackId}: a code job changed main: ${changedMain.split("\n")[0]!.slice(0, 160)}; checked again now`)), true;
			if (o.codeJob) log(pc.yellow(`builder ${stackId}: code job ${n}/${MAX_BUILD_CODE_JOBS} merged nothing; tried again after the next merges`));
			if (n < MAX_BUILD_CODE_JOBS && o.codeJob) return false;
			return park(o.codeJob ? `${n} code job(s) did not make it green` : "no code job to fix it");
		} finally {
			await reset();
		}
	};

	return {
		afterMerge(stackId) {
			merged.set(stackId, (merged.get(stackId) ?? 0) + 1);
			start(false);
		},
		async appDown(stackId, error) {
			const tree = (await exec("git", ["-C", o.config.target.path, "rev-parse", `${await mainBranch(o.config.target.path, o.config.target.git.branch)}^{tree}`])).trim();
			if (downTrees.has(`${stackId} ${tree}`)) return;
			downTrees.add(`${stackId} ${tree}`);
			down.set(stackId, error);
			merged.set(stackId, (merged.get(stackId) ?? 0) + 1);
			start(true);
		},
		async finish() {
			await running;
			start(true);
			await running;
		},
		async stop() {
			stopped = true;
			kill.abort();
			await running;
		},
	};
}

/**
 * Whether a unit's merge turns its stack's whole-project build or lint red where main passed it, or adds errors to a
 * step main already fails: the output of each step it breaks (only the new error lines for a step red on main), or
 * undefined (merge it). `wt` is the unit's worktree, already rebased onto main. Runs only when the merge changes files
 * of that stack; main is checked only when this fails, and its result is kept per tree, so main is checked again only
 * after merges that did not pass here (code jobs, the builder, tidy).
 * `draft`: the implementer's check before DONE (check_my_code), its code uncommitted in `wt`: always run, nothing kept
 * but main's own result.
 */
export type MergeCheck = (stackId: string, wt: string, draft?: boolean) => Promise<string | undefined>;

export function createMergeCheck(o: { config: Config; adapters: Map<string, TargetAdapter> }): MergeCheck {
	const repo = o.config.target.path;
	const seen = new Map<string, { tree: string; dir: string; failing: Map<string, string> }>();
	const git = async (cwd: string, args: string[]) => (await exec("git", ["-C", cwd, ...args])).trim();
	const failingSteps = async (adapter: TargetAdapter, dir: string) => {
		const failing = new Map<string, string>();
		for (const s of wholeProjectSteps(adapter, dir)) {
			const err = await runCmd(s.cmd, s.args, dir, FULL_OUTPUT);
			if (err !== undefined) failing.set(s.step, err);
		}
		return failing;
	};
	return async (stackId, wt, draft = false) => {
		const adapter = o.adapters.get(stackId);
		if (!adapter) return undefined;
		setStep(`merge check ${stackId}`);
		const rel = relative(repo, projectDir(o.config, stackId));
		const main = await mainBranch(repo, o.config.target.git.branch);
		if (!draft) {
			try {
				await git(wt, ["diff", "--quiet", main, "HEAD", "--", rel || "."]);
				return undefined; // nothing of this stack changes
			} catch {
				/* it changes files of this stack */
			}
		}
		const dir = join(wt, rel);
		const steps = wholeProjectSteps(adapter, dir);
		if (!steps.length) return undefined;
		const failing = await failingSteps(adapter, dir);
		const mainTree = await git(repo, ["rev-parse", `${main}^{tree}`]);
		let before = seen.get(stackId);
		if (failing.size && before?.tree !== mainTree) {
			const mainDir = projectDir(o.config, stackId);
			before = { tree: mainTree, dir: mainDir, failing: await failingSteps(adapter, mainDir) };
			if (draft) seen.set(stackId, before);
		}
		const broke = steps.flatMap((s) => {
			const out = failing.get(s.step);
			if (out === undefined) return [];
			const head = `$ ${[s.cmd, ...s.args].join(" ")}   (whole-project ${s.step})`;
			const was = before?.failing.get(s.step);
			if (was === undefined) return [`${head}\n${out.slice(-8000)}`];
			// main fails this step already: only errors main does not have count
			const added = newErrorLines(out, dir, was, before!.dir);
			return added.length ? [`${head}; main fails it too, these ${added.length} error line(s) are new:\n${added.join("\n").slice(-8000)}`] : [];
		});
		// kept: main as it stays (refused), or as it is once this merges
		if (!draft) seen.set(stackId, broke.length ? before! : { tree: await git(wt, ["rev-parse", "HEAD^{tree}"]), dir, failing });
		return broke.length ? broke.join("\n\n") : undefined;
	};
}
