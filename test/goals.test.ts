import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { askGoals } from "../src/init/goals.ts";
import { DEFAULT_GOALS, goalsText } from "../src/policy.ts";
import { implementerSystemPrompt } from "../src/run/prompts.ts";

/** The first question of onboarding: what the migration should achieve, as checkboxes plus the owner's own words. */
describe("migration goals", () => {
	it("asks with checkboxes (defaults checked) plus own words; --yes takes the defaults; without checkboxes the note is still asked", async () => {
		const seen: Array<{ initial: string[]; other: string; values: string[] }> = [];
		const ui = {
			text: async () => "keep the API",
			select: async () => undefined,
			multi: async (_m: string, options: Array<{ value: string }>, initial: string[], other: string) => (seen.push({ initial, other, values: options.map((o) => o.value) }), { values: ["security", "new-ui"], note: "  keep the public API  " }),
			log: () => {},
		};
		expect(await askGoals(ui, false)).toEqual({ picked: ["security", "new-ui"], note: "keep the public API" });
		expect(seen[0]!.initial).toEqual(DEFAULT_GOALS);
		expect(seen[0]!.values).toContain("new-db");
		expect(await askGoals(ui, true)).toEqual({ picked: DEFAULT_GOALS });
		expect(await askGoals({ ...ui, multi: undefined }, false)).toEqual({ picked: DEFAULT_GOALS, note: "keep the API" });
		await expect(askGoals({ ...ui, multi: async () => undefined }, false)).rejects.toThrow(/cancelled/);
	});

	it("the goals reach the coding prompts in plain words, with the owner's note; nothing when not asked", () => {
		expect(goalsText(undefined)).toBe("");
		expect(goalsText({ picked: [] })).toBe("");
		const config = ConfigSchema.parse({ source: { path: "/x", stack: "php" }, target: { path: "/y", stacks: ["nestjs"] }, models: {}, goals: { picked: ["security"], note: "keep the public API" } });
		const p = implementerSystemPrompt(config, { area: "billing", stackId: "nestjs", moduleDir: "src/billing", structureDoc: "-", sharedDirs: [], rules: "", attempt: 1, source: { id: "php" } as never, target: { layout: { legacyMarker: () => "" } } as never });
		expect(p).toContain("fix security problems (SQL injection");
		expect(p).toContain(`In the owner's own words: "keep the public API"`);
	});
});
