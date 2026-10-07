import { cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultTargetPath, init, recentSources, sourceCandidates } from "../src/init/init.ts";

/** Setup offers the old folder (used before, or recognised next to the workspace) and puts the new code in `<old>-new`. */
const fixture = resolve(import.meta.dirname, "..", "fixtures", "mini-app", "legacy");

describe("setup folders", () => {
	it("new code defaults to <old>-new next to the old folder", () => {
		expect(defaultTargetPath("../gyro-app")).toBe("../gyro-app-new");
		expect(defaultTargetPath("../gyro-app/")).toBe("../gyro-app-new");
		expect(defaultTargetPath("./legacy")).toBe("legacy-new");
	});

	it("offers recognised sibling folders and folders used before, and remembers the chosen one", async () => {
		const parent = mkdtempSync(join(tmpdir(), "br-folders-"));
		process.env["BR_HOME"] = join(parent, ".home");
		const ws = join(parent, "workspace");
		mkdirSync(ws);
		cpSync(fixture, join(parent, "gyro-app"), { recursive: true });
		mkdirSync(join(parent, "photos"));
		const found = await sourceCandidates(ws);
		expect(found.map((o) => o.value)).toEqual(["../gyro-app"]);
		expect(found[0]!.hint).toMatch(/php/);

		const asked: string[] = [];
		const prompter = {
			text: async (m: string, i?: string) => (asked.push(`${m} [${i}]`), i),
			select: async (m: string, o: Array<{ value: string }>, i?: string) => (asked.push(`${m} [${o.map((x) => x.value).join(",")}]`), i ?? o[0]!.value),
			log: () => {},
		};
		await init(["--no-docs"], { root: ws, prompter });
		expect(asked[0]).toMatch(/^Old codebase folder .*\[\.\.\/gyro-app,/);
		expect(asked[1]).toBe("New codebase folder [../gyro-app-new]");
		expect(JSON.parse(readFileSync(join(ws, "bigrefactor.config.json"), "utf8")).target.path).toBe("../gyro-app-new");
		expect(recentSources()).toEqual([join(parent, "gyro-app")]);
		delete process.env["BR_HOME"];
	});
});
