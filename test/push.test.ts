import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema, saveConfig } from "../src/config.ts";
import { commitAll, ensureRepo } from "../src/git.ts";
import { createPusher, pushSetting } from "../src/run/push.ts";

/** target.git.push: the migration branch goes to the target repo's remote after merges, when it has one. */
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function setup(remote: boolean) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "br-push-")));
	const target = join(root, "new");
	mkdirSync(target, { recursive: true });
	ensureRepo(target, "migration/main", []);
	writeFileSync(join(target, "a.txt"), "1\n");
	commitAll(target, "init");
	const bare = join(root, "remote.git");
	if (remote) {
		git(root, ["init", "-q", "--bare", bare]);
		git(target, ["remote", "add", "origin", bare]);
	}
	const config = ConfigSchema.parse({ source: { path: root, stack: "php" }, target: { path: target, stacks: ["nestjs"] }, models: {} });
	saveConfig(root, config);
	return { root, target, bare, config, cfgPath: join(root, "bigrefactor.config.json") };
}

describe("pushing to the target's remote", () => {
	it("is off by default; on, merges are pushed (at most once per interval, and at the end)", async () => {
		const { root, target, bare, config, cfgPath } = setup(true);
		const logs: string[] = [];
		const off = createPusher({ config, root, log: (l) => logs.push(l), everyMs: 0 });
		off.afterMerge();
		await off.finish();
		expect(git(bare, ["branch", "--list"])).toBe("");
		expect(pushSetting(cfgPath, ["on"])).toMatch(/push on: migration\/main → origin/);
		const p = createPusher({ config, root, log: (l) => logs.push(l), everyMs: 60_000 });
		p.afterMerge();
		await p.finish();
		expect(git(bare, ["rev-parse", "migration/main"])).toBe(git(target, ["rev-parse", "HEAD"]));
		writeFileSync(join(target, "a.txt"), "2\n");
		commitAll(target, "unit");
		p.afterMerge(); // within the interval: waits
		expect(git(bare, ["rev-parse", "migration/main"])).not.toBe(git(target, ["rev-parse", "HEAD"]));
		await p.finish(); // the end of the run pushes what is left
		expect(git(bare, ["rev-parse", "migration/main"])).toBe(git(target, ["rev-parse", "HEAD"]));
		expect(logs.filter((l) => /fail/.test(l))).toEqual([]);
	});

	it("a merge that lands while a push runs goes out on its own, not with some later merge; br push is remembered as decided", async () => {
		const { root, target, bare, config, cfgPath } = setup(true);
		pushSetting(cfgPath, ["on"]);
		expect(JSON.parse(readFileSync(cfgPath, "utf8")).target.git.pushAskedAt).toBeTruthy();
		const p = createPusher({ config, root, log: () => {}, everyMs: 0 });
		p.afterMerge(); // push 1 starts
		writeFileSync(join(target, "a.txt"), "3\n");
		commitAll(target, "unit while pushing");
		p.afterMerge(); // push 1 still running
		const head = git(target, ["rev-parse", "HEAD"]);
		for (let i = 0; i < 100 && git(bare, ["rev-parse", "migration/main"]) !== head; i++) await new Promise((r) => setTimeout(r, 50));
		expect(git(bare, ["rev-parse", "migration/main"])).toBe(head);
		await p.finish();
	});

	it("without a remote it says so once and does nothing", async () => {
		const { root, config, cfgPath } = setup(false);
		expect(pushSetting(cfgPath, ["on"])).toMatch(/no remote/);
		const logs: string[] = [];
		const p = createPusher({ config, root, log: (l) => logs.push(l), everyMs: 0 });
		p.afterMerge();
		p.afterMerge();
		await p.finish();
		expect(logs.filter((l) => /no remote/.test(l))).toHaveLength(1);
		expect(() => pushSetting(cfgPath, ["maybe"])).toThrow(/usage/);
	});

	it("a URL as the remote: an existing config pushes to it as it is; br push on <url> adds it as origin", async () => {
		const { root, target, bare, config, cfgPath } = setup(false);
		git(root, ["init", "-q", "--bare", bare]);
		// a config written with the URL as the remote (no remote in the repo)
		const p = createPusher({ config: { ...config, target: { ...config.target, git: { ...config.target.git, push: "on", remote: bare } } }, root, log: () => {}, everyMs: 0 });
		saveConfig(root, { ...config, target: { ...config.target, git: { ...config.target.git, push: "on", remote: bare } } });
		p.afterMerge();
		await p.finish();
		expect(git(bare, ["rev-parse", "migration/main"])).toBe(git(target, ["rev-parse", "HEAD"]));
		expect(pushSetting(cfgPath, ["on", bare])).toMatch(/→ origin/);
		expect(git(target, ["remote", "get-url", "origin"])).toBe(bare);
		expect(JSON.parse(readFileSync(cfgPath, "utf8")).target.git.remote).toBe("origin");
	});
});

describe("onboarding asks where the new code goes", () => {
	const ui = (answers: string[]) => ({ asked: [] as string[], select: async function (m: string) { this.asked.push(m); return answers.shift(); }, text: async () => answers.shift(), log: () => {} });

	it("with a remote: shows it and turns pushing on when the owner says yes", async () => {
		const { askPush } = await import("../src/run/push.ts");
		const { config } = setup(true);
		const u = ui(["on"]);
		expect(await askPush(config, u, false)).toEqual({ push: "on", remote: "origin" });
		expect(u.asked[0]).toMatch(/remote origin → .*remote\.git/);
	});

	it("without one: the typed URL becomes origin and pushing is on; no answer keeps it local", async () => {
		const { askPush } = await import("../src/run/push.ts");
		const { root, target, config } = setup(false);
		const bare = join(root, "other.git");
		git(root, ["init", "-q", "--bare", bare]);
		expect(await askPush(config, ui(["off"]), false)).toMatchObject({ push: "off" });
		expect(await askPush(config, ui(["url", bare]), false)).toEqual({ push: "on", remote: "origin" });
		expect(git(target, ["remote", "get-url", "origin"])).toBe(bare);
		expect(await askPush(config, ui([]), true)).toMatchObject({ push: "off" }); // --yes: no question, nothing changes
	});
});
