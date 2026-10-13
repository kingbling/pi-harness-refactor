import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { TargetAdapter } from "../src/adapters/types.ts";
import { Ledger } from "../src/ledger/db.ts";
import { ownTests, runPortedTests } from "../src/run/ported.ts";

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
	git(main, "init", "-q");
	git(main, "add", "-A");
	git(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
	git(root, "clone", "-q", main, wt);
	ledger = new Ledger(join(root, "ledger.sqlite"));
	ledger.createUnit({ id: "u1", tier: "T1", deps: [], meta: {}, symbolIds: [] });
	ledger.db.prepare("INSERT INTO truth_cases(id, unit_id, symbol_id, inputs, expected, verified_on_old, created_at, ported_test_path) VALUES ('u1#1','u1','s','[]','1',1,'t','tests/own.spec')").run();
});

describe("ported tests: the unit's own, and the area's other tests only when the unit broke them", () => {
	it("own tests are the ones its truth cases link to, plus test files new or changed in the worktree", () => {
		write(join(wt, "tests/new.spec"), "pass\n");
		expect(ownTests(ledger, "u1", wt, [...TESTS, "tests/new.spec"])).toEqual(["tests/own.spec", "tests/new.spec"]);
		// nothing of its own found: every test counts, as before
		expect(ownTests(ledger, "u2", wt, TESTS)).toEqual(TESTS);
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
});
