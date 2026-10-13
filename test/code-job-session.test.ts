import { describe, expect, it, vi } from "vitest";
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
});
