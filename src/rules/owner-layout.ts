import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { TargetAdapter } from "../adapters/types.ts";
import { LAYOUT_RULES_SCHEMA } from "../adapters/target/generated.ts";
import type { InitPrompter } from "../init/init.ts";
import type { Ledger } from "../ledger/db.ts";
import type { ModelClient } from "../models/types.ts";
import { PLAIN_LANGUAGE } from "../policy.ts";
import { checkLayoutRules, checkLayoutTree, loadLayoutRules, normalize, samplePath, saveLayoutRules, subStyle, validateLayoutRules, type LayoutRules } from "./layout-rules.ts";
import { rulesDir, stripLayout } from "./layout.ts";

/**
 * The owner decides the feature-folder layout of each stack: at onboarding the framework's own convention is
 * proposed (the adapter's layoutRules), mid-run `/br rule <plain words>` changes it. A model turns plain words into
 * layout rules; code checks them (patterns compile, the model's own example paths pass and fail as it says, a
 * catch-all folder fails) before the owner sees them; nothing is written until the owner says apply.
 */

/** One example feature folder, the way the owner reads a layout: paths for area "campaign" with what goes there. */
export function layoutPreview(r: LayoutRules, area = "campaign"): string {
	const mod = r.moduleDir.replace(/\{area\}/g, area).replace(/\{Area\}/g, area[0]!.toUpperCase() + area.slice(1)).replace(/\{area_snake\}/g, area);
	const sub = subStyle(r.moduleDir).sample;
	const required = new Set(r.require.map((q) => samplePath(q, area, sub)));
	return [
		`${mod}/`,
		...r.files.map((f) => {
			const p = samplePath(f.path, area, sub).replace(/\bsample\b/g, "<name>").replace(/\bSample\b/g, "<Name>").replace(new RegExp(`\\b${sub}\\b`, "g"), "<sub>");
			return `  ${p}${required.has(samplePath(f.path, area, sub)) ? " (always)" : ""} — ${f.doc}`;
		}),
		`  never: ${r.forbidDirs.map((d) => `${d}/`).join(", ")}`,
		...(r.place ?? []).map((p) => `  ${p.doc}`),
	].join("\n");
}

export type LayoutDraft = { ok: true; rules: LayoutRules; summary: string } | { ok: false; reason: string };

/** Plain words → changed layout rules, checked by code; up to `repairs` retries with the problems found. */
export async function draftLayout(o: { client: ModelClient; model: string; stack: string; current: LayoutRules | undefined; words: string; repairs?: number }): Promise<LayoutDraft> {
	const schema = {
		type: "object",
		additionalProperties: false,
		required: ["checkable", "summary", "reason", "rules", "mustPass", "mustFail"],
		properties: {
			checkable: { type: "boolean", description: "false when the request is not about where files and folders go (then rules = current, reason says why)" },
			summary: { type: "string", description: "what changes, in one or two plain sentences" },
			reason: { type: "string" },
			rules: LAYOUT_RULES_SCHEMA,
			mustPass: { type: "array", items: { type: "string" }, description: "paths relative to the feature folder of area 'campaign' that the new rules must allow" },
			mustFail: { type: "array", items: { type: "string" }, description: "paths relative to the feature folder of area 'campaign' that the new rules must reject" },
		},
	};
	const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
		{
			role: "system",
			content: `You maintain the feature-folder layout of the ${o.stack} project in an automated migration. The layout is data a checker enforces (layout.json). Patterns are relative to the feature folder: {area} {Area} {area_snake} the feature, {name}/{Name}/{name_snake} any kebab-case/PascalCase/snake_case name (use the one this stack names its files with, e.g. snake_case for Python, Go, Ruby, Rust), {sub} a sub-feature folder named after what it does, spelled like the feature folders ({Area} → PascalCase, {area} → kebab-case; same value where it repeats), (a|b) either word. files = the only files allowed; require = files the framework itself needs in every feature folder to load it (none when it finds the code on its own); place = code (regex on the text) that may only live in some files; forbidDirs = banned folder names. Change only what the owner asks; keep everything else exactly. If the request is the framework's own convention, use the official docs' layout. If the request is not about where files and folders go (naming inside code, style), set checkable=false.\n\n${PLAIN_LANGUAGE}`,
		},
		{ role: "user", content: `Current layout.json:\n${JSON.stringify(o.current ?? { moduleDir: "src/{area}", files: [], require: [], forbidDirs: [], place: [] }, null, 1)}\n\nThe owner says: ${o.words}` },
	];
	for (let attempt = 0; attempt <= (o.repairs ?? 2); attempt++) {
		const res = await o.client.chat({ model: o.model, messages, schema, effort: "medium" });
		const j = res.json as { checkable: boolean; summary: string; reason: string; rules: LayoutRules; mustPass: string[]; mustFail: string[] } | undefined;
		if (!j) return { ok: false, reason: "the model gave no answer" };
		if (!j.checkable) return { ok: false, reason: j.reason || "this is not about where files and folders go" };
		const rules = normalize(j.rules);
		const problems = [...validateLayoutRules(rules), ...examplesProblems(rules, j.mustPass, j.mustFail)];
		if (!problems.length) return { ok: true, rules, summary: j.summary };
		messages.push({ role: "assistant", content: JSON.stringify(j) }, { role: "user", content: `The checker found problems; fix them and answer again:\n- ${problems.join("\n- ")}` });
	}
	return { ok: false, reason: "the rules the model wrote did not pass the checks after several tries" };
}

/** The model's own examples, run through the real checker. */
export function examplesProblems(r: LayoutRules, mustPass: string[], mustFail: string[]): string[] {
	const opts = { sharedDirs: [], isTestFile: () => false };
	const mod = r.moduleDir.replace(/\{area\}/g, "campaign").replace(/\{Area\}/g, "Campaign").replace(/\{area_snake\}/g, "campaign");
	// `require` needs the whole folder: checked per path without it
	const one = (rel: string) => checkLayoutRules([`${mod}/${rel}`], mod, "campaign", "/nonexistent", { ...r, require: [] }, opts);
	return [
		...mustPass.filter((p) => one(p).length).map((p) => `${p} should pass but fails: ${one(p)[0]}`),
		...mustFail.filter((p) => !one(p).length).map((p) => `${p} should fail but passes`),
	];
}

/** How much of the project as it is now breaks the rules: findings and feature folders affected. */
export function layoutImpact(projectDir: string, adapter: TargetAdapter, r: LayoutRules): { findings: string[]; areas: number } {
	if (!existsSync(projectDir)) return { findings: [], areas: 0 };
	const l = adapter.layout;
	const findings = checkLayoutTree(projectDir, r, { sharedDirs: l.sharedDirs, dataDirs: l.dataDirs, isTestFile: (f) => l.isTestFile(f), sourceExtensions: l.sourceExtensions, ignoreDirs: l.ignoreDirs, fileFindings: l.fileFindings });
	const root = r.moduleDir.split("/").slice(0, -1).join("/");
	const areas = new Set(findings.map((f) => f.startsWith(`${root}/`) ? f.slice(root.length + 1).split("/")[0] : "").filter(Boolean));
	return { findings, areas: areas.size };
}

/**
 * Write the rules, re-render RULES.md's layout section (when there is one) and record the new drift, so tidy
 * proposes moving what is already there. The next gate enforces them.
 */
export async function applyLayout(o: { root: string; stack: string; rules: LayoutRules; ledger?: Ledger; projectDir?: string }): Promise<string> {
	const path = saveLayoutRules(o.root, o.stack, o.rules);
	const rulesMd = join(rulesDir(o.root, o.stack), "RULES.md");
	if (o.ledger && existsSync(rulesMd)) {
		const { saveRulesVersion } = await import("./living.ts");
		await saveRulesVersion({ ledger: o.ledger, root: o.root }, o.stack, stripLayout(readFileSync(rulesMd, "utf8")));
	}
	if (o.ledger && o.projectDir && existsSync(o.projectDir)) {
		const { recordDrift } = await import("../run/layout-check.ts");
		const { getTargetAdapter } = await import("../adapters/registry.ts");
		recordDrift(o.ledger, await getTargetAdapter(o.stack), o.projectDir);
	}
	return path;
}

/**
 * The onboarding question per stack: the framework's convention (or the current layout.json), as an example
 * folder; use it, change it in plain words, or keep the built-in checks for now. Returns what was decided.
 */
export async function askLayout(o: { root: string; stack: string; adapter: TargetAdapter; ui: InitPrompter; yes: boolean; client?: ModelClient; model: string; projectDir?: string; ledger?: Ledger; log?: (l: string) => void }): Promise<string> {
	let rules = loadLayoutRules(o.root, o.stack) ?? (o.adapter.layoutRules ? normalize(o.adapter.layoutRules) : undefined);
	let summary = rules?.source ? `the framework's own convention (${rules.source})` : "";
	if (!rules && o.client && !o.yes) {
		o.log?.(`${o.stack}: asking a model for the framework's official folder layout…`);
		const d = await draftLayout({ client: o.client, model: o.model, stack: o.stack, current: undefined, words: `Write the official feature-folder convention of ${o.stack}: one folder per feature, request/response classes in their own folder, sub-features in folders named after what they do (spelled like the feature folders). require only a file the framework itself needs to load a feature folder; none when the framework finds the code on its own.` });
		if (d.ok) ({ rules, summary } = { rules: d.rules, summary: d.summary });
	}
	if (!rules) return "no layout proposal: the built-in checks apply (/br rule sets one later)";
	// a project that already has feature folders keeps its root: moving them is a cleanup decision, never a side effect
	const current = o.adapter.layout.moduleDir("{area}");
	if (!loadLayoutRules(o.root, o.stack) && current !== rules.moduleDir && o.projectDir && hasFeatureFolders(o.projectDir, current)) {
		rules = { ...rules, moduleDir: current };
		summary = `${summary || "this layout"}, keeping your existing feature folders under ${current.replace(/\{area\}$/, "")}`;
	}
	if (o.yes) {
		await applyLayout({ root: o.root, stack: o.stack, rules, ledger: o.ledger, projectDir: o.projectDir });
		return `${rules.moduleDir} (${summary || "proposed"})`;
	}
	for (;;) {
		const impact = o.projectDir ? layoutImpact(o.projectDir, o.adapter, rules) : { findings: [], areas: 0 };
		const v = await o.ui.select(
			`How should the ${o.stack} code be organised? Proposed: ${summary || "this layout"}.\n${layoutPreview(rules).split("\n").map((l) => `   ${l}`).join("\n")}${impact.findings.length ? `\n   ${impact.findings.length} thing(s) in ${impact.areas} feature folder(s) already there break it; the cleanup step proposes moving them.` : ""}\n   Every agent's work is checked against this; breaking it fails the check with what to fix.`,
			[
				{ value: "use", label: "use this layout (recommended)" },
				{ value: "change", label: "change it — describe in your own words", hint: 'e.g. "sub-features in their own folder, no extended/ folder"' },
				{ value: "later", label: "decide later", hint: "only the built-in checks apply until then (/br rule)" },
			],
			"use",
		);
		if (v === undefined) throw new Error("onboarding cancelled");
		if (v === "later") return "decided later";
		if (v === "use") {
			await applyLayout({ root: o.root, stack: o.stack, rules, ledger: o.ledger, projectDir: o.projectDir });
			return `${rules.moduleDir}${summary ? ` (${summary})` : ""}`;
		}
		const words = (await o.ui.text("What should change? (plain words)", ""))?.trim();
		if (!words) continue;
		if (!o.client) {
			o.ui.log("changing the layout in your words needs a model (no API key / --no-llm); edit .bigrefactor/rules/<stack>/layout.json by hand instead");
			continue;
		}
		const d = await draftLayout({ client: o.client, model: o.model, stack: o.stack, current: rules, words });
		if (!d.ok) o.ui.log(`not changed: ${d.reason}`);
		else ({ rules, summary } = { rules: d.rules, summary: d.summary });
	}
}

function hasFeatureFolders(projectDir: string, moduleDir: string): boolean {
	const root = join(projectDir, moduleDir.split("/").slice(0, -1).join("/"));
	try {
		return readdirSync(root, { withFileTypes: true }).some((e) => e.isDirectory() && !e.name.startsWith("."));
	} catch {
		return false;
	}
}

/** `/br rule <words>`: draft → code check → one card with the change and its impact → apply or reject. */
export async function ownerRule(o: { root: string; stack: string; adapter: TargetAdapter; words: string; ui: InitPrompter; client: ModelClient; model: string; projectDir?: string; ledger?: Ledger }): Promise<string> {
	const current = loadLayoutRules(o.root, o.stack) ?? (o.adapter.layoutRules ? normalize(o.adapter.layoutRules) : undefined);
	const d = await draftLayout({ client: o.client, model: o.model, stack: o.stack, current, words: o.words });
	if (!d.ok) {
		const { proposeRule } = await import("./living.ts");
		if (o.ledger) proposeRule({ ledger: o.ledger }, { stack: o.stack, kind: "add", text: o.words, why: "owner (/br rule)" });
		return `not a folder rule the checker can enforce (${d.reason}); added as a written rule for the agents instead (merged into RULES.md with the next rules update)`;
	}
	const impact = o.projectDir ? layoutImpact(o.projectDir, o.adapter, d.rules) : { findings: [], areas: 0 };
	const v = await o.ui.select(
		`Change the ${o.stack} folder layout? ${d.summary}\n${layoutPreview(d.rules).split("\n").map((l) => `   ${l}`).join("\n")}\n   ${impact.findings.length ? `${impact.findings.length} thing(s) in ${impact.areas} feature folder(s) already there break it, e.g. ${impact.findings[0]}; the cleanup step proposes moving them.` : "Nothing already there breaks it."}\n   From the next unit on, every agent's work is checked against it.`,
		[
			{ value: "apply", label: "apply" },
			{ value: "reject", label: "don't change anything" },
		],
		"apply",
	);
	if (v !== "apply") return "nothing changed";
	await applyLayout({ root: o.root, stack: o.stack, rules: d.rules, ledger: o.ledger, projectDir: o.projectDir });
	return `applied: ${d.summary}${impact.findings.length ? ` (${impact.findings.length} existing finding(s) recorded for cleanup)` : ""}`;
}
