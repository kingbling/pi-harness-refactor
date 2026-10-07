import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { SourceAdapter } from "../adapters/types.ts";
import { knownTargets, TARGET_SUBDIRS } from "../adapters/registry.ts";

/**
 * What `br init` finds in the legacy repo BEFORE it asks anything, so every default is derived from the
 * code instead of hardcoded: data stores (compose images + the adapter's own signals), UI (server
 * templates and client components by framework), framework, compose file, test setup. Stack-neutral:
 * language-specific signals come from the source adapter (`dbSignals`, `detect`).
 */
export interface Survey {
	framework?: string;
	version?: string;
	engines: Array<{ engine: string; evidence: string }>;
	/** File counts by extension (top ones): the model reads what they mean (templates, UI components, …); code does not. */
	files: Record<string, number>;
	compose?: string;
	tests?: string;
}

export interface Recommendation {
	targets: string[];
	dbStrategy: "keep-schema" | "new-schema" | "none";
	dbFrom: string[];
	targetPath: string;
	why: string[];
}

const IMAGE_ENGINES: Array<[RegExp, string]> = [[/mariadb/i, "mariadb"], [/mysql/i, "mysql"], [/postgres|postgis/i, "postgresql"], [/mongo/i, "mongodb"], [/arangodb/i, "arangodb"], [/redis|valkey/i, "redis"], [/elasticsearch|opensearch/i, "elasticsearch"], [/mssql|sqlserver/i, "sqlserver"], [/oracle/i, "oracle"]];
/** Stores that hold data to migrate (caches/search indexes are infrastructure, kept as they are). */
export const DATA_STORES = new Set(["mariadb", "mysql", "postgresql", "mongodb", "arangodb", "sqlserver", "oracle", "sqlite"]);

export async function surveySource(root: string, adapter: SourceAdapter): Promise<Survey> {
	const det = await adapter.detect(root).catch(() => ({ confidence: 0 }) as { confidence: number; framework?: string; version?: string });
	const engines = new Map<string, string>();
	const files: Record<string, number> = {};
	let compose: string | undefined;
	// dependency dirs are the source adapter's knowledge; dot-dirs (vcs, editors) are never the app
	const skip = new Set(adapter.traits?.vendorDirs ?? []);
	const visit = (dir: string, rel: string, depth: number) => {
		if (depth > 8) return;
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const n of names) {
			if (skip.has(n) || n.startsWith(".")) continue;
			const p = join(dir, n);
			const r = rel ? `${rel}/${n}` : n;
			let st;
			try {
				st = statSync(p);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				visit(p, r, depth + 1);
				continue;
			}
			if (/^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(n) && depth <= 2) {
				compose ??= r;
				const text = readFileSync(p, "utf8");
				for (const m of text.matchAll(/^\s*image:\s*["']?([^\s"']+)/gm)) for (const [re, e] of IMAGE_ENGINES) if (re.test(m[1]!)) engines.set(e, `${r}: image ${m[1]}`);
			}
			// compound extensions count as their own kind (x.tpl.y is not x.y)
			const ext = /(\.[a-z0-9]+){1,2}$/i.exec(n)?.[0].toLowerCase();
			if (ext) files[ext] = (files[ext] ?? 0) + 1;
		}
	};
	visit(root, "", 0);
	for (const s of adapter.dbSignals?.(root) ?? []) if (!engines.has(s.engine)) engines.set(s.engine, s.evidence);
	// mariadb and mysql are one family: keep the more specific one
	if (engines.has("mariadb")) engines.delete("mysql");
	const tests = ["tests", "test", "spec"].find((t) => existsSync(join(root, t)));
	const top = Object.fromEntries(Object.entries(files).sort((a, b) => b[1] - a[1]).slice(0, 25));
	return { framework: det.framework, version: det.version, engines: [...engines].map(([engine, evidence]) => ({ engine, evidence })), files: top, compose, tests };
}

/**
 * Provisional values only, so inventory can run before anything is decided: the first adapters that
 * fit. Never a recommendation: `adviseTargets` judges the target stack from the analyzed repo.
 */
export function recommend(s: Survey, sourcePath: string): Recommendation {
	const why: string[] = [];
	const roleOf = (id: string) => TARGET_SUBDIRS[id];
	const api = knownTargets().find((t) => roleOf(t) === "api");
	const webs = knownTargets().filter((t) => roleOf(t) === "web");
	const targets = api ? [api] : [];
	// code cannot tell UI files from others without stack knowledge: provisionally every role, judged later
	if (webs.length) targets.push(webs[0]!);
	why.push(`files: ${Object.entries(s.files).slice(0, 10).map(([k, v]) => `${v} ${k}`).join(", ")}`);
	const dbFrom = s.engines.map((e) => e.engine).filter((e) => DATA_STORES.has(e));
	const dbStrategy = dbFrom.length ? "keep-schema" : "none";
	why.push(dbFrom.length ? `data stores found: ${s.engines.filter((e) => DATA_STORES.has(e.engine)).map((e) => `${e.engine} (${e.evidence})`).join("; ")} → keep-schema` : "no data store found → db strategy none");
	const targetPath = `./${basename(sourcePath.replace(/\/+$/, "")) || "legacy"}-next`;
	return { targets, dbStrategy, dbFrom, targetPath, why };
}

export function renderSurvey(s: Survey, r: Recommendation): string {
	const L = ["found in the legacy repo:"];
	if (s.framework) L.push(`  framework   ${s.framework}${s.version ? ` (${s.version})` : ""}`);
	L.push(`  data        ${s.engines.length ? s.engines.map((e) => e.engine).join(", ") : "none detected"}`);
	L.push(`  files       ${Object.entries(s.files).slice(0, 10).map(([k, v]) => `${v} ${k}`).join(", ")}`);
	if (s.compose) L.push(`  compose     ${s.compose}`);
	if (s.tests) L.push(`  tests       ${s.tests}`);
	L.push(`provisional (decided after the repo is analyzed): targets ${r.targets.join(" + ")}, db ${r.dbStrategy}${r.dbFrom.length ? ` from ${r.dbFrom.join(" + ")}` : ""}, new code in ${r.targetPath}`);
	for (const w of r.why) L.push(`  · ${w}`);
	return L.join("\n");
}

/**
 * Stack defaults judged by a model from the survey instead of fixed adapter defaults: one structured call
 * (escalate model) picks an option per adapter stack choice, with a reason. Options are the adapter's;
 * the model can only choose among them. Returns {} when no model is reachable (offline / --no-llm).
 */
export async function adviseStack(
	s: Survey,
	targets: Array<{ id: string; stackChoices?: Array<{ key: string; question: string; default: string; options: Array<{ id: string; label: string; hint?: string }> }> }>,
	client: import("../models/types.ts").ModelClient,
	model: string,
	extra: { dbTo?: string; legacyLibraries?: string[]; brief?: string } = {},
): Promise<{ picks: Record<string, Record<string, { id: string; reason: string }>>; costUsd: number }> {
	const items = targets.flatMap((t) => (t.stackChoices ?? []).map((c) => ({ t: t.id, c })));
	if (!items.length) return { picks: {}, costUsd: 0 };
	const key = (t: string, k: string) => `${t}__${k}`;
	const schema = {
		type: "object",
		additionalProperties: false,
		required: items.map((i) => key(i.t, i.c.key)),
		properties: Object.fromEntries(items.map((i) => [key(i.t, i.c.key), { type: "object", additionalProperties: false, required: ["id", "reason"], properties: { id: { type: "string", enum: i.c.options.map((o) => o.id) }, reason: { type: "string" } } }])),
	};
	const prompt = [
		extra.brief ? `Repo brief:\n${extra.brief.slice(0, 4000)}\n` : "",
		`Legacy repo survey: framework ${s.framework ?? "unknown"}${s.version ? ` ${s.version}` : ""}; data stores ${s.engines.map((e) => `${e.engine} (${e.evidence})`).join("; ") || "none"}; files by extension ${Object.entries(s.files).map(([k, v]) => `${k}=${v}`).join(", ")}; tests ${s.tests ?? "none found"}.`,
		extra.dbTo ? `The data will move to ${extra.dbTo}.` : "",
		extra.legacyLibraries?.length ? `Legacy libraries: ${extra.legacyLibraries.join(", ")}.` : "",
		"Pick, for each stack decision of the new codebase, the option that fits THIS repo best (team continuity, data model, UI style, what the legacy code already does). One sentence reason each, grounded in the survey.",
		...items.map((i) => `\n${key(i.t, i.c.key)} — ${i.t}: ${i.c.question}\n${i.c.options.map((o) => `  - ${o.id}: ${o.label}${o.hint ? ` (${o.hint})` : ""}`).join("\n")}`),
	].join("\n");
	const res = await client.chat({ model, messages: [{ role: "system", content: "You are a senior architect choosing a target stack for a legacy migration. Answer only with the JSON object." }, { role: "user", content: prompt }], schema, effort: "low" });
	const out = (res.json ?? {}) as Record<string, { id: string; reason: string }>;
	const picks: Record<string, Record<string, { id: string; reason: string }>> = {};
	for (const i of items) {
		const a = out[key(i.t, i.c.key)];
		if (a && i.c.options.some((o) => o.id === a.id)) (picks[i.t] ??= {})[i.c.key] = a;
	}
	return { picks, costUsd: res.usage.costUsd };
}

export interface TargetAdvice {
	/** `<server>[+<ui>]` stack ids, e.g. the model's own kebab-case names. */
	value: string;
	reason: string;
	alternatives: Array<{ value: string; reason: string }>;
	costUsd: number;
}

/**
 * The target stack judged from the repo: a model reads the repo brief (what the app does, its UI, data,
 * odd patterns) plus the survey and libraries and says what the new codebase should be built on, with
 * alternatives. It names stacks freely; which ones bigrefactor has adapters for is listed as a fact the
 * owner must know, never as the space to choose from.
 */
export async function adviseTargets(
	s: Survey,
	brief: string,
	client: import("../models/types.ts").ModelClient,
	model: string,
	extra: { legacyLibraries?: string[]; adapters: Array<{ id: string; role: string }> },
): Promise<TargetAdvice | undefined> {
	const pick = { type: "object", additionalProperties: false, required: ["server", "ui", "reason"], properties: { server: { type: "string", description: "kebab-case id of the server/API stack" }, ui: { type: "string", description: "kebab-case id of the UI stack, or \"none\" when the app needs no separate UI codebase" }, reason: { type: "string", description: "1–2 sentences grounded in THIS repo (its UI, data, team code, patterns)" } } };
	const schema = { type: "object", additionalProperties: false, required: ["recommended", "alternatives"], properties: { recommended: pick, alternatives: { type: "array", items: pick, description: "1–3 other serious options" } } };
	const prompt = [
		`Repo brief:\n${brief.slice(0, 6000)}`,
		`\nSurvey: framework ${s.framework ?? "unknown"}${s.version ? ` ${s.version}` : ""}; data stores ${s.engines.map((e) => `${e.engine} (${e.evidence})`).join("; ") || "none"}; files by extension ${Object.entries(s.files).map(([k, v]) => `${k}=${v}`).join(", ")}; tests ${s.tests ?? "none found"}.`,
		extra.legacyLibraries?.length ? `Legacy libraries: ${extra.legacyLibraries.join(", ")}.` : "",
		"\nThis legacy app is being rewritten into a new codebase. Which server stack and which UI stack should the new codebase use? Judge from what this repo is and does (how its UI is built, how much client code exists and in what, data access, size, odd patterns), not from fashion. Use short kebab-case stack ids.",
		`For information only (do NOT let it steer the pick): the migration tool currently has target adapters for ${extra.adapters.map((a) => `${a.id} (${a.role})`).join(", ")}; others would need an adapter first.`,
	].join("\n");
	const res = await client.chat({ model, messages: [{ role: "system", content: "You are a senior architect choosing the target stack for a legacy rewrite. Answer only with the JSON object." }, { role: "user", content: prompt }], schema, effort: "medium" });
	type Pick = { server?: string; ui?: string; reason?: string };
	const j = (res.json ?? {}) as { recommended?: Pick; alternatives?: Pick[] };
	const id = (x?: string) => (x ?? "").trim().toLowerCase().replace(/[^a-z0-9.+-]+/g, "-").replace(/^-+|-+$/g, "");
	const value = (p?: Pick) => (p && id(p.server) ? [id(p.server), ...(id(p.ui) && id(p.ui) !== "none" ? [id(p.ui)] : [])].join("+") : "");
	const rec = value(j.recommended);
	if (!rec) return undefined;
	const alternatives = (j.alternatives ?? []).map((p) => ({ value: value(p), reason: p.reason ?? "" })).filter((a, i, all) => a.value && a.value !== rec && all.findIndex((b) => b.value === a.value) === i);
	return { value: rec, reason: j.recommended!.reason ?? "", alternatives, costUsd: res.usage.costUsd };
}
