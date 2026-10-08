import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TargetAdapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import { resolveChoices } from "../init/stack.ts";
import type { Ledger } from "../ledger/db.ts";
import { goalsText } from "../policy.ts";
import { spawnLeaf } from "../sessions/spawn.ts";
import { docsLookup, readFunctionTool, sourceSymbolBody, targetLookup, whoCalls } from "../sessions/tools.ts";

/**
 * wired_ok, judged by a model with tools (no fixed pattern lists): is what the unit added real code (no stubs,
 * the legacy behaviour is there), connected (the framework reaches it, it uses the code already migrated) and on
 * the stack the owner chose? Code hands it the facts (diff, legacy files, migrated deps, choices); the reviewer
 * reads more with its tools and answers with one verdict. A session that ends without a verdict is "not judged":
 * a provider outage never burns the implementer's attempts.
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
	transcriptPath?: string;
	spawn?: typeof spawnLeaf;
}
export type Finding = { file: string; line?: number; problem: string; fix: string };
export type Reviewer = (o: ReviewInput) => Promise<{ ok: boolean; output: string; judged: boolean; costUsd?: number }>;

export const reviewWithModel: Reviewer = async (o) => {
	let verdict: { ok: boolean; findings: Finding[] } | undefined;
	const verdictTool = {
		name: "review_verdict",
		label: "Review verdict",
		description: "Your one verdict on the unit. ok = true only when nothing below is a problem. Each finding names the file (and line), the problem and the fix, so the implementer can act on it without asking.",
		promptSnippet: "review_verdict: your verdict (ok + findings)",
		parameters: Type.Object({ ok: Type.Boolean(), findings: Type.Array(Type.Object({ file: Type.String(), line: Type.Optional(Type.Number()), problem: Type.String(), fix: Type.String() })) }),
		execute: async (_id: string, p: { ok: boolean; findings: Finding[] }) => {
			verdict = p;
			return { content: [{ type: "text" as const, text: "verdict recorded; stop here" }], details: {} };
		},
	} as unknown as ToolDefinition;
	const deps = { ledger: o.ledger, config: o.config, unitId: o.unitId, root: o.root, targetProjectDir: o.targetProjectDir, adapter: o.adapter, moduleDir: o.moduleDir };
	const session = await (o.spawn ?? spawnLeaf)({
		role: "review",
		cwd: o.targetProjectDir,
		config: o.config,
		writeGlobs: [],
		customTools: [verdictTool, sourceSymbolBody(deps), readFunctionTool(deps), whoCalls(deps), targetLookup(deps), docsLookup(deps)],
		transcriptPath: o.transcriptPath,
		systemPrompt: `You review ONE unit of an automated migration (${o.config.source.stack} → ${o.config.target.stacks.join(" + ")}) before it is accepted. Build, lint and the layout checks already passed; the tests from the old behaviour run after you. You judge what tests and compilers cannot see:
1. Real: the unit's legacy behaviour is really ported. No stubs or placeholders (TODO, "not implemented", a fixed empty result where the legacy code computes something, an interface or port nothing implements, an endpoint that only answers "not implemented"). Compare with the legacy code (source_symbol_body, read_function).
2. Connected: the framework reaches the new code (an HTTP handler has its route/page/command registered the way this stack does it), and it uses the code already migrated (listed below) instead of rewriting or skipping it. Code that only later units will call is fine: do not fail a unit for work that belongs to units not migrated yet.
3. On the chosen stack: the owner's stack choices below are used where they apply (data access, rendering, data fetching, routing, forms, styling …), not gone around.
Judge only what this unit added or changed. Read the files and search the project with your tools before you decide; do not guess. Then call review_verdict once. Findings are concrete (file, line, problem, fix) and few: only what must change for the unit to be acceptable.${goalsText(o.config.goals) ? `\n\n${goalsText(o.config.goals)}` : ""}`,
	});
	try {
		const r = await session.run(facts(o));
		if (!verdict) return { ok: true, judged: false, costUsd: r.usage.cost, output: `not judged: the reviewer ended without a verdict${r.error ? ` (${r.error})` : ""}` };
		const v = verdict as { ok: boolean; findings: Finding[] };
		const ok = v.ok && !v.findings.length;
		return { ok, judged: true, costUsd: r.usage.cost, output: ok ? "reviewer: real, connected, on the chosen stack" : `reviewer findings:\n${v.findings.map((f) => `- ${f.file}${f.line ? `:${f.line}` : ""}: ${f.problem} → ${f.fix}`).join("\n")}` };
	} catch (e: any) {
		return { ok: true, judged: false, output: `not judged: ${e?.message ?? e}` };
	} finally {
		session.dispose();
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
	const choices = resolveChoices(o.adapter, o.config.target.choices).map((r) => `- ${r.choice.question}: ${r.option.label}${r.option.platform ? ` (${Object.values(r.option.platform).join("; ")})` : ""}`);
	return [
		`Unit ${o.unitId} (${unit?.kind ?? "?"}), area module ${o.moduleDir}/ in ${o.adapter.id}.`,
		`Legacy files: ${o.legacyFiles.join(", ") || "none"}`,
		`\nStack choices of the owner (${o.adapter.id}):\n${choices.join("\n") || "- none recorded"}`,
		`\nAlready migrated code this unit's legacy code calls:\n${deps.join("\n") || "- none"}`,
		`\nWhat the unit changed:\n${diff(o.targetProjectDir, o.changedFiles)}`,
	].join("\n");
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
