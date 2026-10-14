import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TargetAdapter } from "../src/adapters/types.ts";
import { ConfigSchema } from "../src/config.ts";
import { commitAll, ensureRepo } from "../src/git.ts";
import { Ledger } from "../src/ledger/db.ts";
import { tidyTasks, type TidyTask } from "../src/run/tidy.ts";
import { createTidyJobs, type TidyWorker } from "../src/run/tidy-job.ts";

/**
 * An approved tidy task runs once as its own job in a worktree of main: the model (faked here) moves the file and
 * updates what uses it; code checks the build and the changed tests; green is merged and done, red is thrown away
 * and failed. Units of the area wait while the task is approved.
 */
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function setup(checkTree?: (dir: string, only?: string[]) => string[], over: { adapter?: (a: TargetAdapter) => TargetAdapter; files?: Record<string, string> } = {}) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "br-tidy-job-")));
	const target = join(root, "new");
	mkdirSync(join(target, "src", "A"), { recursive: true });
	writeFileSync(join(target, "src", "A", "Old.txt"), "class Old\n");
	// an earlier unit's test imports the old path
	writeFileSync(join(target, "src", "A", "Old.test.txt"), "import src/A/Old.txt\nexpects Old\n");
	for (const [f, s] of Object.entries(over.files ?? {})) writeFileSync(join(target, f), s);
	await ensureRepo(target, "migration/main", []);
	await commitAll(target, "init");
	const config = ConfigSchema.parse({ source: { path: root, stack: "php" }, target: { path: target, stacks: ["fake"], git: { branch: "migration/main" } }, models: {} });
	const base = {
		id: "fake",
		protectedGlobs: [],
		toolchain: { ignoredPaths: [] },
		layout: { isTestFile: (p: string) => p.includes(".test."), sourceExtensions: [".txt"], checkTree },
		// the whole-project build (it cannot take files): red while a file's first line points at a path that is not there
		build: () => ({ cmd: "sh", args: ["-c", 'for f in $(grep -rl "src/" src); do i=$(head -1 "$f" | cut -d" " -f2); test -f "$i" || { echo "$f: cannot find $i"; bad=1; }; done; exit ${bad:-0}'] }),
		lint: (_r: string, files: string[]) => ({ cmd: "true", args: files }),
		// a test passes when its import resolves
		test: (_r: string, files: string[]) => ({ cmd: "sh", args: ["-c", 'for f in "$@"; do i=$(head -1 "$f" | cut -d" " -f2); test -f "$i" || exit 1; done', "sh", ...files] }),
	} as unknown as TargetAdapter;
	const adapter = over.adapter ? over.adapter(base) : base;
	const ledger = new Ledger(":memory:");
	const task: TidyTask = { id: "T7", stack: "fake", area: "a", op: "move", from: ["src/A/Old.txt"], to: ["src/B/New.txt"], why: "B is where it belongs", questionId: 7, status: "approved" };
	ledger.setMeta("tidy_tasks", JSON.stringify([task]));
	const mergeFix = async (wt: string, branch: string, what: string) => {
		await commitAll(wt, what);
		git(target, ["merge", "-q", "--ff-only", branch]);
		return git(target, ["rev-parse", "HEAD"]);
	};
	const jobs = (worker: TidyWorker | false, areaBusy = () => false) => createTidyJobs({ config, root, ledger, adapters: new Map([["fake", adapter]]), log: () => {}, linkAll: () => {}, mergeFix, areaBusy, worker });
	return { target, ledger, jobs };
}

/** The faked model: moves the file; `fixTest` = it also updates the test's import. */
const mover =
	(fixTest: boolean): TidyWorker =>
	async ({ dir }) => {
		mkdirSync(join(dir, "src", "B"), { recursive: true });
		renameSync(join(dir, "src", "A", "Old.txt"), join(dir, "src", "B", "New.txt"));
		if (fixTest) writeFileSync(join(dir, "src", "A", "Old.test.txt"), "import src/B/New.txt\nexpects Old\n");
		return "moved Old to B/New";
	};

describe("the tidy job", () => {
	it("moves the file and updates the test that imports it; green is merged and the task is done", async () => {
		const { target, ledger, jobs } = (await setup());
		const j = jobs(mover(true));
		expect(j.holds("fake", "a")).toBe(true); // units of the area wait
		j.next();
		await j.busy;
		expect(tidyTasks(ledger)[0]!.status).toBe("done");
		expect(existsSync(join(target, "src", "A", "Old.txt"))).toBe(false);
		expect(existsSync(join(target, "src", "B", "New.txt"))).toBe(true);
		expect(readFileSync(join(target, "src", "A", "Old.test.txt"), "utf8")).toMatch(/^import src\/B\/New\.txt/);
		expect(git(target, ["log", "-1", "--format=%s"])).toMatch(/tidy T7 move/);
		expect(j.holds("fake", "a")).toBe(false);
		// runs once: nothing left to start
		j.next();
		expect(j.busy).toBeUndefined();
	});

	it("a reference left behind makes the build red: the change is thrown away and the task is failed", async () => {
		const { target, ledger, jobs } = (await setup());
		const j = jobs(mover(false));
		j.next();
		await j.busy;
		const t = tidyTasks(ledger)[0]!;
		expect(t.status).toBe("failed");
		expect(t.failure).toMatch(/\(build\)/);
		// main is as it was
		expect(existsSync(join(target, "src", "A", "Old.txt"))).toBe(true);
		expect(existsSync(join(target, "src", "B", "New.txt"))).toBe(false);
		expect(git(target, ["status", "--porcelain"])).toBe("");
		expect(j.holds("fake", "a")).toBe(false); // units are not blocked
	});

	it("main red already: its errors are not the task's, only error lines main does not have fail it", async () => {
		const { target, ledger, jobs } = (await setup());
		mkdirSync(join(target, "src", "Z"), { recursive: true });
		writeFileSync(join(target, "src", "Z", "Broken.txt"), "import src/Z/Missing.txt\n");
		await commitAll(target, "main is red");
		const j = jobs(mover(true));
		j.next();
		await j.busy;
		expect(tidyTasks(ledger)[0]!.status).toBe("done");
		expect(existsSync(join(target, "src", "B", "New.txt"))).toBe(true);
		// a reference left behind is an error main does not have
		ledger.setMeta("tidy_tasks", JSON.stringify([{ ...tidyTasks(ledger)[0]!, id: "T9", from: ["src/B/New.txt"], to: ["src/C/New.txt"], status: "approved" }]));
		const k = jobs(async ({ dir }) => (mkdirSync(join(dir, "src", "C"), { recursive: true }), renameSync(join(dir, "src", "B", "New.txt"), join(dir, "src", "C", "New.txt")), "moved"));
		k.next();
		await k.busy;
		const t = tidyTasks(ledger)[0]!;
		expect(t.status).toBe("failed");
		expect(t.failure).toMatch(/1 error line\(s\) main does not have:\nsrc\/A\/Old\.test\.txt: cannot find src\/B\/New\.txt$/);
	});

	it("a move to a path the layout check refuses is failed like the gate would, before any build; files touched only for imports are not checked", async () => {
		const seen: string[][] = [];
		const { target, ledger, jobs } = (await setup((_dir, only) => (seen.push(only ?? []), (only ?? []).filter((f) => f.startsWith("src/B/")).map((f) => `${f}: not an allowed file in the feature folder`))));
		const j = jobs(mover(true));
		j.next();
		await j.busy;
		const t = tidyTasks(ledger)[0]!;
		expect(t.status).toBe("failed");
		expect(t.failure).toMatch(/the layout check failed: src\/B\/New\.txt: not an allowed file/);
		expect(t.failure).not.toMatch(/\(build\)/);
		expect(seen).toEqual([["src/B/New.txt"]]); // the test changed only for its import is not the task's target
		expect(existsSync(join(target, "src", "A", "Old.txt"))).toBe(true);
	});

	it("a delete of a note: done when the note is gone; deleting more than the task names fails", async () => {
		const { target, ledger, jobs } = (await setup());
		writeFileSync(join(target, "src", "A", "README.md"), "notes for other units\n");
		writeFileSync(join(target, "src", "A", "Old.test.txt"), "expects Old\n"); // main builds green
		await commitAll(target, "note");
		const del: TidyTask = { id: "T8", stack: "fake", area: "a", op: "delete", from: ["src/A/README.md"], to: [], why: "a handoff note, not code", questionId: 8, status: "approved" };
		ledger.setMeta("tidy_tasks", JSON.stringify([del]));
		const greedy = jobs(async ({ dir }) => (rmSync(join(dir, "src", "A", "README.md")), rmSync(join(dir, "src", "A", "Old.test.txt")), "deleted the note"));
		greedy.next();
		await greedy.busy;
		expect(tidyTasks(ledger)[0]).toMatchObject({ status: "failed", failure: expect.stringMatching(/more was deleted than the task names: src\/A\/Old\.test\.txt/) });
		ledger.setMeta("tidy_tasks", JSON.stringify([del]));
		const j = jobs(async ({ dir }) => (rmSync(join(dir, "src", "A", "README.md")), "deleted the note"));
		j.next();
		await j.busy;
		expect(tidyTasks(ledger)[0]!.status).toBe("done");
		expect(existsSync(join(target, "src", "A", "README.md"))).toBe(false);
		expect(existsSync(join(target, "src", "A", "Old.test.txt"))).toBe(true);
	});

	it("a move the model did not finish is failed by code before any build", async () => {
		const { ledger, jobs } = (await setup());
		const j = jobs(async () => "did nothing");
		j.next();
		await j.busy;
		expect(tidyTasks(ledger)[0]!.failure).toMatch(/src\/A\/Old\.txt still exists; src\/B\/New\.txt is missing/);
	});

	it("a worktree that cannot be made fails the task instead of holding its area back", async () => {
		const { ledger, jobs } = (await setup());
		const bad = { ...tidyTasks(ledger)[0]!, id: "T..7" }; // not a valid branch name: git worktree add fails
		ledger.setMeta("tidy_tasks", JSON.stringify([bad]));
		const j = jobs(mover(true));
		j.next();
		await j.busy;
		expect(tidyTasks(ledger)[0]!.status).toBe("failed");
		expect(j.holds("fake", "a")).toBe(false);
	});

	it("a unit merged into main while the job ran is checked too: its use of the old path makes the job red", async () => {
		const { target, ledger, jobs } = (await setup());
		const j = jobs(async (o) => {
			const said = await mover(true)(o);
			mkdirSync(join(target, "src", "C"), { recursive: true });
			writeFileSync(join(target, "src", "C", "Use.txt"), "uses src/A/Old.txt\n");
			await commitAll(target, "a unit merged meanwhile");
			return said;
		});
		j.next();
		await j.busy;
		const t = tidyTasks(ledger)[0]!;
		expect(t.status).toBe("failed");
		expect(t.failure).toMatch(/\(build\)/);
		expect(existsSync(join(target, "src", "A", "Old.txt"))).toBe(true);
	});

	it("a task whose question was withdrawn is dropped, not left asked forever", async () => {
		const { ledger } = (await setup());
		const id = ledger.askQuestion({ point: "tidy", question: "move?", askedBy: "tidy" });
		ledger.setMeta("tidy_tasks", JSON.stringify([{ ...tidyTasks(ledger)[0]!, questionId: id, status: "asked" }]));
		ledger.withdrawQuestion(id, "gone");
		expect(tidyTasks(ledger)).toEqual([]);
	});

	it("waits while a unit of the area runs; without a tidy job no unit is held back", async () => {
		const { ledger, jobs } = (await setup());
		let calls = 0;
		const j = jobs(async () => (calls++, ""), () => true);
		j.next();
		expect(j.busy).toBeUndefined();
		expect(calls).toBe(0);
		expect(tidyTasks(ledger)[0]!.status).toBe("approved");
		expect(jobs(false).holds("fake", "a")).toBe(false);
	});

	it("a move that keeps the app from starting fails on the app's boot check, though the build and the changed tests pass", async () => {
		// the app loads every source file its config lists (a service folder scan); the build checks nothing
		const boot = { cmd: "sh", args: ["-c", 'for f in $(find src -name "*.txt" ! -name "*.test.txt"); do grep -qx "$f" app.txt || { echo "app cannot load $f"; exit 1; }; done'] };
		const { target, ledger, jobs } = await setup(undefined, { files: { "app.txt": "src/A/Old.txt\n" }, adapter: (a) => ({ ...a, build: () => ({ cmd: "true", args: [] }), boot: () => boot }) as TargetAdapter });
		const j = jobs(mover(true));
		j.next();
		await j.busy;
		const t = tidyTasks(ledger)[0]!;
		expect(t.status).toBe("failed");
		expect(t.failure).toMatch(/\(boot\)\napp cannot load src\/B\/New\.txt/);
		expect(existsSync(join(target, "src", "A", "Old.txt"))).toBe(true);
	});

	it("a move also runs the area's ported tests, not only the changed ones", async () => {
		// another unit's test of the area uses the old path; nothing changed it, so only the area's tests find it
		const { target, ledger, jobs } = await setup(undefined, {
			files: { "src/A/Area.test.txt": "import src/A/Old.txt\n" },
			adapter: (a) => ({ ...a, build: () => ({ cmd: "true", args: [] }), layout: { ...a.layout, moduleDir: () => "src/A", testFileGlobs: (m: string) => [`${m}/**/*.test.txt`] } }) as unknown as TargetAdapter,
		});
		const j = jobs(mover(true));
		j.next();
		await j.busy;
		const t = tidyTasks(ledger)[0]!;
		expect(t.status).toBe("failed");
		expect(t.failure).toMatch(/\(test\)/);
		expect(existsSync(join(target, "src", "A", "Old.txt"))).toBe(true);
	});
});
