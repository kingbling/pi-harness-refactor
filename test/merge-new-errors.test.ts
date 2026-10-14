import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { nestjsAdapter } from "../src/adapters/target/nestjs.ts";
import type { TargetAdapter } from "../src/adapters/types.ts";
import { ConfigSchema } from "../src/config.ts";
import { commitAll, ensureRepo } from "../src/git.ts";
import { Ledger } from "../src/ledger/db.ts";
import { createBuilder, createMergeCheck, filesNamed, MAX_BUILD_CODE_JOBS, newErrorLines } from "../src/run/builder.ts";
import { runCodeJob } from "../src/run/code-job.ts";
import { runGate, sha1 } from "../src/run/gate.ts";
import { checkMyCodeTool } from "../src/sessions/tools.ts";

/**
 * A red main is no free pass: a merge (and the builder's code job) is judged by its error lines against main's, so a
 * unit cannot add errors to a step main already fails, and a job that fixes part of a red main is merged.
 */
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// the whole-project type check: prints src/errs.txt (one error per line) and fails when it has any
async function setup(errs: string) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "br-new-errors-")));
	const target = join(root, "new");
	mkdirSync(join(target, "src"), { recursive: true });
	writeFileSync(join(target, "src", "errs.txt"), errs);
	await ensureRepo(target, "migration/main", []);
	await commitAll(target, "init");
	const config = ConfigSchema.parse({ source: { path: root, stack: "php" }, target: { path: target, stacks: ["fake"], git: { branch: "migration/main" } }, models: {} });
	const tested = join(root, "tested");
	writeFileSync(tested, "");
	const adapter = {
		id: "fake",
		protectedGlobs: [],
		toolchain: { ignoredPaths: [] },
		generatedFiles: [],
		layout: { moduleDir: (x: string) => `src/features/${x}`, sharedDirs: ["src/shared/"], ignoreDirs: [], isTestFile: (p: string) => p.includes(".test."), sourceExtensions: [".txt"], wiringFiles: [], suppressMarker: /@ts-ignore/ },
		build: () => ({ cmd: "sh", args: ["-c", "cat src/errs.txt; ! test -s src/errs.txt"] }),
		lint: (_r: string, files: string[]) => ({ cmd: "true", args: files }),
		test: (_r: string, files: string[]) => ({ cmd: "sh", args: ["-c", `echo "$@" >> ${tested}`, "sh", ...files] }),
	} as unknown as TargetAdapter;
	const unit = async (name: string, content: string, commit = true) => {
		const wt = join(root, "wt", name);
		git(target, ["worktree", "add", "-q", "-b", `unit/${name}`, wt]);
		writeFileSync(join(wt, "src", "errs.txt"), content);
		if (commit) await commitAll(wt, name);
		return wt;
	};
	return { root, target, config, adapter, unit, tested: () => readFileSync(tested, "utf8") };
}

describe("error lines against main's", () => {
	it("are new only when main does not have them; line numbers and the run dir do not count", () => {
		const main = "src/a.ts(3,5): error TS2741: Property 'x' is missing\nFound 1 error.";
		expect(newErrorLines("src/a.ts(9,1): error TS2741: Property 'x' is missing\nFound 1 error.", "/wt", main, "/main")).toEqual([]);
		expect(newErrorLines("src/a.ts(3,5): error TS2741: Property 'x' is missing\nsrc/b.ts(1,1): error TS2741: Property 'x' is missing\nFound 2 errors.", "/wt", main, "/main")).toEqual(["src/b.ts(1,1): error TS2741: Property 'x' is missing", "Found 2 errors."]);
		// eslint names the file once, above its errors, with the absolute path of the dir it ran in
		const lint = (dir: string, file: string) => `${dir}/${file}\n  3:1  error  'x' is unused  no-unused-vars`;
		expect(newErrorLines(lint("/wt", "src/a.ts"), "/wt", lint("/main", "src/a.ts"), "/main")).toEqual([]);
		expect(newErrorLines(lint("/wt", "src/b.ts"), "/wt", lint("/main", "src/a.ts"), "/main")).toHaveLength(2);
	});

	it("name the files of an output relative to where it ran, not the echoed command", () => {
		expect(filesNamed("$ tsc -p x.ts\nsrc/a.test.ts(3,5): error TS1\n/wt/p/src/b.ts\n  1:1 error", "/wt/p", [".ts"]).sort()).toEqual(["src/a.test.ts", "src/b.ts"]);
	});
});

describe("the merge check on a red main", () => {
	const MAIN = "src/a.ts(1,1): error TS2741: missing x\n";
	it("refuses a merge that adds an error, with only the new line", async () => {
		const s = await setup(MAIN);
		const check = createMergeCheck({ config: s.config, adapters: new Map([["fake", s.adapter]]) });
		const out = await check("fake", (await s.unit("u1", `${MAIN}src/b.ts(2,2): error TS2741: missing y\n`)));
		expect(out).toMatch(/main fails it too, these 1 error line\(s\) are new:\nsrc\/b\.ts\(2,2\): error TS2741: missing y/);
		expect(out).not.toMatch(/a\.ts/);
	});

	it("lets a merge land that only moves or removes main's errors", async () => {
		const s = await setup(MAIN);
		const check = createMergeCheck({ config: s.config, adapters: new Map([["fake", s.adapter]]) });
		expect(await check("fake", (await s.unit("u1", "src/a.ts(7,3): error TS2741: missing x\n")))).toBeUndefined();
	});

	it("draft: checks the implementer's uncommitted code (check_my_code), with the errors main does not have", async () => {
		const s = await setup(MAIN);
		const check = createMergeCheck({ config: s.config, adapters: new Map([["fake", s.adapter]]) });
		const wt = await s.unit("u1", `${MAIN}src/b.ts(2,2): error TS1: new\n`, false);
		const tool = checkMyCodeTool({ ledger: undefined as never, config: undefined as never, unitId: "u1", root: wt, targetProjectDir: wt, adapter: { ...s.adapter, layout: { ...s.adapter.layout, lang: () => undefined } } as never, wholeCheck: async () => (await check("fake", wt, true)) });
		const r = await (tool as unknown as { execute: (i: string, p: object) => Promise<{ content: Array<{ text: string }>; details: any }> }).execute("x", {});
		expect(r.details).toMatchObject({ ok: false, failed: "whole" });
		expect(r.content[0]!.text).toMatch(/WHOLE-PROJECT check FAILED[\s\S]*src\/b\.ts\(2,2\): error TS1: new/);
	});
});

describe("the builder's code job on a red main", () => {
	const MAIN = "src/a.ts(1,1): error TS1: one\nsrc/a.ts(2,1): error TS1: two\n";
	async function job(fix: (dir: string) => void) {
		const s = await setup(MAIN);
		let merged = false;
		const said = await runCodeJob({
			config: s.config,
			root: s.root,
			ledger: new Ledger(":memory:"),
			adapter: s.adapter,
			what: "make the whole project pass",
			label: "build-fake-1",
			linkAll: () => {},
			mergeFix: async () => ((merged = true), undefined),
			log: () => {},
			whole: true,
			worker: async ({ dir }) => (fix(dir), "fixed one"),
		});
		return { said, merged, s };
	}

	it("merges a fix of part of main's errors that adds none", async () => {
		expect((await job((d) => writeFileSync(join(d, "src", "errs.txt"), "src/a.ts(1,1): error TS1: one\n"))).merged).toBe(true);
	});

	it("does not merge one that adds an error while fixing another", async () => {
		expect((await job((d) => writeFileSync(join(d, "src", "errs.txt"), "src/a.ts(1,1): error TS1: one\nsrc/c.ts(1,1): error TS1: three\n"))).merged).toBe(false);
	});

	it("does not merge a silenced check", async () => {
		expect((await job((d) => writeFileSync(join(d, "src", "errs.txt"), "// @ts-ignore\n"))).merged).toBe(false);
	});

	it("runs the accepted tests that import the changed code", async () => {
		const s = await setup("src/a.ts(1,1): error TS1: one\n");
		mkdirSync(join(s.target, "src", "other"), { recursive: true });
		writeFileSync(join(s.target, "src", "errs.test.txt"), "import x from './errs'\n");
		writeFileSync(join(s.target, "src", "other", "none.test.txt"), "import y from './none'\n");
		await commitAll(s.target, "tests");
		await runCodeJob({ config: s.config, root: s.root, ledger: new Ledger(":memory:"), adapter: s.adapter, what: "w", label: "build-fake-2", linkAll: () => {}, mergeFix: async () => undefined, log: () => {}, whole: true, worker: async ({ dir }) => (writeFileSync(join(dir, "src", "errs.txt"), ""), "x") });
		expect(s.tested()).toMatch(/src\/errs\.test\.txt/);
		expect(s.tested()).not.toMatch(/none\.test/);
	});
});

describe("the builder after a code job that made progress", () => {
	it("keeps sending jobs: only jobs in a row that merged nothing park the stack", async () => {
		const s = await setup("src/a.ts(1,1): error TS1: one\n");
		const ledger = new Ledger(":memory:");
		let n = 0;
		const b = createBuilder({ config: s.config, root: s.root, ledger, adapters: new Map([["fake", s.adapter]]), log: () => {}, linkAll: () => {}, mergeFix: async () => undefined, repair: false, codeJob: async () => (n++, "fewer errors"), every: { units: 1, minutes: 60 } });
		for (let i = 0; i < MAX_BUILD_CODE_JOBS + 2; i++) {
			b.afterMerge("fake");
			await b.finish();
		}
		expect(n).toBe(MAX_BUILD_CODE_JOBS + 2);
	});
});

describe("structure_ok findings a test's import can fix", () => {
	it("are path findings only, not a file's size or classes", async () => {
		const project = realpathSync(mkdtempSync(join(tmpdir(), "br-imported-")));
		const write = (rel: string, body: string) => (mkdirSync(dirname(join(project, rel)), { recursive: true }), writeFileSync(join(project, rel), body));
		write("package.json", JSON.stringify({ dependencies: { "@nestjs/core": "^11" } }));
		const SPEC = "src/features/agency/agency.service.spec.ts";
		write(SPEC, "import { AgencyService } from './agency.service';\nimport { X } from './legacy.ts.php/x';\n");
		write("src/features/agency/agency.service.ts", "export class AgencyService {}\n");
		git(project, ["init", "-q"]);
		git(project, ["add", "-A"]);
		git(project, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
		const ledger = new Ledger(":memory:");
		ledger.createUnit({ id: "u1", tier: "T0", symbolIds: [] });
		const tick = { cmd: "true", args: [] as string[] };
		const adapter = { ...nestjsAdapter, build: () => tick, lint: () => tick, test: () => tick } as TargetAdapter;
		const gate = () => runGate({ ledger, unitId: "u1", adapter, targetProjectDir: project, writeGlobs: ["src/**"], testFiles: [{ path: SPEC, sha1: sha1(readFileSync(join(project, SPEC))) }], moduleDir: "src/features/agency", area: "agency", root: project, stackId: "nestjs" });
		// two service classes in one file: the implementer splits it, the test's import stays
		write("src/features/agency/agency.service.ts", "export class AgencyService {}\nexport class OtherService {}\n");
		let r = await gate();
		expect(r.failedStep).toBe("structure_ok");
		expect(r.testImported).toBeUndefined();
		// a folder the layout does not allow, that the test imports: only the tester can move that import
		git(project, ["checkout", "--", "src/features/agency/agency.service.ts"]);
		write("src/features/agency/legacy.ts.php/x.ts", "export const X = 1;\n");
		r = await gate();
		expect(r.failedStep).toBe("structure_ok");
		expect(r.testImported).toEqual(["src/features/agency/legacy.ts.php/x.ts"]);
	});
});
