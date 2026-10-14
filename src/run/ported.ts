import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { TargetAdapter } from "../adapters/types.ts";
import type { Ledger } from "../ledger/db.ts";
import { globToRegExp } from "../sessions/spawn.ts";
import { changedFiles, dropNoticeLists, runTests, scopedCheck, trackedFiles } from "./gate.ts";
import { exec } from "../proc.ts";

/**
 * The ported-test checks code runs on a unit, shared by the orchestrator (coverTruth, the lint pass before the
 * implementer) and the tester's own check_ported_tests tool, so both see the same answer.
 */

/** A test text names truth case `id` as exact text (u1#3, not u1#30, not u1-3). */
export function mentionsCase(text: string, id: string): boolean {
	return new RegExp(`${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\d)`).test(text);
}

/** The unit's test files: wherever the stack keeps an area's tests (its testFileGlobs), not only inside the module. */
export function findTests(targetProjectDir: string, moduleDir: string, layout: TargetAdapter["layout"]): string[] {
	const globs = layout.testFileGlobs(moduleDir);
	const res = globs.map(globToRegExp);
	const out = new Set<string>();
	const visit = (d: string) => {
		for (const n of readdirSync(d)) {
			const p = join(d, n);
			const r = relative(targetProjectDir, p);
			if (statSync(p).isDirectory()) visit(p);
			else if (layout.isTestFile(r) && res.some((re) => re.test(r))) out.add(r);
		}
	};
	// walk only the fixed part of each glob (src/Billing/tests/**/*Test.php → src/Billing/tests)
	for (const g of globs) {
		const base = g.split("/").filter((_, i, a) => !a.slice(0, i + 1).some((s) => /[*?{[]/.test(s))).join("/");
		if (existsSync(join(targetProjectDir, base))) visit(join(targetProjectDir, base));
	}
	return [...out].sort();
}

/** Case ids no test file names, and the file each found id is in. */
export function caseCoverage(targetProjectDir: string, moduleDir: string, layout: TargetAdapter["layout"], ids: string[]): { missing: string[]; found: Map<string, string>; files: string[]; globs: string[] } {
	const files = findTests(targetProjectDir, moduleDir, layout);
	const texts = files.map((p) => [p, readFileSync(join(targetProjectDir, p), "utf8")] as const);
	const found = new Map<string, string>();
	const missing: string[] = [];
	for (const id of ids) {
		const hit = texts.find(([, t]) => mentionsCase(t, id));
		if (hit) found.set(id, hit[0]);
		else missing.push(id);
	}
	return { missing, found, files, globs: layout.testFileGlobs(moduleDir) };
}

/**
 * The stack's build or lint on the given test files, run from the target project dir and scoped the way the gate
 * scopes it: the error output, or undefined when clean. `skipped` when the command checks the whole project (the
 * builder runs it after merges, so it is never the tester's to fix).
 */
export function checkTests(targetProjectDir: string, adapter: TargetAdapter, name: "build" | "lint", files: string[], timeoutMs = 5 * 60_000): Promise<{ command: string; error?: string; skipped?: string }> {
	const c = scopedCheck(adapter, targetProjectDir, name, files.filter((f) => adapter.layout.lang(f)));
	if ("skip" in c) return Promise.resolve({ command: "", skipped: c.skip });
	const command = [c.cmd, ...c.args].join(" ");
	return new Promise((res) =>
		execFile(c.cmd, c.args, { cwd: targetProjectDir, env: { ...process.env, CI: "1", FORCE_COLOR: "0" }, maxBuffer: 20 * 1024 * 1024, timeout: timeoutMs }, (e, out, err) =>
			res({ command, error: e ? `${String(err)}\n${String(out)}${e.killed ? "\n[timed out]" : ""}`.trim().slice(-2500) || String(e.message) : undefined }),
		),
	);
}

/**
 * The unit's own ported tests among `tests` (the area's): the files its truth cases are linked to, and test files new
 * or changed in its worktree (the tester's). The rest are other units' tests. No own file found (or no git): all of them count.
 */
export async function ownTests(ledger: Ledger, unitId: string, dir: string, tests: string[], ignored: string[] = []): Promise<string[]> {
	const own = await onlyOwnTests(ledger, unitId, dir, tests, ignored);
	return own.length ? own : tests;
}

/** As ownTests, but no own file found is none (what the reviewer judges: other units' tests are not this unit's). Not a git checkout: all of them count. */
export async function onlyOwnTests(ledger: Ledger, unitId: string, dir: string, tests: string[], ignored: string[] = []): Promise<string[]> {
	const linked = (ledger.db.prepare("SELECT DISTINCT ported_test_path p FROM truth_cases WHERE unit_id = ? AND ported_test_path IS NOT NULL").all(unitId) as Array<{ p: string }>).map((r) => r.p);
	let changed: string[];
	try {
		changed = await changedFiles(dir, ignored);
	} catch {
		return tests; // not a git checkout: all of them count
	}
	const mine = new Set([...linked, ...changed]);
	return tests.filter((t) => mine.has(t));
}

/** The note on a green run that excused other units' tests because main fails them too. */
export const FAIL_ON_MAIN_TOO = "fail on main too, not counted against this unit";

/** `mainWaitMs`: how long the run waited for main's answer on the neighbour tests (main's queue and its run there). */
type TestRun = { ok: boolean; output: string; exitCode?: number; mainWaitMs?: number };
type Slot = <T>(fn: () => Promise<T>) => Promise<T>;
/** Neighbour test files that pass on main, per main's tree: main is run again only after it changed. */
const greenOnMain = new Map<string, boolean>();

/** Runs on a main checkout, one at a time across lanes, per checkout: each stack's main has its own caches, so the stacks never wait on each other. */
const mainQueues = new Map<string, Promise<unknown>>();
function onMain<T>(main: string, fn: () => Promise<T>): Promise<T> {
	const r = (mainQueues.get(main) ?? Promise.resolve()).then(fn, fn);
	mainQueues.set(main, r.catch(() => undefined));
	return r;
}

/** What main says about neighbour test files: pass (true) or not, and the commit it ran on. */
type MainAnswer = { green: Map<string, boolean>; head: string; waitedMs: number };
type How = { adapter: TargetAdapter; timeoutMs: number; slot: Slot };
type Ask = How & { files: string[]; at: number; warm: boolean; res: (a: MainAnswer) => void; rej: (e: unknown) => void };
/** Questions to main waiting for its turn, per main dir: one turn answers all of them with one run. */
const asks = new Map<string, Ask[]>();
/** Neighbour files lanes asked main about lately (when, and how to run them), per main dir: run again after a merge. */
const asked = new Map<string, { how: How; files: Map<string, number> }>();
/** How long a file asked about is run again after merges. */
const WARM_FOR_MS = 60 * 60_000;

/**
 * Asks main whether `files` pass there. One run on main at a time (the test command may clear main's caches while
 * another run boots); lanes that ask while main is busy are answered together by the next turn, with one run of
 * all their files, instead of one turn each.
 */
function askMain(main: string, files: string[], how: How, warm = false): Promise<MainAnswer> {
	if (!warm) {
		const seen = asked.get(main) ?? { how, files: new Map<string, number>() };
		seen.how = how;
		for (const f of files) seen.files.set(f, Date.now());
		asked.set(main, seen);
	}
	return new Promise((res, rej) => {
		asks.set(main, [...(asks.get(main) ?? []), { ...how, files, at: Date.now(), warm, res, rej }]);
		void onMain(main, async () => {
			const batch = asks.get(main) ?? [];
			if (!batch.length) return; // an earlier turn answered it
			asks.delete(main);
			// a lane waiting: its files only (a warm-up's many files would make the lane wait for all of them); the
			// warm-up is answered by that run too, its other files wait for the next merge
			const lanes = batch.filter((a) => !a.warm);
			const run = lanes.length ? lanes : batch;
			const timeoutMs = Math.max(...run.map((a) => a.timeoutMs));
			const test = (dir: string, f: string[]) => run[0]!.slot(() => runTests(run[0]!.adapter, dir, f, timeoutMs));
			try {
				const r = await greenThere(main, [...new Set(run.flatMap((a) => a.files))], test, !lanes.length);
				for (const a of batch) a.res({ ...r, waitedMs: Date.now() - a.at });
			} catch (e) {
				for (const a of batch) a.rej(e);
			}
		});
	});
}

/**
 * After a merge main's tree is new and every kept answer is old: the neighbour files lanes asked about in the last
 * hour run on it now, on the side, so a lane's next gate finds the answer instead of waiting for main's turn.
 */
export async function warmMainCache(): Promise<void> {
	const runs: Array<Promise<unknown>> = [];
	for (const [main, { how, files }] of asked) {
		for (const [f, at] of files) if (Date.now() - at > WARM_FOR_MS) files.delete(f);
		if (files.size && existsSync(main)) runs.push(askMain(main, [...files.keys()], how, true).catch(() => undefined));
	}
	await Promise.all(runs);
}

/** Which of `files` pass on main (its checkout at `main`), from the kept answers for main's tree or a run there. */
async function greenThere(main: string, files: string[], test: (dir: string, files: string[]) => Promise<TestRun>, warm = false): Promise<{ green: Map<string, boolean>; head: string }> {
	const headOf = async () => {
		try {
			return (await exec("git", ["-C", main, "rev-parse", "HEAD", "HEAD^{tree}"])).trim().split("\n");
		} catch {
			return ["", ""]; // not a git checkout: nothing kept
		}
	};
	const [head, tree] = await headOf();
	const key = (t: string) => `${main}\0${tree}\0${t}`;
	const green = new Map(files.filter((t) => tree && greenOnMain.has(key(t))).map((t) => [t, greenOnMain.get(key(t))!] as const));
	for (const t of files) if (!green.has(t) && !existsSync(join(main, t))) green.set(t, false);
	const present = files.filter((t) => !green.has(t));
	// all of them at once first. Red on main too: the files the runner names failing are red, the rest run once
	// more together; only when the runner names none (or that run is red too) file by file, which is slow with
	// many files and one main run at a time across lanes
	const all = present.length ? await test(main, present) : { ok: true, output: "" };
	if (all.ok) for (const t of present) green.set(t, true);
	else {
		const red = all.output.endsWith("[timed out]") ? [] : failingFiles(all.output, present, main);
		for (const t of red) green.set(t, false);
		const rest = present.filter((t) => !red.includes(t));
		if (red.length && rest.length && (await test(main, rest)).ok) for (const t of rest) green.set(t, true);
		// a warm-up never runs file by file (it would hold main's turn for minutes): those files stay unanswered
		else if (!warm) for (const t of rest) green.set(t, (await test(main, [t])).ok);
	}
	// a result is kept only when main did not move during the run
	if (tree && (await headOf())[1] === tree) for (const [t, ok] of green) greenOnMain.set(key(t), ok);
	return { green, head: head ?? "" };
}

/**
 * The gate's ported-test run (check_my_code runs the same). The unit's own tests must pass. The area's other tests
 * then run too: one that fails counts against this unit only if it passes on main (this unit broke it), so a test red
 * on main already never blocks it. Main (`mainDir`, main's project checkout) runs only when a neighbour fails here,
 * and its answer is kept per main's tree. Without `mainDir` every neighbour failure counts.
 * The worktree may be on an older main than the one asked: a neighbour main fixed since would fail here only for
 * that. `catchUp` (the gate): main's new commits are brought in under the unit's work and the neighbours run again
 * before they count; a clash with main counts none of them (the merge puts the code on the current main, and the
 * gate after it checks them). Without it (the session's own checks) they do not count either: the gate decides.
 * `slot`: the gate pool slot, taken around each test run only, never while waiting for main's turn.
 */
export async function runPortedTests(o: { ledger: Ledger; unitId: string; adapter: TargetAdapter; dir: string; tests: string[]; mainDir?: string; timeoutMs: number; slot?: Slot; catchUp?: boolean }): Promise<TestRun> {
	const slot = o.slot ?? (<T>(fn: () => Promise<T>) => fn());
	const test = (dir: string, files: string[]) => slot(() => runTests(o.adapter, dir, files, o.timeoutMs));
	if (o.tests.length < 2) return test(o.dir, o.tests);
	const own = await ownTests(o.ledger, o.unitId, o.dir, o.tests, o.adapter.toolchain.ignoredPaths);
	const mine = await test(o.dir, own);
	const others = o.tests.filter((t) => !own.includes(t));
	if (!mine.ok || !others.length) return mine;
	const stillPass = { ...mine, output: `${mine.output}\n\nThe area's other ported tests (${others.length} file(s)) still pass.` };
	let n = await test(o.dir, others);
	if (n.ok) return stillPass;
	const main = o.mainDir && existsSync(o.mainDir) && realpathSync(o.mainDir) !== realpathSync(o.dir) ? o.mainDir : undefined;
	if (!main) return { ...n, output: `Your own tests pass; the area's other ported tests fail with your code:\n${n.output}` };
	// the worktree on an older main: main's new commits come in (the gate) or not (the session's checks) before main's
	// answer is waited for, which a clash would throw away
	let why: string | undefined;
	if (o.catchUp) {
		const caught = await catchUpWithMain(o.dir, main);
		if (caught && "clash" in caught) why = `your code clashes with main's new commits in ${caught.clash.join(", ") || "some files"}: the merge puts it on the current main and they are checked after it`;
		else if (caught && (n = await test(o.dir, others)).ok) return stillPass;
	} else {
		const sha = await exec("git", ["-C", main, "rev-parse", "HEAD"]).then((s) => s.trim(), () => "");
		if (sha && !(await holds(o.dir, sha))) why = "the gate brings main's new commits into your worktree first and checks them again";
	}
	if (why) {
		const named = failingFiles(n.output, others, o.dir);
		return { ...mine, output: `${mine.output}\nwarning: test file(s) of other units fail here (${named.length ? named.join(", ") : `${others.length} file(s)`}), but your worktree is on an older main, so they are ${STALE_NOT_COUNTED}: ${why}` };
	}
	const ans = await askMain(main, others, { adapter: o.adapter, timeoutMs: o.timeoutMs, slot });
	const mainWaitMs = ans.waitedMs;
	const greenThere = others.filter((t) => ans.green.get(t));
	const redThere = others.filter((t) => !greenThere.includes(t));
	const note = redThere.length ? `\nwarning: ${redThere.length} test file(s) of other units ${FAIL_ON_MAIN_TOO}: ${redThere.join(", ")}` : "";
	if (!greenThere.length) return { ...mine, output: `${mine.output}${note}`, mainWaitMs };
	// main moved while its answer was waited for: they may fail here only for what main fixed since
	if (ans.head && !(await holds(o.dir, ans.head))) {
		const caught = o.catchUp ? await catchUpWithMain(o.dir, main, ans.head) : undefined;
		const why = !o.catchUp ? "the gate brings main's new commits into your worktree first and checks them again" : caught && "clash" in caught ? `your code clashes with main's new commits in ${caught.clash.join(", ") || "some files"}: the merge puts it on the current main and they are checked after it` : undefined;
		if (why) return { ...mine, output: `${mine.output}${note}\nwarning: ${greenThere.length} test file(s) of other units fail here and pass on main, but your worktree is on an older main, so they are ${STALE_NOT_COUNTED}: ${why}: ${greenThere.join(", ")}`, mainWaitMs };
	}
	const broke = await test(o.dir, greenThere);
	if (broke.ok) return { ...mine, output: `${mine.output}${note}`, mainWaitMs };
	// name only the files the runner shows failing (it may list passing files too), so the failing test still fits in a clipped report
	const named = failingFiles(broke.output, greenThere, o.dir);
	return { ...broke, mainWaitMs, output: `Your own tests pass, but other units' tests in the area pass on main and fail with your code (${named.length ? named.join(", ") : `${greenThere.length} file(s)`}): fix your code (they may not be edited; a wrong one: report_migrated_bug with evidence).${note}\n${broke.output}` };
}

/** The note on a green run that did not count other units' tests because the worktree was on an older main. */
export const STALE_NOT_COUNTED = "not counted against this unit yet";

/**
 * The test runner's failure lines in `out` ("FAIL x", "Failed x", "✗ x", "1) x"), without the marker, cut to `max`
 * characters. A long line is kept, not dropped: vitest puts the file and the whole test title on its FAIL line.
 */
export const failureLines = (out: string, max = 160): string[] => [...out.matchAll(/^\s*(?:FAIL|FAILED|✗|×|✕|\d+\))\s+(.{3,})$/gim)].map((m) => m[1]!.trim().slice(0, max));

/**
 * The files among `files` (project paths of a run in `dir`) the runner's output says failed: named on a failure
 * line ("FAIL tests/a.spec", "Failed tests/ATest.php (exit 2)"), or in the trace of a numbered failure
 * ("1) App\\Tests\\ATest::testX" … "<dir>/tests/ATest.php:75"), where the runner names the file of a test it calls
 * by class. The runner's notice and deprecation lists name passing tests the same way: they are left out.
 */
export function failingFiles(out: string, files: string[], dir: string): string[] {
	const lines = dropNoticeLists(out.split("\n")).kept;
	const fails = failureLines(lines.join("\n"), Infinity);
	const dirs = [...new Set([dir, ...(existsSync(dir) ? [realpathSync(dir)] : [])])];
	// the path itself, not the tail of a longer one (tests/a.spec in src/tests/a.spec), unless the run dir is in front
	const names = (l: string, t: string) => {
		for (let i = l.indexOf(t); i >= 0; i = l.indexOf(t, i + 1)) {
			const before = l.slice(0, i);
			if ((i === 0 || /[\s'"(\[]$/.test(before) || dirs.some((d) => before.endsWith(`${d}/`))) && !/[\w./-]/.test(l[i + t.length] ?? "")) return true;
		}
		return false;
	};
	// each numbered failure's lines, up to the next one or the next list heading
	const traces: string[] = [];
	for (const l of lines) {
		if (/^\s*\d+\)\s+\S/.test(l)) traces.push("");
		else if (/^(?:\d+ tests? triggered|There (?:was|were)) /i.test(l)) traces.push("\0");
		else if (traces.length && !traces.at(-1)!.startsWith("\0")) traces[traces.length - 1] += `\n${l}`;
	}
	const inTrace = (t: string) => traces.some((b) => dirs.some((d) => b.includes(`${d}/${t}:`)));
	return files.filter((t) => fails.some((l) => names(l, t)) || inTrace(t));
}

/** `sha` is in the history of the checkout at `dir` (true when git cannot say: nothing to bring in then). */
async function holds(dir: string, sha: string): Promise<boolean> {
	try {
		await exec("git", ["-C", dir, "cat-file", "-e", `${sha}^{commit}`]);
	} catch {
		return true; // another repository (a clone): its main is not this one's
	}
	try {
		await exec("git", ["-C", dir, "merge-base", "--is-ancestor", sha, "HEAD"]);
		return true;
	} catch {
		return false;
	}
}

/**
 * Brings main's commits since the worktree was made into it, the work in it kept uncommitted on top as before: it is
 * committed, the branch rebased onto main (`to`, else the commit main's checkout `mainDir` is on), and the commit
 * undone. A clash with main leaves the worktree as it was and names the files. Nothing to bring in, or a worktree in
 * the middle of a git operation: undefined.
 */
export async function catchUpWithMain(dir: string, mainDir: string, to?: string): Promise<{ commits: number } | { clash: string[] } | undefined> {
	const git = async (args: string[]) => (await exec("git", ["-C", dir, "-c", "user.name=bigrefactor", "-c", "user.email=bigrefactor@localhost", ...args])).trim();
	try {
		const sha = to ?? (await exec("git", ["-C", mainDir, "rev-parse", "HEAD"])).trim();
		if (await holds(dir, sha)) return undefined;
		const busy = await Promise.all(["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD"].map(async (p) => existsSync(await git(["rev-parse", "--path-format=absolute", "--git-path", p]))));
		if (busy.some(Boolean) || (await git(["diff", "--name-only", "--diff-filter=U"]))) return undefined;
		const before = await git(["rev-parse", "HEAD"]);
		const commits = Number(await git(["rev-list", "--count", `HEAD..${sha}`]));
		await git(["add", "-A"]);
		const work = !!(await git(["diff", "--cached", "--name-only"]));
		if (work) await git(["commit", "-q", "--no-verify", "-m", "wip: the unit's work while main's new commits are brought in"]);
		try {
			await git(["rebase", "-q", sha]);
		} catch {
			const clash = (await git(["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).split("\n").filter(Boolean);
			await git(["rebase", "--abort"]).catch(() => "");
			await git(["reset", "-q", before]);
			return { clash };
		}
		if (work) await git(["reset", "-q", "HEAD~1"]);
		return { commits };
	} catch {
		return undefined; // no git answer: the worktree stays as it is
	}
}

/** Runs the stack's test command on `files`; true when it exits 0 (all given tests pass). */
export function testsPass(targetProjectDir: string, adapter: TargetAdapter, files: string[]): Promise<boolean> {
	const c = adapter.test(targetProjectDir, files);
	return new Promise((res) => execFile(c.cmd, c.args, { cwd: targetProjectDir, env: { ...process.env, CI: "1", FORCE_COLOR: "0" }, maxBuffer: 20 * 1024 * 1024, timeout: 5 * 60_000 }, (e) => res(!e)));
}

/**
 * Keeps a session to its own paths in the project. Call it before the session; the function it returns, called after
 * the session, puts back every file the session changed outside `allowed` (globs relative to `dir`): to its content
 * before the session, else to HEAD, and a new file is removed. Work already in the tree (an implementer's) stays.
 * Returns the paths it put back.
 */
export async function scopeGuard(dir: string, allowed: string[], ignored: string[] = []): Promise<() => Promise<string[]>> {
	const allow = allowed.map(globToRegExp);
	const outside = async () => (await changedFiles(dir, ignored)).filter((f) => !allow.some((r) => r.test(f)));
	const read = (f: string) => (existsSync(join(dir, f)) && statSync(join(dir, f)).isFile() ? readFileSync(join(dir, f)) : null);
	const before = new Map((await outside()).map((f) => [f, read(f)] as const));
	return async () => {
		const tracked = new Set(await trackedFiles(dir));
		const put: string[] = [];
		for (const f of new Set([...before.keys(), ...(await outside())])) {
			const now = read(f);
			const was = before.get(f);
			if (was !== undefined) {
				if (now === was || (now && was && now.equals(was))) continue;
				if (was === null) rmSync(join(dir, f), { force: true });
				else (mkdirSync(dirname(join(dir, f)), { recursive: true }), writeFileSync(join(dir, f), was));
			} else if (tracked.has(f)) await exec("git", ["checkout", "HEAD", "--", f], { cwd: dir });
			else rmSync(join(dir, f), { force: true });
			put.push(f);
		}
		return put;
	};
}
