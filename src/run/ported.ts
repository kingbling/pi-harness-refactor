import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { TargetAdapter } from "../adapters/types.ts";
import type { Ledger } from "../ledger/db.ts";
import { globToRegExp } from "../sessions/spawn.ts";
import { changedFiles, runTests, scopedCheck, trackedFiles } from "./gate.ts";
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

type TestRun = { ok: boolean; output: string; exitCode?: number };
/** Neighbour test files that pass on main, per main's tree: main is run again only after it changed. */
const greenOnMain = new Map<string, boolean>();

/** Runs on main's checkout, one at a time across lanes. */
let mainQueue: Promise<unknown> = Promise.resolve();
function onMain<T>(fn: () => Promise<T>): Promise<T> {
	const r = mainQueue.then(fn, fn);
	mainQueue = r.catch(() => undefined);
	return r;
}

/**
 * The gate's ported-test run (check_my_code runs the same). The unit's own tests must pass. The area's other tests
 * then run too: one that fails counts against this unit only if it passes on main (this unit broke it), so a test red
 * on main already never blocks it. Main (`mainDir`, main's project checkout) runs only when a neighbour fails here,
 * and its answer is kept per main's tree. Without `mainDir` every neighbour failure counts.
 * `slot`: the gate pool slot, taken around each test run only, never while waiting for main's turn.
 */
export async function runPortedTests(o: { ledger: Ledger; unitId: string; adapter: TargetAdapter; dir: string; tests: string[]; mainDir?: string; timeoutMs: number; slot?: <T>(fn: () => Promise<T>) => Promise<T> }): Promise<TestRun> {
	const slot = o.slot ?? (<T>(fn: () => Promise<T>) => fn());
	const test = (dir: string, files: string[]) => slot(() => runTests(o.adapter, dir, files, o.timeoutMs));
	if (o.tests.length < 2) return test(o.dir, o.tests);
	const own = await ownTests(o.ledger, o.unitId, o.dir, o.tests, o.adapter.toolchain.ignoredPaths);
	const mine = await test(o.dir, own);
	const others = o.tests.filter((t) => !own.includes(t));
	if (!mine.ok || !others.length) return mine;
	const n = await test(o.dir, others);
	if (n.ok) return { ...mine, output: `${mine.output}\n\nThe area's other ported tests (${others.length} file(s)) still pass.` };
	const main = o.mainDir && existsSync(o.mainDir) && realpathSync(o.mainDir) !== realpathSync(o.dir) ? o.mainDir : undefined;
	if (!main) return { ...n, output: `Your own tests pass; the area's other ported tests fail with your code:\n${n.output}` };
	const treeOf = async () => {
		try {
			return (await exec("git", ["-C", main, "rev-parse", "HEAD^{tree}"])).trim();
		} catch {
			return ""; // not a git checkout: nothing kept
		}
	};
	// one run on main at a time (the test command may clear main's caches while another run boots), and a result is
	// kept only when main did not move during the run
	const green = await onMain(async () => {
		const tree = await treeOf();
		const key = (t: string) => `${main}\0${tree}\0${t}`;
		const green = new Map(others.filter((t) => tree && greenOnMain.has(key(t))).map((t) => [t, greenOnMain.get(key(t))!] as const));
		for (const t of others) if (!green.has(t) && !existsSync(join(main, t))) green.set(t, false);
		const present = others.filter((t) => !green.has(t));
		// all of them at once first; only when main is red too, file by file to find the ones it passes
		if (present.length && (await test(main, present)).ok) for (const t of present) green.set(t, true);
		else for (const t of present) green.set(t, (await test(main, [t])).ok);
		if (tree && (await treeOf()) === tree) for (const [t, ok] of green) greenOnMain.set(key(t), ok);
		return green;
	});
	const greenThere = others.filter((t) => green.get(t));
	const redThere = others.filter((t) => !greenThere.includes(t));
	const note = redThere.length ? `\nwarning: ${redThere.length} test file(s) of other units ${FAIL_ON_MAIN_TOO}: ${redThere.join(", ")}` : "";
	if (!greenThere.length) return { ...mine, output: `${mine.output}${note}` };
	const broke = await test(o.dir, greenThere);
	if (broke.ok) return { ...mine, output: `${mine.output}${note}` };
	// name only the files on the runner's failure lines (it may list passing files too), so the failing test still fits in a clipped report
	const fails = failureLines(broke.output);
	const named = greenThere.filter((t) => fails.some((l) => l.includes(t)));
	return { ...broke, output: `Your own tests pass, but other units' tests in the area pass on main and fail with your code (${named.length ? named.join(", ") : `${greenThere.length} file(s)`}): fix your code (they may not be edited; a wrong one: report_migrated_bug with evidence).${note}\n${broke.output}` };
}

/** The test runner's failure lines in `out` ("FAIL x", "✗ x", "1) x"), without the marker. */
export const failureLines = (out: string): string[] => [...out.matchAll(/^\s*(?:FAIL|FAILED|✗|×|✕|\d+\))\s+(.{3,160})$/gm)].map((m) => m[1]!.trim());

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
