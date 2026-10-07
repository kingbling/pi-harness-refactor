import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { TargetAdapter } from "../adapters/types.ts";
import type { Ledger } from "../ledger/db.ts";
import type { EvidenceType } from "../ledger/schema.ts";
import { globToRegExp } from "../sessions/spawn.ts";

/**
 * The gate: deterministic, cheapest-first, stops at the first failure. Runs AFTER the implementer
 * session has ended, in the gate pool (CPU-bound). Each passing step writes evidence; the unit can
 * only be accepted with all of REQUIRED_FOR_ACCEPTED present.
 */
export interface GateInput {
	ledger: Ledger;
	unitId: string;
	adapter: TargetAdapter;
	targetProjectDir: string;
	/** Globs (relative to targetProjectDir) the implementer was allowed to write. */
	writeGlobs: string[];
	/** Globs where only NEW files are acceptable (shared helpers). */
	appendOnlyGlobs?: string[];
	/** Test files written by the tester, with their hashes at hand-over time. */
	testFiles: Array<{ path: string; sha1: string }>;
	timeoutMs?: number;
}

export interface GateStep {
	/** Process exit code when the step ran a command (undefined for code-only steps). */
	exitCode?: number;
	name: EvidenceType;
	ok: boolean;
	ms: number;
	output: string;
}
export interface GateReport {
	ok: boolean;
	steps: GateStep[];
	changedFiles: string[];
	failedStep?: EvidenceType;
	/** Protected test files the gate checked (so triage can tell "error in a test file" from "error in production code"). */
	testFiles?: string[];
}

export async function runGate(g: GateInput): Promise<GateReport> {
	const steps: GateStep[] = [];
	const changed = changedFiles(g.targetProjectDir);
	const timeout = g.timeoutMs ?? 240_000;
	const step = async (name: EvidenceType, fn: () => Promise<{ ok: boolean; output: string; exitCode?: number }>) => {
		const t0 = Date.now();
		const r = await fn();
		steps.push({ name, ok: r.ok, ms: Date.now() - t0, output: r.output.slice(-6000), exitCode: r.exitCode });
		if (r.ok) g.ledger.addEvidence(g.unitId, name, { ms: Date.now() - t0 });
		return r.ok;
	};

	// 1. every legacy symbol of the unit is accounted for
	const proofOk = await step("symbolproof_ok", async () => {
		const unproven = g.ledger.symbolsOfUnit(g.unitId).filter((s) => !["mapped", "dropped", "tested", "accepted"].includes(s.state));
		return { ok: unproven.length === 0, output: unproven.length ? `unproven symbols (call ledger_prove for each):\n${unproven.map((s) => `- ${s.id}`).join("\n")}` : "all symbols proven" };
	});
	if (!proofOk) return done();

	// 2. anti-gaming, cheap part: scope + tests untouched + no skipped tests + a non-trivial change
	const agOk = await step("antigaming_ok", async () => {
		const problems: string[] = [];
		const allow = g.writeGlobs.map(globToRegExp);
		const appendOnly = (g.appendOnlyGlobs ?? []).map(globToRegExp);
		const tracked = new Set(trackedFiles(g.targetProjectDir));
		for (const f of changed) {
			if (allow.some((r) => r.test(f))) continue;
			if (appendOnly.some((r) => r.test(f))) {
				if (tracked.has(f)) problems.push(`edited an existing shared file (add-only zone): ${f}`);
				continue;
			}
			problems.push(`write outside unit scope: ${f}`);
		}
		for (const t of g.testFiles) {
			const p = join(g.targetProjectDir, t.path);
			if (!existsSync(p)) problems.push(`test file removed: ${t.path}`);
			else if (sha1(readFileSync(p)) !== t.sha1) problems.push(`test file modified after hand-over: ${t.path}`);
			else if (g.adapter.layout.skipMarker.test(readFileSync(p, "utf8"))) problems.push(`skipped/only test in ${t.path}`);
		}
		const prodFiles = changed.filter((f) => !g.adapter.layout.isTestFile(f));
		if (prodFiles.length === 0) problems.push("no production files were written");
		return { ok: problems.length === 0, output: problems.length ? problems.join("\n") : `${prodFiles.length} production file(s) changed within scope; tests untouched` };
	});
	if (!agOk) return done();

	// 3. build (type check)
	const b = g.adapter.build(g.targetProjectDir);
	if (!(await step("build_ok", () => run(b.cmd, b.args, g.targetProjectDir, timeout)))) return done();

	// 4. lint on changed files only
	const lintFiles = changed.filter((f) => /\.(ts|tsx)$/.test(f));
	const l = g.adapter.lint(g.targetProjectDir, lintFiles);
	if (!(await step("lint_ok", () => (lintFiles.length ? run(l.cmd, l.args, g.targetProjectDir, timeout) : Promise.resolve({ ok: true, output: "no lintable files" }))))) return done();

	// 5. rules (ast-grep / dependency rules) — none configured yet in v1 pilot; recorded explicitly so it is visible
	if (!(await step("rules_ok", async () => ({ ok: true, output: "no project rules configured (br init --rules pending)" })))) return done();

	// 6. the ported characterization tests
	const t = g.adapter.test(g.targetProjectDir, g.testFiles.map((x) => x.path));
	if (!(await step("ported_tests_green", () => run(t.cmd, t.args, g.targetProjectDir, timeout)))) return done();

	return done();

	function done(): GateReport {
		const failed = steps.find((s) => !s.ok);
		return { ok: !failed, steps, changedFiles: changed, failedStep: failed?.name, testFiles: g.testFiles.map((t) => t.path) };
	}
}

export function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ ok: boolean; output: string; exitCode?: number }> {
	return new Promise((resolvePromise) => {
		execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, CI: "1", FORCE_COLOR: "0" } }, (err, stdout, stderr) => {
			const body = `${stdout}${stderr}`.trim();
			const code = err ? ((err as any).code as number | string | undefined) : 0;
			const output = `$ ${cmd} ${args.join(" ")}\n${body}${err && (err as any).killed ? "\n[timed out]" : ""}${err && !body ? `\n[no output, exit ${String(code)}]` : ""}`.trim();
			resolvePromise({ ok: !err, output, exitCode: typeof code === "number" ? code : code === undefined ? 1 : -1 });
		});
	});
}

/** Files changed in the working tree under `dir` (git status), relative to `dir`. */
export function changedFiles(dir: string): string[] {
	try {
		const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" }).trim();
		const out = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--", "."], { cwd: dir, encoding: "utf8" });
		return out
			.split("\n")
			.filter(Boolean)
			.map((l) => l.slice(3).trim().replace(/^"|"$/g, ""))
			.map((p) => relative(dir, join(top, p)))
			.filter((p) => !p.startsWith("..") && !/^(node_modules|dist)(\/|$)/.test(p)); // worktrees symlink node_modules (a symlink is not matched by "node_modules/")
	} catch {
		return [];
	}
}

/** Files git already tracks under `dir` (relative to `dir`). */
export function trackedFiles(dir: string): string[] {
	try {
		return execFileSync("git", ["ls-files", "--", "."], { cwd: dir, encoding: "utf8" }).split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

export function sha1(buf: Buffer | string): string {
	return createHash("sha1").update(buf).digest("hex");
}

export function renderGate(r: GateReport): string {
	return r.steps.map((s) => `${s.ok ? "✓" : "✗"} ${s.name.padEnd(20)} ${String(s.ms).padStart(6)}ms${s.ok ? "" : `\n${s.output}`}`).join("\n") + `\nchanged: ${r.changedFiles.join(", ") || "-"}`;
}
