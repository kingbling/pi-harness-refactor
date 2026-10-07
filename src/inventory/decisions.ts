import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { effectivePlatform } from "../init/stack.ts";
import type { SourceAdapter, TargetAdapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import type { Ledger } from "../ledger/db.ts";
import { planFrameworks } from "./frameworks.ts";
import { TARGET_SUBDIRS } from "../adapters/registry.ts";
import { pointHash, type DecisionPoint, type PhrasedQuestion } from "../jev/ask.ts";

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
	topic: "data" | "frontend" | "framework" | "library" | "slicing" | "truth" | "target" | "budget" | "repo";
	question: string;
	options: Array<{ value: string; label: string; hint?: string }>;
	recommended?: string;
	/** Why the recommendation (model reason or Jev confidence); empty for code-only defaults. */
	reason?: string;
	confidence?: number;
	/** What in the inventory triggered this. */
	evidence: string;
}

export interface DecisionAnswer { answer: string; by: string; at: string }
export type DecisionFile = { phrased?: Record<string, PhrasedQuestion & { hash: string }>; discovered?: Record<string, PhrasedQuestion & { evidence: string }>; survey?: { targets: string[]; dbStrategy: string; dbFrom: string[]; why: string[] }; answers: Record<string, DecisionAnswer>; libraries?: Record<string, { verdict: string; successor?: string }>; frameworkClasses?: Record<string, string>; truth?: Record<string, string>; target?: Record<string, string>; strategy?: Record<string, string> };

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

	// --- the stack itself: provisional values from the init survey, confirmed here after data gathering
	const survey = loadDecisions(root).survey;
	const combos = targetCombos();
	const current = config.target.stacks.join("+");
	if (combos.length > 1) out.push({ id: "targets", topic: "target", question: "Which target stacks?", evidence: survey?.why.join("; ") ?? `config: ${current}`, recommended: survey?.targets.join("+") ?? current, options: combos.map((c) => ({ value: c, label: c.replace(/\+/g, " + ") })) });
	out.push({ id: "db-strategy", topic: "data", question: "Database strategy?", evidence: survey?.dbFrom.length ? `data stores found: ${survey.dbFrom.join(", ")}` : "no data store found", recommended: survey?.dbStrategy ?? config.db.strategy, options: [{ value: "keep-schema", label: "keep the schema", hint: "introspect the existing DB, generate DTOs, translate types" }, { value: "new-schema", label: "new schema", hint: "design a target schema per module after keep-schema is accepted" }, { value: "none", label: "no database" }] });
	for (const t of targets)
		for (const c of t.stackChoices ?? []) out.push({ id: `stack:${t.id}.${c.key}`, topic: "target", question: `${t.id}: ${c.question}`, evidence: `${c.options.length} options from the ${t.id} adapter`, recommended: c.options.some((o) => o.id === config.target.choices[t.id]?.[c.key]) ? config.target.choices[t.id]![c.key]! : c.default, options: c.options.map((o) => ({ value: o.id, label: o.label, hint: o.hint })) });

	// --- data stores beyond the target engine
	const target = (config.db.to ?? "").toLowerCase();
	const sameFamily = (a: string, b: string) => /mysql|maria/.test(a) && /mysql|maria/.test(b) || /postgres|pg/.test(a) && /postgres|pg/.test(b) || a === b;
	for (const store of config.db.from) {
		if (sameFamily(store.toLowerCase(), target)) continue;
		if (store.toLowerCase() === "mariadb" || store.toLowerCase() === "mysql") continue; // relational → relational is the keep-schema translation path, not a decision
		out.push({ id: `store:${store}`, topic: "data", question: `${store} is a second data store. What happens to it?`, evidence: `config.db.from includes ${store}; target engine ${config.db.to ?? "unset"}`, recommended: "keep", options: [{ value: "keep", label: `keep ${store}, new client library`, hint: "lowest risk; its commands port as services" }, { value: "fold", label: `fold into ${config.db.to ?? "the target DB"}`, hint: "new-schema path (JSONB tables + ETL); larger scope" }, { value: "drop", label: "drop: its features are dead", hint: "only if the inventory shows no live referrers" }] });
	}

	// --- frontend
	const fe = countFrontendFiles(config.source.path);
	const hasWeb = targets.some((t) => t.platform?.["rendering"]?.toLowerCase().includes("component"));
	if (fe.total > 0 && !hasWeb && targetCombos().length <= 1) out.push({ id: "frontend", topic: "frontend", question: `The legacy app has UI (${fe.summary}). Which web target?`, evidence: fe.summary, recommended: "react", options: [{ value: "react", label: "React + TypeScript (adds target stack react)", hint: "existing Vue/templates rewritten as React features" }, { value: "vue", label: "Vue 3 + TypeScript", hint: "needs a vue target adapter; keeps existing Vue components" }, { value: "backend-only", label: "backend only for now", hint: "templates become JSON endpoints + contract; UI later" }] });

	// --- framework concerns under review and unmapped classes
	for (const c of plan.concerns) if (c.verdict === "review" && c.appRefs > 0) out.push({ id: `concern:${c.concern}`, topic: "framework", question: `Framework concern "${c.concern}" (${c.legacy}) is referenced ${c.appRefs}× from ${c.appFiles} files. Verdict?`, evidence: `top: ${c.top.join(", ")}`, options: concernOptions });
	const advisedIds = new Set(Object.keys((loadDecisions(root) as { advice?: Record<string, unknown> }).advice ?? {}));
	const big = plan.unmapped.filter((u) => u.appRefs >= 50 || advisedIds.has(`fw:${u.name}`));
	for (const u of big) out.push({ id: `fw:${u.name}`, topic: "framework", question: `Framework class ${u.name} (${u.appRefs} app references) has no concern mapping. Which concern / verdict?`, evidence: u.path, recommended: guessConcern(u.name, Object.keys(platform)), options: concernOptions });
	const small = plan.unmapped.filter((u) => u.appRefs < 50 && !advisedIds.has(`fw:${u.name}`));
	if (small.length) out.push({ id: "fw:rest", topic: "framework", question: `${small.length} low-use framework classes (<50 refs each) are unmapped. Map them by name heuristic?`, evidence: small.slice(0, 12).map((u) => `${u.name}(${u.appRefs})`).join(", ") + (small.length > 12 ? " …" : ""), recommended: "heuristic", options: [{ value: "heuristic", label: "map by name heuristic, implementer may deviate with a why", hint: "recorded per class in decisions.json" }, { value: "review-each", label: "ask me for each one", hint: `${small.length} more questions` }, { value: "port", label: "treat all as port (logic to carry over)" }] });

	// --- libraries under review
	for (const l of plan.libraries) if (l.verdict === "review" || advisedIds.has(`lib:${l.name}`) && !loadDecisions(root).libraries?.[l.name]) out.push({ id: `lib:${l.name}`, topic: "library", question: `Library ${l.name}${l.version ? ` ${l.version}` : ""}: successor?`, evidence: l.note ?? "no known successor", recommended: l.successor ? `replace:${l.successor}` : undefined, options: [...(l.successor ? [{ value: `replace:${l.successor}`, label: `replace with ${l.successor}` }] : []), { value: "platform", label: "the target platform already covers it" }, { value: "port", label: "port: rewrite the parts the app uses" }, { value: "drop", label: "drop: usage is dead or not needed" }] });

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

	// --- budget for very large units
	const huge = (ledger.db.prepare("SELECT COUNT(*) n FROM units WHERE json_extract(meta,'$.loc') > 3000").get() as { n: number }).n;
	if (huge > 0 && config.run.budgetUsdPerUnit <= 5) out.push({ id: "budget", topic: "budget", question: `${huge} units exceed 3,000 LOC; the per-unit budget is $${config.run.budgetUsdPerUnit}. Keep?`, evidence: "big controllers escalate to the expensive model", recommended: "keep", options: [{ value: "keep", label: `keep $${config.run.budgetUsdPerUnit}/unit; big units quarantine on overrun` }, { value: "raise:15", label: "raise to $15/unit for this repo" }, { value: "raise:30", label: "raise to $30/unit" }] });

	// model advice (br advise) replaces the static defaults; an advised value outside the options is added as one
	const advice = (loadDecisions(root) as { advice?: Record<string, { value: string; reason?: string; confidence?: number }> }).advice ?? {};
	for (const d of out) {
		const a = advice[d.id];
		if (!a) continue;
		// an unsure Jev pick (< 50%) does not replace the code recommendation; it is shown, so a human sees the doubt
		if (a.confidence !== undefined && a.confidence < 0.5 && a.value !== d.recommended) {
			d.reason = `Jev leans to ${a.value} but is unsure (${Math.round(a.confidence * 100)}%)`;
			d.confidence = a.confidence;
			continue;
		}
		if (!d.options.some((o) => o.value === a.value)) d.options.unshift({ value: a.value, label: a.value.replace(/^replace:/, "replace with "), hint: "advised" });
		d.recommended = a.value;
		d.reason = a.reason;
		d.confidence = a.confidence;
	}
	// every decision carries a recommendation: the model's, else the code's, else the first option
	for (const d of out) if (!d.recommended || !d.options.some((o) => o.value === d.recommended)) {
		if (d.recommended && !d.options.some((o) => o.value === d.recommended)) d.options.unshift({ value: d.recommended, label: d.recommended });
		else {
			d.recommended = d.id.startsWith("lib:") ? "port" : d.options[0]!.value;
			d.reason ??= "no stronger evidence; safest option";
		}
	}
	// the model's phrasing for this repo replaces the code's intent text; facts changed since → code text stays until re-advised
	const file = loadDecisions(root);
	const ids = new Set(out.map((d) => d.id));
	if (!opts.raw) for (const d of out) {
		const ph = file.phrased?.[d.id];
		if (!ph || ph.hash !== pointHash(toPoint(d))) continue;
		const labels = new Map(ph.options.map((o) => [o.value, o]));
		// the model may omit options that make no sense here; the recommended one always stays
		d.options = d.options.filter((o) => labels.has(o.value) || o.value === d.recommended).map((o) => ({ value: o.value, label: labels.get(o.value)?.label ?? o.label, hint: labels.get(o.value)?.hint ?? o.hint }));
		d.question = ph.question;
		if (!advice[d.id] && ph.recommended && d.options.some((o) => o.value === ph.recommended)) d.recommended = ph.recommended;
		d.reason = d.reason && advice[d.id] ? `${d.reason}. ${ph.opinion}` : ph.opinion;
	}
	for (const [id, q] of Object.entries(file.discovered ?? {})) {
		if (ids.has(id) || opts.raw) continue;
		out.push({ id, topic: "repo", question: q.question, evidence: q.evidence, options: q.options, recommended: q.recommended ?? q.options[0]?.value, reason: q.opinion });
	}
	// recommended option first: in a multiple-choice prompt, Enter takes it
	for (const d of out) d.options.sort((a, b) => Number(b.value === d.recommended) - Number(a.value === d.recommended));
	return out.filter((d) => !answered[d.id]);
}

/** The code's view of a decision, as the phrasing model gets it. */
export function toPoint(d: Decision): DecisionPoint {
	return { id: d.id, topic: d.topic, intent: d.question, evidence: d.evidence, options: d.options.map((o) => ({ value: o.value, facts: `${o.label}${o.hint ? ` — ${o.hint}` : ""}` })), recommended: d.recommended };
}

/** api target alone, or api + each web target: the options for the "targets" decision. */
function targetCombos(): string[] {
	const roles = TARGET_SUBDIRS;
	const apis = Object.keys(roles).filter((k) => roles[k] === "api");
	const webs = Object.keys(roles).filter((k) => roles[k] === "web");
	return apis.flatMap((a) => [...webs.map((w) => `${a}+${w}`), a]);
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
	} else if (id === "targets") {
		raw.target.stacks = answer.split("+").filter(Boolean);
		note = `config.target.stacks = ${raw.target.stacks.join(", ")}`;
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
	} else if (id === "frontend") {
		if (answer === "react" || answer === "vue") {
			raw.target.stacks = [...new Set([...(raw.target.stacks ?? []), answer])];
			note = `config.target.stacks = ${raw.target.stacks.join(", ")}`;
		} else note = "backend only";
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
	} else if (id === "budget") {
		const m = /^raise:(\d+)$/.exec(answer);
		if (m) {
			raw.run ??= {};
			raw.run.budgetUsdPerUnit = Number(m[1]);
			note = `run.budgetUsdPerUnit = ${m[1]}`;
		}
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

function guessConcern(name: string, keys: string[]): string | undefined {
	const table: Array<[RegExp, string]> = [[/DB|Where|Query|Sql|DataObject/i, "orm"], [/Http|Request|Response|Url/i, "http"], [/Render|View|Template|Widget|Html/i, "rendering"], [/Command/i, "commands"], [/Mapper|Route|Action|Controller/i, "routing"], [/Access|User|Login|Session/i, "auth"], [/Cache/i, "cache"], [/Log/i, "logging"], [/Mail/i, "mail"], [/Event/i, "events"], [/String|Arr|Date|Convert|Filter|Helper|History|Stat/i, "helpers"], [/Translat|Locale/i, "i18n"]];
	for (const [re, k] of table) if (re.test(name) && keys.includes(k)) return k === "auth" || k === "commands" ? "port" : `platform:${k}`;
	return undefined;
}

function countFrontendFiles(root: string): { total: number; summary: string } {
	const counts: Record<string, number> = {};
	const visit = (dir: string, depth: number) => {
		if (depth > 6) return;
		let names: string[];
		try { names = readdirSync(dir); } catch { return; }
		for (const n of names) {
			if (n === "node_modules" || n === ".git" || n === "vendor" || n === "dist" || n === "build") continue;
			const p = join(dir, n);
			let st; try { st = statSync(p); } catch { continue; }
			if (st.isDirectory()) visit(p, depth + 1);
			else { const m = /\.(vue|jsx|tsx|svelte)$/.exec(n) ?? (/\.tpl\.php$|\.phtml$|\.blade\.php$|\.twig$/.test(n) ? ["", "template"] : null); if (m) counts[m[1]!] = (counts[m[1]!] ?? 0) + 1; }
		}
	};
	visit(root, 0);
	const total = Object.values(counts).reduce((a, b) => a + b, 0);
	return { total, summary: Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "none" };
}

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
