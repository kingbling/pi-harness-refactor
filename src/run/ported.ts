import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { TargetAdapter } from "../adapters/types.ts";
import { globToRegExp } from "../sessions/spawn.ts";
import { changedFiles, scopedCheck, trackedFiles } from "./gate.ts";

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

/**
 * The stack's build or lint on the given test files, run from the target project dir and scoped the way the gate
 * scopes it: the error output, or undefined when clean. `skipped` when the command checks the whole project (the
 * builder runs it after merges, so it is never the tester's to fix).
 */
export function checkTests(targetProjectDir: string, adapter: TargetAdapter, name: "build" | "lint", files: string[]): Promise<{ command: string; error?: string; skipped?: string }> {
	const c = scopedCheck(adapter, targetProjectDir, name, files.filter((f) => adapter.layout.lang(f)));
	if ("skip" in c) return Promise.resolve({ command: "", skipped: c.skip });
	const command = [c.cmd, ...c.args].join(" ");
	return new Promise((res) =>
		execFile(c.cmd, c.args, { cwd: targetProjectDir, env: { ...process.env, CI: "1", FORCE_COLOR: "0" }, maxBuffer: 20 * 1024 * 1024, timeout: 5 * 60_000 }, (e, out, err) =>
			res({ command, error: e ? `${String(err)}\n${String(out)}`.trim().slice(-2500) || String(e.message) : undefined }),
		),
	);
}

/**
 * Keeps a session to its own paths in the project. Call it before the session; the function it returns, called after
 * the session, puts back every file the session changed outside `allowed` (globs relative to `dir`): to its content
 * before the session, else to HEAD, and a new file is removed. Work already in the tree (an implementer's) stays.
 * Returns the paths it put back.
 */
export function scopeGuard(dir: string, allowed: string[], ignored: string[] = []): () => string[] {
	const allow = allowed.map(globToRegExp);
	const outside = () => changedFiles(dir, ignored).filter((f) => !allow.some((r) => r.test(f)));
	const read = (f: string) => (existsSync(join(dir, f)) && statSync(join(dir, f)).isFile() ? readFileSync(join(dir, f)) : null);
	const before = new Map(outside().map((f) => [f, read(f)] as const));
	return () => {
		const tracked = new Set(trackedFiles(dir));
		const put: string[] = [];
		for (const f of new Set([...before.keys(), ...outside()])) {
			const now = read(f);
			const was = before.get(f);
			if (was !== undefined) {
				if (now === was || (now && was && now.equals(was))) continue;
				if (was === null) rmSync(join(dir, f), { force: true });
				else (mkdirSync(dirname(join(dir, f)), { recursive: true }), writeFileSync(join(dir, f), was));
			} else if (tracked.has(f)) execFileSync("git", ["checkout", "HEAD", "--", f], { cwd: dir, stdio: "pipe" });
			else rmSync(join(dir, f), { force: true });
			put.push(f);
		}
		return put;
	};
}
