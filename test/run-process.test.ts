import { fork } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getSourceAdapter, getTargetAdapter } from "../src/adapters/registry.ts";
import { ConfigSchema } from "../src/config.ts";
import { applyDecision } from "../src/inventory/decisions.ts";
import { inventory } from "../src/inventory/run.ts";
import { Ledger } from "../src/ledger/db.ts";
import { runInChild, type Ask } from "../src/pi/run-process.ts";
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
async function makeWorkspace(ws: string) {
	rmSync(ws, { recursive: true, force: true });
	mkdirSync(join(ws, "legacy", "myfw"), { recursive: true });
	cpSync(join(here, "fixtures", "mini-app"), join(ws, "legacy"), { recursive: true });
	writeFileSync(join(ws, "legacy", "myfw", "registry.php"), "<?php\nclass Registry { public static function get($k) { return null; } }\n");
	writeFileSync(join(ws, "legacy", "src", "uses_registry.php"), `<?php\nfunction uses_registry() {\nRegistry::get('k');\n}\n`);
	writeFileSync(join(ws, "legacy", "index.php"), `<?php\nrequire 'src/uses_registry.php';\nuses_registry();\n`);
	mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
	writeFileSync(join(ws, ".bigrefactor", "framework-profile.json"), JSON.stringify({ id: "myfw", frameworkDirs: ["myfw/"], loaders: [], concerns: [] }));
	const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, models: {} });
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

	it("when Pi goes away the child stops its run and exits", async () => {
		const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
		const child = fork(join(here, "src", "run", "run-child.ts"), [JSON.stringify({ cwd: ws, flags: [], hasUI: false, job: "migration run" })], { cwd: ws, execArgv: ["--import", tsx], stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, BR_RUN_CHILD: "1", BR_RUN_CHILD_SCHEDULER: fake } });
		const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
		let started = false;
		child.on("message", (m: any) => (started ||= m.type === "progress" && m.snap.steps.some((s: any) => s.name === "U1_fake")));
		await until("the unit step", () => started);
		child.disconnect();
		expect(await exited).toBe(0);
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
