import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import type { SourceAdapter, TargetAdapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import { decide } from "../jev/decide.ts";
import type { Battery } from "../jev/questions.ts";
import type { Ledger } from "../ledger/db.ts";
import type { ModelClient } from "../models/types.ts";
import { decisionsPath, loadDecisions, openDecisions, type Decision } from "../inventory/decisions.ts";
import { planFrameworks } from "../inventory/frameworks.ts";

/**
 * `br advise`: judgments come from models, facts from code. Code collects the evidence (index, framework
 * plan, survey); models make the calls the old hardcoded tables made:
 *  - escalate model (structured JSON): successor for every legacy library, verdict + concern for every
 *    framework class the app uses that the profile does not map, each with a one-line reason; it sees the
 *    class source and the target platform's capabilities.
 *  - Jev (one typed battery, cheap, with confidence): the recommended option for every open decision.
 * Output is ADVICE (`decisions.json → advice`), never an answer: `br decide` / onboarding show it as the
 * recommendation with its reason and confidence; a human (or `--yes`) still decides. Static tables in the
 * adapters remain only as the offline fallback (`--no-llm`).
 */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*/;

export interface Advice {
	value: string;
	reason?: string;
	confidence?: number;
	by: string;
}

export async function advise(config: Config, root: string, ledger: Ledger, client: ModelClient, source: SourceAdapter, targets: TargetAdapter[], log: (l: string) => void = console.log): Promise<{ libraries: number; classes: number; decisions: number; costUsd: number }> {
	const file = loadDecisions(root) as ReturnType<typeof loadDecisions> & { advice?: Record<string, Advice> };
	const advice: Record<string, Advice> = (file.advice ??= {});
	let cost = 0;
	source.frameworkDirs?.(config.source.path);
	const plan = planFrameworks(ledger, source, targets, config.source.path, file, config.target.choices);
	const platform = Object.assign({}, ...targets.map((t) => t.platform ?? {})) as Record<string, string>;
	const choices = JSON.stringify(config.target.choices);

	// ---- 1. libraries + unmapped framework classes: one structured call to the escalate model
	const libs = plan.libraries.filter((l) => !file.libraries?.[l.name] && !advice[`lib:${l.name}`]);
	const classes = plan.unmapped.filter((u) => !file.frameworkClasses?.[u.name] && !advice[`fw:${u.name}`]).slice(0, 60);
	if (libs.length || classes.length) {
		const excerpt = (path: string, name: string) => {
			try {
				const text = readFileSync(join(config.source.path, path), "utf8");
				const i = Math.max(0, text.search(new RegExp(`(class|interface|trait|function)\\s+${name}\\b`)));
				return text.slice(i, i + 900);
			} catch {
				return "";
			}
		};
		const verdictEnum = [...Object.keys(platform).map((k) => `platform:${k}`), "port", "drop"];
		const schema = {
			type: "object",
			additionalProperties: false,
			required: ["libraries", "classes"],
			properties: {
				libraries: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "verdict", "successor", "condition", "reason"], properties: { name: { type: "string" }, verdict: { type: "string", enum: ["replace", "platform", "drop", "port"] }, successor: { type: "string", description: "exact npm package name only, e.g. exceljs or @aws-sdk/client-s3; empty unless verdict is replace" }, condition: { type: "string", description: "when the choice only holds under a condition (e.g. 'only if SFTP is used'), else empty" }, reason: { type: "string" } } } },
				classes: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "verdict", "reason"], properties: { name: { type: "string" }, verdict: { type: "string", enum: verdictEnum }, reason: { type: "string" } } } },
			},
		};
		const prompt = [
			`Legacy app: ${config.source.stack}${config.source.framework ? `/${config.source.framework}` : ""}. Target: ${config.target.stacks.join(" + ")} with choices ${choices}.`,
			`Target platform capabilities by concern:\n${Object.entries(platform).map(([k, v]) => `- ${k}: ${v}`).join("\n")}`,
			libs.length ? `\nLegacy libraries (decide each: replace with a maintained npm package for the target, platform = the target platform already covers it, drop = not needed, port = small enough to rewrite):\n${libs.map((l) => `- ${l.name} ${l.version ?? ""}${l.dev ? " [dev]" : ""}${l.note ? ` (${l.note})` : ""}`).join("\n")}` : "",
			classes.length ? `\nLegacy framework classes the app uses that have no mapping yet (verdict platform:<concern> when the target platform provides it, port when it holds application logic to carry over, drop when obsolete):\n${classes.map((c) => `### ${c.name} (${c.appRefs} app references, ${c.path})\n${excerpt(c.path, c.name)}`).join("\n\n")}` : "",
			"\nReturn every listed item exactly once with a one-sentence reason grounded in what the code/library does. successor is \"\" unless verdict is replace.",
		].join("\n");
		const res = await client.chat({ model: config.models.escalate.id, tier: config.models.escalate.tier as any, messages: [{ role: "system", content: "You are a senior migration architect. Be concrete; never invent packages." }, { role: "user", content: prompt }], schema, effort: "medium" });
		cost += res.usage.costUsd;
		const out = (res.json ?? {}) as { libraries?: Array<{ name: string; verdict: string; successor: string; condition?: string; reason: string }>; classes?: Array<{ name: string; verdict: string; reason: string }> };
		for (const l of out.libraries ?? []) {
			// a successor must be a package name; prose ("x (if S3 is used)") is split into package + condition
			const pkg = NPM_NAME.exec(l.successor.trim())?.[0];
			const rest = l.successor.trim().slice(pkg?.length ?? 0).replace(/^[\s(,;:-]+|[\s)]+$/g, "");
			const condition = [l.condition, rest].filter(Boolean).join("; ");
			advice[`lib:${l.name}`] = { value: l.verdict === "replace" && pkg ? `replace:${pkg}` : l.verdict === "replace" ? "review" : l.verdict, reason: `${l.reason}${condition ? ` (${condition})` : ""}`, by: res.usage.model };
		}
		for (const c of out.classes ?? []) advice[`fw:${c.name}`] = { value: c.verdict, reason: c.reason, by: res.usage.model };
		log(pc.dim(`  advise: ${out.libraries?.length ?? 0} libraries, ${out.classes?.length ?? 0} framework classes, $${res.usage.costUsd.toFixed(4)}`));
	}
	persist(root, file);

	// ---- 2. target stack choices: the escalate model picks among each adapter's options from the survey
	const stackOpen = targets.some((t) => (t.stackChoices ?? []).some((c) => !file.answers[`stack:${t.id}.${c.key}`] && !advice[`stack:${t.id}.${c.key}`]));
	if (stackOpen) {
		const { surveySource, adviseStack } = await import("./survey.ts");
		const survey = await surveySource(config.source.path, source);
		const r = await adviseStack(survey, targets, client, config.models.escalate.id, { dbTo: config.db.to, legacyLibraries: plan.libraries.map((l) => l.name) });
		cost += r.costUsd;
		for (const [t, picks] of Object.entries(r.picks)) for (const [k, v] of Object.entries(picks)) advice[`stack:${t}.${k}`] = { value: v.id, reason: v.reason, by: config.models.escalate.id };
		log(pc.dim(`  advise: ${Object.values(r.picks).reduce((a, x) => a + Object.keys(x).length, 0)} stack choices, $${r.costUsd.toFixed(4)}`));
	}
	persist(root, file);

	// ---- 3. open decisions: Jev picks among each decision's options, with confidence
	// libraries/classes were judged above; everything else open gets a Jev pick
	const jevable = openDecisions(ledger, config, source, targets, root).filter((d) => !advice[d.id] && !d.id.startsWith("lib:") && !d.id.startsWith("fw:") && !d.id.startsWith("stack:") && d.options.length > 1);
	if (jevable.length) {
		// one call per decision, each with its own evidence: a combined call reports the minimum confidence of
		// unrelated questions and gives Jev no specific facts (observed 0.05–0.14 that way)
		const repo = { stack: config.source.stack, framework: config.source.framework, db: { strategy: config.db.strategy, from: config.db.from, to: config.db.to }, targets: config.target.stacks };
		const facts = { frameworks: plan.concerns.filter((c) => c.appRefs > 0).map((c) => `${c.concern}:${c.verdict}`), slices: ledger.getMeta("slice_plan") ? JSON.parse(ledger.getMeta("slice_plan")!).map((s: { name: string; units: number }) => `${s.name}:${s.units}`) : [] };
		let spent = 0;
		await Promise.all(
			jevable.map(async (d) => {
				const battery: Battery = { choice: { type: "choice", instructions: `${d.question} Use \`evidence\` and \`repo\`. Pick the option a careful migration lead would choose for this repo.`, criteria: { ...Object.fromEntries(d.options.filter((o) => !o.value.includes("?")).map((o) => [o.value, `${o.label}${o.hint ? ` — ${o.hint}` : ""}`])), other: null } } };
				try {
					const r = await decide({ client, ledger, model: config.models.decide.id }, `advise:${d.id}`, { evidence: d.evidence, current_recommendation: d.recommended, repo, ...(d.topic === "slicing" || d.topic === "budget" ? facts : {}) }, battery, ["choice"]);
					spent += r.costUsd;
					const a = r.answers["choice"];
					if (a?.type === "choice" && a.choice !== "other") advice[d.id] = { value: a.choice, confidence: a.confidence, reason: `Jev ${Math.round(a.confidence * 100)}%`, by: `jev:${r.decisionId}` };
				} catch {
					/* no advice: the code recommendation stands */
				}
			}),
		);
		cost += spent;
		log(pc.dim(`  advise: ${jevable.length} decisions via Jev, $${spent.toFixed(5)}`));
	}
	persist(root, file);
	return { libraries: libs.length, classes: classes.length, decisions: jevable.length, costUsd: cost };
}

function persist(root: string, d: unknown): void {
	writeFileSync(decisionsPath(root), JSON.stringify(d, null, 2) + "\n");
}

export function loadAdvice(root: string): Record<string, Advice> {
	const p = decisionsPath(root);
	if (!existsSync(p)) return {};
	return ((JSON.parse(readFileSync(p, "utf8")) as { advice?: Record<string, Advice> }).advice ?? {});
}
