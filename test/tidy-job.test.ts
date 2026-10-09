import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
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

function setup() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "br-tidy-job-")));
	const target = join(root, "new");
	mkdirSync(join(target, "src", "A"), { recursive: true });
	writeFileSync(join(target, "src", "A", "Old.txt"), "class Old\n");
	// an earlier unit's test imports the old path
	writeFileSync(join(target, "src", "A", "Old.test.txt"), "import src/A/Old.txt\nexpects Old\n");
	ensureRepo(target, "migration/main", []);
	commitAll(target, "init");
	const config = ConfigSchema.parse({ source: { path: root, stack: "php" }, target: { path: target, stacks: ["fake"], git: { branch: "migration/main" } }, models: {} });
	const adapter = {
		id: "fake",
		protectedGlobs: [],
		toolchain: { ignoredPaths: [] },
		layout: { isTestFile: (p: string) => p.includes(".test."), sourceExtensions: [".txt"] },
		// the whole-project build (it cannot take files): red while anything still points at the old path
		build: () => ({ cmd: "sh", args: ["-c", "! grep -rq 'src/A/Old.txt' src"] }),
		lint: (_r: string, files: string[]) => ({ cmd: "true", args: files }),
		// a test passes when its import resolves
		test: (_r: string, files: string[]) => ({ cmd: "sh", args: ["-c", 'for f in "$@"; do i=$(head -1 "$f" | cut -d" " -f2); test -f "$i" || exit 1; done', "sh", ...files] }),
	} as unknown as TargetAdapter;
	const ledger = new Ledger(":memory:");
	const task: TidyTask = { id: "T7", stack: "fake", area: "a", op: "move", from: ["src/A/Old.txt"], to: ["src/B/New.txt"], why: "B is where it belongs", questionId: 7, status: "approved" };
	ledger.setMeta("tidy_tasks", JSON.stringify([task]));
	const mergeFix = async (wt: string, branch: string, what: string) => {
		commitAll(wt, what);
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
		const { target, ledger, jobs } = setup();
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
		const { target, ledger, jobs } = setup();
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

	it("a move the model did not finish is failed by code before any build", async () => {
		const { ledger, jobs } = setup();
		const j = jobs(async () => "did nothing");
		j.next();
		await j.busy;
		expect(tidyTasks(ledger)[0]!.failure).toMatch(/src\/A\/Old\.txt still exists; src\/B\/New\.txt is missing/);
	});

	it("waits while a unit of the area runs; without a tidy job no unit is held back", async () => {
		const { ledger, jobs } = setup();
		let calls = 0;
		const j = jobs(async () => (calls++, ""), () => true);
		j.next();
		expect(j.busy).toBeUndefined();
		expect(calls).toBe(0);
		expect(tidyTasks(ledger)[0]!.status).toBe("approved");
		expect(jobs(false).holds("fake", "a")).toBe(false);
	});
});
