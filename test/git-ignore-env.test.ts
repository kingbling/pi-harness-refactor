import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ensureRepo } from "../src/git.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("a new target repo's ignore file", () => {
	it("keeps out only a .env at the root; a stack's own .env (Symfony's committed defaults) is tracked", () => {
		const t = mkdtempSync(join(tmpdir(), "br-env-"));
		dirs.push(t);
		ensureRepo(t, "main", ["vendor"]);
		expect(readFileSync(join(t, ".gitignore"), "utf8")).toBe("vendor/\n/.env\n");
		mkdirSync(join(t, "symfony"));
		writeFileSync(join(t, "symfony", ".env"), "APP_ENV=dev\n");
		writeFileSync(join(t, ".env"), "SECRET=1\n");
		const ignored = (p: string) => {
			try {
				execFileSync("git", ["-C", t, "check-ignore", "-q", p]);
				return true;
			} catch {
				return false;
			}
		};
		expect(existsSync(join(t, ".git"))).toBe(true);
		expect(ignored(".env")).toBe(true);
		expect(ignored("symfony/.env")).toBe(false);
	});
});
