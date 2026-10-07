import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTargetAdapter, registerGeneratedTargets } from "../src/adapters/registry.ts";
import { generateAdapter, loadManifests, seedDir, verifyPendingAdapters, type AdapterManifest } from "../src/adapters/target/generated.ts";
import { ConfigSchema } from "../src/config.ts";
import { setup } from "../src/init/init.ts";
import { FakeModelClient } from "../src/models/fake.ts";

/**
 * Questions first: a stack picked without an adapter gets its manifest written at once (its stack questions
 * can be asked), but the slow trial build runs only after the last question; the project it built becomes
 * the real project in setup instead of being built a second time.
 */
const manifest = (id: string, over: Partial<AdapterManifest> = {}): AdapterManifest => ({
	id,
	role: "server",
	subdir: "api",
	aliases: [],
	docs: [],
	scaffold: { cmd: "mkdir", args: ["-p", "{name}"], readyFile: "ready.txt" },
	postScaffold: [{ cmd: "touch", args: ["ready.txt"] }],
	build: { cmd: "true", args: [] },
	lint: { cmd: "true", args: ["{files}"] },
	test: { cmd: "test", args: ["-f", "{files}"] },
	toolchain: { ecosystem: "x", packageName: "^[a-z]+", packageExamples: [], manifestFiles: ["ready.txt"], installed: { file: "none.json", keys: [] }, add: { cmd: "true", args: ["{packages}"] }, worktreeLinks: [], ignoredPaths: [] },
	layout: { moduleDir: "src/{area}", structureDoc: "one folder per area", sharedDirs: ["src/shared/"], testFileGlobs: ["{moduleDir}/**/*.test.txt"], testFileRegex: "\\.test\\.txt$", sourceExtensions: [".txt"], langByExtension: {}, skipMarker: "skip\\(", interfaceHint: "-", testHint: "-", legacyMarker: "# LEGACY: {why}", dataAccessHint: "", ignoreDirs: [] },
	platform: {},
	stackChoices: [{ key: "orm", question: "ORM?", default: "a", options: [{ id: "a", label: "A", packages: [] }, { id: "b", label: "B", packages: [] }] }] as never,
	protectedGlobs: [],
	patternKinds: ["service"],
	probeTest: { path: "probe.test.txt", content: "ok\n" },
	detect: { file: "ready.txt", contains: "" },
	...over,
});

describe("adapter generation: questions first, build once", () => {
	it("writes the manifest without building; its stack questions are available; the check runs later and its project is reused by setup", async () => {
		const root = mkdtempSync(join(tmpdir(), "br-qf-"));
		const id = "qfirst-a";
		const client = new FakeModelClient({ chat: () => ({ json: manifest(id) }) });
		const m = await generateAdapter({ id, role: "server", why: "test", client, model: "m", root, deferVerify: true });
		expect(m.verified).toBe(false);
		expect(existsSync(seedDir(root, id))).toBe(false); // nothing built during the questions
		registerGeneratedTargets(root);
		expect((await getTargetAdapter(id)).stackChoices?.[0]?.key).toBe("orm"); // stack questions can be asked now

		const logs: string[] = [];
		expect(await verifyPendingAdapters(root, { model: "m", log: (l) => logs.push(l) })).toEqual([id]);
		const saved = loadManifests(root).find((x) => x.id === id)!;
		expect(saved.verified).toBeUndefined();
		expect(saved.seedProject).toBe(join(seedDir(root, id), "api"));
		expect(existsSync(join(saved.seedProject!, "ready.txt"))).toBe(true);
		expect(existsSync(join(saved.seedProject!, "probe.test.txt"))).toBe(false); // the probe test is not part of the new project
		expect(logs.join("\n")).toMatch(/building and testing a fresh qfirst-a project .* it becomes your new project/);

		registerGeneratedTargets(root);
		const target = join(root, "new");
		const config = ConfigSchema.parse({ source: { path: root, stack: "php" }, target: { path: target, stacks: [id] }, models: {} });
		const out: string[] = [];
		const orig = console.log;
		console.log = (...a: unknown[]) => out.push(a.join(" "));
		try {
			await setup(config, root);
		} finally {
			console.log = orig;
		}
		expect(out.join("\n")).toMatch(/reused the qfirst-a project built by the adapter check/);
		expect(existsSync(join(target, "ready.txt"))).toBe(true);
		expect(existsSync(saved.seedProject!)).toBe(false);
	});

	it("a failed check goes back to the model with the failure; the fixed manifest is proven the same way", async () => {
		const root = mkdtempSync(join(tmpdir(), "br-qf-"));
		const id = "qfirst-b";
		let calls = 0;
		const seen: string[] = [];
		const client = new FakeModelClient({
			chat: (req: { messages: Array<{ content: string }> }) => {
				calls++;
				seen.push(req.messages.map((x) => x.content).join("\n"));
				return { json: calls === 1 ? manifest(id, { build: { cmd: "false", args: [] } }) : manifest(id) };
			},
		} as never);
		await generateAdapter({ id, role: "server", why: "test", client, model: "m", root, deferVerify: true });
		expect(await verifyPendingAdapters(root, { client, model: "m", log: () => {} })).toEqual([id]);
		expect(calls).toBe(2);
		expect(seen[1]).toMatch(/Verification failed:\nbuild failed on the fresh project \(false/);
		expect(JSON.parse(readFileSync(join(root, ".bigrefactor", "adapters", `${id}.json`), "utf8")).verified).toBeUndefined();
	});
});
