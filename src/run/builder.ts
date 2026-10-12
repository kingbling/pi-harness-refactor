import { execFile, execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join, relative } from "node:path";
import pc from "picocolors";
import { keepOverrides } from "../adapters/command-overrides.ts";
import type { TargetAdapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import { addWorktree, removeWorktree, whitespaceOnly } from "../git.ts";
import { projectDir } from "../init/init.ts";
import { askViaModel } from "../jev/ask.ts";
import type { Ledger } from "../ledger/db.ts";
import type { ModelClient } from "../models/types.ts";
import { PLAIN_LANGUAGE } from "../policy.ts";
import { globToRegExp, spawnLeaf } from "../sessions/spawn.ts";
import { mentionsCase } from "./ported.ts";
import { reopenUnit } from "./recheck.ts";
import { errorSignature, trackedFiles, wholeProjectSteps } from "./gate.ts";

/**
 * The builder: whole-project checks (a type check of everything, a linter that cannot take files, all tests) do not run in
 * every unit's gate, they grew with the project. One builder runs them on the side, now and then after merges, in
 * its own worktree of main. When they fail (units that each passed on their own, together they do not), the big
 * model fixes the code there, code re-runs the checks, and the fix is merged like a unit. Lanes never wait for it.
 */

/** Returns the model's one-sentence account of what it changed. */
export type Repairer = (o: { config: Config; root: string; adapter: TargetAdapter; dir: string; problem: string; attempt: number }) => Promise<string | void>;

const MAX_REPAIRS = 2;
/** How often the builder may send one accepted unit back for its own failing tests before it asks instead. */
export const MAX_BUILD_REOPENS = 2;

/** Accepted units whose ported tests (named by their case id) fail in `problem`: back to planned, code kept. */
export function reopenBroken(ledger: Ledger, problem: string): string[] {
	const cases = ledger.db.prepare("SELECT tc.id, tc.unit_id, u.meta FROM truth_cases tc JOIN units u ON u.id = tc.unit_id WHERE u.state = 'accepted'").all() as Array<{ id: string; unit_id: string; meta: string }>;
	const failing = new Map<string, string[]>();
	for (const c of cases) if (mentionsCase(problem, c.id)) failing.set(c.unit_id, [...(failing.get(c.unit_id) ?? []), c.id]);
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
		const r = await session.run(`The whole-project checks fail:\n${o.problem.slice(-6000)}\n\nFix the code, then run the commands again.`);
		return r.text.trim().split("\n").at(-1) ?? "";
	} finally {
		session.dispose();
	}
};

export function runCmd(cmd: string, args: string[], cwd: string): Promise<string | undefined> {
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
	// repairs paid per problem: the same problem is not repaired again on every build cycle
	const tried = new Map<string, number>();
	const ignored = (sig: string) =>
		(o.ledger.db.prepare("SELECT answer FROM questions WHERE point = 'build' AND json_extract(context, '$.sameAs') = ? AND status IN ('answered', 'auto') ORDER BY id DESC LIMIT 1").get(sig) as { answer: string } | undefined)?.answer === "ignore";
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
			// every accepted unit's tests too: later units, tidy and repairs change accepted code, and a unit's gate
			// only runs the tests of its own area
			// the test files found are named to the runner: a run without files may skip folders its config does not
			// list, and "no tests ran" would pass
			const tests = trackedFiles(dir).filter((f) => adapter.layout.isTestFile(f) && adapter.layout.sourceExtensions.some((e) => f.endsWith(e)));
			const steps: Array<{ step: string; cmd: string; args: string[] }> = [...wholeProjectSteps(adapter, dir), ...(tests.length ? [{ step: "test", ...adapter.test(dir, tests) }] : [])];
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
			const sig = errorSignature(`build:${stackId}`, problem);
			// a problem already with the owner (open, or answered "leave it"), or already repaired in vain: no more paid repairs
			const skip = o.ledger.openQuestionFor("build", sig) !== undefined || ignored(sig) || (tried.get(sig) ?? 0) >= MAX_REPAIRS;
			const repair = o.repair === false || skip ? undefined : (o.repair ?? repairWithModel);
			const protectedRes = adapter.protectedGlobs.map(globToRegExp);
			const isProtected = (rel: string) => protectedRes.some((r) => r.test(rel));
			let said = "";
			for (let i = 1; problem && repair && i <= MAX_REPAIRS; i++) {
				tried.set(sig, i);
				o.log(pc.cyan(`builder ${stackId}: whole-project check fails; the big model fixes it (try ${i})`));
				const overrides = keepOverrides(o.root, stackId);
				said = (await repair({ config: o.config, root: o.root, adapter, dir, problem, attempt: i }).finally(() => overrides.restore() && o.log(pc.yellow(`builder ${stackId}: the repair changed the gate commands file; put back`)))) || "";
				// tests are the truth and protected config (tsconfig, test and lint config, manifests) holds the checks:
				// a repair never changes them, also not through bash, which the write gate does not see
				const status = execFileSync("git", ["-C", wt, "status", "--porcelain", "-uall"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n").filter(Boolean).map((l) => ({ added: l.startsWith("??"), f: l.slice(3).trim() }));
				const proj = relative(o.config.target.path, projectDir(o.config, stackId));
				const inProj = (f: string) => (proj && f.startsWith(`${proj}/`) ? f.slice(proj.length + 1) : f);
				// a formatter's whitespace fix in a test stays (it cannot change what the test checks)
				const tests = status.filter((t) => adapter.layout.isTestFile(inProj(t.f)) && (t.added || !whitespaceOnly(wt, t.f)));
				const configFiles = status.filter(({ f }) => !tests.some((t) => t.f === f) && isProtected(inProj(f)));
				const undo = [...tests, ...configFiles];
				const tracked = undo.filter((u) => !u.added).map((u) => u.f);
				if (tracked.length) execFileSync("git", ["-C", wt, "checkout", "--", ...tracked], { stdio: "pipe" });
				// a new file is not in git, so checkout cannot undo it: it is deleted
				for (const u of undo.filter((u) => u.added)) rmSync(join(wt, u.f), { recursive: true, force: true });
				if (configFiles.length) o.log(pc.yellow(`builder ${stackId}: the repair changed protected config; undone: ${configFiles.map((u) => u.f).slice(0, 5).join(", ")}`));
				problem = await check();
			}
			if (!problem) {
				const sha = await o.mergeFix(wt, branch, `fix(${stackId}): whole-project check after merges\n\n${said || "builder"}`);
				o.log(pc.green(`builder ${stackId}: fixed and merged${sha ? ` ${sha.slice(0, 7)}` : ""} — ${said}`));
				return;
			}
			// a failing test names its case id: that accepted unit's behaviour broke on main, so it goes back to work
			// (its code stays) instead of a vague question. Capped per unit: its own gate runs only its area's tests
			const reopened = reopenBroken(o.ledger, problem);
			if (reopened.length) o.log(pc.yellow(`builder ${stackId}: re-opened ${reopened.join(", ")}, whose tests fail on main`));
			if (reopened.length) return;
			// one question for this problem, blocking nothing: units keep running
			await askViaModel(
				{ ledger: o.ledger, config: o.config, root: o.root, client: o.client },
				{
					point: "build",
					facts: `The whole ${stackId} project fails its checks after recent merges; the builder model${repair ? ` tried ${MAX_REPAIRS} times and` : ""} could not fix it. Units keep running; the builder tries again after the next merges.\n${problem.slice(-2000)}`,
					options: [{ value: "fixed", facts: "I fixed it on main" }, { value: "ignore", facts: "leave it for now" }],
					blocks: "none",
					askedBy: "builder",
					sameAs: sig,
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
