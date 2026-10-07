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

export interface Advice {
	value: string;
	reason?: string;
	confidence?: number;
	by: string;
}

export async function advise(config: Config, root: string, ledger: Ledger, client: ModelClient, source: SourceAdapter, targets: TargetAdapter[], log: (l: string) => void = console.log): Promise<{ libraries: number; classes: number; decisions: number; costUsd: number; implied: Array<{ id: string; value: string; reason: string }> }> {
	const file = loadDecisions(root) as ReturnType<typeof loadDecisions> & { advice?: Record<string, Advice>; adviceBasis?: string };
	// advice sees the code's points, not an earlier phrasing
	const advice: Record<string, Advice> = (file.advice ??= {});
	// library successors, class verdicts and stack choices are judged FOR a target: when the stacks or the
	// owner's dimension answers change they are judged again, and the questions re-phrased
	const basis = [config.target.stacks.join("+"), ...Object.entries(file.answers).filter(([k]) => k.startsWith("target:")).map(([k, a]) => `${k}=${a.answer}`).sort()].join("|");
	if (file.adviceBasis && file.adviceBasis !== basis) {
		for (const k of Object.keys(advice)) if (/^(lib|fw|stack|concern):/.test(k)) delete advice[k];
		delete file.phrased;
		delete file.discovered;
	}
	file.adviceBasis = basis;
	let cost = 0;
	source.frameworkDirs?.(config.source.path);
	const plan = planFrameworks(ledger, source, targets, config.source.path, file, config.target.choices);
	// only what the owner decided is stated as fact; provisional config values would anchor every judgment
	const decidedChoices = Object.fromEntries(Object.entries(file.answers).filter(([k]) => k.startsWith("stack:")).map(([k, a]) => [k.slice(6), a.answer]));
	const decidedTargets = file.answers["target:server"] ? config.target.stacks.join(" + ") : undefined;
	const { phraseDecisions, discoverDecisions, pointHash, repoBrief } = await import("../jev/ask.ts");
	const deps = { ledger, config, root, client };
	// every judgment below reads the repo: the brief is what a model understood of it. Until the target is
	// decided, a brief written while provisional targets were stated as fact is rewritten.
	const targetsOpen = !file.answers["target:server"] && !file.dimensions;
	const b = await repoBrief(deps, { force: targetsOpen });
	cost += b.costUsd;
	const { surveySource, adviseStack, adviseDimensions } = await import("./survey.ts");
	const survey = await surveySource(config.source.path, source);

	// ---- 0. where each part of the app goes (server, ui, every data store, …), rated from the repo
	if (!file.dimensions) {
		const { TARGET_ROLES } = await import("../adapters/registry.ts");
		const r = await adviseDimensions(survey, b.brief, client, config.models.escalate.id, { legacyLibraries: plan.libraries.map((l) => l.name), dataStores: config.db.from, adapters: Object.entries(TARGET_ROLES).map(([id, role]) => ({ id, role })) });
		cost += r.costUsd;
		if (r.dimensions.length) {
			file.dimensions = r.dimensions;
			for (const d of r.dimensions) advice[`target:${d.key}`] = { value: d.candidates[0]!.id, reason: d.candidates[0]!.reason, by: config.models.escalate.id };
			log(pc.dim(`  advise: rated ${r.dimensions.length} dimensions (${r.dimensions.map((d) => `${d.key} → ${d.candidates[0]!.id} ${d.candidates[0]!.score}`).join(", ")}), $${r.costUsd.toFixed(4)}`));
		}
	}
	const implied: Array<{ id: string; value: string; reason: string }> = [];
	// what the owner decided about the dimensions: binding for every judgment below
	const decidedDims = Object.entries(file.answers).filter(([k]) => k.startsWith("target:")).map(([k, a]) => `${k.slice(7)} → ${a.answer}`);

	// ---- 1. target stack choices: the escalate model picks among each adapter's options from the repo
	const stackOpen = targets.some((t) => (t.stackChoices ?? []).some((c) => !file.answers[`stack:${t.id}.${c.key}`] && !advice[`stack:${t.id}.${c.key}`]));
	if (stackOpen) {
		const r = await adviseStack(survey, targets, client, config.models.escalate.id, { dbTo: config.db.to, legacyLibraries: plan.libraries.map((l) => l.name), brief: b.brief, decided: decidedDims });
		cost += r.costUsd;
		for (const [t, picks] of Object.entries(r.picks))
			for (const [k, v] of Object.entries(picks)) {
				advice[`stack:${t}.${k}`] = { value: v.id, reason: v.reason, by: config.models.escalate.id };
				// settled by what the owner decided (e.g. the data dimension fixes the database): not asked
				if (v.implied && !file.answers[`stack:${t}.${k}`]) implied.push({ id: `stack:${t}.${k}`, value: v.id, reason: v.reason });
			}
		log(pc.dim(`  advise: ${Object.values(r.picks).reduce((a, x) => a + Object.keys(x).length, 0)} stack choices, $${r.costUsd.toFixed(4)}`));
	}
	persist(root, file);

	// the platform the libraries/classes are judged against: decided choices, else the advised ones
	const advisedChoices: Config["target"]["choices"] = {};
	for (const [k, a] of Object.entries(advice)) if (k.startsWith("stack:")) {
		const [t, c] = k.slice(6).split(".");
		(advisedChoices[t!] ??= {})[c!] = a.value;
	}
	for (const [k, a] of Object.entries(decidedChoices)) {
		const [t, c] = k.split(".");
		(advisedChoices[t!] ??= {})[c!] = a;
	}
	const { effectivePlatform } = await import("./stack.ts");
	// successors are packages of the server target's ecosystem (its toolchain says which, and their shape)
	const tc = (targets.find((t) => t.role === "server") ?? targets[0]!).toolchain;
	const platform = Object.assign({}, ...targets.map((t) => effectivePlatform(t, { ...config.target.choices, ...advisedChoices }))) as Record<string, string>;

	// ---- 2. libraries + unmapped framework classes: one structured call to the escalate model
	const libs = plan.libraries.filter((l) => !l.dev && !file.libraries?.[l.name] && !advice[`lib:${l.name}`]);
	const classes = plan.unmapped.filter((u) => !file.frameworkClasses?.[u.name] && !advice[`fw:${u.name}`]).slice(0, 60);
	if (libs.length || classes.length) {
		// the class body from the index span (stack-neutral; inventory records line..end_line per symbol)
		const span = ledger.db.prepare("SELECT line, end_line FROM index_symbols WHERE side = 'source' AND path = ? AND name = ? ORDER BY line LIMIT 1");
		const excerpt = (path: string, name: string) => {
			try {
				const lines = readFileSync(join(config.source.path, path), "utf8").split("\n");
				const r = span.get(path, name) as { line: number | null; end_line: number | null } | undefined;
				const from = Math.max(0, (r?.line ?? 1) - 1);
				return lines.slice(from, r?.end_line ?? from + 40).join("\n").slice(0, 900);
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
				libraries: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "verdict", "successor", "condition", "reason"], properties: { name: { type: "string" }, verdict: { type: "string", enum: ["replace", "platform", "drop", "port"] }, successor: { type: "string", description: `exact ${tc.ecosystem} package name only${tc.packageExamples.length ? `, e.g. ${tc.packageExamples.join(" or ")}` : ""}; empty unless verdict is replace` }, condition: { type: "string", description: "when the choice only holds under a condition (e.g. 'only if SFTP is used'), else empty" }, reason: { type: "string" } } } },
				classes: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "verdict", "reason"], properties: { name: { type: "string" }, verdict: { type: "string", enum: verdictEnum }, reason: { type: "string" } } } },
			},
		};
		const prompt = [
			`Legacy app: ${config.source.stack}${config.source.framework ? `/${config.source.framework}` : ""}. Target: ${decidedTargets ?? `${config.target.stacks.join(" + ")} (not decided yet; judge for it)`} with choices ${JSON.stringify(advisedChoices)}.`,
			`Target platform capabilities by concern:\n${Object.entries(platform).map(([k, v]) => `- ${k}: ${v}`).join("\n")}`,
			libs.length ? `\nLegacy libraries (decide each: replace with a maintained ${tc.ecosystem} package for the target, platform = the target platform already covers it, drop = not needed, port = small enough to rewrite):\n${libs.map((l) => `- ${l.name} ${l.version ?? ""}${l.dev ? " [dev]" : ""}${l.note ? ` (${l.note})` : ""}`).join("\n")}` : "",
			classes.length ? `\nLegacy framework classes the app uses that have no mapping yet (verdict platform:<concern> when the target platform provides it, port when it holds application logic to carry over, drop when obsolete):\n${classes.map((c) => `### ${c.name} (${c.appRefs} app references, ${c.path})\n${excerpt(c.path, c.name)}`).join("\n\n")}` : "",
			"\nReturn every listed item exactly once with a one-sentence reason grounded in what the code/library does. successor is \"\" unless verdict is replace.",
		].join("\n");
		const res = await client.chat({ model: config.models.escalate.id, tier: config.models.escalate.tier as any, messages: [{ role: "system", content: "You are a senior migration architect. Be concrete; never invent packages." }, { role: "user", content: prompt }], schema, effort: "medium" });
		cost += res.usage.costUsd;
		const out = (res.json ?? {}) as { libraries?: Array<{ name: string; verdict: string; successor: string; condition?: string; reason: string }>; classes?: Array<{ name: string; verdict: string; reason: string }> };
		for (const l of out.libraries ?? []) {
			// a successor must be a package name; prose ("x (if S3 is used)") is split into package + condition
			const pkg = tc.packageName.exec(l.successor.trim())?.[0];
			const rest = l.successor.trim().slice(pkg?.length ?? 0).replace(/^[\s(,;:-]+|[\s)]+$/g, "");
			const condition = [l.condition, rest].filter(Boolean).join("; ");
			advice[`lib:${l.name}`] = { value: l.verdict === "replace" && pkg ? `replace:${pkg}` : l.verdict === "replace" ? "review" : l.verdict, reason: `${l.reason}${condition ? ` (${condition})` : ""}`, by: res.usage.model };
		}
		for (const c of out.classes ?? []) advice[`fw:${c.name}`] = { value: c.verdict, reason: c.reason, by: res.usage.model };
		log(pc.dim(`  advise: ${out.libraries?.length ?? 0} libraries, ${out.classes?.length ?? 0} framework classes, $${res.usage.costUsd.toFixed(4)}`));
	}
	persist(root, file);

	// ---- 3. open decisions: Jev picks among each decision's options, with confidence
	// libraries/classes were judged above; everything else open gets a Jev pick
	const jevable = openDecisions(ledger, config, source, targets, root, { raw: true }).filter((d) => !advice[d.id] && !d.id.startsWith("lib:") && !d.id.startsWith("fw:") && !d.id.startsWith("stack:") && !d.id.startsWith("target:") && d.options.length > 1);
	if (jevable.length) {
		// one call per decision, each with its own evidence: a combined call reports the minimum confidence of
		// unrelated questions and gives Jev no specific facts (observed 0.05–0.14 that way)
		// no code default goes in (it would anchor the pick); targets only once the owner decided them
		const repo = { stack: config.source.stack, framework: config.source.framework, db: { from: config.db.from }, targets: decidedTargets ?? "not decided yet", brief: b.brief.slice(0, 3000) };
		const facts = { frameworks: plan.concerns.filter((c) => c.appRefs > 0).map((c) => `${c.concern}:${c.verdict}`), slices: ledger.getMeta("slice_plan") ? JSON.parse(ledger.getMeta("slice_plan")!).map((s: { name: string; units: number }) => `${s.name}:${s.units}`) : [] };
		let spent = 0;
		await Promise.all(
			jevable.map(async (d) => {
				const battery: Battery = { choice: { type: "choice", instructions: `${d.question} Use \`evidence\` and \`repo\`. Pick the option a careful migration lead would choose for this repo.`, criteria: { ...Object.fromEntries(d.options.filter((o) => !o.value.includes("?")).map((o) => [o.value, `${o.label}${o.hint ? ` — ${o.hint}` : ""}`])), other: null } } };
				try {
					const r = await decide({ client, ledger, model: config.models.decide.id, second: config.models.escalate.id }, `advise:${d.id}`, { evidence: d.evidence, repo, ...(d.topic === "slicing" ? facts : {}) }, battery, ["choice"]);
					spent += r.costUsd;
					const a = r.answers["choice"];
					// kept with its confidence: below JEV_ACT (after a second opinion) it is shown as doubt, never used as
					// the recommendation (openDecisions); the phrasing model, which read the brief, recommends instead
					if (a?.type === "choice" && a.choice !== "other") advice[d.id] = { value: a.choice, confidence: r.confidence, reason: `decision model, ${Math.round(r.confidence * 100)}% confident${r.secondOpinion === "agreed" ? " (a second model agreed)" : ""}`, by: `jev:${r.decisionId}` };
				} catch {
					/* no advice: the code recommendation stands */
				}
			}),
		);
		cost += spent;
		log(pc.dim(`  advise: ${jevable.length} decisions via Jev, $${spent.toFixed(5)}`));
	}
	persist(root, file);

	// ---- 4. every question is phrased for THIS repo by a model that read it; plus decisions code did not foresee
	const { toPoint } = await import("../inventory/decisions.ts");
	const raw = openDecisions(ledger, config, source, targets, root, { raw: true });
	const stale = raw.map(toPoint).filter((p) => file.phrased?.[p.id]?.hash !== pointHash(p));
	if (stale.length) {
		const r = await phraseDecisions(deps, stale);
		file.phrased = { ...file.phrased, ...r.phrased };
		cost += r.costUsd;
		log(pc.dim(`  advise: ${Object.keys(r.phrased).length}/${stale.length} questions phrased for this repo, $${r.costUsd.toFixed(4)}`));
	}
	if (!file.discovered) {
		const r = await discoverDecisions(deps, raw.map((d) => ({ id: d.id, question: file.phrased?.[d.id]?.question ?? d.question })));
		file.discovered = r.discovered;
		cost += r.costUsd;
		log(pc.dim(`  advise: ${Object.keys(r.discovered).length} repo-specific decisions found, $${r.costUsd.toFixed(4)}`));
	}
	persist(root, file);
	return { libraries: libs.length, classes: classes.length, decisions: jevable.length, costUsd: cost, implied };
}

function persist(root: string, d: unknown): void {
	writeFileSync(decisionsPath(root), JSON.stringify(d, null, 2) + "\n");
}
