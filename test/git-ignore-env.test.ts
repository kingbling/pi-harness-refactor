import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { commitAll, ensureRepo, whitespaceOnly } from "../src/git.ts";

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

	it("a formatter's whitespace-only change is told apart from a real one", () => {
		const t = mkdtempSync(join(tmpdir(), "br-ws-"));
		dirs.push(t);
		ensureRepo(t, "main", []);
		writeFileSync(join(t, "a.php"), "<?php\nassert(1+1 === 2);\n");
		commitAll(t, "init");
		writeFileSync(join(t, "a.php"), "<?php\n\nassert(1 + 1 === 2);\n");
		expect(whitespaceOnly(t, "a.php")).toBe(true);
		writeFileSync(join(t, "a.php"), "<?php\nassert(1+1 === 3);\n");
		expect(whitespaceOnly(t, "a.php")).toBe(false);
		writeFileSync(join(t, "new.php"), "x");
		expect(whitespaceOnly(t, "new.php")).toBe(false);
	});
});
