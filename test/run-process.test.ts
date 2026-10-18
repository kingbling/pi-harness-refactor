import { execFileSync, fork } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getSourceAdapter, getTargetAdapter } from "../src/adapters/registry.ts";
import { ConfigSchema } from "../src/config.ts";
import { applyDecision } from "../src/inventory/decisions.ts";
import { inventory } from "../src/inventory/run.ts";
import { Ledger } from "../src/ledger/db.ts";
import { detachRunProcess, liveRunProcess, runInChild, type Ask } from "../src/pi/run-process.ts";
import { progress, type ProgressSnapshot } from "../src/progress.ts";
import { decisionGate } from "../src/run/decisions-gate.ts";

/**
 * Pi's migration run lives in its own process: Pi's thread only draws. The child's progress arrives here as
 * snapshots, /br stop reaches it, its open decisions come here as dialogs and the answers go back, it reports done.
 */
const here = resolve(import.meta.dirname, "..");
const ws = join(here, ".sim", "run-process");
const fake = join(here, "test", "fake-run-scheduler.ts");

const until = async (what: string, ok: () => boolean, ms = 20_000) => {
	const t = Date.now();
	while (!ok()) {
		if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 50));
	}
};

/** The decisions-during-run workspace: framework decisions left open for the run to ask. */
async function makeWorkspace(ws: string, run: Record<string, unknown> = {}) {
	rmSync(ws, { recursive: true, force: true });
	mkdirSync(join(ws, "legacy", "myfw"), { recursive: true });
	cpSync(join(here, "fixtures", "mini-app"), join(ws, "legacy"), { recursive: true });
	writeFileSync(join(ws, "legacy", "myfw", "registry.php"), "<?php\nclass Registry { public static function get($k) { return null; } }\n");
	writeFileSync(join(ws, "legacy", "src", "uses_registry.php"), `<?php\nfunction uses_registry() {\nRegistry::get('k');\n}\n`);
	writeFileSync(join(ws, "legacy", "index.php"), `<?php\nrequire 'src/uses_registry.php';\nuses_registry();\n`);
	mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
	writeFileSync(join(ws, ".bigrefactor", "framework-profile.json"), JSON.stringify({ id: "myfw", frameworkDirs: ["myfw/"], loaders: [], concerns: [] }));
	const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, models: {}, run });
	writeFileSync(join(ws, "bigrefactor.config.json"), JSON.stringify(config, null, 2));
	process.env["BR_WORKSPACE"] = ws;
	const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
	await inventory(config, ws, ledger);
	const source = getSourceAdapter("php");
	const targets = [await getTargetAdapter("nestjs")];
	for (const d of (await decisionGate(ledger, config, source, targets, ws)).global) applyDecision(ledger, config, ws, d.id, d.recommended!, "test");
	ledger.close();
}

describe("migration run in its own process", () => {
	beforeAll(() => makeWorkspace(ws), 60_000);
	afterEach(() => {
		delete process.env["BR_RUN_CHILD_SCHEDULER"];
		delete process.env["BR_FAKE_CRASH"];
		delete process.env["BR_FAKE_HANG"];
		delete process.env["BR_FAKE_FREEZE"];
		if (progress.running) progress.end();
	});

	it("mirrors progress, asks decisions here, honours stop and reports done", async () => {
		process.env["BR_RUN_CHILD_SCHEDULER"] = fake;
		const snaps: ProgressSnapshot[] = [];
		const unsub = progress.subscribe((s) => snaps.push(structuredClone(s)));
		progress.begin("migration run");
		const asked: Ask[] = [];
		let decisionsDone = false;
		const run = runInChild({ cwd: ws, flags: [], hasUI: true, job: "migration run" }, { ask: async (q) => (asked.push(q), q.recommended ?? q.options[0]!.value), decisionsDone: () => (decisionsDone = true) });
		// the child's state shows here: its unit step and its lanes
		await until("the unit step", () => progress.snapshot().steps.some((s) => s.name === "U1_fake" && s.status === "running"));
		expect(progress.snapshot().lanes?.max).toBe(2);
		expect(progress.running).toBe(true);
		// the decision was worked out in the child, asked here, applied there
		await until("the decision", () => decisionsDone);
		const q = asked[0]!;
		expect(q.id).toMatch(/^fw:/);
		expect(q.prompt).toMatch(/^decision while the run continues/);
		expect(q.options.length).toBeGreaterThan(1);
		await until("the decision applied", () => progress.snapshot().activity.some((l) => l.startsWith(`decided ${q.id} = `)));
		// a line logged on this side lands in the child's feed and stays after the next mirror
		progress.log("hello from pi");
		await until("the forwarded line", () => snaps.at(-1)!.activity.includes("hello from pi"));
		// /br stop reaches the child: it drains, the fake unit ends, done comes back
		await progress.stop("drain");
		expect(progress.stopping).toBe(true);
		const out = await run;
		unsub();
		expect(out.error).toBeUndefined();
		expect(out.lines?.[0]).toMatch(/^1 accepted · 0 quarantined · 2 still planned/);
		const last = progress.snapshot();
		expect(last.activity.some((l) => l.includes("stop requested"))).toBe(true);
		expect(last.steps.find((s) => s.name === "U1_fake")?.status).toBe("done");
		expect(snaps.length).toBeGreaterThan(2);
		progress.end();
	}, 60_000);

	it("a decision dialog still open when the run ends is saved by the child after the job ended", async () => {
		const ws2 = join(here, ".sim", "run-process-late");
		await makeWorkspace(ws2);
		process.env["BR_WORKSPACE"] = ws;
		process.env["BR_RUN_CHILD_SCHEDULER"] = fake;
		progress.begin("migration run");
		let answer!: (v: string | undefined) => void;
		let asked: Ask | undefined;
		const run = runInChild({ cwd: ws2, flags: [], hasUI: true, job: "migration run" }, { ask: (q) => ((asked = q), new Promise((r) => (answer = r))) });
		await until("the decision", () => asked !== undefined);
		await progress.stop("drain");
		// the job ends while the dialog is still open
		const out = await run;
		expect(out.error).toBeUndefined();
		progress.end();
		answer(asked!.recommended ?? asked!.options[0]!.value);
		const config = ConfigSchema.parse(JSON.parse(readFileSync(join(ws2, "bigrefactor.config.json"), "utf8")));
		const open = async () => {
			const ledger = new Ledger(join(ws2, ".bigrefactor", "ledger.sqlite"));
			try {
				const g = await decisionGate(ledger, config, getSourceAdapter("php"), [await getTargetAdapter("nestjs")], ws2);
				return [...g.scoped.map((x) => x.decision.id), ...g.free.map((d) => d.id)];
			} finally {
				ledger.close();
			}
		};
		const t = Date.now();
		while ((await open()).includes(asked!.id)) {
			if (Date.now() - t > 20_000) throw new Error("the late answer was not saved");
			await new Promise((r) => setTimeout(r, 100));
		}
	}, 60_000);

	it("a stop (and abort) that came before the child started reaches it", async () => {
		process.env["BR_RUN_CHILD_SCHEDULER"] = fake;
		progress.begin("migration run");
		await progress.stop("drain");
		await progress.stop("abort");
		const out = await runInChild({ cwd: ws, flags: [], hasUI: false, job: "migration run" });
		expect(out.lines?.[0]).toMatch(/^1 accepted/);
		expect(progress.snapshot().activity.some((l) => l.includes("aborting the running model session"))).toBe(true);
		progress.end();
	}, 60_000);

	it("a dry run takes the real scheduler in the child", async () => {
		progress.begin("migration run");
		const out = await runInChild({ cwd: ws, flags: ["--dry"], hasUI: true, job: "migration run" });
		expect(out.error).toBeUndefined();
		expect(progress.snapshot().activity.some((l) => l.includes("ready now"))).toBe(true);
		progress.end();
	}, 60_000);

	it("a child that dies ends the job with an error", async () => {
		process.env["BR_RUN_CHILD_SCHEDULER"] = fake;
		process.env["BR_FAKE_CRASH"] = "1";
		progress.begin("migration run");
		const out = await runInChild({ cwd: ws, flags: [], hasUI: false, job: "migration run" });
		expect(out.error).toMatch(/run process ended unexpectedly \(exit code 3\)/);
		// kept on disk too: Pi's screen is the only other place that shows it
		expect(readFileSync(join(ws, ".bigrefactor", "run-crashes.log"), "utf8")).toMatch(/ended unexpectedly \(exit code 3\); started /);
		progress.end(out.error);
	}, 60_000);

	it("an aborted run process that does not end is killed", async () => {
		process.env["BR_RUN_CHILD_SCHEDULER"] = fake;
		process.env["BR_FAKE_HANG"] = "1";
		progress.begin("migration run");
		const run = runInChild({ cwd: ws, flags: [], hasUI: false, job: "migration run" }, { abortKillMs: 500 });
		await until("the unit step", () => progress.snapshot().steps.some((s) => s.name === "U1_fake"));
		await progress.stop("drain");
		await progress.stop("drain"); // the second stop aborts
		const out = await run;
		expect(out.error).toMatch(/run process ended unexpectedly \(signal SIGKILL\)/);
		expect(progress.snapshot().activity.some((l) => l.includes("killed"))).toBe(true);
		progress.end(out.error);
	}, 60_000);

	it("a freeze in the run process is logged as the run process's, not Pi's", async () => {
		process.env["BR_RUN_CHILD_SCHEDULER"] = fake;
		process.env["BR_FAKE_FREEZE"] = "1";
		rmSync(join(ws, ".bigrefactor", "blocked.log"), { force: true });
		progress.begin("migration run");
		const run = runInChild({ cwd: ws, flags: [], hasUI: false, job: "migration run" });
		await until("the unit step", () => progress.snapshot().steps.some((s) => s.name === "U1_fake"));
		await until("the freeze line", () => progress.snapshot().activity.some((l) => l.includes("was blocked")));
		await progress.stop("drain");
		await run;
		expect(readFileSync(join(ws, ".bigrefactor", "blocked.log"), "utf8")).toMatch(/Z the run process was blocked \d+\.\d s/);
		progress.end();
	}, 60_000);

	it("a freeze on Pi's side during a run is logged as Pi's", async () => {
		process.env["BR_RUN_CHILD_SCHEDULER"] = fake;
		rmSync(join(ws, ".bigrefactor", "blocked.log"), { force: true });
		progress.begin("migration run");
		const run = runInChild({ cwd: ws, flags: [], hasUI: false, job: "migration run" });
		await until("the unit step", () => progress.snapshot().steps.some((s) => s.name === "U1_fake"));
		const t = Date.now();
		while (Date.now() - t < 1500);
		await new Promise((r) => setTimeout(r, 400));
		await progress.stop("drain");
		await run;
		expect(readFileSync(join(ws, ".bigrefactor", "blocked.log"), "utf8")).toMatch(/Z Pi was blocked \d+\.\d s \(last step: Pi drawing the run\)/);
		progress.end();
	}, 60_000);

	it("a higher plugin version does not restart a run unless the owner turned that on (run.restartOnNewCode)", async () => {
		const repo = join(here, ".sim", "plugin-head-off");
		rmSync(repo, { recursive: true, force: true });
		mkdirSync(repo, { recursive: true });
		writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "p", version: "0.1.0" }));
		const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
		const child = fork(join(here, "src", "run", "run-child.ts"), [JSON.stringify({ cwd: ws, flags: [], hasUI: false, job: "migration run", head: "0.1.0" })], { cwd: ws, execArgv: ["--import", tsx], stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, BR_RUN_CHILD: "1", BR_RUN_CHILD_SCHEDULER: fake, BR_PLUGIN_DIR: repo, BR_NEW_CODE_CHECK_MS: "100", BR_NEW_CODE_QUIET_MS: "200" } });
		const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
		let started = false;
		let newCode = false;
		child.on("message", (m: any) => {
			started ||= m.type === "progress" && m.snap.steps.some((s: any) => s.name === "U1_fake");
			newCode ||= m.type === "progress" && m.snap.activity.some((l: string) => l.includes("the plugin has new code"));
		});
		await until("the unit step", () => started);
		writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "p", version: "0.2.0" }));
		await new Promise((r) => setTimeout(r, 1500));
		expect(newCode).toBe(false);
		child.disconnect();
		expect(await exited).toBe(0);
	}, 60_000);

	it("when Pi goes away (the owner quit it) the child aborts its units at once and exits", async () => {
		const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
		// a unit that would take 30 s to finish after a plain stop
		const child = fork(join(here, "src", "run", "run-child.ts"), [JSON.stringify({ cwd: ws, flags: [], hasUI: false, job: "migration run" })], { cwd: ws, execArgv: ["--import", tsx], stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, BR_RUN_CHILD: "1", BR_RUN_CHILD_SCHEDULER: fake, BR_FAKE_DRAIN_MS: "30000" } });
		const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
		let started = false;
		child.on("message", (m: any) => (started ||= m.type === "progress" && m.snap.steps.some((s: any) => s.name === "U1_fake")));
		await until("the unit step", () => started);
		const t = Date.now();
		child.disconnect();
		expect(await exited).toBe(0);
		expect(Date.now() - t).toBeLessThan(10_000);
	}, 60_000);
});

/**
 * New plugin code while a run goes on: the run process drains and Pi starts a new one on the new code (the owner does
 * not restart Pi). Pi's /reload: the run process stays, the next runtime shows it again.
 */
describe("a run that outlives plugin changes", () => {
	const repo = join(here, ".sim", "plugin-head");
	// a new plugin version: what starts the run again (commits that keep the version change nothing)
	let patch = 0;
	const commit = (_why: string) => writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "p", version: `0.1.${++patch}` }));
	const pids = () => [...new Set(progress.snapshot().activity.flatMap((l) => /fake run process pid (\d+)/.exec(l)?.[1] ?? []))];
	const has = (s: string) => progress.snapshot().activity.some((l) => l.includes(s));
	const env = { BR_RUN_CHILD_SCHEDULER: fake, BR_PLUGIN_DIR: repo, BR_NEW_CODE_CHECK_MS: "100", BR_NEW_CODE_QUIET_MS: "300" };
	beforeAll(async () => {
		// the owner turned the restart on (it is off by default)
		await makeWorkspace(ws, { restartOnNewCode: true });
		rmSync(repo, { recursive: true, force: true });
		mkdirSync(repo, { recursive: true });
		commit("one");
	}, 60_000);
	beforeEach(() => Object.assign(process.env, env));
	afterEach(() => {
		for (const k of [...Object.keys(env), "BR_FAKE_DRAIN_MS", "BR_FAKE_FAIL_IF", "BR_FAKE_DONE_FIRST"]) delete process.env[k];
		// a failed test must not leave its run process (and its run lock) to the next one
		(liveRunProcess() as { child?: { kill(s: string): void } } | undefined)?.child?.kill("SIGKILL");
		detachRunProcess();
		if (progress.running) progress.end();
	});

	it("a higher plugin version drains the run process and starts a new one; a stop during that drain cancels the restart", async () => {
		process.env["BR_FAKE_DRAIN_MS"] = "1500";
		progress.begin("migration run");
		const run = runInChild({ cwd: ws, flags: [], hasUI: false, job: "migration run" });
		await until("the first run process", () => pids().length === 1 && progress.snapshot().steps.some((s) => s.name === "U1_fake" && s.status === "running"));
		commit("two");
		await until("the new code line", () => has("the plugin has new code"));
		// the job goes on: a second run process, the first one's feed kept
		await until("the second run process", () => pids().length === 2 && has("run started again on the new code"), 30_000);
		expect(progress.running).toBe(true);
		expect(progress.stopping).toBe(false);
		expect(has("stop requested (the plugin has new code)") || has("fake: stop (the plugin has new code)")).toBe(true);
		// another commit; the owner stops while that run process drains for it: no third one
		const lines = progress.snapshot().activity.filter((l) => l.includes("the plugin has new code (")).length;
		commit("three");
		await until("the second new code line", () => progress.snapshot().activity.filter((l) => l.includes("the plugin has new code (")).length > lines);
		await progress.stop("drain");
		const out = await run;
		expect(out.error).toBeUndefined();
		expect(out.lines?.[0]).toMatch(/^1 accepted/);
		expect(has("stopped: the run will not start again on the new code")).toBe(true);
		expect(pids()).toHaveLength(2);
		expect(liveRunProcess()).toBeUndefined();
		progress.end();
	}, 60_000);

	it("a decision dialog open across a restart: answered during the drain, the new run process applies it once; the question cards wait for it", async () => {
		const ws4 = join(here, ".sim", "run-process-restart-dialog");
		await makeWorkspace(ws4, { restartOnNewCode: true });
		process.env["BR_WORKSPACE"] = ws;
		process.env["BR_FAKE_DRAIN_MS"] = "1500";
		progress.begin("migration run");
		const asked: Ask[] = [];
		let answerFirst: ((v: string | undefined) => void) | undefined;
		let decisionsDone = 0;
		const run = runInChild(
			{ cwd: ws4, flags: [], hasUI: true, job: "migration run" },
			{
				ask: (q) => (asked.push(q), asked.length === 1 ? new Promise((r) => (answerFirst = r)) : Promise.resolve(q.recommended ?? q.options[0]!.value)),
				decisionsDone: () => decisionsDone++,
			},
		);
		await until("the first dialog", () => answerFirst !== undefined && pids().length === 1);
		const first = asked[0]!;
		commit("dialog");
		await until("the new code line", () => has("the plugin has new code"));
		// answered while the first run process drains: it must not be lost
		answerFirst!(first.recommended ?? first.options[0]!.value);
		await until("the second run process", () => pids().length === 2, 30_000);
		await until("the decision applied", () => has(`decided ${first.id} = `));
		await until("the decisions through", () => decisionsDone > 0);
		expect(progress.snapshot().activity.filter((l) => l.startsWith(`decided ${first.id} = `))).toHaveLength(1);
		// one dialog for it, and the cards started once, after it
		expect(asked.filter((q) => q.id === first.id)).toHaveLength(1);
		expect(decisionsDone).toBe(1);
		await progress.stop("drain");
		const out = await run;
		expect(out.error).toBeUndefined();
		progress.end();
	}, 60_000);

	it("only a higher plugin version counts as new code", async () => {
		const { pluginVersion, higher } = await import("../src/run/plugin-version.ts");
		expect(await pluginVersion()).toMatch(/^\d+\.\d+/);
		expect(higher("0.1.10", "0.1.9")).toBe(true);
		expect(higher("0.2.0", "0.1.9")).toBe(true);
		expect(higher("0.1.0", "0.1.0")).toBe(false);
		expect(higher("0.1.0", "0.1.1")).toBe(false);
		// no package.json: the feature is off
		process.env["BR_PLUGIN_DIR"] = join(repo, "nothing-here");
		expect(await pluginVersion()).toBeUndefined();
	});

	it("a run process started again that fails at start waits for the next higher version, then starts again", async () => {
		const marker = join(repo, "..", "plugin-broken");
		process.env["BR_FAKE_FAIL_IF"] = marker;
		rmSync(marker, { force: true });
		progress.begin("migration run");
		const run = runInChild({ cwd: ws, flags: [], hasUI: false, job: "migration run" });
		await until("the first run process", () => progress.snapshot().steps.some((s) => s.name === "U1_fake" && s.status === "running"));
		// broken code lands
		writeFileSync(marker, "");
		commit("broken");
		await until("the failed start", () => has("the run on the new code failed at start"), 30_000);
		expect(progress.running).toBe(true);
		expect(progress.snapshot().waiting?.what).toMatch(/next higher plugin version/);
		// the fix lands
		rmSync(marker);
		commit("fixed");
		await until("the run on the fix", () => pids().length === 3 && progress.snapshot().steps.some((s) => s.name === "U1_fake" && s.status === "running"), 30_000);
		await progress.stop("drain");
		const out = await run;
		expect(out.error).toBeUndefined();
		expect(out.lines?.[0]).toMatch(/^1 accepted/);
		progress.end();
	}, 60_000);

	it("a /br stop while it waits for a fix ends the run with the start error", async () => {
		const marker = join(repo, "..", "plugin-broken");
		process.env["BR_FAKE_FAIL_IF"] = marker;
		rmSync(marker, { force: true });
		progress.begin("migration run");
		const run = runInChild({ cwd: ws, flags: [], hasUI: false, job: "migration run" });
		await until("the first run process", () => progress.snapshot().steps.some((s) => s.name === "U1_fake" && s.status === "running"));
		writeFileSync(marker, "");
		commit("broken again");
		await until("the failed start", () => has("the run on the new code failed at start"), 30_000);
		await progress.stop("drain");
		const out = await run;
		expect(out.error).toMatch(/exit code 4/);
		rmSync(marker);
		progress.end(out.error);
	}, 60_000);

	it("a pilot (--limit) keeps the code it started on", async () => {
		progress.begin("pilot run (5 units)");
		const run = runInChild({ cwd: ws, flags: ["--limit", "5"], hasUI: false, job: "pilot run (5 units)" });
		await until("the run process", () => progress.snapshot().steps.some((s) => s.name === "U1_fake" && s.status === "running"));
		commit("for the pilot");
		await new Promise((r) => setTimeout(r, 1200));
		expect(has("the plugin has new code")).toBe(false);
		await progress.stop("drain");
		await run;
		progress.end();
	}, 60_000);

	it("a reload lets go of the run process and the next runtime shows it again: progress, its open dialog, stop and done", async () => {
		const ws3 = join(here, ".sim", "run-process-reload");
		await makeWorkspace(ws3);
		process.env["BR_WORKSPACE"] = ws;
		// a plugin folder that does not change here
		process.env["BR_NEW_CODE_CHECK_MS"] = "600000";
		progress.begin("migration run");
		let firstAsked: Ask | undefined;
		let answerFirst!: (v: string | undefined) => void;
		const first = runInChild({ cwd: ws3, flags: [], hasUI: true, job: "migration run" }, { ask: (q) => ((firstAsked = q), new Promise((r) => (answerFirst = r))) });
		await until("the dialog in the first runtime", () => firstAsked !== undefined);
		await until("the unit step", () => progress.snapshot().steps.some((s) => s.name === "U1_fake" && s.status === "running"));
		const pid = pids()[0];
		// /reload: the old runtime lets go; the run process stays
		detachRunProcess();
		expect(await first).toEqual({ detached: true });
		expect(liveRunProcess()?.args.cwd).toBe(ws3);
		progress.end();
		// the new runtime (a fresh panel) shows it again
		progress.begin("migration run");
		const asked: Ask[] = [];
		let decisionsDone = false;
		const again = runInChild({ cwd: ws3, flags: [], hasUI: true, job: "migration run" }, { attach: true, ask: async (q) => (asked.push(q), q.recommended ?? q.options[0]!.value), decisionsDone: () => (decisionsDone = true) });
		await until("the run shown again", () => progress.snapshot().steps.some((s) => s.name === "U1_fake" && s.status === "running"));
		expect(pids()).toEqual([pid]);
		// the dialog open during the reload is asked again here and answered; the old runtime's late answer goes nowhere
		await until("the dialog asked again", () => asked.some((q) => q.id === firstAsked!.id));
		answerFirst("something else");
		await until("the decision applied", () => has(`decided ${firstAsked!.id} = `));
		await until("the decisions through", () => decisionsDone);
		expect(progress.snapshot().activity.filter((l) => l.startsWith(`decided ${firstAsked!.id}`))).toHaveLength(1);
		await progress.stop("drain");
		const out = await again;
		expect(out.error).toBeUndefined();
		expect(out.lines?.[0]).toMatch(/^1 accepted/);
		expect(liveRunProcess()).toBeUndefined();
		progress.end();
	}, 60_000);

	it("Pi's /reload through the extension: the next runtime shows the same run process without posting its ended units to the chat again, and /br stop ends it", async () => {
		const ws5 = join(here, ".sim", "run-process-reload-ext");
		await makeWorkspace(ws5);
		process.env["BR_NEW_CODE_CHECK_MS"] = "600000";
		process.env["BR_FAKE_DONE_FIRST"] = "1";
		/** One extension runtime: its own module instances (a reload loads them fresh), a stub Pi and context. */
		const runtime = async () => {
			const handlers = new Map<string, Array<(e: unknown, ctx: unknown) => Promise<void> | void>>();
			const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
			const entries: string[] = [];
			const messages: string[] = [];
			const pi = {
				registerCommand: (n: string, def: any) => commands.set(n, def),
				registerTool: () => {},
				registerEntryRenderer: () => {},
				registerMessageRenderer: () => {},
				on: (ev: string, h: any) => handlers.set(ev, [...(handlers.get(ev) ?? []), h]),
				appendEntry: (_t: string, e: { text: string }) => entries.push(e.text),
				sendMessage: (m: { content: string }) => messages.push(m.content),
			};
			const ctx = { cwd: ws5, hasUI: true, ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, select: async () => undefined, input: async () => undefined, confirm: async () => false, custom: async () => undefined }, sessionManager: { getBranch: () => [] } };
			vi.resetModules();
			const ext = await import("../src/pi/extension.ts");
			const prog = (await import("../src/progress.ts")).progress;
			(ext.default as (p: unknown) => void)(pi);
			const fire = async (ev: string) => {
				for (const h of handlers.get(ev) ?? []) await h({}, ctx);
			};
			return { entries, messages, prog, fire, br: (a: string) => commands.get("br")!.handler(a, ctx) };
		};
		const runPids = (p: typeof progress) => [...new Set(p.snapshot().activity.flatMap((l) => /fake run process pid (\d+)/.exec(l)?.[1] ?? []))];
		const one = await runtime();
		await one.br("run");
		await until("the first unit posted", () => one.entries.some((e) => e.includes("U0_fake")));
		await until("the second unit running", () => one.prog.snapshot().steps.some((s) => s.name === "U1_fake" && s.status === "running"));
		const pid = runPids(one.prog)[0];
		expect(pid).toBeTruthy();
		// /reload
		await one.fire("session_shutdown");
		expect(one.prog.running).toBe(false);
		expect(one.messages).toEqual([]);
		const two = await runtime();
		await two.fire("session_start");
		await until("the run shown again", () => two.prog.running && two.prog.snapshot().steps.some((s) => s.name === "U1_fake" && s.status === "running"));
		expect(runPids(two.prog)).toEqual([pid]);
		// a /br run typed now shows the same run, never a second one
		await two.br("run");
		await new Promise((r) => setTimeout(r, 300));
		await two.br("stop");
		await until("the summary", () => two.messages.length > 0);
		expect(two.messages[0]).toMatch(/migration run (finished|stopped)/);
		expect(runPids(two.prog)).toEqual([pid]);
		// U0 ended before the reload: the first runtime posted it, the second does not again; U1 ended after: posted once
		expect(two.entries.filter((e) => e.includes("U0_fake"))).toEqual([]);
		expect(two.entries.filter((e) => e.includes("U1_fake"))).toHaveLength(1);
		expect(liveRunProcess()).toBeUndefined();
		delete process.env["BR_FAKE_DONE_FIRST"];
	}, 60_000);

	it("a run process that ended while no runtime listened ends the job of the next one", async () => {
		process.env["BR_NEW_CODE_CHECK_MS"] = "600000";
		progress.begin("migration run");
		const first = runInChild({ cwd: ws, flags: [], hasUI: false, job: "migration run" });
		await until("the unit step", () => progress.snapshot().steps.some((s) => s.name === "U1_fake" && s.status === "running"));
		await progress.stop("drain");
		detachRunProcess();
		await first;
		await new Promise((r) => setTimeout(r, 1500));
		progress.end();
		progress.begin("migration run");
		const out = await runInChild({ cwd: ws, flags: [], hasUI: false, job: "migration run" }, { attach: true });
		expect(out.error).toBeUndefined();
		expect(out.lines?.[0]).toMatch(/^1 accepted/);
		progress.end();
	}, 60_000);
});

describe("progress mirror", () => {
	it("shows the other process's state, keeps the job running here and sends stops and lines there", async () => {
		const sent: string[] = [];
		progress.begin("migration run");
		progress.follow({ stop: (m) => sent.push(`stop:${m}`), log: (l) => sent.push(`log:${l}`) });
		progress.mirror({ job: "migration run", plan: [], about: {}, running: false, stopping: false, steps: [{ name: "U9", status: "running", startedAt: 1 }], activity: ["from child"], agents: [], costByLabel: {}, costUsd: 0.5, tokensIn: 10, tokensOut: 2 });
		const s = progress.snapshot();
		expect(s.running).toBe(true);
		expect(s.steps[0]!.name).toBe("U9");
		expect(s.activity).toEqual(["from child"]);
		expect(s.costUsd).toBe(0.5);
		progress.log("here");
		expect(sent).toEqual(["log:here"]);
		await progress.stop("drain");
		await progress.stop("drain"); // the second stop aborts
		expect(sent.slice(1)).toEqual(["stop:drain", "stop:abort"]);
		expect(progress.stopping && progress.aborting).toBe(true);
		progress.end();
		// after the end a late snapshot changes nothing and nothing is sent any more
		progress.mirror({ ...s, steps: [] });
		progress.log("after");
		expect(progress.snapshot().steps).toHaveLength(1);
		expect(sent).toHaveLength(3);
	});
});
