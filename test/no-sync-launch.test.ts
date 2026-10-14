import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Pi TUI must never hang: a process started with a sync call (git, docker, php, composer, a test runner…)
 * blocks the whole event loop until it ends. Every launch in src/ is awaited (proc.ts exec, git.ts git) or forked.
 */
const SRC = resolve(import.meta.dirname, "../src");
const files = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? files(join(d, n)) : n.endsWith(".ts") ? [join(d, n)] : []));

describe("no sync process launch", () => {
	it("src/ never uses execFileSync, spawnSync or execSync", () => {
		const hits: string[] = [];
		for (const f of files(SRC)) {
			readFileSync(f, "utf8")
				.split("\n")
				.forEach((line, i) => {
					if (/\b(execFileSync|spawnSync|execSync)\b/.test(line)) hits.push(`${relative(SRC, f)}:${i + 1}: ${line.trim()}`);
				});
		}
		expect(hits, hits.join("\n")).toEqual([]);
	});
});
