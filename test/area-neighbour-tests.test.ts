import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { TargetAdapter } from "../src/adapters/types.ts";
import { Ledger } from "../src/ledger/db.ts";
import { catchUpWithMain, failingFiles, failureLines, ownTests, runPortedTests, STALE_NOT_COUNTED, warmMainCache } from "../src/run/ported.ts";

/**
 * The gate runs the unit's own ported tests; another unit's test in the same area counts against the unit only when it
 * passes on main and fails with the unit's code. A test already red on main never blocks it.
 */
const here = resolve(import.meta.dirname, "..");
const root = join(here, ".sim", "area-neighbour-tests");
const main = join(root, "main");
const wt = join(root, "wt");
const log = join(root, "runs.log");
const write = (p: string, s: string) => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, s));
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" });
// a test file passes when it says "pass" and the code in broken.txt does not break it; every run is logged with its dir
const adapter = {
	toolchain: { ignoredPaths: [] },
	test: (_d: string, files: string[]) => ({ cmd: "sh", args: ["-c", `echo "$PWD $*" >> ${log}; for f; do grep -q pass "$f" || { echo "FAIL $f"; exit 1; }; grep -qx "$f" broken.txt 2>/dev/null && { echo "FAIL $f"; exit 1; }; done; exit 0`, "sh", ...files] }),
} as unknown as TargetAdapter;
const TESTS = ["tests/own.spec", "tests/n1.spec", "tests/n2.spec"];
const runsIn = (dir: string) => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith(`${dir} `)).length : 0);
let ledger: Ledger;
const run = (tests = TESTS) => runPortedTests({ ledger, unitId: "u1", adapter, dir: wt, tests, mainDir: main, timeoutMs: 30_000 });

beforeEach(() => {
	rmSync(root, { recursive: true, force: true });
	write(join(main, "tests/own.spec"), "pass\n");
	write(join(main, "tests/n1.spec"), "pass\n"); // another unit's, green on main
	write(join(main, "tests/n2.spec"), "fail\n"); // another unit's, red on main already
	write(join(main, "stamp.txt"), `${Math.random()}\n`); // a tree of its own: no answer main kept for an earlier test's tree
	git(main, "init", "-q");
	git(main, "add", "-A");
	git(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
	git(root, "clone", "-q", main, wt);
	ledger = new Ledger(join(root, "ledger.sqlite"));
	ledger.createUnit({ id: "u1", tier: "T1", deps: [], meta: {}, symbolIds: [] });
	ledger.db.prepare("INSERT INTO truth_cases(id, unit_id, symbol_id, inputs, expected, verified_on_old, created_at, ported_test_path) VALUES ('u1#1','u1','s','[]','1',1,'t','tests/own.spec')").run();
});

describe("ported tests: the unit's own, and the area's other tests only when the unit broke them", () => {
	it("own tests are the ones its truth cases link to, plus test files new or changed in the worktree", async () => {
		write(join(wt, "tests/new.spec"), "pass\n");
		expect(await ownTests(ledger, "u1", wt, [...TESTS, "tests/new.spec"])).toEqual(["tests/own.spec", "tests/new.spec"]);
		// nothing of its own found: every test counts, as before
		expect(await ownTests(ledger, "u2", wt, TESTS)).toEqual(TESTS);
	});

	it("a neighbour already red on main does not block the unit (named as a warning)", async () => {
		const r = await run();
		expect(r.ok).toBe(true);
		expect(r.output).toMatch(/warning: 1 test file\(s\) of other units fail on main too, not counted against this unit: tests\/n2\.spec/);
	});

	it("a neighbour green on main that fails with the unit's code counts against it, named", async () => {
		write(join(wt, "broken.txt"), "tests/n1.spec\n");
		const r = await run();
		expect(r.ok).toBe(false);
		expect(r.output).toMatch(/Your own tests pass, but other units' tests in the area pass on main and fail with your code \(tests\/n1\.spec\)/);
		expect(r.output).toContain("FAIL tests/n1.spec");
	});

	it("names only the neighbours the output shows failing; none shown: a count", async () => {
		write(join(main, "tests/n3.spec"), "pass\n");
		git(main, "add", "-A");
		git(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "n3");
		git(wt, "pull", "-q");
		write(join(wt, "broken.txt"), "tests/n1.spec\n");
		const tests = [...TESTS, "tests/n3.spec"];
		// a runner that lists every file, passing ones too (vitest's "✓ file"), and goes on after a failure
		const verbose = { ...adapter, test: (_d: string, files: string[]) => ({ cmd: "sh", args: ["-c", `s=0; for f; do if grep -q pass "$f" && ! grep -qx "$f" broken.txt 2>/dev/null; then echo " ✓ $f (1 test)"; else echo " FAIL  $f > a test"; s=1; fi; done; exit $s`, "sh", ...files] }) } as unknown as TargetAdapter;
		const r = await runPortedTests({ ledger, unitId: "u1", adapter: verbose, dir: wt, tests, mainDir: main, timeoutMs: 30_000 });
		expect(r.output).toContain("✓ tests/n3.spec");
		expect(r.output).toMatch(/fail with your code \(tests\/n1\.spec\)/);
		// a runner that prints no file names
		const quiet = { ...adapter, test: (d: string, files: string[]) => { const c = adapter.test(d, files); return { ...c, args: [c.args[0], `(${c.args[1]}) >/dev/null; s=$?; [ $s = 0 ] || echo "1 failed"; exit $s`, ...c.args.slice(2)] }; } } as TargetAdapter;
		const q = await runPortedTests({ ledger, unitId: "u1", adapter: quiet, dir: wt, tests, mainDir: main, timeoutMs: 30_000 });
		expect(q.ok).toBe(false);
		expect(q.output).toMatch(/fail with your code \(2 file\(s\)\)/);
	});

	it("own tests red: red, and main is never run", async () => {
		write(join(wt, "tests/own.spec"), "fail\n");
		const r = await run();
		expect(r.ok).toBe(false);
		expect(r.output).toContain("FAIL tests/own.spec");
		expect(runsIn(main)).toBe(0);
	});

	it("main runs only when a neighbour fails here, and once per main tree", async () => {
		write(join(main, "tests/n2.spec"), "pass\n");
		git(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "n2 fixed on main");
		write(join(wt, "tests/n2.spec"), "pass\n"); // all green here: main is not needed
		git(wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "same");
		expect((await run()).ok).toBe(true);
		expect(runsIn(main)).toBe(0);
		write(join(wt, "broken.txt"), "tests/n1.spec\n");
		expect((await run()).ok).toBe(false);
		const first = runsIn(main);
		expect(first).toBeGreaterThan(0);
		expect((await run()).ok).toBe(false);
		expect(runsIn(main)).toBe(first);
		// main changed: asked again
		write(join(main, "other.txt"), "x\n");
		git(main, "add", "-A");
		git(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "merge");
		await run();
		expect(runsIn(main)).toBeGreaterThan(first);
	});

	it("two lanes never run tests on main at the same time", async () => {
		write(join(main, "lanes.txt"), "a tree no other test has\n");
		git(main, "add", "-A");
		git(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "lanes");
		const wt2 = join(root, "wt2");
		git(root, "clone", "-q", main, wt2);
		// on main the command marks itself busy for a moment; a second run that finds the mark logs an overlap
		const slow = {
			...adapter,
			test: (d: string, files: string[]) => (d === main ? { cmd: "sh", args: ["-c", `[ -e .busy ] && echo overlap >> ${log}; touch .busy; sleep 0.3; rm -f .busy; for f; do grep -q pass "$f" || exit 1; done`, "sh", ...files] } : adapter.test(d, files)),
		} as TargetAdapter;
		for (const d of [wt, wt2]) write(join(d, "broken.txt"), "tests/n1.spec\n");
		const runs = await Promise.all([wt, wt2].map((dir) => runPortedTests({ ledger, unitId: "u1", adapter: slow, dir, tests: TESTS, mainDir: main, timeoutMs: 30_000 })));
		expect(runs.map((r) => r.ok)).toEqual([false, false]);
		expect(existsSync(log) ? readFileSync(log, "utf8") : "").not.toContain("overlap");
	});

	it("without main's checkout every neighbour failure counts (as before)", async () => {
		const r = await runPortedTests({ ledger, unitId: "u1", adapter, dir: wt, tests: TESTS, timeoutMs: 30_000 });
		expect(r.ok).toBe(false);
		expect(r.output).toContain("FAIL tests/n2.spec");
	});
	it("main red too: the files its runner names failing are red, the rest run together once, not file by file", async () => {
		const many = Array.from({ length: 8 }, (_, i) => `tests/m${i}.spec`);
		for (const f of many) write(join(main, f), "pass\n");
		git(main, "add", "-A");
		git(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "many");
		git(wt, "pull", "-q");
		write(join(wt, "broken.txt"), "tests/m3.spec\n");
		// a runner that runs every file and names each failing one (vitest, jest)
		const all = { ...adapter, test: (_d: string, files: string[]) => ({ cmd: "sh", args: ["-c", `echo "$PWD $*" >> ${log}; rc=0; for f; do if ! grep -q pass "$f" || grep -qx "$f" broken.txt 2>/dev/null; then echo "FAIL $f"; rc=1; fi; done; exit $rc`, "sh", ...files] }) } as unknown as TargetAdapter;
		const r = await runPortedTests({ ledger, unitId: "u1", adapter: all, dir: wt, tests: [...TESTS, ...many], mainDir: main, timeoutMs: 30_000 });
		expect(r.ok).toBe(false);
		expect(r.output).toMatch(/pass on main and fail with your code \(tests\/m3\.spec\)/);
		expect(r.output).toMatch(/fail on main too.*tests\/n2\.spec/);
		expect(runsIn(main)).toBe(2); // all at once (n2 named red), then the other 9 together
	});

	it("a runner's 'Failed <file>' line and a numbered failure's trace name the failing files; notice lists and longer paths do not", () => {
		const dir = "/w/symfony";
		const out = [
			"Running tests/AOkTest.php",
			"2 tests triggered 2 PHPUnit notices:",
			"",
			"1) App\\Tests\\AOkTest::testA",
			"No expectations were configured for the mock object.",
			"",
			`${dir}/tests/AOkTest.php:17`,
			"",
			"OK, but there were issues!",
			"There were 2 errors:",
			"",
			"1) App\\Tests\\BTest::testB",
			"Symfony\\Component\\Config\\Exception\\LoaderLoadException: Expected to find class",
			"",
			`${dir}/vendor/symfony/config/Loader/FileLoader.php:190`,
			`${dir}/tests/BTest.php:15`,
			"",
			"ERRORS!",
			"Failed tests/CTest.php (exit 2)",
			"Failed src/tests/DTest.php (exit 2)",
		].join("\n");
		expect(failingFiles(out, ["tests/AOkTest.php", "tests/BTest.php", "tests/CTest.php", "tests/DTest.php"], dir)).toEqual(["tests/BTest.php", "tests/CTest.php"]);
	});

	it("vitest's FAIL line longer than 160 characters (the file and the whole test title) names the failing file", () => {
		const file = "src/features/inventory/components/SubnetDetails.U719.test.tsx";
		const out = [
			` ❯ ${file} (3 tests | 1 failed) 3240ms`,
			"     × U719_inc_subnets_tpl#1 displays populated fields and includes hours; null CPM prices omit CPM section 1079ms",
			` ✓ src/features/inventory/components/SubnetList.test.tsx (2 tests) 40ms`,
			"",
			` FAIL  ${file} > SubnetDetails legacy presentation > U719_inc_subnets_tpl#1 displays populated fields and includes hours; null CPM prices omit CPM section`,
			"TestingLibraryElementError: Unable to find an element with the text: Hours",
		].join("\n");
		expect(out.split("\n")[4]!.length).toBeGreaterThan(160);
		expect(failingFiles(out, [file, "src/features/inventory/components/SubnetList.test.tsx"], "/w/web")).toEqual([file]);
		// the readable list of failures (triage) stays short
		expect(failureLines(out).every((l) => l.length <= 160)).toBe(true);
		expect(failureLines(out)).toHaveLength(2);
	});

	it("main red too, with a runner that says 'Failed <file> (exit 2)': no run file by file", async () => {
		const many = Array.from({ length: 6 }, (_, i) => `tests/m${i}.spec`);
		for (const f of many) write(join(main, f), "pass\n");
		git(main, "add", "-A");
		git(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "many");
		git(wt, "pull", "-q");
		write(join(wt, "broken.txt"), "tests/m3.spec\n");
		// a per-file wrapper: runs every file and lists the failing ones at the end
		const wrapper = { ...adapter, test: (_d: string, files: string[]) => ({ cmd: "sh", args: ["-c", `echo "$PWD $*" >> ${log}; rc=0; for f; do echo "Running $f"; if ! grep -q pass "$f" || grep -qx "$f" broken.txt 2>/dev/null; then echo "Failed $f (exit 2)"; rc=1; fi; done; exit $rc`, "sh", ...files] }) } as unknown as TargetAdapter;
		const r = await runPortedTests({ ledger, unitId: "u1", adapter: wrapper, dir: wt, tests: [...TESTS, ...many], mainDir: main, timeoutMs: 30_000 });
		expect(r.ok).toBe(false);
		expect(r.output).toMatch(/pass on main and fail with your code \(tests\/m3\.spec\)/);
		expect(runsIn(main)).toBe(2);
	});

	it("lanes that ask main while it is busy are answered by one run together, and the wait is reported", async () => {
		const extra = ["tests/n3.spec", "tests/n4.spec", "tests/n5.spec"];
		for (const f of extra) write(join(main, f), "pass\n");
		git(main, "add", "-A");
		git(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "three more");
		const lanes = extra.map((_, i) => join(root, `lane${i}`));
		for (const [i, d] of lanes.entries()) {
			git(root, "clone", "-q", main, d);
			write(join(d, "broken.txt"), `${extra[i]}\n`);
		}
		const slow = { ...adapter, test: (d: string, files: string[]) => (d === main ? { ...adapter.test(d, files), args: [adapter.test(d, files).args[0]!, `sleep 0.3; ${adapter.test(d, files).args[1]}`, ...adapter.test(d, files).args.slice(2)] } : adapter.test(d, files)) } as TargetAdapter;
		const runs = await Promise.all(lanes.map((dir, i) => runPortedTests({ ledger, unitId: "u1", adapter: slow, dir, tests: ["tests/own.spec", extra[i]!], mainDir: main, timeoutMs: 30_000 })));
		expect(runs.map((r) => r.ok)).toEqual([false, false, false]);
		// the first lane's run, then one run for the two lanes that waited meanwhile
		expect(runsIn(main)).toBe(2);
		expect(Math.max(...runs.map((r) => r.mainWaitMs ?? 0))).toBeGreaterThanOrEqual(250);
	});

	it("each stack's main checkout has its own turn: a long run on one main does not hold a lane asking the other", async () => {
		const main2 = join(root, "main2");
		git(root, "clone", "-q", main, main2);
		const wt2 = join(root, "wt2");
		git(root, "clone", "-q", main2, wt2);
		for (const d of [wt, wt2]) write(join(d, "broken.txt"), "tests/n1.spec\n");
		const busy = join(root, "main-busy");
		// on the first main the run takes a while
		const slow = { ...adapter, test: (d: string, files: string[]) => (d === main ? { ...adapter.test(d, files), args: [adapter.test(d, files).args[0]!, `touch ${busy}; sleep 1.5; ${adapter.test(d, files).args[1]}`, ...adapter.test(d, files).args.slice(2)] } : adapter.test(d, files)) } as TargetAdapter;
		const first = runPortedTests({ ledger, unitId: "u1", adapter: slow, dir: wt, tests: TESTS, mainDir: main, timeoutMs: 30_000 });
		for (let i = 0; i < 150 && !existsSync(busy); i++) await new Promise((r) => setTimeout(r, 20));
		const second = await runPortedTests({ ledger, unitId: "u1", adapter: slow, dir: wt2, tests: TESTS, mainDir: main2, timeoutMs: 30_000 });
		expect(second.ok).toBe(false);
		expect(second.mainWaitMs ?? 0).toBeLessThan(1000);
		expect((await first).ok).toBe(false);
	});

	it("after a merge the neighbour files lanes asked about run on main's new tree on the side; the next gate finds the answer", async () => {
		write(join(wt, "broken.txt"), "tests/n1.spec\n");
		expect((await run()).ok).toBe(false);
		write(join(main, "merged.txt"), "another unit\n");
		git(main, "add", "-A");
		git(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "merge");
		await warmMainCache();
		const warmed = runsIn(main);
		expect(warmed).toBeGreaterThan(0);
		expect((await run()).ok).toBe(false);
		expect(runsIn(main)).toBe(warmed);
	});
});

describe("ported tests: main's warm-up after a merge stays out of the lanes' way", () => {
	const commitMain = (m: string) => (write(join(main, `${m}.txt`), m), git(main, "add", "-A"), git(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", m));
	const mainLines = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith(`${main} `)) : []);

	it("a warm-up whose run is red and names no file does not run file by file", async () => {
		// a runner that fails without saying which file
		const quiet = { ...adapter, test: (_d: string, files: string[]) => ({ cmd: "sh", args: ["-c", `echo "$PWD $*" >> ${log}; for f; do grep -q pass "$f" || exit 1; grep -qx "$f" broken.txt 2>/dev/null && exit 1; done; exit 0`, "sh", ...files] }) } as unknown as TargetAdapter;
		write(join(wt, "broken.txt"), "tests/n1.spec\n");
		expect((await runPortedTests({ ledger, unitId: "u1", adapter: quiet, dir: wt, tests: TESTS, mainDir: main, timeoutMs: 30_000 })).ok).toBe(false);
		commitMain("merge");
		const before = mainLines().length;
		await warmMainCache();
		expect(mainLines().length - before).toBe(1);
	});

	it("a lane that asks while a warm-up waits for main's turn gets a run of its own files only", async () => {
		const extra = ["tests/n3.spec", "tests/n4.spec"];
		for (const f of extra) write(join(main, f), "pass\n");
		commitMain("two more");
		const lanes = extra.map((_, i) => join(root, `wlane${i}`));
		for (const [i, d] of lanes.entries()) {
			git(root, "clone", "-q", main, d);
			write(join(d, "broken.txt"), `${extra[i]}\n`);
		}
		const slow = { ...adapter, test: (d: string, files: string[]) => (d === main ? { ...adapter.test(d, files), args: [adapter.test(d, files).args[0]!, `touch ${join(root, "main-busy")}; sleep 1; ${adapter.test(d, files).args[1]}`, ...adapter.test(d, files).args.slice(2)] } : adapter.test(d, files)) } as TargetAdapter;
		const ask = (i: number) => runPortedTests({ ledger, unitId: "u1", adapter: slow, dir: lanes[i]!, tests: ["tests/own.spec", extra[i]!], mainDir: main, timeoutMs: 30_000 });
		const first = ask(0);
		for (let i = 0; i < 100 && !existsSync(join(root, "main-busy")); i++) await new Promise((r) => setTimeout(r, 20));
		// main is busy with the first lane: a warm-up and a second lane wait for the same turn
		const warm = warmMainCache();
		const second = ask(1);
		expect((await Promise.all([first, second])).map((r) => r.ok)).toEqual([false, false]);
		await warm;
		expect(mainLines().filter((l) => l.includes("tests/n4.spec"))).toEqual([`${main} tests/n4.spec`]);
	});
});

/**
 * A unit's worktree is made from main once; main moves on (other units, setup fixes). A neighbour test that fails in
 * the worktree only because main fixed it since must not count against the unit: the gate brings main's new commits
 * in under the unit's work first.
 */
describe("ported tests: a worktree on an older main", () => {
	const lane = join(root, "lane");
	const commit = (m: string) => git(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", m);
	beforeEach(() => {
		// main is broken for n1 when the worktree is made; a setup fix lands on main after
		write(join(main, "broken.txt"), "tests/n1.spec\n");
		write(join(main, "app.txt"), "app\n");
		git(main, "add", "-A");
		commit("n1 broken");
		git(main, "worktree", "add", "-q", "-b", "unit/u1", lane);
		rmSync(join(main, "broken.txt"));
		commit("setup fix: n1 works again");
		// the unit's work, uncommitted: a new file and a changed one
		write(join(lane, "tests/own.spec"), "pass # u1#1\n");
		write(join(lane, "src/mine.txt"), "mine\n");
	});
	const head = (d: string) => execFileSync("git", ["-C", d, "rev-parse", "HEAD"]).toString().trim();
	const status = (d: string) => execFileSync("git", ["-C", d, "status", "--porcelain"]).toString();
	const gate = (catchUp: boolean) => runPortedTests({ ledger, unitId: "u1", adapter, dir: lane, tests: TESTS, mainDir: main, timeoutMs: 30_000, catchUp });

	it("the gate brings main's new commits in under the unit's work, uncommitted as before, and the neighbour passes", async () => {
		const r = await gate(true);
		expect(r.ok).toBe(true);
		expect(r.output).not.toMatch(/fail with your code/);
		expect(head(lane)).toBe(head(main));
		expect(existsSync(join(lane, "broken.txt"))).toBe(false);
		expect(status(lane)).toMatch(/ M tests\/own\.spec/);
		expect(status(lane)).toMatch(/\?\? src\//);
	});

	it("the session's own check does not move the worktree and does not count the neighbour; the gate does not take that check", async () => {
		const before = head(lane);
		const r = await gate(false);
		expect(r.ok).toBe(true);
		expect(r.output).toContain(STALE_NOT_COUNTED);
		expect(r.output).toContain("tests/n1.spec");
		expect(head(lane)).toBe(before);
		// it is not counted whatever main says: main's answer is not waited for
		expect(runsIn(main)).toBe(0);
	});

	it("work that clashes with main's new commits: the worktree stays as it was and the neighbour is left to the merge", async () => {
		write(join(main, "app.txt"), "main's change\n");
		commit("main changes app.txt");
		write(join(lane, "app.txt"), "the unit's change\n");
		const before = head(lane);
		const r = await gate(true);
		expect(r.ok).toBe(true);
		expect(r.output).toMatch(/clashes with main's new commits in app\.txt/);
		expect(head(lane)).toBe(before);
		expect(readFileSync(join(lane, "app.txt"), "utf8")).toBe("the unit's change\n");
		expect(status(lane)).toMatch(/\?\? src\//);
		// the clash is known before main's answer would be: main is not asked
		expect(runsIn(main)).toBe(0);
	});

	it("catchUpWithMain: nothing to bring in when the worktree already holds main", async () => {
		expect(await catchUpWithMain(lane, main)).toEqual({ commits: 1 });
		expect(await catchUpWithMain(lane, main)).toBeUndefined();
	});
});
