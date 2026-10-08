import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { FakeModelClient } from "../src/models/fake.ts";
import { draftedOutside, runUnit } from "../src/run/unit.ts";
import { getTargetAdapter, knownTargets, TARGET_ROLES, TARGET_SUBDIRS, targetIdFor } from "../src/adapters/registry.ts";
import { applyPlacementAnswers, codePlace, placeUnit, pruneRules, planPlacements, resolvePlacements, unplacedReason } from "../src/run/placement.ts";

/**
 * Placement: one legacy area → one feature module per stack. The area model writes prefix rules (placement.json)
 * from the folder tree; code applies them with the adapter's ui/server fact, orphan helpers used by ≥ 2 areas go
 * shared, Jev places what no rule covers, a question what Jev cannot; the answer becomes a prefix rule.
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
/** What the area model writes for the gyro layout above (taxonomy.ts); money, fpdf and uuid are left to Jev. */
const TAXONOMY = [
	{ prefix: "app/view/templates/default/agency/", area: "agency" },
	{ prefix: "app/view/templates/default/campaign/", area: "campaign" },
	{ prefix: "app/view/templates/default/vue/", area: "widgets", shared: true },
	{ prefix: "app/behaviour/commands/agency/", area: "agency" },
	{ prefix: "app/behaviour/commands/campaign/", area: "campaign" },
	{ prefix: "app/model/classes/agency", area: "agency" },
	{ prefix: "app/model/classes/campaigns", area: "campaign" },
	{ prefix: "app/lib/components/agencytool", area: "agency" },
].map((r) => ({ ...r, by: "taxonomy" }));
const rulesPath = () => join(ws, ".bigrefactor", "placement.json");
const addRules = (...rules: object[]) => writeFileSync(rulesPath(), JSON.stringify({ rules: [...JSON.parse(readFileSync(rulesPath(), "utf8")).rules, ...rules] }));
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
	writeFileSync(rulesPath(), JSON.stringify({ rules: TAXONOMY }));
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
	it("code applies the area rules; the adapter's ui/server fact picks the stack", () => {
		expect(place("agency_list")).toMatchObject({ stackId: "react", area: "agency", moduleKey: "react:agency", shared: false, source: "override" });
		expect(place("agency_edit")).toMatchObject({ stackId: "react", area: "agency" });
		expect(place("agency_filter")).toMatchObject({ stackId: "react", area: "agency" });
		expect(place("agency_cmd")).toMatchObject({ stackId: "nestjs", area: "agency" });
		expect(place("agency_model")).toMatchObject({ stackId: "nestjs", area: "agency" });
		expect(place("agency_tool")).toMatchObject({ stackId: "nestjs", area: "agency" });
		expect(place("campaign_model")).toMatchObject({ stackId: "nestjs", area: "campaign" });
		expect(place("progressbar")).toMatchObject({ stackId: "react", shared: true });
		for (const u of ledger.listUnits()) expect(place(u.id).area).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
	});

	it("code never guesses an area from a name, but always knows the surface of a framework file", () => {
		for (const f of ["app/model/classes/base/status.base.php", "app/lib/components/clock.cls.php", "app/controller/catch400http.controller.php"]) {
			const c = codePlace(config, { files: [f] }, ws);
			expect(c.unsure, f).toMatch(/no area rule/);
			expect(c.surfaceKnown, f).toBe(true); // Jev only picks the area: server code never lands on the UI stack
			expect(c.place.stackId, f).toBe("nestjs");
		}
	});

	it("overrides: the longest prefix wins, an owner's file rule beats the area model's folder rule", () => {
		addRules({ prefix: "app/view/templates/default/campaign/list.", area: "billing" });
		expect(place("campaign_list")).toMatchObject({ stackId: "react", area: "billing", source: "override" });
		expect(place("agency_list").area).toBe("agency");
	});

	it("pipeline: shared by dependents, Jev for unsure code, a question below threshold, the answer becomes a rule", async () => {
		const client = new FakeModelClient({
			decide: (req) => {
				const s = req.state as { path?: string };
				if (s.path?.includes("fpdf")) return { area: "campaign", ui: false };
				if (s.path?.includes("uuid")) return { area: "other", ui: false };
				if (s.path?.includes("money")) return { area: "agency" };
				return {};
			},
			chat: () => ({ json: { id: "placement", question: "Where does the uuid helper belong?", options: [], recommended: "", opinion: "It has no feature of its own." } }),
		});
		const r = await resolvePlacements({ ledger, config, root: ws, client });
		// money matches no feature of the app: Jev may only pick a known area, never one named after the file
		expect(place("money")).toMatchObject({ stackId: "nestjs", area: "agency", shared: false, source: "model" });
		const offered = JSON.stringify(client.calls.filter((c: any) => JSON.stringify(c).includes("money.controller")));
		expect(offered).not.toMatch(/feature \\"money\\"/);
		expect(offered).toMatch(/feature \\"agency\\"/); // the known areas are what it chooses from
		// the agency entity is used by campaign too, but agency is a feature module: it stays there
		expect(place("agency_model")).toMatchObject({ area: "agency", shared: false });
		expect(place("fpdf")).toMatchObject({ stackId: "nestjs", area: "campaign", source: "model" });
		expect(r.byModel).toBe(2);
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
		expect(rules).toContainEqual({ prefix: "app/lib/components/uuid.", area: "ids", shared: true }); // the adapter knows the surface: no stack pin
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
		expect(JSON.parse(readFileSync(join(ws, ".bigrefactor", "placement.json"), "utf8")).rules.at(-1)).toEqual({ prefix: "app/view/templates/default/agency/list.", area: "agency-admin" });
		for (const f of ["app/view/templates/default/agency/list.vue.tpl.php", "app/view/templates/default/agency/listing.tpl.php"]) writeFileSync(join(config.source.path, f), "<?php\n");
		unit("agency_list_vue", ["app/view/templates/default/agency/list.vue.tpl.php"]);
		unit("agency_listing", ["app/view/templates/default/agency/listing.tpl.php"]);
		// same stem: the answer's area, but the adapter's surface (UI stays on the UI stack); a longer name is not covered
		expect(place("agency_list_vue")).toMatchObject({ stackId: "react", area: "agency-admin", source: "override" });
		expect(place("agency_listing")).toMatchObject({ stackId: "react", area: "agency", source: "override" });
	});

	it("unsure units never run on code's guess: without Jev or when Jev fails they are asked; an answer places similar waiting units", async () => {
		unit("uuid_v4", ["app/lib/components/uuid.v4.cls.php"]);
		writeFileSync(join(config.source.path, "app/lib/components/uuid.v4.cls.php"), "<?php\n");
		const failing = new FakeModelClient({ decide: () => { throw new Error("provider down"); }, chat: () => ({ json: { id: "placement", question: "Where?", options: [], recommended: "", opinion: "" } }) });
		const r = await resolvePlacements({ ledger, config, root: ws, client: failing });
		expect(r.asked).toBe(4); // money, fpdf, uuid, uuid_v4
		for (const id of ["money", "fpdf", "uuid", "uuid_v4"]) {
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
		expect(r.asked).toBe(3); // money, fpdf, uuid
		expect(unplacedReason(config, ledger.getUnit("uuid")!.meta, ws)).toBeTruthy();
		ledger.withdrawQuestion(ledger.openQuestions().find((x) => x.unit_id === "uuid")!.id, "test");
		await expect(runUnit({ ledger, config, root: ws, unitId: "uuid", log: () => {} })).rejects.toThrow(/no placement yet \(code unsure/);
	});

	it("Jev chooses from the curated areas and topics, most relevant first; the stronger model's pick is what the question recommends", async () => {
		// curated: two features + many small ones, topics with a purpose; a topic in use named after a legacy file is not curated
		const filler = Array.from({ length: 25 }, (_, i) => ({ name: `area-${i}`, purpose: "" }));
		writeFileSync(join(ws, ".bigrefactor", "areas.json"), JSON.stringify({
			stacks: [{ stack: "nestjs", areas: [{ name: "agency", purpose: "agency accounts" }, { name: "campaign", purpose: "ad campaigns" }, { name: "shared", purpose: "" }, ...filler], topics: [{ name: "dates", purpose: "clocks and date helpers" }] }],
			rules: [{ prefix: "app/view/templates/default/vue/", to: "shared", stack: "react", area: "widgets", confidence: 0.9, why: "reusable widgets" }],
		}));
		ledger.updateUnit("agency_tool", { meta: { place: { stack: "nestjs", area: "cpaa", shared: true, source: "code" } } });
		const client = new FakeModelClient({
			decide: (req) => {
				const s = req.state as { path?: string };
				if (s.path?.includes("money")) return { area: { type: "choice", choice: "agency", probabilities: { agency: 0.4 }, confidence: 0.4 } };
				return { area: "other" };
			},
			chat: (req) => {
				if (req.messages[0]!.content.startsWith("Answer each question")) return { json: { area: "shared__dates" } }; // the second opinion
				return { json: { id: "placement", question: "Where does money go?", options: [], recommended: "nestjs:agency", opinion: "" } };
			},
		});
		await resolvePlacements({ ledger, config, root: ws, client });
		const call = client.calls.find((c) => c.kind === "decide" && JSON.stringify(c.req).includes("money.controller"))!;
		const criteria = (call.req as unknown as { questions: { area: { criteria: Record<string, string | null> } } }).questions.area.criteria;
		expect(criteria["shared__dates"]).toBe('shared topic "dates" (cross-cutting code): clocks and date helpers'); // not cut by the many small areas
		expect(criteria["agency"]).toMatch(/agency accounts/);
		const order = Object.keys(criteria);
		expect(order.slice(0, 2).sort()).toEqual(["agency", "campaign"]); // what uses it first, then the topics, then the rest
		expect(order[2]).toBe("shared__dates");
		expect(criteria["shared__cpaa"]).toBeUndefined();
		expect(criteria["shared"]).toBeUndefined();
		expect(criteria["other"]).toMatch(/new feature area or shared topic/);
		// Jev unsure, the stronger model disagrees: its pick is the recommendation, and the phrasing model cannot overrule it
		const q = ledger.openQuestions().find((x) => x.unit_id === "money")!;
		const ctx = JSON.parse(q.context!);
		expect(ctx.codePick).toBe("nestjs:shared/dates");
		expect(ctx.guess).toBe(false);
		expect(ctx.facts).toMatch(/second opinion \(openai\/gpt-6\.1-sol, read the same code\): shared__dates/);
		expect(q.status).toBe("open");
	});

	it("the static role mirror equals every target adapter's role", async () => {
		for (const id of knownTargets()) expect(TARGET_ROLES[id], id).toBe((await getTargetAdapter(id)).role);
		// the registry knows role, subdir and aliases without loading an adapter; they must match the adapter's own
		for (const id of knownTargets()) {
			const t = await getTargetAdapter(id);
			expect(TARGET_SUBDIRS[id], id).toBe(t.subdir);
			for (const alias of [id, ...(t.aliases ?? [])]) expect(targetIdFor(alias), alias).toBe(id);
		}
	});

	it("drafted interface paths must stay inside the unit's placement", () => {
		const md = "- `api/src/features/agency/agency.service.ts` exports AgencyService\n- src/features/list.tpl/list.ts\n- ported from app/model/classes/agency.model.php";
		expect(draftedOutside(md, ["src/features/agency/"], "api", [join(ws, "migrated"), config.source.path])).toEqual(["src/features/list.tpl/list.ts"]);
	});
});

describe("placement + taxonomy", () => {
	it("taxonomy holds keep a unit from running; forced re-placement keeps taxonomy and answers", () => {
		ledger.updateUnit("agency_cmd", { meta: { place: { stack: "nestjs", area: "accounts", shared: false, source: "taxonomy" } } });
		ledger.updateUnit("agency_list", { meta: { taxonomyQuestion: 7 } });
		ledger.updateUnit("campaign_list", { meta: { exclude: { question: 8, why: "dead admin page" } } });
		expect(unplacedReason(config, ledger.getUnit("agency_list")!.meta, ws)).toMatch(/area question #7/);
		expect(unplacedReason(config, ledger.getUnit("campaign_list")!.meta, ws)).toMatch(/excluded/);
		expect(unplacedReason(config, ledger.getUnit("agency_cmd")!.meta, ws)).toBeUndefined();
		const plan = planPlacements(config, ledger.listUnits(), ws, true);
		expect(plan.get("agency_cmd")).toMatchObject({ stored: true, place: { area: "accounts", source: "taxonomy" } });
	});

	it("onboarding: the area model writes the rules from the folder tree, code applies them, Jev places the rest", async () => {
		writeFileSync(rulesPath(), JSON.stringify({ rules: [{ prefix: "app/lib/components/uuid.", area: "ids", shared: true }] })); // an answer's rule
		const client = new FakeModelClient({
			chat: (req) => {
				if (!req.messages[0]!.content.includes("feature-module structure")) return undefined;
				return { json: {
					stacks: [{ stack: "nestjs", areas: [{ name: "agencies", purpose: "agency accounts" }, { name: "campaigns", purpose: "ad campaigns" }] }, { stack: "react", areas: [{ name: "agencies", purpose: "" }, { name: "campaigns", purpose: "" }] }],
					rules: [
						{ prefix: "app/view/templates/default/agency/", to: "area", stack: "nestjs", area: "agencies", confidence: 0.95, why: "agency pages" },
						{ prefix: "app/behaviour/commands/agency/", to: "area", stack: "nestjs", area: "agencies", confidence: 0.95, why: "" },
						{ prefix: "app/model/classes/agency", to: "area", stack: "nestjs", area: "agencies", confidence: 0.9, why: "" },
						{ prefix: "app/view/templates/default/campaign/", to: "area", stack: "react", area: "campaigns", confidence: 0.95, why: "" },
						{ prefix: "app/behaviour/commands/campaign/", to: "area", stack: "nestjs", area: "campaigns", confidence: 0.95, why: "" },
						{ prefix: "app/model/classes/campaigns", to: "area", stack: "nestjs", area: "campaigns", confidence: 0.9, why: "" },
						{ prefix: "app/view/templates/default/vue/", to: "shared", stack: "react", area: "widgets", confidence: 0.9, why: "" },
						{ prefix: "app/lib/components/agencytool", to: "area", stack: "nestjs", area: "agencies", confidence: 0.5, why: "maybe" },
						{ prefix: "app/lib/components/uuid.", to: "shared", stack: "nestjs", area: "misc", confidence: 0.9, why: "" },
					],
				} };
			},
			decide: () => ({ area: "agencies" }),
		});
		const r = await resolvePlacements({ ledger, config, root: ws, client, curate: true });
		// the adapter's surface wins over the model's stack: the agency pages stay on the UI stack
		expect(place("agency_list")).toMatchObject({ stackId: "react", area: "agencies", source: "override" });
		expect(place("agency_cmd")).toMatchObject({ stackId: "nestjs", area: "agencies" });
		expect(place("campaign_model")).toMatchObject({ stackId: "nestjs", area: "campaigns" });
		expect(place("progressbar")).toMatchObject({ stackId: "react", area: "widgets", shared: true });
		// an answer's rule stays and wins on its prefix; a rule below the confidence to act is left to Jev
		expect(place("uuid")).toMatchObject({ area: "ids", shared: true });
		expect(place("agency_tool")).toMatchObject({ area: "agencies", source: "model" });
		const rules = JSON.parse(readFileSync(rulesPath(), "utf8")).rules as Array<{ prefix: string; stack?: string; by?: string }>;
		expect(rules.filter((x) => x.prefix === "app/lib/components/uuid.")).toEqual([{ prefix: "app/lib/components/uuid.", area: "ids", shared: true }]);
		expect(rules.filter((x) => x.by === "taxonomy").every((x) => !x.stack)).toBe(true); // gyro: the surface is known for every file
		expect(r.byModel).toBeGreaterThan(0);
		// a second pass: everything placed, nothing curated again
		const calls = client.calls.length;
		await resolvePlacements({ ledger, config, root: ws, client, curate: true });
		expect(client.calls.length).toBe(calls);
	});

	it("curation runs between the code and the model pass, only when something was placed", async () => {
		const client = new FakeModelClient({
			decide: () => ({ area: "shared" }),
			chat: () => ({ json: { areas: [], mappings: [] } }),
		});
		await resolvePlacements({ ledger, config, root: ws, client, curate: true });
		const first = client.calls.length;
		expect(first).toBeGreaterThan(0);
		await resolvePlacements({ ledger, config, root: ws, client, curate: true });
		expect(client.calls.length).toBe(first); // nothing new to place: no curation, no Jev
	});

	it("re-placement settles stale questions: a placed unit never keeps an open placement or area question", async () => {
		// no model: unsure units (money, fpdf, uuid) get placement questions
		await resolvePlacements({ ledger, config, root: ws });
		const open = () => ledger.openQuestions().filter((q) => q.point === "placement").map((q) => q.unit_id).sort();
		expect(open()).toEqual(["fpdf", "money", "uuid"]);
		// an area question on a code-placed unit, then a rule that now places fpdf for sure
		const tq = ledger.askQuestion({ point: "taxonomy", unitId: "agency_cmd", question: "area?", blocks: "unit", askedBy: "taxonomy" });
		ledger.updateUnit("agency_cmd", { meta: { taxonomyQuestion: tq } });
		addRules({ prefix: "app/lib/components/fpdf.", area: "campaign" });
		await resolvePlacements({ ledger, config, root: ws, force: true });
		expect(place("fpdf")).toMatchObject({ area: "campaign", source: "override" });
		for (const u of ledger.listUnits()) {
			const m = JSON.parse(u.meta);
			if (m.place) expect(ledger.openQuestions().filter((q) => q.unit_id === u.id), u.id).toEqual([]);
		}
		expect(ledger.getQuestion(tq)!.status).toBe("withdrawn");
		// still unsure units are asked again with the current candidates: one open question each, not two
		expect(open()).toEqual(["money", "uuid"]);
		// a later placement by another route (e.g. taxonomy writing meta.place) withdraws the open question on the next pass
		ledger.updateUnit("uuid", { meta: { place: { stack: "nestjs", area: "ids", shared: true, source: "taxonomy" } } });
		await resolvePlacements({ ledger, config, root: ws });
		expect(open()).toEqual(["money"]);
	});

	it("fresh repo (no curated areas, no rules): folder names are proposals for Jev, not a question per unit", async () => {
		const plain = join(ws, "plain");
		for (const f of ["src/billing/InvoiceController.php", "src/pricing/Pricing.php"]) (mkdirSync(dirname(join(plain, f)), { recursive: true }), writeFileSync(join(plain, f), "<?php\n"));
		const cfg = ConfigSchema.parse({ source: { path: plain, stack: "php" }, target: { path: join(ws, "migrated2"), stacks: ["nestjs"] }, models: {} });
		const l2 = new Ledger(join(ws, ".bigrefactor", "fresh.sqlite"));
		l2.createUnit({ id: "inv", tier: "T1", deps: [], meta: { files: ["src/billing/InvoiceController.php"] }, symbolIds: [] });
		l2.createUnit({ id: "pricing", tier: "T1", deps: [], meta: { files: ["src/pricing/Pricing.php"] }, symbolIds: [] });
		const client = new FakeModelClient({ decide: (req) => ({ area: (req.state as { path: string }).path.includes("Invoice") ? "billing" : "pricing" }) });
		const r = await resolvePlacements({ ledger: l2, config: cfg, root: join(ws, "fresh-root"), client });
		expect(r).toMatchObject({ placed: 2, byModel: 2, asked: 0 });
		expect(placeUnit(cfg, l2.getUnit("inv")!.meta)).toMatchObject({ area: "billing", source: "model" });
		l2.close();
	});
});


describe("placement rules left from an earlier setup", () => {
	it("a rule for a stack that is no longer a target places nothing; pruning removes it and rules for files the source does not have", () => {
		writeFileSync(join(ws, ".bigrefactor", "placement.json"), JSON.stringify({ rules: [
			{ prefix: "app/controller/money.", area: "billing", stack: "symfony" },
			{ prefix: ".sim/other-repo/src/Config.", area: "config", stack: "nestjs" },
			{ prefix: "app/model/classes/agency.", area: "agencies", stack: "nestjs" },
		] }));
		const meta = (files: string[]) => ({ files });
		expect(() => codePlace(config, meta(["app/controller/money.controller.php"]), ws)).not.toThrow();
		expect(codePlace(config, meta(["app/controller/money.controller.php"]), ws).place.area).not.toBe("billing");
		expect(pruneRules(ws, config)).toEqual(["app/controller/money. (symfony)", ".sim/other-repo/src/Config. (nestjs)"]);
		expect(JSON.parse(readFileSync(join(ws, ".bigrefactor", "placement.json"), "utf8")).rules.map((r: { prefix: string }) => r.prefix)).toEqual(["app/model/classes/agency."]);
		expect(pruneRules(ws, config)).toEqual([]);
	});
});
