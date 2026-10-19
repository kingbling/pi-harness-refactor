import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getSourceAdapter, registerGeneratedSources } from "../src/adapters/registry.ts";
import { exampleSourceManifest } from "../src/adapters/source/generated.ts";
import { expressProfileExample } from "../src/adapters/source/profile.ts";
import { ConfigSchema } from "../src/config.ts";
import { inventory } from "../src/inventory/run.ts";
import { Ledger } from "../src/ledger/db.ts";
import { ONLY_COMMENTS, runGate, type GateInput } from "../src/run/gate.ts";
import { runUnit } from "../src/run/unit.ts";
import type { LeafSession, SpawnOptions } from "../src/sessions/spawn.ts";

/**
 * The pipeline on a legacy app that is not PHP (fixtures/mini-express), offline: a generated source adapter (the
 * JavaScript manifest) and the Express profile index it, the inventory makes units, and one unit runs through
 * runUnit with scripted sessions: the tester's Node truth script runs on the old code by code, then the real gate
 * (scope, anti-gaming, the parse-tree comment check, symbol proofs, structure) with build, lint and tests as no-ops.
 */
const here = resolve(import.meta.dirname, "..");
const write = (p: string, s: string) => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, s));
const UNIT = "U001_lib_money";
const SERVICE = "src/features/invoices/invoices.service.ts";
const NOTE = "src/features/invoices/invoices.types.ts";

describe("a non-PHP legacy app through inventory, truth and the gate", () => {
	it("an Express app: indexed by the generated adapter, its unit's truth runs on the old code, the gate refuses a comment-only file and then accepts", async () => {
		const ws = join(here, ".sim", "express-pipeline");
		rmSync(ws, { recursive: true, force: true });
		const legacy = join(ws, "legacy");
		cpSync(join(here, "fixtures", "mini-express"), legacy, { recursive: true });
		write(join(ws, ".bigrefactor", "adapters", "source", "javascript.json"), JSON.stringify(exampleSourceManifest()));
		write(join(ws, ".bigrefactor", "framework-profile.json"), JSON.stringify(expressProfileExample()));
		process.env["BR_WORKSPACE"] = ws;
		registerGeneratedSources(ws);
		getSourceAdapter("javascript").reloadProfile?.();
		const target = join(ws, "migrated");
		write(join(target, "package.json"), JSON.stringify({ name: "sim", private: true, devDependencies: { vitest: "x" } }));
		write(join(target, ".gitignore"), "node_modules/\n");
		write(join(target, "src", "app.module.ts"), "import { Module } from '@nestjs/common';\n\n@Module({ imports: [] })\nexport class AppModule {}\n");
		const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: target });
		git("init", "-q", "-b", "migration/main");
		git("add", "-A");
		git("commit", "-qm", "bootstrap");
		const config = ConfigSchema.parse({ source: { path: legacy, stack: "javascript" }, target: { path: target, stacks: ["nestjs"], git: { branch: "migration/main" } }, models: {}, run: { maxImplementAttempts: 2, maxEscalateAttempts: 0 } });
		const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));

		// inventory: files, symbols, the route, the dead file, one unit per file
		const inv = await inventory(config, ws, ledger);
		expect(inv.invariantsOk).toBe(true);
		expect(inv.dead).toEqual(["old/export.js"]);
		expect(ledger.db.prepare("SELECT method, path, handler_symbol h FROM index_routes").all()).toEqual([{ method: "GET", path: "/invoices/total", h: "lib/handlers.js::invoiceTotal" }]);
		expect(ledger.symbolsOfUnit(UNIT).map((s) => s.id).sort()).toEqual(["lib/money.js::addTax", "lib/money.js::round2"]);
		// the profile's loader on an object (res.render) gives a load edge, as Load::models does in PHP
		const shown = await getSourceAdapter("javascript").indexFile(legacy, "lib/show.js", 'function show(req, res) {\n  res.render("invoice");\n}\n');
		expect(shown.deps).toContainEqual({ from: "lib/show.js::show", to: "glob:views/invoice.ejs", kind: "load" });
		ledger.updateUnit(UNIT, { meta: { place: { stack: "nestjs", area: "invoices", shared: false, source: "code" } } });

		// scripted sessions: the tester writes a Node truth script and a spec; the implementer ports the two functions,
		// leaving a file with only comments on its first try
		const usage = { input: 0, output: 0, cost: 0 };
		let tries = 0;
		const spawn = (async (o: SpawnOptions): Promise<LeafSession> =>
			({
				async run() {
					const base = o.globRoot ?? o.cwd;
					if (o.role === "test") {
						write(join(base, ".bigrefactor", "truth", UNIT, "cases.cjs"), `const { round2, addTax } = require(require("path").join(process.cwd(), "lib/money.js"));\nconsole.log(JSON.stringify([\n  { symbol: "lib/money.js::round2", inputs: [2.345], expected: round2(2.345) },\n  { symbol: "lib/money.js::addTax", inputs: [10, 0.2], expected: addTax(10, 0.2) },\n]));\n`);
						write(join(base, ".bigrefactor", "truth", UNIT, "interface.md"), `${SERVICE} exports InvoicesService with round2 and addTax\n`);
						write(join(target, "src/features/invoices/invoices.service.spec.ts"), `import { describe, it, expect } from "vitest";\nimport { InvoicesService } from "./invoices.service";\ndescribe("invoices", () => {\n\tit("${UNIT}#1 round2", () => expect(new InvoicesService().round2(2.345)).toBe(2.35));\n\tit("${UNIT}#2 addTax", () => expect(new InvoicesService().addTax(10, 0.2)).toBe(12));\n});\n`);
						return { text: "TESTER DONE 2 cases", toolCalls: 3, blocked: 0, usage };
					}
					tries++;
					write(join(o.cwd, SERVICE), "export class InvoicesService {\n\tround2(x: number): number {\n\t\treturn Math.round(x * 100) / 100;\n\t}\n\n\taddTax(net: number, rate: number): number {\n\t\treturn this.round2(net * (1 + rate));\n\t}\n}\n");
					if (tries === 1) write(join(o.cwd, NOTE), "// The invoice line type waits for the handlers unit.\n/* nothing here yet */\n");
					else rmSync(join(o.cwd, NOTE), { force: true });
					const prove = o.customTools!.find((t) => t.name === "ledger_prove")!;
					await prove.execute("prove", { proofs: ["round2", "addTax"].map((n) => ({ srcSymbol: `lib/money.js::${n}`, op: "moved", targetSymbols: [`${SERVICE}::InvoicesService::${n}`], why: "1:1 port" })) }, undefined, undefined, {} as never);
					return { text: "IMPLEMENTER DONE", toolCalls: 2, blocked: 0, usage };
				},
				dispose() {},
			}) as unknown as LeafSession) as never;
		const tick = (_d: string, files: string[] = []) => ({ cmd: "true", args: files });
		const reports: Array<{ ok: boolean; output: string }> = [];
		const gate = async (g: GateInput) => {
			const r = await runGate({ ...g, review: async () => ({ ok: true, output: "scripted review: real, connected", judged: true }), adapter: { ...g.adapter, build: tick, lint: tick, test: () => tick("") } });
			reports.push({ ok: r.ok, output: r.steps.map((s) => s.output).join("\n") });
			return r;
		};
		const r = await runUnit({ ledger, config, root: ws, unitId: UNIT, spawn, gate, accept: true, log: () => {} });

		// truth came from running the old code (code ran cases.cjs with node), not from the tester's word
		expect(ledger.db.prepare("SELECT id, expected, verified_on_old v FROM truth_cases WHERE unit_id = ? ORDER BY id").all(UNIT)).toEqual([
			{ id: `${UNIT}#1`, expected: "2.35", v: 1 },
			{ id: `${UNIT}#2`, expected: "12", v: 1 },
		]);
		// the first try left a file with only comments: the parse tree saw it; the second try passed
		expect(reports[0]).toMatchObject({ ok: false, output: expect.stringContaining(`${NOTE}: ${ONLY_COMMENTS}`) });
		expect(reports.at(-1)!.ok).toBe(true);
		expect(r.state).toBe("accepted");
		expect(execFileSync("git", ["show", "--stat", "--format=%B", "HEAD"], { cwd: target, encoding: "utf8" })).toContain(SERVICE);
		ledger.close();
	});
});
