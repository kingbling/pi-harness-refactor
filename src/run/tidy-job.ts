import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import pc from "picocolors";
import type { TargetAdapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import { addWorktree, removeWorktree } from "../git.ts";
import { projectDir } from "../init/init.ts";
import { indexTarget } from "../inventory/target.ts";
import type { Ledger } from "../ledger/db.ts";
import { PLAIN_LANGUAGE } from "../policy.ts";
import { spawnLeaf } from "../sessions/spawn.ts";
import { runCmd } from "./builder.ts";
import { changedFiles, wholeProjectSteps } from "./gate.ts";
import { endTidyTask, onlyCase, tidyMissing, tidyTasks, type TidyTask } from "./tidy.ts";

/**
 * The tidy job: each approved tidy task runs once, on its own, in a worktree of main. A model does the move and
 * finds every file that uses the moved names (it searches; code does not guess), tests included, and changes
 * only their imports and namespaces; it also deletes shims an earlier attempt left (deprecated copies, aliases).
 * Code then checks: the tree shows the task done, the build passes, the tests of the changed files pass.
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
		systemPrompt: `You do one approved tidy change in a ${o.adapter.id} project under migration: move, rename, merge or split files so the code is easier to find. Keep behaviour identical.
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
	linkAll: (wt: string) => void;
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
		const reset = () => {
			removeWorktree(o.config.target.path, wt);
			try {
				execFileSync("git", ["-C", o.config.target.path, "branch", "-q", "-D", branch], { stdio: "pipe" });
			} catch {
				/* no branch */
			}
		};
		reset();
		addWorktree(o.config.target.path, wt, branch);
		o.log(pc.cyan(`tidy ${t.id}: ${t.op} ${t.from.join(", ")} → ${t.to.join(", ")}`));
		try {
			o.linkAll(wt);
			const dir = join(wt, relative(o.config.target.path, projectDir(o.config, t.stack)));
			const said = (await work({ config: o.config, root: o.root, adapter, dir, task: t })) || "";
			const changed = changedFiles(dir, adapter.toolchain.ignoredPaths);
			const problem = await check(adapter, dir, t, changed);
			if (problem) {
				endTidyTask(o.ledger, t.id, "failed", problem);
				o.log(pc.yellow(`tidy ${t.id}: failed, nothing changed on main — ${problem.split("\n")[0]}`));
				return;
			}
			const sha = await o.mergeFix(wt, branch, `refactor(${t.stack}): tidy ${t.id} ${t.op} ${t.from.join(", ")} → ${t.to.join(", ")}\n\n${said || t.why}`);
			endTidyTask(o.ledger, t.id, "done");
			// the moved code is found under its new name (reuse hints, the copy check)
			await indexTarget(o.ledger, adapter, projectDir(o.config, t.stack), changed).catch(() => 0);
			o.log(pc.green(`tidy ${t.id}: done and merged${sha ? ` ${sha.slice(0, 7)}` : ""} — ${said}`));
		} catch (e: any) {
			endTidyTask(o.ledger, t.id, "failed", String(e?.message ?? e));
			o.log(pc.yellow(`tidy ${t.id}: failed (${String(e?.message ?? e).split("\n")[0]})`));
		} finally {
			reset();
		}
	};

	return {
		holds: (stackId, area) => !!worker && tidyTasks(o.ledger, stackId, area).some(todo),
		next() {
			if (running || !worker) return;
			const t = tidyTasks(o.ledger).find((x) => todo(x) && !o.areaBusy(x.stack, x.area));
			if (!t) return;
			running = run(t, worker).finally(() => (running = undefined));
		},
		get busy() {
			return running;
		},
	};
}

/**
 * Code's check of a tidy job: the task is done in the tree, the build passes (the whole project when the build
 * cannot take files, else the changed code files) and the tests among the changed files pass. Undefined = green.
 */
async function check(adapter: TargetAdapter, dir: string, t: TidyTask, changed: string[]): Promise<string | undefined> {
	const missing = tidyMissing(dir, t);
	if (missing.length) return `the change is not complete: ${missing.join("; ")}`;
	const present = changed.filter((f) => existsSync(join(dir, f)) && adapter.layout.sourceExtensions.some((e) => f.endsWith(e)));
	const tests = present.filter((f) => adapter.layout.isTestFile(f));
	const whole = wholeProjectSteps(adapter, dir).filter((s) => s.step === "build");
	const code = present.filter((f) => !adapter.layout.isTestFile(f));
	const steps = [...(whole.length ? whole : code.length ? [{ step: "build", ...adapter.build(dir, code) }] : []), ...(tests.length ? [{ step: "test", ...adapter.test(dir, tests) }] : [])];
	const out: string[] = [];
	for (const s of steps) {
		const err = await runCmd(s.cmd, s.args, dir);
		if (err !== undefined) out.push(`$ ${[s.cmd, ...s.args].join(" ")}   (${s.step})\n${err}`);
	}
	return out.length ? out.join("\n\n") : undefined;
}
