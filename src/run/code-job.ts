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
import { changedFiles } from "./gate.ts";

/**
 * The code job: app code a unit needs but may not write (outside its files) — an endpoint its screen calls, a
 * service another module must expose, wiring into an entry file, a shared test fixture. The resolver model asks
 * for it instead of sending the owner "retry or leave parked". A model writes it with tests in a worktree of
 * main; code checks that the changed code builds and the changed tests pass; green is merged into main and the
 * waiting units run again. Red is thrown away and the question goes to the owner with the output.
 */

/** Returns the model's one-sentence account of what it wrote. */
export type CodeWorker = (o: { config: Config; root: string; adapter: TargetAdapter; dir: string; what: string; label: string }) => Promise<string | void>;

export const codeWithModel: CodeWorker = async (o) => {
	const b = o.adapter.build(o.dir, ["{files}"]);
	const t = o.adapter.test(o.dir, ["{files}"]);
	const session = await spawnLeaf({
		role: "setup", // bash + the big model
		cwd: o.dir,
		config: o.config,
		writeGlobs: ["**"],
		protectedGlobs: [".git/**"],
		transcriptPath: join(o.root, ".bigrefactor", "sessions", `__code__.${o.label}.jsonl`),
		systemPrompt: `You write one piece of missing app code in a ${o.adapter.id} project under migration, so the units waiting on it can finish. The legacy code is at ${o.config.source.path} (read it for the behaviour to keep).
- Read the project first and follow its layout and conventions (RULES.md, the existing modules); reuse what exists, add nothing the task does not need.
- Write tests for what you add. Never change what an existing test checks; never skip or delete tests.
- Build: ${[b.cmd, ...b.args].join(" ")}   Test: ${[t.cmd, ...t.args].join(" ")}   ({files} = the files to check). Run them on what you changed before you stop.
Never interactive prompts or servers; do not commit. End with one sentence saying what you added.\n\n${PLAIN_LANGUAGE}`,
	});
	try {
		const r = await session.run(`${o.what}\nPaths are relative to ${o.dir}.`);
		return r.text.trim().split("\n").at(-1) ?? "";
	} finally {
		session.dispose();
	}
};

/** Code jobs for one question at a time per stack: two would change main at once. */
const busy = new Map<string, Promise<string | undefined>>();

export async function runCodeJob(o: {
	config: Config;
	root: string;
	ledger: Ledger;
	adapter: TargetAdapter;
	/** what to write, concretely (the resolver's words) */
	what: string;
	/** names the worktree, branch and transcript (e.g. q2109) */
	label: string;
	linkAll: (wt: string) => void;
	/** commits the worktree and merges it into main under the merge lock */
	mergeFix: (wt: string, branch: string, what: string) => Promise<string | undefined>;
	log: (l: string) => void;
	worker?: CodeWorker;
}): Promise<string | undefined> {
	const key = o.adapter.id;
	while (busy.has(key)) await busy.get(key)!.catch(() => undefined);
	const p = run(o);
	busy.set(key, p);
	try {
		return await p;
	} finally {
		busy.delete(key);
	}
}

async function run(o: Parameters<typeof runCodeJob>[0]): Promise<string | undefined> {
	const repo = o.config.target.path;
	const wt = join(o.root, ".bigrefactor", "worktrees", `__code__${o.label}`);
	const branch = `code/${o.label}`;
	const reset = () => {
		removeWorktree(repo, wt);
		try {
			execFileSync("git", ["-C", repo, "branch", "-q", "-D", branch], { stdio: "pipe" });
		} catch {
			/* no branch */
		}
	};
	reset();
	addWorktree(repo, wt, branch);
	const attempt = o.ledger.startAttempt("__code__", `code:${o.adapter.id}`, o.config.models.escalate.id);
	o.log(pc.cyan(`code job ${o.label} (${o.adapter.id}): ${o.what.split("\n")[0]!.slice(0, 160)}`));
	try {
		o.linkAll(wt);
		const dir = join(wt, relative(repo, projectDir(o.config, o.adapter.id)));
		const said = ((await (o.worker ?? codeWithModel)({ config: o.config, root: o.root, adapter: o.adapter, dir, what: o.what, label: o.label })) || "").trim();
		const changed = changedFiles(dir, o.adapter.toolchain.ignoredPaths);
		const problem = changed.length ? await check(o.adapter, dir, changed) : "nothing was changed";
		if (problem) {
			o.ledger.endAttempt(attempt, { outcome: "no_change", gateReport: { said, changedFiles: changed, problem: problem.slice(0, 4000), what: o.what.slice(0, 2000) } });
			o.log(pc.yellow(`code job ${o.label}: not merged — ${problem.split("\n")[0]}`));
			return undefined;
		}
		const sha = await o.mergeFix(wt, branch, `feat(${o.adapter.id}): ${said || o.what.split("\n")[0]!.slice(0, 120)}\n\ncode job ${o.label}`);
		o.ledger.endAttempt(attempt, { outcome: "fixed", gateReport: { said, commit: sha ?? null, changedFiles: changed, what: o.what.slice(0, 2000) } });
		// what it added is found by later units (reuse hints, the copy check)
		await indexTarget(o.ledger, o.adapter, projectDir(o.config, o.adapter.id), changed).catch(() => 0);
		o.log(pc.green(`code job ${o.label}: merged${sha ? ` ${sha.slice(0, 7)}` : ""} — ${said}`));
		return said || "the missing code was added";
	} catch (e: any) {
		o.ledger.endAttempt(attempt, { outcome: "exception", gateReport: { error: String(e?.message ?? e).slice(0, 2000), what: o.what.slice(0, 2000) } });
		o.log(pc.yellow(`code job ${o.label}: failed (${String(e?.message ?? e).split("\n")[0]})`));
		return undefined;
	} finally {
		reset();
	}
}

/**
 * Code's check: the changed code files build, there is a test among the changed files when code changed, and the
 * changed tests pass. Undefined = green. Only what the job changed is checked: the rest of main is not its job.
 */
async function check(adapter: TargetAdapter, dir: string, changed: string[]): Promise<string | undefined> {
	const present = changed.filter((f) => existsSync(join(dir, f)) && adapter.layout.sourceExtensions.some((e) => f.endsWith(e)));
	const tests = present.filter((f) => adapter.layout.isTestFile(f));
	const code = present.filter((f) => !adapter.layout.isTestFile(f));
	if (code.length && !tests.length) return `code changed without a test: ${code.slice(0, 5).join(", ")}`;
	const steps = [...(code.length ? [{ step: "build", ...adapter.build(dir, code) }] : []), ...(tests.length ? [{ step: "test", ...adapter.test(dir, tests) }] : [])];
	const out: string[] = [];
	for (const s of steps) {
		const err = await runCmd(s.cmd, s.args, dir);
		if (err !== undefined) out.push(`$ ${[s.cmd, ...s.args].join(" ")}   (${s.step})\n${err}`);
	}
	return out.length ? out.join("\n\n") : undefined;
}
