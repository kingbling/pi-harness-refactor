import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { projectDir } from "../src/init/init.ts";
import { answerValue, groupQuestions } from "../src/jev/ask.ts";
import { Ledger } from "../src/ledger/db.ts";
import { FakeModelClient } from "../src/models/fake.ts";
import { askPendingQuirks, quirkRetestNote, quirksOf, recordQuirk } from "../src/run/quirks.ts";
import { curateAreas, syncTaxonomyAnswers, taxonomyHold } from "../src/run/taxonomy.ts";
import { maybeTidyReview, tidyTasks } from "../src/run/tidy.ts";
import { maybeCurateRules, proposeRule, saveRulesVersion, syncRuleAnswers } from "../src/rules/living.ts";

/**
 * Every question type the run asks reaches the owner through `/br answer` and its answer is applied by that
 * type's sync: quirks (keep/drop → tests), rule changes, tidy moves, area exclusions. Questions asking the same
 * decision share one dialog; differing texts can be answered one by one. No Pi process, model calls faked.
 */
const SPLIT = "Answer these one by one";

describe("/br answer applies every question type", () => {
	it("quirk, rule_change, tidy and area_taxonomy answers given in the dialog are picked up by their syncs", async () => {
		const root = mkdtempSync(join(tmpdir(), "br-answer-"));
		mkdirSync(join(root, "legacy"), { recursive: true });
		const raw = { version: 1, source: { path: join(root, "legacy"), stack: "php" }, target: { path: join(root, "new"), stacks: ["nestjs", "react"] }, models: {} };
		writeFileSync(join(root, "bigrefactor.config.json"), JSON.stringify(raw));
		const config = ConfigSchema.parse(raw);
		mkdirSync(join(root, ".bigrefactor"), { recursive: true });
		const ledger = new Ledger(join(root, ".bigrefactor", "ledger.sqlite"));

		const mk = (id: string, file: string, area: string, symbols = ["X"]) => {
			ledger.upsertFile({ path: file, hash: "h", lang: "php", loc: 10 });
			for (const s of symbols) ledger.upsertSymbol({ id: `${file}::${s}`, path: file, kind: "function", name: s });
			ledger.createUnit({ id, tier: "T0", symbolIds: symbols.map((s) => `${file}::${s}`), meta: { files: [file], place: { stack: "nestjs", area, shared: false, source: "code" } } });
		};
		mk("U1", "app/model/classes/flights.facade.php", "flights", ["isEmpty", "total"]);
		mk("U2", "app/model/classes/slots.facade.php", "flights", ["a", "b"]);
		mk("A4", "phpstan-stubs/macros.php", "phpstan-stubs");

		const client = new FakeModelClient({
			chat: (req) => {
				const sys = req.messages[0]!.content;
				if (sys.includes("curate")) return { json: { body: "## Errors\n- throw HttpException", merged: [], rejected: [], breaking: [{ id: 2, impact: "accepted controllers throw" }] } };
				if (sys.includes("tidiness")) return { json: { changes: [{ op: "rename", from: ["src/features/flights/helper2.ts"], to: ["src/features/flights/flight-slots.ts"], why: "name says nothing" }], conventions: [] } };
				if (sys.includes("feature-module structure"))
					return { json: { stacks: [{ stack: "nestjs", areas: [{ name: "flights", purpose: "flight booking" }] }], mappings: [{ from: "nestjs:flights", to: "area", stack: "nestjs", area: "flights", confidence: 0.95, why: "domain" }, { from: "nestjs:phpstan-stubs", to: "exclude", stack: "nestjs", area: "none", confidence: 0.99, why: "static-analysis stubs" }] } };
				return undefined; // phrasing falls back to the unphrased facts
			},
		});
		const d = { ledger, config, root, client };

		// quirks: two of U1 (same decision, different behaviours) and two of U2 with another recommendation
		recordQuirk({ ledger, root }, { unitId: "U1", symbolId: "app/model/classes/flights.facade.php::isEmpty", kind: "suspected_bug", behaviour: "QUIRK-A empty('0') is true", opinion: "drop", why: "PHP emptiness" });
		recordQuirk({ ledger, root }, { unitId: "U1", symbolId: "app/model/classes/flights.facade.php::total", kind: "suspected_bug", behaviour: "QUIRK-B total of [] is '0'", opinion: "drop", why: "callers cast" });
		recordQuirk({ ledger, root }, { unitId: "U2", symbolId: "app/model/classes/slots.facade.php::a", kind: "edge_case", behaviour: "QUIRK-C a() rounds half down", opinion: "keep", why: "invoices depend on it" });
		recordQuirk({ ledger, root }, { unitId: "U2", symbolId: "app/model/classes/slots.facade.php::b", kind: "edge_case", behaviour: "QUIRK-C b() rounds half down", opinion: "keep", why: "invoices depend on it" });
		await askPendingQuirks(d);

		// a breaking rule proposal → rule_change question
		await saveRulesVersion({ ledger, root }, "nestjs", "## Errors\n- throw HttpException", { version: 1 });
		proposeRule({ ledger }, { stack: "nestjs", kind: "add", text: "Dates are ISO strings", why: "legacy sends Y-m-d" });
		const p2 = proposeRule({ ledger }, { stack: "nestjs", kind: "change", text: "Errors return 200 with {error}", why: "legacy clients expect it" });
		expect(p2).toBe(2);
		expect((await maybeCurateRules(d, { threshold: 1 })).asked).toBe(1);

		// a tidy review → tidy question
		const proj = projectDir(config, "nestjs");
		mkdirSync(join(proj, "src/features/flights"), { recursive: true });
		writeFileSync(join(proj, "src/features/flights/helper2.ts"), "export const x = 1;\n");
		expect((await maybeTidyReview(d, { stackId: "nestjs", area: "flights", force: true })).asked).toBe(1);

		// area taxonomy → exclusion question
		expect((await curateAreas(d)).asked).toBe(1);

		const open = ledger.openQuestions();
		expect(open.map((q) => q.point).sort()).toEqual(["area_taxonomy", "quirk", "quirk", "quirk", "quirk", "rule_change", "tidy"]);
		expect(groupQuestions(open).map((g) => g.length).sort()).toEqual([1, 1, 1, 2, 2]);
		ledger.close();

		// the owner answers everything in Pi
		const want = (title: string) =>
			title.includes("QUIRK-B") ? "keep" : title.includes("QUIRK-A") ? "drop" : title.includes("QUIRK-C") ? "keep" : title.includes("[rule_change]") ? "apply" : title.includes("[tidy]") ? "apply" : title.includes("[area_taxonomy]") ? "exclude" : "?";
		const titles: string[] = [];
		const ctx = {
			cwd: root,
			hasUI: true,
			ui: {
				notify: () => {},
				setStatus: () => {},
				select: async (title: string, options: string[]) => {
					titles.push(title);
					if (options.includes(SPLIT) && title.includes("QUIRK-A")) return SPLIT;
					return options.find((o) => answerValue(o) === want(title.split("\n").slice(1).join("\n"))) ?? "Stop answering";
				},
				input: async () => "",
				confirm: async () => true,
				// the question card: answered like the select above, through the card's own options
				custom: (factory: any) =>
					new Promise((resolve) => {
						const card = factory({ requestRender() {} }, {}, {}, resolve);
						const { message: text, options, details } = card.q as { message: string; options?: Array<{ value: string }>; details?: string[] };
						const message = [text, ...(details ?? [])].join("\n"); // a group's members are listed one per line below the question
						if (!options) return resolve("");
						titles.push(message);
						const values = options.map((o) => o.value);
						if (values.includes(SPLIT) && message.includes("QUIRK-A")) return resolve(SPLIT);
						resolve(values.find((o) => answerValue(o) === want(message.split("\n").slice(1).join("\n"))) ?? "Stop answering");
					}),
			},
			sessionManager: { getBranch: () => [] },
		};
		const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
		const entries: string[] = [];
		const pi = { appendEntry: (_t: string, e: { text: string }) => entries.push(e.text), registerCommand: (n: string, def: any) => commands.set(n, def), registerTool: () => {}, registerEntryRenderer: () => {}, registerMessageRenderer: () => {}, on: () => {}, sendMessage: () => {} };
		((await import("../src/pi/extension.ts")).default as (p: any) => void)(pi as any);
		await commands.get("br")!.handler("answer", ctx);

		expect(entries.join("\n")).toMatch(/no open questions left/);
		// 5 groups, the U1 quirk group split into 2 → 7 dialogs; U2's quirks shared one
		expect(titles).toHaveLength(7);
		expect(titles.find((t) => t.includes("QUIRK-C"))).toMatch(/2 questions, one answer for all/);

		const l2 = new Ledger(join(root, ".bigrefactor", "ledger.sqlite"));
		try {
			expect(l2.openQuestions()).toEqual([]);
			// every stored answer is that question's own option string
			for (const q of l2.db.prepare("SELECT options, answer FROM questions").all() as Array<{ options: string; answer: string }>) expect(JSON.parse(q.options)).toContain(q.answer);
			const d2 = { ledger: l2, root };
			expect(quirkRetestNote(d2, "U1")).toMatch(/QUIRK-B.*KEEP/);
			expect(Object.fromEntries(quirksOf(d2).map((q) => [q.behaviour.slice(0, 7), q.status]))).toEqual({ "QUIRK-A": "dropped", "QUIRK-B": "kept", "QUIRK-C": "kept" });
			syncRuleAnswers(d2);
			expect((l2.db.prepare("SELECT status FROM rule_proposals WHERE id = ?").get(p2) as { status: string }).status).toBe("approved");
			expect(tidyTasks(l2, "nestjs", "flights").map((t) => t.status)).toEqual(["approved"]);
			expect(syncTaxonomyAnswers(d2)).toBe(1);
			expect(taxonomyHold(l2.getUnit("A4")!.meta)).toMatch(/excluded/);
		} finally {
			l2.close();
		}
	});
});
