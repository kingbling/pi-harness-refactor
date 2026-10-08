import { execFile, execFileSync } from "node:child_process";
import { join, relative } from "node:path";
import pc from "picocolors";
import type { TargetAdapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import { addWorktree, removeWorktree } from "../git.ts";
import { projectDir } from "../init/init.ts";
import { askViaModel } from "../jev/ask.ts";
import type { Ledger } from "../ledger/db.ts";
import type { ModelClient } from "../models/types.ts";
import { PLAIN_LANGUAGE } from "../policy.ts";
import { spawnLeaf } from "../sessions/spawn.ts";
import { errorSignature, wholeProjectSteps } from "./gate.ts";

/**
 * The builder: whole-project checks (a type check of everything, a linter that cannot take files) do not run in
 * every unit's gate, they grew with the project. One builder runs them on the side, now and then after merges, in
 * its own worktree of main. When they fail (units that each passed on their own, together they do not), the big
 * model fixes the code there, code re-runs the checks, and the fix is merged like a unit. Lanes never wait for it.
 */

/** Returns the model's one-sentence account of what it changed. */
export type Repairer = (o: { config: Config; root: string; adapter: TargetAdapter; dir: string; problem: string; attempt: number }) => Promise<string | void>;

const MAX_REPAIRS = 2;

export const repairWithModel: Repairer = async (o) => {
	const session = await spawnLeaf({
		role: "setup", // bash + the big model
		cwd: o.dir,
		config: o.config,
		writeGlobs: ["**"],
		protectedGlobs: [".git/**", ...o.adapter.protectedGlobs],
		transcriptPath: join(o.root, ".bigrefactor", "sessions", `__builder__.${o.adapter.id}.${Date.now()}.${o.attempt}.jsonl`),
		systemPrompt: `You are the BUILDER of an automated migration to ${o.adapter.id}. Many units were migrated separately and each passed its own checks; the whole-project checks now fail. Fix the CODE so they pass: imports, types, signatures and calls between modules, missing exports. Keep behaviour. Never edit tests (test changes are thrown away), never weaken the checks (no excluded paths, lower levels, ignore comments, baseline files, config changes that hide errors). Never interactive prompts or servers. Run the failing commands yourself to confirm. End with one sentence saying what you fixed.\n\n${PLAIN_LANGUAGE}`,
	});
	try {
		const r = await session.run(`The whole-project checks fail:\n${o.problem.slice(-6000)}\n\nFix the code, then run the commands again.`);
		return r.text.trim().split("\n").at(-1) ?? "";
	} finally {
		session.dispose();
	}
};

function runCmd(cmd: string, args: string[], cwd: string): Promise<string | undefined> {
	return new Promise((res) => {
		execFile(cmd, args, { cwd, timeout: 20 * 60_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => res(err ? `${stdout}\n${stderr}`.trim().slice(-8000) || String(err.message) : undefined));
	});
}

export interface Builder {
	/** A unit of this stack was merged into main. */
	afterMerge(stackId: string): void;
	/** At the end of the run: one last build of what was merged since the last one. */
	finish(): Promise<void>;
}

export function createBuilder(o: {
	config: Config;
	root: string;
	ledger: Ledger;
	adapters: Map<string, TargetAdapter>;
	client?: ModelClient;
	log: (l: string) => void;
	/** Links the dependency dirs into a fresh worktree, like for units. */
	linkAll: (wt: string) => void;
	/** Commits the worktree's changes and merges them into main (under the merge lock). */
	mergeFix: (wt: string, branch: string, what: string) => Promise<string | undefined>;
	repair?: Repairer | false;
	every?: { units: number; minutes: number };
}): Builder {
	const every = o.every ?? { units: o.config.run.buildEveryUnits, minutes: o.config.run.buildEveryMinutes };
	const merged = new Map<string, number>();
	let last = Date.now();
	let running: Promise<void> | undefined;

	const start = (force: boolean) => {
		if (running) return;
		const total = [...merged.values()].reduce((a, b) => a + b, 0);
		if (!total || (!force && total < every.units && Date.now() - last < every.minutes * 60_000)) return;
		const stacks = [...merged.keys()];
		merged.clear();
		running = (async () => {
			for (const s of stacks) await buildStack(s).catch((e) => o.log(pc.yellow(`builder ${s}: ${e?.message ?? e}`)));
		})().finally(() => {
			running = undefined;
			last = Date.now();
		});
	};

	const buildStack = async (stackId: string) => {
		const adapter = o.adapters.get(stackId);
		if (!adapter) return;
		const wt = join(o.root, ".bigrefactor", "worktrees", `__builder__${stackId}`);
		const branch = `builder/${stackId}`;
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
		try {
			o.linkAll(wt);
			const dir = join(wt, relative(o.config.target.path, projectDir(o.config, stackId)));
			const steps = wholeProjectSteps(adapter, dir);
			if (!steps.length) return;
			const check = async () => {
				const out: string[] = [];
				for (const s of steps) {
					const err = await runCmd(s.cmd, s.args, dir);
					if (err !== undefined) out.push(`$ ${[s.cmd, ...s.args].join(" ")}   (${s.step})\n${err}`);
				}
				return out.length ? out.join("\n\n") : undefined;
			};
			o.log(pc.dim(`builder ${stackId}: whole-project ${steps.map((s) => s.step).join(" + ")} on main`));
			let problem = await check();
			if (!problem) return o.log(pc.green(`builder ${stackId}: whole project ok`));
			const repair = o.repair === false ? undefined : (o.repair ?? repairWithModel);
			let said = "";
			for (let i = 1; problem && repair && i <= MAX_REPAIRS; i++) {
				o.log(pc.cyan(`builder ${stackId}: whole-project check fails; the big model fixes it (try ${i})`));
				said = (await repair({ config: o.config, root: o.root, adapter, dir, problem, attempt: i })) || "";
				// tests are the truth: a repair never changes them
				const touched = execFileSync("git", ["-C", wt, "status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
				const proj = relative(o.config.target.path, projectDir(o.config, stackId));
				const tests = touched.filter((f) => adapter.layout.isTestFile(proj && f.startsWith(`${proj}/`) ? f.slice(proj.length + 1) : f));
				if (tests.length) execFileSync("git", ["-C", wt, "checkout", "--", ...tests], { stdio: "pipe" });
				problem = await check();
			}
			if (!problem) {
				const sha = await o.mergeFix(wt, branch, `fix(${stackId}): whole-project check after merges\n\n${said || "builder"}`);
				o.log(pc.green(`builder ${stackId}: fixed and merged${sha ? ` ${sha.slice(0, 7)}` : ""} — ${said}`));
				return;
			}
			// one question for this problem, blocking nothing: units keep running
			await askViaModel(
				{ ledger: o.ledger, config: o.config, root: o.root, client: o.client },
				{
					point: "build",
					facts: `The whole ${stackId} project fails its checks after recent merges; the builder model${repair ? ` tried ${MAX_REPAIRS} times and` : ""} could not fix it. Units keep running; the builder tries again after the next merges.\n${problem.slice(-2000)}`,
					options: [{ value: "fixed", facts: "I fixed it on main" }, { value: "ignore", facts: "leave it for now" }],
					blocks: "none",
					askedBy: "builder",
					sameAs: errorSignature(`build:${stackId}`, problem),
				},
			).catch(() => undefined);
			o.log(pc.yellow(`builder ${stackId}: whole project still fails; asked once (blocks nothing)`));
		} finally {
			reset();
		}
	};

	return {
		afterMerge(stackId) {
			merged.set(stackId, (merged.get(stackId) ?? 0) + 1);
			start(false);
		},
		async finish() {
			await running;
			start(true);
			await running;
		},
	};
}
