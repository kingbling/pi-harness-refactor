import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nestjsAdapter } from "../src/adapters/target/nestjs.ts";
import { tsCheckStructure, tsCheckTree } from "../src/adapters/target/ts-structure.ts";
import type { TargetAdapter } from "../src/adapters/types.ts";
import { indexTarget } from "../src/inventory/target.ts";
import { Ledger } from "../src/ledger/db.ts";
import { runGate, type GateReport } from "../src/run/gate.ts";

/**
 * structure_ok + rules_ok: the gate fails what the incident produced (folders per legacy file, parallel classes,
 * copied bodies) and runs the stack's ast-grep rules, in a temp git repo against a real target index.
 */
const SERVICE = `import { Injectable } from '@nestjs/common';

@Injectable()
export class AgencyService {
	total(items: Array<{ price: number; qty: number }>): number {
		let sum = 0;
		for (const i of items) sum += i.price * i.qty;
		const rounded = Math.round(sum * 100) / 100;
		return rounded;
	}
}
`;
// same body, other formatting, other types, a comment
const COPIED = `export class CampaignService {
	sum(items: any[]) {
		let sum = 0 // running total
		for (const i of items)   sum += i.price * i.qty;
		const rounded = Math.round(sum * 100) / 100 as number;
		return rounded;
	}
}
`;
const tick = { cmd: "true", args: [] as string[] };
const adapter: TargetAdapter = { ...nestjsAdapter, build: () => tick, lint: () => tick, test: () => tick };

let ws: string;
let project: string;
let ledger: Ledger;
const write = (rel: string, body: string) => {
	mkdirSync(dirname(join(project, rel)), { recursive: true });
	writeFileSync(join(project, rel), body);
};
const gate = (area: string, extra: Partial<Parameters<typeof runGate>[0]> = {}) =>
	runGate({ ledger, unitId: "u1", adapter, targetProjectDir: project, writeGlobs: ["src/**"], testFiles: [], moduleDir: `src/features/${area}`, area, root: ws, stackId: "nestjs", ...extra });
const step = (r: GateReport, name: string) => r.steps.find((s) => s.name === name);
const commit = () => {
	execFileSync("git", ["add", "-A"], { cwd: project });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "landed"], { cwd: project });
};

beforeEach(async () => {
	ws = mkdtempSync(join(tmpdir(), "br-gate-"));
	project = join(ws, "api");
	mkdirSync(project, { recursive: true });
	write("package.json", JSON.stringify({ dependencies: { "@nestjs/core": "^11" } }));
	write("src/features/agency/agency.service.ts", SERVICE);
	write("src/features/agency/dto/create-agency-request.dto.ts", "export class CreateAgencyRequestDto {\n\tname!: string;\n}\n");
	execFileSync("git", ["init", "-q"], { cwd: project });
	execFileSync("git", ["add", "-A"], { cwd: project });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "scaffold"], { cwd: project });
	mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
	ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
	ledger.createUnit({ id: "u1", tier: "T0", symbolIds: [] });
	await indexTarget(ledger, adapter, project);
});
afterEach(() => {
	ledger.close();
	rmSync(ws, { recursive: true, force: true });
});

describe("gate structure_ok", () => {
	it("passes a unit that extends the area's service and adds the controller", async () => {
		write("src/features/agency/agency.service.ts", SERVICE.replace("}\n}", "}\n\tname(): string {\n\t\treturn 'agency';\n\t}\n}"));
		write("src/features/agency/agency.controller.ts", "export class AgencyController {}\n");
		const r = await gate("agency");
		expect(step(r, "structure_ok")?.ok).toBe(true);
		expect(r.ok).toBe(true);
	});
	it("fails a folder named after a legacy file", async () => {
		write("src/list.tpl/x.ts", "export const x = 1;\n");
		const s = step(await gate("agency"), "structure_ok")!;
		expect(s.ok).toBe(false);
		expect(s.output).toMatch(/folder "list\.tpl"/);
	});
	it("fails a dotted folder inside the module", async () => {
		write("src/features/agency/players.facade/players.ts", "export const p = 1;\n");
		expect(step(await gate("agency"), "structure_ok")!.output).toMatch(/players\.facade/);
	});
	it("fails a file shape the structure doc does not name, and a second module file", async () => {
		write("src/features/agency/edit.ts", "export const e = 1;\n");
		write("src/features/agency/agency.module.ts", "export class AgencyModule {}\n");
		write("src/features/agency/agency-edit.module.ts", "export class AgencyEditModule {}\n");
		const s = step(await gate("agency"), "structure_ok")!;
		expect(s.ok).toBe(false);
		expect(s.output).toMatch(/edit\.ts: not a file of the area module/);
		expect(s.output).toMatch(/2 module files/);
	});
	it("fails a parallel class with an existing name in another area", async () => {
		write("src/features/campaign/campaign.service.ts", "export class AgencyService {}\n");
		const s = step(await gate("campaign"), "structure_ok")!;
		expect(s.ok).toBe(false);
		expect(s.output).toMatch(/reuse src\/features\/agency\/agency\.service\.ts::AgencyService/);
	});
	it("same-name DTO in another area fails; an area-specific name passes", async () => {
		write("src/features/campaign/dto/create-agency-request.dto.ts", "export class CreateAgencyRequestDto {}\n");
		expect(step(await gate("campaign"), "structure_ok")!.output).toMatch(/reuse .*::CreateAgencyRequestDto/);
		rmSync(join(project, "src/features/campaign"), { recursive: true });
		write("src/features/campaign/dto/create-campaign-request.dto.ts", "export class CreateCampaignRequestDto {}\n");
		expect(step(await gate("campaign"), "structure_ok")!.ok).toBe(true);
	});
	it("a name that only looks like an existing class is no hard fail: the reviewer gets it as a fact to judge", async () => {
		write("src/features/campaign/dto/create-agency-request-record.dto.ts", "export class CreateAgencyRequestDtoRecord {}\n");
		const seen: string[][] = [];
		const review = async (_files: string[], near?: string[]) => (seen.push(near ?? []), { ok: true, output: "fine", judged: true });
		const r = await gate("campaign", { review });
		const s = step(r, "structure_ok")!;
		expect(s.ok, s.output).toBe(true);
		expect(s.output).toMatch(/note: .*declares CreateAgencyRequestDtoRecord, and .* has CreateAgencyRequestDto: if it is the same record or class, reuse the existing one \(the reviewer judges it\)/);
		expect(seen).toEqual([[expect.stringMatching(/declares CreateAgencyRequestDtoRecord, and src\/features\/agency\/dto\/create-agency-request\.dto\.ts has CreateAgencyRequestDto/)]]);
	});
	it("fails a function body copied into another file", async () => {
		write("src/features/campaign/campaign.service.ts", COPIED);
		const s = step(await gate("campaign"), "structure_ok")!;
		expect(s.ok).toBe(false);
		expect(s.output).toMatch(/reuse src\/features\/agency\/agency\.service\.ts::AgencyService\.total — .*CampaignService\.sum has the same body/);
	});
});

describe("gate structure_ok: one area extends one class per kind (the incident)", () => {
	it("fails a new parallel <area>-<sub>.service.ts next to a small main service; the cap or a tidy task allow it", async () => {
		const sub = "src/features/agency/agency-list-template.service.ts";
		write(sub, "export class AgencyListTemplateService {\n\tping(): number {\n\t\treturn 1;\n\t}\n}\n");
		const s = step(await gate("agency"), "structure_ok")!;
		expect(s.ok).toBe(false);
		expect(s.output).toMatch(/agency-list-template\.service\.ts: a parallel file next to src\/features\/agency\/agency\.service\.ts \(11 lines\)/);
		expect(step(await gate("agency", { sanctioned: [sub] }), "structure_ok")!.ok).toBe(true);
		write(sub, `export class AgencyListTemplateService {\n${"\t// more\n".repeat(392)}}\n`); // 11 + 394 lines would not fit in one file
		expect(step(await gate("agency"), "structure_ok")!.ok).toBe(true);
	});
	it("an edited existing <area>-<sub> file needs no reason", async () => {
		write("src/features/agency/agency-billing.service.ts", "export class AgencyBillingService {}\n");
		commit();
		write("src/features/agency/agency-billing.service.ts", "export class AgencyBillingService {\n\tx = 1;\n}\n");
		expect(step(await gate("agency"), "structure_ok")!.ok).toBe(true);
	});
	it("fails a class not named after its file and a legacy file kind in a name (server and ui)", async () => {
		write("src/features/agency/agency.service.ts", SERVICE.replace("class AgencyService", "class ListTplService"));
		expect(step(await gate("agency"), "structure_ok")!.output).toMatch(/class ListTplService must be named AgencyService/);
		write("src/features/agency/agency.service.ts", SERVICE);
		write("src/features/agency/agency-list-tpl.service.ts", "export class AgencyListTplService {}\n");
		expect(step(await gate("agency", { legacyWords: ["tpl", "cmd"] }), "structure_ok")!.output).toMatch(/agency-list-tpl\.service\.ts: "tpl" is a legacy file kind/);
		const ui = tsCheckStructure(["src/features/agency/components/ListTpl.tsx", "src/features/agency/pages/AgencyListTplPage.tsx", "src/features/agency/components/AgencyTable.tsx"], "src/features/agency", "agency", ws, "ui", { legacyWords: ["tpl"] });
		expect(ui).toEqual([expect.stringMatching(/ListTpl\.tsx: "tpl"/), expect.stringMatching(/AgencyListTplPage\.tsx: "tpl"/)]);
	});
	it("fails a copy hidden in a private method, with renamed locals, or in a non-exported function", async () => {
		const body = "let acc = 0;\n\t\tfor (const r of rows) acc += r.price * r.qty;\n\t\tconst out = Math.round(acc * 100) / 100;\n\t\treturn out;";
		write("src/features/campaign/campaign.service.ts", `export class CampaignService {\n\tprivate sum(rows: any[]) {\n\t\t${body}\n\t}\n}\n`);
		expect(step(await gate("campaign"), "structure_ok")!.output).toMatch(/AgencyService\.total — src\/features\/campaign\/campaign\.service\.ts::CampaignService\.sum has the same body/);
		rmSync(join(project, "src/features/campaign"), { recursive: true });
		write("src/features/campaign/lib/money.ts", `function sum(rows: any[]) {\n\t\t${body}\n}\nexport const fmt = sum;\n`);
		expect(step(await gate("campaign"), "structure_ok")!.output).toMatch(/AgencyService\.total — src\/features\/campaign\/lib\/money\.ts::sum has the same body/);
	});
	it("the idiomatic load-or-404 handler in two areas is no copy", async () => {
		const ctl = (A: string) => `export class ${A}Controller {\n\tconstructor(private readonly service: any) {}\n\tasync get(id: string) {\n\t\tconst row = await this.service.findOne(Number(id));\n\t\tif (!row) throw new Error("not found");\n\t\treturn row;\n\t}\n}\n`;
		write("src/features/agency/agency.controller.ts", ctl("Agency"));
		commit();
		await indexTarget(ledger, adapter, project);
		write("src/features/campaign/campaign.controller.ts", ctl("Campaign"));
		const s = step(await gate("campaign"), "structure_ok")!;
		expect(s.ok, s.output).toBe(true);
	});
	it("a sanctioned tidy rename is no copy of itself", async () => {
		const from = "src/features/agency/agency-list.service.ts";
		const to = "src/features/agency/agency-reports.service.ts";
		const cls = (A: string) => `export class ${A} {\n\treport(rows: any[]) {\n\t\tlet n = 0;\n\t\tfor (const r of rows) n += r.clicks * r.weight + r.views;\n\t\tconst share = Math.round((n / rows.length) * 1000) / 1000;\n\t\treturn share;\n\t}\n}\n`;
		write(from, cls("AgencyListService"));
		commit();
		await indexTarget(ledger, adapter, project);
		rmSync(join(project, from));
		write(to, cls("AgencyReportsService"));
		const s = step(await gate("agency", { sanctioned: [from, to] }), "structure_ok")!;
		expect(s.output).not.toMatch(/reuse/);
		expect(s.ok).toBe(true);
	});
	it("an area unit adds to an existing shared topic, but never starts one or names one after its area", async () => {
		write("src/shared/money/format-money.ts", "export const formatMoney = (n: number) => n.toFixed(2);\n");
		commit();
		write("src/shared/money/parse-money.ts", "export const parseMoney = (s: string) => Number(s);\n");
		expect(step(await gate("agency"), "structure_ok")!.ok).toBe(true);
		write("src/shared/list/list.ts", "export const list = 1;\n");
		write("src/shared/agency/agency-list.ts", "export const agencyList = 1;\n");
		const out = step(await gate("agency"), "structure_ok")!.output;
		expect(out).toMatch(/src\/shared\/list\/list\.ts: new shared topic src\/shared\/list\/ from an area unit/);
		expect(out).toMatch(/src\/shared\/agency\/agency-list\.ts: the area's code goes in src\/features\/agency\/, not in a shared topic named after the area/);
		rmSync(join(project, "src/shared/agency"), { recursive: true });
		expect(step(await gate("agency", { sanctioned: ["src/shared/list/list.ts"] }), "structure_ok")!.ok).toBe(true);
	});
});

describe("ts shapes", () => {
	it("accept Nest generator names, guards, __tests__, area helpers and components/<Name>/<Name>.tsx", () => {
		const server = ["dto/create-agency.dto.ts", "dto/update-agency.dto.ts", "agency.guard.ts", "__tests__/agency.service.spec.ts", "lib/format-budget.ts"].map((f) => `src/features/agency/${f}`);
		expect(tsCheckStructure(server, "src/features/agency", "agency", project, "server")).toEqual([]);
		expect(tsCheckStructure(["src/features/campaign/components/Table/Table.tsx", "src/features/campaign/lib/format-budget.ts"], "src/features/campaign", "campaign", project, "ui")).toEqual([]);
		expect(tsCheckStructure(["src/features/campaign/components/Table/Other.tsx"], "src/features/campaign", "campaign", project, "ui")).toHaveLength(1);
	});
	it("count lines without the trailing newline; a big api file may grow a second one", () => {
		write("src/features/campaign/api/campaign.api.ts", "export const a = 1;\n".repeat(400));
		expect(tsCheckTree(project, "ui", ["src/features/campaign/api/campaign.api.ts"])).toEqual([]);
		write("src/features/campaign/api/campaign-reports.api.ts", "export const b = 1;\n");
		const isNew = () => true;
		expect(tsCheckStructure(["src/features/campaign/api/campaign-reports.api.ts", "src/features/campaign/campaign-reports.types.ts"], "src/features/campaign", "campaign", project, "ui", { isNew })).toEqual([
			expect.stringMatching(/campaign-reports\.types\.ts: a second file of its kind, but src\/features\/campaign\/campaign\.types\.ts does not exist/),
		]);
	});
});

describe("gate rules_ok", () => {
	it("is skipped visibly without rules", async () => {
		write("src/features/agency/agency.controller.ts", "export class AgencyController {}\n");
		const s = step(await gate("agency"), "rules_ok")!;
		expect(s.ok).toBe(true);
		expect(s.output).toMatch(/^skipped: no ast-grep rules for nestjs/);
	});
	it("fails an ast-grep rule hit with rule id and location", async () => {
		const dir = join(ws, ".bigrefactor", "rules", "nestjs", "astgrep");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "no-console.yml"), "id: no-console\nlanguage: typescript\nseverity: error\nmessage: use the Nest Logger\nrule:\n  pattern: console.log($$$A)\n");
		writeFileSync(join(dir, "no-console-test.yml"), "id: no-console\nvalid: []\ninvalid: []\n");
		write("src/features/agency/agency.controller.ts", "export class AgencyController {\n\tping() {\n\t\tconsole.log('x');\n\t}\n}\n");
		const r = await gate("agency");
		const s = step(r, "rules_ok")!;
		expect(s.ok).toBe(false);
		expect(r.failedStep).toBe("rules_ok");
		expect(s.output).toMatch(/no-console src\/features\/agency\/agency\.controller\.ts:3:3 use the Nest Logger/);
	});
	it("says so when a rule file is broken instead of reporting no violations", async () => {
		const dir = join(ws, ".bigrefactor", "rules", "nestjs", "astgrep");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "broken.yml"), "id: broken\nlanguage: typescript\nseverity: error\nrule:\n  nonsense: [1\n");
		write("src/features/agency/agency.controller.ts", "export class AgencyController {}\n");
		const s = step(await gate("agency"), "rules_ok")!;
		expect(s.output).toMatch(/note: rule broken\.yml not applied/);
	});
});

describe("tsCheckStructure (ui)", () => {
	it("accepts the React feature shapes and rejects template-named files", () => {
		const ok = ["src/features/agency-sso/pages/AgencySsoPage.tsx", "src/features/agency-sso/pages/AgencySsoEditPage.tsx", "src/features/agency-sso/components/SsoForm.tsx", "src/features/agency-sso/hooks/use-sso-filters.ts", "src/features/agency-sso/api/agency-sso.api.ts", "src/features/agency-sso/agency-sso.routes.tsx", "src/shared/format/format-date.ts"];
		expect(tsCheckStructure(ok, "src/features/agency-sso", "agency-sso", ws, "ui")).toEqual([]);
		const bad = tsCheckStructure(["src/features/agency-sso/list.tpl.tsx", "src/features/agency-sso/agency-sso.service.ts", "src/features/campaign/pages/CampaignPage.tsx", "src/shared/x.ts"], "src/features/agency-sso", "agency-sso", ws, "ui");
		expect(bad).toHaveLength(4);
	});
});

describe("accepted behaviour stays proven", () => {
	it("a unit with truth cases but no ported test file fails ported_tests_green", async () => {
		write("src/features/agency/agency.controller.ts", "export class AgencyController {}\n");
		ledger.db.prepare("INSERT INTO truth_cases(id, unit_id, symbol_id, inputs, expected, verified_on_old, created_at) VALUES ('u1#1','u1','s','[]','1',1,'t')").run();
		const s = step(await gate("agency"), "ported_tests_green")!;
		expect(s.ok).toBe(false);
		expect(s.output).toMatch(/1 truth case\(s\) but no ported test file/);
	});
	it("changing a test of an earlier unit fails antigaming; its own tests and tidy-sanctioned ones do not", async () => {
		write("src/features/agency/agency.service.spec.ts", "it('u0#1 totals', () => {});\n");
		write("src/features/agency/own.spec.ts", "it('u1#1 names', () => {});\n");
		commit();
		write("src/features/agency/agency.service.spec.ts", "it('u0#1 totals', () => { /* weaker */ });\n");
		write("src/features/agency/own.spec.ts", "it('u1#1 names it', () => {});\n");
		write("src/features/agency/agency.controller.ts", "export class AgencyController {}\n");
		const s = step(await gate("agency"), "antigaming_ok")!;
		expect(s.ok).toBe(false);
		expect(s.output).toMatch(/changed a test of an earlier unit: src\/features\/agency\/agency\.service\.spec\.ts/);
		expect(s.output).not.toMatch(/own\.spec/);
		expect(step(await gate("agency", { sanctioned: ["src/features/agency/agency.service.spec.ts"] }), "antigaming_ok")!.output).not.toMatch(/earlier unit/);
	});
});
