import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { getTargetAdapter } from "../src/adapters/registry.ts";
import { ConfigSchema, type Config } from "../src/config.ts";
import { indexTarget } from "../src/inventory/target.ts";
import { Ledger } from "../src/ledger/db.ts";
import { placementDir, placeUnit } from "../src/run/placement.ts";
import { buildTaskCard, renderTaskCard } from "../src/sessions/taskcard.ts";

/**
 * Task card area module: the card shows the unit's binding module dir, what that module already exports (so the
 * unit extends AgencyService instead of forking it) and the other units of the same area. Bounded, never silently.
 */
const here = resolve(import.meta.dirname, "..");
let ws: string;
let api: string;
let config: Config;
let ledger: Ledger;

const write = (rel: string, body: string) => {
	mkdirSync(dirname(join(api, rel)), { recursive: true });
	writeFileSync(join(api, rel), body);
};
const unit = (id: string, stack: string, area: string, state = "planned", symbolIds: string[] = []) => {
	ledger.createUnit({ id, tier: "T1", meta: { files: [`legacy/${id}.php`], place: { stack, area, shared: false, source: "code" } }, symbolIds });
	if (state !== "planned") ledger.db.prepare("UPDATE units SET state = ? WHERE id = ?").run(state, id);
};
const card = async (id: string) => {
	const adapter = await getTargetAdapter("nestjs");
	const place = placeUnit(config, ledger.getUnit(id)!.meta, ws);
	const moduleDir = placementDir(adapter.layout, place);
	return buildTaskCard(ledger, config, id, { targetProjectDir: api, writeGlobs: [`${moduleDir}/**`], adapter, place, moduleDir, root: ws });
};

beforeEach(async () => {
	ws = join(here, ".sim", "taskcard-area");
	rmSync(ws, { recursive: true, force: true });
	api = join(ws, "migrated", "api");
	mkdirSync(join(ws, "legacy"), { recursive: true });
	mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
	config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs", "react"] }, models: {} });
	ledger = new Ledger(":memory:");

	write("package.json", "{}");
	write(
		"src/features/agency/agency.service.ts",
		`import { Injectable } from "@nestjs/common";
@Injectable()
export class AgencyService {
	findAll(): Promise<string[]> { return Promise.resolve([]); }
	findById(id: number): Promise<string | undefined> { return Promise.resolve(undefined); }
}
`,
	);
	write("src/features/agency/agency.service.spec.ts", `it("x", () => {});\n`);
	write("src/features/campaign/campaign.service.ts", `export class CampaignService { list(): string[] { return []; } }\n`);
	await indexTarget(ledger, await getTargetAdapter("nestjs"), api);
	// same project-relative path from the web project: must not leak into the api card
	ledger.db.prepare("INSERT INTO index_symbols(id, side, path, kind, name, line, exported) VALUES (?, 'target', ?, 'function', 'AgencyPage', 1, 1)").run("src/features/agency/AgencyPage.tsx::AgencyPage", "src/features/agency/AgencyPage.tsx");

	ledger.upsertFile({ path: "legacy/agency_model.php", hash: "h", lang: "php", loc: 10 });
	ledger.upsertSymbol({ id: "legacy/agency_model.php::Agency", path: "legacy/agency_model.php", kind: "class", name: "Agency" });
	unit("agency_model", "nestjs", "agency", "planned", ["legacy/agency_model.php::Agency"]);
	ledger.prove({ unitId: "agency_model", srcSymbol: "legacy/agency_model.php::Agency", op: "moved", targetSymbols: ["src/features/agency/agency.service.ts::AgencyService"], why: "ported" });
	ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = 'agency_model'").run();
	unit("agency_cmd", "nestjs", "agency");
	unit("agency_tool", "nestjs", "agency");
	unit("agency_sso", "nestjs", "agency", "implementing");
	unit("agency_list", "react", "agency");
	unit("campaign_cmd", "nestjs", "campaign");
});

describe("task card area module", () => {
	it("an agency unit sees AgencyService's methods and its sibling units, nothing from other areas or stacks", async () => {
		const c = await card("agency_cmd");
		const a = c.areaModule!;
		expect(a).toMatchObject({ area: "agency", stackId: "nestjs", moduleDir: "src/features/agency", shared: false, testFiles: 1, classes: ["AgencyService"] });
		expect(a.files.map((f) => f.path)).toEqual(["agency.service.ts"]);
		expect(a.files[0]!.symbols.map((s) => s.name)).toEqual(["AgencyService", "AgencyService.findAll", "AgencyService.findById"]);
		expect(a.siblings.map((s) => s.id).sort()).toEqual(["agency_model", "agency_sso", "agency_tool"]);
		expect(a.siblings.find((s) => s.id === "agency_model")!.targetFiles).toEqual(["src/features/agency/agency.service.ts"]);

		const text = renderTaskCard(c, config, { includeSource: false });
		expect(text).toContain("## Area module (binding): agency on nestjs → src/features/agency/");
		expect(text).toContain("add methods to AgencyService rather than new classes");
		expect(text).toContain("AgencyService.findById(id: number): Promise<string | undefined>");
		expect(text).toContain("- accepted agency_model → src/features/agency/agency.service.ts");
		expect(text).toContain("- planned: agency_tool");
		expect(text).toContain("- implementing: agency_sso");
		expect(text).toContain(a.structureDoc);
		expect(text).not.toMatch(/AgencyPage|CampaignService|agency_list|campaign_cmd/);
	});

	it("lists reuse candidates found by meaning and the area's approved tidy tasks", async () => {
		ledger.upsertFile({ path: "legacy/agency_report.php", hash: "h2", lang: "php", loc: 5 });
		ledger.upsertSymbol({ id: "legacy/agency_report.php::listAgencies", path: "legacy/agency_report.php", kind: "function", name: "listAgencies" });
		unit("agency_report", "nestjs", "agency", "planned", ["legacy/agency_report.php::listAgencies"]);
		const id = "src/features/agency/agency.service.ts::AgencyService.findAll";
		ledger.db.prepare("INSERT INTO capabilities(id, stack, area, path, name, kind, summary, terms, io, legacy, unit_id, created_at) VALUES (?, 'nestjs', 'agency', 'src/features/agency/agency.service.ts', 'AgencyService.findAll', 'method', 'lists all agencies of the network', 'agency agencies list overview', '() → names', '[]', 'agency_model', '2026-01-01')").run(id);
		ledger.db.prepare("INSERT INTO capabilities_fts(id, name, summary, terms) VALUES (?, 'AgencyService findAll', 'lists all agencies of the network', 'agency agencies list overview')").run(id);
		const task = { id: "T9", stack: "nestjs", area: "agency", op: "rename", from: ["src/features/agency/agency-list.service.ts"], to: ["src/features/agency/agency.service.ts"], why: "one service per area", questionId: 9, status: "approved" };
		ledger.setMeta("tidy_tasks", JSON.stringify([task, { ...task, id: "T10", area: "campaign", from: ["src/features/campaign/x.ts"] }]));
		const c = await card("agency_report");
		expect(c.reuseCandidates.map((r) => r.capability.id)).toEqual([id]);
		const text = renderTaskCard(c, config, { includeSource: false });
		expect(text).toContain("## Reuse candidates");
		expect(text).toContain(`- for legacy/agency_report.php::listAgencies: ${id}`);
		expect(text).toContain("## Tidy tasks for this area (do these too)");
		expect(text).toContain("- rename: src/features/agency/agency-list.service.ts → src/features/agency/agency.service.ts (one service per area)");
		expect(text).not.toContain("campaign/x.ts");
	});

	it("an empty module says so; big areas are cut with explicit omitted lines", async () => {
		for (let i = 0; i < 50; i++) unit(`offers_${String(i).padStart(2, "0")}`, "nestjs", "offers");
		for (let i = 0; i < 100; i++) write(`src/features/offers/f${String(i).padStart(3, "0")}.ts`, "export const x = 1;\n");
		const text = renderTaskCard(await card("offers_00"), config, { includeSource: false });
		expect(text).toContain("- (60 more files omitted; target_lookup)");
		expect(text).toContain("- (9 more units omitted)");

		rmSync(join(api, "src/features/offers"), { recursive: true });
		expect(renderTaskCard(await card("offers_00"), config, { includeSource: false })).toContain("src/features/offers/ is empty");
	});
});
