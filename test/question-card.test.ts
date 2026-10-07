import { describe, expect, it } from "vitest";
import { QuestionCard, type CardAnswer } from "../src/pi/question-card.ts";

/** The decision card in Pi: context and option descriptions are shown, the recommendation is preselected. */
const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
const UP = "\x1b[A", DOWN = "\x1b[B", ENTER = "\r", ESC = "\x1b";

function card(q: ConstructorParameters<typeof QuestionCard>[0]) {
	const got: Array<CardAnswer | undefined> = [];
	const c = new QuestionCard(q, (v) => got.push(v));
	return { c, got };
}

const q = {
	message: "Which backend stack?\n   970 templates, 456 command files\n   why symfony: keeps PHP",
	recommended: "symfony",
	options: [
		{ value: "nestjs", label: "NestJS", description: "move to TypeScript" },
		{ value: "symfony", label: "Symfony (recommended)", description: "stay in PHP" },
		{ value: "\0later", label: "decide later" },
	],
};

describe("question card", () => {
	it("shows the question, its context and every option with its description; the recommendation is marked and preselected", () => {
		const { c, got } = card({ ...q, options: q.options.map((o) => ({ ...o, label: o.label.replace(" (recommended)", "") })) });
		const out = plain(c.render(80));
		expect(out).toContain("Which backend stack?");
		expect(out).toContain("970 templates, 456 command files");
		expect(out).toContain("move to TypeScript");
		expect(out).toMatch(/❯ 2\. Symfony \(recommended\)/);
		c.handleInput(ENTER);
		expect(got).toEqual(["symfony"]);
	});

	it("arrows wrap around, numbers pick directly, Esc cancels", () => {
		const a = card(q);
		a.c.handleInput(DOWN);
		a.c.handleInput(DOWN); // 2 → 3 → wraps to 1
		a.c.handleInput(ENTER);
		a.c.handleInput(UP);
		expect(a.got).toEqual(["nestjs"]);
		const b = card(q);
		b.c.handleInput("3");
		expect(b.got).toEqual(["\0later"]);
		const e = card(q);
		e.c.handleInput(ESC);
		expect(e.got).toEqual([undefined]);
	});

	it("a text question is prefilled with the recommended value; Enter keeps it, typing replaces it", () => {
		const a = card({ message: "New codebase folder", text: { initial: "../app-new" } });
		expect(plain(a.c.render(80))).toContain("../app-new");
		a.c.handleInput(ENTER);
		expect(a.got).toEqual(["../app-new"]);
		const b = card({ message: "New codebase folder", text: { initial: "../app-new" } });
		for (const ch of "2") b.c.handleInput(ch);
		b.c.handleInput(ENTER);
		expect(b.got).toEqual(["../app-new2"]);
	});

	it("checkboxes: the defaults start checked, Space or a number toggles, the last row takes your own words (digits and spaces are text there), Enter sends both", () => {
		const a = card({
			message: "What should this migration achieve?",
			multi: { initial: ["new-stack", "security"] },
			other: "add your own",
			options: [
				{ value: "new-stack", label: "move to the new stack" },
				{ value: "security", label: "fix security problems" },
				{ value: "new-ui", label: "new look for the UI" },
			],
		});
		let out = plain(a.c.render(80));
		expect(out).toMatch(/❯ 1\. \[✔\] move to the new stack/);
		expect(out).toMatch(/3\. \[ \] new look for the UI/);
		expect(out).toContain("✎  add your own");
		a.c.handleInput("3"); // check new-ui
		a.c.handleInput(" "); // cursor on row 1: uncheck new-stack
		a.c.handleInput(UP); // wraps to the own-words row
		for (const ch of "keep the 2 APIs") a.c.handleInput(ch);
		out = plain(a.c.render(80));
		expect(out).toContain("keep the 2 APIs");
		expect(out).toMatch(/1\. \[ \] move to the new stack/);
		expect(a.got).toEqual([]); // typing never sends
		a.c.handleInput(ENTER);
		expect(a.got).toEqual([{ values: ["security", "new-ui"], note: "keep the 2 APIs" }]);
	});

	it("a single choice with an own-words row: the typed text is the answer; Enter on an empty row does nothing", () => {
		const a = card({ ...q, other: "type something else" });
		a.c.handleInput(DOWN);
		a.c.handleInput(DOWN); // 2 → 3 → own words
		a.c.handleInput(ENTER);
		expect(a.got).toEqual([]);
		for (const ch of "laravel") a.c.handleInput(ch);
		a.c.handleInput(ENTER);
		expect(a.got).toEqual(["laravel"]);
	});

	it("taller than the screen: the choices stay visible, the text scrolls with ←/→; group members take one line each", () => {
		const a = card({ message: `Where should old_export.php go?\n${Array.from({ length: 30 }, (_, i) => `context line ${i + 1}`).join("\n")}`, details: ["10 questions, one answer for all:", `· U1722: ${"very long question text ".repeat(20)}`], recommended: "a", options: [{ value: "a", label: "shared" }, { value: "b", label: "billing" }] });
		a.c.maxRows = () => 20;
		let out = a.c.render(60);
		expect(out.length).toBeLessThanOrEqual(20);
		expect(plain(out)).toMatch(/❯ 1\. shared \(recommended\)/);
		expect(plain(out)).toMatch(/more line\(s\) — ←\/→ or PgUp\/PgDn to read/);
		for (let i = 0; i < 6; i++) a.c.handleInput("\x1b[C"); // → pages down, stops at the end
		out = a.c.render(60);
		expect(plain(out)).toContain("· U1722: very long");
		expect(out.every((l) => plain([l]).length <= 58)).toBe(true);
		expect(plain(out)).toMatch(/line\(s\) above/);
		a.c.handleInput(ENTER);
		expect(a.got).toEqual(["a"]);
	});
});

describe("question card width", () => {
	it("never draws a line wider than the terminal (Pi stops drawing then), even with a long prefilled path", async () => {
		const { visibleWidth } = await import("@earendil-works/pi-tui");
		const long = "app/install/install.sql, app/install/old/0001_uuid.sql, app/install/old/0002_more.sql, tests/ci/seed.sql";
		const c = new QuestionCard({ message: `mariadb: schema files or folders\nNot found: php/gyro/x.sql (did you mean gyro-php/gyro/x.sql?)`, text: { initial: long } }, () => {});
		for (const width of [20, 40, 80]) for (const l of c.render(width)) expect(visibleWidth(l)).toBeLessThanOrEqual(width);
	});
});
