import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reactAdapter } from "../src/adapters/target/react.ts";
import { ConfigSchema } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { implementerSystemPrompt } from "../src/run/prompts.ts";
import { legacyFacts, reviewWithModel } from "../src/run/review.ts";
import { renderLayoutSection } from "../src/rules/layout.ts";
import type { LeafSession, SpawnOptions } from "../src/sessions/spawn.ts";
import { unitOfLegacy, whoCalls } from "../src/sessions/tools.ts";

/**
 * A page (template unit) is reached through its controller by view name, not by a class name: the reviewer and
 * who_calls find that caller and its unit's state, so a page whose controller is not migrated yet is not asked
 * for a route. The implementer sees the owner's stack choices and that the wiring files are in its write paths;
 * data/asset files it cannot write by hand go to outOfScope.
 */
function setup(controllerState: "planned" | "accepted", controllerStack = "react") {
	const dir = mkdtempSync(join(tmpdir(), "br-page-wiring-"));
	const ledger = new Ledger(":memory:");
	const config = ConfigSchema.parse({ source: { path: dir, stack: "php" }, target: { path: dir, stacks: ["react"], choices: { react: { styling: "css-modules" } } }, models: {} });
	const tpl = "app/view/templates/default/offers/list.tpl.php";
	const ctl = "app/controller/sales.controller.php";
	for (const [unit, file, name, kind] of [["U1482", tpl, "list.tpl.php", "template"], ["U2210", ctl, "SalesController", "class"]] as const) {
		const id = `${file}::${kind === "template" ? "template" : name}`;
		ledger.upsertFile({ path: file, hash: "h", lang: "php", loc: 10 });
		ledger.upsertSymbol({ id, path: file, kind, name });
		const stack = unit === "U2210" ? controllerStack : "react";
		ledger.createUnit({ id: unit, tier: "T1", deps: [], meta: { files: [file], place: { stack, area: "offers", shared: false, source: "code" } }, symbolIds: [id] });
	}
	ledger.db.prepare("UPDATE units SET state = ? WHERE id = 'U2210'").run(controllerState);
	ledger.db.prepare("INSERT INTO index_literal_refs(name, path, line) VALUES (?, ?, 0)").run("offers/list", ctl);
	return { dir, ledger, config, tpl };
}

describe("page wiring: callers by view name, choices and wiring for the implementer, assets out of scope", () => {
	it("the reviewer sees the controller that renders the page by its view name, with that unit's state", async () => {
		const { ledger, config, tpl } = setup("planned");
		const facts = (await legacyFacts({ ledger, config, unitId: "U1482", legacyFiles: [tpl], adapter: reactAdapter, targetProjectDir: "/nowhere" })).join("\n");
		expect(facts).not.toMatch(/Legacy callers of this unit's code: none/);
		expect(facts).toMatch(/app\/controller\/sales\.controller\.php names "offers\/list" in a string \([^)]*unit U2210 planned on react\)/);
		expect(facts).toMatch(/A caller whose unit is not accepted yet and is on react too is not migrated[^\n]*TODO\(br:<that unit>\)/);
	});

	it("a caller unit on another stack never wires this stack: the page registers itself, the reviewer and who_calls show the stack", async () => {
		const { ledger, config, tpl } = setup("planned", "symfony");
		const facts = (await legacyFacts({ ledger, config, unitId: "U1482", legacyFiles: [tpl], adapter: reactAdapter, targetProjectDir: "/nowhere" })).join("\n");
		expect(facts).toMatch(/unit U2210 planned on symfony\)/);
		expect(facts).toMatch(/A caller's unit on another stack can never write react's wiring files: registering the page or handler here[^\n]*is this unit's own job/);
		const out = await whoCalls({ ledger, config } as never).execute("t", { symbolId: `${tpl}::template` }, undefined as never, undefined as never, undefined as never);
		expect((out.content[0] as { text: string }).text).toMatch(/names "offers\/list", unit U2210 planned on symfony/);
	});

	it("who_calls on a template finds its controller by view name and says the controller unit's state", async () => {
		const { ledger, config, tpl } = setup("accepted");
		const out = await whoCalls({ ledger, config } as never).execute("t", { symbolId: `${tpl}::template` }, undefined as never, undefined as never, undefined as never);
		expect((out.content[0] as { text: string }).text).toMatch(/app\/controller\/sales\.controller\.php names "offers\/list", unit U2210 accepted on react/);
	});

	it("a caller's unit: its exact symbol first, never a symbol of the same file without a unit", () => {
		const { ledger } = setup("planned");
		const ctl = "app/controller/sales.controller.php";
		ledger.upsertSymbol({ id: `${ctl}::Aaa`, path: ctl, kind: "class", name: "Aaa" });
		ledger.createUnit({ id: "U9", tier: "T1", deps: [], meta: {}, symbolIds: [`${ctl}::Zzz`] });
		ledger.upsertSymbol({ id: `${ctl}::Zzz`, path: ctl, kind: "class", name: "Zzz" });
		ledger.db.prepare("UPDATE symbols SET unit_id = 'U9' WHERE id = ?").run(`${ctl}::Zzz`);
		expect(unitOfLegacy(ledger, `${ctl}::Zzz`)).toBe("U9");
		expect(unitOfLegacy(ledger, `${ctl}::SalesController`)).toBe("U2210");
		expect(unitOfLegacy(ledger, `${ctl}::Aaa`)).not.toBeNull();
		expect(unitOfLegacy(ledger, "app/none.php")).toBeNull();
	});

	it("the implementer gets the owner's stack choices and the stack's wiring files as its own write paths", () => {
		const { config } = setup("planned");
		const p = implementerSystemPrompt(config, { area: "offers", stackId: "react", moduleDir: "src/features/offers", structureDoc: "-", sharedDirs: [], rules: "", attempt: 1, writeGlobs: ["src/features/offers/**", ...reactAdapter.layout.wiringFiles!], source: { id: "php" } as never, target: reactAdapter });
		expect(p).toMatch(/owner's stack choices[\s\S]*- Styling: CSS Modules/);
		for (const f of reactAdapter.layout.wiringFiles!) expect(p).toContain(f);
		expect(p).toMatch(/wiring files are in your write paths/);
		expect(p).toMatch(/caller's unit is on react too and not accepted yet[^\n]*TODO\(br:<that unit>\)/);
		expect(p).toMatch(/A caller's unit on another stack can never write these files: then you register it here yourself/);
		expect(p).toMatch(/data or asset file you cannot write by hand/);
	});

	it("template data seam: the implementer finds the project's one shared data seam with its tools and never designs its own; stack choices only where the legacy code has that concern", () => {
		const { config } = setup("planned");
		const p = implementerSystemPrompt(config, { area: "offers", stackId: "react", moduleDir: "src/features/offers", structureDoc: "-", sharedDirs: [], rules: "", attempt: 1, writeGlobs: ["src/features/offers/**", ...reactAdapter.layout.wiringFiles!], source: { id: "php" } as never, target: reactAdapter });
		expect(p).toMatch(/project's one shared data seam: find it with target_lookup \/ find_capability[^\n]*?use it as it is; never design a new one per page/);
		expect(p).toMatch(/has none yet[^.]*say in your final line that the project has no shared data seam/);
		expect(p).toMatch(/A choice applies only when the legacy code has that concern/);
	});

	it("the reviewer: a registered page that gets its data through the shared seam behind TODO(br:…) is connected; a missing seam is one outOfScope item; a stack choice applies only where the legacy code has that concern", async () => {
		const { dir, ledger, config, tpl } = setup("planned");
		let system = "";
		let tools: string[] = [];
		const spawn = (async (opts: SpawnOptions) => {
			system = opts.systemPrompt ?? "";
			tools = (opts.customTools ?? []).map((t) => t.name);
			return { run: async () => ({ text: "", toolCalls: 0, blocked: 0, usage: { input: 0, output: 0, cost: 0 } }), dispose() {} } as unknown as LeafSession;
		}) as never;
		await reviewWithModel({ ledger, config, root: dir, unitId: "U1482", adapter: reactAdapter, targetProjectDir: dir, moduleDir: "src/features/offers", legacyFiles: [tpl], changedFiles: [], spawn });
		expect(tools).toEqual(expect.arrayContaining(["target_lookup", "find_capability"]));
		expect(system).toMatch(/a registered page that gets its data through that seam, marked TODO\(br:<that unit>\), is connected, and the seam's shape, name or typing is never a finding/);
		expect(system).toMatch(/no shared data seam yet[^.]*put it in outOfScope \(setup = false\)/);
		expect(system).toMatch(/A choice applies only when the unit's legacy code has that concern/);
		expect(system).toMatch(/Asking for a choice where the legacy code has no such concern is not a finding/);
	});

	it("the binding layout section names the wiring files every unit may edit", () => {
		const s = renderLayoutSection(reactAdapter);
		for (const f of reactAdapter.layout.wiringFiles!) expect(s).toContain(`\`${f}\``);
		expect(s).toMatch(/every unit may edit them/);
	});

	it("the reviewer is told that data/asset files the implementer cannot write by hand go to outOfScope", async () => {
		const { dir, ledger, config, tpl } = setup("planned");
		let system = "";
		const spawn = (async (opts: SpawnOptions) => {
			system = opts.systemPrompt ?? "";
			return { run: async () => ({ text: "", toolCalls: 0, blocked: 0, usage: { input: 0, output: 0, cost: 0 } }), dispose() {} } as unknown as LeafSession;
		}) as never;
		await reviewWithModel({ ledger, config, root: dir, unitId: "U1482", adapter: reactAdapter, targetProjectDir: dir, moduleDir: "src/features/offers", legacyFiles: [tpl], changedFiles: [], spawn });
		expect(system).toMatch(/data or asset file it cannot write by hand[^.]*\) goes in outOfScope/);
		expect(system).toMatch(/while that caller's unit is not accepted and is on this same stack[^;]*TODO\(br:<that unit>\), is fine and not a finding; a caller's unit on another stack can never write this stack's wiring files/);
	});
});
