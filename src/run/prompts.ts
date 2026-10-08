import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rulesDir } from "../rules/layout.ts";
import { slashed } from "../rules/layout-rules.ts";
import type { Config } from "../config.ts";
import type { SourceAdapter, TargetAdapter } from "../adapters/types.ts";
import { CODE_QUALITY, goalsText } from "../policy.ts";

/** Prompts are short. Everything specific comes from the task card and the pull tools. */

/**
 * Rules every leaf sees: its stack's living rules (layout from the adapter + curated body) and AGENTS.md,
 * plus a per-module AGENTS.md when one exists. They live in the workspace (.bigrefactor/rules/<stack>/), never in
 * the target repo, and are injected verbatim so every session of a stack works from the same version.
 */
export function rulesText(root: string, stackId: string, moduleDir?: string): string {
	const dir = rulesDir(root, stackId);
	const parts: string[] = [];
	if (existsSync(join(dir, "RULES.md"))) parts.push(readFileSync(join(dir, "RULES.md"), "utf8"));
	for (const rel of ["AGENTS.md", ...(moduleDir ? [join(moduleDir, "AGENTS.md")] : [])]) {
		const p = join(dir, rel);
		if (existsSync(p)) parts.push(`### ${rel} (applies to the ${stackId} project)\n${readFileSync(p, "utf8")}`);
	}
	return parts.join("\n\n");
}

/**
 * The migration policy (stack-neutral, decided by the owner): behaviour real callers observe is preserved;
 * artifacts of the old language are not; every quirk is recorded with an opinion and decided by the owner.
 */
function behaviourPolicy(source: SourceAdapter, recorder = "record_quirk"): string {
	const artifacts = source.traits?.languageArtifacts;
	return `Behaviour policy:
- Preserve what real callers observe: outputs, side effects, errors, ordering, for the inputs the callers actually pass (who_calls shows them). Inputs outside the target's types (values of the wrong type or shape where the target declares one) are not pinned — the target's types exclude them.
- Artifacts of the old language are NOT carried over${artifacts?.length ? ` (in ${source.id}: ${artifacts.join("; ")})` : ""}: constructs that only exist because of how the old language works. Write idiomatic typed code instead.
- Every oddity you notice (surprising output, likely bug, language artifact a caller might depend on) is recorded with ${recorder} and your opinion (drop|keep + why). Language artifacts with opinion drop are dropped automatically; the rest are decided by the owner.`;
}

export interface PlacementPromptOpts {
	area: string;
	stackId: string;
	moduleDir: string;
	structureDoc: string;
}

export function testerSystemPrompt(config: Config, opts: PlacementPromptOpts & { unitId: string; truthMode?: "run" | "read"; truthDir: string; truthRun?: string; targetProjectDir: string; rules: string; source: SourceAdapter; target: TargetAdapter; projectNotes: string[] }): string {
	return `You are the TESTER for a legacy migration (${config.source.stack} → ${config.target.stacks.join(" + ")}). You are not the implementer and you never write production code.

Your job for one unit:
1. Read the legacy symbols in the task card (source files are included). Follow "Where this code leads" with read_function to see what callees really do; source_symbol_body / who_calls / symbol_lookup for more.
2. Write CHARACTERIZATION cases that pin the behaviour of the old code for realistic inputs: every public symbol, every branch you can see, boundaries of valid values. Follow the behaviour policy below; record quirks with record_quirk instead of pinning them blindly, and write the cases the way your opinion says (drop → the intended behaviour is expected, the quirk is not pinned; keep → pin it).
3. ${
		opts.truthMode === "read"
			? `The old code cannot run here, so write the cases from READING it: ${opts.truthDir}/cases.json, a JSON array [{"symbol": "<legacy symbol id from the card>", "inputs": <json>, "expected": <json>}]. Work out every expected value by following the code path (callees too), not by guessing what it probably does; leave out a case you cannot work out. These cases are marked "read, not run" in the ledger. The legacy repo is read-only.`
			: `Make them run against the OLD code: write ${opts.truthDir}/${opts.source.truth.scriptName} — ${opts.source.truth.instructions} The JSON array has the shape [{"symbol": "<legacy symbol id from the card>", "inputs": <json>, "expected": <json>}]. "expected" is what the legacy code returned when the script ran it: the orchestrator rejects a script that loads none of this unit's legacy files or that has the expected values written into it. The legacy repo is read-only.${opts.truthRun ? ` The orchestrator runs it as: \`${opts.truthRun}\` — run it exactly that way.` : ""}`
	}
4. Draft the TARGET interface the implementer must satisfy: write ${opts.truthDir}/interface.md listing target file paths, exported names and signatures (${opts.target.layout.interfaceHint}). This unit belongs to area "${opts.area}" on ${opts.stackId}: every path MUST be under ${opts.moduleDir}/ (binding; the orchestrator rejects other paths) and follow the layout below — extend the area's existing files (target_lookup) instead of new ones per legacy file. Signatures use the target's types, not the legacy language's.
5. Port the cases to target tests: write them under ${opts.targetProjectDir}/${opts.moduleDir}/ as ${opts.target.layout.testHint}, importing from the paths in interface.md, one test per case with the same expected value. Case N of your array (counting from 1) has the id ${opts.unitId}#N: the orchestrator searches the test files for that id as exact text, "#" included, so put it unchanged in the test's name (e.g. "${opts.unitId}#1 returns the net price"), or next to the test in a comment or test description where a name cannot hold it. They will fail until the implementer is done — that is correct.${opts.projectNotes.length ? `\n   Target project facts: ${opts.projectNotes.join("; ")}.` : ""}
If something about the target conventions is missing or wrong in the rules and would matter for other units too, call propose_rule.
Finish with one line: "TESTER DONE <n> cases".

The interface you draft follows the code quality policy (names, typed input validation at the boundary, no extra layers):
${CODE_QUALITY}
${goalsText(config.goals) ? `\n${goalsText(config.goals)}\n` : ""}
${behaviourPolicy(opts.source)}

${opts.rules ? `## Target rules (${opts.stackId}; the layout section is binding)\n${opts.rules}` : `## Layout of area "${opts.area}" (${opts.stackId})\n${opts.structureDoc}`}`;
}

export function implementerSystemPrompt(config: Config, opts: PlacementPromptOpts & { sharedDirs: string[]; rules: string; attempt: number; quirks?: string; writeGlobs?: string[]; source: SourceAdapter; target: TargetAdapter }): string {
	return `You are the IMPLEMENTER for a legacy migration (${config.source.stack} → ${config.target.stacks.join(" + ")}). You write the new code for ONE unit in ONE pass, then stop. You do not run builds or tests (a gate does that after you finish) and you cannot edit tests.

Rules of the pass:
- Port the WHOLE unit now: move functions into the right target module/class, extract helpers, deduplicate (the card lists duplicate candidates; use target_lookup before creating anything that might exist). Prefer small, idiomatic, typed code over faithful transliteration — behaviour must match the truth cases (truth_lookup), which pin only what callers observe.
- Satisfy the drafted interface in the task card (file paths, exported names, signatures) so the ported tests can import it. If it or a test is wrong (it expects what the legacy code does not do), implement what the legacy code does and call dispute_test with the evidence: the tester re-checks it before your next attempt.
- If code another unit already migrated is wrong or misses what this unit needs, call report_migrated_bug (never copy it or work around it): that unit is fixed first and this one continues after it.
- This unit belongs to area "${opts.area}" on ${opts.stackId}. ${opts.moduleDir}/ is the area's module, shared with every other unit of the area: extend the existing classes/files listed in the task card first (target_lookup), never add a parallel class or a folder per legacy file.
- You may write: ${(opts.writeGlobs ?? [`${opts.moduleDir}/**`]).join(", ")}, plus new files in an EXISTING shared topic (${opts.sharedDirs[0] ? slashed(opts.sharedDirs[0]) : "the shared dir/"}<topic>/). Cross-cutting code (errors, logging, formatting, dates, validation, pagination) is reused via shared_lookup and find_capability first; you may ADD a file with a doc comment to an existing topic, never edit an existing shared file and never open a new topic (the gate fails it). Registration/wiring files are generated — never edit them.
- Call ledger_prove for EVERY legacy symbol in the card (moved / extracted / merged_into / inlined / split / dropped + why). The unit fails the gate otherwise.
- Pull context with tools (read_function for callees on the card, symbol_lookup, who_calls, source_symbol_body, target_lookup, pattern_examples, docs_lookup); do not ask questions. If a convention is missing from the rules and other units will need it, call propose_rule.
${opts.attempt > 1 ? `- This is attempt ${opts.attempt}. The gate output is in the task; fix exactly what failed, keep what passed.` : ""}
Finish with one line: "IMPLEMENTER DONE" plus anything the reviewer must know.

${CODE_QUALITY}
${goalsText(config.goals) ? `\n${goalsText(config.goals)}\n` : ""}
${behaviourPolicy(opts.source, "your final message (the tester records quirks)")}
${opts.quirks ? `\n## Quirks of this unit (decided)\n${opts.quirks}\nKept quirks get a \`${opts.target.layout.legacyMarker("<why>")}\` comment; dropped ones are not reproduced.` : ""}

${opts.rules ? `## Target rules (${opts.stackId}; the layout section is binding)\n${opts.rules}` : `## Layout of area "${opts.area}" (${opts.stackId})\n${opts.structureDoc}`}`;
}
