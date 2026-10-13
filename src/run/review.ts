import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TargetAdapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import type { Ledger } from "../ledger/db.ts";
import { goalsText } from "../policy.ts";
import { getSourceAdapter } from "../adapters/registry.ts";
import { noBehaviour } from "./gate.ts";
import { spawnLeaf } from "../sessions/spawn.ts";
import { behaviourPolicy, choicesText } from "./prompts.ts";
import { quirksOf } from "./quirks.ts";
import { docsLookup, fileAliases, readFunctionTool, sourceSymbolBody, targetLookup, unitOfLegacy, unitState, whoCalls } from "../sessions/tools.ts";
import { unitFacts } from "../sessions/taskcard.ts";

/**
 * wired_ok, judged by a model with tools (no fixed pattern lists): is what the unit added real code (no stubs,
 * the legacy behaviour is there), connected (the framework reaches it, it uses the code already migrated) and on
 * the stack the owner chose? Code hands it the facts (diff, legacy files, migrated deps, choices); the reviewer
 * reads more with its tools and answers with one verdict. A session that ends without a verdict is asked once more;
 * still none is red ("not judged"): a unit is never accepted with nothing proven.
 */
export interface ReviewInput {
	ledger: Ledger;
	config: Config;
	root: string;
	unitId: string;
	adapter: TargetAdapter;
	targetProjectDir: string;
	moduleDir: string;
	/** The unit's legacy files (relative to the legacy repo). */
	legacyFiles: string[];
	changedFiles: string[];
	/** Classes whose names only look like an existing one (the gate's reuse check): the reviewer judges "same record?". */
	nearDuplicates?: string[];
	/** br recheck: judge changedFiles as they are now (later units, tidy and repairs change accepted code). */
	recheck?: boolean;
	/** br recheck: the unit's original commit, context only. */
	commit?: string;
	/** Where the implementer may write: a fix outside these is never a finding for it (it goes to outOfScope). */
	writeGlobs?: string[];
	/** The owner's / orchestrator's note for this run of the unit (e.g. the answer to an earlier out-of-scope question). */
	ownerNote?: string;
	/** The ported tests already passed before the implementer wrote any code (and still did after one retest). */
	greenBefore?: string;
	/** The ported tests (the tester's): weak ones go back to the tester, not the implementer. */
	testFiles?: string[];
	/** The unit's code findings still open from its earlier reviews (kept in unit meta across attempts and runs). */
	openFindings?: string[];
	/** The implementer's final message of its last session (its claims, to check against the code). */
	implementerNote?: string;
	/** Open findings the implementer disputes (dispute_finding): the reviewer keeps each with a reason or drops it. */
	findingDisputes?: Array<{ finding: string; why: string; evidence: string }>;
	/** The tester's answer after re-checking tests the reviewer called weak: the ones it kept, with its reasons. */
	testerKept?: string;
	transcriptPath?: string;
	spawn?: typeof spawnLeaf;
}
export type Finding = { file: string; line?: number; problem: string; fix: string };
/** findings: every code finding still open after this review, one line each (the unit keeps them for the next round). */
export type Reviewer = (o: ReviewInput) => Promise<{ ok: boolean; output: string; judged: boolean; costUsd?: number; weakTests?: string; outOfScope?: string; findings?: string[] }>;
type Verdict = { ok: boolean; findings: Finding[]; fixed?: string[]; weakTests?: Array<{ file: string; problem: string }>; outOfScope?: Array<{ problem: string; fix: string }>; disputeAnswers?: Array<{ finding: string; kept: boolean; reason: string }> };

export const reviewWithModel: Reviewer = async (o) => {
	let verdict: Verdict | undefined;
	// a verdict that leaves a disputed finding unanswered is sent back once
	let askedAnswers = false;
	const verdictTool = {
		name: "review_verdict",
		label: "Review verdict",
		description: "Your one verdict on the unit. ok = true only when nothing below is a problem. Each finding names the file (and line), the problem and the fix, so the implementer can act on it without asking. findings lists ALL open problems, earlier ones still open included. fixed: your earlier findings that the code fixes now. weakTests: ported tests that do not really check the legacy behaviour; they go to the tester. outOfScope: what must change outside the files the implementer may write (project setup, config, manifests, folder names, the migration tool); they go to the setup fixer or the owner, never to the implementer. disputeAnswers: one per finding the implementer disputes — kept (still in findings) with the reason the dispute is wrong, or dropped with the reason it is right.",
		promptSnippet: "review_verdict: your verdict (ok + findings for the code, weakTests for the tester, outOfScope for setup/config)",
		parameters: Type.Object({ ok: Type.Boolean(), findings: Type.Array(Type.Object({ file: Type.String(), line: Type.Optional(Type.Number()), problem: Type.String(), fix: Type.String() })), fixed: Type.Optional(Type.Array(Type.String())), weakTests: Type.Optional(Type.Array(Type.Object({ file: Type.String(), problem: Type.String() }))), outOfScope: Type.Optional(Type.Array(Type.Object({ problem: Type.String(), fix: Type.String() }))), disputeAnswers: Type.Optional(Type.Array(Type.Object({ finding: Type.String(), kept: Type.Boolean(), reason: Type.String() }))) }),
		execute: async (_id: string, p: Verdict) => {
			const disputed = o.findingDisputes?.length ?? 0;
			if (disputed > (p.disputeAnswers?.length ?? 0) && !askedAnswers) {
				askedAnswers = true;
				return { content: [{ type: "text" as const, text: `not recorded: the implementer disputes ${disputed} finding(s); answer each in disputeAnswers (kept with the reason the dispute is wrong, or dropped) and call review_verdict again` }], details: { error: true } };
			}
			verdict = p;
			return { content: [{ type: "text" as const, text: "verdict recorded; stop here" }], details: {} };
		},
	} as unknown as ToolDefinition;
	const deps = { ledger: o.ledger, config: o.config, unitId: o.unitId, root: o.root, targetProjectDir: o.targetProjectDir, adapter: o.adapter, moduleDir: o.moduleDir };
	// a spawn that throws (the model is down) is "not judged" too, never a crash of the unit
	let session: Awaited<ReturnType<typeof spawnLeaf>> | undefined;
	try {
		session = await (o.spawn ?? spawnLeaf)({
			role: "review",
			cwd: o.targetProjectDir,
			config: o.config,
			writeGlobs: [],
			customTools: [verdictTool, sourceSymbolBody(deps), readFunctionTool(deps), whoCalls(deps), targetLookup(deps), docsLookup(deps)],
			transcriptPath: o.transcriptPath,
			systemPrompt: `You review ONE unit of an automated migration (${o.config.source.stack} → ${o.config.target.stacks.join(" + ")}) before it is accepted. Build, lint and the layout checks already passed; the tests from the old behaviour run after you. You judge what tests and compilers cannot see:
1. Real: the unit's legacy behaviour is really ported. No stubs or placeholders (TODO, "not implemented", a fixed empty result where the legacy code computes something, code that special-cases the truth inputs or returns their expected values as literals instead of computing them, an interface or port nothing implements, an endpoint that only answers "not implemented"). Compare with the legacy code (source_symbol_body, read_function). Comments, names and TODO notes in the new code are the implementer's claims, not facts: a comment saying why the new code does less or differs from the legacy code never makes it fine. Check it against the legacy code; a difference the legacy code does not support is a finding.
2. Connected: the new code can be reached the way the legacy callers (listed below) reached the old code — an HTTP handler or page has its route registered the way this stack does it once the legacy caller that reached it (e.g. the controller that renders the page) is migrated: while that caller's unit is not accepted and is on this same stack (its state and stack are listed below), an unregistered page or handler, or a typed seam marked TODO(br:<that unit>), is fine and not a finding; a caller's unit on another stack can never write this stack's wiring files, so then the page or handler is registered here by this unit (only its data access may wait behind TODO(br:<that unit>)), and a missing registration is a finding; code the legacy callers reached through a factory or another class is reached that way, not turned into an entry point nobody calls — and it uses the code already migrated (listed below) instead of rewriting or skipping it. Code that only later units will call is fine: do not fail a unit for work that belongs to units not migrated yet. Code owned by planned units (listed below) is expected as a minimal stub marked TODO(br:<the owning unit>): that is not a finding. A stub marked TODO(br:${o.unitId}) (grep for it) that stands in for this unit's own legacy code was left by an earlier unit for this one: one still there, not replaced by the real code or pointed at it, is a finding.
3. On the chosen stack: the owner's stack choices below are used where they apply (data access, rendering, data fetching, routing, forms, styling …), not gone around.
4. The tests: the ported tests (listed below) really check the legacy behaviour — they assert the expected values, not only that something renders or exists. Weak tests go in weakTests (the tester rewrites them), never in findings.
Judge only what this unit added or changed, against the facts below: the behaviour policy and the decided quirks are settled (never ask to undo a decided quirk, never ask to widen the target's types back to the legacy inputs). Read the files and search the project with your tools before you decide; do not guess. Then call review_verdict once. Findings are concrete (file, line, problem, fix) and complete: list ALL open problems in this one verdict, not a few at a time (the implementer fixes them in one go), but only what must change for the unit to be acceptable, and only inside the files the implementer may write. A fix anywhere else (project setup, config, manifests, autoloading, folder names, a missing package, the migration tool itself) goes in outOfScope, never in findings. The implementer has no shell: it writes source files by hand and cannot run scripts or copy files. A data or asset file it cannot write by hand (binary such as a certificate, made by running a tool or converter, copied from the legacy repo, or very large) goes in outOfScope too, naming where the file comes from; check that source exists in the legacy repo first, and if it does not, it is no finding at all.${goalsText(o.config.goals) ? `\n\n${goalsText(o.config.goals)}` : ""}`,
		});
		const r = await session.run(facts(o));
		// no verdict: ask once more in the same session; still none is red, never a pass
		if (!verdict) {
			const again = await session.run("You ended without a verdict. Call review_verdict now, once.");
			r.usage.cost += again.usage.cost;
			r.error = again.error ?? r.error;
		}
		if (!verdict) return { ok: false, judged: false, costUsd: r.usage.cost, output: `not judged: the reviewer ended without a verdict${r.error ? ` (${r.error})` : ""}` };
		const v = verdict as Verdict;
		const weakTests = v.weakTests?.length ? v.weakTests.map((t) => `- ${t.file}: ${t.problem}`).join("\n") : undefined;
		const outOfScope = v.outOfScope?.length ? v.outOfScope.map((f) => `- ${f.problem} → ${f.fix}`).join("\n") : undefined;
		const ok = v.ok && !v.findings.length && !weakTests && !outOfScope;
		const findings = v.findings.map((f) => `- ${f.file}${f.line ? `:${f.line}` : ""}: ${f.problem} → ${f.fix}`);
		const out = [
			findings.length ? `reviewer findings:\n${findings.join("\n")}` : "",
			v.fixed?.length ? `fixed since the earlier review:\n${v.fixed.map((f) => `- ${f}`).join("\n")}` : "",
			weakTests ? `weak tests (the tester rewrites them):\n${weakTests}` : "",
			outOfScope ? `outside the unit's files (setup fixer, else the owner):\n${outOfScope}` : "",
			v.disputeAnswers?.length ? `answers to the implementer's disputes:\n${v.disputeAnswers.map((a) => `- ${a.finding}: ${a.kept ? "kept" : "dropped"} — ${a.reason}`).join("\n")}` : "",
		].filter(Boolean).join("\n");
		return { ok, judged: true, costUsd: r.usage.cost, weakTests, outOfScope, findings, output: ok ? "reviewer: real, connected, on the chosen stack" : out };
	} catch (e: any) {
		return { ok: false, judged: false, output: `not judged: ${e?.message ?? e}` };
	} finally {
		session?.dispose();
	}
};

/** What code knows for sure, handed to the reviewer: the diff, the legacy files, the migrated deps, the stack choices. */
function facts(o: ReviewInput): string {
	const unit = o.ledger.getUnit(o.unitId);
	const deps = (JSON.parse(unit?.deps ?? "[]") as string[])
		.filter((d) => o.ledger.getUnit(d)?.state === "accepted")
		.map((d) => {
			const targets = (o.ledger.db.prepare("SELECT target_symbols FROM moves WHERE unit_id = ? AND op != 'dropped'").all(d) as Array<{ target_symbols: string }>).flatMap((r) => JSON.parse(r.target_symbols) as string[]);
			return targets.length ? `- ${d}: ${[...new Set(targets)].slice(0, 8).join(", ")}` : "";
		})
		.filter(Boolean);
	const choices = choicesText(o.adapter, o.config.target.choices);
	const none = noBehaviour(o.ledger, o.unitId);
	return [
		`Unit ${o.unitId}${unit ? ` (${unitFacts(o.ledger, unit, o.config.source.path).join("; ") || "no facts"})` : ""}, area module ${o.moduleDir}/ in ${o.adapter.id}.`,
		`Legacy files: ${o.legacyFiles.join(", ") || "none"}`,
		`Ported tests (the tester's): ${o.testFiles?.join(", ") || "none"}`,
		...(o.writeGlobs?.length ? [`The implementer may write only: ${o.writeGlobs.join(", ")}. A fix anywhere else is an outOfScope item, not a finding.`] : []),
		...(o.greenBefore ? [o.greenBefore] : []),
		...(o.openFindings?.length ? [`\nYour earlier reviews of this unit found these, still open as far as the ledger knows. Check each against the code now: a fixed one goes in fixed, one still open goes in findings again (with any new ones), so findings is the whole open list. Raise a new one only when it is a real blocker, not a change of mind:\n${o.openFindings.join("\n")}`] : []),
		...(o.findingDisputes?.length ? [`\nThe implementer disputes these findings. Check each against the legacy code and the code now, then answer each in disputeAnswers: kept (it stays in findings) with the reason the dispute is wrong, or dropped (it leaves findings) with the reason it is right:\n${o.findingDisputes.map((d) => `- ${d.finding}: ${d.why}\n  evidence: ${d.evidence}`).join("\n")}`] : []),
		...(o.implementerNote ? [`\nThe implementer's final message (its claims, not facts: check them against the code):\n${o.implementerNote}`] : []),
		...(o.testerKept ? [`\nThe tester re-checked the tests you called weak against the legacy code and kept these, with its reasons. Call a kept test weak again only when its reason is wrong, and say why:\n${o.testerKept}`] : []),
		...(o.ownerNote ? [`Note from the orchestrator for this run (only an answer by the owner, a person, counts as decided; a model's hint is context to check against the legacy code): ${o.ownerNote}`] : []),
		...legacyFacts(o),
		...(none ? [`The tester found no runtime behaviour to pin in this unit, so it has no truth cases and no ported tests. Its reason: ${none}. Check that against the legacy code: if the unit does compute or decide something, name it in weakTests (the tester then writes cases for it).`] : []),
		`\nStack choices of the owner (${o.adapter.id}):\n${choices.join("\n") || "- none recorded"}`,
		`\nAlready migrated code this unit's legacy code calls:\n${deps.join("\n") || "- none"}`,
		...(o.nearDuplicates?.length ? [`\nLook-alike class names the reuse check found (a guess from the names, not proof). For each, read both classes: when they are the same record or class, it is a finding (reuse the existing one); when they hold different things, it is fine:\n${o.nearDuplicates.map((n) => `- ${n}`).join("\n")}`] : []),
		o.recheck
			? `\nThis unit was accepted earlier; later units, tidy and repairs may have changed its code since. Judge its files as they are now:\n${current(o.targetProjectDir, o.changedFiles)}${o.commit ? `\n\nIts original commit (context only, may be outdated): ${summary(o.config.target.path, o.commit)}` : ""}`
			: `\nWhat the unit changed:\n${diff(o.targetProjectDir, o.changedFiles)}`,
	].join("\n");
}

const CAP = 15;
const capped = (rows: string[], what: string) => (rows.length > CAP ? [...rows.slice(0, CAP), `- (${rows.length - CAP} more ${what}; ask your tools)`] : rows);

/**
 * What the ledger knows about the unit's legacy side, for judging against it: the behaviour policy, the decided
 * quirks, the truth cases, the code owned by planned units, the legacy callers, the legacy packages. Capped.
 */
export function legacyFacts(o: Pick<ReviewInput, "ledger" | "config" | "unitId" | "legacyFiles" | "adapter" | "targetProjectDir">): string[] {
	const db = o.ledger.db;
	const out: string[] = [];
	try {
		out.push(`\n${behaviourPolicy(getSourceAdapter(o.config.source.stack), "the tester (already done)")}`);
	} catch {
		/* unknown source adapter: no policy text */
	}
	const quirks = quirksOf({ ledger: o.ledger }, o.unitId).map((q) => `- ${q.symbol_id}: ${q.behaviour} → ${q.status === "kept" ? "kept" : q.status === "dropped" ? "dropped" : `not decided yet (tests follow "${q.applied ?? q.opinion}")`} (${q.kind}${q.decided_by ? `, decided by ${q.decided_by}` : ""}; ${q.why})`);
	if (quirks.length) out.push(`\nDecided quirks of this unit (settled: the code follows them, do not ask to undo them):\n${capped(quirks, "quirks").join("\n")}`);
	const cases = db.prepare("SELECT symbol_id, COUNT(*) n, SUM(verified_on_old) run FROM truth_cases WHERE unit_id = ? GROUP BY symbol_id ORDER BY symbol_id").all(o.unitId) as Array<{ symbol_id: string; n: number; run: number }>;
	if (cases.length) out.push(`\nTruth cases (expected values from the old code; the ported tests check them):\n${capped(cases.map((c) => `- ${c.symbol_id}: ${c.n} case(s)${c.run < c.n ? `, ${c.n - c.run} read not run` : ""}`), "symbols").join("\n")}`);
	const planned = db
		.prepare(`SELECT DISTINCT t.id, t.unit_id, t.path, u.state FROM (
			SELECT d.to_id FROM index_deps d JOIN symbols s ON s.id = d.from_id WHERE s.unit_id = ?
			UNION SELECT c.to_id FROM code_calls c JOIN symbols s ON s.id = c.from_id WHERE s.unit_id = ? AND c.to_id IS NOT NULL AND c.resolution = 'code'
		) e JOIN symbols t ON t.id = e.to_id JOIN units u ON u.id = t.unit_id WHERE t.unit_id != ? AND u.state != 'accepted' ORDER BY t.unit_id, t.id`)
		.all(o.unitId, o.unitId, o.unitId) as Array<{ id: string; unit_id: string; path: string; state: string }>;
	if (planned.length) out.push(`\nLegacy code this unit calls that other units still own (not migrated yet): a minimal stub marked TODO(br:<the owning unit>) for these is expected, not a finding; porting them here is wrong:\n${capped(planned.map((p) => `- ${p.id} (unit ${p.unit_id}, ${p.state}, ${p.path})`), "callees").join("\n")}`);
	const own = new Set(o.legacyFiles);
	const outside = (id: string) => !own.has(id.split("::")[0]!);
	const callers = (
		db
			.prepare(`SELECT DISTINCT e.from_id, e.how, f.unit_id FROM (
				SELECT c.from_id, c.kind || ' call' AS how FROM code_calls c JOIN symbols s ON s.id = c.to_id WHERE s.unit_id = ? AND c.resolution = 'code'
				UNION SELECT d.from_id, d.kind AS how FROM index_deps d JOIN symbols s ON s.id = d.to_id WHERE s.unit_id = ?
			) e LEFT JOIN symbols f ON f.id = e.from_id ORDER BY e.from_id`)
			.all(o.unitId, o.unitId) as Array<{ from_id: string; how: string; unit_id: string | null }>
	).filter((c) => c.unit_id !== o.unitId && outside(c.from_id));
	// names the code is reached by: its classes/functions, plus the names the framework knows a file by (a template's view name)
	const names = [...new Set([...(db.prepare("SELECT DISTINCT name FROM symbols WHERE unit_id = ? AND kind IN ('class','function')").all(o.unitId) as Array<{ name: string }>).map((r) => r.name), ...o.legacyFiles.flatMap((f) => fileAliases(o.config, f))])];
	const literal = names.length ? (db.prepare(`SELECT DISTINCT name, path FROM index_literal_refs WHERE name IN (${names.map(() => "?").join(",")}) ORDER BY path`).all(...names) as Array<{ name: string; path: string }>).filter((l) => !own.has(l.path)) : [];
	if (callers.length || literal.length)
		out.push(
			`\nLegacy callers of this unit's code (who_calls for more). Can the new code be reached the way these callers reached the old code? A caller whose unit is not accepted yet and is on ${o.adapter.id} too is not migrated: the new code need not be reached from it yet (an unregistered page or handler, or a seam marked TODO(br:<that unit>), is fine); that unit wires it. A caller's unit on another stack can never write ${o.adapter.id}'s wiring files: registering the page or handler here (route, menu entry) is this unit's own job, with only its data access behind a seam marked TODO(br:<that unit>) while that unit is not accepted.\n${capped(
				[...callers.map((c) => `- ${c.from_id} (${c.how}${unitState(o.ledger, c.unit_id ?? unitOfLegacy(o.ledger, c.from_id))})`), ...literal.map((l) => `- ${l.path} names "${l.name}" in a string (maybe a factory, dynamic call or rendered view${unitState(o.ledger, unitOfLegacy(o.ledger, l.path))})`)],
				"callers",
			).join("\n")}`,
		);
	else out.push(`\nLegacy callers of this unit's code: none in the index (who_calls to check; an entry point is reached by the framework).`);
	const plan = o.ledger.getMeta("framework_plan");
	const libs = plan ? ((JSON.parse(plan) as { libraries?: Array<{ name: string; verdict: string; successor?: string; dev?: boolean }> }).libraries ?? []).filter((l) => !l.dev) : [];
	if (libs.length) {
		let have: string[] = [];
		try {
			have = o.adapter.toolchain.installedPackages(o.targetProjectDir);
		} catch {
			/* no manifest readable: the reviewer reads it with its tools */
		}
		out.push(
			`\nThird-party packages of the legacy project (decision per package). When the unit's legacy code extends or uses a class from one, check the target has it or its successor; a missing package is an outOfScope item:\n${capped(libs.map((l) => `- ${l.name}: ${l.verdict}${l.successor ? ` → ${l.successor}` : ""}`), "packages").join("\n")}`,
			`Packages the target declares (${o.adapter.toolchain.manifestFiles.join(", ") || "its manifest"}): ${have.length ? `${have.slice(0, 40).join(", ")}${have.length > 40 ? ` (+${have.length - 40} more)` : ""}` : "none found; read the manifest"}`,
		);
	}
	return out;
}

/** The unit's files as they are now; capped like diff(). */
function current(dir: string, files: string[]): string {
	const all = files
		.filter((f) => existsSync(join(dir, f)))
		.map((f) => `--- ${f}\n${readFileSync(join(dir, f), "utf8")}`)
		.join("\n");
	return all.length > 60_000 ? `${all.slice(0, 60_000)}\n[… cut: read the rest with your tools]` : all || "(nothing)";
}

/** A commit's subject and the files it touched (cheap context, no diff). */
function summary(repo: string, sha: string): string {
	try {
		return execFileSync("git", ["show", "--stat", "--format=%h %s", sha], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	} catch {
		return `${sha} (not found)`;
	}
}

/** The unit's changes: git diff for files git knows, the whole file for new ones; capped. */
function diff(dir: string, files: string[]): string {
	const out: string[] = [];
	let tracked = "";
	try {
		tracked = execFileSync("git", ["diff", "HEAD", "--", ...files], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
	} catch {
		/* not a repo, or no HEAD yet */
	}
	if (tracked.trim()) out.push(tracked);
	for (const f of files) {
		if (tracked.includes(`b/${f}\n`) || !existsSync(join(dir, f))) continue;
		out.push(`--- new file ${f}\n${readFileSync(join(dir, f), "utf8")}`);
	}
	const all = out.join("\n");
	return all.length > 60_000 ? `${all.slice(0, 60_000)}\n[… cut: read the rest with your tools]` : all || "(nothing)";
}
