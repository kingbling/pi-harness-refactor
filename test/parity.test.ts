import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { commitAll, ensureRepo } from "../src/git.ts";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { legacyCopyTool } from "../src/run/legacy-env.ts";
import { appBootTools, askBootOwner, bootApp, bootWaits, clipError, dumpData, ensureTestLogins, LEGACY, loadApps, loginFacts, MAX_DUMP_MB, MAX_FIXUPS, MAX_LOGIN_TRIES, probeApp, saveApp, setupFixer, type AppFixer } from "../src/run/parity.ts";

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
	it("a failing data reset keeps the tool's own message, not only the traceback after it", () => {
		const stderr = `Error response from daemon: volume ssp1copy_mariadb_data is in use\n${"  File \"reset.py\", line 11, in run\n".repeat(60)}\u001b[35msubprocess.CalledProcessError\u001b[0m: exit status 1`;
		const t = clipError({ stderr });
		expect(t).toMatch(/^Error response from daemon: volume ssp1copy_mariadb_data is in use/);
		expect(t).toMatch(/subprocess.CalledProcessError: exit status 1$/);
		expect(t.length).toBeLessThan(1300);
	});

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

	it("a keep-schema app that is up but cannot dump its data is asked (3 times at most) to add a reset and a dump; a broken new recipe is dropped", async () => {
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
		expect(loadApps(root)[LEGACY]).toMatchObject({ up: true, dataProbes: 1, recipe: { start: { args: ["server.js", String(port)] } } });
		// asked 3 times at most
		for (let i = 0; i < 3; i++) expect(await probeApp({ config, root, side: LEGACY, fixer: broken, log: () => {} })).toBe(true);
		expect(problems).toHaveLength(3);
	});

	it("a data reset is checked once for a full copy of a large database; a recipe saved without it is asked for a reset that loads a small fixture instead", async () => {
		const { root, config: base } = workspace();
		const config = ConfigSchema.parse({ ...base, db: { strategy: "keep-schema", from: ["mariadb"], to: "postgresql" } });
		const port = await freePort();
		const dump = { dumpCmd: process.execPath, dumpArgs: ["-e", "process.stdout.write('{}')"] };
		const first: AppFixer = async (o) => (await call(legacyCopyTool(o.root, o.config), { why: "copy" }), await call(tool(appBootTools(o.config, o.root, o.side), "set_app_boot"), { ...serverRecipe(port), resetCmd: process.execPath, resetArgs: ["-e", "0"], ...dump }), "node serves it");
		expect(await probeApp({ config, root, side: LEGACY, fixer: first, log: () => {} })).toBe(true);
		const problems: string[] = [];
		const drop: AppFixer = async (o) => (problems.push(o.problem), await call(tool(appBootTools(o.config, o.root, o.side), "set_app_boot"), { ...serverRecipe(port), ...dump }), "dropped the reset");
		expect(await probeApp({ config, root, side: LEGACY, fixer: drop, log: () => {} })).toBe(true);
		expect(problems[0]).toMatch(/full second copy[\s\S]*replace the restore from that copy with loading the schema and a small fixture/);
		expect(loadApps(root)[LEGACY]).toMatchObject({ up: true, resetSpaceChecked: true });
		expect(loadApps(root)[LEGACY]!.recipe!.reset).toBeUndefined();
		// strict parity needs every run to start from the same data: a reset loading a small fixture, MAX_FIXUPS times at most
		for (let i = 0; i < MAX_FIXUPS + 1; i++) expect(await probeApp({ config, root, side: LEGACY, fixer: drop, log: () => {} })).toBe(true);
		expect(problems).toHaveLength(MAX_FIXUPS);
		expect(problems[1]).toMatch(/replays every slice on both apps from the same starting data, and it has no data reset[\s\S]*small fixture[\s\S]*set_fixture_files/);
		expect(loadApps(root)[LEGACY]).toMatchObject({ fixtureProbes: MAX_FIXUPS });
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

	it("a dump bigger than a comparison reads is refused by its size, never read into the run's thread, and says what to dump instead", async () => {
		const { legacy } = workspace();
		const port = await freePort();
		const bytes = (MAX_DUMP_MB + 1) * 1024 * 1024;
		// the run's event loop must stay live while the dump is judged (a whole-database dump held it 10 s per try)
		let last = performance.now();
		let worst = 0;
		const tick = setInterval(() => ((worst = Math.max(worst, performance.now() - last)), (last = performance.now())), 10);
		try {
			const r = dumpData({ ...asRecipe(serverRecipe(port)), dump: { cmd: process.execPath, args: ["-e", `process.stdout.write(JSON.stringify({ t: ['x'.repeat(${bytes})] }))`] } }, legacy);
			await expect(r).rejects.toThrow(new RegExp(`the dump printed more than the ${MAX_DUMP_MB} MB a comparison reads: use a complete bounded observation`));
		} finally {
			clearInterval(tick);
		}
		expect(worst).toBeLessThan(1000);
		// the setup model is told the limit before it writes the dump
		const set = tool(appBootTools(ConfigSchema.parse(workspace().config), workspace().root, LEGACY), "set_app_boot") as { parameters: { properties: { dumpCmd: { description: string } } } };
		expect(set.parameters.properties.dumpCmd.description).toContain(`at most ${MAX_DUMP_MB} MB`);
	});

	it("an old app that only redirects to itself on https is probed again until plain http reaches it (3 times at most); the check sends that request again", async () => {
		const { root, legacy, config } = workspace();
		// like an app whose force-https setting is on: every plain-http request is redirected to itself on https
		writeFileSync(join(legacy, "redir.js"), "const p = Number(process.argv[2]); require('http').createServer((q, s) => { if (process.env.HTTPS !== 'off') { s.writeHead(301, { location: `https://localhost:${p}${q.url}` }); return s.end(); } s.end('ok'); }).listen(p);\n");
		const port = await freePort();
		const recipe = { ...serverRecipe(port), args: ["redir.js", String(port)] };
		const first: AppFixer = async (o) => (await call(legacyCopyTool(o.root, o.config), { why: "copy" }), await call(tool(appBootTools(o.config, o.root, o.side), "set_app_boot"), recipe), "node serves it");
		expect(await probeApp({ config, root, side: LEGACY, fixer: first, log: () => {} })).toBe(true);
		saveApp(root, LEGACY, { selfRedirect: "POST /post_command → 301 https://(this app)/post_command" });
		const problems: string[] = [];
		const checks: string[] = [];
		// a model that keeps the https rule: the check tells it the request is still redirected, and nothing is cleared
		const keep: AppFixer = async (o) => {
			problems.push(o.problem);
			checks.push((await call(tool(appBootTools(o.config, o.root, o.side), "check_app_boot"), recipe)).content[0]!.text);
			await call(tool(appBootTools(o.config, o.root, o.side), "set_app_boot"), recipe);
			return "kept the https rule";
		};
		expect(await probeApp({ config, root, side: LEGACY, fixer: keep, log: () => {} })).toBe(true);
		expect(problems[0]).toMatch(/redirect to itself[\s\S]*301 https:\/\/\(this app\)\/post_command[\s\S]*plain http[\s\S]*local config only/);
		expect(checks[0]).toMatch(/^not up: .*still only redirects to the app itself: POST \/post_command → 301 https:\/\/localhost/);
		expect(loadApps(root)[LEGACY]).toMatchObject({ up: true, redirectProbes: 1, selfRedirect: expect.stringContaining("post_command") });
		// a model that switches it off: code sends the request again, it reaches the handler, the redirect is cleared
		const fix: AppFixer = async (o) => (problems.push(o.problem), await call(tool(appBootTools(o.config, o.root, o.side), "set_app_boot"), { ...recipe, env: { HTTPS: "off" } }), "turned off the https redirect");
		expect(await probeApp({ config, root, side: LEGACY, fixer: fix, log: () => {} })).toBe(true);
		expect(loadApps(root)[LEGACY]).toMatchObject({ up: true, redirectProbes: 2, recipe: { env: { HTTPS: "off" } } });
		expect(loadApps(root)[LEGACY]!.selfRedirect).toBeUndefined();
		// 3 times at most, whatever came of it
		saveApp(root, LEGACY, { selfRedirect: "GET / → 301 https://(this app)/" });
		expect(await probeApp({ config, root, side: LEGACY, fixer: keep, log: () => {} })).toBe(true);
		saveApp(root, LEGACY, { selfRedirect: "GET / → 301 https://(this app)/" });
		expect(await probeApp({ config, root, side: LEGACY, fixer: keep, log: () => {} })).toBe(true);
		expect(problems).toHaveLength(3);
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
		expect(loadApps(root)[LEGACY]).toMatchObject({ up: true, setupProbes: 1, recipe: { env: { BASE_URL: "x" } } });
		expect(loadApps(root)[LEGACY]!.setupProblem).toBeUndefined();
		// 3 times at most (an older workspace's "probed once" counts as one)
		saveApp(root, LEGACY, { setupProblem: "again", setupProbes: undefined, setupProbed: true });
		expect(await probeApp({ config, root, side: LEGACY, fixer: fix, log: () => {} })).toBe(true);
		saveApp(root, LEGACY, { setupProblem: "again" });
		expect(await probeApp({ config, root, side: LEGACY, fixer: fix, log: () => {} })).toBe(true);
		saveApp(root, LEGACY, { setupProblem: "again" });
		expect(await probeApp({ config, root, side: LEGACY, fixer: fix, log: () => {} })).toBe(true);
		expect(problems).toHaveLength(3);
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

	it("a data reset is judged by its exit status: a notice it prints never fails it; a failure says how it ended", async () => {
		const { legacy } = workspace();
		const port = await freePort();
		const node = (code: string) => ({ cmd: process.execPath, args: ["-e", code] });
		// a container tool's notice on stderr and stdout, exit 0: the app starts
		const notice = await bootApp({ ...asRecipe(serverRecipe(port)), reset: node("console.error('OrbStack is already running. Docker engine is ready to use.'); console.log('Use --all to start all machines.')") }, legacy);
		expect(notice.ok).toBe(true);
		if (notice.ok) await notice.stop();
		const failed = await bootApp({ ...asRecipe(serverRecipe(port)), reset: node("console.error('volume in use'); process.exit(2)") }, legacy);
		expect(failed).toMatchObject({ ok: false, stage: "setup" });
		expect(!failed.ok && failed.error).toMatch(/the data reset failed \(.* it exited with status 2\); its output: volume in use/);
		// a reset that hangs after a notice: stopped, and said so; the notice is only its output
		const hung = await bootApp({ ...asRecipe(serverRecipe(port)), reset: node("console.error('OrbStack is already running.'); setInterval(() => {}, 1000)") }, legacy, { resetTimeoutMs: 1_000 });
		expect(!hung.ok && hung.error).toMatch(/did not finish within 1 s and was stopped\); its output: OrbStack is already running/);
		// the start command failing is the app's own start, not its setup
		const start = await bootApp({ ...asRecipe(serverRecipe(port)), start: node("process.exit(4)") }, legacy);
		expect(start).toMatchObject({ ok: false, stage: "start" });
	});

	it("an app a slice check could not start goes to its setup with what failed, a few times at most until it starts again", async () => {
		const { root, config } = workspace();
		const port = await freePort();
		const first: AppFixer = async (o) => (await call(legacyCopyTool(o.root, o.config), { why: "copy" }), await call(tool(appBootTools(o.config, o.root, o.side), "set_app_boot"), serverRecipe(port)), "node serves it");
		expect(await probeApp({ config, root, side: LEGACY, fixer: first, log: () => {} })).toBe(true);
		const problems: string[] = [];
		// the fixer changes nothing in the recipe (it started a stopped container): the saved recipe starts, the problem is gone
		const look: AppFixer = async (o) => (problems.push(o.problem), "the database container was stopped; started it");
		expect(await setupFixer({ config, root, fixer: look, log: () => {} })(LEGACY, "the data reset failed (reset.py: it exited with status 1)")).toBe(true);
		expect(problems[0]).toMatch(/did not start for a slice check just now \(the data reset failed \(reset\.py: it exited with status 1\)\)/);
		expect(loadApps(root)[LEGACY]).toMatchObject({ up: true, bootProbes: 1 });
		expect(loadApps(root)[LEGACY]!.bootProblem).toBeUndefined();
		// a fixer whose recipe does not start: the problem stays, and after MAX_FIXUPS it is not asked again
		const broken: AppFixer = async (o) => (problems.push(o.problem), await call(tool(appBootTools(o.config, o.root, o.side), "set_app_boot"), { ...serverRecipe(port), resetCmd: process.execPath, resetArgs: ["-e", "process.exit(1)"] }), "tried");
		for (let i = 0; i < MAX_FIXUPS + 1; i++) expect(await setupFixer({ config, root, fixer: broken, log: () => {} })(LEGACY, "still fails")).toBe(false);
		expect(problems).toHaveLength(MAX_FIXUPS);
		expect(loadApps(root)[LEGACY]).toMatchObject({ up: true, bootProbes: MAX_FIXUPS, bootProblem: "still fails" });
		// the working recipe was kept, not the broken one
		expect(loadApps(root)[LEGACY]!.recipe!.reset).toBeUndefined();
	});

	it("once its setup ran out of fixes the owner is asked once; checks wait for the answer and \"retry\" gives the setup its tries back", async () => {
		const { root, config } = workspace();
		const port = await freePort();
		const first: AppFixer = async (o) => (await call(legacyCopyTool(o.root, o.config), { why: "copy" }), await call(tool(appBootTools(o.config, o.root, o.side), "set_app_boot"), serverRecipe(port)), "node serves it");
		expect(await probeApp({ config, root, side: LEGACY, fixer: first, log: () => {} })).toBe(true);
		const asked: string[] = [];
		const ask = async (q: { facts: string }) => (asked.push(q.facts), 7);
		// fixes left: nobody is asked
		saveApp(root, LEGACY, { bootProblem: "no answer on http://localhost/ after 180s" });
		expect(await askBootOwner({ root, side: LEGACY, error: "no answer after 180s", ask })).toBe(false);
		expect(asked).toEqual([]);
		// used up: asked once, checks wait until the answer is "retry"
		saveApp(root, LEGACY, { bootProbes: MAX_FIXUPS });
		expect(await askBootOwner({ root, side: LEGACY, error: "no answer after 180s", ask })).toBe(true);
		expect(await askBootOwner({ root, side: LEGACY, error: "no answer after 180s", ask })).toBe(true);
		expect(asked).toHaveLength(1);
		expect(asked[0]).toMatch(/the old app stopped starting .* no answer after 180s/);
		// the run starts it again without its setup model every BOOT_RECHECK_MS from now: it often starts again by itself
		expect(loadApps(root)[LEGACY]!.bootRetriedAt).toBeGreaterThan(Date.now() - 60_000);
		let answer: string | undefined;
		expect(bootWaits(loadApps(root), () => answer)).toBe(LEGACY);
		answer = "skip";
		expect(bootWaits(loadApps(root), () => answer)).toBe(LEGACY);
		answer = "retry";
		expect(bootWaits(loadApps(root), () => answer)).toBeUndefined();
		// the next failure after "retry": the setup model is asked again
		const problems: string[] = [];
		const look: AppFixer = async (o) => (problems.push(o.problem), "the database was stopped; started it");
		expect(await setupFixer({ config, root, fixer: look, log: () => {}, answer: () => answer })(LEGACY, "no answer after 180s")).toBe(true);
		expect(problems).toHaveLength(1);
		expect(loadApps(root)[LEGACY]).toMatchObject({ bootProbes: 1 });
		expect(loadApps(root)[LEGACY]!.bootQuestion).toBeUndefined();
	});
	it("each app gets a test account from its setup (a new app is told the old one's); with none after a few tries the owner is asked once, retry looks again", async () => {
		const { root, legacy, config: base } = workspace();
		writeFileSync(join(legacy, "login.js"), "require('http').createServer((q, s) => q.method === 'POST' && q.url === '/login' ? s.writeHead(302, { 'set-cookie': 'sid=1; Path=/', location: '/home' }).end() : q.url === '/home' ? (q.headers.cookie === 'sid=1' ? s.end('welcome') : s.writeHead(302, { location: '/login' }).end()) : s.end('login form')).listen(Number(process.argv[2]));\n");
		const target = join(root, "new");
		mkdirSync(target, { recursive: true });
		await ensureRepo(target);
		await commitAll(target, "scaffold", { allowEmpty: true });
		const config = ConfigSchema.parse({ ...base, target: { path: target, stacks: ["nestjs"] } });
		const [port, newPort] = [await freePort(), await freePort()];
		const first: AppFixer = async (o) => (await call(legacyCopyTool(o.root, o.config), { why: "copy" }), await call(tool(appBootTools(o.config, o.root, o.side), "set_app_boot"), { ...serverRecipe(port), args: ["login.js", String(port)] }), "node serves it");
		expect(await probeApp({ config, root, side: LEGACY, fixer: first, log: () => {} })).toBe(true);
		saveApp(root, "nestjs", { up: true, recipe: asRecipe(serverRecipe(newPort)) });
		expect(loginFacts(root, ["nestjs"])).toMatchObject({ login: false, text: expect.stringMatching(/No test account is known yet/) });
		// no account found: tried MAX_LOGIN_TRIES times, then the owner is asked once; the new app waits for the old one's
		const problems: Array<{ side: string; problem: string }> = [];
		const none: AppFixer = async (o) => (problems.push(o), "no user table found");
		const asked: string[] = [];
		let answer: string | undefined;
		const opts = { config, root, sides: ["nestjs"], linkAll: () => {}, log: () => {}, ask: async (q: { facts: string }) => (asked.push(q.facts), 9), answer: () => answer };
		for (let i = 0; i < MAX_LOGIN_TRIES + 1; i++) await ensureTestLogins({ ...opts, fixer: none });
		expect(problems.map((p) => p.side)).toEqual(Array(MAX_LOGIN_TRIES).fill(LEGACY));
		expect(problems[0]!.problem).toMatch(/test account on the old app[\s\S]*try_requests[\s\S]*set_test_login/);
		expect(asked).toHaveLength(1);
		expect(asked[0]).toMatch(/needs a test account on the old app/);
		// the owner's retry: the setup model looks again, tries the login, saves it; the new app is told the old account
		answer = "retry";
		const found: AppFixer = async (o) => {
			problems.push(o);
			const tools = appBootTools(o.config, o.root, o.side);
			if (o.side !== LEGACY) return void (await call(tool(tools, "set_test_login"), { none: "serves files only" }));
			const login = [{ method: "POST", path: "/login", form: { user: "parity", password: "pw" } }];
			expect((await call(tool(tools, "try_requests"), { requests: [...login, { method: "GET", path: "/home" }] })).content[0]!.text).toMatch(/r1 POST \/login → 302 → \/home[\s\S]*r2 GET \/home → 200 welcome/);
			expect((await call(tool(tools, "set_test_login"), { user: "parity" })).content[0]!.text).toMatch(/^refused/);
			await call(tool(tools, "set_test_login"), { user: "parity", password: "pw", steps: login, said: "made in the copy's user table" });
		};
		await ensureTestLogins({ ...opts, fixer: found });
		expect(loadApps(root)[LEGACY]).toMatchObject({ login: { user: "parity", password: "pw" }, loginTries: 1 });
		expect(loadApps(root)[LEGACY]!.loginQuestion).toBeUndefined();
		expect(problems.at(-1)).toMatchObject({ side: "nestjs", problem: expect.stringMatching(/old app's test account: user parity, password pw/) });
		expect(loadApps(root)["nestjs"]!.login).toEqual({ none: "serves files only" });
		const facts = loginFacts(root, ["nestjs"]);
		expect(facts.login).toBe(true);
		expect(facts.text).toMatch(/the old app: user parity, password pw; it logs in with .*\/login[\s\S]*the new nestjs app: no login of its own/);
		// known: no more sessions
		const n = problems.length;
		await ensureTestLogins({ ...opts, fixer: found });
		expect(problems).toHaveLength(n);
	}, 30_000);
});
