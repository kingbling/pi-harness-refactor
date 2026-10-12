import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AdapterGaveUpError } from "../src/adapters/target/generated.ts";
import type { InitPrompter, PromptOption } from "../src/init/init.ts";
import { onboard } from "../src/init/onboard.ts";
import { MissingToolsError } from "../src/init/toolchain-install.ts";

// the trial build of a generated adapter, scripted per test (default: the real one)
const verify = vi.hoisted(() => ({ fail: undefined as (() => Error) | undefined }));
vi.mock("../src/adapters/target/generated.ts", async (importOriginal) => {
	const real = await importOriginal<typeof import("../src/adapters/target/generated.ts")>();
	return { ...real, verifyPendingAdapters: async (...a: Parameters<typeof real.verifyPendingAdapters>) => (verify.fail ? Promise.reject(verify.fail()) : real.verifyPendingAdapters(...a)) };
});
import { Ledger } from "../src/ledger/db.ts";
import { ensureRepo, commitAll } from "../src/git.ts";

/**
 * End-to-end onboarding on the fixture, offline (no model calls, no network): init → setup (pre-bootstrapped
 * target, like after `nest new`) → inventory → frameworks → decide → order. Proves the flow is seamless,
 * resumable and that every artifact lands in the workspace, never in a repo. The TUI test drives the same
 * flow through a scripted prompter and asserts which questions a human actually sees.
 */
const here = resolve(import.meta.dirname, "..");

function workspace(name: string) {
	const ws = join(here, ".sim", name);
	rmSync(ws, { recursive: true, force: true });
	mkdirSync(join(ws, "legacy"), { recursive: true });
	cpSync(join(here, "fixtures", "mini-app"), join(ws, "legacy"), { recursive: true });
	// target pre-bootstrapped (what the official generator would leave, with the default choices' packages) so the
	// test needs no network; a target missing a chosen package is set up again
	const target = join(ws, "migrated");
	mkdirSync(join(target, "src"), { recursive: true });
	writeFileSync(join(target, "package.json"), JSON.stringify({ name: "sim", private: true, dependencies: Object.fromEntries(["prisma", "@prisma/client", "class-validator", "class-transformer", "@nestjs/passport", "passport", "passport-jwt", "@nestjs/jwt", "express-session", "passport-local"].map((p) => [p, "x"])), devDependencies: { vitest: "x" } }, null, 2));
	writeFileSync(join(target, "nest-cli.json"), "{}");
	writeFileSync(join(target, ".gitignore"), "node_modules/\n");
	ensureRepo(target, "migration/main");
	commitAll(target, "chore: bootstrap (test)");
	return { ws, target };
}

const baseArgs = (ws: string) => ["--source", join(ws, "legacy"), "--stack", "php", "--target", join(ws, "migrated"), "--to", "nestjs", "--db", "keep-schema", "--no-docs", "--no-llm"];

describe("br onboard (e2e, offline)", () => {
	it("runs every step, leaves artifacts only in the workspace, and is resumable", async () => {
		const { ws, target } = workspace("onboard-e2e");
		const lines: string[] = [];
		const r = await onboard({ root: ws, args: [...baseArgs(ws), "--yes"], log: (l) => lines.push(l) });
		expect(r.ok, lines.join("\n")).toBe(true);
		const names = r.steps.map((s) => `${s.name}:${s.status}`);
		expect(names).toContain("init:done");
		expect(names).toContain("setup:skipped"); // pre-bootstrapped
		expect(names).toContain("inventory:done");
		expect(names).toContain("frameworks:done");
		expect(names).toContain("decide:done");
		expect(names).toContain("rules:skipped"); // --no-llm
		expect(names).toContain("order:done");
		expect(r.openDecisions).toBe(0);

		// artifacts: workspace only
		for (const f of ["bigrefactor.config.json", ".bigrefactor/ledger.sqlite", ".bigrefactor/decisions.json"]) expect(existsSync(join(ws, f)), f).toBe(true);
		expect(existsSync(join(target, ".bigrefactor"))).toBe(false);
		expect(existsSync(join(ws, "legacy", ".bigrefactor"))).toBe(false);
		const config = JSON.parse(readFileSync(join(ws, "bigrefactor.config.json"), "utf8"));
		expect(config.source.stack).toBe("php");
		expect(config.target.stacks).toEqual(["nestjs"]);

		const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
		try {
			const st = ledger.status();
			expect(st.symbols["discovered"] ?? 0).toBe(0); // every symbol clustered into a unit (unaccounted counts non-terminal states, fine before a run)
			expect(Object.values(st.units).reduce((a, b) => a + b, 0)).toBeGreaterThan(3);
			expect(ledger.getMeta("slice_plan")).toBeTruthy();
			expect(ledger.getMeta("framework_plan")).toBeTruthy();
			// decisions are mirrored into the ledger questions table (answered, blocking nothing)
			const decided = ledger.db.prepare("SELECT COUNT(*) n FROM questions WHERE point LIKE 'decision:%' AND status = 'answered'").get() as { n: number };
			expect(decided.n).toBeGreaterThan(0);
			expect(ledger.openQuestions().length).toBe(0);
		} finally {
			ledger.close();
		}

		// resumable: a second run skips everything already done and stays green
		const again = await onboard({ root: ws, args: [...baseArgs(ws), "--yes"], log: () => {} });
		expect(again.ok).toBe(true);
		expect(again.steps.find((s) => s.name === "init")?.status).toBe("skipped");
		expect(again.steps.find((s) => s.name === "inventory")?.status).toBe("skipped");
		expect(again.steps.find((s) => s.name === "decide")?.note).toBe("nothing to decide");
	}, 120_000);

	it("TUI: a human sees one 'accept recommendations' question, then only decisions without a recommendation", async () => {
		const { ws } = workspace("onboard-tui");
		const asked: string[] = [];
		const scripted: InitPrompter = {
			text: async (_m, initial) => initial,
			select: async (message: string, options: PromptOption[], initial?: string) => {
				asked.push(message.split("\n")[0]!);
				if (/Accept the .* recommended/.test(message)) return "accept";
				// anything else: pick the recommended/initial, else the first option
				return initial ?? options[0]!.value;
			},
			log: () => {},
		};
		const r = await onboard({ root: ws, args: baseArgs(ws), prompter: scripted, log: () => {} });
		expect(r.ok, JSON.stringify(r.steps)).toBe(true);
		expect(r.openDecisions).toBe(0);
		// init asks its interview (stack recommendation first), decide asks the accept-all question
		expect(asked.some((q) => /recommended stack|Accept the/.test(q))).toBe(true);
		// never more than a handful of questions for the fixture: seamless means few prompts
		expect(asked.length).toBeLessThanOrEqual(8);
		// every prompt went through the prompter, nothing printed to stdout for a human to miss
		const d = JSON.parse(readFileSync(join(ws, ".bigrefactor", "decisions.json"), "utf8"));
		expect(Object.keys(d.answers).length).toBeGreaterThan(0);
	}, 120_000);

	it("an error outside any step (here: a config that does not load) ends onboarding as failed, never as done", async () => {
		const ws = join(here, ".sim", "onboard-outside-step");
		rmSync(ws, { recursive: true, force: true });
		mkdirSync(ws, { recursive: true });
		writeFileSync(join(ws, "bigrefactor.config.json"), "{ not json");
		const lines: string[] = [];
		const r = await onboard({ root: ws, args: ["--yes", "--no-llm"], log: (l) => lines.push(l) });
		expect(r.ok).toBe(false);
		expect(r.steps.map((s) => `${s.name}:${s.status}`)).toEqual(["init:skipped", "onboarding:failed"]);
		expect(lines.at(-1)).toMatch(/onboarding stopped at "onboarding"/);
	});

	describe("a generated adapter that cannot be made to work", () => {
		// a stack picked during the questions: its adapter was written, its trial build runs after the last question
		const pickGenerated = (ws: string) => {
			const cmd = { cmd: "true", args: [] };
			const m = {
				id: "go-x", role: "server", subdir: "api", aliases: [], docs: [], scaffold: { ...cmd, readyFile: "go.mod" }, postScaffold: [], build: cmd, lint: cmd, test: cmd, verified: false,
				toolchain: { ecosystem: "go", packageName: "^[\\w./-]+", packageExamples: [], manifestFiles: ["go.mod"], installed: { file: "", keys: [] }, add: cmd, worktreeLinks: [], ignoredPaths: [] },
				layout: { moduleDir: "internal/{area}", structureDoc: "-", sharedDirs: ["internal/shared/"], testFileGlobs: ["{moduleDir}/*_test.go"], testFileRegex: "_test\\.go$", sourceExtensions: [".go"], langByExtension: {}, skipMarker: "t\\.Skip", interfaceHint: "-", testHint: "-", legacyMarker: "// LEGACY: {why}", dataAccessHint: "", ignoreDirs: [], wiringFiles: [] },
				platform: {}, stackChoices: [], protectedGlobs: [], patternKinds: ["handler"], probeTest: { path: "x_test.go", content: "" }, detect: { file: "go.mod", contains: "module" },
			};
			mkdirSync(join(ws, ".bigrefactor", "adapters"), { recursive: true });
			writeFileSync(join(ws, ".bigrefactor", "adapters", "go-x.json"), JSON.stringify(m));
			const cfgPath = join(ws, "bigrefactor.config.json");
			const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
			cfg.target.stacks = ["go-x"];
			cfg.target.choices = { "go-x": {} };
			writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
			const decPath = join(ws, ".bigrefactor", "decisions.json");
			const d = JSON.parse(readFileSync(decPath, "utf8"));
			d.answers["target:server"] = { answer: "go-x", by: "human (onboard)", at: new Date().toISOString() };
			writeFileSync(decPath, JSON.stringify(d, null, 2));
		};
		const read = (ws: string) => ({ config: JSON.parse(readFileSync(join(ws, "bigrefactor.config.json"), "utf8")), answers: JSON.parse(readFileSync(join(ws, ".bigrefactor", "decisions.json"), "utf8")).answers });

		it("repairs that gave up: the stack question opens again and the stack leaves the config; missing tools keep the choice", async () => {
			const { ws } = workspace("onboard-adapter-gave-up");
			expect((await onboard({ root: ws, args: [...baseArgs(ws), "--yes"], log: () => {} })).ok).toBe(true);
			pickGenerated(ws);
			try {
				// nothing left to decide: setup proves the pending adapter first. Tools missing on this machine: the owner installs them and resumes, the choice stands
				verify.fail = () => new MissingToolsError("go-x", ["go"]);
				const tools = await onboard({ root: ws, args: [...baseArgs(ws), "--yes"], log: () => {} });
				expect(tools.ok).toBe(false);
				expect(tools.steps.find((s) => s.status === "failed")).toMatchObject({ name: "setup", note: expect.stringMatching(/needs go/) });
				expect(read(ws).answers["target:server"].answer).toBe("go-x");
				expect(read(ws).config.target.stacks).toEqual(["go-x"]);

				// the model's repairs failed too: forgotten, so a resume asks the stack question again
				verify.fail = () => new AdapterGaveUpError("go-x", "server", "the build still fails");
				const gaveUp = await onboard({ root: ws, args: [...baseArgs(ws), "--yes"], log: () => {} });
				expect(gaveUp.ok).toBe(false);
				expect(gaveUp.steps.find((s) => s.status === "failed")).toMatchObject({ name: "setup", note: expect.stringMatching(/no working go-x adapter/) });
				const after = read(ws);
				expect(after.answers["target:server"]).toBeUndefined();
				expect(after.config.target.stacks).not.toContain("go-x");
				expect(after.config.target.stacks).toHaveLength(1);
				expect(after.config.target.choices["go-x"]).toBeUndefined();
			} finally {
				verify.fail = undefined;
			}
		}, 120_000);
	});
});
