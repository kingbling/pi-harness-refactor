import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getTargetAdapter } from "../adapters/registry.ts";
import type { TargetAdapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";

/**
 * Where a stack's rules live and the one part of them that is NOT model-written: the module layout. It comes
 * from the target adapter (the same source the write gate and placement use), is rendered by code between
 * markers at the top of each stack's RULES.md, and is re-rendered on every rules version, so rules and gate
 * cannot drift apart.
 *
 *   .bigrefactor/rules/<stack>/RULES.md         layout (code) + living rules body (model, versioned)
 *   .bigrefactor/rules/<stack>/AGENTS.md        how to work in that project (commands, generated files)
 *   .bigrefactor/rules/<stack>/idioms.json      legacy construct → idiom of this stack
 *   .bigrefactor/rules/<stack>/astgrep/*.yml    enforced patterns (+ *-test.yml)
 *   .bigrefactor/rules/<stack>/history/RULES.v<n>.md
 */
export const LAYOUT_BEGIN = "<!-- layout:begin (generated from the target adapter; do not edit) -->";
export const LAYOUT_END = "<!-- layout:end -->";

export function rulesDir(root: string, stackId: string): string {
	return join(root, ".bigrefactor", "rules", stackId);
}

export function renderLayoutSection(adapter: TargetAdapter): string {
	const l = adapter.layout;
	return [
		LAYOUT_BEGIN,
		`## Module layout (${adapter.id}, project dir \`${adapter.subdir}/\`)`,
		`- One legacy area → one feature module per stack: \`${l.moduleDir("<area>")}/\`. Every unit of the area extends the area's existing files and classes; never a parallel class or folder per legacy file.`,
		`- Cross-cutting helpers (used by ≥2 areas) live in ${l.sharedDirs.map((d) => `\`${d}<topic>/\``).join(" or ")}: reuse via shared_lookup, add new files, never edit existing ones from a feature unit.`,
		`- No module root other than \`${l.moduleDir("<area>").replace(/<area>$/, "")}\` and the shared dirs; no folder or file named after a legacy file name or legacy extension.`,
		"",
		l.structureDoc,
		LAYOUT_END,
	].join("\n");
}

/** RULES.md = code-rendered layout + model-written body. */
export function composeRules(adapter: TargetAdapter, body: string): string {
	return `${renderLayoutSection(adapter)}\n\n${stripLayout(body).trim()}\n`;
}

export function stripLayout(md: string): string {
	const a = md.indexOf(LAYOUT_BEGIN);
	const b = md.indexOf(LAYOUT_END);
	return a >= 0 && b > a ? md.slice(0, a) + md.slice(b + LAYOUT_END.length) : md;
}

/** Problems with the rules' layout for every target stack; empty = rules and adapters agree. */
export async function validateRulesLayout(root: string, config: Config): Promise<string[]> {
	const problems: string[] = [];
	for (const stackId of config.target.stacks) {
		const adapter = await getTargetAdapter(stackId);
		const p = join(rulesDir(root, stackId), "RULES.md");
		if (!existsSync(p)) {
			problems.push(`${stackId}: ${p} missing (br rules)`);
			continue;
		}
		const md = readFileSync(p, "utf8");
		if (!md.includes(renderLayoutSection(adapter))) problems.push(`${stackId}: RULES.md layout section differs from the adapter layout (br rules --relayout)`);
		const moduleRoot = adapter.layout.moduleDir("<area>").replace(/<area>$/, "");
		const allowed = [moduleRoot, ...adapter.layout.sharedDirs];
		const body = stripLayout(md);
		// any other src/<x>/ path the body names (with or without the project subdir, in or out of backticks) is a competing layout
		for (const m of body.matchAll(/(?:^|[\s`("'./])((?:[\w-]+\/)?src\/[\w.<>-]+\/)/gm)) {
			const dir = m[1]!.replace(new RegExp(`^${adapter.subdir}/`), "");
			if (!dir.startsWith("src/")) continue;
			if (!allowed.some((a) => dir.startsWith(a) || a.startsWith(dir))) problems.push(`${stackId}: RULES.md names module root ${dir} outside ${allowed.join(", ")}`);
		}
		// file shapes under the module root must be ones the adapter's structureDoc lists (by suffix)
		const doc = adapter.layout.structureDoc;
		for (const m of body.matchAll(new RegExp(`${escape(moduleRoot)}[^\\s\`)'"]*?/([\\w<>-]+((?:\\.[\\w-]+)+))(?=[\\s\`)'",]|$)`, "gm"))) {
			const suffix = m[2]!;
			if (!doc.includes(suffix)) problems.push(`${stackId}: RULES.md names file shape ${m[1]} (${suffix}) that the ${stackId} layout does not list`);
		}
	}
	return [...new Set(problems)];
}

function escape(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The ast-grep rule files currently active for a stack (tests excluded). */
export function activeRuleFiles(root: string, stackId: string): string[] {
	const dir = join(rulesDir(root, stackId), "astgrep");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".yml") && !f.endsWith("-test.yml"))
		.sort()
		.map((f) => join(dir, f));
}

/**
 * A rule only applies to files of its `language`; a stack whose files need several (adapter.layout.astGrepLanguages)
 * gets a copy of each rule (and its test) per missing language: `<id>--<lang>.yml`. Returns the files written.
 */
export function expandRuleLanguages(root: string, adapter: TargetAdapter): string[] {
	const langs = adapter.layout.astGrepLanguages ?? [];
	const dir = join(rulesDir(root, adapter.id), "astgrep");
	if (langs.length < 2 || !existsSync(dir)) return [];
	const written: string[] = [];
	for (const f of readdirSync(dir).filter((f) => f.endsWith(".yml") && !f.endsWith("-test.yml") && !f.includes("--"))) {
		const text = readFileSync(join(dir, f), "utf8");
		const lang = /^language:\s*(\S+)/m.exec(text)?.[1];
		const id = /^id:\s*(\S+)/m.exec(text)?.[1];
		if (!lang || !id) continue;
		for (const other of langs.filter((l) => l.toLowerCase() !== lang.toLowerCase())) {
			const suffix = other.toLowerCase();
			const name = `${f.replace(/\.yml$/, "")}--${suffix}.yml`;
			writeFileSync(join(dir, name), text.replace(/^language:.*$/m, `language: ${other}`).replace(/^id:.*$/m, `id: ${id}--${suffix}`));
			written.push(name);
			const test = join(dir, f.replace(/\.yml$/, "-test.yml"));
			if (existsSync(test)) writeFileSync(join(dir, name.replace(/\.yml$/, "-test.yml")), readFileSync(test, "utf8").replace(/^id:.*$/m, `id: ${id}--${suffix}`));
		}
	}
	return written;
}
