import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../config.ts";
import type { Ledger } from "../ledger/db.ts";
import type { QuestionBlocks, QuestionRow } from "../ledger/schema.ts";
import type { ModelClient } from "../models/types.ts";

/**
 * Every question a human sees is phrased by a model that has read the source repo. Code only says WHAT is
 * undecided (a point, facts, machine option values); the model turns that into a question about THIS repo,
 * labels the options in its words, recommends one and states its opinion. Nothing here holds question text.
 *
 *   repoBrief        — the model's understanding of the legacy repo (.bigrefactor/repo-brief.md), written once
 *                      from facts the code gathers; every other call gets it as context.
 *   phraseDecisions  — onboarding: code-detected decision points → repo-specific questions.
 *   discoverDecisions— onboarding: decision points the code did not foresee, found by the model in the brief.
 *   askViaModel      — run time: one ledger question (quirks, placement, rule changes, environment …).
 *
 * Without a client (offline e2e, `--no-llm`) questions carry the raw facts and option values — visibly
 * unphrased, never a crafted text.
 */

export interface AskOption {
	/** Machine value the code acts on; never changed by the model. */
	value: string;
	/** What the code knows about this option (input to the model, not shown as-is). */
	facts?: string;
}

export interface PhrasedQuestion {
	question: string;
	/** Recommended first. */
	options: Array<{ value: string; label: string; hint?: string }>;
	recommended?: string;
	/** The model's opinion: one or two sentences why, grounded in the repo. */
	opinion: string;
	by: string;
}

export interface AskDeps {
	ledger: Ledger;
	config: Config;
	/** Workspace root (repo brief); without it questions are phrased from the facts alone. */
	root?: string;
	client?: ModelClient;
}

// ---- repo brief ---------------------------------------------------------------------------------------

export function briefPath(root: string): string {
	return join(root, ".bigrefactor", "repo-brief.md");
}

export function loadBrief(root: string | undefined): string {
	if (!root) return "";
	const p = briefPath(root);
	return existsSync(p) ? readFileSync(p, "utf8") : "";
}

/** Facts the code can gather about the source repo, stack-neutral: tree with counts, readme, ledger stats. */
export function repoFacts(config: Config, ledger?: Ledger, root?: string, vendorDirs: string[] = []): string {
	const src = config.source.path;
	const skip = new Set(vendorDirs);
	const count = (dir: string, depth: number): number => {
		if (depth > 10) return 0;
		let n = 0;
		for (const name of safeList(dir)) {
			if (skip.has(name)) continue;
			const p = join(dir, name);
			n += isDir(p) ? count(p, depth + 1) : 1;
		}
		return n;
	};
	const tree: string[] = [];
	const walk = (dir: string, rel: string, depth: number) => {
		for (const name of safeList(dir).sort()) {
			if (skip.has(name) || name.startsWith(".")) continue;
			const p = join(dir, name);
			if (!isDir(p)) continue;
			const r = rel ? `${rel}/${name}` : name;
			const files = count(p, 0);
			if (files < 3) continue;
			tree.push(`${"  ".repeat(depth)}${r}/ (${files} files)`);
			if (depth < 2) walk(p, r, depth + 1);
		}
	};
	walk(src, "", 0);
	const readme = safeList(src).find((n) => /^readme(\.md|\.txt)?$/i.test(n));
	const answers = root && existsSync(join(root, ".bigrefactor", "decisions.json")) ? (JSON.parse(readFileSync(join(root, ".bigrefactor", "decisions.json"), "utf8")) as { answers?: Record<string, { answer: string }> }).answers ?? {} : {};
	// config holds provisional values until the owner decides: only decided ones are stated as facts
	const L = [`stack: ${config.source.stack}${config.source.framework ? ` / ${config.source.framework}` : ""}`, `target: ${answers["targets"] ? answers["targets"].answer.replace(/\+/g, " + ") : Object.entries(answers).filter(([k]) => k.startsWith("target:")).map(([k, a]) => `${k.slice(7)} → ${a.answer}`).join(", ") || "not decided yet"}`, `data stores: ${config.db.from.map((s) => `${s}${config.db.stores[s] ? ` (${config.db.stores[s]})` : ""}`).join(", ") || "none found"}${answers["db-strategy"] ? `; strategy ${answers["db-strategy"].answer}` : ""}`];
	if (Object.keys(answers).length) L.push(`owner decisions already made (binding facts): ${Object.entries(answers).map(([k, a]) => `${k}=${a.answer}`).join("; ")}`);
	if (ledger) {
		const kinds = ledger.db.prepare("SELECT json_extract(meta,'$.kind') k, COUNT(*) n FROM units GROUP BY k ORDER BY n DESC LIMIT 12").all() as Array<{ k: string | null; n: number }>;
		if (kinds.length) L.push(`units by kind: ${kinds.map((k) => `${k.k ?? "?"}=${k.n}`).join(", ")}`);
		const ext = ledger.db.prepare("SELECT lower(replace(path, rtrim(path, replace(path, '.', '')), '')) e, COUNT(*) n FROM files GROUP BY e ORDER BY n DESC LIMIT 12").all() as Array<{ e: string; n: number }>;
		if (ext.length) L.push(`files by extension: ${ext.map((x) => `.${x.e}=${x.n}`).join(", ")}`);
		const slices = ledger.getMeta("slice_plan");
		if (slices) L.push(`slices: ${(JSON.parse(slices) as Array<{ name: string; units: number }>).map((s) => `${s.name}(${s.units})`).join(", ")}`);
		const routes = ledger.db.prepare("SELECT path FROM index_routes WHERE side = 'source' LIMIT 40").all() as Array<{ path: string }>;
		if (routes.length) L.push(`sample routes: ${routes.map((r) => r.path).join(" ")}`);
	}
	L.push("", "directories:", ...tree.slice(0, 120));
	if (readme) L.push("", `${readme}:`, readFileSync(join(src, readme), "utf8").slice(0, 3000));
	return L.join("\n");
}

/** The model's understanding of the source repo; written once, refreshed with `force` (e.g. after re-inventory). */
export async function repoBrief(d: AskDeps, opts: { force?: boolean } = {}): Promise<{ brief: string; costUsd: number }> {
	if (!d.root) throw new Error("repoBrief needs the workspace root");
	const existing = loadBrief(d.root);
	if (existing && !opts.force) return { brief: existing, costUsd: 0 };
	const { getSourceAdapter } = await import("../adapters/registry.ts");
	const facts = repoFacts(d.config, d.ledger, d.root, getSourceAdapter(d.config.source.stack).traits?.vendorDirs);
	if (!d.client) return { brief: facts, costUsd: 0 };
	const role = d.config.models.escalate;
	const res = await d.client.chat({
		model: role.id,
		tier: role.tier as "default" | "flex" | "priority",
		effort: "medium",
		messages: [
			{ role: "system", content: "You are a senior engineer reading a legacy codebase before migrating it. Write what a migration lead must know, concretely, from the facts given. Owner decisions are settled facts: state them, never contradict them. No generic advice." },
			{ role: "user", content: `Facts gathered from the legacy repo:\n\n${facts}\n\nWrite a brief (≤ 60 lines, markdown) with sections: What the app does; Feature areas (name → directories); UI (how pages are produced, client-side code); Data (stores, how they are accessed); Cross-cutting (auth, i18n, jobs, files, external APIs); Odd patterns a migration will trip over; Open points a human must decide.` },
		],
	});
	const brief = res.text.trim();
	mkdirSync(dirname(briefPath(d.root)), { recursive: true });
	writeFileSync(briefPath(d.root), brief + "\n");
	return { brief, costUsd: res.usage.costUsd };
}

// ---- onboarding: phrase + discover --------------------------------------------------------------------

export interface DecisionPoint {
	id: string;
	topic: string;
	/** What is undecided, in the code's terms (input to the model). */
	intent: string;
	evidence: string;
	options: AskOption[];
	/** Set only when a model advised it (reason given); a code default never reaches the phrasing model. */
	recommended?: string;
	reason?: string;
}

export function pointHash(p: DecisionPoint): string {
	// option ORDER is presentation (recommended first), not a fact: sorted, so reordering never invalidates
	return createHash("sha1").update(JSON.stringify([p.id, p.intent, p.evidence, p.options.map((o) => o.value).sort()])).digest("hex").slice(0, 10);
}

const PHRASE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["questions"],
	properties: {
		questions: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id", "question", "options", "recommended", "opinion"],
				properties: {
					id: { type: "string" },
					question: { type: "string", description: "one question about THIS repo, plain words, mention the concrete evidence" },
					options: { type: "array", items: { type: "object", additionalProperties: false, required: ["value", "label", "hint"], properties: { value: { type: "string" }, label: { type: "string" }, hint: { type: "string" } } } },
					recommended: { type: "string", description: "one of the option values" },
					opinion: { type: "string", description: "1–2 sentences why, grounded in the repo" },
				},
			},
		},
	},
};

/** Turns code-detected decision points into repo-specific questions. Option values are kept; unknown values are dropped. */
export async function phraseDecisions(d: AskDeps, points: DecisionPoint[]): Promise<{ phrased: Record<string, PhrasedQuestion & { hash: string }>; costUsd: number }> {
	const out: Record<string, PhrasedQuestion & { hash: string }> = {};
	if (!d.client || !points.length) return { phrased: out, costUsd: 0 };
	const { brief } = await repoBrief(d);
	const role = d.config.models.escalate;
	let cost = 0;
	for (let i = 0; i < points.length; i += 12) {
		const batch = points.slice(i, i + 12);
		const res = await d.client.chat({
			model: role.id,
			tier: role.tier as "default" | "flex" | "priority",
			effort: "medium",
			schema: PHRASE_SCHEMA,
			messages: [
				{ role: "system", content: "You turn migration decision points into questions for the person who owns this legacy app. Each question must be answerable by someone who knows the app but not this tool. Use the repo brief; mention concrete files, features or counts. Keep every option value exactly as given; relabel options in plain words, never drop or invent values. Always recommend one option and give your opinion; where an analysis already advised one (advised, advised_because), agree or disagree with it on the evidence." },
				{ role: "user", content: `Repo brief:\n${brief}\n\nDecision points (JSON):\n${JSON.stringify(batch.map((p) => ({ id: p.id, topic: p.topic, intent: p.intent, evidence: p.evidence, options: p.options, ...(p.reason ? { advised: p.recommended, advised_because: p.reason } : {}) })), null, 1)}` },
			],
		});
		cost += res.usage.costUsd;
		const qs = ((res.json ?? {}) as { questions?: Array<{ id: string; question: string; options: Array<{ value: string; label: string; hint: string }>; recommended: string; opinion: string }> }).questions ?? [];
		for (const q of qs) {
			const p = batch.find((x) => x.id === q.id);
			if (!p) continue;
			const known = new Set(p.options.map((o) => o.value));
			const options = q.options.filter((o) => known.has(o.value)).map((o) => ({ value: o.value, label: o.label, hint: o.hint || undefined }));
			if (!options.length) continue;
			const recommended = options.some((o) => o.value === q.recommended) ? q.recommended : undefined;
			out[p.id] = { question: q.question, options: recommendedFirst(options, recommended), recommended, opinion: q.opinion, by: res.usage.model, hash: pointHash(p) };
		}
	}
	return { phrased: out, costUsd: cost };
}

/** Decisions the model sees in the repo that no code check asks about. Answers are binding context for rules. */
export async function discoverDecisions(d: AskDeps, covered: Array<{ id: string; question: string }>): Promise<{ discovered: Record<string, PhrasedQuestion & { evidence: string }>; costUsd: number }> {
	if (!d.client) return { discovered: {}, costUsd: 0 };
	const { brief, costUsd: briefCost } = await repoBrief(d);
	const role = d.config.models.escalate;
	const res = await d.client.chat({
		model: role.id,
		tier: role.tier as "default" | "flex" | "priority",
		effort: "medium",
		schema: {
			type: "object",
			additionalProperties: false,
			required: ["decisions"],
			properties: {
				decisions: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						required: ["slug", "question", "evidence", "options", "recommended", "opinion"],
						properties: {
							slug: { type: "string", description: "kebab-case id" },
							question: { type: "string" },
							evidence: { type: "string", description: "files/features in the brief that raise it" },
							options: { type: "array", items: { type: "object", additionalProperties: false, required: ["value", "label", "hint"], properties: { value: { type: "string", description: "kebab-case" }, label: { type: "string" }, hint: { type: "string" } } } },
							recommended: { type: "string" },
							opinion: { type: "string" },
						},
					},
				},
			},
		},
		messages: [
			{ role: "system", content: "You plan the migration of the legacy app described in the brief. Find decisions a human owner must make BEFORE agents migrate code, that are not already covered. Only decisions with real consequences for many files (behaviour, data, UX, scope). At most 6; none if nothing is missing. 2–4 options each, recommendation + opinion always." },
			{ role: "user", content: `Repo brief:\n${brief}\n\nTarget: ${d.config.target.stacks.join(" + ")} with ${JSON.stringify(d.config.target.choices)}.\n\nAlready asked:\n${covered.map((c) => `- ${c.id}: ${c.question}`).join("\n")}` },
		],
	});
	const out: Record<string, PhrasedQuestion & { evidence: string }> = {};
	for (const q of ((res.json ?? {}) as { decisions?: Array<{ slug: string; question: string; evidence: string; options: Array<{ value: string; label: string; hint: string }>; recommended: string; opinion: string }> }).decisions ?? []) {
		const id = `repo:${q.slug.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`;
		if (!q.options?.length || covered.some((c) => c.id === id)) continue;
		const options = q.options.map((o) => ({ value: o.value, label: o.label, hint: o.hint || undefined }));
		const recommended = options.some((o) => o.value === q.recommended) ? q.recommended : undefined;
		out[id] = { question: q.question, options: recommendedFirst(options, recommended), recommended, opinion: q.opinion, by: res.usage.model, evidence: q.evidence };
	}
	return { discovered: out, costUsd: briefCost + res.usage.costUsd };
}

// ---- run time -----------------------------------------------------------------------------------------

export interface AskRequest {
	point: string;
	unitId?: string;
	/** Everything the code knows: what happened, numbers, errors, paths. */
	facts: string;
	options: AskOption[];
	/** Code's or an agent's pick; the model may disagree and says so in its opinion. */
	recommended?: string;
	/** An agent's opinion to carry along (e.g. the tester's on a quirk). */
	agentOpinion?: string;
	blocks?: QuestionBlocks;
	askedBy: string;
	context?: Record<string, unknown>;
	/** The Jev decision this question labels (calibration). */
	decisionId?: number;
}

/** Phrase one question with a model and store it in the ledger. Options are stored as "value — label", recommendation first. */
export async function askViaModel(d: AskDeps, q: AskRequest): Promise<{ id: number; phrased: PhrasedQuestion; costUsd: number }> {
	const phrased = d.client ? await phraseOne(d, q) : unphrased(q);
	const id = d.ledger.askQuestion({
		unitId: q.unitId,
		point: q.point,
		question: phrased.question + (phrased.opinion ? `\nOpinion: ${phrased.opinion}` : ""),
		options: phrased.options.map((o) => `${o.value} — ${o.label}${o.value === phrased.recommended ? " (recommended)" : ""}`),
		context: { ...q.context, facts: q.facts, recommended: phrased.recommended, opinion: phrased.opinion, phrasedBy: phrased.by },
		blocks: q.blocks ?? "unit",
		askedBy: q.askedBy,
		decisionId: q.decisionId,
	});
	return { id, phrased, costUsd: (phrased as { costUsd?: number }).costUsd ?? 0 };
}

/** The machine value of an answer given to an askViaModel question ("drop — remove it" → "drop"). */
export function answerValue(answer: string | null | undefined): string {
	return (answer ?? "").split(/\s+—\s+|:\s/)[0]!.trim();
}

/**
 * Open questions grouped so one answer can serve several: identical questions, or model-phrased ones that ask
 * the same decision (same point, same option values, same recommendation) with per-unit wording. Groups keep
 * ledger order; a group whose texts differ is shown with every member so the owner can still go one by one.
 */
export function groupQuestions(rows: QuestionRow[]): QuestionRow[][] {
	const groups = new Map<string, QuestionRow[]>();
	for (const q of rows) {
		const values = q.options ? (JSON.parse(q.options) as string[]).map(answerValue).sort() : [];
		const rec = (q.context ? (JSON.parse(q.context) as { recommended?: string }).recommended : undefined) ?? "";
		const key = values.length ? `${q.point}\0${values.join("\0")}\0${rec}` : `${q.question}\0`;
		groups.set(key, [...(groups.get(key) ?? []), q]);
	}
	return [...groups.values()];
}

/** The row's own option string for an answer picked on another row of its group (same value, its own label). */
export function optionFor(q: QuestionRow, picked: string): string {
	const v = answerValue(picked);
	return (q.options ? (JSON.parse(q.options) as string[]) : []).find((o) => answerValue(o) === v) ?? picked;
}

async function phraseOne(d: AskDeps, q: AskRequest): Promise<PhrasedQuestion & { costUsd: number }> {
	const brief = loadBrief(d.root);
	const role = d.config.models.implement;
	try {
		const res = await d.client!.chat({
			model: role.id,
			tier: role.tier as "default" | "flex" | "priority",
			effort: "low",
			schema: { type: "object", additionalProperties: false, required: PHRASE_SCHEMA.properties.questions.items.required, properties: PHRASE_SCHEMA.properties.questions.items.properties },
			messages: [
				{ role: "system", content: "You ask the owner of a legacy app ONE question on behalf of an automated migration. Short, concrete, about this repo; say what happens with each answer. Keep option values exactly; label them in plain words. Always recommend one and give your opinion (agree or disagree with the agent's, with a reason)." },
				{ role: "user", content: `${brief ? `Repo brief:\n${brief.slice(0, 4000)}\n\n` : ""}Point: ${q.point}${q.unitId ? ` (unit ${q.unitId})` : ""}\nFacts:\n${q.facts}\n\nOptions: ${JSON.stringify(q.options)}\n${q.recommended ? `Current pick: ${q.recommended}\n` : ""}${q.agentOpinion ? `Agent's opinion: ${q.agentOpinion}\n` : ""}\nReturn id "${q.point}".` },
			],
		});
		const j = (res.json ?? {}) as { question?: string; options?: Array<{ value: string; label: string; hint: string }>; recommended?: string; opinion?: string };
		const known = new Set(q.options.map((o) => o.value));
		const options = (j.options ?? []).filter((o) => known.has(o.value)).map((o) => ({ value: o.value, label: o.label, hint: o.hint || undefined }));
		for (const o of q.options) if (!options.some((x) => x.value === o.value)) options.push({ value: o.value, label: o.facts ?? o.value, hint: undefined });
		if (!j.question) return { ...unphrased(q), costUsd: res.usage.costUsd };
		const recommended = known.has(j.recommended ?? "") ? j.recommended : q.recommended;
		return { question: j.question, options: recommendedFirst(options, recommended), recommended, opinion: j.opinion ?? q.agentOpinion ?? "", by: res.usage.model, costUsd: res.usage.costUsd };
	} catch {
		return { ...unphrased(q), costUsd: 0 };
	}
}

function unphrased(q: AskRequest): PhrasedQuestion {
	const options = q.options.map((o) => ({ value: o.value, label: o.facts ?? o.value }));
	return { question: `[${q.point}] ${q.facts}`, options: recommendedFirst(options, q.recommended), recommended: q.recommended, opinion: q.agentOpinion ?? "", by: "code" };
}

function recommendedFirst<T extends { value: string }>(options: T[], recommended?: string): T[] {
	return recommended ? [...options.filter((o) => o.value === recommended), ...options.filter((o) => o.value !== recommended)] : options;
}

function safeList(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}
function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}
