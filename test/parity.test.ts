import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { commitAll, ensureRepo } from "../src/git.ts";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { legacyCopyTool } from "../src/run/legacy-env.ts";
import { appBootTools, bootApp, dumpData, LEGACY, loadApps, probeApp, saveApp, type AppFixer } from "../src/run/parity.ts";

/**
 * Differential parity starts with: can each app run here as a local server? The setup model saves a recipe;
 * code starts the app, gets an answer on the ready URL and stops it. The old app only ever runs in a copy.
 */
function workspace() {
	const root = mkdtempSync(join(tmpdir(), "br-parity-"));
	const legacy = join(root, "legacy");
	mkdirSync(legacy, { recursive: true });
	writeFileSync(join(legacy, "server.js"), "require('http').createServer((q, s) => s.end('ok')).listen(Number(process.argv[2]));\n");
	const config = ConfigSchema.parse({ source: { path: legacy, stack: "php" }, target: { path: join(root, "new"), stacks: ["nestjs"] }, models: {}, db: { strategy: "none" } });
	return { root, legacy, config };
}

async function freePort(): Promise<number> {
	return new Promise((res) => {
		const s = createServer().listen(0, () => {
			const p = (s.address() as { port: number }).port;
			s.close(() => res(p));
		});
	});
}

const call = (t: unknown, p: object) => (t as { execute: (id: string, p: object) => Promise<{ content: Array<{ text: string }> }> }).execute("x", p);
const tool = (tools: unknown[], name: string) => tools.find((t) => (t as { name: string }).name === name);
const serverRecipe = (port: number) => ({ dir: ".", cmd: process.execPath, args: ["server.js", String(port)], ready: `http://localhost:${port}/` });
const asRecipe = (p: ReturnType<typeof serverRecipe>) => ({ dir: p.dir, start: { cmd: p.cmd, args: p.args }, ready: p.ready });

describe("starting the apps for parity", () => {
	it("the old app runs only in the workspace copy; code starts it once to confirm, and the result is kept", async () => {
		const { root, legacy, config } = workspace();
		const port = await freePort();
		let calls = 0;
		const fixer: AppFixer = async (o) => {
			calls++;
			const tools = appBootTools(o.config, o.root, o.side);
			// before the copy: refused, the legacy repo is read-only
			expect((await call(tool(tools, "set_app_boot"), serverRecipe(port))).content[0]!.text).toMatch(/make_legacy_copy first/);
			await call(legacyCopyTool(o.root, o.config), { why: "the app writes caches" });
			expect((await call(tool(tools, "check_app_boot"), serverRecipe(port))).content[0]!.text).toMatch(/^up/);
			await call(tool(tools, "set_app_boot"), serverRecipe(port));
			return "node serves it";
		};
		expect(await probeApp({ config, root, side: LEGACY, fixer, log: () => {} })).toBe(true);
		expect(loadApps(root)[LEGACY]).toMatchObject({ up: true, recipe: { ready: `http://localhost:${port}/` } });
		// decided: no second session
		expect(await probeApp({ config, root, side: LEGACY, fixer, log: () => {} })).toBe(true);
		expect(calls).toBe(1);
		// the app was stopped again, and nothing was written into the legacy repo
		await expect(fetch(`http://localhost:${port}/`)).rejects.toThrow();
		expect(readdirSync(legacy)).toEqual(["server.js"]);
	});

	it("a recipe that never answers is red, says why, asks the owner once; retry probes again", async () => {
		const { root, config } = workspace();
		const port = await freePort();
		const asked: Array<{ facts: string }> = [];
		const answers = new Map<number, string>();
		const broken: AppFixer = async (o) => {
			await call(legacyCopyTool(o.root, o.config), { why: "copy" });
			await call(tool(appBootTools(o.config, o.root, o.side), "set_app_boot"), { ...serverRecipe(port), args: ["-e", "console.error('php: not found'); process.exit(3)"] });
			return "tried the dev server";
		};
		const opts = { config, root, side: LEGACY, log: () => {}, ask: async (q: { facts: string }) => (asked.push(q), 7), answer: (id: number) => answers.get(id) };
		expect(await probeApp({ ...opts, fixer: broken })).toBe(false);
		expect(loadApps(root)[LEGACY]!.said).toMatch(/exited with 3[\s\S]*php: not found/);
		expect(asked).toHaveLength(1);
		expect(await probeApp({ ...opts, fixer: broken })).toBe(false);
		expect(asked).toHaveLength(1);
		answers.set(7, "retry");
		const fixed: AppFixer = async (o) => (await call(tool(appBootTools(o.config, o.root, o.side), "set_app_boot"), serverRecipe(port)), "installed node");
		expect(await probeApp({ ...opts, fixer: fixed })).toBe(true);
	});

	it("a keep-schema app that is up but cannot dump its data is asked once to add a reset and a dump; a broken new recipe is dropped", async () => {
		const { root, config: base } = workspace();
		const config = ConfigSchema.parse({ ...base, db: { strategy: "keep-schema", from: ["mariadb"], to: "postgresql" } });
		const port = await freePort();
		const first: AppFixer = async (o) => (await call(legacyCopyTool(o.root, o.config), { why: "copy" }), await call(tool(appBootTools(o.config, o.root, o.side), "set_app_boot"), serverRecipe(port)), "node serves it");
		expect(await probeApp({ config, root, side: LEGACY, fixer: first, log: () => {} })).toBe(true);
		const problems: string[] = [];
		// the second try breaks the start command: the app was up before, so the old recipe stays
		const broken: AppFixer = async (o) => (problems.push(o.problem), await call(tool(appBootTools(o.config, o.root, o.side), "set_app_boot"), { ...serverRecipe(port), args: ["-e", "process.exit(3)"], dumpCmd: "echo", dumpArgs: ["{}"] }), "added a dump");
		expect(await probeApp({ config, root, side: LEGACY, fixer: broken, log: () => {} })).toBe(true);
		expect(problems[0]).toMatch(/no data reset and no data dump/);
		expect(loadApps(root)[LEGACY]).toMatchObject({ up: true, dataProbed: true, recipe: { start: { args: ["server.js", String(port)] } } });
		// asked once only
		expect(await probeApp({ config, root, side: LEGACY, fixer: broken, log: () => {} })).toBe(true);
		expect(problems).toHaveLength(1);
	});

	it("a new recipe whose reset works but whose dump fails keeps its reset; a dump bigger than any buffer is read whole", async () => {
		const { root, legacy, config: base } = workspace();
		const config = ConfigSchema.parse({ ...base, db: { strategy: "keep-schema", from: ["mariadb"], to: "postgresql" } });
		const port = await freePort();
		const first: AppFixer = async (o) => (await call(legacyCopyTool(o.root, o.config), { why: "copy" }), await call(tool(appBootTools(o.config, o.root, o.side), "set_app_boot"), serverRecipe(port)), "node serves it");
		expect(await probeApp({ config, root, side: LEGACY, fixer: first, log: () => {} })).toBe(true);
		const half: AppFixer = async (o) => (await call(tool(appBootTools(o.config, o.root, o.side), "set_app_boot"), { ...serverRecipe(port), resetCmd: process.execPath, resetArgs: ["-e", "0"], dumpCmd: process.execPath, dumpArgs: ["-e", "process.exit(2)"] }), "reset works, dump not");
		expect(await probeApp({ config, root, side: LEGACY, fixer: half, log: () => {} })).toBe(true);
		const kept = loadApps(root)[LEGACY]!;
		expect(kept.recipe!.reset).toEqual({ cmd: process.execPath, args: ["-e", "0"] });
		expect(kept.recipe!.dump).toBeUndefined();
		// 70 MB on stdout: more than the 64 MB a buffer would take
		const big = await dumpData({ ...asRecipe(serverRecipe(port)), dump: { cmd: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify({ t: ['x'.repeat(70 * 1024 * 1024)] }))"] } }, legacy);
		expect((big["t"]![0] as string).length).toBe(70 * 1024 * 1024);
	});

	it("an old app that only redirects to itself on https is probed again once, told so; a working new recipe clears it", async () => {
		const { root, config } = workspace();
		const port = await freePort();
		const first: AppFixer = async (o) => (await call(legacyCopyTool(o.root, o.config), { why: "copy" }), await call(tool(appBootTools(o.config, o.root, o.side), "set_app_boot"), serverRecipe(port)), "node serves it");
		expect(await probeApp({ config, root, side: LEGACY, fixer: first, log: () => {} })).toBe(true);
		saveApp(root, LEGACY, { selfRedirect: "POST /post_command → 301 https://(this app)/post_command" });
		const problems: string[] = [];
		const fix: AppFixer = async (o) => (problems.push(o.problem), await call(tool(appBootTools(o.config, o.root, o.side), "set_app_boot"), { ...serverRecipe(port), env: { HTTPS: "off" } }), "turned off the https redirect");
		expect(await probeApp({ config, root, side: LEGACY, fixer: fix, log: () => {} })).toBe(true);
		expect(problems[0]).toMatch(/redirect to itself[\s\S]*301 https:\/\/\(this app\)\/post_command[\s\S]*plain http/);
		expect(loadApps(root)[LEGACY]).toMatchObject({ up: true, redirectProbed: true, recipe: { env: { HTTPS: "off" } } });
		expect(loadApps(root)[LEGACY]!.selfRedirect).toBeUndefined();
		// once only, even when a later slice check sees the redirect again
		saveApp(root, LEGACY, { selfRedirect: "GET / → 301 https://(this app)/" });
		expect(await probeApp({ config, root, side: LEGACY, fixer: fix, log: () => {} })).toBe(true);
		expect(problems).toHaveLength(1);
	});

	it("a setup problem the parity judge found is sent to that app's setup once; a working new recipe clears it", async () => {
		const { root, config } = workspace();
		const port = await freePort();
		const first: AppFixer = async (o) => (await call(legacyCopyTool(o.root, o.config), { why: "copy" }), await call(tool(appBootTools(o.config, o.root, o.side), "set_app_boot"), serverRecipe(port)), "node serves it");
		expect(await probeApp({ config, root, side: LEGACY, fixer: first, log: () => {} })).toBe(true);
		saveApp(root, LEGACY, { setupProblem: "step s1 redirects to localhost — the app's base URL is set to another port" });
		const problems: string[] = [];
		const fix: AppFixer = async (o) => (problems.push(o.problem), await call(tool(appBootTools(o.config, o.root, o.side), "set_app_boot"), { ...serverRecipe(port), env: { BASE_URL: "x" } }), "set the base URL");
		expect(await probeApp({ config, root, side: LEGACY, fixer: fix, log: () => {} })).toBe(true);
		expect(problems[0]).toMatch(/only its setup here causes \(step s1 redirects to localhost/);
		expect(loadApps(root)[LEGACY]).toMatchObject({ up: true, setupProbed: true, recipe: { env: { BASE_URL: "x" } } });
		expect(loadApps(root)[LEGACY]!.setupProblem).toBeUndefined();
		// once only
		saveApp(root, LEGACY, { setupProblem: "again" });
		expect(await probeApp({ config, root, side: LEGACY, fixer: fix, log: () => {} })).toBe(true);
		expect(problems).toHaveLength(1);
	});

	it("a red new app is probed again once main has moved on, a few times at most, without asking the owner again", async () => {
		const { root, config } = workspace();
		mkdirSync(config.target.path, { recursive: true });
		await ensureRepo(config.target.path);
		await commitAll(config.target.path, "scaffold", { allowEmpty: true });
		let calls = 0;
		const red: AppFixer = async () => (calls++, "nothing to start yet");
		let asked = 0;
		const opts = { config, root, side: "nestjs", fixer: red, log: () => {}, ask: async () => (asked++, 1) };
		expect(await probeApp(opts)).toBe(false);
		expect(await probeApp(opts)).toBe(false);
		expect(calls).toBe(1);
		for (let i = 0; i < 4; i++) {
			await commitAll(config.target.path, `unit ${i}`, { allowEmpty: true });
			await probeApp(opts);
		}
		expect(calls).toBe(3);
		expect(asked).toBe(1);
	});

	it("stop() takes down a server the start command left running in the background", async () => {
		const { legacy } = workspace();
		const port = await freePort();
		const r = await bootApp({ dir: ".", start: { cmd: "sh", args: ["-c", `${JSON.stringify(process.execPath)} server.js ${port} & exit 0`] }, ready: `http://localhost:${port}/` }, legacy);
		expect(r.ok).toBe(true);
		if (r.ok) await r.stop();
		await expect(fetch(`http://localhost:${port}/`)).rejects.toThrow();
	});

	it("both apps run at once: the new app may not take the old app's port", async () => {
		const { root, config } = workspace();
		const port = await freePort();
		await call(legacyCopyTool(root, config), { why: "copy" });
		await call(tool(appBootTools(config, root, LEGACY), "set_app_boot"), serverRecipe(port));
		expect((await call(tool(appBootTools(config, root, "nestjs"), "set_app_boot"), serverRecipe(port))).content[0]!.text).toMatch(/port \d+ is the legacy app's/);
	});

	it("something already answering on the ready URL, or a URL off this machine, never counts as the app", async () => {
		const { legacy } = workspace();
		const port = await freePort();
		const other = createServer((_q, s) => s.end("someone else")).listen(port);
		try {
			const r = await bootApp(asRecipe(serverRecipe(port)), legacy);
			expect(r.ok).toBe(false);
			expect(!r.ok && r.error).toMatch(/already answers/);
		} finally {
			other.close();
		}
		const far = await bootApp({ ...asRecipe(serverRecipe(port)), ready: "https://example.com/" }, legacy);
		expect(!far.ok && far.error).toMatch(/on this machine/);
	});
});
