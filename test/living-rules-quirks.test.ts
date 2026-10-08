import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { answerValue, askViaModel, decideOpenFromGoals, discoverDecisions, phraseDecisions, pointHash } from "../src/jev/ask.ts";
import { Ledger } from "../src/ledger/db.ts";
import { FakeModelClient } from "../src/models/fake.ts";
import { askPendingQuirks, quirkRetestNote, quirksOf, recordQuirk } from "../src/run/quirks.ts";
import { rulesText } from "../src/run/prompts.ts";
import { activeRuleFiles, renderLayoutSection, rulesDir, validateRulesLayout } from "../src/rules/layout.ts";
import { maybeCurateRules, proposeRule, saveRulesVersion } from "../src/rules/living.ts";
import { getTargetAdapter } from "../src/adapters/registry.ts";

function setup() {
	const root = mkdtempSync(join(tmpdir(), "br-living-"));
	const src = join(root, "legacy");
	mkdirSync(join(src, "app", "views"), { recursive: true });
	for (let i = 0; i < 4; i++) writeFileSync(join(src, "app", "views", `v${i}.tpl.php`), "<?php echo 1;");
	writeFileSync(join(src, "README.md"), "Ad-serving dashboard for airport screens.");
	const config = ConfigSchema.parse({ version: 1, source: { path: src, stack: "php" }, target: { path: join(root, "new"), stacks: ["nestjs", "react"] }, models: {} });
	const ledger = new Ledger(":memory:");
	ledger.upsertFile({ path: "app/x.php", hash: "h", lang: "php", loc: 10 });
	ledger.upsertSymbol({ id: "app/x.php::isEmpty", path: "app/x.php", kind: "function", name: "isEmpty" });
	ledger.upsertSymbol({ id: "app/x.php::total", path: "app/x.php", kind: "function", name: "total" });
	ledger.createUnit({ id: "U1", tier: "T0", symbolIds: ["app/x.php::isEmpty", "app/x.php::total"], meta: { files: ["app/x.php"] } });
	return { root, config, ledger };
}

describe("questions are phrased by a model", () => {
	it("askViaModel stores the model's question, recommendation first, opinion attached; values stay machine values", async () => {
		const { root, config, ledger } = setup();
		const client = new FakeModelClient({ chat: () => ({ json: { id: "quirk", question: "Can total() stop returning '0' as a string?", options: [{ value: "keep", label: "Keep it", hint: "" }, { value: "drop", label: "Return a number", hint: "" }, { value: "invented", label: "x", hint: "" }], recommended: "drop", opinion: "No caller compares the string." } }) });
		const { id } = await askViaModel({ ledger, config, root, client }, { point: "quirk", unitId: "U1", facts: "total() returns '0'", options: [{ value: "drop" }, { value: "keep" }], askedBy: "tester" });
		const q = ledger.getQuestion(id)!;
		expect(q.question).toMatch(/^Can total\(\) stop/);
		expect(q.question).toMatch(/Opinion: No caller/);
		const opts = JSON.parse(q.options!) as string[];
		expect(opts[0]).toMatch(/^drop — Return a number \(recommended\)/);
		expect(opts.some((o) => o.startsWith("invented"))).toBe(false);
		expect(answerValue(opts[0])).toBe("drop");
	});
	it("without a client the question is visibly unphrased (facts + values), never crafted text", async () => {
		const { root, config, ledger } = setup();
		const { id } = await askViaModel({ ledger, config, root }, { point: "env", facts: "provider down", options: [{ value: "wait" }], askedBy: "orchestrator" });
		expect(ledger.getQuestion(id)!.question).toBe("[env] provider down");
	});
	it("phraseDecisions keeps option values, drops unknown ones; discoverDecisions adds repo: decisions", async () => {
		const { root, config, ledger } = setup();
		const client = new FakeModelClient({
			chat: (req) => {
				const sys = req.messages[0]!.content;
				if (sys.includes("legacy codebase")) return { text: "# Brief\nAirport ad dashboard." };
				if (sys.includes("turn migration decision points")) return { json: { questions: [{ id: "truth-env", question: "Can you run the dashboard locally with its MariaDB dump?", options: [{ value: "none", label: "No", hint: "" }, { value: "bogus", label: "?", hint: "" }], recommended: "none", opinion: "No compose file found." }] } };
				if (sys.includes("Find decisions")) return { json: { decisions: [{ slug: "PDF export", question: "Keep the PDF invoices?", evidence: "app/pdf/", options: [{ value: "keep", label: "Keep", hint: "" }, { value: "drop", label: "Drop", hint: "" }], recommended: "keep", opinion: "Used by billing." }] } };
				return undefined;
			},
		});
		const point = { id: "truth-env", topic: "truth", intent: "runnable?", evidence: "none", options: [{ value: "none" }, { value: "docker-dump" }] };
		const r = await phraseDecisions({ ledger, config, root, client }, [point]);
		expect(r.phrased["truth-env"]!.options.map((o) => o.value)).toEqual(["none"]);
		expect(r.phrased["truth-env"]!.hash).toBe(pointHash(point));
		expect(readFileSync(join(root, ".bigrefactor", "repo-brief.md"), "utf8")).toMatch(/Airport/);
		const disc = await discoverDecisions({ ledger, config, root, client }, [{ id: "truth-env", question: "x" }]);
		expect(Object.keys(disc.discovered)).toEqual(["repo:pdf-export"]);
		expect(disc.discovered["repo:pdf-export"]!.options[0]!.value).toBe("keep");
	});
});

describe("quirk file", () => {
	it("language artifacts with opinion drop are dropped silently; others are asked and block only their unit", async () => {
		const { root, config, ledger } = setup();
		const a = recordQuirk({ ledger, root }, { unitId: "U1", symbolId: "app/x.php::isEmpty", kind: "language_artifact", behaviour: "empty('0') is true", opinion: "drop", why: "PHP emptiness" });
		const b = recordQuirk({ ledger, root }, { unitId: "U1", symbolId: "app/x.php::total", kind: "suspected_bug", behaviour: "total of [] is '0' (string)", opinion: "drop", why: "callers cast" });
		expect(a.status).toBe("dropped");
		expect(b.status).toBe("pending");
		const r = await askPendingQuirks({ ledger, config, root }, "U1");
		expect(r.asked).toBe(1);
		expect([...ledger.blockedUnits().keys()]).toEqual(["U1"]);
		expect(readFileSync(join(root, ".bigrefactor", "quirks.md"), "utf8")).toMatch(/\*\*asked\*\*.*total of \[\]/);
		// owner disagrees with the tester → the unit's tests must be redone, once
		const q = quirksOf({ ledger }, "U1").find((x) => x.id === b.id)!;
		ledger.answerQuestion(q.question_id!, "keep — keep it 1:1");
		const note = quirkRetestNote({ ledger, root }, "U1");
		expect(note).toMatch(/KEEP it/);
		expect(quirkRetestNote({ ledger, root }, "U1")).toBeUndefined();
		expect(ledger.blockedUnits().size).toBe(0);
	});
});

describe("living rules", () => {
	it("layout is code-rendered per stack; validator and ast-grep listing agree", async () => {
		const { root, config, ledger } = setup();
		await saveRulesVersion({ ledger, root }, "nestjs", "## Errors\n- throw HttpException", { version: 1 });
		await saveRulesVersion({ ledger, root }, "react", "## UI\n- put pages in `src/list.tpl/`\n- evidence from the old code: `src/controllers/InvoiceController.php` (a legacy file, not a folder of the new project)", { version: 1 });
		const nest = await getTargetAdapter("nestjs");
		expect(readFileSync(join(rulesDir(root, "nestjs"), "RULES.md"), "utf8")).toContain(renderLayoutSection(nest));
		const problems = await validateRulesLayout(root, config);
		expect(problems).toEqual([expect.stringMatching(/react: RULES.md names module root src\/list.tpl\//)]);
		mkdirSync(join(rulesDir(root, "nestjs"), "astgrep"), { recursive: true });
		writeFileSync(join(rulesDir(root, "nestjs"), "astgrep", "no-any.yml"), "id: no-any");
		writeFileSync(join(rulesDir(root, "nestjs"), "astgrep", "no-any-test.yml"), "id: no-any");
		expect(activeRuleFiles(root, "nestjs").map((f) => f.split("/").pop())).toEqual(["no-any.yml"]);
		expect(rulesText(root, "nestjs")).toMatch(/throw HttpException/);
		expect(rulesText(root, "react")).not.toMatch(/HttpException/);
	});
	it("proposals are curated into a new version; breaking ones are decided by the run, and merge after the owner says apply", async () => {
		const { root, config, ledger } = setup();
		await saveRulesVersion({ ledger, root }, "nestjs", "## Errors\n- throw HttpException", { version: 1 });
		const p1 = proposeRule({ ledger }, { stack: "nestjs", unitId: "U1", kind: "add", text: "Dates are ISO strings in DTOs", why: "legacy sends Y-m-d" });
		const p2 = proposeRule({ ledger }, { stack: "nestjs", unitId: "U1", kind: "change", text: "Errors return 200 with {error}", why: "legacy clients expect it" });
		expect(proposeRule({ ledger }, { stack: "nestjs", kind: "add", text: "Dates are ISO strings in DTOs", why: "dup" })).toBe(p1);
		let calls = 0;
		const client = new FakeModelClient({
			chat: (req) => {
				const sys = req.messages[0]!.content;
				if (sys.includes("curate")) {
					calls++;
					return { json: { body: `## Errors\n- throw HttpException\n## DTOs\n- Dates are ISO strings${calls > 1 ? "\n- Errors return 200 with {error}" : ""}`, merged: calls > 1 ? [p2] : [p1], rejected: [], breaking: calls > 1 ? [] : [{ id: p2, impact: "accepted controllers throw" }] } };
				}
				return { json: { id: "rule_change", question: "Switch errors to HTTP 200?", options: [{ value: "reject", label: "No", hint: "" }, { value: "apply", label: "Yes", hint: "" }], recommended: "reject", opinion: "Breaks REST semantics." } };
			},
		});
		const r = await maybeCurateRules({ ledger, config, root, client }, { threshold: 2 });
		expect(r.versions).toEqual({ nestjs: 2 });
		expect(r.asked).toBe(1);
		expect(existsSync(join(rulesDir(root, "nestjs"), "history", "RULES.v2.md"))).toBe(true);
		const st = (id: number) => (ledger.db.prepare("SELECT status FROM rule_proposals WHERE id = ?").get(id) as { status: string }).status;
		expect(st(p1)).toBe("merged");
		expect(st(p2)).toBe("asked");
		const qid = (ledger.db.prepare("SELECT question_id FROM rule_proposals WHERE id = ?").get(p2) as { question_id: number }).question_id;
		expect(ledger.getQuestion(qid)!.status).toBe("auto"); // the run decided "reject" from the goals, nobody waited
		ledger.answerQuestion(qid, "apply — Yes"); // the owner changes it later
		const r2 = await maybeCurateRules({ ledger, config, root, client }, { threshold: 1 });
		expect(r2.versions).toEqual({ nestjs: 3 });
		expect(st(p2)).toBe("merged");
		expect(rulesText(root, "nestjs")).toMatch(/Errors return 200/);
	});
	it("same text = no new version; a proposal the curator refuses after the owner's apply is final, recorded once, never curated again", async () => {
		const { root, config, ledger } = setup();
		await saveRulesVersion({ ledger, root }, "nestjs", "## Errors\n- throw HttpException", { version: 1 });
		expect(await saveRulesVersion({ ledger, root }, "nestjs", "## Errors\n- throw HttpException")).toBe(1);
		expect(existsSync(join(rulesDir(root, "nestjs"), "history", "RULES.v2.md"))).toBe(false);
		const p = proposeRule({ ledger }, { stack: "nestjs", unitId: "U1", kind: "change", text: "Tests live next to the service", why: "easier to find" });
		let curations = 0;
		const client = new FakeModelClient({
			chat: (req) => {
				const sys = req.messages[0]!.content;
				if (sys.includes("curate")) {
					curations++;
					// the body never changes; first breaking, then (after the owner's apply) rejected
					return { json: { body: "## Errors\n- throw HttpException", merged: [], rejected: curations > 1 ? [{ id: p, reason: "Placement belongs to the generated layout" }] : [], breaking: curations > 1 ? [] : [{ id: p, impact: "tests elsewhere" }] } };
				}
				return { json: { id: "rule_change", question: "Move tests?", options: [{ value: "apply", label: "Yes", hint: "" }, { value: "reject", label: "No", hint: "" }], recommended: "reject", opinion: "-" } };
			},
		});
		const r1 = await maybeCurateRules({ ledger, config, root, client }, { threshold: 1 });
		expect(r1.versions).toEqual({});
		const qid = (ledger.db.prepare("SELECT question_id FROM rule_proposals WHERE id = ?").get(p) as { question_id: number }).question_id;
		ledger.answerQuestion(qid, "apply — Yes");
		const r2 = await maybeCurateRules({ ledger, config, root, client }, { threshold: 1 });
		expect(r2.refused).toEqual([{ stack: "nestjs", id: p, text: "Tests live next to the service", reason: "Placement belongs to the generated layout" }]);
		expect((ledger.db.prepare("SELECT status FROM rule_proposals WHERE id = ?").get(p) as { status: string }).status).toBe("refused");
		expect(JSON.parse(ledger.getQuestion(qid)!.context!).curatorRefused).toBe("Placement belongs to the generated layout");
		// the owner's apply no longer brings it back: no more curations, no new versions, the same text is not proposed again
		const r3 = await maybeCurateRules({ ledger, config, root, client }, { threshold: 1 });
		expect(curations).toBe(2);
		expect(r3.refused).toEqual([]);
		expect(rulesVersionOf(ledger)).toBe("1");
		expect(proposeRule({ ledger }, { stack: "nestjs", kind: "change", text: "Tests live next to the service", why: "again" })).toBe(p);
	});
});
const rulesVersionOf = (ledger: Ledger) => ledger.getMeta("rules_version:nestjs");

describe("capability cards", () => {
	it("a model describes accepted business logic; find_capability and reuse candidates find it by meaning", async () => {
		const { config, ledger } = setup();
		const ins = ledger.db.prepare("INSERT INTO index_symbols(id, side, path, kind, name, line, signature, exported) VALUES (?, 'target', ?, ?, ?, 1, ?, 1)");
		ins.run("src/features/flights/flights.service.ts::FlightsService.availableSlots", "src/features/flights/flights.service.ts", "method", "availableSlots", "(flightId: number): Slot[]");
		ins.run("src/features/flights/flights.module.ts::FlightsModule", "src/features/flights/flights.module.ts", "module", "FlightsModule", "");
		const client = new FakeModelClient({ chat: (req) => {
			const msg = req.messages[1]!.content;
			expect(msg).not.toMatch(/FlightsModule/); // wiring is not catalogued
			return { json: { cards: [{ id: "src/features/flights/flights.service.ts::FlightsService.availableSlots", reusable: true, summary: "Computes the free advertising slots on airport screens for a flight.", terms: "slot availability screen inventory flight capacity booking", io: "flightId → free slots" }] } };
		} });
		const r = await (await import("../src/inventory/capabilities.ts")).describeCapabilities({ ledger, config, client }, { unitId: "U0", stack: "nestjs", area: "flights", files: ["src/features/flights/flights.service.ts", "src/features/flights/flights.module.ts"] });
		expect(r.cards).toBe(1);
		const { findCapabilities, reuseCandidates } = await import("../src/inventory/capabilities.ts");
		expect(findCapabilities(ledger, "screen capacity of a flight")[0]!.name).toBe("availableSlots");
		expect(findCapabilities(ledger, "invoice total")).toEqual([]);
		// a legacy unit with a similarly named function gets it as a reuse candidate
		ledger.upsertFile({ path: "app/slots.php", hash: "h", lang: "php", loc: 10 });
		ledger.upsertSymbol({ id: "app/slots.php::getAvailableSlots", path: "app/slots.php", kind: "function", name: "getAvailableSlots" });
		ledger.createUnit({ id: "U2", tier: "T0", symbolIds: ["app/slots.php::getAvailableSlots"], meta: { files: ["app/slots.php"] } });
		expect(reuseCandidates(ledger, "U2").map((c) => c.capability.name)).toEqual(["availableSlots"]);
	});
});

describe("tidy review", () => {
	it("every N accepts of an area a model reviews it; approved moves become tasks for the next unit, closed when the tree shows them", async () => {
		const { root, config, ledger } = setup();
		config.run.ask = "all"; // this test answers the question itself; the run's own pick is tested below
		const { maybeTidyReview, tidyTaskCard, completeTidyTasks } = await import("../src/run/tidy.ts");
		const { projectDir } = await import("../src/init/init.ts");
		const proj = projectDir(config, "nestjs");
		mkdirSync(join(proj, "src/features/flights"), { recursive: true });
		writeFileSync(join(proj, "src/features/flights/flights.service.ts"), "export class FlightsService {}\n");
		writeFileSync(join(proj, "src/features/flights/helper2.ts"), "export const x = 1;\n");
		const client = new FakeModelClient({ chat: (req) => {
			const sys = req.messages[0]!.content;
			if (sys.includes("tidiness")) return { json: { changes: [{ op: "rename", from: ["src/features/flights/helper2.ts"], to: ["src/features/flights/flight-slots.ts"], why: "name says nothing" }, { op: "move", from: ["src/features/flights/flights.service.ts"], to: ["src/list.tpl/x.ts"], why: "outside layout" }], conventions: [{ text: "Name helper files after the domain concept", why: "helper2.ts" }] } };
			return { json: { id: "tidy", question: "Rename helper2.ts to flight-slots.ts?", options: [{ value: "apply", label: "Rename", hint: "" }, { value: "skip", label: "Keep", hint: "" }], recommended: "apply", opinion: "Clearer." } };
		} });
		const d = { ledger, config, root, client };
		expect((await maybeTidyReview(d, { stackId: "nestjs", area: "flights", every: 2 })).reviewed).toBe(false);
		const r = await maybeTidyReview(d, { stackId: "nestjs", area: "flights", every: 2 });
		expect(r).toMatchObject({ reviewed: true, asked: 1, proposals: 1 }); // the out-of-layout move is refused by code
		expect(tidyTaskCard(ledger, "nestjs", "flights")).toBe("");
		const q = ledger.openQuestions().find((x) => x.point === "tidy")!;
		ledger.answerQuestion(q.id, "apply — Rename");
		expect(tidyTaskCard(ledger, "nestjs", "flights")).toMatch(/rename: .*helper2.ts → .*flight-slots.ts/);
		expect(completeTidyTasks(ledger, proj, "nestjs", "flights")).toEqual([]);
		writeFileSync(join(proj, "src/features/flights/flight-slots.ts"), "export const x = 1;\n");
		(await import("node:fs")).rmSync(join(proj, "src/features/flights/helper2.ts"));
		expect(completeTidyTasks(ledger, proj, "nestjs", "flights")).toHaveLength(1);
		expect(tidyTaskCard(ledger, "nestjs", "flights")).toBe("");
	});

	it("a shared topic is reviewed in the shared dir, not in a feature folder of the same name", async () => {
		const { root, config, ledger } = setup();
		const { maybeTidyReview } = await import("../src/run/tidy.ts");
		const { projectDir } = await import("../src/init/init.ts");
		const proj = projectDir(config, "nestjs");
		mkdirSync(join(proj, "src/shared/money"), { recursive: true });
		writeFileSync(join(proj, "src/shared/money/amount.ts"), "export const amount = 1;\n");
		let seen = "";
		const client = new FakeModelClient({ chat: (req) => ((seen = req.messages.map((m) => m.content).join("\n")), { json: { changes: [], conventions: [] } }) });
		const r = await maybeTidyReview({ ledger, config, root, client }, { stackId: "nestjs", area: "money", shared: true, force: true });
		expect(r.reviewed).toBe(true);
		expect(seen).toContain("src/shared/money/amount.ts");
	});
});

describe("the run decides routine questions itself", () => {
	const phrase = (recommended: string) => new FakeModelClient({ chat: () => ({ json: { id: "x", question: "Keep the quirk?", options: [{ value: "drop", label: "Drop it", hint: "" }, { value: "keep", label: "Keep it", hint: "" }], recommended, opinion: "Your goals say same behaviour." } }) });

	it("model and agent agree on a routine point: stored answered, nobody waits; the quirk follows it", async () => {
		const { root, config, ledger } = setup();
		const d = { ledger, config, root, client: phrase("keep") };
		recordQuirk({ ...d }, { unitId: "U1", symbolId: "total", kind: "intentional", behaviour: "returns '0' for empty", opinion: "keep", why: "callers compare strings" });
		await askPendingQuirks(d, "U1");
		const q = ledger.db.prepare("SELECT * FROM questions WHERE point = 'quirk'").get() as { status: string; answer: string; answered_by: string };
		expect(q).toMatchObject({ status: "auto", answer: "keep — Keep it (recommended)" });
		expect(q.answered_by).toMatch(/^auto/);
		expect(ledger.blockedUnits().has("U1")).toBe(false);
		expect(quirkRetestNote({ ledger, root }, "U1")).toBeUndefined(); // the tests already follow the decision
		expect(quirksOf({ ledger }, "U1")[0]!.status).toBe("kept");
		expect(ledger.ownDecisions()).toHaveLength(1);
	});

	it("a quirk the tester would keep but the goals-aware model drops is decided drop; the owner can still change it", async () => {
		const { root, config, ledger } = setup();
		const d = { ledger, config, root, client: phrase("drop") };
		recordQuirk({ ...d }, { unitId: "U1", symbolId: "total", kind: "intentional", behaviour: "mails contain unescaped HTML", opinion: "keep", why: "same output" });
		await askPendingQuirks(d, "U1");
		const q = ledger.db.prepare("SELECT * FROM questions WHERE point = 'quirk'").get() as { id: number; status: string };
		expect(q.status).toBe("auto");
		expect(quirkRetestNote({ ledger, root }, "U1")).toMatch(/DROP it/); // the tests pinned the quirk: the tester rewrites them
		expect(quirksOf({ ledger }, "U1")[0]!.status).toBe("dropped");
		ledger.answerQuestion(q.id, "keep", "human (pi)"); // the owner overrides the run
		expect(quirksOf({ ledger }, "U1")[0]!.status).toBe("dropped"); // synced on the next read
		expect(quirkRetestNote({ ledger, root }, "U1")).toMatch(/KEEP it/);
		expect(quirksOf({ ledger }, "U1")[0]!).toMatchObject({ status: "kept", decided_by: "human (pi)" });
		expect(() => ledger.answerQuestion(q.id, "drop", "human")).toThrow(/already answered/); // only the run's own answers stay open
	});

	it("questions left open under older rules are decided at run start from the picks stored with them", async () => {
		const { config, ledger } = setup();
		const old = (point: string, askedBy: string, context: object) => ledger.askQuestion({ unitId: "U1", point, question: "q", options: ["drop — Drop it", "keep — Keep it (recommended)"], context, askedBy });
		const quirk = old("quirk", "tester", { codePick: "keep", modelPick: "drop", phrasedBy: "some-model" });
		const rule = old("rule_change", "curator", { modelPick: "keep", phrasedBy: "some-model" });
		const unphrased = old("quirk", "tester", { codePick: "keep", phrasedBy: "code" });
		const human = old("systemic_failure", "orchestrator", { codePick: "keep", modelPick: "keep", phrasedBy: "some-model" });
		expect(decideOpenFromGoals(ledger, config)).toBe(2);
		expect(ledger.getQuestion(quirk)).toMatchObject({ status: "auto", answer: "drop — Drop it" });
		expect(ledger.getQuestion(rule)!.status).toBe("auto");
		expect(ledger.openQuestions().map((q) => q.id)).toEqual([unphrased, human]);
	});

	it("asks when the model disagrees, when there is no model, for points that need a human, and with run.ask all", async () => {
		const { root, config, ledger } = setup();
		const ask = (client: FakeModelClient | undefined, point: string, recommended: string) =>
			askViaModel({ ledger, config, root, client }, { point, unitId: "U1", facts: "f", options: [{ value: "drop" }, { value: "keep" }, { value: "fixed" }], recommended, askedBy: "t" });
		expect((await ask(phrase("drop"), "quirk", "keep")).decided).toBeUndefined(); // disagreement
		expect((await ask(undefined, "quirk", "keep")).decided).toBeUndefined(); // no second opinion
		expect((await ask(phrase("keep"), "systemic_failure", "keep")).decided).toBeUndefined(); // not routine
		expect((await ask(phrase("keep"), "quirk", "keep")).decided).toBe("keep");
		// a guessed pick (first option, Jev below its confidence) does not hold the model back
		const guessed = await askViaModel({ ledger, config, root, client: phrase("keep") }, { point: "placement", unitId: "U1", facts: "f", options: [{ value: "drop" }, { value: "keep" }], recommended: "drop", guess: true, askedBy: "t" });
		expect(guessed.decided).toBe("keep");
		expect(JSON.parse(ledger.getQuestion(guessed.id)!.context!)).toMatchObject({ codePick: "drop", modelPick: "keep" });
		config.run.ask = "all";
		expect((await ask(phrase("keep"), "quirk", "keep")).decided).toBeUndefined();
		expect(ledger.openQuestions()).toHaveLength(4);
	});
});

describe("rules layout validation + ast-grep languages", () => {
	it("flags competing module roots anywhere and unknown file shapes; copies rules per ast-grep language", async () => {
		const { root, config, ledger } = setup();
		await saveRulesVersion({ ledger, root }, "nestjs", "Put helpers in api/src/helpers/ and see (src/utils/x.ts).\nUse src/features/<area>/<area>.service.ts and src/features/<area>/<area>.helpers.ts", { version: 1 });
		await saveRulesVersion({ ledger, root }, "react", "ok", { version: 1 });
		const problems = await validateRulesLayout(root, config);
		expect(problems.some((p) => p.includes("src/helpers/"))).toBe(true);
		expect(problems.some((p) => p.includes("src/utils/"))).toBe(true);
		expect(problems.some((p) => p.includes(".helpers.ts"))).toBe(true);
		expect(problems.some((p) => p.includes(".service.ts"))).toBe(false);
		const { expandRuleLanguages } = await import("../src/rules/layout.ts");
		const dir = join(rulesDir(root, "react"), "astgrep");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "no-any.yml"), "id: no-any\nlanguage: TypeScript\nrule:\n  pattern: $X as any\n");
		writeFileSync(join(dir, "no-any-test.yml"), "id: no-any\nvalid: []\n");
		expect(expandRuleLanguages(root, await getTargetAdapter("react"))).toEqual(["no-any--tsx.yml"]);
		expect(readFileSync(join(dir, "no-any--tsx.yml"), "utf8")).toMatch(/id: no-any--tsx\nlanguage: Tsx/);
		expect(readFileSync(join(dir, "no-any--tsx-test.yml"), "utf8")).toMatch(/id: no-any--tsx/);
		expect(activeRuleFiles(root, "react").map((f) => f.split("/").pop())).toEqual(["no-any--tsx.yml", "no-any.yml"]);
	});
});

describe("area taxonomy", () => {
	it("one model pass writes prefix rules from the folder tree: merges file-named areas, moves utilities to shared, asks before excluding", async () => {
		const { root, config, ledger } = setup();
		const mk = (id: string, file: string, stack: string, area: string) => {
			ledger.upsertFile({ path: file, hash: "h", lang: "php", loc: 10 });
			ledger.upsertSymbol({ id: `${file}::X`, path: file, kind: "class", name: "X" });
			ledger.createUnit({ id, tier: "T0", symbolIds: [`${file}::X`], meta: { files: [file], place: { stack, area, shared: false, source: "code" } } });
		};
		mk("A1", "app/model/classes/flights.facade.php", "nestjs", "flights");
		mk("A2", "app/lib/components/flightplayoutscombiner.cls.php", "nestjs", "flightplayouts");
		mk("A3", "app/lib/components/utils/clock.cls.php", "nestjs", "clock");
		mk("A4", "phpstan-stubs/macros.php", "nestjs", "phpstan-stubs");
		ledger.createUnit({ id: "A5", tier: "T0", deps: ["A2"], symbolIds: [], meta: { files: ["app/view/flights/list.tpl.php"], place: { stack: "nestjs", area: "flights", shared: false, source: "code" } } });
		let prompt = "";
		const client = new FakeModelClient({ chat: (req) => {
			const sys = req.messages[0]!.content;
			if (sys.includes("legacy codebase")) return { text: "brief" };
			if (sys.includes("feature-module structure")) {
				prompt = req.messages[1]!.content;
				return { json: { stacks: [{ stack: "nestjs", areas: [{ name: "flights", purpose: "flight booking" }] }], rules: [
					{ prefix: "app/model/classes/flights", to: "area", stack: "nestjs", area: "flights", confidence: 0.95, why: "domain" },
					{ prefix: "app/lib/components/flightplayoutscombiner", to: "area", stack: "nestjs", area: "Flights", confidence: 0.9, why: "part of flights" },
					{ prefix: "app/lib/components/utils/", to: "shared", stack: "nestjs", area: "dates", confidence: 0.92, why: "time helpers" },
					{ prefix: "app/lib/nowhere/", to: "area", stack: "nestjs", area: "ghosts", confidence: 0.99, why: "a folder the inventory does not have" },
					{ prefix: "phpstan-stubs/", to: "exclude", stack: "nestjs", area: "none", confidence: 0.99, why: "static-analysis stubs" },
				] } };
			}
			return undefined;
		} });
		const { curateAreas, syncTaxonomyAnswers, taxonomyHold } = await import("../src/run/taxonomy.ts");
		const r = await curateAreas({ ledger, config, root, client });
		// the model sees the folder tree with who uses what, not only area names
		expect(prompt).toContain("app/lib/components/  1 file(s)");
		expect(prompt).toMatch(/ {2}flightplayoutscombiner {2}← app\/view\/flights ×1/);
		expect(r).toMatchObject({ applied: 3, moved: 2, asked: 1 });
		const place = (id: string) => (JSON.parse(ledger.getUnit(id)!.meta) as { place: { area: string; shared: boolean; source: string } }).place;
		expect(place("A1")).toMatchObject({ area: "flights", shared: false, source: "code" }); // unchanged
		expect(place("A2")).toMatchObject({ area: "flights", shared: false, source: "taxonomy" });
		expect(place("A3")).toMatchObject({ area: "dates", shared: true });
		const rules = JSON.parse(readFileSync(join(root, ".bigrefactor", "placement.json"), "utf8")).rules;
		expect(rules.find((x: { prefix: string }) => x.prefix === "app/lib/components/utils/")).toMatchObject({ area: "dates", shared: true, by: "taxonomy" });
		expect(rules.some((x: { prefix: string }) => x.prefix === "app/lib/nowhere/")).toBe(false); // guard: a rule must cover a real file
		expect(taxonomyHold(ledger.getUnit("A4")!.meta)).toMatch(/waits for area question/);
		const q = ledger.openQuestions().find((x) => x.point === "area_taxonomy")!;
		ledger.answerQuestion(q.id, "exclude — do not migrate");
		expect(syncTaxonomyAnswers({ ledger, root })).toBe(1);
		expect(taxonomyHold(ledger.getUnit("A4")!.meta)).toMatch(/excluded/);
	});
});

describe("area taxonomy idempotency", () => {
	it("a second pass costs nothing when every area is already curated", async () => {
		const { root, config, ledger } = setup();
		ledger.upsertFile({ path: "app/f.php", hash: "h", lang: "php", loc: 1 });
		ledger.upsertSymbol({ id: "app/f.php::X", path: "app/f.php", kind: "class", name: "X" });
		ledger.createUnit({ id: "B1", tier: "T0", symbolIds: ["app/f.php::X"], meta: { files: ["app/f.php"], place: { stack: "nestjs", area: "flights", shared: false, source: "code" } } });
		let calls = 0;
		const client = new FakeModelClient({ chat: (req) => {
			calls++;
			if (req.messages[0]!.content.includes("legacy codebase")) return { text: "brief" };
			return { json: { stacks: [{ stack: "nestjs", areas: [{ name: "flights", purpose: "x" }] }], mappings: [{ from: "nestjs:flights", to: "area", stack: "nestjs", area: "flights", confidence: 1, why: "ok" }] } };
		} });
		const { curateAreas } = await import("../src/run/taxonomy.ts");
		await curateAreas({ ledger, config, root, client });
		const before = calls;
		const r = await curateAreas({ ledger, config, root, client });
		expect(calls).toBe(before);
		expect(r).toMatchObject({ applied: 0, asked: 0, costUsd: 0, areas: { nestjs: ["flights"] } });
	});
});
