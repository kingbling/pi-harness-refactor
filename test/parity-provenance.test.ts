import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verificationEngine, verificationWorkspace } from "../src/run/parity-provenance.ts";

let root: string;
const write = (path: string, value: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "br-provenance-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("verification implementation provenance", () => {
	it("detects engine changes without a version bump, including added and removed files", async () => {
		write("package.json", '{"version":"0.4.66"}'); write("src/compare.ts", "compare(a,b)");
		const first = await verificationEngine(root);
		expect(first.files["src/compare.ts"]).toBe(createHash("sha256").update("compare(a,b)").digest("hex"));
		expect(await verificationEngine(root)).toEqual(first);
		write("src/compare.ts", "compareEverything(a,b)");
		expect((await verificationEngine(root)).hash).not.toBe(first.hash);
		write("src/compare.ts", "compare(a,b)"); write("bin/br.js", "run()");
		expect((await verificationEngine(root)).hash).not.toBe(first.hash);
		rmSync(join(root, "bin/br.js"));
		expect(await verificationEngine(root)).toEqual(first);
	});
	it("fingerprints adapter manifests, helper scripts, command overrides and runtime settings while excluding logs", async () => {
		write(".bigrefactor/adapters/php.json", '{"build":"php"}');
		write(".bigrefactor/commands/php.json", '{"test":"phpunit"}');
		write(".bigrefactor/commands/validate.mts", "validate()");
		write(".bigrefactor/legacy-env.json", '{"root":"runtime-a"}');
		const first = await verificationWorkspace(root);
		expect(Object.keys(first.files)).toHaveLength(4);
		write(".bigrefactor/commands/php.fixes.log", "ordinary log update");
		expect(await verificationWorkspace(root)).toEqual(first);
		write(".bigrefactor/commands/validate.mts", "differentValidation()");
		expect((await verificationWorkspace(root)).hash).not.toBe(first.hash);
	});
	it("detects a symlink changing its referent even when both files currently contain the same bytes", async () => {
		write("a.mts", "same()"); write("b.mts", "same()");
		mkdirSync(join(root, ".bigrefactor/commands"), { recursive: true });
		symlinkSync("../../a.mts", join(root, ".bigrefactor/commands/check.mts"));
		const first = await verificationWorkspace(root);
		rmSync(join(root, ".bigrefactor/commands/check.mts"));
		symlinkSync("../../b.mts", join(root, ".bigrefactor/commands/check.mts"));
		expect((await verificationWorkspace(root)).hash).not.toBe(first.hash);
	});
	it("fails closed on unavailable engine source and directory symlink cycles", async () => {
		await expect(verificationEngine(root)).rejects.toThrow("package.json and src are required");
		write("package.json", "{}"); write("src/run.ts", "run()");
		symlinkSync(".", join(root, "src/cycle"));
		await expect(verificationEngine(root)).rejects.toThrow("directory symlink cycle");
	});
});
