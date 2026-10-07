import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Safeguard for every external command, whatever the tool (php, composer, npm, git, test runners, generated
 * adapters' commands): a child process must never write to the terminal directly. Inside Pi that text lands on
 * top of the UI (a PHP warning over the status bar). Every call that starts a process must capture stdout and
 * stderr; the one place that may stream to the terminal is proc.ts, and only for the plain CLI.
 */
const SRC = resolve(import.meta.dirname, "../src");
const files = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? files(join(d, n)) : n.endsWith(".ts") ? [join(d, n)] : []));

/** The full text of each call `name(...)`, balanced parentheses. */
function calls(text: string, name: RegExp): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(name)) {
		let depth = 0;
		let i = m.index! + m[0].length - 1;
		for (; i < text.length; i++) {
			if (text[i] === "(") depth++;
			else if (text[i] === ")" && --depth === 0) break;
		}
		out.push(text.slice(m.index!, i + 1));
	}
	return out;
}

describe("child processes never write to the terminal", () => {
	const all = files(SRC).map((f) => ({ f: relative(SRC, f), text: readFileSync(f, "utf8") }));

	it("every execFileSync / spawnSync / execSync / spawn call captures its output", () => {
		const bad: string[] = [];
		for (const { f, text } of all) {
			for (const c of calls(text, /\b(execFileSync|spawnSync|execSync|spawn)\(/g)) {
				if (/^\w+\(\s*(\)|\{)/.test(c)) continue; // spawn({ … }) starts an agent session, not a process
				// stdio given, every stream captured or discarded ("pipe" / "ignore"), never "inherit"
				const stdio = /stdio:\s*("(?:pipe|ignore)"|\[\s*"(?:pipe|ignore)",\s*"(?:pipe|ignore)",\s*"(?:pipe|ignore)"\s*\])/.test(c);
				const ok = stdio || (f === "proc.ts" && /tracked \? \["ignore", "pipe", "pipe"\]/.test(c));
				if (!ok) bad.push(`${f}: ${c.replace(/\s+/g, " ").slice(0, 140)}`);
			}
		}
		expect(bad).toEqual([]);
	});

	it("nothing inherits the terminal except the plain CLI path in proc.ts", () => {
		const bad = all.filter(({ f, text }) => f !== "proc.ts" && /["']inherit["']/.test(text)).map(({ f }) => f);
		expect(bad).toEqual([]);
	});
});
