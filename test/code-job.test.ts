import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TargetAdapter } from "../src/adapters/types.ts";
import { ConfigSchema } from "../src/config.ts";
import { commitAll, ensureRepo } from "../src/git.ts";
import { Ledger } from "../src/ledger/db.ts";
import { runCodeJob } from "../src/run/code-job.ts";

/** The code job's check: a model may not make it green by deleting the test that was red. */
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

describe("the code job", () => {
	async function job(worker: (dir: string) => string, protectedGlobs: string[] = []) {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "br-code-job-")));
		const target = join(root, "new");
		mkdirSync(join(target, "src"), { recursive: true });
		writeFileSync(join(target, "src", "a.test.txt"), "expects ok\n");
		writeFileSync(join(target, "tsconfig.json"), "{}\n");
		ensureRepo(target, "migration/main", []);
		commitAll(target, "init");
		const config = ConfigSchema.parse({ source: { path: root, stack: "php" }, target: { path: target, stacks: ["fake"], git: { branch: "migration/main" } }, models: {} });
		const adapter = {
			id: "fake",
			protectedGlobs,
			toolchain: { ignoredPaths: [] },
			layout: { isTestFile: (p: string) => p.includes(".test."), sourceExtensions: [".txt"] },
			build: () => ({ cmd: "true", args: [] }),
			test: () => ({ cmd: "true", args: [] }),
		} as unknown as TargetAdapter;
		let merged = false;
		const said = await runCodeJob({
			config,
			root,
			ledger: new Ledger(":memory:"),
			adapter,
			what: "make the test pass",
			label: "q1",
			linkAll: () => {},
			mergeFix: async () => ((merged = true), undefined),
			log: () => {},
			worker: async ({ dir }) => worker(dir),
		});
		return { said, merged, target };
	}

	it("a deleted test fails the check: nothing is merged", async () => {
		const { said, merged, target } = await job((dir) => (rmSync(join(dir, "src", "a.test.txt")), "removed the failing test"));
		expect(said).toBeUndefined();
		expect(merged).toBe(false);
		expect(existsSync(join(target, "src", "a.test.txt"))).toBe(true);
		expect(git(target, ["status", "--porcelain"])).toBe("");
	});

	const code = (dir: string) => (writeFileSync(join(dir, "src", "b.txt"), "code\n"), writeFileSync(join(dir, "src", "b.test.txt"), "test\n"));
	it("changed protected config fails the check: it holds the checks", async () => {
		const r = await job((dir) => (code(dir), writeFileSync(join(dir, "tsconfig.json"), '{"strict":false}\n'), "added b"), ["**/tsconfig*.json"]);
		expect(r.merged).toBe(false);
	});
	it("no code at all fails the check: the job was to write code", async () => {
		const r = await job((dir) => (writeFileSync(join(dir, "notes.md"), "todo\n"), "wrote notes"));
		expect(r.merged).toBe(false);
	});
	it("code with its test is merged", async () => {
		const r = await job((dir) => (code(dir), "added b"), ["**/tsconfig*.json"]);
		expect(r.merged).toBe(true);
	});
});
