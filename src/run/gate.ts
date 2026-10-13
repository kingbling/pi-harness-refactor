import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative } from "node:path";
import type { TargetAdapter, TargetSymbol } from "../adapters/types.ts";
import { targetBodies, targetClasses } from "../inventory/target.ts";
import type { Ledger } from "../ledger/db.ts";
import type { EvidenceType } from "../ledger/schema.ts";
import { activeRuleFiles } from "../rules/layout.ts";
import { isWiringFile } from "../rules/layout-rules.ts";
import { checkTree } from "./layout-check.ts";
import { globToRegExp } from "../sessions/spawn.ts";
import { runPortedTests } from "./ported.ts";

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
	/** The area's ported test files (this unit's and earlier units'), with their hashes at hand-over time. */
	testFiles: Array<{ path: string; sha1: string }>;
	/** Main's checkout of the unit's project: another unit's test that fails here counts only if it passes there. */
	mainDir?: string;
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
	 * `nearDuplicates`: classes whose names only look alike (Repo/Repository …) — facts for the reviewer to judge.
	 */
	review?: (changedFiles: string[], nearDuplicates?: string[]) => Promise<{ ok: boolean; output: string; judged: boolean }>;
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
	/** Time the step held a gate slot (the wait for one not counted); what `br lanes` measures gate load by. */
	slotMs?: number;
	output: string;
}
export interface GateReport {
	ok: boolean;
	steps: GateStep[];
	changedFiles: string[];
	failedStep?: EvidenceType;
	/** Protected test files the gate checked (so triage can tell "error in a test file" from "error in production code"). */
	testFiles?: string[];
	/** structure_ok: the failing paths a protected test imports (the implementer cannot rename them; the tester must). */
	testImported?: string[];
}

export async function runGate(g: GateInput): Promise<GateReport> {
	const steps: GateStep[] = [];
	// structure_ok: its failing paths a protected test imports (set by that step)
	let testImported: string[] | undefined;
	const changed = changedFiles(g.targetProjectDir, g.adapter.toolchain.ignoredPaths);
	const tracked = new Set(trackedFiles(g.targetProjectDir));
	const prodFiles = changed.filter((f) => !g.adapter.layout.isTestFile(f));
	const timeout = g.timeoutMs ?? 240_000;
	const slot = g.slot ?? (<T>(fn: () => Promise<T>) => fn());
	let slotMs = 0;
	const cpu = <T>(fn: () => Promise<T>) =>
		slot(async () => {
			const t0 = Date.now();
			try {
				return await fn();
			} finally {
				slotMs += Date.now() - t0;
			}
		});
	const step = async (name: EvidenceType, fn: () => Promise<{ ok: boolean; output: string; exitCode?: number; judged?: boolean }>) => {
		const t0 = Date.now();
		slotMs = 0;
		const r = await fn();
		// cut output is saved whole in the unit's sessions folder: the prompt names the file
		const full = g.root ? join(g.root, ".bigrefactor", "sessions", `${g.unitId}.${name}.log`) : undefined;
		steps.push({ name, ok: r.ok, ms: Date.now() - t0, slotMs, output: clipOutput(r.output, 6000, full), exitCode: r.exitCode });
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
		// the unit's own ported tests are the tester's (a re-port edits one already on main): the hash check below covers them
		const own = new Set(g.testFiles.map((t) => t.path));
		for (const f of changed) {
			if (own.has(f) || allow.some((r) => r.test(f))) continue;
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
		for (const f of othersTestsChanged(g.targetProjectDir, g.unitId, (x) => g.adapter.layout.isTestFile(x), g.sanctioned)) problems.push(`changed a test of an earlier unit: ${f} (it proves accepted behaviour; report a wrong one with dispute_test / report_migrated_bug)`);
		// a comment that silences the type check or the linter hides an error instead of fixing it (only lines this unit added)
		const silence = g.adapter.layout.suppressMarker;
		if (silence) for (const f of prodFiles) for (const l of addedLines(g.targetProjectDir, f, tracked.has(f))) if (silence.test(l.text)) problems.push(`check silenced in ${f}:${l.line} (${l.text.trim().slice(0, 80)}): fix the error instead`);
		// a merge conflict restored into the worktree: no marker line may reach main (build and tests do not read every file)
		for (const f of conflictMarkers(g.targetProjectDir, changed)) problems.push(`unresolved merge conflict in ${f}: keep the changes of both sides and remove the <<<<<<< ======= >>>>>>> lines`);
		// no code written but ported tests to run: existing code may already do it (reuse); the tests and the reviewer decide
		const reuse = prodFiles.length === 0 && g.testFiles.length > 0;
		if (prodFiles.length === 0 && !reuse && !nothingToWrite(g)) problems.push(NOTHING_WRITTEN);
		return { ok: problems.length === 0, output: problems.length ? problems.join("\n") : reuse ? "no production file changed (reuse): the ported tests and the reviewer decide" : `${prodFiles.length} production file(s) changed within scope; tests untouched` };
	});
	if (!agOk) return done();

	// 3. structure + reuse: files follow the stack layout (one module per area, no per-legacy-file folders) and
	//    nothing re-creates a class or function body that already exists in the target
	//    (deleted files are not checked: a sanctioned tidy move removes a misnamed file; the write scope covers deletes)
	let nearDuplicates: string[] = [];
	const structureOk = await step("structure_ok", async () => {
		const present = changed.filter((f) => existsSync(join(g.targetProjectDir, f)));
		const ctx = { isNew: (f: string) => !tracked.has(f), sanctioned: g.sanctioned ?? [], legacyWords: g.legacyWords };
		const lines = g.moduleDir && g.adapter.layout.checkStructure ? g.adapter.layout.checkStructure(present, g.moduleDir, g.area ?? "", g.targetProjectDir, ctx) : [];
		const warnings = lines.filter((l) => l.startsWith("warning:"));
		// drift checks (size cap, one class per responsibility …) on the touched files; drift elsewhere is reported, not failed
		const tree = checkTree(g.targetProjectDir, g.adapter, present);
		const reuse = await reuseProblems(g, prodFiles.filter((f) => present.includes(f)), changed);
		nearDuplicates = reuse.near;
		const problems = [...new Set([...lines.filter((l) => !l.startsWith("warning:")), ...tree, ...sharedTopicProblems(g, present, tracked)])].concat(reuse.problems);
		// only path findings (checkStructure) need a renamed import; size and class findings (checkTree) are about the file's content
		testImported = importedByTests(g.targetProjectDir, g.testFiles.map((t) => t.path), lines.filter((l) => !l.startsWith("warning:")));
		return { ok: problems.length === 0, output: [...(problems.length ? problems : ["layout ok; nothing duplicated"]), ...warnings, ...reuse.near.map((n) => `note: ${n} (the reviewer judges it)`)].join("\n") };
	});
	if (!structureOk) return done();

	// 4. build and 5. lint on the unit's files only. A command that cannot take files checks the whole project:
	//    the builder runs it after merges now and then, not every unit (it grew with the project and ran out of memory)
	const unitFiles = buildFiles(g.targetProjectDir, g.adapter, changed);
	const scopedStep = (name: "build" | "lint") => () => {
		const c = scopedCheck(g.adapter, g.targetProjectDir, name, unitFiles);
		// skipped is not a pass: it is stored as not judged, so nobody reads a 0 ms build_ok as a green build
		return "skip" in c ? Promise.resolve({ ok: true, output: c.skip, judged: false }) : cpu(() => run(c.cmd, c.args, g.targetProjectDir, timeout));
	};
	if (!(await step("build_ok", scopedStep("build")))) return done();
	if (!(await step("lint_ok", scopedStep("lint")))) return done();

	// 6. the stack's ast-grep rules on the changed production files
	if (!(await step("rules_ok", () => cpu(() => checkRules(g, prodFiles.filter((f) => g.adapter.layout.lang(f) && existsSync(join(g.targetProjectDir, f))), timeout))))) return done();

	// 7. the ported characterization tests (one per truth case), before the review: a red test is cheaper to find than a review
	const cases = (g.ledger.db.prepare("SELECT COUNT(*) n FROM truth_cases WHERE unit_id = ?").get(g.unitId) as { n: number }).n;
	// a unit the tester found without runtime behaviour (a pure contract, constants) has nothing to pin: no tests to run
	const none = !cases && !g.testFiles.length ? noBehaviour(g.ledger, g.unitId) : undefined;
	if (!(await step("ported_tests_green", () => (none !== undefined ? Promise.resolve({ ok: true, output: `no runtime behaviour to pin (the tester's reason: ${none}); the reviewer judges it` }) : !g.testFiles.length ? Promise.resolve({ ok: false, output: cases ? `${cases} truth case(s) but no ported test file: nothing proves the behaviour` : "no truth cases, no ported test file and no reason from the tester why there is nothing to pin: nothing proves the behaviour" }) : cpu(() => runPortedTests({ ledger: g.ledger, unitId: g.unitId, adapter: g.adapter, dir: g.targetProjectDir, tests: g.testFiles.map((x) => x.path), mainDir: g.mainDir, timeoutMs: timeout })))))) return done();

	// 8. a reviewer model with tools: real code, connected, on the chosen stack (outside the CPU slot)
	if (!(await step("wired_ok", () => (g.review ? g.review(changed, nearDuplicates) : Promise.resolve({ ok: true, output: "not judged: no reviewer in this run", judged: false }))))) return done();

	return done();

	function done(): GateReport {
		const failed = steps.find((s) => !s.ok);
		return { ok: !failed, steps, changedFiles: changed, failedStep: failed?.name, testFiles: g.testFiles.map((t) => t.path), ...(testImported?.length ? { testImported } : {}) };
	}
}

/**
 * The paths of `<path>: <problem>` findings that a test file imports: its relative specifier (./pages/OfferEditPage)
 * or its project path without the first folder and extension (an alias such as @/features/offers/pages/OfferEditPage).
 */
export function importedByTests(projectDir: string, tests: string[], findings: string[]): string[] {
	const paths = [...new Set(findings.map((l) => /^([^\s:]+\.[A-Za-z0-9]+):/.exec(l)?.[1]).filter((p): p is string => !!p && !tests.includes(p)))];
	if (!paths.length || !tests.length) return [];
	const texts = tests.map((t) => ({ t, text: existsSync(join(projectDir, t)) ? readFileSync(join(projectDir, t), "utf8") : "" }));
	return paths.filter((p) => {
		const noExt = p.replace(/\.[A-Za-z0-9]+$/, "");
		return texts.some(({ t, text }) => {
			let rel = relative(dirname(t), noExt);
			if (!rel.startsWith(".")) rel = `./${rel}`;
			const tail = noExt.split("/").slice(1).join("/");
			return ["\"", "'"].some((q) => [rel, `${rel}${p.slice(noExt.length)}`].some((s) => text.includes(`${q}${s}${q}`)) || (tail.includes("/") && text.includes(`/${tail}${q}`)));
		});
	});
}

/** Changed files (project-relative) that still hold a git conflict marker line, as "file:line". */
export function conflictMarkers(dir: string, files: string[]): string[] {
	const out: string[] = [];
	for (const f of files) {
		let text = "";
		try {
			text = readFileSync(join(dir, f), "utf8");
		} catch {
			continue; // removed, or not a file
		}
		if (text.includes("\0")) continue; // binary
		const i = text.split("\n").findIndex((l) => /^(?:<{7}|>{7})(?: |$)/.test(l));
		if (i >= 0) out.push(`${f}:${i + 1}`);
	}
	return out;
}

/** Terminal colour codes: test runners print them even with FORCE_COLOR=0 and they only cost room. */
const ANSI = /\x1b\[[0-9;]*m/g;
/** A line that says what failed, in any runner's words (a failed test, an error, an assertion, a ✗ mark). */
const FAILURE = /\b(?:fail(?:ed|ures?|s)?|errors?|exception|assert\w*|expect(?:ed)?|not ok)\b|[✗×✕]|\w+Error\b/i;
/** A deprecation or notice: noise next to a failure, never its cause. */
const NOTICE = /\b(?:deprecat\w*|notices?)\b/i;

/**
 * A step's output for the report and the next prompt, at most `max` chars. Long output (phpstan, phpunit, vitest)
 * shows the failure blocks first (the lines around what says FAIL, Error, assert, expected, ✗), then the rest with
 * its start (the command, the first errors) and its end (the summary): colour codes, deprecation and notice lines
 * and padding go, a line already shown twice is left out, and what still does not fit is cut from the middle.
 * `saveTo`: when anything was cut, the full output is written there and the clip names the file.
 */
export function clipOutput(out: string, max = 6000, saveTo?: string): string {
	const plain = out.replace(ANSI, "");
	if (plain.length <= max) return plain;
	const seen = new Map<string, number>();
	let dropped = 0;
	let notices = 0;
	const all = plain
		.split("\n")
		.map((l) => l.trimEnd())
		.filter((l) => {
			if (!l.trim()) return true;
			const n = (seen.get(l.trim()) ?? 0) + 1;
			seen.set(l.trim(), n);
			if (n <= 2) return true;
			dropped++;
			return false;
		});
	// the failure blocks: each failure line with one line before and eight after (the message, the code frame).
	// Deprecation and notice lines go, but never from a failure line or the eight after it (a code line with the word)
	const frame = new Set<number>();
	const before = new Set<number>();
	all.forEach((l, i) => {
		if (!FAILURE.test(l)) return;
		if (i > 0) before.add(i - 1);
		for (let j = i; j <= Math.min(all.length - 1, i + 8); j++) frame.add(j);
	});
	const inBlock = new Set<number>();
	const lines = all.filter((l, i) => {
		if (!frame.has(i) && NOTICE.test(l)) return (notices++, false);
		if (frame.has(i) || before.has(i)) inBlock.add(i - notices);
		return true;
	});
	let saved = "";
	if (saveTo)
		try {
			mkdirSync(dirname(saveTo), { recursive: true });
			writeFileSync(saveTo, plain);
			saved = `(full output: ${saveTo})\n`;
		} catch {
			/* no file: the clip alone */
		}
	const note = `${saved}${dropped ? `(${dropped} repeated line(s) left out)\n` : ""}${notices ? `(${notices} deprecation or notice line(s) left out)\n` : ""}`;
	const cut = (text: string, room: number) => {
		if (text.length <= room) return text;
		const head = Math.floor(room / 3);
		return `${text.slice(0, head)}\n… ${text.length - room} chars left out …\n${text.slice(-(room - head))}`;
	};
	const rest = lines.filter((_, i) => !inBlock.has(i)).join("\n");
	// no failure line, or nothing outside the blocks: the whole text with its start and its end
	if (!inBlock.size || !rest.trim()) return note + cut(lines.join("\n"), Math.max(200, max - note.length));
	const blocks: string[] = [];
	lines.forEach((l, i) => {
		if (!inBlock.has(i)) return;
		if (i > 0 && !inBlock.has(i - 1) && blocks.length) blocks.push("…");
		blocks.push(l);
	});
	const room = Math.max(400, max - note.length - 40);
	const failures = blocks.join("\n").slice(0, Math.floor((room * 2) / 3));
	return `${note}failures:\n${failures}\n── rest of the output ──\n${cut(rest, room - failures.length)}`;
}

/** The tester's reason why the unit has no runtime behaviour to pin (latest truth_none evidence), or undefined. */
export function noBehaviour(ledger: Ledger, unitId: string): string | undefined {
	const row = ledger.db.prepare("SELECT payload FROM evidence WHERE unit_id = ? AND type = 'truth_none' ORDER BY id DESC LIMIT 1").get(unitId) as { payload: string } | undefined;
	if (!row) return undefined;
	try {
		return String((JSON.parse(row.payload) as { reason?: unknown }).reason ?? "") || "no reason given";
	} catch {
		return "no reason given";
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
		// a wiring file (config/bundles.php) is where a unit registers itself: never a new topic
		if (!d || tracked.has(f) || g.sanctioned?.includes(f) || g.adapter.layout.isTestFile(f) || isWiringFile(f, g.adapter.layout.wiringFiles)) continue;
		const topic = f.slice(d.length).split("/")[0]!;
		if (topic === g.area) out.push(`${f}: the area's code goes in ${g.moduleDir}/, not in a shared topic named after the area`);
		else if (![...tracked].some((t) => t.startsWith(`${d}${topic}/`))) out.push(`${f}: new shared topic ${d}${topic}/ from an area unit; put the code in ${g.moduleDir}/ (shared units and tidy tasks start shared topics) or import an existing one`);
	}
	return out;
}

/** Canonical class name to find look-alike classes (Repo = Repository, Agency = AgencyEntity): a hint, never proof. */
export function classKey(name: string): string {
	return name
		.toLowerCase()
		.replace(/impl$/, "")
		.replace(/repo$/, "repository")
		.replace(/(entity|model|record)$/, "");
}

/**
 * Reuse, decided by code on facts: a new class whose name already exists in this stack's target index (or in another
 * changed file), and a function/method whose normalized body equals one in another file, fail with a pointer to the
 * original. Same-name DTOs/entities in different areas count too: one record = one class; a different record needs
 * an area-specific name. Files the unit changed are compared against their fresh parse, not the index; fresh bodies
 * include non-exported functions and private methods (tag "internal"), so a copy hidden there fails too.
 * A name that only looks alike (classKey: AgencyRepo next to AgencyRepository) is a guess, not a fact: it goes to
 * the reviewer model as `near`, which judges whether it is the same record.
 */
async function reuseProblems(g: GateInput, prodFiles: string[], allChanged: string[]): Promise<{ problems: string[]; near: string[] }> {
	// no symbol index for this stack (generated adapters): code cannot compare, so the reviewer searches instead
	if (!g.adapter.indexFile)
		return { problems: [], near: prodFiles.length ? [`the ${g.adapter.id} stack has no symbol index, so the duplicate check did not run on ${prodFiles.join(", ")}: search the project (grep) for the classes and functions these files declare; a copy of a class, record or helper that already exists elsewhere is a finding (reuse the existing one)`] : [] };
	// every changed path, deleted ones too: a tidy move's old path is still indexed but no original any more
	const changed = new Set(allChanged);
	const fresh: TargetSymbol[] = [];
	for (const f of prodFiles) if (g.adapter.layout.lang(f) && existsSync(join(g.targetProjectDir, f))) fresh.push(...(await g.adapter.indexFile(g.targetProjectDir, f).catch(() => [])));
	const problems: string[] = [];
	const near: string[] = [];
	const indexed = targetClasses(g.ledger, g.adapter.id).filter((r) => !changed.has(r.path));
	for (const s of fresh) {
		if (s.tags.includes("class")) {
			const others = [...indexed, ...fresh.filter((o) => o.path !== s.path && o.tags.includes("class"))];
			const same = others.find((o) => o.name.toLowerCase() === s.name.toLowerCase());
			const alike = !same && classKey(s.name) ? others.find((o) => classKey(o.name) === classKey(s.name)) : undefined;
			if (same) problems.push(`reuse ${same.path}::${same.name} — ${s.path} declares ${s.name} again; extend/import the existing class (a different record needs an area-specific name)`);
			else if (alike) near.push(`${s.path} declares ${s.name}, and ${alike.path} has ${alike.name}: if it is the same record or class, reuse the existing one`);
		}
		if (s.bodyHash) {
			const dup = targetBodies(g.ledger, g.adapter.id, s.bodyHash).find((r) => !changed.has(r.path)) ?? fresh.find((o) => o.path !== s.path && o.bodyHash === s.bodyHash);
			if (dup) problems.push(`reuse ${dup.path}::${dup.name} — ${s.path}::${s.name} has the same body; call or move it to a shared helper instead of copying`);
		}
	}
	return { problems: [...new Set(problems)], near: [...new Set(near)] };
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

/**
 * The stack's test command on `files`. A red run that talks about deprecations or notices is run again with the
 * stack's lenient test command when the workspace has one (the setup fixer writes it with the runner's own flags,
 * e.g. PHPUnit's --do-not-fail-on-deprecation): green then means every test passed, and the deprecations and notices
 * are a warning. Still red: the first run's output stands (the real failure).
 */
export async function runTests(adapter: TargetAdapter, dir: string, files: string[], timeoutMs: number): Promise<{ ok: boolean; output: string; exitCode?: number }> {
	const t = adapter.test(dir, files);
	const r = await run(t.cmd, t.args, dir, timeoutMs);
	if (r.ok || !NOTICE.test(r.output.replace(ANSI, "")) || r.output.endsWith("[timed out]")) return r;
	const l = adapter.testLenient?.(dir, files);
	if (!l) return r;
	const again = await run(l.cmd, l.args, dir, timeoutMs);
	if (!again.ok) return r;
	return { ...again, output: `warning: every test passed; the run failed only on deprecations or notices, so they are warnings here (\`${[l.cmd, ...l.args].join(" ")}\`); fix them when you can\n${again.output}` };
}

/** Files changed in the working tree under `dir` (git status), relative to `dir`. */
/** Files changed in the project, without generated paths (`ignored`: dependencies, build output; symlinked in worktrees). */
/** Lines of `f` (project-relative) not in HEAD, with their line numbers: a new file's every line. */
export function addedLines(dir: string, f: string, isTracked: boolean): Array<{ line: number; text: string }> {
	const abs = join(dir, f);
	if (!existsSync(abs)) return [];
	if (!isTracked) return readFileSync(abs, "utf8").split("\n").map((text, i) => ({ line: i + 1, text }));
	const out: Array<{ line: number; text: string }> = [];
	let at = 0;
	for (const l of execFileSync("git", ["diff", "-U0", "HEAD", "--", f], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n")) {
		const hunk = /^@@ -\S+ \+(\d+)/.exec(l);
		if (hunk) at = Number(hunk[1]);
		else if (l.startsWith("+") && !l.startsWith("+++")) out.push({ line: at++, text: l.slice(1) });
	}
	return out;
}

/** The changed files the gate builds and lints (check_my_code checks the same): in a language of the stack, still on disk. */
export function buildFiles(dir: string, adapter: TargetAdapter, changed: string[]): string[] {
	return changed.filter((f) => adapter.layout.lang(f) && existsSync(join(dir, f)));
}

export function changedFiles(dir: string, ignored: string[] = []): string[] {
	// a git failure throws: read as "nothing written" it would be blamed on the implementer, not the environment
	const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	const out = execFileSync("git", ["status", "--porcelain", "-z", "--no-renames", "--untracked-files=all", "--", "."], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	return out
		.split("\0")
		.filter(Boolean)
		.map((l) => l.slice(3))
		.map((p) => relative(realpathSync(dir), join(top, p))) // top is the real path (/var → /private/var on macOS)
		.filter((p) => !p.startsWith("..") && !ignored.some((i) => p === i || p.startsWith(`${i}/`))); // a symlinked dependency dir is not matched by a "dir/" ignore line
}

/**
 * Tests of earlier units this unit changed or removed: test files git already tracks whose committed version does
 * not name one of this unit's truth cases (`<unit>#N`). Only their own unit's tester may change them (a reopen);
 * a test that looks wrong is reported (dispute_test, report_migrated_bug), not rewritten. Tidy-sanctioned paths pass.
 */
export function othersTestsChanged(dir: string, unitId: string, isTestFile: (f: string) => boolean, sanctioned: string[] = []): string[] {
	const tracked = new Set(trackedFiles(dir));
	const own = new RegExp(`(?<![\\w-])${unitId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}#\\d`);
	return changedFiles(dir).filter((f) => {
		if (!isTestFile(f) || !tracked.has(f) || sanctioned.includes(f)) return false;
		try {
			return !own.test(execFileSync("git", ["show", `HEAD:./${f}`], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 }));
		} catch {
			return false; // not in HEAD: new in this worktree
		}
	});
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
 * names, so unrelated units never share it by key (not for a crash: step "exception"). Only a cheap first match: a model decides whether two
 * different keys are one cause (sameQuestion in src/jev/same.ts).
 */
export function errorSignature(step: string, output: string): string {
	const lines = output.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	// what follows a tool's closing summary is its footer (PHPStan's "how to read errors"), never the cause
	const end = lines.reduce((e, l, i) => (SUMMARY_LINE.test(l) ? i : e), lines.length); // the last summary line
	const cause = lines.findIndex((l, i) => i < end && /error|failed|fatal|cannot|could not|not found|no such/i.test(l) && !FRAME_LINE.test(l) && !SUMMARY_LINE.test(l));
	const at = cause >= 0 ? cause : Math.max(0, lines.findIndex((l) => SUMMARY_LINE.test(l)));
	const line = lines[at] ?? "";
	let key = normalizeErrorLine(line);
	// a crash message is its own cause: the file it names differs per unit, so it never goes into the key
	if ((cause < 0 || ASSERTION.test(line)) && step !== "exception") {
		const file = lines.slice(at + 1).concat(lines).flatMap((l) => l.match(/[^\s'"`()]*\/[^\s'"`():]+\.[a-z][a-z0-9]{0,4}\b/gi) ?? []).find((f) => !f.includes("://")); // not a docs link
		if (file) key += ` in ${basename(file)}`;
	}
	return `${step}: ${key}`.slice(0, 200);
}

/**
 * What one failed gate step found, for comparing two attempts of the same unit: a reviewer says the same thing in
 * new words each time, so its findings count by the places they point at (file:line); other output by its
 * errorSignature. The same key twice in a row means another attempt is unlikely to get further.
 */
export function findingKey(step: string, output: string): string {
	const places = [...output.matchAll(/^- (\S+?):(?:\d+:)? /gm)].map((m) => m[0].slice(2, -1).replace(/:$/, ""));
	return places.length ? `${step}: ${[...new Set(places)].sort().join(" ")}` : errorSignature(step, output);
}

/** One error line without what differs per unit: paths (outside quotes any with a slash, inside only absolute ones), file names, commit ids, numbers. */
function normalizeErrorLine(line: string): string {
	return line
		.replace(/^PHP (?=[A-Z][a-z]+(?: [a-z]+)?:)/, "") // "PHP Fatal error:" (stderr) and "Fatal error:" (stdout) are one message
		.replace(/(["'`])((?:(?!\1).)*)\1|[^\s'"`()<>[\]{},;|]*\/[^\s'"`()<>[\]{},;|]*/g, (m, q: string | undefined, inner: string | undefined) =>
			q ? `${q}${inner!.replace(/(?<![\w@.-])(?:[a-z][\w+.-]*:\/\/|~\/|\/)[^\s'"`]*/gi, "<path>")}${q}` : "<path>",
		)
		.replace(/(["'`])((?:(?!\1).)*)\1|\b[\w-]+\.[a-z][a-z0-9]{0,4}\b/gi, (m, q: string | undefined) => (q ? m : "<file>"))
		.replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g, "<sha>") // a commit id
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

/**
 * The stack's build or lint on the given files, or why it does not run per unit: a command that ignores the files
 * checks the whole project, and the builder runs it after merges. Shared by the gate and the tester's checks.
 */
export function scopedCheck(adapter: TargetAdapter, dir: string, name: "build" | "lint", files: string[]): { cmd: string; args: string[] } | { skip: string } {
	if (wholeProjectSteps(adapter, dir).some((w) => w.step === name)) return { skip: `whole-project ${name}: the builder runs it after merges` };
	if (!files.length) return { skip: `no files to ${name}` };
	return name === "build" ? adapter.build(dir, files) : adapter.lint(dir, files);
}

/** The anti-gaming problem the implementer causes and fixes itself: triage retries it, never asks the owner. */
export const NOTHING_WRITTEN = "no production files were written";

/**
 * A pass may rightly change no code: the unit was re-opened with its merged code kept (recheck, parity, owner) and
 * that code is already right, or every symbol was proven dropped. Failing it for writing nothing would only burn
 * its attempts or push a pointless edit.
 */
function nothingToWrite(g: GateInput): boolean {
	const u = g.ledger.getUnit(g.unitId);
	if (u && (JSON.parse(u.meta) as { commit?: string }).commit) return true;
	const syms = g.ledger.symbolsOfUnit(g.unitId);
	return syms.length > 0 && syms.every((s) => s.state === "dropped");
}
