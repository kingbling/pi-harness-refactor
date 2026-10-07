import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { generateAdapter, type AdapterManifest } from "../src/adapters/target/generated.ts";
import { ensureTools, installPlan, MissingToolsError } from "../src/init/toolchain-install.ts";
import { FakeModelClient } from "../src/models/fake.ts";

const here = resolve(import.meta.dirname, "..");

const symfony = (): AdapterManifest => ({
	id: "symfony-test",
	role: "server",
	subdir: "api",
	aliases: [],
	docs: [],
	scaffold: { cmd: "br-fake-composer", args: ["create-project", "symfony/skeleton", "{name}"], readyFile: "composer.json" },
	postScaffold: [],
	build: { cmd: "br-fake-php", args: ["bin/console", "lint:container"] },
	lint: { cmd: "br-fake-php", args: ["vendor/bin/php-cs-fixer", "check", "{files}"] },
	test: { cmd: "br-fake-php", args: ["bin/phpunit", "{files}"] },
	toolchain: { ecosystem: "composer", packageName: "^[a-z0-9-]+/[a-z0-9-]+", packageExamples: ["doctrine/orm"], manifestFiles: ["composer.json"], installed: { file: "composer.json", keys: ["require"] }, add: { cmd: "br-fake-composer", args: ["require", "{packages}"] }, worktreeLinks: ["vendor"], ignoredPaths: ["vendor", "var"] },
	layout: { moduleDir: "src/{Area}", structureDoc: "one dir per area", sharedDirs: ["src/Shared/"], testFileGlobs: ["tests/**/*Test.php"], testFileRegex: "Test\\.php$", sourceExtensions: [".php"], langByExtension: { ".php": "php" }, skipMarker: "markTestSkipped", interfaceHint: "typed PHP", testHint: "PHPUnit *Test.php", legacyMarker: "// LEGACY: {why}", dataAccessHint: "Doctrine", ignoreDirs: ["vendor", "var"] },
	platform: {},
	stackChoices: [],
	protectedGlobs: [],
	patternKinds: ["controller"],
	probeTest: { path: "tests/ProbeTest.php", content: "<?php" },
	detect: { file: "composer.json", contains: "symfony" },
});

/** A scripted prompter: answers select() by matching the first option label against each pattern in turn. */
function prompter(answers: RegExp[]) {
	const asked: string[] = [];
	return {
		asked,
		log: () => {},
		text: async () => "",
		select: async (message: string, options: Array<{ value: string; label: string }>) => {
			asked.push(`${message}\n${options.map((o) => `  [${o.value}] ${o.label}`).join("\n")}`);
			const re = answers.shift();
			return re ? options.find((o) => re.test(o.label))?.value : undefined;
		},
	};
}

describe("missing toolchain: offered install instead of a dead end", () => {
	it("maps tools to the machine's package manager; sudo only shown, never run", () => {
		const has = (set: string[]) => (t: string) => set.includes(t);
		expect(installPlan(["php", "composer"], has(["brew"]), "darwin").display).toBe("brew install php composer");
		const apt = installPlan(["php", "composer"], has(["apt-get"]), "linux", false);
		expect(apt).toMatchObject({ manager: "apt-get", needsSudo: true, display: "sudo apt-get install -y php-cli composer" });
		expect(installPlan(["frobnicate"], has(["brew"]), "darwin").unknown).toEqual(["frobnicate"]);
		expect(installPlan(["php"], has([]), "linux")).toMatchObject({ unknown: ["php"], needsSudo: false });
	});

	it("generation: missing tools → install hook → tools on PATH → the same manifest goes on to verification", async () => {
		const ws = join(here, ".sim", "toolchain-install");
		rmSync(ws, { recursive: true, force: true });
		const bin = join(ws, "bin");
		mkdirSync(bin, { recursive: true });
		const pathBefore = process.env["PATH"];
		process.env["PATH"] = `${bin}:${pathBefore}`;
		try {
			const client = new FakeModelClient({ chat: () => ({ json: symfony() }) });
			const asked: string[][] = [];
			const verified: string[] = [];
			const m = await generateAdapter({
				id: "symfony-test",
				role: "server",
				why: "",
				client,
				model: "m",
				root: ws,
				verify: async (x) => (verified.push(x.id), undefined),
				ensureTools: async (missing) => {
					asked.push(missing);
					// the owner's install puts the tools on PATH
					for (const t of missing) {
						writeFileSync(join(bin, t), "#!/bin/sh\n");
						chmodSync(join(bin, t), 0o755);
					}
					return true;
				},
			});
			expect(asked).toEqual([["br-fake-composer", "br-fake-php"]]);
			expect(verified).toEqual(["symfony-test"]);
			expect(client.calls.length).toBe(1); // not a manifest problem: no repair round
			expect(m.id).toBe("symfony-test");
			expect(existsSync(join(ws, ".bigrefactor", "adapters", "symfony-test.json"))).toBe(true);
		} finally {
			process.env["PATH"] = pathBefore;
		}
	});

	it("known tools: brew install runs on the owner's go, then generation continues to verification", async () => {
		const ws = join(here, ".sim", "toolchain-install2");
		rmSync(ws, { recursive: true, force: true });
		mkdirSync(ws, { recursive: true });
		const present = new Set<string>(["brew"]);
		const ran: string[][] = [];
		const ui = prompter([/^install now: brew install php composer/]);
		const tools = await ensureTools({
			stack: "symfony",
			tools: ["php", "composer"],
			ui,
			platform: "darwin",
			probe: (t) => present.has(t),
			run: async (argv) => (ran.push(argv), present.add("php"), present.add("composer"), { ok: true, output: "" }),
		});
		expect(tools).toBe(true);
		expect(ran).toEqual([["brew", "install", "php", "composer"]]);
		expect(ui.asked[0]).toMatch(/symfony needs php, composer on this machine/);
		expect(ui.asked[0]).toMatch(/I installed it myself, check again/);
		expect(ui.asked[0]).toMatch(/pick another stack/);
		expect(existsSync(ws)).toBe(true);
	});

	it("a failed install shows the error and asks again; check again re-probes", async () => {
		const present = new Set<string>(["brew"]);
		let n = 0;
		const ui = prompter([/^install now/, /check again/]);
		const ok = await ensureTools({
			stack: "symfony",
			tools: ["php"],
			ui,
			platform: "darwin",
			probe: (t) => present.has(t),
			run: async () => (n++, present.add("php"), { ok: false, output: "Error: php: some brew failure" }),
		});
		expect(ok).toBe(true);
		expect(n).toBe(1);
	});

	it("sudo installs are never run: the owner runs them, then checks again", async () => {
		const present = new Set<string>(["apt-get"]);
		const ui = prompter([/check again/]);
		const ok = await ensureTools({ stack: "symfony", tools: ["php"], ui, platform: "linux", isRoot: false, probe: (t) => (t === "php" ? ui.asked.length > 0 : present.has(t)), run: async () => { throw new Error("must not run"); } });
		expect(ok).toBe(true);
		expect(ui.asked[0]).toMatch(/needs root: run it yourself \(in Pi: ! sudo apt-get install -y php-cli\)/);
		expect(ui.asked[0]).not.toMatch(/install now/);
	});

	it("--yes never installs: it stops with the exact command; pick another stack declines generation", async () => {
		const probe = (t: string) => t === "brew";
		await expect(ensureTools({ stack: "symfony", tools: ["php", "composer"], ui: prompter([]), yes: true, platform: "darwin", probe })).rejects.toThrow(/needs php, composer.*install it with `brew install php composer`/);
		await expect(ensureTools({ stack: "symfony", tools: ["php"], ui: prompter([]), yes: true, platform: "darwin", probe })).rejects.toBeInstanceOf(MissingToolsError);
		expect(await ensureTools({ stack: "symfony", tools: ["php"], ui: prompter([/pick another stack/]), platform: "darwin", probe })).toBe(false);
		// through generateAdapter: declining stops generation before anything runs
		const client = new FakeModelClient({ chat: () => ({ json: { ...symfony(), scaffold: { cmd: "br-no-such-php", args: [], readyFile: "x" } } }) });
		let verified = 0;
		await expect(generateAdapter({ id: "symfony-test", role: "server", why: "", client, model: "m", root: join(here, ".sim", "toolchain-install3"), verify: async () => (verified++, undefined), ensureTools: async () => false })).rejects.toThrow(/declined \(tools missing: br-no-such-php/);
		expect(verified).toBe(0);
	});
});
