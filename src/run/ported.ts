import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { TargetAdapter } from "../adapters/types.ts";
import { globToRegExp } from "../sessions/spawn.ts";

/**
 * The ported-test checks code runs on a unit, shared by the orchestrator (coverTruth, the lint pass before the
 * implementer) and the tester's own check_ported_tests tool, so both see the same answer.
 */

/** A test text names truth case `id` as exact text (u1#3, not u1#30, not u1-3). */
export function mentionsCase(text: string, id: string): boolean {
	return new RegExp(`${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\d)`).test(text);
}

/** The unit's test files: wherever the stack keeps an area's tests (its testFileGlobs), not only inside the module. */
export function findTests(targetProjectDir: string, moduleDir: string, layout: TargetAdapter["layout"]): string[] {
	const globs = layout.testFileGlobs(moduleDir);
	const res = globs.map(globToRegExp);
	const out = new Set<string>();
	const visit = (d: string) => {
		for (const n of readdirSync(d)) {
			const p = join(d, n);
			const r = relative(targetProjectDir, p);
			if (statSync(p).isDirectory()) visit(p);
			else if (layout.isTestFile(r) && res.some((re) => re.test(r))) out.add(r);
		}
	};
	// walk only the fixed part of each glob (src/Billing/tests/**/*Test.php → src/Billing/tests)
	for (const g of globs) {
		const base = g.split("/").filter((_, i, a) => !a.slice(0, i + 1).some((s) => /[*?{[]/.test(s))).join("/");
		if (existsSync(join(targetProjectDir, base))) visit(join(targetProjectDir, base));
	}
	return [...out].sort();
}

/** Case ids no test file names, and the file each found id is in. */
export function caseCoverage(targetProjectDir: string, moduleDir: string, layout: TargetAdapter["layout"], ids: string[]): { missing: string[]; found: Map<string, string>; files: string[]; globs: string[] } {
	const files = findTests(targetProjectDir, moduleDir, layout);
	const texts = files.map((p) => [p, readFileSync(join(targetProjectDir, p), "utf8")] as const);
	const found = new Map<string, string>();
	const missing: string[] = [];
	for (const id of ids) {
		const hit = texts.find(([, t]) => mentionsCase(t, id));
		if (hit) found.set(id, hit[0]);
		else missing.push(id);
	}
	return { missing, found, files, globs: layout.testFileGlobs(moduleDir) };
}

/** The stack's lint/static check on the given test files, run from the target project dir; the error output, or undefined when clean. */
export function lintTests(targetProjectDir: string, adapter: TargetAdapter, files: string[]): Promise<{ command: string; error?: string }> {
	const c = adapter.lint(targetProjectDir, files);
	const command = [c.cmd, ...c.args].join(" ");
	return new Promise((res) =>
		execFile(c.cmd, c.args, { cwd: targetProjectDir, env: { ...process.env, CI: "1", FORCE_COLOR: "0" }, maxBuffer: 20 * 1024 * 1024, timeout: 5 * 60_000 }, (e, out, err) =>
			res({ command, error: e ? `${String(err)}\n${String(out)}`.trim().slice(-2500) || String(e.message) : undefined }),
		),
	);
}
