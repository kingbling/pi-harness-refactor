import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { commitAll, ensureRepo } from "../src/git.ts";
import type { TargetAdapter } from "../src/adapters/types.ts";
import { ConfigSchema } from "../src/config.ts";
import { makeWriteGate, type SpawnOptions } from "../src/sessions/spawn.ts";

/** The code job's session is refused protected config at the write, as its check would refuse the whole job afterwards. */
const seen: SpawnOptions[] = [];
vi.mock("../src/sessions/spawn.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/sessions/spawn.ts")>()),
	spawnLeaf: async (o: SpawnOptions) => (seen.push(o), { run: async () => ({ text: "added it" }), dispose: () => {} }),
}));

describe("the code job's session", () => {
	it("may write code, tests and wiring files, never protected config", async () => {
		const { codeWithModel } = await import("../src/run/code-job.ts");
		const config = ConfigSchema.parse({ source: { path: "/legacy", stack: "php" }, target: { path: "/p", stacks: ["fake"] }, models: {} });
		const adapter = {
			id: "fake",
			protectedGlobs: ["**/*.test.ts", "tsconfig*.json", "src/*.tsx"],
			layout: { isTestFile: (p: string) => p.endsWith(".test.ts"), wiringFiles: ["src/routes.tsx"], structureDoc: "" },
			build: () => ({ cmd: "true", args: [] }),
			test: () => ({ cmd: "true", args: [] }),
		} as unknown as TargetAdapter;
		await codeWithModel({ config, root: "/r", adapter, dir: "/p", what: "add the endpoint", label: "q1" });
		const o = seen[0]!;
		const gate = makeWriteGate({ cwd: o.cwd, sourceRoot: "/legacy", writeGlobs: o.writeGlobs, protectedGlobs: o.protectedGlobs ?? [], isProtected: o.isProtected });
		expect(gate("tsconfig.app.json")).toMatch(/protected path/);
		expect(gate("src/main.tsx")).toMatch(/protected path/);
		expect(gate("src/routes.tsx")).toBeUndefined();
		expect(gate("src/features/a/a.test.ts")).toBeUndefined();
		expect(gate("src/features/a/a.ts")).toBeUndefined();
	});

	it("with the files that decide how the checks run known, app entry files may change; a bash write to those files is put back after the command and the model told", async () => {
		const { codeWithModel } = await import("../src/run/code-job.ts");
		const { afterBashResult } = await import("../src/sessions/spawn.ts");
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "br-code-bash-")));
		writeFileSync(join(dir, "tsconfig.json"), "{}\n");
		await ensureRepo(dir, "main", []);
		await commitAll(dir, "init");
		const config = ConfigSchema.parse({ source: { path: "/legacy", stack: "php" }, target: { path: dir, stacks: ["fake"] }, models: {} });
		const adapter = {
			id: "fake",
			protectedGlobs: ["**/*.test.ts", "tsconfig*.json", "src/*.tsx"],
			checkConfigGlobs: ["tsconfig*.json"],
			toolchain: { ignoredPaths: [] },
			layout: { isTestFile: (p: string) => p.endsWith(".test.ts"), wiringFiles: [], structureDoc: "" },
			build: () => ({ cmd: "true", args: [] }),
			test: () => ({ cmd: "true", args: [] }),
		} as unknown as TargetAdapter;
		const locked: string[] = [];
		await codeWithModel({ config, root: dir, adapter, dir, what: "add the endpoint", label: "q2", onLocked: (l) => locked.push(...l.files) });
		const o = seen.at(-1)!;
		const gate = makeWriteGate({ cwd: o.cwd, sourceRoot: "/legacy", writeGlobs: o.writeGlobs, protectedGlobs: o.protectedGlobs ?? [], isProtected: o.isProtected });
		expect(gate("src/main.tsx")).toBeUndefined(); // app entry file: the job's to change
		expect(gate("tsconfig.json")).toMatch(/protected path/);
		// the model writes tsconfig.json through bash, where the write gate does not look
		writeFileSync(join(dir, "tsconfig.json"), '{"strict":false}\n');
		const out = await afterBashResult({ content: [{ type: "text", text: "done" }] }, o.afterBash!);
		expect(readFileSync(join(dir, "tsconfig.json"), "utf8")).toBe("{}\n");
		expect(out?.content.at(-1).text).toMatch(/tsconfig\.json decides how the checks run.*put back/);
		expect(locked).toEqual(["tsconfig.json"]);
		// a command that changed nothing of those leaves its output as it is
		expect(await afterBashResult({ content: [{ type: "text", text: "ok" }] }, o.afterBash!)).toBeUndefined();
	});
});
