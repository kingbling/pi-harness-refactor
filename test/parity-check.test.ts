import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { inventory } from "../src/inventory/run.ts";
import { applySlicePlan, planSlices } from "../src/inventory/slices.ts";
import { Ledger } from "../src/ledger/db.ts";
import { legacyCopyTool } from "../src/run/legacy-env.ts";
import { LEGACY, loadApps } from "../src/run/parity.ts";
import { checkSlice, compareRuns, dataChanges, runSteps, selfRedirect, stepsProblem, type Step, type StepResult, type StepWriter } from "../src/run/parity-check.ts";

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
		const r = await checkSlice({ ledger, config, root, slice: "invoices", linkAll: () => {}, serverStack: "nestjs", writer, log: () => {} });
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
			const steps: Step[] = [{ id: "list", route: "GET /invoices", compare: "data", method: "GET", path: "/invoices", headers: { "x-force-https": "1" } }];
			writeFileSync(join(o.dir, "steps.json"), JSON.stringify({ steps, skipped: { "GET /invoices/{id}": "t", "POST /invoices": "t" } }));
		};
		const h = await checkSlice({ ledger, config, root, slice: "invoices", linkAll: () => {}, serverStack: "nestjs", writer: hop, rewrite: true, log: () => {} });
		expect(h).toMatchObject({ outcome: "error", compared: 0, diffs: [] });
		expect(loadApps(root)[LEGACY]!.selfRedirect).toBe("GET /invoices → 301 https://(this app)/invoices");
		// a new app that does not start on main: said as such, so the run hands it to the builder as a main problem
		const broken = { dir: ".", start: { cmd: process.execPath, args: ["-e", "console.error('no such mapping dir'); process.exit(1)"] }, ready: `http://localhost:${newPort}/invoices` };
		writeFileSync(join(root, ".bigrefactor", "parity", "apps.json"), JSON.stringify({ legacy: { up: true, recipe: recipe(oldPort) }, nestjs: { up: true, recipe: broken } }));
		const d = await checkSlice({ ledger, config, root, slice: "invoices", linkAll: () => {}, serverStack: "nestjs", writer, log: () => {} });
		expect(d.outcome).toBe("error");
		expect(d.down).toMatchObject({ stack: "nestjs", error: expect.stringMatching(/no such mapping dir/) });
	}, 60_000);
});
