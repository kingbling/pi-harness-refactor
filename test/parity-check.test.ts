import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { inventory } from "../src/inventory/run.ts";
import { applySlicePlan, planSlices } from "../src/inventory/slices.ts";
import { Ledger } from "../src/ledger/db.ts";
import { legacyCopyTool } from "../src/run/legacy-env.ts";
import { LEGACY, loadApps, saveApp } from "../src/run/parity.ts";
import { checkSlice, compareRuns, dataChanges, fieldValue, loginWall, MAX_SETUP_RETRIES, plainValue, textBody, runSteps, selfRedirect, skippedRoutes, stepsProblem, type Step, type StepResult, type StepWriter } from "../src/run/parity-check.ts";

const FIXTURE = resolve(import.meta.dirname, "../fixtures/mini-app");

async function freePort(): Promise<number> {
	return new Promise((res) => {
		const s = createServer().listen(0, () => {
			const p = (s.address() as { port: number }).port;
			s.close(() => res(p));
		});
	});
}

const step = (id: string, compare: Step["compare"] = "data"): Step => ({ id, route: `GET /${id}`, compare, method: "GET", path: `/${id}` });

describe("comparing the old and the new app", () => {
	it("only what differs between two runs of the old app is noise; the rest is a difference", () => {
		const s = [step("a")];
		const old1: StepResult[] = [{ status: 200, body: { total: 10, at: 1 } }];
		const old2: StepResult[] = [{ status: 200, body: { total: 10, at: 2 } }];
		const neu: StepResult[] = [{ status: 200, body: { total: 11, at: 3 } }];
		const c = compareRuns(s, old1, old2, neu, false);
		expect(c.diffs).toEqual([{ step: "a", route: "GET /a", kind: "body", path: "body.total", legacy: 10, target: 11 }]);
		expect(c.compared).toBe(1);
	});

	it("a step the old app itself fails on proves nothing; a new app that does not answer is a difference", () => {
		const s = [step("a"), step("b")];
		const c = compareRuns(s, [{ status: 500, body: "" }, { status: 200, body: 1 }], [{ status: 500, body: "" }, { status: 200, body: 1 }], [{ status: 200, body: "" }, { error: "ECONNREFUSED" }], false);
		expect(c.notCompared).toEqual(["a (the old app: status 500)"]);
		expect(c.diffs).toMatchObject([{ step: "b", kind: "error", target: "ECONNREFUSED" }]);
	});

	it("a second old run that failed is not compared: its missing answer must not count as noise and hide differences", () => {
		const c = compareRuns([step("a")], [{ status: 200, body: { total: 10 } }], [{ error: "ECONNRESET" }], [{ status: 404, body: "" }], false);
		expect(c.notCompared).toEqual(["a (the old app's second run: ECONNRESET)"]);
		expect(c.compared).toBe(0);
	});

	it("what a step wrote is compared as rows added and removed", () => {
		expect(dataChanges({ t: [{ id: 1 }] }, { t: [{ id: 1 }, { id: 2 }], u: [] })).toEqual({ t: { added: [{ id: 2 }], removed: [] } });
		const s = [{ ...step("p", "redirect"), method: "POST" }];
		const w = (n: number): StepResult => ({ status: 302, location: "/x", data: { t: { added: [{ id: 2, total: n }], removed: [] } } });
		expect(compareRuns(s, [w(5)], [w(5)], [w(6)], true).diffs).toMatchObject([{ kind: "data", path: "data.t.added[0].total" }]);
		expect(compareRuns(s, [w(5)], [w(5)], [w(6)], false).diffs).toEqual([]);
	});

	it("an http → https redirect of the old app to itself reaches no handler: not compared, and the old app is marked for another probe", async () => {
		const serve = (to: (host: string) => string) =>
			new Promise<{ base: string; close: () => void }>((res) => {
				const s = createServer((q, r) => r.writeHead(301, { location: to(q.headers.host!) }).end()).listen(0, () => {
					res({ base: `http://localhost:${(s.address() as { port: number }).port}/`, close: () => s.close() });
				});
			});
		const [a, b, c] = [await serve((h) => `https://${h}/x?y=1`), await serve((h) => `https://${h}/x?y=1`), await serve(() => "https://elsewhere.example/x?y=1")];
		try {
			const s = [step("r", "redirect")];
			const [ra, rb, rc] = await Promise.all([a, b, c].map((app) => runSteps(s, { side: "legacy", base: () => app.base })));
			expect(ra![0]!.location).toBe("https://(this app)/x?y=1");
			expect(selfRedirect(ra![0]!)).toBe(true);
			// both apps forcing https says nothing about the handler, and neither does one that does not
			for (const neu of [rb!, rc!]) expect(compareRuns(s, ra!, ra!, neu, false)).toEqual({ diffs: [], compared: 0, notCompared: ["r (the old app only redirects it to itself: 301 → https://(this app)/x?y=1)"] });
			// a redirect somewhere else is the handler's answer, and still compared
			expect(selfRedirect(rc![0]!)).toBe(false);
			expect(compareRuns(s, rc!, rc!, ra!, false).diffs).toMatchObject([{ kind: "redirect" }]);
		} finally {
			for (const app of [a, b, c]) app.close();
		}
	});

	it("a page step compares its status, so a page the new app does not have is a difference", () => {
		const s = [step("p", "page")];
		const c = compareRuns(s, [{ status: 200, body: "<html>" }], [{ status: 200, body: "<html>!" }], [{ status: 404, body: "" }], false);
		expect(c.diffs).toMatchObject([{ step: "p", kind: "status", legacy: 200, target: 404 }]);
	});

	it("every slice route needs a compared step or a reason it has none", () => {
		expect(stepsProblem({ steps: [step("a")] }, ["GET /a", "GET /b"], ["nestjs"])).toMatch(/GET \/b/);
		expect(stepsProblem({ steps: [step("a")], skipped: { "GET /b": "needs a payment provider" } }, ["GET /a", "GET /b"], ["nestjs"])).toBeUndefined();
		// a login step does not cover a route
		expect(stepsProblem({ steps: [step("a", "none")] }, ["GET /a"], ["nestjs"])).toMatch(/GET \/a/);
		// a step may name its route without the method word or the leading slash
		expect(stepsProblem({ steps: [{ ...step("a"), route: "dashboard/ajax" }, { ...step("b"), route: "/ssp/dashboard" }] }, ["ANY dashboard/ajax", "ANY ssp/dashboard"], ["nestjs"])).toBeUndefined();
		expect(stepsProblem({ steps: [{ ...step("a"), route: "dashboard/ajax" }] }, ["ANY dashboard/ajax", "ANY ssp/dashboard"], ["nestjs"])).toMatch(/ANY ssp\/dashboard/);
	});

	it("a slice may skip at most half its routes; with a test account its steps must log in", () => {
		const routes = ["GET /a", "GET /b", "GET /c", "GET /d"];
		const skip = (...r: string[]) => Object.fromEntries(r.map((x) => [x, "needs an existing id"]));
		expect(stepsProblem({ steps: [step("a")], skipped: skip("GET /b", "GET /c", "GET /d") }, routes, ["nestjs"])).toMatch(/3 of 4 routes are only skipped/);
		expect(stepsProblem({ steps: [step("a"), step("b")], skipped: skip("GET /c", "GET /d") }, routes, ["nestjs"])).toBeUndefined();
		// one route of one is not "most": a slice with a single route that cannot be called still passes
		expect(stepsProblem({ steps: [step("x")], skipped: skip("GET /a") }, ["GET /a"], ["nestjs"])).toBeUndefined();
		expect(skippedRoutes({ steps: [step("a")], skipped: skip("GET /a", "GET /b") }, routes)).toEqual(["GET /b"]);
		const steps = [step("a"), step("b"), step("c"), step("d")];
		expect(stepsProblem({ steps }, routes, ["nestjs"], { login: true })).toMatch(/test account is known: log in first/);
		expect(stepsProblem({ steps: [{ ...step("in", "none"), route: "setup", method: "POST", path: "/login" }, ...steps] }, routes, ["nestjs"], { login: true })).toBeUndefined();
	});

	it("a step after the login that the old app sends back to the login page is not compared: only the login wall was seen", () => {
		const s: Step[] = [step("before"), { ...step("in", "none"), route: "setup", method: "POST", path: "/login" }, step("a"), step("b")];
		const old: StepResult[] = [{ status: 302, location: "/login" }, { status: 302, location: "/" }, { status: 302, location: "/login?back=%2Fa" }, { status: 200, body: 1 }];
		expect([...loginWall(s, old)]).toEqual([2]);
		const c = compareRuns(s, old, old, [{ status: 302, location: "/login" }, {}, { status: 200 }, { status: 200, body: 1 }], false);
		// the logged-out step before the login is still compared
		expect(c.compared).toBe(2);
		expect(c.notCompared).toEqual(["a (the old app sends it to the login page: the login before it did not hold)"]);
	});

	it("the new app sending every page after the login back to its login page is a login that did not hold: not compared, no difference", () => {
		const s = [step("a"), { ...step("in", "none"), path: "/login" }, step("b"), step("c")];
		const old: StepResult[] = [{ status: 302, location: "/login" }, {}, { status: 200, body: 1 }, { status: 200, body: 2 }];
		const c = compareRuns(s, old, old, [{ status: 302, location: "/login" }, {}, { status: 302, location: "/login" }, { status: 302, location: "/login" }], false);
		expect(c.newLoginFailed).toBe(true);
		expect(c.diffs).toEqual([]);
		expect(c.notCompared).toEqual(["b (the new app sends it to the login page: the comparison's login did not hold there)", "c (the new app sends it to the login page: the comparison's login did not hold there)"]);
		// only some pages back at the login: the login held, those pages differ
		const some = compareRuns(s, old, old, [{ status: 302, location: "/login" }, {}, { status: 302, location: "/login" }, { status: 200, body: 2 }], false);
		expect(some.newLoginFailed).toBeUndefined();
		expect(some.diffs.map((d) => d.step)).toContain("b");
	});

	it("a saved token whose pattern misses is read from the form field the login sends it in, attributes in any order", async () => {
		expect(fieldValue('<input type="hidden" value="t0k" name="csrf_f" class="hidden" />', "csrf_f")).toBe("t0k");
		expect(fieldValue("<input name='csrf_f' type=hidden value='a b'>", "csrf_f")).toBe("a b");
		expect(fieldValue('{"form":{"csrf_f":"j1"}}', "csrf_f")).toBe("j1");
		expect(fieldValue("<p>none</p>", "csrf_f")).toBeUndefined();
		const port = await freePort();
		let posted = "";
		const server = createServer((q, r) => {
			if (q.method === "GET") return void r.end('<form><input type="hidden" value="T123" name="csrf_f"></form>');
			let b = "";
			q.on("data", (d) => (b += d)).on("end", () => ((posted = b), r.end("ok")));
		}).listen(port);
		try {
			const steps: Step[] = [
				{ id: "s0", route: "setup", compare: "none", method: "GET", path: "/login", save: { csrf: 'name="csrf_f"\\s+value="([^"]+)"' } },
				{ id: "s00", route: "setup", compare: "none", method: "POST", path: "/login", form: { user: "u", csrf_f: "{{csrf}}" } },
			];
			await runSteps(steps, { side: "target", base: () => `http://localhost:${port}` });
			expect(posted).toBe("user=u&csrf_f=T123");
		} finally {
			server.close();
		}
	});

	it("each app's own address and a dump's base64 text are the harness's noise, not a difference", async () => {
		const text = "_GYSS__|history|s:35:\"http://127.0.0.1:18081/api/rest/doc\";";
		expect(plainValue({ data: { base64: Buffer.from(text).toString("base64") }, n: 1 }, ["127.0.0.1:18081"])).toEqual({ data: '_GYSS__|history|s:35:"http://(this app)/api/rest/doc";', n: 1 });
		// line endings never make two text answers differ
		expect(textBody("<html>\r\n  <p>not found</p>\r\n</html>", [])).toBe(textBody("<html>\n  <p>not found</p>\n</html>", []));
		expect(plainValue("http://localhost:18080/x?to=http%3A%2F%2Flocalhost%3A18080%2Fy", ["localhost:18080"])).toBe(`http://(this app)/x?to=http%3A%2F%2F${encodeURIComponent("(this app)")}%2Fy`);
		// bytes that are no text stay as they are
		const bin = { base64: Buffer.from([0xff, 0xfe, 0x00]).toString("base64") };
		expect(plainValue(bin, [])).toEqual(bin);
		// runSteps: body and written rows of both apps come out alike
		const port = await freePort();
		const server = createServer((q, s) => s.end(JSON.stringify({ back: `http://localhost:${port}/a` }))).listen(port);
		try {
			let n = 0;
			const dump = () => ({ sessions: n++ ? [{ url: { base64: Buffer.from(`http://localhost:${port}/a`).toString("base64") } }] : [] });
			const [r] = await runSteps([{ ...step("p"), method: "POST" }], { side: "legacy", base: () => `http://localhost:${port}/`, dump });
			expect(r).toMatchObject({ status: 200, body: { back: "http://(this app)/a" }, data: { sessions: { added: [{ url: "http://(this app)/a" }], removed: [] } } });
		} finally {
			server.close();
		}
	});

	it("a slice end to end: steps written once, the old app run twice, the new app in a worktree of main, differences in the ledger", async () => {
		const root = mkdtempSync(join(tmpdir(), "br-paritycheck-"));
		const legacy = join(root, "legacy");
		cpSync(FIXTURE, legacy, { recursive: true });
		const [oldPort, newPort] = [await freePort(), await freePort()];
		// the old app: a login cookie is needed for the invoice; POST redirects with 302
		writeFileSync(
			join(legacy, "server.js"),
			`require('http').createServer((q, s) => {
				if (q.headers['x-force-https']) return s.writeHead(301, { location: 'https://' + q.headers.host + q.url }).end();
				if (q.method === 'POST') return s.writeHead(302, { location: '/invoices' }).end();
				if (q.url === '/login') return s.writeHead(200, { 'set-cookie': 'sid=abc; Path=/' }).end('ok');
				if (q.url === '/invoices') return s.end(JSON.stringify({ count: 2, at: Date.now() + Math.random() }));
				if (q.url === '/invoices/1') return s.end(JSON.stringify(q.headers.cookie === 'sid=abc' ? { id: 1, total: 10 } : { error: 'login' }));
				s.writeHead(404).end();
			}).listen(${oldPort});\n`,
		);
		// the new app: the invoice moved to /api, its total is wrong, POST answers 303
		const target = join(root, "new");
		mkdirSync(target, { recursive: true });
		writeFileSync(
			join(target, "server.js"),
			`require('http').createServer((q, s) => {
				if (q.method === 'POST') return s.writeHead(303, { location: '/invoices' }).end();
				if (q.url === '/login') return s.writeHead(200, { 'set-cookie': 'sid=abc; Path=/' }).end('ok');
				if (q.url === '/invoices') return s.end(JSON.stringify({ count: 2, at: Date.now() + Math.random() }));
				if (q.url === '/api/invoices/1') return s.end(JSON.stringify(q.headers.cookie === 'sid=abc' ? { id: 1, total: 11 } : { error: 'login' }));
				s.writeHead(404).end();
			}).listen(${newPort});\n`,
		);
		const git = (...a: string[]) => execFileSync("git", ["-C", target, ...a], { stdio: "pipe" });
		git("init", "-q");
		git("add", ".");
		git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");

		const config = ConfigSchema.parse({ source: { path: legacy, stack: "php" }, target: { path: target, stacks: ["nestjs"] }, models: {}, db: { strategy: "none" } });
		const ledger = new Ledger(":memory:");
		await inventory(config, legacy, ledger);
		applySlicePlan(ledger, planSlices(ledger));
		await (legacyCopyTool(root, config) as unknown as { execute: (id: string, p: object) => Promise<unknown> }).execute("x", { why: "copy" });
		mkdirSync(join(root, ".bigrefactor", "parity"), { recursive: true });
		const recipe = (port: number) => ({ dir: ".", start: { cmd: process.execPath, args: ["server.js"] }, ready: `http://localhost:${port}/invoices` });
		writeFileSync(join(root, ".bigrefactor", "parity", "apps.json"), JSON.stringify({ legacy: { up: true, recipe: recipe(oldPort) }, nestjs: { up: true, recipe: recipe(newPort) } }));

		let writes = 0;
		const writer: StepWriter = async (o) => {
			writes++;
			expect(o.problem).toMatch(/GET \/invoices\/\{id\}/);
			const steps: Step[] = [
				{ id: "login", route: "setup", compare: "none", method: "GET", path: "/login" },
				{ id: "list", route: "GET /invoices", compare: "data", method: "GET", path: "/invoices" },
				{ id: "one", route: "GET /invoices/{id}", compare: "data", method: "GET", path: "/invoices/1", target: { path: "/api/invoices/1" } },
				{ id: "add", route: "POST /invoices", compare: "redirect", method: "POST", path: "/invoices", form: { amount: "5" } },
			];
			writeFileSync(join(o.dir, "steps.json"), JSON.stringify({ steps }));
		};
		// each app gets its test account before the steps are checked: the old app has one now, so steps must log in
		const asked: string[][] = [];
		const ensureLogins = async (sides: string[]) => (asked.push(sides), void saveApp(root, LEGACY, { login: { user: "t", password: "p", steps: [{ method: "GET", path: "/login" }] } }));
		const r = await checkSlice({ ledger, config, root, slice: "invoices", linkAll: () => {}, serverStack: "nestjs", writer, log: () => {}, ensureLogins });
		expect(asked).toEqual([["nestjs"]]);
		expect(ledger.db.prepare("SELECT skipped FROM parity_runs WHERE id = ?").get(r.runId!)).toMatchObject({ skipped: 0 });
		expect(r.outcome).toBe("differs");
		expect(r.compared).toBe(3);
		expect(r.diffs.map((d) => `${d.step} ${d.path}`).sort()).toEqual(["add status", "one body.total"]);
		const rows = ledger.db.prepare("SELECT step, kind, legacy, target FROM parity_diffs ORDER BY step").all();
		expect(rows).toEqual([
			{ step: "add", kind: "status", legacy: "302", target: "303" },
			{ step: "one", kind: "body", legacy: "10", target: "11" },
		]);
		// steps are kept: a second check does not write them again
		await checkSlice({ ledger, config, root, slice: "invoices", linkAll: () => {}, serverStack: "nestjs", writer, log: () => {} });
		expect(writes).toBe(1);
		// an old app that only sends requests on to itself over https: nothing is compared, and it is marked for another probe
		const hop: StepWriter = async (o) => {
			const steps: Step[] = [{ id: "in", route: "setup", compare: "none", method: "GET", path: "/login" }, { id: "list", route: "GET /invoices", compare: "data", method: "GET", path: "/invoices", headers: { "x-force-https": "1" } }];
			writeFileSync(join(o.dir, "steps.json"), JSON.stringify({ steps, skipped: { "GET /invoices/{id}": "t", "POST /invoices": "t" } }));
		};
		const h = await checkSlice({ ledger, config, root, slice: "invoices", linkAll: () => {}, serverStack: "nestjs", writer: hop, rewrite: true, log: () => {} });
		expect(h).toMatchObject({ outcome: "error", compared: 0, diffs: [] });
		// the routes it skipped are recorded with the run
		expect(h.note).toMatch(/1 of 3 route\(s\) skipped/);
		expect(ledger.db.prepare("SELECT skipped FROM parity_runs WHERE id = ?").get(h.runId!)).toMatchObject({ skipped: 1 });
		expect(loadApps(root)[LEGACY]!.selfRedirect).toBe("GET /invoices → 301 https://(this app)/invoices");
		// a new app that does not start on main: said as such, so the run hands it to the builder as a main problem
		const broken = { dir: ".", start: { cmd: process.execPath, args: ["-e", "console.error('no such mapping dir'); process.exit(1)"] }, ready: `http://localhost:${newPort}/invoices` };
		writeFileSync(join(root, ".bigrefactor", "parity", "apps.json"), JSON.stringify({ legacy: { up: true, recipe: recipe(oldPort) }, nestjs: { up: true, recipe: broken } }));
		const d = await checkSlice({ ledger, config, root, slice: "invoices", linkAll: () => {}, serverStack: "nestjs", writer, log: () => {} });
		expect(d.outcome).toBe("error");
		expect(d.down).toMatchObject({ stack: "nestjs", error: expect.stringMatching(/no such mapping dir/) });
	}, 60_000);

	it("an app whose data reset fails goes to its setup fixer and the check goes on; one never fixed is recorded as setup, not as an error of the code", async () => {
		const root = mkdtempSync(join(tmpdir(), "br-paritysetup-"));
		const legacy = join(root, "legacy");
		cpSync(FIXTURE, legacy, { recursive: true });
		const [oldPort, newPort] = [await freePort(), await freePort()];
		const server = (body: string) => `require('http').createServer((q, s) => s.end(${JSON.stringify(body)})).listen(Number(process.argv[2]));\n`;
		writeFileSync(join(legacy, "server.js"), server("[1]"));
		const target = join(root, "new");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "server.js"), server("[1]"));
		const git = (...a: string[]) => execFileSync("git", ["-C", target, ...a], { stdio: "pipe" });
		git("init", "-q");
		git("add", ".");
		git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
		const config = ConfigSchema.parse({ source: { path: legacy, stack: "php" }, target: { path: target, stacks: ["nestjs"] }, models: {}, db: { strategy: "none" } });
		const ledger = new Ledger(":memory:");
		await inventory(config, legacy, ledger);
		applySlicePlan(ledger, planSlices(ledger));
		await (legacyCopyTool(root, config) as unknown as { execute: (id: string, p: object) => Promise<unknown> }).execute("x", { why: "copy" });
		mkdirSync(join(root, ".bigrefactor", "parity"), { recursive: true });
		// the reset prints a notice, and fails while the "broken" file exists (a stopped database, say)
		const broken = join(root, "broken");
		const reset = { cmd: process.execPath, args: ["-e", `console.error('OrbStack is already running.'); process.exit(require('fs').existsSync(${JSON.stringify(broken)}) ? 1 : 0)`] };
		const recipe = (port: number) => ({ dir: ".", start: { cmd: process.execPath, args: ["server.js", String(port)] }, ready: `http://localhost:${port}/invoices`, reset });
		const apps = () => writeFileSync(join(root, ".bigrefactor", "parity", "apps.json"), JSON.stringify({ legacy: { up: true, recipe: recipe(oldPort) }, nestjs: { up: true, recipe: recipe(newPort) } }));
		apps();
		const writer: StepWriter = async (o) => {
			const steps: Step[] = [{ id: "list", route: "GET /invoices", compare: "data", method: "GET", path: "/invoices" }];
			writeFileSync(join(o.dir, "steps.json"), JSON.stringify({ steps, skipped: { "GET /invoices/{id}": "t", "POST /invoices": "t" } }));
		};
		const check = (fixSetup?: (side: string, error: string) => Promise<boolean>) => checkSlice({ ledger, config, root, slice: "invoices", linkAll: () => {}, serverStack: "nestjs", writer, log: () => {}, fixSetup });
		// the fixer gets the side and what failed, fixes it, the comparison runs
		writeFileSync(broken, "");
		const asked: string[] = [];
		const fixes = async (side: string, error: string) => (asked.push(`${side}: ${error}`), rmSync(broken), true);
		// The reset is fixed and the list compares, but skipped routes prevent a whole-slice pass.
		expect(await check(fixes)).toMatchObject({ outcome: "error", compared: 1, note: expect.stringContaining("skipped") });
		expect(asked).toHaveLength(1);
		expect(asked[0]).toMatch(/^legacy: the data reset failed \(.* it exited with status 1\); its output: OrbStack is already running/);
		// a fixer that says it fixed it but did not: tried MAX_SETUP_RETRIES times, then recorded as setup with what failed
		writeFileSync(broken, "");
		asked.length = 0;
		const r = await check(async (side, error) => (asked.push(`${side}: ${error}`), true));
		expect(asked).toHaveLength(MAX_SETUP_RETRIES);
		expect(r).toMatchObject({ outcome: "setup", compared: 0, setup: { side: LEGACY } });
		expect(r.note).toMatch(/^setup: the old app did not start: the data reset failed/);
		expect(ledger.db.prepare("SELECT outcome FROM parity_runs WHERE id = ?").get(r.runId!)).toEqual({ outcome: "setup" });
		// the new app's data reset failing is its setup too, not a main the builder must fix
		rmSync(broken);
		const newOnly = { ...recipe(newPort), reset: { cmd: process.execPath, args: ["-e", "process.exit(3)"] } };
		writeFileSync(join(root, ".bigrefactor", "parity", "apps.json"), JSON.stringify({ legacy: { up: true, recipe: recipe(oldPort) }, nestjs: { up: true, recipe: newOnly } }));
		asked.length = 0;
		const n = await check(async (side, error) => (asked.push(`${side}: ${error}`), false));
		expect(n).toMatchObject({ outcome: "setup", setup: { side: "nestjs" } });
		expect(n.down).toBeUndefined();
		expect(asked).toEqual([expect.stringMatching(/^nestjs: the data reset failed .*status 3/)]);
		// the new app's own start failing (a stopped database makes it exit, say) goes to its setup first too: fixed, compared
		const down = join(root, "db-down");
		const starts = (port: number) => ({ ...recipe(port), reset: undefined, start: { cmd: process.execPath, args: ["-e", `if (require('fs').existsSync(${JSON.stringify(down)})) process.exit(5); require('http').createServer((q, s) => s.end('[1]')).listen(Number(process.argv[1]))`, String(port)] } });
		writeFileSync(join(root, ".bigrefactor", "parity", "apps.json"), JSON.stringify({ legacy: { up: true, recipe: recipe(oldPort) }, nestjs: { up: true, recipe: starts(newPort) } }));
		writeFileSync(down, "");
		asked.length = 0;
		expect(await check(async (side, error) => (asked.push(`${side}: ${error}`), rmSync(down), true))).toMatchObject({ outcome: "error", compared: 1 });
		expect(asked).toEqual([expect.stringMatching(/^nestjs: the start command exited with 5/)]);
		// one its setup cannot fix: after MAX_SETUP_RETRIES tries it is main's code, the builder's
		writeFileSync(down, "");
		asked.length = 0;
		const s = await check(async (side, error) => (asked.push(`${side}: ${error}`), true));
		expect(asked).toHaveLength(MAX_SETUP_RETRIES);
		expect(s).toMatchObject({ outcome: "error", down: { stack: "nestjs" } });
		expect(s.note).toMatch(/its setup could not fix it/);
		expect(s.setup).toBeUndefined();
	}, 90_000);
});
