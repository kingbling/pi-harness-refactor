import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import pc from "picocolors";
import type { TargetAdapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import { addWorktree, deleteBranch, removeWorktree } from "../git.ts";
import { projectDir } from "../init/init.ts";
import { indexTarget } from "../inventory/target.ts";
import type { Ledger } from "../ledger/db.ts";
import { PLAIN_LANGUAGE } from "../policy.ts";
import { isWiringFile } from "../rules/layout-rules.ts";
import { globToRegExp, spawnLeaf } from "../sessions/spawn.ts";
import { errorKeys, FULL_OUTPUT, newErrorLines, runCmd } from "./builder.ts";
import { addedLines, changedFiles, importedByTests, trackedFiles, wholeProjectSteps } from "./gate.ts";
import { checkTree, STRAY, strayDirs } from "./layout-check.ts";
import { exec } from "../proc.ts";

/**
 * The code job: app code a unit needs but may not write (outside its files) — an endpoint its screen calls, a
 * service another module must expose, wiring into an entry file, a shared test fixture. The resolver model asks
 * for it instead of sending the owner "retry or leave parked". A model writes it with tests in a worktree of
 * main; code checks that the changed code builds and the changed tests pass; green is merged into main and the
 * waiting units run again. Red is thrown away and the question goes to the owner with the output.
 */

/** Returns the model's reply; its last paragraph (what it added, how to call it) is the waiting units' hint. */
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
		// told at the write, not after the whole job: the check throws away a job that changed protected config
		isProtected: (rel) => protectedConfig(o.adapter, rel),
		transcriptPath: join(o.root, ".bigrefactor", "sessions", `__code__.${o.label}.jsonl`),
		systemPrompt: `You write one piece of missing app code in a ${o.adapter.id} project under migration, so the units waiting on it can finish. The legacy code is at ${o.config.source.path} (read it for the behaviour to keep).
- Read the project first and follow its layout and conventions (RULES.md, the existing modules); reuse what exists, add nothing the task does not need. A new feature folder gets the files every feature folder has, and their wiring.
- Write tests for what you add. Never change what an existing test checks; never skip or delete tests.
- Build: ${[b.cmd, ...b.args].join(" ")}   Test: ${[t.cmd, ...t.args].join(" ")}   ({files} = the files to check). Run them on what you changed before you stop.
- Write no notes or docs files for other units: the units waiting on this get your final reply as their hint.
Never interactive prompts or servers; do not commit. End with a short paragraph (a few sentences) saying what you added and how callers use it (route, method, fields).\n\nBinding layout:\n${o.adapter.layout.structureDoc}\n\n${PLAIN_LANGUAGE}`,
	});
	try {
		const r = await session.run(`${o.what}\nPaths are relative to ${o.dir}.`);
		return r.text.trim().split("\n").at(-1) ?? "";
	} finally {
		session.dispose();
	}
};

/**
 * Protected config (tsconfig, test and lint config, manifests) holds the checks: changing it could turn them green.
 * Tests are the job's to write; the stack's wiring files (bundle list, route table) are where new code is registered, as a unit may when nothing generates them.
 */
function protectedConfig(adapter: TargetAdapter, f: string): boolean {
	const wiring = adapter.generateRegistration ? [] : adapter.layout.wiringFiles;
	return !adapter.layout.isTestFile(f) && !isWiringFile(f, wiring) && adapter.protectedGlobs.some((g) => globToRegExp(g).test(f));
}

/** Code jobs for one question at a time per stack: two would change main at once. The builder's job has its own turn
 * (a question's job need not wait behind it); the merge lock still puts their merges one after the other. */
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
	linkAll: (wt: string) => void | Promise<void>;
	/** commits the worktree and merges it into main under the merge lock */
	mergeFix: (wt: string, branch: string, what: string) => Promise<string | undefined>;
	log: (l: string) => void;
	worker?: CodeWorker;
	/** the builder's job (main fails its whole-project checks): green means those pass; a fix needs no new test */
	whole?: boolean;
	/** told why the check refused what the job wrote (it returns undefined then) */
	onRefused?: (problem: string) => void;
}): Promise<string | undefined> {
	const key = o.whole ? `${o.adapter.id}:build` : o.adapter.id;
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
	const reset = async () => {
		await removeWorktree(repo, wt);
		try {
			await deleteBranch(repo, branch);
		} catch {
			/* no branch */
		}
	};
	await reset();
	await addWorktree(repo, wt, branch);
	const attempt = o.ledger.startAttempt("__code__", `code:${o.adapter.id}`, o.config.models.escalate.id);
	o.log(pc.cyan(`code job ${o.label} (${o.adapter.id}): ${o.what.split("\n")[0]!.slice(0, 160)}`));
	try {
		await o.linkAll(wt);
		const dir = join(wt, relative(repo, projectDir(o.config, o.adapter.id)));
		const reply = (await (o.worker ?? codeWithModel)({ config: o.config, root: o.root, adapter: o.adapter, dir, what: o.what, label: o.label })) || "";
		// its last paragraph: it carries what the waiting units need (route, fields …), capped so the hint stays short
		const said = (reply.trim().split(/\n\s*\n/).at(-1) ?? "").trim().slice(-1500);
		const changed = await changedFiles(dir, o.adapter.toolchain.ignoredPaths);
		const problem = changed.length ? await check(o.adapter, dir, changed, projectDir(o.config, o.adapter.id), !!o.whole, o.ledger) : "nothing was changed";
		if (problem) {
			o.ledger.endAttempt(attempt, { outcome: "no_change", gateReport: { said, changedFiles: changed, problem: problem.slice(0, 4000), what: o.what.slice(0, 2000) } });
			o.log(pc.yellow(`code job ${o.label}: not merged — ${problem.split("\n")[0]}`));
			if (changed.length) o.onRefused?.(problem);
			return undefined;
		}
		const sha = await o.mergeFix(wt, branch, `feat(${o.adapter.id}): ${(said || o.what).split("\n")[0]!.slice(0, 120)}\n\ncode job ${o.label}`);
		o.ledger.endAttempt(attempt, { outcome: "fixed", gateReport: { said, commit: sha ?? null, changedFiles: changed, what: o.what.slice(0, 2000) } });
		// what it added is found by later units (reuse hints, the copy check)
		await indexTarget(o.ledger, o.adapter, projectDir(o.config, o.adapter.id), changed).catch(() => 0);
		o.log(pc.green(`code job ${o.label}: merged${sha ? ` ${sha.slice(0, 7)}` : ""} — ${said.split("\n")[0]!.slice(0, 160)}`));
		return said || "the missing code was added";
	} catch (e: any) {
		o.ledger.endAttempt(attempt, { outcome: "exception", gateReport: { error: String(e?.message ?? e).slice(0, 2000), what: o.what.slice(0, 2000) } });
		o.log(pc.yellow(`code job ${o.label}: failed (${String(e?.message ?? e).split("\n")[0]})`));
		return undefined;
	} finally {
		await reset();
	}
}

/** Units whose TODO(br:<unit>) mark the changed files lost (a mark moved to another changed file is kept). */
async function removedMarks(dir: string, changed: string[]): Promise<string[]> {
	const mark = /TODO\(br:([^)\s]+)\)/g;
	const removed = new Set<string>();
	const added = new Set<string>();
	const diff = await exec("git", ["diff", "-U0", "HEAD", "--", ...changed], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
	// a file's header lines (--- a/x, +++ b/x) come before its first @@; after it, "--- TODO" is a removed "-- TODO" comment
	let header = false;
	for (const l of diff.split("\n")) {
		if (l.startsWith("diff --git ")) header = true;
		else if (l.startsWith("@@")) header = false;
		if (header) continue;
		const into = l.startsWith("-") ? removed : l.startsWith("+") ? added : undefined;
		for (const m of into ? l.matchAll(mark) : []) into!.add(m[1]!);
	}
	// a new file is not in the diff against HEAD
	const tracked = new Set(await trackedFiles(dir));
	for (const f of changed) if (existsSync(join(dir, f)) && !tracked.has(f)) for (const m of readFileSync(join(dir, f), "utf8").matchAll(mark)) added.add(m[1]!);
	return [...removed].filter((u) => !added.has(u));
}

/**
 * Code's check: the changed files follow the layout, the changed code files build, there is a test among the changed files when code changed, and the
 * changed tests pass. Undefined = green. Only what the job changed is checked: the rest of main is not its job, except
 * for the builder's job (`whole`: main fails its whole-project checks). There the whole-project build and lint
 * run, with the tests that import the changed code (the builder runs no tests, accepted units' tests prove their
 * behaviour), and a fix needs no test of its own. It merges when all of that passes, or when it has fewer error lines
 * than main and none main does not have: a job that fixes part of a big red main is not thrown away. Any other job's
 * failing steps run again on main (`mainDir`): it fails only on a step green on main or error lines main does not have.
 */
async function check(adapter: TargetAdapter, dir: string, changed: string[], mainDir: string, whole: boolean, ledger: Ledger): Promise<string | undefined> {
	// a deleted test checks nothing: the job may not make the check green by removing what was red
	const deleted = changed.filter((f) => !existsSync(join(dir, f)) && adapter.layout.isTestFile(f));
	if (deleted.length) return `tests were deleted: ${deleted.slice(0, 5).join(", ")}`;
	// a stub's TODO(br:<unit>) mark tells that unit which files it may edit to replace the stub: it is the unit's to
	// remove, not a question's job (the builder's job may: it only makes main build)
	const marks = whole ? [] : (await removedMarks(dir, changed)).filter((u) => (ledger.getUnit(u)?.state ?? "accepted") !== "accepted");
	if (marks.length) return `stub marks of units not accepted yet were removed: ${marks.slice(0, 5).map((u) => `TODO(br:${u})`).join(", ")}; leave the stubs and their marks to those units`;
	const config = changed.filter((f) => protectedConfig(adapter, f));
	if (config.length) return `protected config was changed: ${config.slice(0, 5).join(", ")}`;
	// the same drift check a unit's gate runs on its files: a note or a misplaced file stays off main. A new file in a
	// folder outside the layout (src/api/ next to the feature root) too: there the gate's "outside the feature folder" says it
	const tracked = new Set(await trackedFiles(dir));
	const stray = await strayDirs(dir, adapter);
	const outside = changed.filter((f) => !tracked.has(f) && existsSync(join(dir, f)) && stray.some((d) => f.startsWith(d)));
	const drift = [...(await checkTree(dir, adapter, changed.filter((f) => existsSync(join(dir, f))))), ...outside.map((f) => `${f}: ${STRAY}; put it in a feature folder or the shared dir`)];
	if (drift.length) return `the layout check failed: ${drift.slice(0, 10).join("\n")}`;
	const present = changed.filter((f) => existsSync(join(dir, f)) && adapter.layout.sourceExtensions.some((e) => f.endsWith(e)));
	// no code and no test: nothing for the check to run, and the job was to write code
	if (!present.length) return `no code was written, only other files: ${changed.slice(0, 5).join(", ")}`;
	// a comment that silences the type check or the linter hides an error instead of fixing it (the gate's rule, in tests too)
	const silence = adapter.layout.suppressMarker;
	const silenced: string[] = [];
	if (silence) for (const f of present) for (const l of await addedLines(dir, f, tracked.has(f))) if (silence.test(l.text)) silenced.push(`${f}:${l.line} (${l.text.trim().slice(0, 80)})`);
	if (silenced.length) return `checks were silenced instead of fixed: ${silenced.slice(0, 5).join(", ")}`;
	const tests = present.filter((f) => adapter.layout.isTestFile(f));
	const code = present.filter((f) => !adapter.layout.isTestFile(f));
	if (code.length && !tests.length && !whole) return `code changed without a test: ${code.slice(0, 5).join(", ")}`;
	// a source file added or moved may keep the app from loading (a folder its config scans), which no changed test
	// shows: the app's boot check runs too (the builder's job runs it with the other whole-project checks)
	const addedOrMoved = changed.some((f) => adapter.layout.sourceExtensions.some((e) => f.endsWith(e)) && (!tracked.has(f) || !existsSync(join(dir, f))));
	const wholeSteps: string[] = whole ? wholeProjectSteps(adapter, dir).map((w) => w.step) : addedOrMoved && adapter.boot?.(dir)?.cmd ? ["boot"] : [];
	// the builder's job: also the tests of accepted units that import the changed code
	const related = whole && code.length ? [...tracked].filter((t) => adapter.layout.isTestFile(t) && adapter.layout.sourceExtensions.some((e) => t.endsWith(e)) && !tests.includes(t) && importedByTests(dir, [t], code.map((f) => `${f}: changed`)).length) : [];
	// each step with the files it checks (none: the whole project), so the same step can run on main
	const steps: Array<{ step: string; files?: string[] }> = [...wholeSteps.map((step) => ({ step })), ...(code.length && !wholeSteps.includes("build") ? [{ step: "build", files: code }] : []), ...(tests.length + related.length ? [{ step: "test", files: [...tests, ...related] }] : [])];
	const cmd = (d: string, s: { step: string; files?: string[] }) => (s.step === "test" ? adapter.test(d, s.files!) : s.step === "boot" ? adapter.boot!(d)! : s.files ? adapter.build(d, s.files) : wholeProjectSteps(adapter, d).find((w) => w.step === s.step)!);
	const out: string[] = [];
	const failing = new Map<string, string>();
	for (const s of steps) {
		const c = cmd(dir, s);
		const err = await runCmd(c.cmd, c.args, dir, FULL_OUTPUT);
		if (err !== undefined) out.push(`$ ${[c.cmd, ...c.args].join(" ")}   (${s.step})\n${err.slice(-8000)}`), failing.set(s.step, err);
	}
	if (!out.length) return undefined;
	// main may fail its checks too: an error main already has is not this job's. The builder's job must fix some of them
	let mine = 0;
	let theirs = 0;
	const added: string[] = [];
	for (const s of steps) {
		const err = failing.get(s.step);
		// another job: only its failing steps are compared
		if (!whole && err === undefined) continue;
		const there = s.files?.filter((f) => existsSync(join(mainDir, f)));
		// its files new on main: a build that ignores its file list (a full tsc) still shows main's errors
		const files = !whole && there?.length === 0 ? s.files : there;
		const c = files?.length === 0 ? undefined : cmd(mainDir, { ...s, files });
		const was = c && (await runCmd(c.cmd, c.args, mainDir, FULL_OUTPUT));
		if (err !== undefined && was === undefined) return out.join("\n\n"); // red here, green on main
		// the builder's job is measured by the type check and the linter: a test run's output (timings, a flaky line)
		// would read as new errors. Tests red on main too are not its job
		if (whole && s.step === "test") continue;
		if (err !== undefined) added.push(...newErrorLines(err, dir, was!, mainDir));
		mine += err === undefined ? 0 : errorKeys(err, dir).length;
		theirs += was === undefined ? 0 : errorKeys(was, mainDir).length;
	}
	if (added.length) return `the ${whole ? "whole-project " : ""}checks fail with ${added.length} error line(s) main does not have:\n${added.join("\n").slice(-6000)}`;
	if (!whole) return undefined;
	return mine < theirs ? undefined : `the whole-project checks fail as much as on main (no error fixed):\n${out.join("\n\n")}`;
}
