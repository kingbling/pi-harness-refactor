import { progress } from "../progress.ts";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import pc from "picocolors";
import type { Config } from "../config.ts";
import type { Ledger } from "../ledger/db.ts";
import type { ModelClient } from "../models/types.ts";
import { spawnLeaf } from "../sessions/spawn.ts";
import { docsLookup } from "../sessions/tools.ts";
import { projectDir } from "./init.ts";
import { libraryPlan, renderStackPlan } from "./stack.ts";
import { loadDecisions } from "../inventory/decisions.ts";
import { askViaModel, loadBrief, repoBrief } from "../jev/ask.ts";
import { composeRules, expandRuleLanguages, rulesDir, stripLayout, validateRulesLayout } from "../rules/layout.ts";
import { saveRulesVersion } from "../rules/living.ts";

/**
 * `br rules`: the FIRST version of each target stack's living rules (src/rules/living.ts curates later ones).
 * One setup session per stack (escalate model) reads the bootstrapped project, the fetched docs, the repo
 * brief and real legacy files, and writes the rule files every agent of that stack sees. Nothing about any
 * stack is written here: the layout comes from the adapter (rendered by code), the rest is the model's,
 * grounded in docs_lookup and the legacy code. Everything lives in .bigrefactor/rules/<stack>/, never in a repo.
 * Validation is code: files exist, idioms parse, layout agrees with the adapter.
 */
export function rulesPresent(root: string, config: Config): boolean {
	return config.target.stacks.every((s) => existsSync(join(rulesDir(root, s), "RULES.md")));
}

export async function generateRules(config: Config, root: string, ledger: Ledger, opts: { force?: boolean; relayout?: boolean; client?: ModelClient; log?: (s: string) => void } = {}): Promise<{ files: string[]; costUsd: number }> {
	const log = opts.log ?? ((s: string) => console.log(s));
	const { getTargetAdapter, getSourceAdapter } = await import("../adapters/registry.ts");
	const targets = await Promise.all(config.target.stacks.map((s) => getTargetAdapter(s)));
	let cost = 0;
	const files: string[] = [];

	if (opts.relayout && !opts.force) {
		// only re-render the layout section (adapter changed); bodies stay
		for (const t of targets) {
			const p = join(rulesDir(root, t.id), "RULES.md");
			if (existsSync(p)) await saveRulesVersion({ ledger, root }, t.id, stripLayout(readFileSync(p, "utf8")));
		}
	}
	if (!opts.force && rulesPresent(root, config)) {
		log(pc.dim("rules already present (use --force to regenerate)"));
		return { files: config.target.stacks.map((s) => join(rulesDir(root, s), "RULES.md")), costUsd: 0 };
	}

	const brief = await repoBrief({ ledger, config, root, client: opts.client });
	cost += brief.costUsd;
	const docsIndex = join(root, ".bigrefactor", "docs", "index.json");
	const docs = existsSync(docsIndex) ? (JSON.parse(readFileSync(docsIndex, "utf8")) as Array<{ tech: string; name: string }>) : [];
	const src = getSourceAdapter(config.source.stack);
	const decisions = loadDecisions(root);
	const { planFrameworks, renderFrameworkPlan } = await import("../inventory/frameworks.ts");
	src.frameworkDirs?.(config.source.path);
	const fwPlan = planFrameworks(ledger, src, targets, config.source.path, decisions, config.target.choices);
	const frameworkPlan = fwPlan.concerns.length ? renderFrameworkPlan(fwPlan).split("\n").filter((l) => !/^\s+top:/.test(l)).slice(0, 40).join("\n") : "(no legacy framework detected)";
	const repoDecisions = Object.entries(decisions.answers).filter(([id]) => id.startsWith("repo:")).map(([id, a]) => `- ${id}: ${a.answer}`);
	const samples = sampleLegacyFiles(ledger, 14);

	for (const adapter of targets) {
		const stackId = adapter.id;
		const target = projectDir(config, stackId);
		if (!existsSync(target)) throw new Error(`target project missing at ${target}; run br setup first`);
		const targetRel = relative(root, target) || ".";
		const dir = rulesDir(root, stackId);
		const dirRel = relative(root, dir);
		mkdirSync(join(dir, "astgrep"), { recursive: true });
		const stackPlan = renderStackPlan([adapter], config.target.choices, libraryPlan(src, config.source.path, decisions.libraries).libraries);
		const facts = (adapter.projectNotes?.(target) ?? []).map((n) => `- ${n}`);
		const stackDocs = [...new Set(docs.map((d) => `${d.tech}:${d.name}`))].join(", ");

		const attempt = ledger.startAttempt("__init__", "setup", config.models.escalate.id);
		const session = await spawnLeaf({
			role: "setup",
			cwd: root,
			config,
			writeGlobs: [`${dirRel}/**`],
			protectedGlobs: [`${targetRel}/**`],
			tools: [],
			customTools: [docsLookup({ ledger, config, unitId: "__init__", root, targetProjectDir: target, adapter })],
			systemPrompt: `You write the first version of the coding rules for the ${stackId} side of an automated migration from ${config.source.stack}${config.source.framework ? `/${config.source.framework}` : ""} to ${config.target.stacks.join(" + ")}. Dozens of agents follow them with tiny context: concrete, checkable, short. Ground every framework claim in docs_lookup (indexed: ${stackDocs}); do not invent APIs. Ground every legacy claim in the legacy files you read (legacy repo: ${config.source.path}, read-only). Stack decisions are binding. The module layout is generated by code and binding — do not write a layout section and never name another place for feature code. These rules will be extended by agents during the run, so write what is known now, not guesses. Do not modify anything inside ${targetRel}/.`,
			transcriptPath: join(root, ".bigrefactor", "sessions", `__init__.setup.${stackId}.${attempt}.jsonl`),
			onToolCall: (e) => e.blocked && log(pc.dim(`  setup blocked: ${e.blocked}`)),
		});
		const prompt = [
			`Repo brief (what the legacy app is):\n${brief.brief}`,
			`\nBinding layout for ${stackId} (generated; agents see it above your rules):\n${composeRules(adapter, "").trim()}`,
			`\nTarget project ${targetRel}/ (bootstrapped by the official generator):\n${listTree(target, 2)}`,
			facts.length ? `\nProject facts (override any decision; never name a package that is not installed):\n${facts.join("\n")}` : "",
			`\nRead the project's dependency manifest and config in ${targetRel}/ yourself before naming any package or command.`,
			`\nStack decisions (binding):\n${stackPlan}`,
			`\nLegacy framework mapping (binding; platform = use the named platform feature, port = carry the logic over, drop = do not recreate). Include the concerns that land on ${stackId}:\n${frameworkPlan}`,
			repoDecisions.length ? `\nOwner decisions about this repo (binding):\n${repoDecisions.join("\n")}` : "",
			`\nLegacy files to read before writing idioms (pick what is representative):\n${samples.map((s) => `- ${s}`).join("\n")}`,
			`\nWrite (paths relative to ${root}):`,
			`1. ${dirRel}/RULES.md — ≤ 120 lines, NO layout section. Choose the sections this stack needs (e.g. types and data shapes, data access, errors, wiring/DI, UI composition, state, tests, shared helpers, library replacements, legacy framework mapping, forbidden patterns with the ast-grep rule id enforcing each). A "Legacy framework mapping" section is required.`,
			`2. ${dirRel}/AGENTS.md — how to work in ${targetRel}/: commands from the manifest (build/lint/test), generated files that must never be hand-edited.`,
			`3. ${dirRel}/idioms.json — JSON array of ≥ 8 objects {"legacy": "<construct as it appears in the legacy files you read>", "target": "<idiom in ${stackId}>", "example": "<one-line snippet>", "rule": "<ast-grep rule id or null>"}; only constructs that actually occur in this repo and land on ${stackId}.`,
			`4. ${dirRel}/astgrep/<id>.yml — 3–6 ast-grep rules (id, language: ${adapter.layout.astGrepLanguages?.[0] ?? `the ast-grep language of ${adapter.layout.sourceExtensions.join("/")}`}; copies for other languages are made by code, rule, message, severity: error) enforcing the forbidden patterns, each with a sibling <id>-test.yml (valid/invalid snippets).`,
			`Finish with the line "RULES DONE".`,
		].join("\n");
		let res;
		try {
			res = await session.run(prompt);
		} finally {
			session.dispose();
		}
		progress.checkStopped();
		ledger.endAttempt(attempt, { outcome: res.error ? "error" : "done", costUsd: res.usage.cost, tokensIn: res.usage.input, tokensOut: res.usage.output });
		cost += res.usage.cost;
		log(pc.dim(`  setup ${stackId}: ${res.toolCalls} tool calls, ${res.blocked} blocked, $${res.usage.cost.toFixed(4)}${res.error ? pc.red(` ERROR: ${res.error}`) : ""}`));

		// the model wrote the body; code prepends the layout and saves it as version 1
		const rulesPath = join(dir, "RULES.md");
		if (existsSync(rulesPath)) await saveRulesVersion({ ledger, root }, stackId, readFileSync(rulesPath, "utf8"), { version: 1 });

		const problems: string[] = [];
		for (const f of ["RULES.md", "AGENTS.md", "idioms.json"]) if (!existsSync(join(dir, f))) problems.push(`missing ${dirRel}/${f}`);
		try {
			const idioms = JSON.parse(readFileSync(join(dir, "idioms.json"), "utf8"));
			if (!Array.isArray(idioms) || idioms.length < 8) problems.push(`idioms.json has ${Array.isArray(idioms) ? idioms.length : "no"} entries (need ≥ 8)`);
		} catch (e: any) {
			if (existsSync(join(dir, "idioms.json"))) problems.push(`idioms.json invalid: ${e?.message ?? e}`);
		}
		const copies = expandRuleLanguages(root, adapter);
		if (copies.length) log(pc.dim(`  ${stackId}: ${copies.length} ast-grep rule copies for ${adapter.layout.astGrepLanguages!.join("/")}`));
		const astRules = readdirSync(join(dir, "astgrep")).filter((f) => f.endsWith(".yml") && !f.endsWith("-test.yml"));
		if (astRules.length < 3) problems.push(`only ${astRules.length} ast-grep rules`);
		if (existsSync(rulesPath) && !/legacy framework mapping/i.test(readFileSync(rulesPath, "utf8"))) problems.push(`RULES.md has no "Legacy framework mapping" section`);
		if (problems.length) {
			log(pc.yellow(`rules ${stackId}: ${problems.join("; ")}`));
			const q = await askViaModel({ ledger, config, root, client: opts.client }, { point: "rules_review", facts: `Generating the ${stackId} rules finished with problems: ${problems.join("; ")}.`, options: [{ value: "regenerate", facts: "re-run br rules --force" }, { value: "fix-by-hand", facts: `edit ${dirRel}/ by hand` }], recommended: "regenerate", blocks: "none", askedBy: "init" });
			cost += q.costUsd;
		} else log(pc.green(`rules ${stackId} ok: ${dirRel}/ (${astRules.length} ast-grep rules)`));
		files.push(rulesPath);
	}
	const layoutProblems = await validateRulesLayout(root, config);
	if (layoutProblems.length) log(pc.yellow(`rules layout: ${layoutProblems.join("; ")}`));
	ledger.setMeta("rules_generated_at", new Date().toISOString());
	if (!loadBrief(root)) log(pc.dim("  (no repo brief: rules were written without a model's view of the repo)"));
	return { files, costUsd: cost };
}

/** A spread of legacy files across units of different kinds and directories, largest first per kind. */
function sampleLegacyFiles(ledger: Ledger, n: number): string[] {
	const rows = ledger.db.prepare("SELECT path, lang, loc FROM files WHERE dead_code = 0 ORDER BY loc DESC").all() as Array<{ path: string; lang: string; loc: number }>;
	const out: string[] = [];
	const seen = new Set<string>();
	for (const r of rows) {
		const key = `${r.lang}:${r.path.split("/").slice(0, 2).join("/")}:${r.path.replace(/^.*?((\.[a-z]+)+)$/i, "$1")}`;
		if (seen.has(key) || r.loc < 20) continue;
		seen.add(key);
		out.push(r.path);
		if (out.length >= n) break;
	}
	return out;
}

function listTree(dir: string, depth: number, prefix = ""): string {
	if (depth < 0 || !existsSync(dir)) return "";
	let out = "";
	for (const n of readdirSync(dir).filter((n) => !["node_modules", ".git", "dist"].includes(n)).sort()) {
		const p = join(dir, n);
		const isDir = statSync(p).isDirectory();
		out += `${prefix}${n}${isDir ? "/" : ""}\n`;
		if (isDir) out += listTree(p, depth - 1, prefix + "  ");
	}
	return out;
}
