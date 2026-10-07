import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { offerFreshStart } from "../src/init/init.ts";

/** A new init in a workspace with earlier answers: they would be taken as decided, so the owner is asked first. */
function workspace() {
	const root = mkdtempSync(join(tmpdir(), "br-fresh-"));
	mkdirSync(join(root, ".bigrefactor"));
	writeFileSync(join(root, ".bigrefactor", "decisions.json"), JSON.stringify({ answers: { "target:server": { answer: "symfony" }, "stack:nestjs.orm": { answer: "drizzle" } } }));
	return root;
}
const ui = (pick: string, asked: string[] = []) => ({ select: async (m: string) => (asked.push(m), pick), text: async () => "", log: () => {} }) as never;

describe("init in a workspace with earlier work", () => {
	it("asks; start fresh moves the old state aside (nothing deleted), so every question is asked again", async () => {
		const root = workspace();
		const asked: string[] = [];
		expect(await offerFreshStart(root, ui("fresh", asked), { yes: false, fresh: false })).toBe(true);
		expect(asked[0]).toMatch(/2 earlier answers/);
		expect(existsSync(join(root, ".bigrefactor"))).toBe(false);
		const old = readdirSync(root).find((n) => n.startsWith(".bigrefactor.old-"))!;
		expect(existsSync(join(root, old, "decisions.json"))).toBe(true);
	});

	it("keep leaves it; --yes keeps without asking; --fresh moves without asking; an empty workspace asks nothing", async () => {
		const a = workspace();
		expect(await offerFreshStart(a, ui("keep"), { yes: false, fresh: false })).toBe(false);
		expect(existsSync(join(a, ".bigrefactor", "decisions.json"))).toBe(true);
		const never = { select: async () => { throw new Error("asked"); }, log: () => {} } as never;
		expect(await offerFreshStart(a, never, { yes: true, fresh: false })).toBe(false);
		expect(await offerFreshStart(a, never, { yes: true, fresh: true })).toBe(true);
		expect(await offerFreshStart(mkdtempSync(join(tmpdir(), "br-fresh-")), never, { yes: false, fresh: false })).toBe(false);
	});
});
