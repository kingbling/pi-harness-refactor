import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveCommandOverride } from "../src/adapters/command-overrides.ts";
import type { TargetAdapter } from "../src/adapters/types.ts";
import { ConfigSchema } from "../src/config.ts";
import { checkToolchain } from "../src/init/init.ts";
import type { SetupFixer } from "../src/init/setup-fixer.ts";

/** A stack whose built-in commands no longer fit the installed tools; the setup fixer repairs it, code re-checks. */
function stack(over: Partial<TargetAdapter> = {}) {
	const root = mkdtempSync(join(tmpdir(), "br-fix-"));
	const target = join(root, "new");
	mkdirSync(join(target, "src"), { recursive: true });
	writeFileSync(join(target, "ready"), "");
	const adapter = {
		id: "fixme",
		toolchain: { isProjectReady: () => true },
		probeTest: () => ({ path: "src/probe.spec.txt", content: "expect(1 + 1).toBe(2)\n" }),
		build: () => ({ cmd: "true", args: [] }),
		lint: () => ({ cmd: "true", args: [] }),
		// the "old flag": always fails, like vitest 5 on --related
		test: () => ({ cmd: "sh", args: ["-c", "echo 'Unknown option --related' >&2; exit 1"] }),
		...over,
	} as unknown as TargetAdapter;
	const config = ConfigSchema.parse({ source: { path: root, stack: "php" }, target: { path: target, stacks: ["fixme"] }, models: {} });
	return { root, target, adapter, config };
}
// a real test runner stand-in: green when the probe expects 2, red otherwise
const grep = { cmd: "grep", args: ["-q", "toBe(2)", "{files}"] };

describe("setup check: a model with tools fixes what fails, code decides it worked", () => {
	it("hands the error to the fixer; its command override is used from then on", async () => {
		const { root, adapter, config } = stack();
		const seen: string[] = [];
		const fix: SetupFixer = async (o) => {
			seen.push(o.problem);
			saveCommandOverride(o.root, o.adapter.id, "test", grep, "the flag is gone");
		};
		await checkToolchain(config, adapter, { root, fix });
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatch(/test command fails on a fresh project[\s\S]*Unknown option --related/);
	});

	it("a test command that cannot fail is not a fix; after the tries the owner gets the last problem", async () => {
		const { root, adapter, config } = stack();
		let calls = 0;
		const fix: SetupFixer = async (o) => {
			calls++;
			saveCommandOverride(o.root, o.adapter.id, "test", { cmd: "true", args: [] }, "cheat");
		};
		await expect(checkToolchain(config, adapter, { root, fix, attempts: 2 })).rejects.toThrow(/passes a failing test[\s\S]*could not fix it in 2 tries/);
		expect(calls).toBe(2);
	});

	it("without a workspace or with the fixer off, a failure stops setup as before", async () => {
		const { adapter, config } = stack();
		await expect(checkToolchain(config, adapter, { fix: false })).rejects.toThrow(/test command fails on a fresh project/);
	});
});
