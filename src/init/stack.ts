import type { Config } from "../config.ts";
import type { ExternalDep, SourceAdapter, StackChoice, StackChoiceOption, TargetAdapter } from "../adapters/types.ts";

/**
 * Stack decisions, stack-neutral: which option every target's StackChoice resolved to (from config, else the
 * adapter default), what that means for docs and platform text, and which legacy libraries still lack a
 * decided successor. init asks for the open ones; docs, the framework plan and rules read the result.
 */
export interface ResolvedChoice {
	stack: string;
	choice: StackChoice;
	option: StackChoiceOption;
	fromConfig: boolean;
}

export function resolveChoices(target: TargetAdapter, choices: Config["target"]["choices"]): ResolvedChoice[] {
	const mine = choices[target.id] ?? {};
	return (target.stackChoices ?? []).map((choice) => {
		const picked = mine[choice.key];
		const option = choice.options.find((o) => o.id === picked) ?? choice.options.find((o) => o.id === choice.default) ?? choice.options[0]!;
		return { stack: target.id, choice, option, fromConfig: option.id === picked };
	});
}

/** Adapter platform map with the chosen options' overrides applied. */
export function effectivePlatform(target: TargetAdapter, choices: Config["target"]["choices"]): Record<string, string> {
	return Object.assign({}, target.platform ?? {}, ...resolveChoices(target, choices).map((r) => r.option.platform ?? {}));
}

/** Adapter base docs plus the chosen options' docs (deduped by url). */
export function effectiveDocs(target: TargetAdapter, choices: Config["target"]["choices"]): Array<{ name: string; url: string }> {
	const out = [...target.docs];
	for (const r of resolveChoices(target, choices)) for (const d of r.option.docs ?? []) if (!out.some((o) => o.url === d.url)) out.push(d);
	return out;
}

/** Legacy libraries with decisions.json applied; `open` = non-dev libraries still under review. */
export function libraryPlan(source: SourceAdapter, sourceRoot: string, decided: Record<string, { verdict: string; successor?: string }> = {}): { libraries: ExternalDep[]; open: ExternalDep[] } {
	const libraries = (source.externalDeps?.(sourceRoot) ?? []).map((l) => {
		const d = decided[l.name];
		if (!d) return l;
		// A decided drop/platform/port has no successor package.
		return { ...l, verdict: d.verdict as ExternalDep["verdict"], successor: d.verdict === "replace" ? d.successor : undefined, note: `${l.note ? l.note + "; " : ""}decided` };
	});
	return { libraries, open: libraries.filter((l) => !l.dev && l.verdict === "review") };
}

/** `nestjs.orm=typeorm,react.styling=tailwind` → config.target.choices shape. */
export function parseChoiceFlag(text: string | undefined): Config["target"]["choices"] {
	const out: Config["target"]["choices"] = {};
	for (const pair of (text ?? "").split(",").map((t) => t.trim()).filter(Boolean)) {
		const m = /^([a-z0-9_-]+)\.([a-z0-9_-]+)=(.+)$/i.exec(pair);
		if (!m) throw new Error(`bad --choose entry "${pair}" (want stack.key=option)`);
		(out[m[1]!] ??= {})[m[2]!] = m[3]!;
	}
	return out;
}

/** `phpmailer/phpmailer=nodemailer,setasign/fpdf=drop` → decision answers keyed `lib:<name>` (`replace:<pkg>` | platform | drop | port). */
export function parseReplaceFlag(text: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const pair of (text ?? "").split(",").map((t) => t.trim()).filter(Boolean)) {
		const i = pair.indexOf("=");
		if (i <= 0) throw new Error(`bad --replace entry "${pair}" (want lib=successor|platform|drop|port)`);
		const v = pair.slice(i + 1).trim();
		out[`lib:${pair.slice(0, i).trim()}`] = /^platform\b/i.test(v) ? "platform" : /^(drop|port)$/i.test(v) ? v.toLowerCase() : `replace:${v.replace(/^replace:/, "")}`;
	}
	return out;
}

/** Human/LLM-readable summary of the decisions, used by init output and the rules prompt. */
export function renderStackPlan(targets: TargetAdapter[], choices: Config["target"]["choices"], libraries: ExternalDep[]): string {
	const L: string[] = [];
	for (const t of targets) {
		const rs = resolveChoices(t, choices);
		if (!rs.length) continue;
		L.push(`${t.id}:`);
		for (const r of rs) L.push(`  ${r.choice.key.padEnd(12)} ${r.option.label}${r.option.hint ? ` — ${r.option.hint}` : ""}${r.fromConfig ? "" : "  (default)"}`);
	}
	const decided = libraries.filter((l) => l.verdict !== "review" && !l.dev);
	const open = libraries.filter((l) => l.verdict === "review" && !l.dev);
	if (decided.length) {
		L.push("libraries:");
		for (const l of decided) L.push(`  ${l.verdict.padEnd(8)} ${l.name.padEnd(32)} → ${l.successor ?? "—"}${l.note ? `  (${l.note})` : ""}`);
	}
	if (open.length) L.push(`libraries still undecided (br decide asks again): ${open.map((l) => l.name).join(", ")}`);
	return L.join("\n");
}

/** Everything init would ask, as data: for `br_init --dry-run` style callers (an LLM asks the user, then calls again with answers). */
export function stackQuestions(source: SourceAdapter, sourceRoot: string, targets: TargetAdapter[], choices: Config["target"]["choices"], decided: Record<string, { verdict: string; successor?: string }> = {}) {
	const stack = targets.flatMap((t) =>
		(t.stackChoices ?? []).map((c) => ({ stack: t.id, key: c.key, question: c.question, default: c.default, current: choices[t.id]?.[c.key], options: c.options.map((o) => ({ id: o.id, label: o.label, hint: o.hint })) })),
	);
	const { open } = libraryPlan(source, sourceRoot, decided);
	const libraries = open.map((l) => ({ name: l.name, version: l.version, note: l.note, answers: ["replace:<package>", "platform", "drop", "port"] }));
	return { stack, libraries };
}

/**
 * The same questions pre-shaped for an ask-user-question style dialog (Pi's `ask_user_question`: ≤4 questions
 * per call, 2–4 options each, header ≤16 chars, label ≤60, a free-text row appended by the tool). `values`
 * maps each option label back to what `br_init` expects in `choices` / `replacements`, so an agent can
 * forward answers without interpretation. Free-text answers for libraries are npm package names.
 */
export function askUserQuestionBatches(q: ReturnType<typeof stackQuestions>, targets: TargetAdapter[]) {
	const eco = (targets.find((t) => t.role === "server") ?? targets[0])?.toolchain.ecosystem ?? "package";
	type Opt = { label: string; description: string };
	type Question = { header: string; question: string; options: Opt[]; values: Record<string, string> };
	const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + "…");
	const gate: Question = {
		header: "Target stack",
		question: "Accept the adapter defaults for now (br advise judges them from the repo after inventory), or decide each item?",
		options: [
			{ label: "Accept the adapter defaults", description: targets.map((t) => `${t.id}: ${(t.stackChoices ?? []).map((c) => c.options.find((o) => o.id === c.default)?.label ?? c.default).join(", ")}`).join(" · ") },
			{ label: `Decide each item (${q.stack.length} questions)`, description: "Walk through ORM, database, styling, data fetching… one by one" },
		],
		values: { "Accept the adapter defaults": "accept", [`Decide each item (${q.stack.length} questions)`]: "each" },
	};
	const stack: Question[] = q.stack.map((s) => {
		const values: Record<string, string> = {};
		const options = s.options.slice(0, 4).map((o) => {
			const label = clip(o.id === s.default ? `${o.label} (adapter default)` : o.label, 60);
			values[label] = `${s.stack}.${s.key}=${o.id}`;
			return { label, description: o.hint ?? o.label };
		});
		return { header: clip(`${s.stack} ${s.key}`, 16), question: `${s.stack}: ${s.question}?`, options, values };
	});
	const libraries: Question[] = q.libraries.map((l) => {
		const values: Record<string, string> = {};
		const options: Opt[] = [];
		for (const [label, description, v] of [
			["Platform covers it", "the target framework already provides this", "platform"],
			["Drop", "usage is dead or not needed in the target", "drop"],
			["Decide later", "leave it to br decide after the inventory", "later"],
		] as const) {
			options.push({ label, description });
			values[label] = `${l.name}=${v}`;
		}
		return { header: clip(l.name.split("/").pop() ?? l.name, 16), question: `Successor for ${l.name}${l.version ? ` ${l.version}` : ""}${l.note ? ` (${l.note})` : ""}? Type a ${eco} package name for anything else.`, options: options.slice(0, 4), values };
	});
	const batch = <T,>(xs: T[]) => Array.from({ length: Math.ceil(xs.length / 4) }, (_, i) => xs.slice(i * 4, i * 4 + 4));
	return { gate, stack: batch(stack), libraries: batch(libraries) };
}
