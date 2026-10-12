import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TargetAdapter } from "../src/adapters/types.ts";
import { testsPass } from "../src/run/ported.ts";
import { testsGreenBefore } from "../src/run/unit.ts";

/**
 * Ported tests that pass before the unit has any code do not call its code: the tester gets one go at them, then the
 * reviewer is told. Behaviour an earlier unit already wrote can make tests legitimately green: never a failure by itself.
 */
describe("ported tests green before any code exists", () => {
	const run = (results: boolean[]) => {
		const retests: string[] = [];
		let files = ["src/a.spec.ts"];
		const out = testsGreenBefore({
			files: () => files,
			pass: async () => results.shift()!,
			retest: async (why) => {
				retests.push(why);
				files = ["src/a.spec.ts", "src/b.spec.ts"]; // the tester rewrote and added tests
			},
		});
		return { out, retests };
	};

	it("red before any code: nothing to do", async () => {
		const { out, retests } = run([false]);
		expect(await out).toBeUndefined();
		expect(retests).toEqual([]);
	});

	it("green: the tester gets one go; red afterwards is fine", async () => {
		const { out, retests } = run([true, false]);
		expect(await out).toBeUndefined();
		expect(retests).toHaveLength(1);
		expect(retests[0]).toMatch(/pass before any code for this unit exists[\s\S]*src\/a\.spec\.ts[\s\S]*fails until that code exists/);
	});

	it("still green after the retest: a note for the reviewer, naming the tests as they are now", async () => {
		const { out, retests } = run([true, true]);
		expect(await out).toMatch(/src\/a\.spec\.ts, src\/b\.spec\.ts[\s\S]*asked once[\s\S]*weakTests/);
		expect(retests).toHaveLength(1);
	});

	it("runs the stack's own test command on the files; green is exit 0", async () => {
		const dir = mkdtempSync(join(tmpdir(), "br-green-"));
		writeFileSync(join(dir, "ok.spec"), "pass\n");
		writeFileSync(join(dir, "bad.spec"), "fail\n");
		const adapter = { test: (_r: string, files: string[]) => ({ cmd: "sh", args: ["-c", 'for f; do grep -q pass "$f" || exit 1; done', "sh", ...files] }) } as unknown as TargetAdapter;
		expect(await testsPass(dir, adapter, ["ok.spec"])).toBe(true);
		expect(await testsPass(dir, adapter, ["ok.spec", "bad.spec"])).toBe(false);
	});
});
