import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { getTargetAdapter } from "../src/adapters/registry.ts";
import { ConfigSchema, type Config } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { checkLayout, renderLayout, sampleFacts } from "../src/run/layout-check.ts";
import { placeUnit } from "../src/run/placement.ts";
import { composeRules, rulesDir } from "../src/rules/layout.ts";

/**
 * Layout preflight: the incident (one folder per legacy file, templates on the server stack, 929 dotted dirs in
 * api/src) must show up as problems before a run scales it; a feature-per-area layout must come out clean.
 */
const here = resolve(import.meta.dirname, "..");
let ws: string;
let config: Config;
let ledger: Ledger;

const write = (p: string, s = "x\n") => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, s));
const unit = (id: string, files: string[], stack: string, area: string, shared = false) => ledger.createUnit({ id, tier: "T0", deps: [], meta: { files, place: { stack, area, shared, source: "code" } }, symbolIds: [] });

// a feature-per-area placement: 12 units, 4 modules
const GOOD: Array<[string, string[], string, string]> = [
	["agency_create", ["app/behaviour/commands/agency/create.cmd.php"], "nestjs", "agency"],
	["agency_update", ["app/behaviour/commands/agency/update.cmd.php"], "nestjs", "agency"],
	["agency_delete", ["app/behaviour/commands/agency/delete.cmd.php"], "nestjs", "agency"],
	["agency_model", ["app/model/classes/agency.model.php", "app/model/classes/agency.facade.php"], "nestjs", "agency"],
	["campaign_create", ["app/behaviour/commands/campaign/create.cmd.php"], "nestjs", "campaign"],
	["campaign_update", ["app/behaviour/commands/campaign/update.cmd.php"], "nestjs", "campaign"],
	["campaign_copy", ["app/behaviour/commands/campaign/copy.cmd.php"], "nestjs", "campaign"],
	["agency_list", ["app/view/templates/default/agency/list.tpl.php"], "react", "agency"],
	["agency_edit", ["app/view/templates/default/agency/edit.tpl.php"], "react", "agency"],
	["agency_filter", ["app/view/templates/default/agency/inc/filter.js.tpl.php"], "react", "agency"],
	["campaign_list", ["app/view/templates/default/campaign/list.tpl.php"], "react", "campaign"],
	["campaign_edit", ["app/view/templates/default/campaign/edit.tpl.php"], "react", "campaign"],
];

beforeEach(async () => {
	ws = join(here, ".sim", "layout-check");
	rmSync(ws, { recursive: true, force: true });
	const legacy = join(ws, "legacy");
	mkdirSync(join(legacy, "gyro-php"), { recursive: true });
	for (const [, files] of GOOD) for (const f of files) write(join(legacy, f), "<?php\n");
	const target = join(ws, "migrated");
	config = ConfigSchema.parse({ source: { path: legacy, stack: "php" }, target: { path: target, stacks: ["nestjs", "react"] }, models: {} });
	mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
	ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
	// rules agree with the adapters, each stack has an active lint rule
	for (const s of config.target.stacks) {
		write(join(rulesDir(ws, s), "RULES.md"), composeRules(await getTargetAdapter(s), "# rules\n"));
		write(join(rulesDir(ws, s), "astgrep", "no-any.yml"), "id: no-any\n");
	}
	// a target in the intended layout (+ scaffold files and an asset dir without source files)
	write(join(target, "api", "src", "main.ts"));
	write(join(target, "api", "src", "features", "agency", "agency.service.ts"));
	write(join(target, "api", "src", "shared", "money", "money.ts"));
	write(join(target, "web", "src", "main.tsx"));
	write(join(target, "web", "src", "assets", "logo.svg"));
	write(join(target, "web", "src", "features", "agency", "pages", "AgencyPage.tsx"));
});

describe("checkLayout", () => {
	it("feature-per-area placement and tree: clean", async () => {
		for (const [id, files, stack, area] of GOOD) unit(id, files, stack, area);
		const r = await checkLayout(config, ws, ledger);
		expect(r.problems).toEqual([]);
		// no layout.json yet: said once per stack, the built-in checks apply
		expect(r.warnings.filter((w) => !/no folder layout decided yet/.test(w))).toEqual([]);
		expect(r.warnings).toContainEqual(expect.stringMatching(/^nestjs: no folder layout decided yet/));
		expect(r.summary.perStack).toEqual({ nestjs: 7, react: 5 });
		expect(r.summary.modules[0]).toEqual({ key: "nestjs:agency", units: 4 });
		expect(r.summary.areas).toBe(2);
		const api = r.summary.trees.find((t) => t.stackId === "nestjs")!;
		expect(api.features).toEqual([{ area: "agency", files: 1 }]);
		expect(api.shared).toEqual(["src/shared/money/money.ts"]);
		expect(renderLayout(r).at(-1)).toBe("layout ok");
	});

	it("basename-style placement (one area per legacy file): problems", async () => {
		// what moduleName() did: every unit in a module named after its file
		for (const [id, files, stack] of GOOD) unit(id, files, stack, files[0]!.split("/").pop()!.replace(/\.php$/, ""));
		const r = await checkLayout(config, ws, ledger);
		expect(r.problems.some((p) => /not kebab-case/.test(p) && /list\.tpl/.test(p))).toBe(true);
		expect(r.problems.some((p) => /areas look like file names: \d+\/12 units/.test(p))).toBe(true);
		// unrelated features share `create.cmd`, `list.tpl`: few singletons, the file-name signal catches it
		expect(r.problems.some((p) => /modules hold a single unit/.test(p))).toBe(false);
	});

	it("one module per unit: problem", async () => {
		for (const [id, files, stack] of GOOD) unit(id, files, stack, id.replace(/_/g, "-"));
		const r = await checkLayout(config, ws, ledger);
		expect(r.problems).toEqual([expect.stringMatching(/^areas look like file names: 12\/12 modules hold a single unit/)]);
	});

	it("templates on the server stack while a ui stack exists: problem; a human override is respected", async () => {
		for (const [id, files, stack, area] of GOOD) unit(id, files, id === "agency_list" ? "nestjs" : stack, area);
		let r = await checkLayout(config, ws, ledger);
		expect(r.problems).toEqual([expect.stringMatching(/1 unit\(s\) whose files render UI are placed on a server stack while react exists: agency_list → nestjs/)]);
		ledger.updateUnit("agency_list", { meta: { place: { stack: "nestjs", area: "agency", shared: false, source: "answer" } } });
		r = await checkLayout(config, ws, ledger);
		expect(r.problems).toEqual([]);
	});

	it("dotted folders in the target tree and RULES.md that disagree with the adapter: problems", async () => {
		for (const [id, files, stack, area] of GOOD) unit(id, files, stack, area);
		write(join(config.target.path, "api", "src", "list.tpl", "list.service.ts"));
		write(join(config.target.path, "api", "src", "uuid.cls", "uuid.ts"));
		write(join(config.target.path, "api", "src", "features", "edit.tpl", "edit.service.ts"));
		write(join(rulesDir(ws, "react"), "RULES.md"), "# rules without the layout section\nPut pages in `src/pages/`.\n");
		const r = await checkLayout(config, ws, ledger);
		expect(r.problems).toContainEqual(expect.stringMatching(/^nestjs: 2 folder\(s\) under src\/ outside src\/features\/ and the shared dirs: list\.tpl\/, uuid\.cls\//));
		expect(r.problems).toContainEqual(expect.stringMatching(/^nestjs: 1 feature folder\(s\) under src\/features\/ are not area names: edit\.tpl/));
		expect(r.problems).toContainEqual(expect.stringMatching(/^react: RULES\.md layout section differs/));
		expect(r.problems.some((p) => /assets/.test(p))).toBe(false);
	});

	it("unplaced units and open placement questions are warnings; RULES.md without a single active rule is a problem", async () => {
		for (const [id, files, stack, area] of GOOD) unit(id, files, stack, area);
		ledger.createUnit({ id: "entry", tier: "T0", deps: [], meta: { files: ["www/index.php"] }, symbolIds: [] });
		const q = ledger.askQuestion({ point: "placement", unitId: "entry", question: "q", blocks: "unit", askedBy: "placement" });
		ledger.updateUnit("entry", { meta: { placeQuestion: q } });
		rmSync(join(rulesDir(ws, "react"), "astgrep"), { recursive: true });
		const r = await checkLayout(config, ws, ledger);
		expect(r.problems).toEqual([expect.stringMatching(/^react: RULES\.md exists but no active ast-grep rule/)]);
		expect(r.warnings.filter((w) => !/no folder layout decided yet/.test(w))).toEqual([expect.stringMatching(/^1 unit\(s\) without a placement yet, 0 not asked yet/), expect.stringMatching(/^1 placement question/)]);
		rmSync(join(rulesDir(ws, "react"), "RULES.md"));
		expect((await checkLayout(config, ws, ledger)).warnings).toContainEqual(expect.stringMatching(/^react: no active ast-grep rules/));
	});

	it("sample facts show each landed module's files and the parallel classes code finds", async () => {
		for (const [id, files, stack, area] of GOOD) unit(id, files, stack, area);
		const api = join(config.target.path, "api", "src", "features", "agency");
		write(join(api, "agency.service.ts"), "export class AgencyService {}\n");
		write(join(api, "agency-list-template.service.ts"), "export class AgencyListTemplateService {}\n");
		const landed = ["agency_create", "agency_list"].map((id) => placeUnit(config, ledger.getUnit(id)!.meta, ws));
		const f = await sampleFacts(config, ledger, landed);
		expect(f.lines).toContainEqual(expect.stringMatching(/^  nestjs src\/features\/agency\/: agency-list-template\.service\.ts; agency\.service\.ts$/));
		expect(f.lines).toContainEqual(expect.stringMatching(/src\/features\/agency\/: 2 service classes \(AgencyListTemplateService, AgencyService\)/));
		expect(f.drift).toBeGreaterThan(0);
	});
});
