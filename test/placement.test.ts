import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { FakeModelClient } from "../src/models/fake.ts";
import { draftedOutside, runUnit } from "../src/run/unit.ts";
import { getTargetAdapter, knownTargets, TARGET_ROLES } from "../src/adapters/registry.ts";
import { applyPlacementAnswers, placeUnit, resolvePlacements, unplacedReason } from "../src/run/placement.ts";

/**
 * Placement: one legacy area → one feature module per stack. Code places clear cases (gyro layout), placement.json
 * overrides, orphan helpers used by ≥ 2 areas go shared, Jev places what code cannot, a question what Jev cannot;
 * the answer becomes a prefix rule.
 */
const here = resolve(import.meta.dirname, "..");
const FILES = [
	"app/view/templates/default/agency/list.tpl.php",
	"app/view/templates/default/agency/edit.vue.tpl.php",
	"app/view/templates/default/agency/inc/filter.js.tpl.php",
	"app/view/templates/default/campaign/list.tpl.php",
	"app/view/templates/default/vue/inc/v-progressbar.vue.tpl.php",
	"app/behaviour/commands/agency/create.cmd.php",
	"app/behaviour/commands/campaign/create.cmd.php",
	"app/model/classes/agency.model.php",
	"app/model/classes/agency.facade.php",
	"app/model/classes/campaigns.model.php",
	"app/model/classes/campaigns.facade.php",
	"app/lib/components/agencytool.cls.php",
	"app/controller/money.controller.php",
	"app/lib/components/fpdf.cls.php",
	"app/lib/components/uuid.cls.php",
];
let ws: string;
let config: Config;
let ledger: Ledger;
const unit = (id: string, files: string[], deps: string[] = []) => ledger.createUnit({ id, tier: "T0", deps, meta: { files }, symbolIds: [] });
const place = (id: string) => placeUnit(config, ledger.getUnit(id)!.meta, ws);

beforeEach(() => {
	ws = join(here, ".sim", "placement");
	rmSync(ws, { recursive: true, force: true });
	const legacy = join(ws, "legacy");
	mkdirSync(join(legacy, "gyro-php"), { recursive: true });
	for (const f of FILES) {
		mkdirSync(dirname(join(legacy, f)), { recursive: true });
		writeFileSync(join(legacy, f), "<?php\n");
	}
	mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
	config = ConfigSchema.parse({ source: { path: legacy, stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs", "react"] }, models: {} });
	ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
	unit("money", ["app/controller/money.controller.php"]);
	unit("agency_model", ["app/model/classes/agency.model.php", "app/model/classes/agency.facade.php"], ["money"]);
	unit("campaign_model", ["app/model/classes/campaigns.model.php", "app/model/classes/campaigns.facade.php"], ["agency_model", "money"]);
	unit("agency_cmd", ["app/behaviour/commands/agency/create.cmd.php"], ["agency_model"]);
	unit("campaign_cmd", ["app/behaviour/commands/campaign/create.cmd.php"], ["campaign_model"]);
	unit("agency_tool", ["app/lib/components/agencytool.cls.php"]);
	unit("agency_list", ["app/view/templates/default/agency/list.tpl.php"]);
	unit("agency_edit", ["app/view/templates/default/agency/edit.vue.tpl.php"]);
	unit("agency_filter", ["app/view/templates/default/agency/inc/filter.js.tpl.php"]);
	unit("campaign_list", ["app/view/templates/default/campaign/list.tpl.php"]);
	unit("progressbar", ["app/view/templates/default/vue/inc/v-progressbar.vue.tpl.php"]);
	unit("fpdf", ["app/lib/components/fpdf.cls.php"]);
	unit("uuid", ["app/lib/components/uuid.cls.php"]);
	unit("pdf_user", ["app/behaviour/commands/campaign/create.cmd.php"], ["fpdf"]);
});

describe("placement", () => {
	it("code: areas are legacy features, templates go to the UI stack, never kind suffixes", () => {
		expect(place("agency_list")).toMatchObject({ stackId: "react", area: "agency", moduleKey: "react:agency", shared: false, source: "code" });
		expect(place("agency_edit")).toMatchObject({ stackId: "react", area: "agency" });
		expect(place("agency_filter")).toMatchObject({ stackId: "react", area: "agency" });
		expect(place("agency_cmd")).toMatchObject({ stackId: "nestjs", area: "agency" });
		expect(place("agency_model")).toMatchObject({ stackId: "nestjs", area: "agency" });
		expect(place("agency_tool")).toMatchObject({ stackId: "nestjs", area: "agency" });
		// singular/plural converge on the spelling the app uses for its feature dirs
		expect(place("campaign_model")).toMatchObject({ stackId: "nestjs", area: "campaign" });
		expect(place("progressbar")).toMatchObject({ stackId: "react", shared: true });
		for (const u of ledger.listUnits()) expect(place(u.id).area).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
	});

	it("overrides: placement.json prefix rules win over code", () => {
		writeFileSync(join(ws, ".bigrefactor", "placement.json"), JSON.stringify({ rules: [{ prefix: "app/view/templates/default/campaign/", area: "billing" }] }));
		expect(place("campaign_list")).toMatchObject({ stackId: "react", area: "billing", source: "override" });
		expect(place("agency_list").area).toBe("agency");
	});

	it("pipeline: shared by dependents, Jev for unsure code, a question below threshold, the answer becomes a rule", async () => {
		const client = new FakeModelClient({
			decide: (req) => {
				const s = req.state as { path?: string };
				if (s.path?.includes("fpdf")) return { area: "campaign", ui: false };
				if (s.path?.includes("uuid")) return { area: "other", ui: false };
				return {};
			},
			chat: () => ({ json: { id: "placement", question: "Where does the uuid helper belong?", options: [], recommended: "", opinion: "It has no feature of its own." } }),
		});
		const r = await resolvePlacements({ ledger, config, root: ws, client });
		// money: its own area has no other unit, and agency + campaign depend on it → shared (no question)
		expect(place("money")).toMatchObject({ stackId: "nestjs", area: "money", shared: true });
		// the agency entity is used by campaign too, but agency is a feature module: it stays there
		expect(place("agency_model")).toMatchObject({ area: "agency", shared: false });
		expect(place("fpdf")).toMatchObject({ stackId: "nestjs", area: "campaign", source: "model" });
		expect(r.byModel).toBe(1);
		expect(r.asked).toBe(1);
		const q = ledger.openQuestions().find((x) => x.unit_id === "uuid")!;
		expect(q.point).toBe("placement");
		expect(q.question).toContain("Where does the uuid helper belong?");
		expect(ledger.blockedUnits().has("uuid")).toBe(true);
		// asked once: a second pass does not ask again
		await resolvePlacements({ ledger, config, root: ws, client });
		expect(ledger.openQuestions().filter((x) => x.unit_id === "uuid")).toHaveLength(1);

		const opts = JSON.parse(q.options!) as string[];
		expect(opts.some((o) => o.startsWith("nestjs:shared/"))).toBe(true);
		ledger.answerQuestion(q.id, "nestjs:shared/ids — shared ids", "human");
		expect(applyPlacementAnswers(ledger, config, ws)).toEqual(["uuid"]);
		expect(place("uuid")).toMatchObject({ stackId: "nestjs", area: "ids", shared: true, source: "answer" });
		const rules = JSON.parse(readFileSync(join(ws, ".bigrefactor", "placement.json"), "utf8")).rules;
		expect(rules).toContainEqual({ prefix: "app/lib/components/uuid.", area: "ids", stack: "nestjs", shared: true });
		// a similar file is placed by the rule, without Jev or a question
		writeFileSync(join(config.source.path, "app/lib/components/uuid.v4.cls.php"), "<?php\n");
		unit("uuid_v4", ["app/lib/components/uuid.v4.cls.php"]);
		const calls = client.calls.length;
		await resolvePlacements({ ledger, config, root: ws, client });
		expect(place("uuid_v4")).toMatchObject({ stackId: "nestjs", area: "ids", shared: true, source: "override" });
		expect(client.calls.length).toBe(calls);
	});

	it("an answer's rule covers the same stem only and pins the stack only where the adapter cannot tell", () => {
		const q = ledger.askQuestion({ point: "placement", unitId: "agency_list", question: "q", blocks: "unit", askedBy: "placement" });
		ledger.updateUnit("agency_list", { meta: { placeQuestion: q } });
		ledger.answerQuestion(q, "nestjs:agency-admin", "human");
		applyPlacementAnswers(ledger, config, ws);
		expect(place("agency_list")).toMatchObject({ stackId: "nestjs", area: "agency-admin", source: "answer" });
		expect(JSON.parse(readFileSync(join(ws, ".bigrefactor", "placement.json"), "utf8")).rules).toEqual([{ prefix: "app/view/templates/default/agency/list.", area: "agency-admin" }]);
		for (const f of ["app/view/templates/default/agency/list.vue.tpl.php", "app/view/templates/default/agency/listing.tpl.php"]) writeFileSync(join(config.source.path, f), "<?php\n");
		unit("agency_list_vue", ["app/view/templates/default/agency/list.vue.tpl.php"]);
		unit("agency_listing", ["app/view/templates/default/agency/listing.tpl.php"]);
		// same stem: the answer's area, but the adapter's surface (UI stays on the UI stack); a longer name is not covered
		expect(place("agency_list_vue")).toMatchObject({ stackId: "react", area: "agency-admin", source: "override" });
		expect(place("agency_listing")).toMatchObject({ stackId: "react", area: "agency", source: "code" });
	});

	it("unsure units never run on code's guess: without Jev or when Jev fails they are asked; an answer places similar waiting units", async () => {
		unit("uuid_v4", ["app/lib/components/uuid.v4.cls.php"]);
		writeFileSync(join(config.source.path, "app/lib/components/uuid.v4.cls.php"), "<?php\n");
		const failing = new FakeModelClient({ decide: () => { throw new Error("provider down"); }, chat: () => ({ json: { id: "placement", question: "Where?", options: [], recommended: "", opinion: "" } }) });
		const r = await resolvePlacements({ ledger, config, root: ws, client: failing });
		expect(r.asked).toBe(3); // fpdf, uuid, uuid_v4
		for (const id of ["fpdf", "uuid", "uuid_v4"]) {
			expect(unplacedReason(config, ledger.getUnit(id)!.meta, ws), id).toBeTruthy();
			expect(ledger.blockedUnits().has(id), id).toBe(true);
		}
		expect(unplacedReason(config, ledger.getUnit("agency_cmd")!.meta, ws)).toBeUndefined();
		const q = ledger.openQuestions().find((x) => x.unit_id === "uuid")!;
		ledger.answerQuestion(q.id, "nestjs:shared/ids", "human");
		applyPlacementAnswers(ledger, config, ws);
		expect(place("uuid_v4")).toMatchObject({ stackId: "nestjs", area: "ids", shared: true, source: "override" });
		expect(ledger.openQuestions().some((x) => x.unit_id === "uuid_v4")).toBe(false);
		expect(ledger.openQuestions().some((x) => x.unit_id === "fpdf")).toBe(true);
	});

	it("no model at all: unsure units get a question too", async () => {
		const r = await resolvePlacements({ ledger, config, root: ws });
		expect(r.asked).toBe(2);
		expect(unplacedReason(config, ledger.getUnit("uuid")!.meta, ws)).toBeTruthy();
		ledger.withdrawQuestion(ledger.openQuestions().find((x) => x.unit_id === "uuid")!.id, "test");
		await expect(runUnit({ ledger, config, root: ws, unitId: "uuid", log: () => {} })).rejects.toThrow(/no placement yet \(code unsure/);
	});

	it("the static role mirror equals every target adapter's role", async () => {
		for (const id of knownTargets()) expect(TARGET_ROLES[id], id).toBe((await getTargetAdapter(id)).role);
	});

	it("drafted interface paths must stay inside the unit's placement", () => {
		const md = "- `api/src/features/agency/agency.service.ts` exports AgencyService\n- src/features/list.tpl/list.ts\n- ported from app/model/classes/agency.model.php";
		expect(draftedOutside(md, ["src/features/agency/"], "api", [join(ws, "migrated"), config.source.path])).toEqual(["src/features/list.tpl/list.ts"]);
	});
});
