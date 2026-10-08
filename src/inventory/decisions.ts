import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { effectivePlatform } from "../init/stack.ts";
import type { SourceAdapter, TargetAdapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import type { Ledger } from "../ledger/db.ts";
import { planFrameworks } from "./frameworks.ts";
import { TARGET_ROLES } from "../adapters/registry.ts";
import { pointHash, type DecisionPoint, type PhrasedQuestion } from "../jev/ask.ts";
import { JEV_ACT } from "../jev/questions.ts";

/**
 * Decision gate. Everything the inventory cannot decide from code alone is derived here as a typed
 * question with options and a recommendation; `br run` and `br simulate --level 3` refuse while any is
 * open (nothing is silently defaulted). Answers live in `.bigrefactor/decisions.json` (workspace, never
 * in a repo), are mirrored into the ledger `questions` table (point `decision:<id>`, blocks nothing), and
 * are applied to config / slices / framework plan by `applyDecision`.
 *
 * Code only detects WHAT is undecided (`question` here is the code's intent, never shown as-is once a model
 * ran): `br advise` has a model that read the repo phrase every point for this repo (`phrased`, keyed by a
 * hash of the facts so changed facts are re-phrased) and add decision points the code did not foresee
 * (`discovered`, ids `repo:<slug>`; their answers are binding context for rules generation).
 */
export interface Decision {
	id: string;
	topic: "data" | "framework" | "library" | "slicing" | "truth" | "target" | "repo";
	question: string;
	options: Array<{ value: string; label: string; hint?: string }>;
	recommended?: string;
	/** Why the recommendation (model reason or Jev confidence); empty for code-only defaults. */
	reason?: string;
	confidence?: number;
	/** What in the inventory triggered this. */
	evidence: string;
	/** The recommendation is a model's judgment of the repo (not the code's offline fallback). */
	advised?: boolean;
}

export interface DecisionAnswer { answer: string; by: string; at: string }
export type DecisionFile = { advice?: Record<string, { value: string; reason?: string; confidence?: number }>; dimensions?: import("../init/survey.ts").Dimension[]; phrased?: Record<string, PhrasedQuestion & { hash: string }>; discovered?: Record<string, PhrasedQuestion & { evidence: string }>; survey?: { targets: string[]; dbStrategy: string; dbFrom: string[]; why: string[] }; answers: Record<string, DecisionAnswer>; libraries?: Record<string, { verdict: string; successor?: string }>; frameworkClasses?: Record<string, string>; truth?: Record<string, string>; target?: Record<string, string>; strategy?: Record<string, string>; /** Jev on files the reachability walk dropped (src/init/dead.ts): alive ones are entry points. */ liveness?: Record<string, { alive: boolean; why: string }> };

export function decisionsPath(root: string): string {
	return join(root, ".bigrefactor", "decisions.json");
}
export function loadDecisions(root: string): DecisionFile {
	const p = decisionsPath(root);
	return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as DecisionFile) : { answers: {} };
}
function saveDecisions(root: string, d: DecisionFile): void {
	mkdirSync(dirname(decisionsPath(root)), { recursive: true });
	writeFileSync(decisionsPath(root), JSON.stringify(d, null, 2) + "\n");
}

/**
 * An answer given at init, before any ledger exists (library successors from the stack interview).
 * Recorded in decisions.json only; `openDecisions` then no longer asks it. `replace:<pkg>`, `platform`,
 * `drop` and `port` are the accepted forms, same as the gate.
 */
export function recordEarlyDecision(root: string, id: string, answer: string, by = "init"): void {
	const d = loadDecisions(root);
	d.answers[id] = { answer, by, at: new Date().toISOString() };
	if (id.startsWith("lib:")) {
		d.libraries ??= {};
		const m = /^replace:(.+)$/.exec(answer);
		d.libraries[id.slice(4)] = m ? { verdict: "replace", successor: m[1]!.trim() } : { verdict: answer };
	}
	saveDecisions(root, d);
}

/** `raw` = the code's points without the model's phrasing (input for `br advise`). */
export function openDecisions(ledger: Ledger, config: Config, source: SourceAdapter, targets: TargetAdapter[], root: string, opts: { raw?: boolean } = {}): Decision[] {
	process.env["BR_WORKSPACE"] = root; // the generated framework profile lives in this workspace
	const answered = loadDecisions(root).answers;
	const out: Decision[] = [];
	const plan = planFrameworks(ledger, source, targets, config.source.path, loadDecisions(root), config.target.choices);
	const platform = Object.assign({}, ...targets.map((t) => effectivePlatform(t, config.target.choices))) as Record<string, string>;
	const concernOptions = [...Object.keys(platform).map((k) => ({ value: `platform:${k}`, label: `platform → ${k}`, hint: platform[k] })), { value: "port", label: "port: application logic, becomes units' responsibility (service/helper in target)" }, { value: "drop", label: "drop: obsolete in the target" }];

	// --- where each part of the app goes: one decision per dimension the model rated from the repo (advise →
	// dimensions), candidates by score. The code adds the adapters it has for server/ui; a pick without one gets
	// an adapter generated at onboarding. Without a model run (offline) only server/ui, from the adapters.
	const file0 = loadDecisions(root);
	const survey = file0.survey;
	const dims = file0.dimensions ?? [];
	const byRole = (role: string) => Object.keys(TARGET_ROLES).filter((k) => TARGET_ROLES[k] === role);
	const adapterNote = (id: string) => (id === "none" || id in TARGET_ROLES ? "" : "no bigrefactor adapter yet: one is generated and verified when you pick it");
	for (const key of ["server", "ui"]) {
		if (dims.some((d) => d.key === key)) continue;
		const ids = key === "ui" ? [...byRole("ui"), "none"] : byRole("server");
		const provisional = config.target.stacks.find((s) => TARGET_ROLES[s] === key) ?? (key === "ui" ? "none" : ids[0]);
		out.push({ id: `target:${key}`, topic: "target", question: `Which ${key} stack should the new codebase use?`, evidence: survey?.why.join("; ") ?? `config: ${config.target.stacks.join("+")}`, recommended: provisional, options: ids.map((v) => ({ value: v, label: v })) });
	}
	for (const d of dims) {
		const options = d.candidates.map((c) => ({ value: c.id, label: `${c.id} — ${c.score}/100`, hint: [c.reason, d.key === "server" || d.key === "ui" ? adapterNote(c.id) : ""].filter(Boolean).join(" · ") }));
		if (d.key === "server" || d.key === "ui") for (const id of [...byRole(d.key), ...(d.key === "ui" ? ["none"] : [])]) if (!options.some((o) => o.value === id)) options.push({ value: id, label: `${id} — not rated`, hint: "bigrefactor adapter available" });
		const top = d.candidates[0]!;
		out.push({ id: `target:${d.key}`, topic: "target", question: `${d.key}: where should it go? (today: ${d.now})`, evidence: `rated from the repo: ${d.candidates.map((c) => `${c.id} ${c.score}`).join(", ")}`, recommended: top.id, reason: top.reason, advised: true, options });
	}
	out.push({ id: "db-strategy", topic: "data", question: "Database strategy?", evidence: survey?.dbFrom.length ? `data stores found: ${survey.dbFrom.join(", ")}` : "no data store found", recommended: survey?.dbStrategy ?? config.db.strategy, options: [{ value: "keep-schema", label: "keep the schema", hint: "introspect the existing DB, generate DTOs, translate types" }, { value: "new-schema", label: "new schema", hint: "design a target schema per module after keep-schema is accepted" }, { value: "none", label: "no database" }] });
	for (const t of targets)
		for (const c of t.stackChoices ?? []) if (c.options.length > 1) out.push({ id: `stack:${t.id}.${c.key}`, topic: "target", question: `${t.id}: ${c.question}`, evidence: `${c.options.length} options from the ${t.id} adapter`, recommended: c.options.some((o) => o.id === config.target.choices[t.id]?.[c.key]) ? config.target.choices[t.id]![c.key]! : c.default, options: c.options.map((o) => ({ value: o.id, label: o.label, hint: o.hint })) });

	// --- data stores beyond the target engine
	const target = (config.db.to ?? "").toLowerCase();
	const sameFamily = (a: string, b: string) => /mysql|maria/.test(a) && /mysql|maria/.test(b) || /postgres|pg/.test(a) && /postgres|pg/.test(b) || a === b;
	for (const store of config.db.from) {
		if (dims.some((d) => d.key === `data:${store}`)) continue; // rated as a dimension: target:data:<store>
		if (sameFamily(store.toLowerCase(), target)) continue;
		if (store.toLowerCase() === "mariadb" || store.toLowerCase() === "mysql") continue; // relational → relational is the keep-schema translation path, not a decision
		out.push({ id: `store:${store}`, topic: "data", question: `${store} is a second data store. What happens to it?`, evidence: `config.db.from includes ${store}; target engine ${config.db.to ?? "unset"}`, recommended: "keep", options: [{ value: "keep", label: `keep ${store}, new client library`, hint: "lowest risk; its commands port as services" }, { value: "fold", label: `fold into ${config.db.to ?? "the target DB"}`, hint: "new-schema path (JSONB tables + ETL); larger scope" }, { value: "drop", label: "drop: its features are dead", hint: "only if the inventory shows no live referrers" }] });
	}

	// --- framework concerns under review and unmapped classes
	for (const c of plan.concerns) if (c.verdict === "review" && c.appRefs > 0) out.push({ id: `concern:${c.concern}`, topic: "framework", question: `Framework concern "${c.concern}" (${c.legacy}) is referenced ${c.appRefs}× from ${c.appFiles} files. Verdict?`, evidence: `top: ${c.top.join(", ")}`, options: [...concernOptions] });
	const advisedIds = new Set(Object.keys((loadDecisions(root) as { advice?: Record<string, unknown> }).advice ?? {}));
	const big = plan.unmapped.filter((u) => u.appRefs >= 50 || advisedIds.has(`fw:${u.name}`));
	for (const u of big) out.push({ id: `fw:${u.name}`, topic: "framework", question: `Framework class ${u.name} (${u.appRefs} app references) has no concern mapping. Which concern / verdict?`, evidence: u.path, options: [...concernOptions] });
	const small = plan.unmapped.filter((u) => u.appRefs < 50 && !advisedIds.has(`fw:${u.name}`));
	if (small.length) out.push({ id: "fw:rest", topic: "framework", question: `${small.length} low-use framework classes (<50 refs each) are unmapped. Map them by name heuristic?`, evidence: small.slice(0, 12).map((u) => `${u.name}(${u.appRefs})`).join(", ") + (small.length > 12 ? " …" : ""), recommended: "heuristic", options: [{ value: "heuristic", label: "map by name heuristic, implementer may deviate with a why", hint: "recorded per class in decisions.json" }, { value: "review-each", label: "ask me for each one", hint: `${small.length} more questions` }, { value: "port", label: "treat all as port (logic to carry over)" }] });

	// --- libraries under review
	// dev tools of the legacy repo (its test/lint tooling) are not migrated: nothing to decide for them
	for (const l of plan.libraries) if (!l.dev && (l.verdict === "review" || advisedIds.has(`lib:${l.name}`) && !loadDecisions(root).libraries?.[l.name])) out.push({ id: `lib:${l.name}`, topic: "library", question: `Library ${l.name}${l.version ? ` ${l.version}` : ""}: successor?`, evidence: l.note ?? "no known successor", recommended: l.successor ? `replace:${l.successor}` : undefined, options: [...(l.successor ? [{ value: `replace:${l.successor}`, label: `replace with ${l.successor}` }] : []), { value: "platform", label: "the target platform already covers it" }, { value: "port", label: "port: rewrite the parts the app uses" }, { value: "drop", label: "drop: usage is dead or not needed" }] });

	// --- cycles: forward references vs merging pairs
	const cutUnits = (ledger.db.prepare("SELECT COUNT(*) n FROM units WHERE json_array_length(json_extract(meta,'$.cutDeps')) > 0").get() as { n: number }).n;
	if (cutUnits > 0 && source.unitGroupOf) out.push({ id: "cycle-cuts", topic: "slicing", question: `${cutUnits} units carry forward references from cycle cutting. Strategy?`, evidence: `${cutUnits} units with cut dependency edges`, recommended: "merge-groups", options: [{ value: "merge-groups", label: "merge naturally paired files into one unit, cut the rest", hint: "fewer forward references; units up to ~2× bigger" }, { value: "forward-refs", label: "keep whole-file units; implementer codes against interfaces", hint: "more units touch an interface twice" }] });

	// --- dynamic slice
	const slicePlan = ledger.getMeta("slice_plan");
	const dyn = slicePlan ? (JSON.parse(slicePlan) as Array<{ name: string; units: number; loc: number }>).find((s) => s.name === "dynamic") : undefined;
	if (dyn && dyn.units > 0) out.push({ id: "dynamic-slice", topic: "slicing", question: `${dyn.units} units (${dyn.loc} LOC) are reached from no route (console commands, modules, scripts). Where do they go?`, evidence: "slice `dynamic`", recommended: "by-directory", options: [{ value: "by-directory", label: "attach each to the feature owning its directory; rest → foundation", hint: "written to .bigrefactor/slices.json" }, { value: "foundation", label: "all into foundation (migrate early)" }, { value: "last", label: "leave as last slice, human review before each" }] });

	// --- truth environment
	const compose = findCompose(config.source.path);
	out.push({ id: "truth-env", topic: "truth", question: "Truth needs the legacy app runnable. What exists?", evidence: compose ? `docker compose found: ${compose}` : "no docker compose found", recommended: compose ? "docker-dump" : "none", options: [{ value: "docker-dump", label: "docker compose + a DB dump I can provide", hint: "recorded HTTP responses + the legacy test suite on the old code" }, { value: "docker-only", label: "docker compose, schema only (no data dump yet)", hint: "unit truth now, goldens later" }, { value: "none", label: "nothing runnable locally", hint: "tester-written characterization tests on pure code only" }] });

	// --- target location
	if (/\/\.sim\//.test(config.target.path)) out.push({ id: "target-location", topic: "target", question: `Target is ${relative(root, config.target.path) || config.target.path} (simulation dir). Fine for L3 sampling?`, evidence: "L3 never merges into a real repo", recommended: "sim-ok", options: [{ value: "sim-ok", label: "yes, decide the real location after L3" }, { value: "set-now", label: "set the real path now (answer `set:<absolute path>`)" }] });


	// model advice (br advise) replaces the static defaults; an advised value outside the options is added as one
	const advice = (loadDecisions(root) as { advice?: Record<string, { value: string; reason?: string; confidence?: number }> }).advice ?? {};
	for (const d of out) {
		const a = advice[d.id];
		if (!a) continue;
		// an unsure Jev pick (below the act line, after a second opinion) is no recommendation, even when it matches the code's fallback: the
		// phrasing model (which read the repo brief) recommends instead; the doubt stays visible
		if (a.confidence !== undefined && a.confidence < JEV_ACT) {
			d.reason = `decision model unsure (${Math.round(a.confidence * 100)}% for ${a.value})`;
			d.confidence = a.confidence;
			continue;
		}
		if (!d.options.some((o) => o.value === a.value)) d.options.unshift({ value: a.value, label: a.value.replace(/^replace:/, "replace with "), hint: "advised" });
		d.recommended = a.value;
		d.reason = a.reason;
		d.confidence = a.confidence;
		d.advised = true;
	}
	// every decision carries a recommendation: a model's (above / phrasing below); without one (offline) the
	// code's fallback, labelled as such so nobody reads it as a judgment of the repo
	for (const d of out) if (!d.recommended || !d.options.some((o) => o.value === d.recommended)) {
		if (d.recommended && !d.options.some((o) => o.value === d.recommended)) d.options.unshift({ value: d.recommended, label: d.recommended });
		else {
			d.recommended = d.id.startsWith("lib:") ? "port" : d.options[0]!.value;
			d.reason ??= "offline fallback: no model has judged this for the repo yet (br advise)";
		}
	}
	// the model's phrasing for this repo replaces the code's intent text; facts changed since → code text stays until re-advised
	const file = loadDecisions(root);
	const ids = new Set(out.map((d) => d.id));
	if (!opts.raw) for (const d of out) {
		const ph = file.phrased?.[d.id];
		if (!ph || ph.hash !== pointHash(toPoint(d))) continue;
		const labels = new Map(ph.options.map((o) => [o.value, o]));
		// relabelled in the repo's words; every option stays (a one-option question is no question)
		// a rating (" — 82/100", " — not rated") is a fact, not wording: it survives the relabel
		const rating = (l: string) => / — (\d+\/100|not rated)$/.exec(l)?.[0] ?? "";
		d.options = d.options.map((o) => {
			const label = labels.get(o.value)?.label;
			return { value: o.value, label: label ? label + (rating(label) ? "" : rating(o.label)) : o.label, hint: labels.get(o.value)?.hint ?? o.hint };
		});
		d.question = ph.question;
		// the phrasing model read the repo: its pick replaces the code fallback, not a confident analysis
		if (!d.advised && ph.recommended && d.options.some((o) => o.value === ph.recommended)) {
			d.recommended = ph.recommended;
			d.advised = true;
		}
		d.reason = d.reason && advice[d.id] ? `${d.reason.replace(/\.\s*$/, "")}. ${ph.opinion}` : ph.opinion;
	}
	for (const [id, q] of Object.entries(file.discovered ?? {})) {
		if (ids.has(id) || opts.raw) continue;
		out.push({ id, topic: "repo", question: q.question, evidence: q.evidence, options: q.options, recommended: q.recommended ?? q.options[0]?.value, reason: q.opinion, advised: !!q.recommended });
	}
	// recommended option first: in a multiple-choice prompt, Enter takes it
	for (const d of out) d.options.sort((a, b) => Number(b.value === d.recommended) - Number(a.value === d.recommended));
	return out.filter((d) => !answered[d.id]);
}

/** The code's view of a decision, as the phrasing model gets it. */
export function toPoint(d: Decision): DecisionPoint {
	// the code's fallback pick is not passed on: it would anchor the model reading the repo
	return { id: d.id, topic: d.topic, intent: d.question, evidence: d.evidence, options: d.options.map((o) => ({ value: o.value, facts: `${o.label}${o.hint ? ` — ${o.hint}` : ""}` })), ...(d.advised ? { recommended: d.recommended, reason: d.reason } : {}) };
}


export function applyDecision(ledger: Ledger, config: Config, root: string, id: string, answer: string, by = "human"): string {
	const d = loadDecisions(root);
	d.answers[id] = { answer, by, at: new Date().toISOString() };
	let note = "";
	const configPath = join(root, "bigrefactor.config.json");
	const raw = JSON.parse(readFileSync(configPath, "utf8"));
	const [kind, ...rest] = id.split(":");
	const key = rest.join(":");
	if (kind === "store") {
		raw.db ??= {};
		raw.db.stores ??= {};
		raw.db.stores[key] = answer;
		note = `config.db.stores.${key} = ${answer}`;
	} else if (kind === "target") {
		// server/ui → the target stacks (server first); data:<store> → target engine / store verdict; other
		// dimensions are binding facts for advice and rules
		const roleOf = (sid: string) => TARGET_ROLES[sid] ?? (d.answers["target:server"]?.answer === sid ? "server" : d.answers["target:ui"]?.answer === sid ? "ui" : undefined);
		if (key === "server" || key === "ui") {
			const keep = (raw.target.stacks as string[]).filter((sid) => roleOf(sid) !== key && sid !== answer);
			const server = key === "server" ? answer : keep.find((sid) => roleOf(sid) === "server");
			const ui = key === "ui" ? (answer === "none" ? undefined : answer) : keep.find((sid) => roleOf(sid) === "ui");
			raw.target.stacks = [server, ui].filter(Boolean);
			// choices of a stack no longer targeted go with it (their packages would otherwise be installed)
			for (const sid of Object.keys(raw.target.choices ?? {})) if (!raw.target.stacks.includes(sid)) delete raw.target.choices[sid];
			note = `config.target.stacks = ${raw.target.stacks.join(", ")}`;
		} else if (key.startsWith("data:")) {
			const store = key.slice(5);
			raw.db ??= {};
			const primary = (raw.db.from ?? [])[0];
			if (store === primary) {
				raw.db.to = answer === "drop" ? raw.db.to : answer;
				note = `config.db.to = ${raw.db.to}`;
			} else {
				raw.db.stores ??= {};
				raw.db.stores[store] = answer === "drop" ? "drop" : answer === store ? "keep" : answer === raw.db.to ? "fold" : "keep";
				note = `config.db.stores.${store} = ${raw.db.stores[store]}${raw.db.stores[store] === "keep" && answer !== store ? ` (moves to ${answer}: binding for rules)` : ""}`;
			}
		} else note = `${id} = ${answer} (binding for advice and rules)`;
	} else if (id === "db-strategy") {
		raw.db ??= {};
		raw.db.strategy = answer;
		note = `config.db.strategy = ${answer}`;
	} else if (kind === "stack") {
		const [t, k] = key.split(".");
		raw.target.choices ??= {};
		(raw.target.choices[t!] ??= {})[k!] = answer;
		if (k === "database") raw.db.to = answer === "postgres" ? "postgresql" : answer === "mysql" ? ((raw.db.from ?? []).includes("mariadb") ? "mariadb" : "mysql") : answer === "legacy" ? (raw.db.from ?? [])[0] : answer;
		note = `config.target.choices.${t}.${k} = ${answer}`;
	} else if (kind === "concern" || kind === "fw") {
		d.frameworkClasses ??= {};
		d.frameworkClasses[key] = answer;
		note = `${key} → ${answer}`;
	} else if (kind === "lib") {
		d.libraries ??= {};
		const m = /^replace:(.+)$/.exec(answer);
		d.libraries[key] = m ? { verdict: "replace", successor: m[1]!.trim() } : { verdict: answer };
		note = `${key} → ${answer}`;
	} else if (id === "cycle-cuts") {
		raw.inventory ??= {};
		raw.inventory.mergeGroups = answer === "merge-groups";
		note = `inventory.mergeGroups = ${raw.inventory.mergeGroups} (re-run br inventory)`;
	} else if (id === "dynamic-slice") {
		d.strategy ??= {};
		d.strategy["dynamic"] = answer;
		if (answer !== "last") note = writeDynamicOverrides(ledger, root, answer);
	} else if (id === "truth-env") {
		d.truth = { env: answer, compose: findCompose(config.source.path) ?? "" };
		note = `truth.env = ${answer}`;
	} else if (id === "target-location") {
		const m = /^set:(.+)$/.exec(answer);
		if (m) {
			raw.target.path = m[1]!.trim();
			note = `config.target.path = ${raw.target.path}`;
		}
	} else if (kind === "repo") {
		note = `${id} = ${answer} (binding for rules)`;
	}
	writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n");
	saveDecisions(root, d);
	// mirror into the ledger so br questions / br why / the dashboard see the full history
	const open = ledger.openQuestions().find((q) => q.point === `decision:${id}`);
	const qid = open?.id ?? ledger.askQuestion({ point: `decision:${id}`, question: id, blocks: "none", askedBy: "inventory" });
	ledger.answerQuestion(qid, answer, by);
	return note;
}

export function renderDecisions(ds: Decision[]): string {
	if (!ds.length) return "no open decisions";
	const L = [`${ds.length} open decision${ds.length === 1 ? "" : "s"} (br run / simulate --level 3 wait for them):`];
	for (const d of ds) {
		L.push("", `[${d.id}] ${d.question}`, `   evidence: ${d.evidence}`);
		if (d.reason) L.push(`   advice: ${d.recommended} — ${d.reason}`);
		for (const o of d.options) L.push(`   ${o.value === d.recommended ? "*" : " "} ${o.value.padEnd(22)} ${o.label}${o.hint ? `  (${o.hint})` : ""}`);
	}
	L.push("", "answer: br decide --answer <id>=<value> [...]   interactive: br decide");
	return L.join("\n");
}

// ---- helpers

function findCompose(root: string): string | undefined {
	for (const c of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml", "docker/docker-compose.yml", "docker/docker-compose.yaml"]) if (existsSync(join(root, c))) return c;
	return undefined;
}

/** dynamic units → feature owning the longest shared directory prefix (else foundation); written as slices.json overrides. */
function writeDynamicOverrides(ledger: Ledger, root: string, mode: string): string {
	const units = ledger.listUnits().map((u) => ({ id: u.id, meta: JSON.parse(u.meta) as { files?: string[]; slice?: string } }));
	const dirOwner = new Map<string, Map<string, number>>();
	for (const u of units) {
		if (!u.meta.slice || u.meta.slice === "dynamic" || u.meta.slice === "foundation") continue;
		for (const f of u.meta.files ?? []) {
			const parts = f.split("/");
			for (let i = 1; i < parts.length; i++) {
				const d = parts.slice(0, i).join("/");
				const m = dirOwner.get(d) ?? dirOwner.set(d, new Map()).get(d)!;
				m.set(u.meta.slice, (m.get(u.meta.slice) ?? 0) + 1);
			}
		}
	}
	const p = join(root, ".bigrefactor", "slices.json");
	const overrides = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
	overrides.overrides ??= {};
	let n = 0;
	for (const u of units) {
		if (u.meta.slice !== "dynamic") continue;
		let target = "foundation";
		if (mode === "by-directory") {
			const f = u.meta.files?.[0] ?? "";
			const parts = f.split("/");
			for (let i = parts.length - 1; i >= 1; i--) {
				const owners = dirOwner.get(parts.slice(0, i).join("/"));
				if (owners) { target = [...owners.entries()].sort((a, b) => b[1] - a[1])[0]![0]; break; }
			}
		}
		overrides.overrides[u.id] = target;
		n++;
	}
	writeFileSync(p, JSON.stringify(overrides, null, 2) + "\n");
	return `${n} dynamic units assigned in .bigrefactor/slices.json (re-run br order)`;
}
