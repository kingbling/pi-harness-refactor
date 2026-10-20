import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import pc from "picocolors";
import type { TargetAdapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import { addWorktree, deleteBranch, removeWorktree, wsBranch } from "../git.ts";
import { probeStillFails, projectDir } from "../init/init.ts";
import { indexTarget } from "../inventory/target.ts";
import type { Ledger } from "../ledger/db.ts";
import { PLAIN_LANGUAGE } from "../policy.ts";
import { isWiringFile } from "../rules/layout-rules.ts";
import { globToRegExp, spawnLeaf } from "../sessions/spawn.ts";
import { errorKeys, failingTests, FULL_OUTPUT, newErrorLines, runCmd } from "./builder.ts";
import { onlyComments } from "./comment-only.ts";
import { addedLines, changedFiles, clipOutput, stubOwnerProblem, testsImporting, trackedFiles, wholeProjectSteps } from "./gate.ts";
import { markOwner } from "./stub-sweep.ts";
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
export type CodeWorker = (o: { config: Config; root: string; adapter: TargetAdapter; dir: string; what: string; label: string; onLocked?: (l: { files: string[]; diff: string }) => void }) => Promise<string | void>;

export const codeWithModel: CodeWorker = async (o) => {
	const b = o.adapter.build(o.dir, ["{files}"]);
	const t = o.adapter.test(o.dir, ["{files}"]);
	const session = await spawnLeaf({
		role: "setup", // bash + the big model
		cwd: o.dir,
		config: o.config,
		writeGlobs: ["**"],
		protectedGlobs: [".git/**"],
		// told at the write, not after the whole job: the check puts back what decides how the checks run
		isProtected: (rel) => lockedForCodeJobs(o.adapter, rel),
		// a write through bash is not seen by the write gate: after each command those files are put back and the model told
		afterBash: putBackLocked(o.adapter, o.dir, o.onLocked),
		transcriptPath: join(o.root, ".bigrefactor", "sessions", `__code__.${o.label}.jsonl`),
		systemPrompt: `You write one piece of missing app code in a ${o.adapter.id} project under migration, so the units waiting on it can finish. The legacy code is at ${o.config.source.path} (read it for the behaviour to keep).
- Read the project first and follow its layout and conventions (RULES.md, the existing modules); reuse what exists, add nothing the task does not need. A new feature folder gets the files every feature folder has, and their wiring.
- Write tests for what you add. Never change what an existing test checks, except a test that demands the opposite of another test: the legacy code decides, correct the one that disagrees with it and name the legacy file and line. Never skip or delete tests.
- App config and entry files are yours to change where the code needs it; the files that decide how the checks run (${(o.adapter.checkConfigGlobs ?? o.adapter.protectedGlobs).join(", ")}) are not.
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
 * The files that decide how the checks run (test and lint config, dependency manifests, env files; the adapter's
 * checkConfigGlobs) hold the checks: changing them could turn them green. App config and entry files a code job may
 * change (an older manifest without checkConfigGlobs: none of the protected files). Tests are the job's to write; the
 * stack's wiring files (bundle list, route table) are where new code is registered, as a unit may when nothing generates them.
 */
export function lockedForCodeJobs(adapter: TargetAdapter, f: string): boolean {
	const wiring = adapter.generateRegistration ? [] : adapter.layout.wiringFiles;
	return !adapter.layout.isTestFile(f) && !isWiringFile(f, wiring) && (adapter.checkConfigGlobs ?? adapter.protectedGlobs).some((g) => globToRegExp(g).test(f));
}

/** A protected file a code job may change (app config, an entry file): the check then proves the test command still fails a failing test. */
function appConfig(adapter: TargetAdapter, f: string): boolean {
	return !adapter.layout.isTestFile(f) && !lockedForCodeJobs(adapter, f) && adapter.protectedGlobs.some((g) => globToRegExp(g).test(f));
}

/**
 * Puts back the files a code job changed that decide how the checks run (in `dir`, its project dir): an edited one
 * from git, a new one deleted. Returns them with their diff (what the job wanted there), for the setup model.
 */
export async function undoLocked(adapter: TargetAdapter, dir: string): Promise<{ files: string[]; diff: string }> {
	const files = (await changedFiles(dir, adapter.toolchain.ignoredPaths)).filter((f) => lockedForCodeJobs(adapter, f));
	if (!files.length) return { files, diff: "" };
	const tracked = new Set(await trackedFiles(dir));
	const old = files.filter((f) => tracked.has(f) && existsSync(join(dir, f)));
	const gone = files.filter((f) => tracked.has(f) && !existsSync(join(dir, f)));
	const added = files.filter((f) => !tracked.has(f));
	const diff = [old.length || gone.length ? await exec("git", ["diff", "HEAD", "--", ...old, ...gone], { cwd: dir, maxBuffer: 64 * 1024 * 1024 }) : "", ...added.map((f) => `new file ${f}:\n${readFileSync(join(dir, f), "utf8").slice(0, 4000)}`)].filter(Boolean).join("\n");
	if (old.length || gone.length) await exec("git", ["checkout", "HEAD", "--", ...old, ...gone], { cwd: dir });
	for (const f of added) rmSync(join(dir, f), { recursive: true, force: true });
	return { files, diff };
}

/** After a code job's bash command: the files that decide how the checks run are put back, and the model is told. */
export function putBackLocked(adapter: TargetAdapter, dir: string, onLocked?: (l: { files: string[]; diff: string }) => void): () => Promise<string | undefined> {
	return async () => {
		const l = await undoLocked(adapter, dir);
		if (!l.files.length) return undefined;
		onLocked?.(l);
		return `${l.files.join(", ")} decide${l.files.length === 1 ? "s" : ""} how the checks run: a code job may not change ${l.files.length === 1 ? "it" : "them"}, so the change was put back. If the code needs it, say in your final reply what must change there (the setup model is handed it).`;
	};
}

/** What the job changed, as a diff (new files in full), capped: what the owner sees when a model gives up on it. */
async function jobDiff(dir: string, changed: string[]): Promise<string> {
	const tracked = new Set(await trackedFiles(dir));
	const old = changed.filter((f) => tracked.has(f));
	const diff = old.length ? await exec("git", ["diff", "HEAD", "--", ...old], { cwd: dir, maxBuffer: 64 * 1024 * 1024 }).catch(() => "") : "";
	const added = changed.filter((f) => !tracked.has(f) && existsSync(join(dir, f))).map((f) => `new file ${f}:\n${readFileSync(join(dir, f), "utf8").slice(0, 2000)}`);
	return [diff, ...added].filter(Boolean).join("\n").slice(0, 8000);
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
	/** told why the check refused what the job wrote (it returns undefined then), with the job's diff */
	onRefused?: (problem: string, diff: string) => void;
	/** told what the job wanted to change in the files that decide how the checks run (put back): the setup model's to judge */
	onLocked?: (l: { files: string[]; diff: string }) => void;
	/** told what the job said when it changed nothing (it returns undefined then): why it could not, in its words */
	onNothing?: (said: string) => void;
	/** told why the job broke on the way (a merge conflict, a crash): nothing about the task, it may run again later */
	onFailed?: (why: string) => void;
	/**
	 * The job serves a waiting unit: its worktree starts from main plus that unit's current work (`apply` puts it on
	 * top, false when it does not apply), and the job merges both. The unit's own stub marks are then its to remove.
	 */
	unitWork?: { unitId: string; apply: (wt: string) => Promise<boolean> };
	/** the unit whose question the job serves: the tests it writes count as that unit's own (a reopened unit may change them) */
	forUnit?: string;
	/** the units waiting on that question: the job is for them too, so their stub marks are its to remove */
	waiting?: string[];
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
	const branch = wsBranch(o.root, `code/${o.label}`);
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
	// what the job wanted in the files that decide how the checks run, put back during the session and before the check
	const locked = { files: new Set<string>(), diffs: [] as string[] };
	const onLocked = (l: { files: string[]; diff: string }) => (l.files.forEach((f) => locked.files.add(f)), l.diff && locked.diffs.push(l.diff));
	try {
		// the waiting unit's current work goes under the job's (before the dependency dirs are linked in)
		const withUnit = o.unitWork ? await o.unitWork.apply(wt).catch(() => false) : false;
		if (o.unitWork) o.log(pc.dim(`code job ${o.label}: ${withUnit ? `starts from main plus ${o.unitWork.unitId}'s current work` : `${o.unitWork.unitId}'s work does not apply on main; starts from main`}`));
		await o.linkAll(wt);
		const dir = join(wt, relative(repo, projectDir(o.config, o.adapter.id)));
		const what = withUnit ? `${o.what}\n\nThe worktree already holds the current work of unit ${o.unitWork!.unitId} (uncommitted, on top of main): use it and keep it. It is checked and merged together with your code.` : o.what;
		const reply = (await (o.worker ?? codeWithModel)({ config: o.config, root: o.root, adapter: o.adapter, dir, what, label: o.label, onLocked })) || "";
		// its last paragraph: it carries what the waiting units need (route, fields …), capped so the hint stays short
		const said = (reply.trim().split(/\n\s*\n/).at(-1) ?? "").trim().slice(-1500);
		// only the files that decide how the checks run are put back; the rest is judged as it is
		onLocked(await undoLocked(o.adapter, dir));
		if (locked.files.size) o.log(pc.yellow(`code job ${o.label}: put back what it changed in files that decide how the checks run: ${[...locked.files].slice(0, 5).join(", ")}`));
		if (locked.diffs.length) o.onLocked?.({ files: [...locked.files], diff: locked.diffs.join("\n").slice(0, 8000) });
		const changed = await changedFiles(dir, o.adapter.toolchain.ignoredPaths);
		const problem = changed.length
			? await check(o.adapter, dir, changed, projectDir(o.config, o.adapter.id), !!o.whole, o.ledger, [o.forUnit, o.unitWork?.unitId, ...(o.waiting ?? [])].filter((u): u is string => !!u))
			: locked.files.size ? `only files that decide how the checks run were changed (put back): ${[...locked.files].slice(0, 5).join(", ")}` : "nothing was changed";
		if (problem) {
			o.ledger.endAttempt(attempt, { outcome: "no_change", gateReport: { said, changedFiles: changed, lockedFiles: [...locked.files], problem: problem.slice(0, 4000), what: o.what.slice(0, 2000) } });
			o.log(pc.yellow(`code job ${o.label}: not merged — ${problem.split("\n")[0]}`));
			if (changed.length || locked.files.size) o.onRefused?.(problem, [await jobDiff(dir, changed), ...locked.diffs].filter(Boolean).join("\n").slice(0, 8000));
			else o.onNothing?.(said);
			return undefined;
		}
		const sha = await o.mergeFix(wt, branch, `feat(${o.adapter.id}): ${(said || o.what).split("\n")[0]!.slice(0, 120)}\n\ncode job ${o.label}`);
		o.ledger.endAttempt(attempt, { outcome: "fixed", gateReport: { said, commit: sha ?? null, changedFiles: changed, forUnit: o.forUnit ?? o.unitWork?.unitId, what: o.what.slice(0, 2000) } });
		// what it added is found by later units (reuse hints, the copy check)
		await indexTarget(o.ledger, o.adapter, projectDir(o.config, o.adapter.id), changed).catch(() => 0);
		o.log(pc.green(`code job ${o.label}: merged${sha ? ` ${sha.slice(0, 7)}` : ""} — ${said.split("\n")[0]!.slice(0, 160)}`));
		return said || "the missing code was added";
	} catch (e: any) {
		o.ledger.endAttempt(attempt, { outcome: "exception", gateReport: { error: String(e?.message ?? e).slice(0, 2000), what: o.what.slice(0, 2000) } });
		o.log(pc.yellow(`code job ${o.label}: failed (${String(e?.message ?? e).split("\n")[0]})`));
		o.onFailed?.(String(e?.message ?? e).slice(0, 1000));
		return undefined;
	} finally {
		await reset();
	}
}

/** Owner names whose TODO(br:<owner>) mark the changed files lost, and the ones they gained (a mark moved to another changed file is neither). */
async function markChanges(dir: string, changed: string[]): Promise<{ removed: string[]; added: string[] }> {
	const mark = /TODO\(br:([^)]+)\)/g;
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
		for (const m of into ? l.matchAll(mark) : []) into!.add(m[1]!.trim());
	}
	// a new file is not in the diff against HEAD
	const tracked = new Set(await trackedFiles(dir));
	for (const f of changed) if (existsSync(join(dir, f)) && !tracked.has(f)) for (const m of readFileSync(join(dir, f), "utf8").matchAll(mark)) added.add(m[1]!.trim());
	return { removed: [...removed].filter((u) => !added.has(u)), added: [...added].filter((u) => !removed.has(u)) };
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
async function check(adapter: TargetAdapter, dir: string, changed: string[], mainDir: string, whole: boolean, ledger: Ledger, served: string[] = []): Promise<string | undefined> {
	// a deleted test checks nothing: the job may not make the check green by removing what was red
	const deleted = changed.filter((f) => !existsSync(join(dir, f)) && adapter.layout.isTestFile(f));
	if (deleted.length) return `tests were deleted: ${deleted.slice(0, 5).join(", ")}`;
	// a stub's TODO(br:<unit>) mark tells that unit which files it may edit to replace the stub: it is the unit's to
	// remove, not a question's job (the builder's job may: it only makes main build)
	// (a loose owner name counts as the unit it stands for)
	const changes = whole ? { removed: [], added: [] } : await markChanges(dir, changed);
	const marks = changes.removed.filter((u) => {
		const unit = markOwner(ledger, u) ?? u;
		return !served.includes(unit) && (ledger.getUnit(unit)?.state ?? "accepted") !== "accepted";
	});
	if (marks.length) return `stub marks of units not accepted yet were removed: ${marks.slice(0, 5).map((u) => `TODO(br:${u})`).join(", ")}; leave the stubs and their marks to those units`;
	// a new stub mark must name a unit still to come (the gate's rule): any other is a stub nobody replaces
	const badMarks = changes.added.flatMap((u) => {
		const why = stubOwnerProblem(ledger, "", u);
		return why ? [`TODO(br:${u}) ${why}`] : [];
	});
	if (badMarks.length) return `new stub marks no unit will replace: ${badMarks.slice(0, 5).join("\n")}`;
	// app config the job may change, but no check setting: the test command must still fail a failing test
	const app = changed.filter((f) => appConfig(adapter, f));
	if (app.length) {
		const lost = await probeStillFails(adapter, dir);
		if (lost) return `with the changed app config (${app.slice(0, 5).join(", ")}) the checks no longer work: ${lost}`;
	}
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
	// a file with only comments, or a test that checks a stub mark: the gate's rules, so no unit gets them from a job
	const empty: string[] = [];
	if (!whole) for (const f of present) if (await onlyComments(readFileSync(join(dir, f), "utf8"), f, { lang: adapter.layout.lang?.(f), ledger })) empty.push(f);
	if (empty.length) return `files with only comments, no code: ${empty.slice(0, 5).join(", ")}`;
	const onMark: string[] = [];
	if (!whole) for (const f of tests) for (const l of await addedLines(dir, f, tracked.has(f))) if (l.text.includes("TODO(br:")) onMark.push(`${f}:${l.line}`);
	if (onMark.length) return `tests check a stub mark (TODO(br:...)) instead of the behaviour: ${onMark.slice(0, 5).join(", ")}`;
	if (code.length && !tests.length && !whole) return `code changed without a test: ${code.slice(0, 5).join(", ")}`;
	// a source file added or moved may keep the app from loading (a folder its config scans), which no changed test
	// shows: the app's boot check runs too (the builder's job runs it with the other whole-project checks)
	const addedOrMoved = changed.some((f) => adapter.layout.sourceExtensions.some((e) => f.endsWith(e)) && (!tracked.has(f) || !existsSync(join(dir, f))));
	const wholeSteps: string[] = whole ? wholeProjectSteps(adapter, dir).map((w) => w.step) : addedOrMoved && adapter.boot?.(dir)?.cmd ? ["boot"] : [];
	// the builder's job: also the tests of accepted units that import the changed code
	const related = whole && code.length ? await testsImporting(dir, [...tracked].filter((t) => adapter.layout.isTestFile(t) && adapter.layout.sourceExtensions.some((e) => t.endsWith(e)) && !tests.includes(t)), code) : [];
	// each step with the files it checks (none: the whole project), so the same step can run on main. The builder's
	// build covers test files too (builderSteps): its job is measured on the test files it changed as well
	const built = whole ? present : code;
	const steps: Array<{ step: string; files?: string[] }> = [...wholeSteps.map((step) => ({ step })), ...(built.length && !wholeSteps.includes("build") ? [{ step: "build", files: built }] : []), ...(tests.length + related.length ? [{ step: "test", files: [...tests, ...related] }] : [])];
	const cmd = (d: string, s: { step: string; files?: string[] }) => (s.step === "test" ? adapter.test(d, s.files!) : s.step === "boot" ? adapter.boot!(d)! : s.files ? adapter.build(d, s.files) : wholeProjectSteps(adapter, d).find((w) => w.step === s.step)!);
	const out: string[] = [];
	const failing = new Map<string, string>();
	for (const s of steps) {
		const c = cmd(dir, s);
		const err = await runCmd(c.cmd, c.args, dir, FULL_OUTPUT);
		// its start and its end, with each distinct error message first: a boot error's message is at the start, its
		// stack frames at the end (the tail alone left only frames)
		if (err !== undefined) out.push(`$ ${[c.cmd, ...c.args].join(" ")}   (${s.step})\n${clipOutput(err, 8000)}`), failing.set(s.step, err);
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
		// a test run's output (timings, counts) is not compared line by line: the builder's job is measured on its
		// failing tests. A test that fails here and not on main is one it broke; fewer failing tests is progress
		if (whole && s.step === "test") {
			const now = failingTests(err ?? ""), before = new Set(failingTests(was ?? ""));
			added.push(...now.filter((t) => !before.has(t)).map((t) => `FAIL ${t}`));
			mine += now.length;
			theirs += before.size;
			continue;
		}
		if (err !== undefined) added.push(...newErrorLines(err, dir, was!, mainDir));
		mine += err === undefined ? 0 : errorKeys(err, dir).length;
		theirs += was === undefined ? 0 : errorKeys(was, mainDir).length;
	}
	if (added.length) return `the ${whole ? "whole-project " : ""}checks fail with ${added.length} error line(s) main does not have:\n${clipOutput(added.join("\n"), 6000)}`;
	if (!whole) return undefined;
	return mine < theirs ? undefined : `the whole-project checks fail as much as on main (no error fixed):\n${out.join("\n\n")}`;
}

