import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { dumpData, type AppRecipe } from "../src/run/parity.ts";
import { runSteps, type Step } from "../src/run/parity-check.ts";
import { runContracts, strictSuiteProblems, type ParityContract } from "../src/run/parity-contracts.ts";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "br-observation-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const contextCode = "console.log(JSON.stringify({context:[Object.fromEntries(['SIDE','SLICE','PHASE','STEP'].map(k=>[k,process.env['BR_PARITY_'+k]]))]}))";
const recipe = (code = contextCode): AppRecipe => ({ dir: ".", ready: "http://localhost:1", start: { cmd: process.execPath, args: [] }, dump: { cmd: process.execPath, args: ["-e", code] }, env: { BR_PARITY_SIDE: "spoofed", BR_PARITY_SLICE: "spoofed", BR_PARITY_PHASE: "spoofed", BR_PARITY_STEP: "spoofed" } });
const contract = (code: string): ParityContract => ({ id: "observe", kind: "data", why: "complete fixture observation", covers: [], inputs: ["fixture.json"], command: { cmd: process.execPath, args: ["-e", code] } });

describe("bounded observations in the actual scenario", () => {
	it("supplies the explicit slice, side and phase to a dump instead of recipe variables", async () => {
		const data = await dumpData(recipe(), temp(), { slice: "data", side: "legacy", phase: "initial" });
		expect(data).toEqual({ context: [{ SIDE: "legacy", SLICE: "data", PHASE: "initial", STEP: "" }] });
	});
	it("probe dumps clear inherited scenario state", async () => {
		const data = await dumpData(recipe(), temp());
		expect(data).toEqual({ context: [{ SIDE: "", SLICE: "", PHASE: "probe", STEP: "" }] });
	});
	it("passes initial and each compared HTTP step through to the real dump process", async () => {
		const dir = temp(), observed: unknown[] = [];
		const server = createServer((_q, r) => r.end("ok")).listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const step: Step = { id: "refresh", route: "GET /refresh", path: "/refresh", method: "GET", compare: "data" };
		try {
			for (const side of ["legacy", "target"] as const) await runSteps([step], {
				side, slice: "login", strict: true,
				base: () => `http://127.0.0.1:${(server.address() as { port: number }).port}`,
				dump: async context => { const data = await dumpData(recipe(), dir, context); observed.push(data.context![0]); return { users: [] }; },
			});
			expect(observed).toEqual([
				{ SIDE: "legacy", SLICE: "login", PHASE: "initial", STEP: "" }, { SIDE: "legacy", SLICE: "login", PHASE: "step", STEP: "refresh" },
				{ SIDE: "target", SLICE: "login", PHASE: "initial", STEP: "" }, { SIDE: "target", SLICE: "login", PHASE: "step", STEP: "refresh" },
			]);
		} finally { await new Promise<void>(resolve => server.close(() => resolve())); }
	});
	it("route-less data suites still receive a full initial observation", async () => {
		const calls: unknown[] = [];
		await runSteps([], { side: "legacy", slice: "data", base: () => "http://localhost:1", dump: context => { calls.push(context); return { all_records: [] }; } });
		expect(calls).toEqual([{ side: "legacy", slice: "data", phase: "initial" }]);
	});
	it("contract drivers get their slice and a fresh contract phase", async () => {
		const dir = temp(), config = ConfigSchema.parse({ source: { path: dir, stack: "php" }, target: { path: dir, stacks: ["nestjs"] }, models: {} });
		const result = await runContracts([contract(contextCode)], { root: dir, config, side: "legacy", slice: "data", appDir: dir, urls: {} });
		expect(result[0]?.observations).toEqual({ context: [{ SIDE: "legacy", SLICE: "data", PHASE: "contract", STEP: "" }] });
	});
	it("a browser check's driver can require the plugin's Playwright and open a page in headless Chromium", async () => {
		const dir = temp(), config = ConfigSchema.parse({ source: { path: dir, stack: "php" }, target: { path: dir, stacks: ["nestjs"] }, models: {} });
		const server = createServer((_q, r) => r.end("<title>Deals</title><script>document.write('<p>rendered by script</p>')</script>")).listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		writeFileSync(join(dir, "page.cjs"), `const { chromium } = require("playwright");
(async () => {
	const browser = await chromium.launch({ headless: true }), page = await browser.newPage();
	await page.goto(JSON.parse(process.env.BR_PARITY_URLS).legacy);
	console.log(JSON.stringify({ title: await page.title(), text: await page.locator("p").innerText() }));
	await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
`);
		try {
			const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
			const [result] = await runContracts([{ id: "page", kind: "browser", why: "the page renders", covers: [], inputs: ["page.cjs"], command: { cmd: process.execPath, args: ["page.cjs"] } }], { root: dir, config, side: "legacy", appDir: dir, urls: { legacy: url } });
			expect(result).toEqual({ id: "page", observations: { title: "Deals", text: "rendered by script" } });
		} finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
	}, 60_000);
	it("honors a dump's explicit time limit", async () => {
		const r = recipe("setTimeout(()=>console.log('{\"rows\":[]}'),300)"); r.dump!.timeoutMs = 80;
		await expect(dumpData(r, temp())).rejects.toThrow(/timed out after 80ms/);
	});
	it("honors a contract's explicit time limit", async () => {
		const dir = temp(), config = ConfigSchema.parse({ source: { path: dir, stack: "php" }, target: { path: dir, stacks: ["nestjs"] }, models: {} });
		const result = await runContracts([{ ...contract("setTimeout(()=>console.log('{\"rows\":[]}'),300)"), timeoutMs: 80 }], { root: dir, config, side: "target", appDir: dir, urls: {} });
		expect(result[0]?.observations).toBeUndefined();
		expect(result[0]?.error).toMatch(/timed out after 80ms/);
	});
	it("rejects invalid and unbounded time limits before running a dump or accepting a suite", async () => {
		const dir = temp(); writeFileSync(join(dir, "fixture.json"), "{}");
		for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 86_400_001, "600000"]) {
			const r = recipe("console.log('{\"rows\":[]}')"); r.dump!.timeoutMs = timeoutMs as number;
			await expect(dumpData(r, dir)).rejects.toThrow(/timeoutMs must be an integer/);
			expect(strictSuiteProblems({ steps: [], checks: [{ ...contract("0"), timeoutMs: timeoutMs as number }] }, [], dir).join("\n")).toMatch(/timeoutMs must be an integer/);
		}
	});
	it("terminates a dump's background descendants even when the parent reports success", async () => {
		const dir = temp(), marker = join(dir, "orphan-wrote-data");
		const grandchild = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'orphan'),250)`;
		const code = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});c.unref();console.log('{"rows":[]}');`;
		expect(await dumpData(recipe(code), dir)).toEqual({ rows: [] });
		await new Promise(resolve => setTimeout(resolve, 500));
		expect(existsSync(marker)).toBe(false);
	});
});
