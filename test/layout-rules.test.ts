import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { NEST_LAYOUT } from "../src/adapters/target/ts-structure.ts";
import { nestjsAdapter } from "../src/adapters/target/nestjs.ts";
import { checkLayoutRules, checkLayoutTree, layoutRulesPath, layoutRulesProblem, loadLayoutRules, normalize, saveLayoutRules, validateLayoutRules, withLayoutRules, type LayoutRules } from "../src/rules/layout-rules.ts";
import { examplesProblems } from "../src/rules/owner-layout.ts";

/**
 * The owner's feature-folder layout is enforced by code: controller, service and module at the feature root,
 * request/response classes in dto/, sub-features in folders named after what they do, never extended/.
 */
const rules = normalize(NEST_LAYOUT);
const opts = { sharedDirs: ["src/shared/"], dataDirs: ["src/db/"], isTestFile: (f: string) => /\.spec\.ts$/.test(f), sourceExtensions: [".ts"] };
const mod = "src/campaign";
function project(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "br-lr-"));
	for (const [p, t] of Object.entries(files)) (mkdirSync(dirname(join(dir, p)), { recursive: true }), writeFileSync(join(dir, p), t));
	return dir;
}
const BASE = { [`${mod}/campaign.module.ts`]: "@Module({})\nexport class CampaignModule {}\n", [`${mod}/campaign.controller.ts`]: "@Controller('campaign')\nexport class CampaignController {}\n", [`${mod}/campaign.service.ts`]: "export class CampaignService {}\n" };
const NEW = { isNew: () => true };
const check = (dir: string, files: string[], ctx: Parameters<typeof checkLayoutRules>[6] = NEW) => checkLayoutRules(files, mod, "campaign", dir, rules, opts, ctx);

describe("layout rules", () => {
	it("the NestJS convention is sound: examples pass, a catch-all folder fails", () => {
		expect(validateLayoutRules(rules)).toEqual([]);
		expect(rules.forbidDirs).toEqual(expect.arrayContaining(["extended", "misc", "utils"]));
	});

	it("allows the feature root, dto/ and named sub-feature folders", () => {
		const files = { ...BASE, [`${mod}/dto/create-campaign.dto.ts`]: "export class CreateCampaignDto {}\n", [`${mod}/creation/campaign-creation.service.ts`]: "export class CampaignCreationService {}\n", [`${mod}/creation/dto/start-creation.dto.ts`]: "export class StartCreationDto {}\n", [`${mod}/creation/campaign-creation.service.spec.ts`]: "it('x')\n" };
		expect(check(project(files), Object.keys(files))).toEqual([]);
	});

	it("rejects extended/, unnamed files, a sub-feature file named after another folder, and says what to do", () => {
		const files = { ...BASE, [`${mod}/extended/stats.service.ts`]: "x", [`${mod}/creation/helper.ts`]: "x", [`${mod}/stuff/campaign-other.service.ts`]: "x", [`${mod}/dto/campaign-dto.service.ts`]: "x" };
		const out = check(project(files), Object.keys(files));
		expect(out).toContainEqual(expect.stringMatching(/^src\/campaign\/extended\/stats\.service\.ts: folder "extended" is not allowed .* name the folder after what the code does/));
		expect(out).toContainEqual(expect.stringMatching(/^src\/campaign\/creation\/helper\.ts: not an allowed file .* campaign\.module\.ts \| campaign\.controller\.ts/));
		expect(out).toContainEqual(expect.stringMatching(/^src\/campaign\/stuff\/campaign-other\.service\.ts: not an allowed file/)); // {sub} must repeat
		expect(out).toContainEqual(expect.stringMatching(/^src\/campaign\/dto\/campaign-dto\.service\.ts: not an allowed file/)); // dto is no sub-feature
	});

	it("places code: a Dto class outside dto/, a controller in the service file; the controller is always required", () => {
		const files = { [`${mod}/campaign.module.ts`]: "@Module({})\n", [`${mod}/campaign.service.ts`]: "export class CreateCampaignDto {}\n@Controller('x')\nexport class CampaignApi {}\n" };
		const out = check(project(files), Object.keys(files));
		expect(out).toContainEqual(expect.stringMatching(/^src\/campaign\/campaign\.service\.ts: "export class CreateCampaignDto" belongs in dto\/<name>\.dto\.ts or <sub>\/dto\/<name>\.dto\.ts/));
		expect(out).toContainEqual(expect.stringMatching(/^src\/campaign\/campaign\.service\.ts: "@Controller\(" belongs in campaign\.controller\.ts/));
		expect(out).toContainEqual(expect.stringMatching(/^src\/campaign\/: missing campaign\.controller\.ts .*; create it/));
	});

	it("shared topics and the data dirs: a topic is required and never a banned name; the DB lane's files are not feature files", () => {
		const dir = project(BASE);
		expect(check(dir, ["src/shared/utils/format.ts", "src/shared/x.ts", "src/shared/dates/format-date.ts", "src/db/schema.ts"])).toEqual([
			expect.stringMatching(/^src\/shared\/utils\/format\.ts: shared topic "utils" is not allowed/),
			expect.stringMatching(/^src\/shared\/x\.ts: shared files go in src\/shared\/<topic>\/<name>/),
		]);
	});

	it("the whole tree: shared, data and scaffold folders under src/ are no feature folders; per-file findings of the stack apply", () => {
		const dir = project({ ...BASE, "src/shared/dates/format-date.ts": "x\n", "src/db/schema.ts": "x\n", [`${mod}/extended/a.ts`]: "x\n", "src/billing/billing.service.ts": "export class BillingService {}\nexport class OtherService {}\n" });
		const out = checkLayoutTree(dir, rules, { ...opts, fileFindings: (_p, f) => (f.endsWith("billing.service.ts") ? [`${f}: two classes`] : []) });
		expect(out).toContainEqual(expect.stringMatching(/^src\/campaign\/extended\/a\.ts: folder "extended"/));
		expect(out).toContainEqual(expect.stringMatching(/^src\/billing\/: missing billing\.module\.ts/));
		expect(out).toContain("src/billing/billing.service.ts: two classes");
		expect(out.some((l) => l.startsWith("src/shared/") || l.startsWith("src/db/"))).toBe(false);
	});

	it("bad rules are refused: unknown placeholder, require that is no allowed file, a folder with any name", () => {
		const bad: LayoutRules = { moduleDir: "src/{area}", files: [{ path: "{name}/index.ts", doc: "anything" }], require: ["{area}.module.ts"], forbidDirs: ["extended"], place: [{ text: "(", in: ["x.ts"], doc: "" }] };
		const p = validateLayoutRules(bad);
		expect(validateLayoutRules({ ...bad, files: [{ path: "{thing}.ts", doc: "" }] })).toContainEqual(expect.stringMatching(/unknown placeholder \{thing\}/));
		expect(p).toContainEqual(expect.stringMatching(/require: "\{area\}\.module\.ts" is not an allowed file/));
		expect(p).toContainEqual(expect.stringMatching(/place: "\(" is not a valid regex/));
		expect(p).toContainEqual(expect.stringMatching(/files: "\{name\}\/index\.ts" allows a folder with any name; use \{sub\}/));
		expect(validateLayoutRules({ ...rules, moduleDir: "src/features" })).toContainEqual(expect.stringMatching(/must end with \{area\}/));
	});

	it("works for any stack: Pascal-case PHP folders (Symfony-style)", () => {
		const sym = normalize({ moduleDir: "src/{Area}", files: [{ path: "Controller/{Area}Controller.php", doc: "" }, { path: "Service/{Area}{Name}Service.php", doc: "" }, { path: "Service/{Area}Service.php", doc: "" }], require: ["Controller/{Area}Controller.php"] });
		expect(validateLayoutRules(sym)).toEqual([]);
		const r = checkLayoutRules(["src/Campaign/Controller/CampaignController.php", "src/Campaign/Service/CampaignCreationService.php", "src/Campaign/Extended/X.php"], "src/Campaign", "campaign", "/nonexistent", sym, { sharedDirs: [], isTestFile: () => false });
		expect(r).toEqual([expect.stringMatching(/^src\/Campaign\/Extended\/X\.php: folder "Extended" is not allowed/)]); // banned names in any case
	});

	it("the model's examples are run through the checker before the owner sees a draft", () => {
		expect(examplesProblems(rules, ["creation/campaign-creation.service.ts"], ["extended/x.service.ts"])).toEqual([]);
		expect(examplesProblems(rules, ["extended/x.service.ts"], ["campaign.service.ts"])).toEqual([expect.stringMatching(/^extended\/x\.service\.ts should pass but fails/), "campaign.service.ts should fail but passes"]);
	});
});

describe("every adapter goes through the layout rules", () => {
	it("without layout.json: the built-in layout plus the banned folder names", () => {
		const root = mkdtempSync(join(tmpdir(), "br-lw-"));
		const a = withLayoutRules(nestjsAdapter, root);
		expect(a.layout.moduleDir("campaign")).toBe("src/features/campaign");
		expect(a.layout.checkStructure!(["src/features/campaign/extended/campaign.service.ts"], "src/features/campaign", "campaign", root, { isNew: () => true })).toContainEqual(expect.stringMatching(/folder "extended" is not allowed/));
		// files that are already there keep working: the ban is for new ones
		expect(a.layout.checkStructure!(["src/shared/utils/format.ts"], "src/features/campaign", "campaign", root, { isNew: () => false })).toEqual([]);
	});

	it("a layout.json written mid-run applies to the next check (read at call time); a broken file keeps the last good one and is reported", () => {
		const root = mkdtempSync(join(tmpdir(), "br-lw-"));
		const a = withLayoutRules(nestjsAdapter, root); // loaded before the rules exist, as a running scheduler holds it
		saveLayoutRules(root, "nestjs", rules);
		expect(a.layout.moduleDir("campaign")).toBe("src/campaign");
		expect(a.layout.structureDoc).toMatch(/One feature folder per legacy area: src\/<area>\/ \(from NestJS docs/);
		expect(a.layout.structureDoc).toContain("Never a folder named extended");
		const dir = project(BASE);
		expect(a.layout.checkStructure!([`${mod}/extended/a.ts`], mod, "campaign", dir)).toContainEqual(expect.stringMatching(/folder "extended"/));
		writeFileSync(layoutRulesPath(root, "nestjs"), "{ broken");
		expect(loadLayoutRules(root, "nestjs")?.moduleDir).toBe("src/{area}");
		expect(layoutRulesProblem(root, "nestjs")).toMatch(/layout\.json: /);
		expect(() => saveLayoutRules(root, "nestjs", { ...rules, moduleDir: "src" })).toThrow(/not usable/);
	});
});

describe("review fixes: what an agent can no longer slip through, and what keeps working", () => {
	it("a controller in a sub-feature service file and a Dto class without export are caught", () => {
		const files = { ...BASE, [`${mod}/creation/campaign-creation.service.ts`]: "@Controller('x')\nexport class CampaignCreationService {}\n", [`${mod}/campaign.controller.ts`]: "@Controller('c')\nexport class CampaignController {}\nclass CreateCampaignDto { a = 1 }\n" };
		const out = check(project(files), Object.keys(files));
		expect(out).toContainEqual(expect.stringMatching(/^src\/campaign\/creation\/campaign-creation\.service\.ts: "@Controller\(" belongs in/));
		expect(out).toContainEqual(expect.stringMatching(/^src\/campaign\/campaign\.controller\.ts: "class CreateCampaignDto" belongs in dto\//));
	});

	it("a new flat second file next to a small main file needs a reason (size or a cleanup task); a named sub-feature folder does not", () => {
		const files = { ...BASE, [`${mod}/creation/campaign-creation.service.ts`]: "export class CampaignCreationService {}\n", [`${mod}/campaign-stats.service.ts`]: "export class CampaignStatsService {}\n" };
		const dir = project(files);
		const out = check(dir, Object.keys(files));
		expect(out).toEqual([expect.stringMatching(/^src\/campaign\/campaign-stats\.service\.ts: a parallel service next to src\/campaign\/campaign\.service\.ts \(1 lines\); extend/)]);
		expect(check(dir, [`${mod}/campaign-stats.service.ts`], { isNew: () => true, sanctioned: [`${mod}/campaign-stats.service.ts`] })).toEqual([]);
		expect(check(dir, [`${mod}/campaign-stats.service.ts`], { isNew: () => false })).toEqual([]); // already there: not new
	});

	it("required files: asked when a unit starts a feature folder; an older folder missing one is drift, not a failed unit", () => {
		const dir = project({ [`${mod}/campaign.module.ts`]: "x\n", [`${mod}/campaign.service.ts`]: "x\n" });
		expect(check(dir, [`${mod}/campaign.service.ts`], { isNew: () => true })).toContainEqual(expect.stringMatching(/missing campaign\.controller\.ts/));
		expect(check(dir, [`${mod}/campaign.service.ts`], { isNew: (f) => f.endsWith("service.ts") })).toEqual([]);
		expect(checkLayoutTree(dir, rules, opts)).toContainEqual(expect.stringMatching(/^src\/campaign\/: missing campaign\.controller\.ts/));
		expect(checkLayoutTree(dir, rules, opts, [`${mod}/campaign.service.ts`])).toEqual([]);
	});

	it("rules that contradict themselves or put a placeholder in the parent folders are refused; area folders must be kebab-case", () => {
		expect(validateLayoutRules({ ...rules, files: [...rules.files, { path: "utils/{name}.ts", doc: "" }] })).toContainEqual(expect.stringMatching(/"utils\/\{name\}\.ts" uses the banned folder "utils"/));
		expect(validateLayoutRules({ ...rules, moduleDir: "{area}" })).toContainEqual(expect.stringMatching(/needs a parent folder/));
		expect(validateLayoutRules({ ...rules, moduleDir: "src/{name}/{area}" })).toContainEqual(expect.stringMatching(/only the last folder may be a placeholder/));
		expect(checkLayoutTree(project({ "src/Campaign_Old/x.ts": "x\n" }), rules, opts)).toContainEqual(expect.stringMatching(/^src\/Campaign_Old\/: folder "Campaign_Old" does not follow src\/\{area\}/));
	});
});
