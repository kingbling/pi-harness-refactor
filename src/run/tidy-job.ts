import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import pc from "picocolors";
import { keepOverrides } from "../adapters/command-overrides.ts";
import type { TargetAdapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import { addWorktree, commitAll, headOf, mainBranch, removeWorktree, deleteBranch } from "../git.ts";
import { projectDir } from "../init/init.ts";
import { indexTarget } from "../inventory/target.ts";
import type { Ledger } from "../ledger/db.ts";
import { PLAIN_LANGUAGE } from "../policy.ts";
import { spawnLeaf } from "../sessions/spawn.ts";
import { FULL_OUTPUT, newErrorLines, runCmd } from "./builder.ts";
import { changedFiles, trackedFiles, wholeProjectSteps } from "./gate.ts";
import { findTests } from "./ported.ts";
import { checkTree } from "./layout-check.ts";
import { endTidyTask, onlyCase, tidyMissing, tidyTasks, type TidyTask } from "./tidy.ts";
import { exec } from "../proc.ts";

/**
 * The tidy job: each approved tidy task runs once, on its own, in a worktree of main. A model does the move and
 * finds every file that uses the moved names (it searches; code does not guess), tests included, and changes
 * only their imports and namespaces; it also deletes shims an earlier attempt left (deprecated copies, aliases).
 * Code then checks: the tree shows the task done, the moved files follow the layout, the build passes, the tests of the changed files pass
 * (an error main already has does not count).
 * Green: merged into main, the task is done. Red: thrown away, the task is failed with the output; units go on.
 * Units never do tidy work: while a task of their area is approved, the scheduler holds them back (`holds`).
 */

/** Returns the model's one-sentence account of what it changed. */
export type TidyWorker = (o: { config: Config; root: string; adapter: TargetAdapter; dir: string; task: TidyTask }) => Promise<string | void>;

export const tidyWithModel: TidyWorker = async (o) => {
	const b = o.adapter.build(o.dir, ["{files}"]);
	const t = o.adapter.test(o.dir, ["{files}"]);
	const session = await spawnLeaf({
		role: "setup", // bash + the big model
		cwd: o.dir,
		config: o.config,
		writeGlobs: ["**"],
		protectedGlobs: [".git/**", ...o.adapter.protectedGlobs],
		transcriptPath: join(o.root, ".bigrefactor", "sessions", `__tidy__.${o.task.id}.jsonl`),
		systemPrompt: `You do one approved tidy change in a ${o.adapter.id} project under migration: move, rename, merge or split files so the code is easier to find, or delete a file that is not code and nothing uses. Keep behaviour identical.
- Do the change itself in the files it names (old and new paths).
- Search the whole project (grep) for every use of the old paths, class names and namespaces, tests included, and update those files. In those files change only imports, namespaces and the moved names; never change what a test checks.
- No compatibility shims: nothing may stay at the old name (no copy, alias, re-export or deprecated class). Delete such shims an earlier attempt left, and point their users at the new name.
- Build: ${[b.cmd, ...b.args].join(" ")}   Test: ${[t.cmd, ...t.args].join(" ")}   ({files} = the files to check). Run them on what you changed before you stop.
Never interactive prompts or servers; do not commit. End with one sentence saying what you changed.\n\n${PLAIN_LANGUAGE}`,
	});
	try {
		const r = await session.run(`Tidy task ${o.task.id}: ${o.task.op} ${o.task.from.join(", ")} → ${o.task.to.join(", ")}\nWhy: ${o.task.why}\nPaths are relative to ${o.dir}.`);
		return r.text.trim().split("\n").at(-1) ?? "";
	} finally {
		session.dispose();
	}
};

export interface TidyJobs {
	/** Units of this area wait: one of its tasks is approved and a tidy job will do it. */
	holds(stackId: string, area: string): boolean;
	/** The same for every area at once ("stack\0area" keys): one read of the tasks, for a scheduler pass over many units. */
	heldAreas(): Set<string>;
	/** Starts the next approved task (one at a time), once no unit of its area runs. */
	next(): void;
	/** The job in progress, if any. */
	readonly busy: Promise<void> | undefined;
}

export function createTidyJobs(o: {
	config: Config;
	root: string;
	ledger: Ledger;
	adapters: Map<string, TargetAdapter>;
	log: (l: string) => void;
	/** Links the dependency dirs into a fresh worktree, like for units. */
	linkAll: (wt: string) => void | Promise<void>;
	/** Commits the worktree's changes and merges them into main (under the merge lock). */
	mergeFix: (wt: string, branch: string, what: string) => Promise<string | undefined>;
	/** A unit of this area is running: its task waits so the two do not conflict. */
	areaBusy: (stackId: string, area: string) => boolean;
	worker?: TidyWorker | false;
}): TidyJobs {
	const worker = o.worker === false ? undefined : (o.worker ?? tidyWithModel);
	const todo = (t: TidyTask) => t.status === "approved" && !onlyCase(t) && o.adapters.has(t.stack);
	let running: Promise<void> | undefined;

	const run = async (t: TidyTask, work: TidyWorker) => {
		const adapter = o.adapters.get(t.stack)!;
		const wt = join(o.root, ".bigrefactor", "worktrees", `__tidy__${t.id}`);
		const branch = `tidy/${t.id}`;
		const reset = async () => {
			await removeWorktree(o.config.target.path, wt);
			try {
				await deleteBranch(o.config.target.path, branch);
			} catch {
				/* no branch */
			}
		};
		o.log(pc.cyan(`tidy ${t.id}: ${t.op} ${t.from.join(", ")} → ${t.to.join(", ")}`));
		// inside the try: a worktree that cannot be made fails the task, it does not stay approved and hold its area
		try {
			await reset();
			const base = await headOf(o.config.target.path);
			await addWorktree(o.config.target.path, wt, branch);
			await o.linkAll(wt);
			const dir = join(wt, relative(o.config.target.path, projectDir(o.config, t.stack)));
			const overrides = keepOverrides(o.root, t.stack); // the gate commands are the setup fixer's, never a tidy job's
			const said = (await work({ config: o.config, root: o.root, adapter, dir, task: t }).finally(() => overrides.restore() && o.log(pc.yellow(`tidy ${t.id}: the job changed the gate commands file; put back`)))) || "";
			const changed = await changedFiles(dir, adapter.toolchain.ignoredPaths);
			const message = `refactor(${t.stack}): tidy ${t.id} ${t.op} ${t.from.join(", ")} → ${t.to.join(", ")}\n\n${said || t.why}`;
			let problem = await check(adapter, dir, t, changed, projectDir(o.config, t.stack));
			// main moved while the job ran: a unit merged since may use the old names, so the check runs again on top of it
			if (!problem && await headOf(o.config.target.path) !== base) {
				await commitAll(wt, message);
				try {
					await exec("git", ["-C", wt, "-c", "user.name=bigrefactor", "-c", "user.email=bigrefactor@localhost", "rebase", "-q", await mainBranch(o.config.target.path, o.config.target.git.branch)]);
				} catch (e: any) {
					// the half-done rebase goes with the worktree below; the task fails with git's reason
					throw new Error(`could not rebase onto main: ${String(e?.stderr ?? e?.message).trim().slice(0, 400)}`);
				}
				problem = await check(adapter, dir, t, changed, projectDir(o.config, t.stack));
			}
			if (problem) {
				endTidyTask(o.ledger, t.id, "failed", problem);
				o.log(pc.yellow(`tidy ${t.id}: failed, nothing changed on main — ${problem.split("\n")[0]}`));
				return;
			}
			const sha = await o.mergeFix(wt, branch, message);
			endTidyTask(o.ledger, t.id, "done");
			// the moved code is found under its new name (reuse hints, the copy check)
			await indexTarget(o.ledger, adapter, projectDir(o.config, t.stack), changed).catch(() => 0);
			o.log(pc.green(`tidy ${t.id}: done and merged${sha ? ` ${sha.slice(0, 7)}` : ""} — ${said}`));
		} catch (e: any) {
			endTidyTask(o.ledger, t.id, "failed", String(e?.message ?? e));
			o.log(pc.yellow(`tidy ${t.id}: failed (${String(e?.message ?? e).split("\n")[0]})`));
		} finally {
			await reset();
		}
	};

	return {
		holds: (stackId, area) => !!worker && tidyTasks(o.ledger, stackId, area).some(todo),
		heldAreas: () => new Set(worker ? tidyTasks(o.ledger).filter(todo).map((t) => `${t.stack}\0${t.area}`) : []),
		next() {
			if (running || !worker) return;
			const t = tidyTasks(o.ledger).find((x) => todo(x) && !o.areaBusy(x.stack, x.area));
			if (!t) return;
			// run() ends the task itself on any error; this catch only keeps a stray one from crashing the process
			running = run(t, worker)
				.catch((e) => o.log(pc.yellow(`tidy ${t.id}: ${e?.message ?? e}`)))
				.finally(() => (running = undefined));
		},
		get busy() {
			return running;
		},
	};
}

/**
 * Code's check of a tidy job: the task is done in the tree, the moved files follow the layout, the build passes (the whole project when the build
 * cannot take files, else the changed code files) and the tests among the changed files pass; when source files were
 * added or moved, also the app's boot check and the area's ported tests. Undefined = green.
 * A failing step runs again on main (`mainDir`), like a code job's: it fails only when green on main or with error lines main does not have.
 */
async function check(adapter: TargetAdapter, dir: string, t: TidyTask, changed: string[], mainDir: string): Promise<string | undefined> {
	const missing = tidyMissing(dir, t);
	if (missing.length) return `the change is not complete: ${missing.join("; ")}`;
	// a delete removes only the files it names
	const gone = t.op === "delete" ? changed.filter((f) => !existsSync(join(dir, f)) && !t.from.includes(f)) : [];
	if (gone.length) return `more was deleted than the task names: ${gone.slice(0, 5).join(", ")}`;
	// the same layout check a unit's gate runs on its files: a move may not put a file where the gate refuses it
	// (only the task's targets: a file touched just for an import keeps its old drift, that is another task's job)
	const moved = changed.filter((f) => existsSync(join(dir, f)) && t.to.some((p) => f === p || f.startsWith(p.replace(/\/*$/, "/"))));
	const drift = moved.length ? await checkTree(dir, adapter, moved) : [];
	if (drift.length) return `the layout check failed: ${drift.slice(0, 10).join("\n")}`;
	const present = changed.filter((f) => existsSync(join(dir, f)) && adapter.layout.sourceExtensions.some((e) => f.endsWith(e)));
	const whole = wholeProjectSteps(adapter, dir).some((s) => s.step === "build");
	const code = present.filter((f) => !adapter.layout.isTestFile(f));
	// source files added or moved: the app may no longer load (a service folder its config scans, a class at an old
	// path), which no test among the changed files shows. The app's boot check and the area's ported tests run too
	const tracked = new Set(await trackedFiles(dir));
	const addedOrMoved = changed.some((f) => adapter.layout.sourceExtensions.some((e) => f.endsWith(e)) && (!tracked.has(f) || !existsSync(join(dir, f))));
	const boot = addedOrMoved && !!adapter.boot?.(dir)?.cmd;
	const tests = [...new Set([...present.filter((f) => adapter.layout.isTestFile(f)), ...(addedOrMoved ? areaTests(adapter, dir, t.area) : [])])];
	// each step with the files it checks (none: the whole project), so the same step can run on main
	const steps: Array<{ step: string; files?: string[] }> = [...(whole ? [{ step: "build" }] : code.length ? [{ step: "build", files: code }] : []), ...(boot ? [{ step: "boot" }] : []), ...(tests.length ? [{ step: "test", files: tests }] : [])];
	const cmd = (d: string, s: { step: string; files?: string[] }) => (s.step === "test" ? adapter.test(d, s.files!) : s.step === "boot" ? adapter.boot!(d)! : s.files ? adapter.build(d, s.files) : wholeProjectSteps(adapter, d).find((w) => w.step === s.step)!);
	const added: string[] = [];
	for (const s of steps) {
		const c = cmd(dir, s);
		const err = await runCmd(c.cmd, c.args, dir, FULL_OUTPUT);
		if (err === undefined) continue;
		// main may be red too (a big project's type check): an error main already has is not this task's.
		// Files new here (the moved ones) keep their names: a build that ignores its file list still shows main's errors
		const there = s.files?.filter((f) => existsSync(join(mainDir, f)));
		const m = cmd(mainDir, { ...s, files: there?.length ? there : s.files });
		const was = await runCmd(m.cmd, m.args, mainDir, FULL_OUTPUT);
		if (was === undefined) return `$ ${[c.cmd, ...c.args].join(" ")}   (${s.step})\n${err.slice(-8000)}`; // red here, green on main
		added.push(...newErrorLines(err, dir, was, mainDir));
	}
	return added.length ? `the checks fail with ${added.length} error line(s) main does not have:\n${added.join("\n").slice(-6000)}` : undefined;
}

/** The ported tests of an area (where its units' tests live in the stack's layout); none when the layout cannot say. */
function areaTests(adapter: TargetAdapter, dir: string, area: string): string[] {
	try {
		return findTests(dir, adapter.layout.moduleDir(area), adapter.layout);
	} catch {
		return [];
	}
}
