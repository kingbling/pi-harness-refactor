import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative } from "node:path";
import type { TargetAdapter, TargetSymbol } from "../adapters/types.ts";
import { targetBodies, targetClasses } from "../inventory/target.ts";
import type { Ledger } from "../ledger/db.ts";
import type { EvidenceType } from "../ledger/schema.ts";
import { activeRuleFiles } from "../rules/layout.ts";
import { checkTree } from "./layout-check.ts";
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
	/** The unit's placement: module dir (relative to targetProjectDir) and legacy area, for the structure check. */
	moduleDir?: string;
	area?: string;
	/** Workspace root (rules live in .bigrefactor/rules/<stackId>/) and the unit's stack; rules_ok is skipped without root. */
	root?: string;
	stackId?: string;
	/** Paths an approved tidy task names (sanctioned splits, moves, new shared topics). */
	sanctioned?: string[];
	/** The source adapter's legacy file kinds (SourceAdapter.legacyWords): no target name may carry one. */
	legacyWords?: string[];
	/**
	 * wired_ok: a reviewer model with tools judges whether the new code is real (no stubs), connected (reached by
	 * the framework, uses the migrated code) and on the chosen stack. Without one the step passes as "not judged".
	 */
	review?: (changedFiles: string[]) => Promise<{ ok: boolean; output: string; judged: boolean }>;
	/** Gate pool slot for the CPU-bound commands (build, lint, rules, tests); the review never holds one. */
	slot?: <T>(fn: () => Promise<T>) => Promise<T>;
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
	const changed = changedFiles(g.targetProjectDir, g.adapter.toolchain.ignoredPaths);
	const tracked = new Set(trackedFiles(g.targetProjectDir));
	const prodFiles = changed.filter((f) => !g.adapter.layout.isTestFile(f));
	const timeout = g.timeoutMs ?? 240_000;
	const cpu = g.slot ?? (<T>(fn: () => Promise<T>) => fn());
	const step = async (name: EvidenceType, fn: () => Promise<{ ok: boolean; output: string; exitCode?: number; judged?: boolean }>) => {
		const t0 = Date.now();
		const r = await fn();
		steps.push({ name, ok: r.ok, ms: Date.now() - t0, output: r.output.slice(-6000), exitCode: r.exitCode });
		if (r.ok) g.ledger.addEvidence(g.unitId, name, { ms: Date.now() - t0, ...(r.judged === false ? { judged: false, note: r.output.slice(0, 300) } : {}) });
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
		if (prodFiles.length === 0) problems.push("no production files were written");
		return { ok: problems.length === 0, output: problems.length ? problems.join("\n") : `${prodFiles.length} production file(s) changed within scope; tests untouched` };
	});
	if (!agOk) return done();

	// 3. structure + reuse: files follow the stack layout (one module per area, no per-legacy-file folders) and
	//    nothing re-creates a class or function body that already exists in the target
	//    (deleted files are not checked: a sanctioned tidy move removes a misnamed file; the write scope covers deletes)
	const structureOk = await step("structure_ok", async () => {
		const present = changed.filter((f) => existsSync(join(g.targetProjectDir, f)));
		const ctx = { isNew: (f: string) => !tracked.has(f), sanctioned: g.sanctioned ?? [], legacyWords: g.legacyWords };
		const lines = g.moduleDir && g.adapter.layout.checkStructure ? g.adapter.layout.checkStructure(present, g.moduleDir, g.area ?? "", g.targetProjectDir, ctx) : [];
		const warnings = lines.filter((l) => l.startsWith("warning:"));
		// drift checks (size cap, one class per responsibility …) on the touched files; drift elsewhere is reported, not failed
		const tree = checkTree(g.targetProjectDir, g.adapter, present);
		const problems = [...new Set([...lines.filter((l) => !l.startsWith("warning:")), ...tree, ...sharedTopicProblems(g, present, tracked)])].concat(await reuseProblems(g, prodFiles.filter((f) => present.includes(f)), changed));
		return { ok: problems.length === 0, output: [...(problems.length ? problems : ["layout ok; nothing duplicated"]), ...warnings].join("\n") };
	});
	if (!structureOk) return done();

	// 4. build and 5. lint on the unit's files only. A command that cannot take files checks the whole project:
	//    the builder runs it after merges now and then, not every unit (it grew with the project and ran out of memory)
	const unitFiles = changed.filter((f) => g.adapter.layout.lang(f) && existsSync(join(g.targetProjectDir, f)));
	const whole = wholeProjectSteps(g.adapter, g.targetProjectDir);
	const scopedStep = (name: "build" | "lint", c: { cmd: string; args: string[] }) => () =>
		whole.some((w) => w.step === name) ? Promise.resolve({ ok: true, output: `whole-project ${name}: the builder runs it after merges` }) : unitFiles.length ? cpu(() => run(c.cmd, c.args, g.targetProjectDir, timeout)) : Promise.resolve({ ok: true, output: `no files to ${name}` });
	if (!(await step("build_ok", scopedStep("build", g.adapter.build(g.targetProjectDir, unitFiles))))) return done();
	if (!(await step("lint_ok", scopedStep("lint", g.adapter.lint(g.targetProjectDir, unitFiles))))) return done();

	// 6. the stack's ast-grep rules on the changed production files
	if (!(await step("rules_ok", () => cpu(() => checkRules(g, prodFiles.filter((f) => g.adapter.layout.lang(f) && existsSync(join(g.targetProjectDir, f))), timeout))))) return done();

	// 7. a reviewer model with tools: real code, connected, on the chosen stack (outside the CPU slot)
	if (!(await step("wired_ok", () => (g.review ? g.review(changed) : Promise.resolve({ ok: true, output: "not judged: no reviewer in this run", judged: false }))))) return done();

	// 8. the ported characterization tests (one per truth case)
	const t = g.adapter.test(g.targetProjectDir, g.testFiles.map((x) => x.path));
	if (!(await step("ported_tests_green", () => cpu(() => run(t.cmd, t.args, g.targetProjectDir, timeout))))) return done();

	return done();

	function done(): GateReport {
		const failed = steps.find((s) => !s.ok);
		return { ok: !failed, steps, changedFiles: changed, failedStep: failed?.name, testFiles: g.testFiles.map((t) => t.path) };
	}
}

/**
 * The shared dir is not a second home for an area: an area unit may add files to an existing shared topic, but a
 * new topic (or one named after its own area) needs a shared unit (placement) or an approved tidy task.
 */
function sharedTopicProblems(g: GateInput, present: string[], tracked: Set<string>): string[] {
	const dirs = g.adapter.layout.sharedDirs;
	if (!g.moduleDir || dirs.some((d) => `${g.moduleDir}/`.startsWith(d))) return [];
	const out: string[] = [];
	for (const f of present) {
		const d = dirs.find((x) => f.startsWith(x));
		if (!d || tracked.has(f) || g.sanctioned?.includes(f) || g.adapter.layout.isTestFile(f)) continue;
		const topic = f.slice(d.length).split("/")[0]!;
		if (topic === g.area) out.push(`${f}: the area's code goes in ${g.moduleDir}/, not in a shared topic named after the area`);
		else if (![...tracked].some((t) => t.startsWith(`${d}${topic}/`))) out.push(`${f}: new shared topic ${d}${topic}/ from an area unit; put the code in ${g.moduleDir}/ (shared units and tidy tasks start shared topics) or import an existing one`);
	}
	return out;
}

/** Canonical class name for the reuse check: aliases of one kind collapse (Repo = Repository, Agency = AgencyEntity). */
export function classKey(name: string): string {
	return name
		.toLowerCase()
		.replace(/impl$/, "")
		.replace(/repo$/, "repository")
		.replace(/(entity|model|record)$/, "");
}

/**
 * Reuse, decided by code: a new class whose canonical name already exists in this stack's target index (or in another
 * changed file), and a function/method whose normalized body equals one in another file, fail with a pointer to the
 * original. Same-name DTOs/entities in different areas count too: one record = one class; a different record needs
 * an area-specific name. Files the unit changed are compared against their fresh parse, not the index; fresh bodies
 * include non-exported functions and private methods (tag "internal"), so a copy hidden there fails too.
 */
async function reuseProblems(g: GateInput, prodFiles: string[], allChanged: string[]): Promise<string[]> {
	if (!g.adapter.indexFile) return [];
	// every changed path, deleted ones too: a tidy move's old path is still indexed but no original any more
	const changed = new Set(allChanged);
	const fresh: TargetSymbol[] = [];
	for (const f of prodFiles) if (g.adapter.layout.lang(f) && existsSync(join(g.targetProjectDir, f))) fresh.push(...(await g.adapter.indexFile(g.targetProjectDir, f).catch(() => [])));
	const problems: string[] = [];
	const indexed = targetClasses(g.ledger, g.adapter.id).filter((r) => !changed.has(r.path));
	for (const s of fresh) {
		if (s.tags.includes("class")) {
			const key = classKey(s.name);
			const dup = !key ? undefined : indexed.find((r) => classKey(r.name) === key) ?? fresh.find((o) => o.path !== s.path && o.tags.includes("class") && classKey(o.name) === key);
			if (dup) problems.push(`reuse ${dup.path}::${dup.name} — ${s.path} declares ${s.name} again; extend/import the existing class (a different record needs an area-specific name)`);
		}
		if (s.bodyHash) {
			const dup = targetBodies(g.ledger, g.adapter.id, s.bodyHash).find((r) => !changed.has(r.path)) ?? fresh.find((o) => o.path !== s.path && o.bodyHash === s.bodyHash);
			if (dup) problems.push(`reuse ${dup.path}::${dup.name} — ${s.path}::${s.name} has the same body; call or move it to a shared helper instead of copying`);
		}
	}
	return [...new Set(problems)];
}

/**
 * rules_ok: every active ast-grep rule of the stack against the changed files. A match with severity error/warning
 * fails with rule id + location; hint/info are listed only. No rules, no binary or a broken rule file: ok with the
 * reason, so a bad rule never blocks every unit.
 */
async function checkRules(g: GateInput, files: string[], timeoutMs: number): Promise<{ ok: boolean; output: string }> {
	if (!g.root) return { ok: true, output: "skipped: no workspace root given" };
	const stackId = g.stackId ?? g.adapter.id;
	const rules = activeRuleFiles(g.root, stackId);
	if (!rules.length) return { ok: true, output: `skipped: no ast-grep rules for ${stackId}` };
	if (!files.length) return { ok: true, output: "skipped: no changed source files" };
	const bin = astGrepBin();
	if (!bin) return { ok: true, output: "skipped: ast-grep is not installed" };
	const fails: string[] = [];
	const notes: string[] = [];
	for (const rule of rules) {
		const r = await new Promise<{ stdout: string; stderr: string; code: number; spawnError?: string }>((res) =>
			execFile(bin, ["scan", "--rule", rule, "--json=compact", ...files], { cwd: g.targetProjectDir, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
				res({ stdout, stderr, code: err ? (typeof (err as any).code === "number" ? (err as any).code : -1) : 0, spawnError: err && (err as any).code === "ENOENT" ? "ENOENT" : undefined }),
			),
		);
		if (r.spawnError) return { ok: true, output: "skipped: ast-grep is not installed" };
		// exit 0 = no match, 1 = matches; anything else (8: rule does not parse) means the rule never ran
		if ((r.code !== 0 && r.code !== 1) || (!r.stdout.trim() && r.stderr.trim() && r.code !== 0)) {
			notes.push(`rule ${basename(rule)} not applied (exit ${r.code}): ${r.stderr.replace(/\[warn\][^\n]*\n(Enable[^\n]*\n)?/g, "").trim().slice(0, 300)}`);
			continue;
		}
		let matches: Array<{ ruleId: string; severity: string; file: string; message: string; range: { start: { line: number; column: number } } }>;
		try {
			matches = JSON.parse(r.stdout || "[]");
		} catch {
			notes.push(`rule ${basename(rule)} not applied: ${r.stderr.replace(/\[warn\][^\n]*\n(Enable[^\n]*\n)?/g, "").trim().slice(0, 300)}`);
			continue;
		}
		for (const m of matches) {
			const line = `${m.ruleId} ${m.file}:${m.range.start.line + 1}:${m.range.start.column + 1} ${m.message}`.trim();
			(m.severity === "error" || m.severity === "warning" ? fails : notes).push(line);
		}
	}
	const head = `${rules.length} rule(s) on ${files.length} file(s)`;
	return { ok: fails.length === 0, output: [fails.length ? `rule violations (${head}):` : `${head}: no violations`, ...fails, ...notes.map((n) => `note: ${n}`)].join("\n") };
}

/** The ast-grep CLI this package ships (devDependency @ast-grep/cli), else one on PATH. */
function astGrepBin(): string | undefined {
	try {
		const dir = dirname(createRequire(import.meta.url).resolve("@ast-grep/cli/package.json"));
		if (existsSync(join(dir, "ast-grep"))) return join(dir, "ast-grep");
	} catch {
		/* not installed with this package */
	}
	return "ast-grep";
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
/** Files changed in the project, without generated paths (`ignored`: dependencies, build output; symlinked in worktrees). */
export function changedFiles(dir: string, ignored: string[] = []): string[] {
	try {
		const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
		const out = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--", "."], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return out
			.split("\n")
			.filter(Boolean)
			.map((l) => l.slice(3).trim().replace(/^"|"$/g, ""))
			.map((p) => relative(realpathSync(dir), join(top, p))) // top is the real path (/var → /private/var on macOS)
			.filter((p) => !p.startsWith("..") && !ignored.some((i) => p === i || p.startsWith(`${i}/`))); // a symlinked dependency dir is not matched by a "dir/" ignore line
	} catch {
		return [];
	}
}

/** Files git already tracks under `dir` (relative to `dir`). */
export function trackedFiles(dir: string): string[] {
	try {
		return execFileSync("git", ["ls-files", "--", "."], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n").filter(Boolean);
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

/** Lines that only say that something failed, not why ("There were 2 errors:"): the key looks past them. */
const SUMMARY_LINE = /^(?:there (?:was|were) \d+ (?:errors?|failures?)|\[error\] found \d+ errors?|instructions for interpreting errors|errors!|failures!|tests?:? +\d+|test files\b|⎯+ failed|an error occurred inside phpunit)/i;
/** Stack frames and the echoed command: where it happened, not what. */
const FRAME_LINE = /^(?:#\d+ |at |❯ |\$ )/;
/** An assertion message is about the unit's own behaviour, not a shared cause. */
const ASSERTION = /failed asserting|assertionerror|expected .+ to /i;

/**
 * Same error, different unit → same key: step + the first line that says what went wrong. Paths are dropped
 * (worktree paths carry the unit id), file names and numbers too; names in quotes are kept (a missing class or
 * module is the cause). A line that names no cause (only a summary, an assertion) keeps the first file the output
 * names, so unrelated units never share it by key. Only a cheap first match: a model decides whether two
 * different keys are one cause (sameQuestion in src/jev/same.ts).
 */
export function errorSignature(step: string, output: string): string {
	const lines = output.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	// what follows a tool's closing summary is its footer (PHPStan's "how to read errors"), never the cause
	const end = lines.reduce((e, l, i) => (SUMMARY_LINE.test(l) ? i : e), lines.length); // the last summary line
	const cause = lines.findIndex((l, i) => i < end && /error|failed|cannot|not found/i.test(l) && !FRAME_LINE.test(l) && !SUMMARY_LINE.test(l));
	const at = cause >= 0 ? cause : Math.max(0, lines.findIndex((l) => SUMMARY_LINE.test(l)));
	const line = lines[at] ?? "";
	let key = normalizeErrorLine(line);
	if (cause < 0 || ASSERTION.test(line)) {
		const file = lines.slice(at + 1).concat(lines).flatMap((l) => l.match(/[^\s'"`()]*\/[^\s'"`():]+\.[a-z][a-z0-9]{0,4}\b/gi) ?? []).find((f) => !f.includes("://")); // not a docs link
		if (file) key += ` in ${basename(file)}`;
	}
	return `${step}: ${key}`.slice(0, 200);
}

/** One error line without what differs per unit: paths (outside quotes any with a slash, inside only absolute ones), file names, numbers. */
function normalizeErrorLine(line: string): string {
	return line
		.replace(/^PHP (?=[A-Z][a-z]+(?: [a-z]+)?:)/, "") // "PHP Fatal error:" (stderr) and "Fatal error:" (stdout) are one message
		.replace(/(["'`])((?:(?!\1).)*)\1|[^\s'"`()<>[\]{},;|]*\/[^\s'"`()<>[\]{},;|]*/g, (m, q: string | undefined, inner: string | undefined) =>
			q ? `${q}${inner!.replace(/(?<![\w@.-])(?:[a-z][\w+.-]*:\/\/|~\/|\/)[^\s'"`]*/gi, "<path>")}${q}` : "<path>",
		)
		.replace(/(["'`])((?:(?!\1).)*)\1|\b[\w-]+\.[a-z][a-z0-9]{0,4}\b/gi, (m, q: string | undefined) => (q ? m : "<file>"))
		.replace(/\b\d+\b/g, "N")
		.replace(/\s+/g, " ")
		.trim();
}

/** The stack's build/lint commands that ignore the files they are given: they check the whole project. */
export function wholeProjectSteps(adapter: TargetAdapter, dir: string): Array<{ step: "build" | "lint"; cmd: string; args: string[] }> {
	const MARK = "\u0000unit-file";
	const takesFiles = (c: { cmd: string; args: string[] }) => c.cmd === MARK || c.args.includes(MARK);
	const out: Array<{ step: "build" | "lint"; cmd: string; args: string[] }> = [];
	if (!takesFiles(adapter.build(dir, [MARK]))) out.push({ step: "build", ...adapter.build(dir, []) });
	if (!takesFiles(adapter.lint(dir, [MARK]))) out.push({ step: "lint", ...adapter.lint(dir, []) });
	return out;
}
