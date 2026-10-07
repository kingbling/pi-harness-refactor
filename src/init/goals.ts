import { DEFAULT_GOALS, GOALS } from "../policy.ts";
import type { InitPrompter } from "./init.ts";

/**
 * The first real question: what should this migration achieve? Checkboxes with the usual goals (the
 * common ones checked) plus the owner's own words. Every model prompt quotes the answer (goalsText).
 * `--yes` takes the checked defaults.
 */
export async function askGoals(ui: InitPrompter, yes: boolean, previous?: { picked: string[]; note?: string }): Promise<{ picked: string[]; note?: string }> {
	const initial = previous?.picked.length ? previous.picked : DEFAULT_GOALS;
	if (yes) return { picked: initial, ...(previous?.note ? { note: previous.note } : {}) };
	const message = "What should this migration achieve?\n   Check everything that applies and add your own words in the last row (what matters most, what must not change, deadlines …). Every model working on the code gets this.";
	if (ui.multi) {
		const got = await ui.multi(message, GOALS, initial, "add your own: what matters most, what must not change …");
		if (got === undefined) throw new Error("onboarding cancelled");
		const note = got.note.trim();
		return { picked: got.values, ...(note ? { note } : {}) };
	}
	// a prompter without checkboxes: the defaults plus a free text
	ui.log(`goals: ${initial.map((v) => GOALS.find((g) => g.value === v)?.label ?? v).join(", ")}`);
	const note = (await ui.text("Anything else this migration should achieve? (your own words, optional)", previous?.note ?? ""))?.trim();
	return { picked: initial, ...(note ? { note } : {}) };
}
