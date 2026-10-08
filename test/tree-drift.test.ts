import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nestjsAdapter } from "../src/adapters/target/nestjs.ts";
import { reactAdapter } from "../src/adapters/target/react.ts";
import type { TargetAdapter } from "../src/adapters/types.ts";
import { Ledger } from "../src/ledger/db.ts";
import { runGate, sha1 } from "../src/run/gate.ts";
import { checkTree, driftReport, recordDrift } from "../src/run/layout-check.ts";
import type { TidyTask } from "../src/run/tidy.ts";
import { tidyLeftovers, tidyMoves } from "../src/run/unit.ts";

/**
 * Whole-tree drift (checkTree): legacy-named folders, stray folders, naming per structureDoc, size cap and one class
 * per responsibility. Findings in files a unit touched fail structure_ok; the rest is a line-oriented drift report
 * in the ledger (driftReport), filtered per area for the tidy review.
 */
const tick = { cmd: "true", args: [] as string[] };
const adapter: TargetAdapter = { ...nestjsAdapter, build: () => tick, lint: () => tick, test: () => tick };
const TWO = "export class AgencyService {}\nexport class AgencyListService {}\n";

let ws: string;
let project: string;
let ledger: Ledger;
const write = (rel: string, body: string) => {
	mkdirSync(dirname(join(project, rel)), { recursive: true });
	writeFileSync(join(project, rel), body);
};
const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: project, stdio: "pipe" });

beforeEach(() => {
	ws = mkdtempSync(join(tmpdir(), "br-drift-"));
	project = join(ws, "api");
	write("package.json", "{}");
	write("src/main.ts", "export {};\n");
	write("src/features/agency/agency.service.ts", "export class AgencyService {}\n");
	write("src/features/agency/agency.controller.ts", "export class AgencyController {}\n");
	write("src/features/agency/dto/list-agency-response.dto.ts", "export class ListAgencyResponseDto {}\n");
	write("src/shared/money/format-money.ts", "export const formatMoney = (n: number) => n.toFixed(2);\n");
	git("init", "-q");
	git("add", "-A");
	git("commit", "-qm", "scaffold");
	mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
	ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
	ledger.createUnit({ id: "u1", tier: "T0", symbolIds: [] });
});
afterEach(() => {
	ledger.close();
	rmSync(ws, { recursive: true, force: true });
});

describe("checkTree", () => {
	it("a clean tree has no findings", () => {
		expect(checkTree(project, adapter)).toEqual([]);
	});

	it("reports dotted folders, stray folders, misnamed files, oversized files and two services in one file", () => {
		write("src/features/list.tpl/list.ts", "export {};\n");
		write("src/players.facade/players.ts", "export {};\n");
		write("src/features/agency/agency-list.service.ts", TWO);
		write("src/features/agency/helpers.ts", "export {};\n");
		write("src/features/campaign/campaign.service.ts", `export class CampaignService {\n${"\t// line\n".repeat(420)}}\n`);
		const lines = checkTree(project, adapter);
		const has = (re: RegExp) => expect(lines.some((l) => re.test(l)), `${re} in\n${lines.join("\n")}`).toBe(true);
		has(/^src\/features\/list\.tpl\/: folder "list\.tpl" is not kebab-case/);
		has(/^src\/players\.facade\/: outside the feature root/);
		has(/^src\/features\/agency\/agency-list\.service\.ts: 2 exported service classes \(AgencyService, AgencyListService\)/);
		has(/^src\/features\/agency\/helpers\.ts: not a file of the area module/);
		has(/^src\/features\/campaign\/campaign\.service\.ts: 42\d lines \(cap 400\)/);
		expect(lines.filter((l) => l.startsWith("src/features/agency/agency.service.ts"))).toEqual([]);
	});

	it("ui stack: a component file with a legacy template name is drift; the React shapes are not", () => {
		write("src/features/agency/pages/AgencyPage.tsx", "export default function AgencyPage() { return null; }\n");
		write("src/features/agency/components/AgencyTable.tsx", "export function AgencyTable() { return null; }\n");
		write("src/features/agency/list.vue.tsx", "export {};\n");
		const lines = reactAdapter.layout.checkTree!(project).filter((l) => l.includes("/agency/") && !l.includes(".service.ts") && !l.includes(".controller.ts") && !l.includes("/dto/"));
		expect(lines).toEqual([expect.stringMatching(/^src\/features\/agency\/list\.vue\.tsx: not a file of the area module/)]);
	});

	it("records the report line-oriented in the ledger; driftReport filters one area", () => {
		write("src/features/agency/agency-list.service.ts", TWO);
		write("src/features/agency-sso/sso.ts", "export {};\n");
		write("src/shared/agency/AgencyThing.service.ts", "export class AgencyThingService {}\nexport class OtherService {}\n");
		const all = recordDrift(ledger, adapter, project);
		expect(ledger.getMeta("drift:nestjs")!.split("\n")).toEqual(all);
		const agency = driftReport(ledger, "nestjs", "agency");
		// the file's two classes, the misnamed class, the area-wide parallel classes, the shared file
		expect(agency, agency.join("\n")).toHaveLength(4);
		expect(agency).toContainEqual(expect.stringMatching(/^src\/features\/agency\/: 3 service classes \(AgencyService, AgencyListService, AgencyService\)/));
		expect(agency.every((l) => l.startsWith("src/features/agency/") || l.startsWith("src/shared/agency/"))).toBe(true);
		expect(driftReport(ledger, "nestjs", "agency-sso")).toEqual([expect.stringMatching(/^src\/features\/agency-sso\/sso\.ts:/)]);
		expect(driftReport(ledger, "nestjs").length).toBe(all.length);
	});
});

describe("structure_ok and drift", () => {
	const gate = (writeGlobs = ["src/features/agency/**"]) => runGate({ ledger, unitId: "u1", adapter, targetProjectDir: project, writeGlobs, appendOnlyGlobs: ["src/shared/**"], testFiles: [], moduleDir: "src/features/agency", area: "agency", root: ws, stackId: "nestjs" });

	it("fails a touched file with two service classes; pre-existing drift elsewhere does not fail the unit", async () => {
		write("src/features/campaign/campaign.service.ts", `export class CampaignService {\n${"\t// line\n".repeat(420)}}\n`);
		git("add", "-A");
		git("commit", "-qm", "drift elsewhere");
		write("src/features/agency/agency.service.ts", TWO);
		const bad = await gate();
		expect(bad.failedStep).toBe("structure_ok");
		expect(bad.steps.find((s) => s.name === "structure_ok")!.output).toMatch(/agency\.service\.ts: 2 exported service classes/);
		expect(bad.steps.find((s) => s.name === "structure_ok")!.output).not.toMatch(/campaign/);
		write("src/features/agency/agency.service.ts", "export class AgencyService {\n\tlist(): string[] {\n\t\treturn [];\n\t}\n}\n");
		expect((await gate()).ok).toBe(true);
	});

	it("an existing shared file may be removed only when a tidy task names it (its path is in the write scope)", async () => {
		rmSync(join(project, "src/shared/money/format-money.ts"));
		write("src/features/agency/agency.constants.ts", "export const formatMoney = (n: number) => n.toFixed(2);\n");
		const refused = await gate();
		expect(refused.failedStep).toBe("antigaming_ok");
		expect(refused.steps.find((s) => s.name === "antigaming_ok")!.output).toMatch(/existing shared file.*format-money\.ts/);
		const sanctioned = await gate(["src/features/agency/**", "src/shared/money/format-money.ts", "src/features/agency/agency.constants.ts"]);
		expect(sanctioned.ok).toBe(true);
		expect(existsSync(join(project, "src/shared/money/format-money.ts"))).toBe(false);
	});
});

describe("approved tidy tasks in a unit's worktree", () => {
	const task = (op: TidyTask["op"], from: string[], to: string[]): TidyTask => ({ id: "T1", stack: "nestjs", area: "agency", op, from, to, why: "tidy", questionId: 1, status: "approved" });

	it("code does 1:1 renames; merged sources go once every target exists; splits keep theirs", () => {
		write("src/features/agency/agency-list.service.ts", "export class AgencyListService {}\n");
		write("src/features/agency/agency-filter.service.ts", "export const x = 1;\n");
		const tasks = [
			task("rename", ["src/features/agency/agency-list.service.ts"], ["src/features/agency/agency-overview.service.ts"]),
			task("merge", ["src/features/agency/agency-filter.service.ts", "src/shared/money/format-money.ts"], ["src/features/agency/agency.service.ts"]),
			task("split", ["src/features/agency/agency.controller.ts"], ["src/features/agency/agency-admin.controller.ts"]),
		];
		const moved = tidyMoves(project, tasks);
		expect(moved).toEqual(["src/features/agency/agency-list.service.ts → src/features/agency/agency-overview.service.ts"]);
		expect(existsSync(join(project, "src/features/agency/agency-overview.service.ts"))).toBe(true);
		// agency.service.ts exists (scaffolded above): the merge's sources are leftovers; the split's target is missing
		expect(tidyLeftovers(project, tasks, moved).sort()).toEqual(["src/features/agency/agency-filter.service.ts", "src/shared/money/format-money.ts"]);
		write("src/features/agency/agency-admin.controller.ts", "export class AgencyAdminController {}\n");
		expect(tidyLeftovers(project, tasks, moved)).not.toContain("src/features/agency/agency.controller.ts");
	});

	it("moves an earlier unit's test with its file; the gate sees it under the new name, the old name is sanctioned", async () => {
		const from = ["src/features/agency/agency-list.service.ts", "src/features/agency/agency-list.service.spec.ts"];
		const to = ["src/features/agency/agency-overview.service.ts", "src/features/agency/agency-overview.service.spec.ts"];
		write(from[0]!, "export class AgencyListService {}\n");
		write(from[1]!, "it('u0#1 lists agencies', () => {});\n");
		git("add", "-A");
		git("commit", "-qm", "u0");
		const moved = tidyMoves(project, [task("rename", from, to)]);
		expect(moved).toEqual([`${from[0]} → ${to[0]}`, `${from[1]} → ${to[1]}`]);
		const testFiles = [{ path: to[1]!, sha1: sha1(readFileSync(join(project, to[1]!))) }];
		const g = (sanctioned: string[]) => runGate({ ledger, unitId: "u1", adapter, targetProjectDir: project, writeGlobs: ["src/features/agency/**"], testFiles, moduleDir: "src/features/agency", area: "agency", root: ws, stackId: "nestjs", sanctioned });
		expect((await g([])).steps.find((s) => s.name === "antigaming_ok")!.output).toMatch(/changed a test of an earlier unit: .*agency-list\.service\.spec\.ts/);
		write(to[0]!, "export class AgencyOverviewService {}\n"); // the implementer's part: names and imports
		expect((await g([...from, ...to])).ok).toBe(true);
	});

	it("skips renames that only change letter case and never deletes their source as a leftover", () => {
		write("src/features/agency/arangodb.client.ts", "export const db = 1;\n");
		const tasks = [task("rename", ["src/features/agency/arangodb.client.ts"], ["src/features/agency/arangoDb.client.ts"])];
		const lines: string[] = [];
		expect(tidyMoves(project, tasks, (l) => lines.push(l))).toEqual([]);
		expect(lines.join("\n")).toMatch(/skipped .*arangodb\.client\.ts → .*arangoDb\.client\.ts \(only the letter case/);
		expect(tidyLeftovers(project, tasks, [])).toEqual([]);
		expect(existsSync(join(project, "src/features/agency/arangodb.client.ts"))).toBe(true);
	});
});
