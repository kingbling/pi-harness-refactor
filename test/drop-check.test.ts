import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import type { ModelClient } from "../src/models/types.ts";
import { checkAcceptedDrops, DROP_CHECK_VERSION, reopenCommentOnly, type DropJudge } from "../src/run/drop-check.ts";

/**
 * Accepted units checked again for what their gate did not see: drops that are work not done (a cheap read picks
 * the suspects, a model with tools judges them, a few units per run), and files with only comments left on main.
 */
let ws: string;
let ledger: Ledger;
let config: Config;

const accepted = (id: string, drops: Array<[string, string]>) => {
	ledger.createUnit({ id, tier: "T0", symbolIds: [] });
	ledger.upsertFile({ path: `app/${id}.php`, hash: "h", lang: "php", loc: 1 });
	for (const [name, why] of drops) {
		const sym = `app/${id}.php::${name}`;
		ledger.upsertSymbol({ id: sym, path: `app/${id}.php`, kind: "function", name });
		ledger.db.prepare("UPDATE symbols SET unit_id = ?, state = 'dropped' WHERE id = ?").run(id, sym);
		ledger.db.prepare("INSERT INTO moves(unit_id, src_symbol, op, target_symbols, why, created_at) VALUES (?, ?, 'dropped', '[]', ?, 'now')").run(id, sym, why);
	}
	ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = ?").run(id);
};

beforeEach(() => {
	ws = mkdtempSync(join(tmpdir(), "br-drop-check-"));
	mkdirSync(join(ws, "target"), { recursive: true });
	ledger = new Ledger(":memory:");
	config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "target"), stacks: ["nestjs"] }, models: {} });
});
afterEach(() => {
	ledger.close();
	rmSync(ws, { recursive: true, force: true });
});

describe("drop check of accepted units", () => {
	it("reads all drop reasons once, judges only the suspect ones, and sends back the unit with a needed drop (code kept, symbol open again)", async () => {
		accepted("U1_reports", [["sales", "Sales KPI report execution is not implemented."], ["init", "platform: Symfony boots the kernel."]]);
		accepted("U2_clean", [["legacy", "dead: nothing calls it."]]);
		const reads: string[] = [];
		const client = { chat: async (req: { messages: Array<{ content: string }> }) => (reads.push(req.messages[1]!.content), { text: "", json: { suspects: ["app/U1_reports.php::sales"] }, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, model: "m" } }) } as unknown as ModelClient;
		const judged: string[][] = [];
		const judge: DropJudge = async (o) => (judged.push(o.drops.map((d) => d.src_symbol)), [{ symbol: "app/U1_reports.php::sales", needed: true, why: "the KPI report is a menu item; nothing in the target builds it" }]);
		const back = await checkAcceptedDrops({ ledger, config, root: ws, client, judge, log: () => {} });
		expect(reads).toHaveLength(1);
		expect(reads[0]).toContain("app/U2_clean.php::legacy: dead: nothing calls it.");
		expect(judged).toEqual([["app/U1_reports.php::sales"]]);
		expect(back).toEqual(["U1_reports"]);
		expect(ledger.getUnit("U1_reports")!.state).toBe("planned");
		expect(JSON.parse(ledger.getUnit("U1_reports")!.meta).retryNote).toMatch(/marked dropped that the app needs[^]*app\/U1_reports\.php::sales: the KPI report is a menu item/);
		expect(ledger.getSymbol("app/U1_reports.php::sales")!.state).toBe("clustered");
		expect(ledger.getSymbol("app/U1_reports.php::init")!.state).toBe("dropped");
		expect(ledger.getUnit("U2_clean")!.state).toBe("accepted");
		expect(JSON.parse(ledger.getUnit("U2_clean")!.meta).dropCheck).toEqual({ v: DROP_CHECK_VERSION, judged: true });
		// a second run reads and judges nothing again
		await checkAcceptedDrops({ ledger, config, root: ws, client, judge, log: () => {} });
		expect(reads).toHaveLength(1);
		expect(judged).toHaveLength(1);
	});

	it("judges at most `cap` units per run, the most suspect drops first; no verdict is judged again next run", async () => {
		accepted("U1_a", [["x", "not ported"]]);
		accepted("U2_b", [["x", "not ported"], ["y", "deferred to the owner"]]);
		accepted("U3_c", [["x", "left for later"]]);
		const judged: string[] = [];
		let answer = false;
		const judge: DropJudge = async (o) => (judged.push(o.unitId), answer ? o.drops.map((d) => ({ symbol: d.src_symbol, needed: false, why: "the target does it" })) : undefined);
		// no model client: every drop is a suspect
		await checkAcceptedDrops({ ledger, config, root: ws, judge, cap: 2, log: () => {} });
		expect(judged).toEqual(["U2_b", "U1_a"]);
		answer = true;
		await checkAcceptedDrops({ ledger, config, root: ws, judge, cap: 2, log: () => {} });
		expect(judged.slice(2)).toEqual(["U2_b", "U1_a"]);
		await checkAcceptedDrops({ ledger, config, root: ws, judge, cap: 2, log: () => {} });
		expect(judged.slice(4)).toEqual(["U3_c"]);
		for (const id of ["U1_a", "U2_b", "U3_c"]) expect(ledger.getUnit(id)!.state).toBe("accepted");
	});
});

describe("files with only comments on main", () => {
	it("sends back the accepted unit whose commit added one, told the file, which it may edit and its gate checks again", async () => {
		const repo = join(ws, "target");
		const write = (rel: string, body: string) => (mkdirSync(dirname(join(repo, rel)), { recursive: true }), writeFileSync(join(repo, rel), body));
		execFileSync("git", ["init", "-q"], { cwd: repo });
		const commit = (msg: string) => (execFileSync("git", ["add", "-A"], { cwd: repo }), execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", msg], { cwd: repo }));
		write("src/vite-env.d.ts", '/// <reference types="vite/client" />\n');
		write("src/other/kept.ts", "// only a note\n");
		commit("setup");
		write("src/features/players/InventoryDeferral.ts", "// The table logic waits for its owner.\n/* deferred */\n");
		write("src/features/players/Inventory.ts", "export const rows = [];\n");
		commit("feat(players): migrate U471_inventory\n\nbigrefactor: unit U471_inventory, target .");
		ledger.createUnit({ id: "U471_inventory", tier: "T0", symbolIds: [] });
		ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = 'U471_inventory'").run();
		const back = await reopenCommentOnly({ ledger, config, log: () => {} });
		expect(back).toEqual(["U471_inventory"]);
		const meta = JSON.parse(ledger.getUnit("U471_inventory")!.meta);
		expect(ledger.getUnit("U471_inventory")!.state).toBe("planned");
		expect(meta.commentOnly).toEqual(["src/features/players/InventoryDeferral.ts"]);
		expect(meta.stubFiles).toEqual(["src/features/players/InventoryDeferral.ts"]);
		expect(meta.retryNote).toMatch(/files that hold only comments, no code: src\/features\/players\/InventoryDeferral\.ts/);
	});
});
