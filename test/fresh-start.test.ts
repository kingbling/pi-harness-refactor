import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { offerFreshStart } from "../src/init/init.ts";
import { restoreManifest } from "../src/adapters/target/generated.ts";

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

	it("generated stack adapters come along: a running session still uses them, the next start must find them", async () => {
		const root = workspace();
		mkdirSync(join(root, ".bigrefactor", "adapters"));
		writeFileSync(join(root, ".bigrefactor", "adapters", "symfony.json"), "{}");
		expect(await offerFreshStart(root, ui("fresh"), { yes: false, fresh: false })).toBe(true);
		expect(readdirSync(join(root, ".bigrefactor"))).toEqual(["adapters"]);
		expect(existsSync(join(root, ".bigrefactor", "adapters", "symfony.json"))).toBe(true);
		const old = readdirSync(root).find((n) => n.startsWith(".bigrefactor.old-"))!;
		expect(existsSync(join(root, old, "adapters", "symfony.json"))).toBe(true); // nothing deleted
		const never = { select: async () => { throw new Error("asked"); }, log: () => {} } as never;
		expect(await offerFreshStart(root, never, { yes: false, fresh: false })).toBe(false); // only kept adapters: nothing to ask
	});

	it("an adapter an earlier fresh start left behind is brought back, newest first", () => {
		const root = mkdtempSync(join(tmpdir(), "br-fresh-"));
		for (const [old, body] of [[".bigrefactor.old-2026-10-07T08-00-00", "older"], [".bigrefactor.old-2026-10-08T08-11-33", "newer"]]) {
			mkdirSync(join(root, old!, "adapters", "symfony.seed"), { recursive: true });
			writeFileSync(join(root, old!, "adapters", "symfony.json"), body!);
		}
		expect(restoreManifest(root, "vue")).toBe(false);
		expect(restoreManifest(root, "symfony")).toBe(true);
		expect(readFileSync(join(root, ".bigrefactor", "adapters", "symfony.json"), "utf8")).toBe("newer");
		expect(existsSync(join(root, ".bigrefactor", "adapters", "symfony.seed"))).toBe(true);
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

describe("git: never commits a parent repo", () => {
	it("commitAll refuses a folder inside another checkout", async () => {
		const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { execFileSync } = await import("node:child_process");
		const { commitAll, isRepoRoot } = await import("../src/git.ts");
		const parent = mkdtempSync(join(tmpdir(), "br-parent-"));
		execFileSync("git", ["init", "-q"], { cwd: parent });
		const inner = join(parent, "target");
		mkdirSync(inner);
		writeFileSync(join(inner, "a.txt"), "x");
		expect(isRepoRoot(parent)).toBe(true);
		expect(isRepoRoot(inner)).toBe(false);
		expect(() => commitAll(inner, "nope")).toThrow(/not the top of its own git repo/);
	});
});
