import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getSourceAdapter, getTargetAdapter } from "../src/adapters/registry.ts";
import { exampleProfileJson } from "../src/adapters/source/php.ts";
import { ConfigSchema } from "../src/config.ts";
import { openDecisions } from "../src/inventory/decisions.ts";
import { inventory } from "../src/inventory/run.ts";
import { Ledger } from "../src/ledger/db.ts";
import { healStackKnowledge } from "../src/run/stack-heal.ts";
import type { LeafSession, SpawnOptions } from "../src/sessions/spawn.ts";

/**
 * Run start: a framework profile written before notApp existed gets that list from a session that reads the repo;
 * the inventory then runs again, so units in code that is not the app's leave the plan.
 */
const here = resolve(import.meta.dirname, "..");

describe("run start: a profile without notApp", () => {
	it("a session writes only notApp; planned and stuck units under those folders drop out; accepted ones stay; a vendored folder is a library decision", async () => {
		const ws = join(here, ".sim", "heal-not-app");
		rmSync(ws, { recursive: true, force: true });
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		cpSync(join(here, "fixtures", "mini-app"), join(ws, "legacy"), { recursive: true });
		process.env["BR_WORKSPACE"] = ws;
		const put = (p: string, s: string) => (mkdirSync(join(ws, "legacy", p, ".."), { recursive: true }), writeFileSync(join(ws, "legacy", p), s));
		put("app/3rdparty/PHPExcel/PHPExcel.php", "<?php\nclass PHPExcel { function save() { return 1; } }\n");
		put("app/3rdparty/PHPExcel/Writer.php", "<?php\nclass PHPExcel_Writer { function write() { return new PHPExcel(); } }\n");
		put("app/3rdparty/PHPExcel/Reader.php", "<?php\nclass PHPExcel_Reader { function read() { return new PHPExcel(); } }\n");
		put("src/Report.php", "<?php\nclass Report { function run() { $w = new PHPExcel_Writer(); $r = new PHPExcel_Reader(); return $w->write(); } }\n");
		put("index.php", "<?php\n$r = new Report(); $r->run();\n");
		const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, models: {} });
		const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
		const profile = { ...exampleProfileJson(), frameworkDirs: [] } as Record<string, unknown>;
		delete profile["notApp"];
		writeFileSync(join(ws, ".bigrefactor", "framework-profile.json"), JSON.stringify(profile));
		getSourceAdapter("php").reloadProfile?.();
		await inventory(config, ws, ledger);
		const unitOf = (file: string) => ledger.listUnits().find((u) => (JSON.parse(u.meta).files ?? []).includes(file))?.id;
		const [excel, writer, reader] = ["app/3rdparty/PHPExcel/PHPExcel.php", "app/3rdparty/PHPExcel/Writer.php", "app/3rdparty/PHPExcel/Reader.php"].map(unitOf);
		expect(excel && writer && reader).toBeTruthy();
		// one started and stuck, one accepted earlier
		ledger.transitionUnit(writer!, "truth", "t");
		ledger.transitionUnit(writer!, "implementing", "t");
		ledger.transitionUnit(writer!, "quarantined", "t");
		const qid = ledger.askQuestion({ unitId: writer!, point: "quarantine", question: "retry?", options: ["retry", "leave"], blocks: "unit", askedBy: "orchestrator" });
		ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = ?").run(reader!);

		const seen: SpawnOptions[] = [];
		const spawn = (async (opts: SpawnOptions): Promise<LeafSession> => {
			seen.push(opts);
			return {
				run: async () => {
					writeFileSync(join(ws, ".bigrefactor", "not-app.json"), JSON.stringify({ notApp: [{ path: "app/3rdparty/PHPExcel/", kind: "vendored", name: "phpoffice/phpexcel", why: "PHPExcel 1.8 copied into the repo" }, { path: "nowhere/", kind: "docs", why: "x" }] }));
					return { text: "done", toolCalls: 4, blocked: 0, usage: { input: 0, output: 0, cost: 0 } };
				},
				dispose() {},
			} as unknown as LeafSession;
		}) as never;
		const log: string[] = [];
		await healStackKnowledge({ ledger, config, root: ws, spawn, log: (l) => log.push(l) });

		expect(seen[0]!.writeGlobs).toEqual([".bigrefactor/not-app.json"]);
		expect(seen[0]!.systemPrompt).toMatch(/notApp \(array of/);
		// only notApp was added (the invalid entry left out after the model's fix round); the rest of the profile stays
		const saved = JSON.parse(readFileSync(join(ws, ".bigrefactor", "framework-profile.json"), "utf8"));
		expect(saved.notApp).toEqual([{ path: "app/3rdparty/PHPExcel/", kind: "vendored", name: "phpoffice/phpexcel", why: "PHPExcel 1.8 copied into the repo" }]);
		expect(saved.concerns).toEqual(profile["concerns"]);
		expect(ledger.getUnit(excel!)).toBeUndefined();
		expect(ledger.getUnit(writer!)).toBeUndefined();
		expect(ledger.getQuestion(qid)!.status).toBe("withdrawn");
		expect(ledger.getUnit(reader!)!.state).toBe("accepted");
		expect(log.join("\n")).toMatch(/1 accepted unit\(s\) hold code that is not the app's/);
		const lib = openDecisions(ledger, config, getSourceAdapter("php"), [await getTargetAdapter("nestjs")], ws).find((d) => d.id === "lib:phpoffice/phpexcel");
		expect(lib?.evidence).toMatch(/vendored copy in app\/3rdparty\/PHPExcel\//);

		// written once: the next run start asks nothing
		await healStackKnowledge({ ledger, config, root: ws, spawn: (async () => { throw new Error("not again"); }) as never, log: () => {} });
	});
});
