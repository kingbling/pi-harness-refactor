import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SourceAdapter, StoreKind } from "../adapters/types.ts";
import { knownTargets, TARGET_SUBDIRS } from "../adapters/registry.ts";
import { defaultTargetPath } from "./init.ts";

/**
 * What `br init` finds in the legacy repo BEFORE it asks anything, so every default is derived from the
 * code instead of hardcoded: data stores (compose images + the adapter's own signals), UI (server
 * templates and client components by framework), framework, compose file, test setup. Stack-neutral:
 * language-specific signals come from the source adapter (`dbSignals`, `detect`).
 */
export interface Survey {
	framework?: string;
	version?: string;
	engines: Array<{ engine: string; evidence: string; kind?: StoreKind }>;
	/** File counts by extension (top ones): the model reads what they mean (templates, UI components, …); code does not. */
	files: Record<string, number>;
	compose?: string;
	/** A top-level test folder, when there is one. Absent means code did not find one, NOT that the repo has no tests. */
	tests?: string;
}

/** The survey's tests fact for a prompt: code only looks for a top-level test folder, so absent is "not checked". */
export const testsFact = (s: Survey) => s.tests ?? "not checked by code (tests may sit next to the code; the repo brief says what exists)";

export interface Recommendation {
	targets: string[];
	dbStrategy: "keep-schema" | "new-schema" | "none";
	dbFrom: string[];
	targetPath: string;
	why: string[];
}

const IMAGE_ENGINES: Array<[RegExp, string]> = [[/mariadb/i, "mariadb"], [/mysql/i, "mysql"], [/postgres|postgis/i, "postgresql"], [/mongo/i, "mongodb"], [/arangodb/i, "arangodb"], [/redis|valkey/i, "redis"], [/elasticsearch|opensearch/i, "elasticsearch"], [/mssql|sqlserver/i, "sqlserver"], [/oracle/i, "oracle"]];
/** Stores that hold data to migrate (caches/search indexes are infrastructure, kept as they are). Fallback only: used when no kind is known (compose images, hand-written adapters). */
export const DATA_STORES = new Set(["mariadb", "mysql", "postgresql", "mongodb", "arangodb", "sqlserver", "oracle", "sqlite"]);
/** A store holds data to migrate: the kind the source adapter gave decides; without one, the fallback list. */
export const holdsData = (e: { engine: string; kind?: StoreKind }) => (e.kind ? e.kind === "relational" || e.kind === "document" : DATA_STORES.has(e.engine));

export async function surveySource(root: string, adapter: SourceAdapter): Promise<Survey> {
	const det = await adapter.detect(root).catch(() => ({ confidence: 0 }) as { confidence: number; framework?: string; version?: string });
	const engines = new Map<string, { evidence: string; kind?: StoreKind }>();
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
				for (const m of text.matchAll(/^\s*image:\s*["']?([^\s"']+)/gm)) for (const [re, e] of IMAGE_ENGINES) if (re.test(m[1]!)) engines.set(e, { evidence: `${r}: image ${m[1]}` });
			}
			// compound extensions count as their own kind (x.tpl.y is not x.y)
			const ext = /(\.[a-z0-9]+){1,2}$/i.exec(n)?.[0].toLowerCase();
			if (ext) files[ext] = (files[ext] ?? 0) + 1;
		}
	};
	visit(root, "", 0);
	for (const s of adapter.dbSignals?.(root) ?? []) {
		const prev = engines.get(s.engine);
		if (!prev) engines.set(s.engine, { evidence: s.evidence, kind: s.kind });
		else if (s.kind) prev.kind ??= s.kind; // the adapter knows what the store is; the compose image only that it runs
	}
	// mariadb and mysql are one family: keep the more specific one
	if (engines.has("mariadb")) {
		engines.get("mariadb")!.kind ??= engines.get("mysql")?.kind;
		engines.delete("mysql");
	}
	const tests = ["tests", "test", "spec"].find((t) => existsSync(join(root, t)));
	const top = Object.fromEntries(Object.entries(files).sort((a, b) => b[1] - a[1]).slice(0, 25));
	return { framework: det.framework, version: det.version, engines: [...engines].map(([engine, e]) => ({ engine, evidence: e.evidence, ...(e.kind ? { kind: e.kind } : {}) })), files: top, compose, tests };
}

/**
 * Provisional values only, so inventory can run before anything is decided: the first adapters that
 * fit. Never a recommendation: `adviseDimensions` rates where each part goes, from the analyzed repo.
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
	const dbFrom = s.engines.filter(holdsData).map((e) => e.engine);
	const dbStrategy = dbFrom.length ? "keep-schema" : "none";
	why.push(dbFrom.length ? `data stores found: ${s.engines.filter(holdsData).map((e) => `${e.engine} (${e.evidence})`).join("; ")} → keep-schema` : "no data store found → db strategy none");
	const targetPath = defaultTargetPath(sourcePath);
	return { targets, dbStrategy, dbFrom, targetPath, why };
}

export function renderSurvey(s: Survey, r: Recommendation): string {
	const L = ["found in the legacy repo:"];
	if (s.framework) L.push(`  framework   ${s.framework}${s.version ? ` (${s.version})` : ""}`);
	L.push(`  data        ${s.engines.length ? s.engines.map((e) => e.engine).join(", ") : "none detected"}`);
	L.push(`  files       ${Object.entries(s.files).slice(0, 10).map(([k, v]) => `${v} ${k}`).join(", ")}`);
	if (s.compose) L.push(`  compose     ${s.compose}`);
	L.push(`  tests       ${s.tests ?? "no top-level test folder (not searched further)"}`);
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
	extra: { dbTo?: string; legacyLibraries?: string[]; brief?: string; decided?: string[] } = {},
): Promise<{ picks: Record<string, Record<string, { id: string; reason: string; implied?: boolean }>>; costUsd: number }> {
	const items = targets.flatMap((t) => (t.stackChoices ?? []).map((c) => ({ t: t.id, c })));
	if (!items.length) return { picks: {}, costUsd: 0 };
	const key = (t: string, k: string) => `${t}__${k}`;
	const schema = {
		type: "object",
		additionalProperties: false,
		required: items.map((i) => key(i.t, i.c.key)),
		properties: Object.fromEntries(items.map((i) => [key(i.t, i.c.key), { type: "object", additionalProperties: false, required: ["id", "reason", "implied"], properties: { id: { type: "string", enum: i.c.options.map((o) => o.id) }, reason: { type: "string" }, implied: { type: "boolean", description: "true only when the owner decisions fully determine this choice (nothing left to ask)" } } }])),
	};
	const prompt = [
		extra.brief ? `Repo brief:\n${extra.brief.slice(0, 4000)}\n` : "",
		`Legacy repo survey: framework ${s.framework ?? "unknown"}${s.version ? ` ${s.version}` : ""}; data stores ${s.engines.map((e) => `${e.engine} (${e.evidence})`).join("; ") || "none"}; files by extension ${Object.entries(s.files).map(([k, v]) => `${k}=${v}`).join(", ")}; tests ${testsFact(s)}.`,
		extra.dbTo ? `The data will move to ${extra.dbTo}.` : "",
		extra.decided?.length ? `Owner decisions (binding): ${extra.decided.join("; ")}.` : "",
		extra.legacyLibraries?.length ? `Legacy libraries: ${extra.legacyLibraries.join(", ")}.` : "",
		"Pick, for each stack decision of the new codebase, the option that fits THIS repo best (team continuity, data model, UI style, what the legacy code already does). One sentence reason each, grounded in the survey.",
		...items.map((i) => `\n${key(i.t, i.c.key)} — ${i.t}: ${i.c.question}\n${i.c.options.map((o) => `  - ${o.id}: ${o.label}${o.hint ? ` (${o.hint})` : ""}`).join("\n")}`),
	].join("\n");
	const res = await client.chat({ model, messages: [{ role: "system", content: "You are a senior architect choosing a target stack for a legacy migration. Answer only with the JSON object." }, { role: "user", content: prompt }], schema, effort: "low" });
	const out = (res.json ?? {}) as Record<string, { id: string; reason: string; implied?: boolean }>;
	const picks: Record<string, Record<string, { id: string; reason: string; implied?: boolean }>> = {};
	for (const i of items) {
		const a = out[key(i.t, i.c.key)];
		if (a && i.c.options.some((o) => o.id === a.id)) (picks[i.t] ??= {})[i.c.key] = { ...a, implied: !!(a.implied && extra.decided?.length) };
	}
	return { picks, costUsd: res.usage.costUsd };
}

/** One part of the app the rewrite has to land somewhere, with every candidate rated for THIS repo. */
export interface Dimension {
	/** "server", "ui", "data:<legacy engine>" per data store, or another part the repo has (queue, search, …). */
	key: string;
	/** What the legacy app uses for it today. */
	now: string;
	candidates: Array<{ id: string; score: number; reason: string }>;
}

/**
 * Where to bring each part of the app, judged from the repo: a model reads the brief (what the app does, its
 * UI, data, odd patterns), the survey and the libraries, and rates candidates per dimension 0–100. It names
 * stacks freely; which ones bigrefactor has adapters for is information for the owner (a missing one is
 * generated on choice), never the space to choose from.
 */
export async function adviseDimensions(
	s: Survey,
	brief: string,
	client: import("../models/types.ts").ModelClient,
	model: string,
	extra: { legacyLibraries?: string[]; dataStores: string[]; adapters: Array<{ id: string; role: string }> },
): Promise<{ dimensions: Dimension[]; costUsd: number }> {
	const cand = { type: "object", additionalProperties: false, required: ["id", "score", "reason"], properties: { id: { type: "string", description: "short kebab-case id of the stack / engine / product" }, score: { type: "integer", minimum: 0, maximum: 100, description: "fit for THIS repo" }, reason: { type: "string", description: "1–2 sentences grounded in the repo" } } };
	const dim = { type: "object", additionalProperties: false, required: ["key", "now", "candidates"], properties: { key: { type: "string" }, now: { type: "string" }, candidates: { type: "array", items: cand, minItems: 2, maxItems: 4 } } };
	const schema = { type: "object", additionalProperties: false, required: ["dimensions"], properties: { dimensions: { type: "array", items: dim } } };
	const prompt = [
		`Repo brief:\n${brief.slice(0, 6000)}`,
		`\nSurvey: framework ${s.framework ?? "unknown"}${s.version ? ` ${s.version}` : ""}; data stores ${s.engines.map((e) => `${e.engine} (${e.evidence})`).join("; ") || "none"}; files by extension ${Object.entries(s.files).map(([k, v]) => `${k}=${v}`).join(", ")}; tests ${testsFact(s)}.`,
		extra.legacyLibraries?.length ? `Legacy libraries: ${extra.legacyLibraries.join(", ")}.` : "",
		"\nThis legacy app is rewritten into a new codebase. For each part of it, rate where it should go: 2–4 candidates, each scored 0–100 for fit with THIS repo (how its UI is built, how much client code exists and in what, data access, size, team code, odd patterns), not for fashion. Include keeping the legacy technology as a candidate where that is a serious option.",
		"Dimensions (keys exactly):",
		"- server: the backend / API stack",
		`- ui: the frontend stack; candidate id "none" when the app needs no separate UI codebase`,
		...extra.dataStores.map((d) => `- data:${d}: where the data in ${d} goes; candidate ids are engine ids (${d} itself = keep it), or "drop"`),
		"- any other part with a real choice for this repo (e.g. background jobs, search, file storage, auth), key = short kebab-case name; skip parts without a real choice",
		`For information only (do NOT let it steer the scores): the migration tool has target adapters for ${extra.adapters.map((a) => `${a.id} (${a.role})`).join(", ")}; for other stacks it generates one.`,
	].join("\n");
	const res = await client.chat({ model, messages: [{ role: "system", content: "You are a senior architect planning a legacy rewrite. Answer only with the JSON object." }, { role: "user", content: prompt }], schema, effort: "medium" });
	const id = (x?: string) => (x ?? "").trim().toLowerCase().replace(/[^a-z0-9.:-]+/g, "-").replace(/^-+|-+$/g, "");
	const dims = (((res.json ?? {}) as { dimensions?: Dimension[] }).dimensions ?? [])
		.map((d) => ({ key: id(d.key), now: d.now ?? "", candidates: (d.candidates ?? []).map((c) => ({ id: id(c.id), score: Math.max(0, Math.min(100, Math.round(c.score ?? 0))), reason: c.reason ?? "" })).filter((c, i, all) => c.id && all.findIndex((x) => x.id === c.id) === i).sort((a, b) => b.score - a.score) }))
		.filter((d, i, all) => d.key && d.candidates.length && all.findIndex((x) => x.key === d.key) === i);
	return { dimensions: dims, costUsd: res.usage.costUsd };
}
