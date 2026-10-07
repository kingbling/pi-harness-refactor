import { progress } from "../progress.ts";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import pc from "picocolors";
import type { Config } from "../config.ts";
import type { Ledger } from "../ledger/db.ts";
import { spawnLeaf } from "../sessions/spawn.ts";
import { docsLookup } from "../sessions/tools.ts";
import { projectDir } from "./init.ts";
import { libraryPlan, renderStackPlan } from "./stack.ts";
import { loadDecisions } from "../inventory/decisions.ts";

/**
 * `br rules`: one setup session (escalate model) reads the bootstrapped target project (official
 * layout + toolchain) and the fetched docs, then writes the rule files every agent sees. ALL of it lives
 * in the bigrefactor workspace, never in the target repo (migration artifacts in the repo make a mess and
 * drift between agents; here every session is injected with the same files):
 *   .bigrefactor/rules/RULES.md          global rules, injected into every leaf system prompt
 *   .bigrefactor/rules/AGENTS.md         how to work in the target repo (commands, layout, generated files)
 *   .bigrefactor/rules/src/AGENTS.md     per-directory patterns, mirroring the target tree (more per module later)
 *   .bigrefactor/idioms.json             legacy construct → target idiom table
 *   .bigrefactor/rules/astgrep/*.yml     ast-grep rules with valid/invalid examples (gate runs them when ast-grep is present)
 * Validation is code: files exist, idioms parse, every target stack is covered. Nothing here edits source code.
 */
export async function generateRules(config: Config, root: string, ledger: Ledger, opts: { force?: boolean; log?: (s: string) => void } = {}): Promise<{ files: string[]; costUsd: number }> {
	const log = opts.log ?? ((s: string) => console.log(s));
	const stackId = config.target.stacks[0]!;
	const target = projectDir(config, stackId);
	if (!existsSync(join(target, "package.json"))) throw new Error(`target project missing at ${target}; run br setup first`);
	const targetRel = relative(root, target) || ".";
	const rulesDir = join(root, ".bigrefactor", "rules");
	const astDir = join(rulesDir, "astgrep");
	mkdirSync(astDir, { recursive: true });
	const expected = [join(rulesDir, "RULES.md"), join(rulesDir, "AGENTS.md"), join(rulesDir, "src", "AGENTS.md"), join(root, ".bigrefactor", "idioms.json")];
	if (!opts.force && expected.every((p) => existsSync(p))) {
		log(pc.dim("rules already present (use --force to regenerate)"));
		return { files: expected, costUsd: 0 };
	}

	const docsIndex = join(root, ".bigrefactor", "docs", "index.json");
	const docs = existsSync(docsIndex) ? (JSON.parse(readFileSync(docsIndex, "utf8")) as Array<{ tech: string; name: string }>) : [];
	const tree = listTree(target, 2);
	const pkg = existsSync(join(target, "package.json")) ? readFileSync(join(target, "package.json"), "utf8") : "(no package.json)";
	const { getTargetAdapter, getSourceAdapter } = await import("../adapters/registry.ts");
	const adapter = await getTargetAdapter(config.target.stacks[0]!);
	// Stack decisions from init are binding for every rule: the ORM, validation, styling… chosen there, not the adapter defaults.
	const targets = await Promise.all(config.target.stacks.map((s) => getTargetAdapter(s)));
	const stackPlan = renderStackPlan(targets, config.target.choices, libraryPlan(getSourceAdapter(config.source.stack), config.source.path, loadDecisions(root).libraries).libraries);
	// Legacy framework → platform mapping (br frameworks + decisions) is binding too: rules must say what replaces each concern.
	const { planFrameworks, renderFrameworkPlan } = await import("../inventory/frameworks.ts");
	const src = getSourceAdapter(config.source.stack);
	src.frameworkDirs?.(config.source.path);
	const fwPlan = planFrameworks(ledger, src, targets, config.source.path, loadDecisions(root), config.target.choices);
	const frameworkPlan = fwPlan.concerns.length ? renderFrameworkPlan(fwPlan).split("\n").filter((l) => !/^\s+top:/.test(l)).slice(0, 40).join("\n") : "(no legacy framework detected)";

	const attempt = ledger.startAttempt("__init__", "setup", config.models.escalate.id);
	const session = await spawnLeaf({
		role: "setup",
		cwd: root,
		config,
		writeGlobs: [".bigrefactor/idioms.json", ".bigrefactor/rules/**"],
		protectedGlobs: [`${targetRel}/**`],
		tools: [], // setup has bash in its role defaults; it may run `npx ast-grep test` if available
		customTools: [docsLookup({ ledger, config, unitId: "__init__", root, targetProjectDir: target, adapter })],
		systemPrompt: `You write the coding rules for an automated migration from ${config.source.stack}${config.source.framework ? `/${config.source.framework}` : ""} to ${config.target.stacks.join(" + ")}. Dozens of implementer agents will follow these rules with tiny context, so rules must be concrete, checkable and short. Use docs_lookup for every claim about a framework (official docs are indexed for: ${[...new Set(docs.map((d) => `${d.tech}:${d.name}`))].join(", ")}). Do not invent APIs. The stack decisions in the task are binding: rules name exactly those libraries and never an alternative. Do not modify anything inside the target repo (${targetRel}/) — migration artifacts live outside it, under .bigrefactor/, and are injected into every agent's prompt.`,
		transcriptPath: join(root, ".bigrefactor", "sessions", `__init__.setup.${attempt}.jsonl`),
		onToolCall: (e) => e.blocked && log(pc.dim(`  setup blocked: ${e.blocked}`)),
	});
	// What the bootstrapped project actually is (test runner, module resolution…) beats any choice: rules that
	// name an uninstalled runner make every unit fail the gate the same way.
	const facts = targets.flatMap((t) => (t.projectNotes?.(projectDir(config, t.id)) ?? []).map((n) => `- ${t.id}: ${n}`));
	const prompt = `The target project was bootstrapped with the official generator. Layout:\n${tree}\n\n${facts.length ? `Project facts (detected from the installed project; they override any stack decision — never tell agents to use a package that is not in package.json):\n${facts.join("\n")}\n\n` : ""}Stack decisions (binding; "(default)" = adapter default accepted by the user):\n${stackPlan}\n\nLegacy framework mapping (binding; verdict platform = use the platform feature named, port = carry the logic over, drop = do not recreate). RULES.md MUST contain a section "Legacy framework mapping" with one line per concern telling implementers what to use instead of the legacy class family:\n${frameworkPlan}\n\npackage.json:\n\`\`\`json\n${pkg}\n\`\`\`\n\nWrite these files (all paths relative to ${root}; they describe the target repo at ${targetRel}/ but live outside it):\n\n1. .bigrefactor/rules/RULES.md — ≤ 120 lines. Sections: Module layout (where a migrated legacy file's symbols go: feature module dir, controller/service/repository/dto/entity files, naming); Types & DTOs (every request/response is a class with class-validator decorators; no \`any\`; legacy assoc arrays → DTO/interface); Data access (strategy: ${config.db.strategy}; the ORM from the stack decisions; how repositories wrap the existing schema; no raw SQL in controllers); Library replacements (one line per legacy library → successor from the stack decisions; dropped ones are listed as dropped); Errors (HttpException mapping of legacy http_response_code / die / echo json); Dependency injection; Tests (where specs live, how they import, no .skip/.only); Shared helpers (cross-cutting code — errors/exception filters, logging, money/number formatting, dates, validation, pagination — lives in ${adapter.layout.sharedDirs[0] ?? "the shared dir"}<area>/ with a doc comment per export; reuse via shared_lookup, add new files, never edit existing shared files from a feature unit); Forbidden (list of patterns with the ast-grep rule name that enforces each); Legacy quirks policy (preserve behaviour pinned by truth cases, document quirks with a // LEGACY: comment).\n2. .bigrefactor/rules/AGENTS.md — how to work in the target repo: commands from package.json (build/lint/test), layout, what is generated and must not be hand-edited (app.module.ts, main.ts), link to RULES.md.\n3. .bigrefactor/rules/src/AGENTS.md — per-directory patterns for the target's src/: file naming, one module per legacy area, barrel policy, import order.\n4. .bigrefactor/idioms.json — JSON array of ≥ 12 objects {"legacy": "<construct in ${config.source.stack}>", "target": "<idiom in ${stackId}>", "example": "<one-line target snippet>", "rule": "<ast-grep rule name or null>"} covering at least: superglobals ($_GET/$_POST), echo/json_encode responses, header()/http_response_code, include/require of templates, PDO/raw SQL, assoc arrays as records, global constants, static helper functions, exceptions/die(), date()/time, number_format/money, string-keyed config arrays.\n5. .bigrefactor/rules/astgrep/*.yml — 5 ast-grep rules (one file each, ast-grep YAML format with id, language: TypeScript, rule, message, severity: error) that enforce the Forbidden section, each followed by a sibling <id>-test.yml with valid/invalid snippets (ast-grep test format). Example targets: no \`@Body() x: any\`, no \`process.env\` outside a config module, no raw SQL strings in controllers, no console.log, no \`as any\`.\n\nUse docs_lookup before writing anything framework-specific (e.g. "ValidationPipe whitelist", "nest g resource", "HttpException"). Finish with the line "RULES DONE".`;
	let res;
	try {
		res = await session.run(prompt);
	} finally {
		session.dispose();
	}
	// A user stop aborts the session: do not validate half-written output or file questions about it.
	progress.checkStopped();
	ledger.endAttempt(attempt, { outcome: res.error ? "error" : "done", costUsd: res.usage.cost, tokensIn: res.usage.input, tokensOut: res.usage.output });
	log(pc.dim(`  setup: ${res.toolCalls} tool calls, ${res.blocked} blocked, $${res.usage.cost.toFixed(4)}${res.error ? pc.red(` ERROR: ${res.error}`) : ""}`));

	// ---- validate (code)
	const problems: string[] = [];
	for (const p of expected) if (!existsSync(p)) problems.push(`missing ${relative(root, p)}`);
	try {
		const idioms = JSON.parse(readFileSync(join(root, ".bigrefactor", "idioms.json"), "utf8"));
		if (!Array.isArray(idioms) || idioms.length < 12) problems.push(`idioms.json has ${Array.isArray(idioms) ? idioms.length : "no"} entries (need ≥ 12)`);
	} catch (e: any) {
		problems.push(`idioms.json invalid: ${e?.message ?? e}`);
	}
	const rules = existsSync(astDir) ? readdirSync(astDir).filter((f) => f.endsWith(".yml") && !f.endsWith("-test.yml")) : [];
	if (rules.length < 3) problems.push(`only ${rules.length} ast-grep rules written`);
	const rulesMd = existsSync(join(rulesDir, "RULES.md")) ? readFileSync(join(rulesDir, "RULES.md"), "utf8") : "";
	for (const s of config.target.stacks) if (rulesMd && !new RegExp(s, "i").test(rulesMd)) problems.push(`RULES.md does not mention ${s}`);
	if (problems.length) {
		log(pc.yellow(`rules validation: ${problems.join("; ")}`));
		ledger.askQuestion({ point: "rules_review", question: `Rules generation finished with problems: ${problems.join("; ")}. Fix by hand or re-run br rules --force?`, blocks: "none", askedBy: "init" });
	} else log(pc.green(`rules ok: ${expected.map((p) => relative(root, p)).join(", ")}, ${rules.length} ast-grep rules`));
	ledger.setMeta("rules_generated_at", new Date().toISOString());
	return { files: expected, costUsd: res.usage.cost };
}

function listTree(dir: string, depth: number, prefix = ""): string {
	if (depth < 0) return "";
	let out = "";
	for (const n of readdirSync(dir).filter((n) => !["node_modules", ".git", "dist"].includes(n)).sort()) {
		const p = join(dir, n);
		const isDir = statSync(p).isDirectory();
		out += `${prefix}${n}${isDir ? "/" : ""}\n`;
		if (isDir) out += listTree(p, depth - 1, prefix + "  ");
	}
	return out;
}
