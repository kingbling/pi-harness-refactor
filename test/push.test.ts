import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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
});
