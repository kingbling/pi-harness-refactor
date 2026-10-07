import { describe, expect, it } from "vitest";
import { QuestionCard } from "../src/pi/question-card.ts";

/** The decision card in Pi: context and option descriptions are shown, the recommendation is preselected. */
const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
const UP = "\x1b[A", DOWN = "\x1b[B", ENTER = "\r", ESC = "\x1b";

function card(q: ConstructorParameters<typeof QuestionCard>[0]) {
	const got: Array<string | undefined> = [];
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
});
