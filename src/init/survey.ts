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
	ui: { templates: number; components: Record<string, number>; framework?: string };
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
const COMPONENT_EXT: Array<[RegExp, string]> = [[/\.vue$/, "vue"], [/\.(jsx|tsx)$/, "react"], [/\.svelte$/, "svelte"]];
const TEMPLATE_RE = /\.(tpl\.php|phtml|blade\.php|twig|erb|hbs|mustache|j2|jinja2?|cshtml|jsp)$/;
/** Stores that hold data to migrate (caches/search indexes are infrastructure, kept as they are). */
export const DATA_STORES = new Set(["mariadb", "mysql", "postgresql", "mongodb", "arangodb", "sqlserver", "oracle", "sqlite"]);

export async function surveySource(root: string, adapter: SourceAdapter): Promise<Survey> {
	const det = await adapter.detect(root).catch(() => ({ confidence: 0 }) as { confidence: number; framework?: string; version?: string });
	const engines = new Map<string, string>();
	const ui = { templates: 0, components: {} as Record<string, number> };
	let compose: string | undefined;
	const skip = new Set(["node_modules", "vendor", ".git", "dist", "build", "3rdparty", "third_party", ".idea", ".vscode"]);
	const visit = (dir: string, rel: string, depth: number) => {
		if (depth > 8) return;
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const n of names) {
			if (skip.has(n)) continue;
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
			if (TEMPLATE_RE.test(n)) ui.templates++;
			else for (const [re, k] of COMPONENT_EXT) if (re.test(n) && !/\.(spec|test)\./.test(n)) ui.components[k] = (ui.components[k] ?? 0) + 1;
		}
	};
	visit(root, "", 0);
	for (const s of adapter.dbSignals?.(root) ?? []) if (!engines.has(s.engine)) engines.set(s.engine, s.evidence);
	// mariadb and mysql are one family: keep the more specific one
	if (engines.has("mariadb")) engines.delete("mysql");
	const fw = Object.entries(ui.components).sort((a, b) => b[1] - a[1])[0]?.[0];
	const tests = ["phpunit.xml", "phpunit.xml.dist", "tests/phpunit", "pytest.ini", "spec", "test", "tests"].find((t) => existsSync(join(root, t)));
	return { framework: det.framework, version: det.version, engines: [...engines].map(([engine, evidence]) => ({ engine, evidence })), ui: { ...ui, framework: fw }, compose, tests };
}

export function recommend(s: Survey, sourcePath: string): Recommendation {
	const why: string[] = [];
	const roleOf = (id: string) => TARGET_SUBDIRS[id];
	const api = knownTargets().find((t) => roleOf(t) === "api");
	const webs = knownTargets().filter((t) => roleOf(t) === "web");
	const targets = api ? [api] : [];
	const hasUi = s.ui.templates > 0 || Object.keys(s.ui.components).length > 0;
	if (hasUi && webs.length) {
		const same = s.ui.framework && webs.includes(s.ui.framework) ? s.ui.framework : undefined;
		const web = same ?? webs[0]!;
		targets.push(web);
		why.push(`UI found (${s.ui.templates} server templates${Object.entries(s.ui.components).map(([k, v]) => `, ${v} ${k}`).join("")}) → web target ${web}${s.ui.framework && !same ? ` (no ${s.ui.framework} target adapter yet)` : ""}`);
	} else if (!hasUi) why.push("no UI found → backend only");
	const dbFrom = s.engines.map((e) => e.engine).filter((e) => DATA_STORES.has(e));
	const dbStrategy = dbFrom.length ? "keep-schema" : "none";
	why.push(dbFrom.length ? `data stores found: ${s.engines.filter((e) => DATA_STORES.has(e.engine)).map((e) => `${e.engine} (${e.evidence})`).join("; ")} → keep-schema` : "no data store found → db strategy none");
	const targetPath = `./${basename(sourcePath.replace(/\/+$/, "")) || "legacy"}-next`;
	return { targets, dbStrategy, dbFrom, targetPath, why };
}

/** Target engine from the api target's "database" stack choice (or the legacy engine when kept). */
export function targetEngine(choiceId: string | undefined, dbFrom: string[]): string | undefined {
	switch (choiceId) {
		case "postgres":
			return "postgresql";
		case "mysql":
			return dbFrom.includes("mariadb") ? "mariadb" : "mysql";
		case "sqlite":
			return "sqlite";
		case "legacy":
			return dbFrom[0];
		default:
			return choiceId;
	}
}

export function renderSurvey(s: Survey, r: Recommendation): string {
	const L = ["found in the legacy repo:"];
	if (s.framework) L.push(`  framework   ${s.framework}${s.version ? ` (${s.version})` : ""}`);
	L.push(`  data        ${s.engines.length ? s.engines.map((e) => e.engine).join(", ") : "none detected"}`);
	L.push(`  ui          ${s.ui.templates} templates${Object.entries(s.ui.components).map(([k, v]) => `, ${v} ${k}`).join("")}`);
	if (s.compose) L.push(`  compose     ${s.compose}`);
	if (s.tests) L.push(`  tests       ${s.tests}`);
	L.push(`recommended: targets ${r.targets.join(" + ")}, db ${r.dbStrategy}${r.dbFrom.length ? ` from ${r.dbFrom.join(" + ")}` : ""}, new code in ${r.targetPath}`);
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
	extra: { dbTo?: string; legacyLibraries?: string[] } = {},
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
		`Legacy repo survey: framework ${s.framework ?? "unknown"}${s.version ? ` ${s.version}` : ""}; data stores ${s.engines.map((e) => `${e.engine} (${e.evidence})`).join("; ") || "none"}; UI ${s.ui.templates} server templates${Object.entries(s.ui.components).map(([k, v]) => `, ${v} ${k} components`).join("")}; tests ${s.tests ?? "none found"}.`,
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
