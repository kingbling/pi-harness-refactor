import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NEST_LAYOUT, REACT_LAYOUT } from "../src/adapters/target/ts-structure.ts";
import { nestjsAdapter } from "../src/adapters/target/nestjs.ts";
import { validateManifest } from "../src/adapters/target/generated.ts";
import { Ledger } from "../src/ledger/db.ts";
import { FakeModelClient } from "../src/models/fake.ts";
import { layoutRulesPath, loadLayoutRules, normalize, validateLayoutRules } from "../src/rules/layout-rules.ts";
import { askLayout, draftLayout, layoutPreview, ownerRule } from "../src/rules/owner-layout.ts";

/** The owner decides the layout: the framework's convention at onboarding, plain-words changes, nothing applied unasked. */
const ui = (answers: string[], texts: string[] = []) => {
	const asked: string[] = [];
	const logs: string[] = [];
	return { asked, logs, text: async () => texts.shift(), select: async (m: string) => (asked.push(m), answers.shift()), log: (l: string) => logs.push(l) };
};
const withSub = { ...NEST_LAYOUT, files: NEST_LAYOUT.files.filter((f) => !f.path.startsWith("{sub}")) };
const answer = (json: unknown) => new FakeModelClient({ chat: () => ({ json }) } as never);

describe("owner layout", () => {
	it("the built-in conventions are sound; the preview shows an example feature folder", () => {
		expect(validateLayoutRules(normalize(NEST_LAYOUT))).toEqual([]);
		expect(validateLayoutRules(normalize(REACT_LAYOUT))).toEqual([]);
		const p = layoutPreview(normalize(NEST_LAYOUT));
		expect(p).toMatch(/^src\/campaign\/\n/);
		expect(p).toContain("campaign.controller.ts (always)");
		expect(p).toContain("dto/<name>.dto.ts");
		expect(p).toContain("<sub>/campaign-<sub>.service.ts");
		expect(p).toMatch(/never: extended\/, misc\//);
	});

	it("onboarding: the framework's convention is proposed; 'change it' drafts from plain words, checked by code; 'use' writes layout.json", async () => {
		const root = mkdtempSync(join(tmpdir(), "br-ol-"));
		const u = ui(["change", "use"], ["sub-features in their own folder"]);
		const client = answer({ checkable: true, summary: "sub-features get their own folder", reason: "", rules: NEST_LAYOUT, mustPass: ["creation/campaign-creation.service.ts"], mustFail: ["extended/x.service.ts"] });
		const r = await askLayout({ root, stack: "nestjs", adapter: { ...nestjsAdapter, layoutRules: withSub }, ui: u as never, yes: false, client, model: "m" });
		expect(u.asked[0]).toMatch(/How should the nestjs code be organised\? Proposed: the framework's own convention \(NestJS docs/);
		expect(u.asked[0]).not.toContain("<sub>/");
		expect(u.asked[1]).toContain("<sub>/campaign-<sub>.service.ts");
		expect(r).toMatch(/^src\/\{area\} \(sub-features get their own folder\)/);
		expect(loadLayoutRules(root, "nestjs")!.files.some((f) => f.path.startsWith("{sub}/"))).toBe(true);
	});

	it("a draft whose own examples fail goes back to the model; 'decide later' writes nothing; --yes takes the convention", async () => {
		let calls = 0;
		const client = new FakeModelClient({ chat: () => ({ json: { checkable: true, summary: "s", reason: "", rules: NEST_LAYOUT, mustPass: calls++ === 0 ? ["extended/x.service.ts"] : ["campaign.service.ts"], mustFail: [] } }) } as never);
		const d = await draftLayout({ client, model: "m", stack: "nestjs", current: normalize(NEST_LAYOUT), words: "x" });
		expect(d.ok).toBe(true);
		expect(calls).toBe(2);

		const root = mkdtempSync(join(tmpdir(), "br-ol-"));
		expect(await askLayout({ root, stack: "nestjs", adapter: nestjsAdapter, ui: ui(["later"]) as never, yes: false, model: "m" })).toBe("decided later");
		expect(existsSync(layoutRulesPath(root, "nestjs"))).toBe(false);
		await askLayout({ root, stack: "nestjs", adapter: nestjsAdapter, ui: ui([]) as never, yes: true, model: "m" });
		expect(loadLayoutRules(root, "nestjs")!.moduleDir).toBe("src/{area}");
	});

	it("/br rule: shows the change and what already breaks it, writes nothing until apply; a non-folder request becomes a written rule", async () => {
		const root = mkdtempSync(join(tmpdir(), "br-ol-"));
		const ledger = new Ledger(":memory:");
		const client = answer({ checkable: true, summary: "no extended/ folder", reason: "", rules: NEST_LAYOUT, mustPass: [], mustFail: ["extended/a.service.ts"] });
		const no = ui(["reject"]);
		expect(await ownerRule({ root, stack: "nestjs", adapter: nestjsAdapter, words: "no extended folder", ui: no as never, client, model: "m", ledger })).toBe("nothing changed");
		expect(no.asked[0]).toMatch(/Change the nestjs folder layout\? no extended\/ folder/);
		expect(existsSync(layoutRulesPath(root, "nestjs"))).toBe(false);
		expect(await ownerRule({ root, stack: "nestjs", adapter: nestjsAdapter, words: "no extended folder", ui: ui(["apply"]) as never, client, model: "m", ledger })).toMatch(/^applied: no extended\/ folder/);
		expect(JSON.parse(readFileSync(layoutRulesPath(root, "nestjs"), "utf8")).moduleDir).toBe("src/{area}");

		const style = answer({ checkable: false, summary: "", reason: "this is about code style, not folders", rules: NEST_LAYOUT, mustPass: [], mustFail: [] });
		expect(await ownerRule({ root, stack: "nestjs", adapter: nestjsAdapter, words: "use early returns", ui: ui([]) as never, client: style, model: "m", ledger })).toMatch(/^not a folder rule the checker can enforce \(this is about code style/);
		expect(ledger.db.prepare("SELECT text, why FROM rule_proposals").all()).toEqual([{ text: "use early returns", why: "owner (/br rule)" }]);
	});

	it("generated stacks: layout.rules in the manifest are checked like an owner's", () => {
		const m = { layout: { moduleDir: "src/{Area}", rules: { moduleDir: "src/{area}", files: [{ path: "{thing}.php", doc: "" }], require: [], forbidDirs: [], place: [] } } };
		const p = validateManifest(m as never);
		expect(p).toContainEqual(expect.stringMatching(/layout\.rules\.moduleDir "src\/\{area\}" must equal layout\.moduleDir "src\/\{Area\}"/));
		expect(p).toContainEqual(expect.stringMatching(/layout\.rules: files: unknown placeholder \{thing\}/));
	});
});

describe("existing projects keep their feature root", () => {
	it("a project with feature folders under src/features/ is offered the convention there, never moved as a side effect", async () => {
		const { mkdirSync, writeFileSync } = await import("node:fs");
		const root = mkdtempSync(join(tmpdir(), "br-ol-"));
		const project = mkdtempSync(join(tmpdir(), "br-olp-"));
		mkdirSync(join(project, "src/features/campaign"), { recursive: true });
		writeFileSync(join(project, "src/features/campaign/campaign.service.ts"), "x\n");
		const r = await askLayout({ root, stack: "nestjs", adapter: nestjsAdapter, ui: ui([]) as never, yes: true, model: "m", projectDir: project });
		expect(r).toMatch(/^src\/features\/\{area\} \(.*keeping your existing feature folders under src\/features\//);
		expect(loadLayoutRules(root, "nestjs")!.moduleDir).toBe("src/features/{area}");
	});
});
