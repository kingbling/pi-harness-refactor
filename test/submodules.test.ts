import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptySubmodules, ensureSubmodules } from "../src/init/submodules.ts";

/** A framework kept as a git submodule that was never downloaded must not silently look absent. */
function repo(): string {
	const root = mkdtempSync(join(tmpdir(), "br-sub-"));
	writeFileSync(join(root, ".gitmodules"), `[submodule "gyro-php"]\n\tpath = gyro-php\n\turl = git@github.com:x/gyro-php.git\n\tbranch = staging\n[submodule "libs/ok"]\n\tpath = libs/ok\n\turl = https://x/ok.git\n`);
	mkdirSync(join(root, "gyro-php"));
	mkdirSync(join(root, "libs", "ok"), { recursive: true });
	writeFileSync(join(root, "libs", "ok", "a.php"), "<?php\n");
	return root;
}

describe("submodules never downloaded", () => {
	it("finds empty submodule folders only", () => {
		expect(emptySubmodules(repo())).toEqual([{ path: "gyro-php", url: "git@github.com:x/gyro-php.git" }]);
		expect(emptySubmodules(mkdtempSync(join(tmpdir(), "br-sub-none-")))).toEqual([]);
	});

	it("offers to download them, shows a failure, checks again; --yes stops with the command", async () => {
		const root = repo();
		const asked: string[] = [];
		const ran: string[][] = [];
		let fail = true;
		const run = async (cmd: string, args: string[]) => {
			ran.push([cmd, ...args]);
			if (fail) {
				fail = false;
				throw new Error("git submodule update failed (exit 128):\nPermission denied (publickey).");
			}
			writeFileSync(join(root, "gyro-php", "load.cls.php"), "<?php\n");
		};
		const ui = { select: async (m: string) => (asked.push(m), "download"), log: () => {} };
		expect(await ensureSubmodules(root, ui, false, run as never)).toBe("ok");
		expect(ran[0]).toEqual(["git", "-C", root, "submodule", "update", "--init", "--recursive"]);
		expect(asked).toHaveLength(2);
		expect(asked[0]).toContain("gyro-php (git@github.com:x/gyro-php.git)");
		expect(asked[1]).toContain("last attempt failed: Permission denied (publickey).");

		await expect(ensureSubmodules(repo(), ui, true)).rejects.toThrow(/never downloaded \(gyro-php\); run `git -C .* submodule update --init --recursive`/);
		expect(await ensureSubmodules(repo(), { select: async () => "skip", log: () => {} }, false)).toBe("skipped");
	});
});
