import type { ObservationContext } from "./parity-command.ts";
import { isExactJsonNumber, parseExactJson } from "./exact-json.ts";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import pc from "picocolors";
import { Type } from "typebox";
import type { Config } from "../config.ts";
import { headOf, isDirty, removeWorktree } from "../git.ts";
import type { Ledger } from "../ledger/db.ts";
import { PLAIN_LANGUAGE } from "../policy.ts";
import { spawnLeaf } from "../sessions/spawn.ts";
import { differences } from "./differences.ts";
import { holdBack, readyRoutes, waitingRoutes } from "./parity-partial.ts";
import { appRoot, bootApp, dumpData, LEGACY, loadApps, loginFacts, prepareTargetCopy, saveApp, type AppRecipe, type Booted } from "./parity.ts";
import { recordOldFailures } from "./parity-scope.ts";
import { contractDiffs, contractInputs, contractProblems, digest, retainedScenarioProblems, runContracts, strictSuiteProblems, type ContractResult, type ParityContract } from "./parity-contracts.ts";
import type { BehaviorChange } from "./parity-changes.ts";

/**
 * Differential parity for one slice: the same requests go to the old app (twice) and to the new app, code compares
 * the answers. A tester model writes the requests once per slice (steps.json), trying them on the old app only: it
 * never sees the new app's answers, so it cannot shape the requests to hide a difference. Fields that already differ
 * between the two runs on the old app (times, tokens, random ids) are noise; no model and no rule declares noise.
 */

/** One request. `{{name}}` in path, headers, body and form is replaced by a value an earlier step saved. */
export interface Step {
	id: string;
	/** The slice route it exercises ("GET /invoices/{id}"), or "setup" for login and other preparation. */
	route: string;
	/** What is compared: data = status, redirect, body and written data; redirect = status, redirect and written data; page = status and written data (not its HTML); none = nothing. */
	compare: "data" | "redirect" | "page" | "none";
	method: string;
	path: string;
	headers?: Record<string, string>;
	/** JSON body. */
	body?: unknown;
	/** Form fields (sent url-encoded). */
	form?: Record<string, string>;
	/** name → regex; group 1 of the first match in the answer (headers, then body) is saved for later steps. */
	save?: Record<string, string>;
	/** Where the new app differs in how it is asked (a moved route, a JSON body instead of a form), and which target stack answers. */
	target?: { method?: string; path?: string; headers?: Record<string, string>; body?: unknown; form?: Record<string, string>; stack?: string };
	why?: string;
	/** Exact download bytes, including textual exports. Otherwise JSON/text is compared. */
	response?: "bytes";
	responseHeaders?: string[];
}

export interface StepsFile {
	steps: Step[];
	checks?: ParityContract[];
	/** Exact old/new expectations for recorded decisions to drop legacy quirks. */
	changes?: BehaviorChange[];
	/** Additional servers used by checks (e.g. the browser's frontend server). */
	stacks?: string[];
	/** route → why it has no step (it cannot be called on its own, it needs an outside service …). */
	skipped?: Record<string, string>;
}

export interface StepResult {
	status?: number;
	location?: string;
	body?: unknown;
	headers?: Record<string, string | null>;
	/** What the step wrote: table → rows added and removed (only steps that may write, only when the app has a dump). */
	data?: Record<string, { added: unknown[]; removed: unknown[] }>;
	error?: string;
}

export type DataDump = Record<string, unknown[]>;

/** Database tables are multisets; row order and object property order do not change the seeded business data. */
export function canonicalData(data: DataDump): DataDump {
	const value = (v: unknown): unknown => isExactJsonNumber(v) ? v : Array.isArray(v) ? v.map(value) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, value(x)])) : v;
	return Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b)).map(([table, rows]) => {
		if (!Array.isArray(rows)) throw new Error(`data dump ${table} must contain an array of rows`);
		return [table, rows.map(value).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))];
	}));
}

export interface Diff {
	step: string;
	route: string;
	kind: "status" | "redirect" | "body" | "data" | "header" | "error";
	path: string;
	legacy: unknown;
	target: unknown;
}

const sliceDir = (root: string, slice: string) => join(root, ".bigrefactor", "parity", "slices", slice.replace(/[^\w.-]+/g, "_"));
const stepsPath = (root: string, slice: string) => join(sliceDir(root, slice), "steps.json");

/** The slice's routes on the old side ("GET /invoices") and its units' legacy files, with the framework routes it covers (frameworkRoutes). */
export function sliceFacts(ledger: Ledger, slice: string): { routes: string[]; files: string[]; units: Array<{ id: string; state: string }> } {
	const units = ledger.db.prepare("SELECT id, state, meta FROM units WHERE json_extract(meta, '$.slice') = ?").all(slice) as Array<{ id: string; state: string; meta: string }>;
	const files = units.flatMap((u) => (JSON.parse(u.meta) as { files?: string[] }).files ?? []);
	const own = new Set(files);
	const rows = ledger.db.prepare("SELECT method, path, handler_symbol FROM index_routes WHERE side = 'source'").all() as Array<{ method: string | null; path: string; handler_symbol: string | null }>;
	const routes = [...new Set(rows.filter((r) => r.handler_symbol && own.has(r.handler_symbol.split("::")[0]!)).map((r) => `${r.method ?? "ANY"} ${r.path}`))];
	const extra = [...frameworkRoutes(ledger)].filter(([, f]) => f.slice === slice);
	return { routes: [...routes, ...extra.map(([r]) => r)], files: [...new Set([...files, ...extra.flatMap(([, f]) => (f.file ? [f.file] : []))])], units: units.map((u) => ({ id: u.id, state: u.state })) };
}

const firstSegment = (path: string) => path.replace(/^\/+/, "").split("/")[0] ?? "";

/**
 * Source routes no unit's files hold (the framework's own: post_command, robots.txt, sitemap.xml), each given to
 * one slice whose steps compare it too: the slice whose own routes share its first path segment most, else the slice
 * with the most routes. Strict verification needs a compared step for every route; one the old app does not serve
 * here is compared too (both answer 404).
 */
export function frameworkRoutes(ledger: Ledger): Map<string, { slice: string; file?: string }> {
	const fileSlice = new Map<string, string>();
	for (const u of ledger.db.prepare("SELECT meta FROM units WHERE json_extract(meta, '$.slice') IS NOT NULL").all() as Array<{ meta: string }>) {
		const m = JSON.parse(u.meta) as { slice: string; files?: string[] };
		for (const f of m.files ?? []) fileSlice.set(f, m.slice);
	}
	const rows = ledger.db.prepare("SELECT method, path, handler_symbol FROM index_routes WHERE side = 'source'").all() as Array<{ method: string | null; path: string; handler_symbol: string | null }>;
	const bySegment = new Map<string, Map<string, number>>();
	const total = new Map<string, number>();
	const unowned: Array<{ key: string; path: string; file?: string }> = [];
	for (const r of rows) {
		const file = r.handler_symbol?.split("::")[0];
		const slice = file ? fileSlice.get(file) : undefined;
		if (!slice) {
			unowned.push({ key: `${r.method ?? "ANY"} ${r.path}`, path: r.path, file });
			continue;
		}
		const seg = bySegment.get(firstSegment(r.path)) ?? new Map<string, number>();
		seg.set(slice, (seg.get(slice) ?? 0) + 1);
		bySegment.set(firstSegment(r.path), seg);
		total.set(slice, (total.get(slice) ?? 0) + 1);
	}
	const most = (counts: Map<string, number> | undefined) => [...(counts ?? [])].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
	const fallback = most(total);
	const out = new Map<string, { slice: string; file?: string }>();
	for (const r of unowned) {
		const slice = most(bySegment.get(firstSegment(r.path))) ?? fallback;
		if (slice && !out.has(r.key)) out.set(r.key, { slice, file: r.file });
	}
	return out;
}

/** The slice's units that hold one of its routes' handlers: once these are accepted, the slice can be compared. */
export function routeOwners(ledger: Ledger, slice: string): Array<{ id: string; state: string }> {
	const units = ledger.listUnits().filter((u) => (JSON.parse(u.meta) as { slice?: string }).slice === slice);
	const rows = ledger.db.prepare("SELECT handler_symbol FROM index_routes WHERE side = 'source' AND handler_symbol IS NOT NULL").all() as Array<{ handler_symbol: string }>;
	const handlers = new Set(rows.map((r) => r.handler_symbol.split("::")[0]!));
	return units.filter((u) => ((JSON.parse(u.meta) as { files?: string[] }).files ?? []).some((f) => handlers.has(f))).map((u) => ({ id: u.id, state: u.state }));
}

/** Every unit of the slice is accepted: its whole behaviour exists in the new app. */
export function sliceComplete(ledger: Ledger, slice: string): boolean {
	const units = ledger.db.prepare("SELECT state FROM units WHERE json_extract(meta, '$.slice') = ?").all(slice) as Array<{ state: string }>;
	return units.length > 0 && units.every((u) => u.state === "accepted");
}

/**
 * HTTP slices can compare accepted routes early. A slice without route owners waits for all its units; the run then
 * prepares its checks (data, dynamic and foundation had none, so they were never compared).
 */
export function paritySliceReady(ledger: Ledger, slice: string): boolean {
	const owners = routeOwners(ledger, slice);
	if (owners.length) return owners.some((u) => u.state === "accepted");
	return sliceComplete(ledger, slice);
}

/** What strict verification would still miss in a complete slice's suite (no suite, routes without a step, pages without a browser check). */
export function suiteGaps(ledger: Ledger, root: string, slice: string): string[] {
	if (!sliceComplete(ledger, slice)) return [];
	const suite = loadSteps(root, slice);
	if (!suite || !Array.isArray(suite.steps)) return ["no steps.json"];
	return strictSuiteProblems(suite, sliceFacts(ledger, slice).routes, root);
}

/** Why these steps cannot be used, or undefined. Every slice route needs a step or a reason it has none. */
const routeKey = (r: unknown) => String(r ?? "").trim().replace(/^[A-Z]+(?:\|[A-Z]+)*\s+/, "").replace(/^\/+/, "");

/** The routes that have no compared step, only a reason in skipped. */
export function skippedRoutes(f: StepsFile, routes: string[]): string[] {
	const stepped = new Set((f?.steps ?? []).filter((s) => s.compare !== "none").map((s) => routeKey(s.route)));
	const skipped = new Set(Object.keys(f?.skipped ?? {}).map(routeKey));
	return routes.filter((r) => !stepped.has(routeKey(r)) && skipped.has(routeKey(r)));
}

/**
 * A slice may skip at most this share of its routes: config skipped 75 of 76 ("needs an existing id", "needs
 * a login") and was called the same as the old app on one compared step.
 */
export const MAX_SKIPPED_SHARE = 0.5;

/** `login`: the old app has a test account, so the steps must log in before the routes behind it. */
export function stepsProblem(f: StepsFile, routes: string[], stacks: string[], o: { login?: boolean } = {}): string | undefined {
	if (!Array.isArray(f?.steps) || (!f.steps.length && (routes.length || !f.checks?.length))) return "steps.json needs a non-empty steps array (or executable checks for a route-less slice)";
	const ids = new Set<string>();
	for (const s of f.steps) {
		if (!s.id || ids.has(s.id)) return `every step needs its own id (${s.id || "missing"})`;
		ids.add(s.id);
		if (!s.method || typeof s.path !== "string" || !s.path.startsWith("/")) return `step ${s.id}: needs a method and a path starting with /`;
		if (!["data", "redirect", "page", "none"].includes(s.compare)) return `step ${s.id}: compare must be data, redirect, page or none`;
		if (s.target?.path !== undefined && !s.target.path.startsWith("/")) return `step ${s.id}: target.path must start with /`;
		if (s.target?.stack && !stacks.includes(s.target.stack)) return `step ${s.id}: target.stack must be one of ${stacks.join(", ")}`;
		for (const [n, re] of Object.entries(s.save ?? {}))
			try {
				new RegExp(re);
			} catch {
				return `step ${s.id}: save.${n} is not a valid regex`;
			}
	}
	// a route counts with or without its method word and leading slash ("ANY dashboard/ajax" = "dashboard/ajax")
	const covered = new Set([...f.steps.filter((s) => s.compare !== "none").map((s) => s.route), ...Object.keys(f.skipped ?? {})].map(routeKey));
	const missing = routes.filter((r) => !covered.has(routeKey(r)));
	if (missing.length) return `these routes have no compared step and no reason in skipped: ${missing.join(", ")}`;
	const skipped = skippedRoutes(f, routes);
	if (skipped.length >= 2 && skipped.length > routes.length * MAX_SKIPPED_SHARE)
		return `${skipped.length} of ${routes.length} routes are only skipped: give most routes a compared step (log in${o.login ? " with the test account" : ""}, take the ids a route needs from the data the old app has, or create them in an earlier step and save them). Skip only a route that cannot be called here at all`;
	if (o.login && f.steps.length && !f.steps.some((s) => s.compare === "none"))
		return `a test account is known: log in first with a step whose route is "setup" and compare "none" (steps after it run logged in), so the routes behind the login are compared logged in, not only their redirect to the login page`;
	return undefined;
}

export function loadSteps(root: string, slice: string): StepsFile | undefined {
	try {
		return parseExactJson(readFileSync(stepsPath(root, slice), "utf8")) as StepsFile;
	} catch {
		return undefined;
	}
}

// ---- running steps against one app ----------------------------------------------------------------------

const WRITES = (m: string) => !/^(GET|HEAD|OPTIONS)$/i.test(m);

function fill<T>(v: T, vars: Map<string, string>): T {
	if (isExactJsonNumber(v)) return v;
	if (typeof v === "string") return v.replace(/\{\{(\w+)\}\}/g, (m, n: string) => vars.get(n) ?? m) as T;
	if (Array.isArray(v)) return v.map((x) => fill(x, vars)) as T;
	if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, vars)])) as T;
	return v;
}

/** Rows added and removed per table, as multisets of whole rows. */
export function dataChanges(before: Record<string, unknown[]>, after: Record<string, unknown[]>): Record<string, { added: unknown[]; removed: unknown[] }> {
	const out: Record<string, { added: unknown[]; removed: unknown[] }> = {};
	for (const t of new Set([...Object.keys(before), ...Object.keys(after)])) {
		const left = (before[t] ?? []).map((r) => JSON.stringify(r));
		const added: unknown[] = [];
		for (const r of after[t] ?? []) {
			const i = left.indexOf(JSON.stringify(r));
			if (i >= 0) left.splice(i, 1);
			else added.push(r);
		}
		if (added.length || left.length) out[t] = { added, removed: left.map((r) => parseExactJson(r)) };
	}
	return out;
}

/** In answers and written data, each app's own address ("localhost:18080") is this: the two apps run on different ports. */
export const THIS_APP = "(this app)";

/**
 * The harness's own noise taken out of an answer or written rows: the app's own host:port (also url-encoded) becomes
 * THIS_APP, and a dump's {"base64": …} value that is plain text is that text (one app's dump prints binary columns
 * so, the other the text). Without it, a session row holding a URL differed on every run.
 */
export function plainValue(v: unknown, hosts: string[], decodeBinary = true): unknown {
	if (isExactJsonNumber(v)) return v;
	if (typeof v === "string") return hosts.reduce((t, h) => t.split(h).join(THIS_APP).split(encodeURIComponent(h)).join(encodeURIComponent(THIS_APP)), v);
	if (Array.isArray(v)) return v.map((x) => plainValue(x, hosts, decodeBinary));
	if (v && typeof v === "object") {
		const keys = Object.keys(v);
		const b64 = (v as { base64?: unknown }).base64;
		if (decodeBinary && keys.length === 1 && typeof b64 === "string")
			try {
				return plainValue(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(b64, "base64")), hosts, decodeBinary);
			} catch {
				return v;
			}
		return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plainValue(x, hosts, decodeBinary)]));
	}
	return v;
}

/**
 * A text answer as compared: line endings are the same in both apps. A page that differs only in \r\n against \n
 * looks the same to every client; the judge called it a bug and reopened U2081 for three download error pages.
 */
export const textBody = (text: string, hosts: string[]): unknown => plainValue(text.replace(/\r\n?/g, "\n"), hosts);

/** The host:port of an app's base URL, when it names a port (a bare "localhost" is too common to replace). */
const ownHost = (base: string) => {
	try {
		const u = new URL(base);
		return u.port ? u.host : undefined;
	} catch {
		return undefined;
	}
};

/**
 * Send the steps to one running app, in order, with one cookie jar (a login holds). `side` picks the request
 * shape: the old app gets the step as written, the new app the step with its `target` changes.
 */
export async function runSteps(steps: Step[], o: { side: "legacy" | "target"; base: (s: Step) => string; slice?: string; dump?: (context: ObservationContext) => Record<string, unknown[]> | Promise<Record<string, unknown[]>>; strict?: boolean; onInitialData?: (data: DataDump) => void; baseUrls?: string[] }): Promise<StepResult[]> {
	const vars = new Map<string, string>();
	const jar = new Map<string, string>();
	let data = await o.dump?.({ side: o.side, slice: o.slice, phase: "initial" });
	const results: StepResult[] = [];
	const hosts = [...new Set([...steps.map((s) => o.base(s)), ...(o.baseUrls ?? [])].map(ownHost).filter((h): h is string => !!h))];
	if (data !== undefined && o.onInitialData) o.onInitialData(canonicalData(plainValue(data, hosts) as DataDump));
	for (const s of steps) {
		const t = o.side === "target" ? s.target ?? {} : {};
		const method = (t.method ?? s.method).toUpperCase();
		const path = fill(t.path ?? s.path, vars);
		const form = fill(t.form ?? (t.body === undefined ? s.form : undefined), vars);
		const body = fill(t.body ?? (t.form === undefined ? s.body : undefined), vars);
		const headers: Record<string, string> = { ...fill(s.headers ?? {}, vars), ...fill(t.headers ?? {}, vars) };
		if (jar.size) headers["cookie"] = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
		let payload: string | undefined;
		if (form) (payload = new URLSearchParams(form).toString()), (headers["content-type"] ??= "application/x-www-form-urlencoded");
		else if (body !== undefined) (payload = JSON.stringify(body)), (headers["content-type"] ??= "application/json");
		const r: StepResult = {};
		try {
			const base = o.base(s);
			const res = await fetch(new URL(path, base), { method, headers, body: payload, redirect: "manual", signal: AbortSignal.timeout(30_000) });
			for (const c of res.headers.getSetCookie()) {
				const [kv] = c.split(";");
				const i = kv!.indexOf("=");
				if (i > 0) jar.set(kv!.slice(0, i).trim(), kv!.slice(i + 1).trim());
			}
			r.status = res.status;
			const loc = res.headers.get("location");
			if (loc) {
				// the app's own address is dropped: the two apps run on different ports. An http → https redirect to
				// itself keeps only the scheme, so it still matches the other app doing the same.
				const u = new URL(loc, base);
				const b = new URL(base);
				r.location = u.host !== b.host ? u.href : u.protocol === b.protocol ? `${u.pathname}${u.search}` : `${u.protocol}//(this app)${u.pathname}${u.search}`;
			}
			const bytes = Buffer.from(await res.arrayBuffer());
			let text = "";
			let binary = s.response === "bytes" || /attachment/i.test(res.headers.get("content-disposition") ?? "") || /^(?:image|audio|video)\/|application\/(?:octet-stream|pdf|zip|vnd\.)/i.test(res.headers.get("content-type") ?? "");
			try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { binary = true; }
			if (o.strict || s.responseHeaders?.length) r.headers = Object.fromEntries([...new Set([...(o.strict ? ["content-type", "content-disposition"] : []), ...(s.responseHeaders ?? [])].map((h) => h.toLowerCase()))].map((h) => [h, res.headers.get(h)]));
			try {
				r.body = binary ? { base64: bytes.toString("base64") } : plainValue(parseExactJson(text), hosts, false);
			} catch {
				r.body = textBody(text, hosts);
			}
			const headText = [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n");
			for (const [n, re] of Object.entries(s.save ?? {})) {
				const m = new RegExp(re).exec(headText) ?? new RegExp(re).exec(text);
				// the pattern missed (the page writes the attributes in another order, or JSON): the value of the form
				// field a later step sends it in, read from the page's inputs or JSON
				const v = m?.[1] ?? fieldsFor(steps, n, o.side).map((f) => fieldValue(text, f)).find((x) => x !== undefined);
				if (v !== undefined) vars.set(n, v);
			}
		} catch (e: any) {
			r.error = String(e?.cause?.message ?? e?.message ?? e);
		}
		if (o.dump && (o.strict || WRITES(method))) {
			try {
				const after = await o.dump({ side: o.side, slice: o.slice, phase: "step", step: s.id });
				r.data = plainValue(dataChanges(data ?? {}, after), hosts) as StepResult["data"];
				data = after;
			} catch (e: any) {
				r.error ??= `data dump failed: ${e?.message ?? e}`;
			}
		}
		results.push(r);
	}
	return results;
}

// ---- comparing -------------------------------------------------------------------------------------------

export { differences } from "./differences.ts";

/** What a step's `compare` says is compared. */
function view(s: Step, r: StepResult, withData: boolean, strict = false): Record<string, unknown> | undefined {
	if (s.compare === "none") return undefined;
	const v: Record<string, unknown> = {};
	v["status"] = r.status;
	if (s.compare === "redirect" || s.compare === "data") v["redirect"] = r.location ?? null;
	if (s.compare === "data") v["body"] = r.body;
	if (strict || s.responseHeaders?.length) v["headers"] = r.headers;
	if (withData && r.data) v["data"] = r.data;
	return v;
}

/** The form fields (or JSON keys) later steps fill with `{{name}}`, as this side sends them. */
function fieldsFor(steps: Step[], name: string, side: "legacy" | "target"): string[] {
	const out = new Set<string>();
	for (const s of steps) {
		const t = side === "target" ? s.target ?? {} : {};
		for (const fields of [t.form ?? s.form, t.body ?? s.body])
			if (fields && typeof fields === "object") for (const [k, v] of Object.entries(fields as Record<string, unknown>)) if (v === `{{${name}}}`) out.add(k);
	}
	return [...out];
}

/** The value of form field `name` in an answer: an <input> with that name (attributes in any order), or a JSON key. */
export function fieldValue(text: string, name: string): string | undefined {
	for (const tag of text.match(/<input\b[^>]*>/gi) ?? []) {
		const attr = (a: string) => new RegExp(`\\s${a}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
		const n = attr("name");
		if (n && (n[1] ?? n[2] ?? n[3]) === name) {
			const v = attr("value");
			return v ? (v[1] ?? v[2] ?? v[3] ?? "") : "";
		}
	}
	try {
		const find = (x: unknown): string | undefined => {
			if (!x || typeof x !== "object" || isExactJsonNumber(x)) return undefined;
			for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
				if (k === name && (typeof v === "string" || typeof v === "number" || isExactJsonNumber(v))) return String(v);
				const deeper = find(v);
				if (deeper !== undefined) return deeper;
			}
			return undefined;
		};
		return find(parseExactJson(text));
	} catch {
		return undefined;
	}
}

/** The old app sent the request on to itself over another scheme (http → https): no handler answered it. */
export const selfRedirect = (r: StepResult) => (r.status ?? 0) >= 300 && (r.status ?? 0) < 400 && /^\w+:\/\/\(this app\)/.test(r.location ?? "");

/**
 * The steps after a login (a "none" step) that the answers send back to that login's page: the login did not hold, so
 * the step only shows the login wall. Returns their indexes.
 */
export function loginWall(steps: Step[], results: StepResult[], side: "legacy" | "target" = "legacy"): Set<number> {
	const pathOf = (p: string) => p.split(/[?#]/)[0]!.replace(/\/+$/, "") || "/";
	const pages = new Set<string>();
	const out = new Set<number>();
	steps.forEach((s, i) => {
		if (s.compare === "none") return void pages.add(pathOf(side === "target" ? s.target?.path ?? s.path : s.path));
		const r = results[i];
		if (pages.size && r && (r.status ?? 0) >= 300 && (r.status ?? 0) < 400 && r.location?.startsWith("/") && pages.has(pathOf(r.location))) out.add(i);
	});
	return out;
}

const covers = (noise: string, path: string) => path === noise || path.startsWith(`${noise}.`) || path.startsWith(`${noise}[`);

/**
 * The real differences between the old app (two runs) and the new app. Only what differs between the two old runs
 * is ignored. A step the old app itself fails on (no answer, 5xx, in either run) proves nothing and is listed as not compared,
 * and so is one it sends back to the login page after a login (the login did not hold: only the login wall was seen),
 * and so is one it only redirects to itself on https: both apps forcing https says nothing about the handler.
 */
export function compareRuns(steps: Step[], old1: StepResult[], old2: StepResult[], neu: StepResult[], withData: boolean, strict = false): { diffs: Diff[]; compared: number; notCompared: string[]; newLoginFailed?: boolean; unstable?: string[] } {
	const diffs: Diff[] = [];
	const notCompared: string[] = [];
	const unstable: string[] = [];
	let compared = 0;
	const wall = loginWall(steps, old1);
	// the new app sends every step after the login that the old app answered logged in back to its login page: the
	// comparison's login did not hold there (a token it could not read, a test account that does not work), so those
	// steps show only the login wall. That is no page's bug: they are not compared, and no unit is blamed for them.
	const loggedIn = steps.map((s, i) => i).filter((i) => steps[i]!.compare !== "none" && steps.slice(0, i).some((x) => x.compare === "none") && !wall.has(i) && old1[i]?.status !== undefined && !old1[i]!.error && old1[i]!.status! < 300);
	const newWall = loginWall(steps, neu, "target");
	const newLoginFailed = loggedIn.length > 0 && loggedIn.every((i) => newWall.has(i));
	steps.forEach((s, i) => {
		const a = old1[i] ?? { error: "missing result" };
		if (s.compare === "none") return;
		if (a.status === undefined) return void notCompared.push(`${s.id} (the old app: ${a.error ?? "missing status"})`);
		if (a.error || (a.status ?? 0) >= 500) return void notCompared.push(`${s.id} (the old app: ${a.error ?? `status ${a.status}`})`);
		if (selfRedirect(a)) return void notCompared.push(`${s.id} (the old app only redirects it to itself: ${a.status} → ${a.location})`);
		if (wall.has(i)) return void notCompared.push(`${s.id} (the old app sends it to the login page: the login before it did not hold)`);
		if (newLoginFailed && newWall.has(i)) return void notCompared.push(`${s.id} (the new app sends it to the login page: the comparison's login did not hold there)`);
		// a failed second old run would make everything look like noise and hide every real difference
		const a2 = old2[i] ?? { error: "missing result" };
		if (a2.status === undefined) return void notCompared.push(`${s.id} (the old app's second run: ${a2.error ?? "missing status"})`);
		if (a2.error || (a2.status ?? 0) >= 500) return void notCompared.push(`${s.id} (the old app's second run: ${a2.error ?? `status ${a2.status}`})`);
		compared++;
		const b = neu[i] ?? { error: "missing result" };
		if (b.error) return void diffs.push({ step: s.id, route: s.route, kind: "error", path: "", legacy: view(s, a, withData, strict), target: b.error });
		const noise = differences(view(s, a, withData, strict), view(s, a2, withData, strict)).map((d) => d.path);
		if (strict) unstable.push(...noise.map((p) => `${s.id}: legacy differs at ${p}`));
		for (const d of differences(view(s, a, withData, strict), view(s, b, withData, strict))) {
			if (noise.some((n) => covers(n, d.path))) continue;
			const top = d.path.split(/[.[]/)[0]!;
			diffs.push({ step: s.id, route: s.route, kind: top === "headers" ? "header" : top === "redirect" ? "redirect" : top === "body" ? "body" : top === "data" ? "data" : "status", path: d.path, legacy: d.a, target: d.b });
		}
	});
	return { diffs, compared, notCompared, ...(newLoginFailed ? { newLoginFailed } : {}), ...(strict ? { unstable } : {}) };
}

// ---- the tester that writes the steps ---------------------------------------------------------------------

/** Starts one side's app with its saved recipe (read again: a setup fix may have saved a new one). */
type Boot = (side: string) => Promise<Booted>;
const plainBoot = (config: Config, root: string): Boot => async (side) => {
	const recipe = loadApps(root)[side]?.recipe;
	return recipe ? bootApp(recipe, appRoot(config, root, side)) : { ok: false, stage: "setup", error: "it has no start recipe (br parity --probe)" };
};

/** Start the old app (data reset first), send the steps, stop it. A string says why it did not start. */
async function runOnOld(config: Config, root: string, steps: Step[], boot: Boot = plainBoot(config, root), extra?: { slice?: string; strict?: boolean; after?: () => Promise<void>; onInitialData?: (data: DataDump) => void }): Promise<StepResult[] | string> {
	const b = await boot(LEGACY);
	if (!b.ok) return `the old app did not start: ${b.error}`;
	const recipe = loadApps(root)[LEGACY]!.recipe!;
	const dir = appRoot(config, root, LEGACY);
	try {
		const results = await runSteps(steps, { side: "legacy", slice: extra?.slice, base: () => recipe.ready, baseUrls: [recipe.ready], dump: recipe.dump ? (context) => dumpData(recipe, dir, context) : undefined, strict: extra?.strict, onInitialData: extra?.onInitialData });
		await extra?.after?.();
		return results;
	} finally {
		await b.stop();
	}
}

const short = (v: unknown, n = 300) => {
	const t = typeof v === "string" ? v : JSON.stringify(v);
	return t && t.length > n ? `${t.slice(0, n)}…` : t;
};

function tryOnOldTool(config: Config, root: string, slice: string): ToolDefinition {
	return {
		name: "try_on_old_app",
		label: "Try the steps on the old app",
		description: "Start the old app (its data reset first, when it has a reset), send the steps in steps.json in order, stop it. Shows each step's answer: status, redirect, the start of the body, what it wrote.",
		promptSnippet: "try_on_old_app: send steps.json to the old app and see its answers",
		parameters: Type.Object({}),
		execute: async () => {
			const f = loadSteps(root, slice);
			if (!f || !Array.isArray(f.steps) || (!f.steps.length && !f.checks?.length)) return { content: [{ type: "text", text: "steps.json is missing or has no steps/checks" }], details: {} };
			const checks = f.checks ?? [];
			let observed: ContractResult[] = [];
			const invalid = checks.length ? strictSuiteProblems({ ...f, steps: f.steps.map((s) => s.compare === "page" ? { ...s, compare: "data" as const } : s) }, [], root) : [];
			if (invalid.length) return { content: [{ type: "text", text: invalid.join("\n") }], details: {} };
			const r = await runOnOld(config, root, f.steps, plainBoot(config, root), { slice, after: async () => { observed = await runContracts(checks, { root, config, side: "legacy", slice, appDir: appRoot(config, root, LEGACY), urls: { legacy: loadApps(root)[LEGACY]!.recipe!.ready } }); } });
			const text = typeof r === "string" ? r : f.steps.map((s, i) => `${s.id} ${s.method} ${s.path} → ${r[i]!.error ? `ERROR ${r[i]!.error}` : `${r[i]!.status}${r[i]!.location ? ` → ${r[i]!.location}` : ""} ${short(r[i]!.body)}${r[i]!.data && Object.keys(r[i]!.data!).length ? ` wrote ${short(r[i]!.data, 200)}` : ""}`}`).join("\n");
			const wall = typeof r === "string" ? [] : [...loginWall(f.steps, r)].map((i) => f.steps[i]!.id);
			const hint = wall.length ? `\n${wall.length} step(s) after the login go back to the login page (${wall.join(", ")}): the login did not hold; they are not compared until it does.` : "";
			return { content: [{ type: "text", text: text + hint + (checks.length ? `\nExecutable legacy observations: ${JSON.stringify(observed)}` : "") }], details: {} };
		},
	} as unknown as ToolDefinition;
}

/** Returns the model's last sentence. */
export type StepWriter = (o: { config: Config; root: string; slice: string; dir: string; problem: string; stronger?: boolean }) => Promise<string | void>;

export const writeStepsWithModel: StepWriter = async (o) => {
	const logins = loginFacts(o.root, o.config.target.stacks);
	const session = await spawnLeaf({
		role: "test",
		...(o.stronger ? { modelOverride: o.config.models.escalate } : {}),
		cwd: o.dir,
		config: o.config,
		writeGlobs: ["steps.json", "checks/**"],
		protectedGlobs: [],
		customTools: [tryOnOldTool(o.config, o.root, o.slice)],
		transcriptPath: join(o.root, ".bigrefactor", "sessions", `__parity__.${o.slice}.steps.${Date.now()}.jsonl`),
		systemPrompt: `You write the HTTP requests a migration tool sends to the OLD app and to the NEW app, to compare their answers. Write them to steps.json in your folder. You try them on the old app with try_on_old_app; you never see the new app's answers, and you never shape a request to make the apps look alike. Read the old handlers to know what each route expects (parameters, form fields, login, tokens) and the new project to know where each route went.\n\nsteps.json: {"steps": [Step, …], "skipped": {"<route>": "why it has no step"}}. A Step: {"id": "s1", "route": "<one of the slice routes, or setup>", "compare": "data" | "redirect" | "page" | "none", "method": "GET", "path": "/…", "headers"?: {}, "body"?: <JSON>, "form"?: {field: value}, "save"?: {"name": "regex with one group"}, "target"?: {"method"?, "path"?, "headers"?, "body"?, "form"?, "stack"?}, "why"?: "…"}.\n- compare: data = an answer with data (JSON or text) where status, redirect and body must match; redirect = status and where it sends to; page = an HTML page (its status and what it writes are compared, not its HTML); none = preparation such as a login.\n- Steps run in order with one cookie jar, so a login step holds for the steps after it. "{{name}}" in a later step is replaced by a value saved earlier (a CSRF token, a new id).\n- target: only what the new app needs differently (the route moved, it takes JSON instead of a form, another target stack answers it: ${o.config.target.stacks.join(", ")}).\n- Every slice route gets at least one compared step. Skip a route (with its reason in skipped) only when it cannot be called here at all (it needs an outside service, say). A route that needs a login or an existing id is not skipped: log in, and take the id from the data the old app has (its answers, its handlers) or create it in an earlier step and save it. At most half the routes may be skipped.\n- ${logins.text}${logins.login ? ' Log in first with these: a step with route "setup" and compare "none" (with the new app\'s login as its target when it differs). Steps that check the logged-out answer go before it.' : ""}\n- ${loadApps(o.root)[LEGACY]?.recipe?.reset ? "Steps that write data are fine: the data is reset before every run." : "The data is NOT reset between runs: a step that writes must still work when it runs again (use new names, or save the id it creates)."}\nEnd with one sentence.\n\n${PLAIN_LANGUAGE}`,
	});
	try {
		const r = await session.run(`${o.problem}\n\nExecutable checks are supported in steps.json: checks:[{id,kind:"browser"|"data"|"command"|"effects",covers:[compared step ids],why,command:{cmd,args},inputs:[script/fixture paths]}]. Additional target servers: stacks:[stack ids]. You may write driver files under checks/. Commands run from the workspace ${o.root}; use workspace-relative script paths (your suite lives at ${join(o.dir, "checks")}). They get BR_PARITY_SIDE=legacy|target, BR_PARITY_APP_DIR (runtime project directory), BR_PARITY_URLS (JSON map legacy→URL or target stack→URL), BR_PARITY_TARGET_DIR (target worktree on target side) and BR_PARITY_CHECK. They print exactly one non-empty JSON object of actual business observations; logs go to stderr and failed assertions exit nonzero. The same observations must match on both apps, including changed UI/route/schema representations. A browser check must load the real app entry with its production loaders and interact through Playwright: a CommonJS driver (checks/*.cjs) can require("playwright") and launch headless Chromium (both provided); never inject test-only props or hand back constant success. Use data checks to reconcile migrated records and effects checks for captured emails/queues/external calls. Use try_on_old_app to execute checks; do not run or inspect the new app's responses while authoring. Read new code only to map paths, selectors and interfaces. Do not change existing expected behavior to match new code. Each page step needs a browser check covering its id for final verification. A slice without HTTP routes may have steps:[] but needs executable checks. Include driver dependency/fixture files in inputs. Do not install tools or start external services from drivers; report unavailable tooling/setup precisely.`);
		const said = r.text.trim().split("\n").at(-1) ?? "";
		console.log(pc.dim(`  parity steps (${o.slice}): ${r.toolCalls} tool calls, $${r.usage.cost.toFixed(4)} — ${said}${r.error ? pc.red(` ERROR: ${r.error}`) : ""}`));
		return said;
	} finally {
		session.dispose();
	}
};

// ---- one slice, end to end --------------------------------------------------------------------------------

export interface SliceCheck {
	runId?: number;
	/** setup = an app could not be started here (its data reset or start), even after its setup was asked to fix it: says nothing about the code. */
	outcome: "same" | "differs" | "error" | "setup";
	diffs: Diff[];
	compared: number;
	note: string;
	/** The new app of this stack did not start on main: a main problem for the builder, not only a parity error. */
	down?: { stack: string; error: string };
	/** outcome setup: the app that did not start ("legacy" or a stack), even after its setup fixer tried. */
	setup?: { side: string };
	evidence?: SliceEvidence;
	/** A preparation that could not write the missing checks: why (the slice was compared with its existing steps). */
	unprepared?: string;
}

export interface SliceEvidence {
	version: 1;
	sourceCommit?: string;
	targetCommit?: string;
	suiteHash: string;
	inputs: Record<string, string>;
	recipesHash: string;
	steps: Step[];
	suite: StepsFile;
	legacy: [StepResult[], StepResult[]];
	target: StepResult[];
	checks: { legacy: [ContractResult[], ContractResult[]]; target: ContractResult[] };
	fixture?: { legacy: [DataDump, DataDump]; target: DataDump };
	problems: string[];
}

/**
 * Compare one slice: steps (written once, `rewrite` writes them anew), the old app run twice, the new app once in a
 * fresh worktree of main, differences into the ledger. Needs both apps' recipes (br parity --probe).
 */
/** How often one slice check hands an app that did not start to its setup fixer before it records that. */
export const MAX_SETUP_RETRIES = 2;

export async function checkSlice(o: { ledger: Ledger; config: Config; root: string; slice: string; linkAll: (wt: string) => void | Promise<void>; serverStack: string; writer?: StepWriter; rewrite?: boolean; prepare?: boolean; onlyAccepted?: boolean; log?: (l: string) => void; fixSetup?: (side: string, error: string) => Promise<boolean>; ensureLogins?: (sides: string[]) => Promise<void>; strict?: boolean }): Promise<SliceCheck> {
	const log = o.log ?? ((l: string) => console.log(l));
	const startedAt = new Date().toISOString();
	const mainAt = await headOf(o.config.target.path);
	const record = (c: Omit<SliceCheck, "runId">, steps = 0, skipped = 0): SliceCheck => {
		const runId = Number(o.ledger.db.prepare("INSERT INTO parity_runs(slice, outcome, steps, compared, skipped, note, started_at, ended_at, commit_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(o.slice, c.outcome, steps, c.compared, skipped, c.note, startedAt, new Date().toISOString(), mainAt ?? null).lastInsertRowid);
		const ins = o.ledger.db.prepare("INSERT INTO parity_diffs(run_id, slice, step, route, kind, path, legacy, target) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
		for (const d of c.diffs) ins.run(runId, o.slice, d.step, d.route, d.kind, d.path, JSON.stringify(d.legacy ?? null), JSON.stringify(d.target ?? null));
		if (c.evidence) {
			const dir = join(o.root, ".bigrefactor", "parity", "evidence");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, `${runId}.json`), JSON.stringify({ runId, slice: o.slice, ...c.evidence }, null, 2) + "\n");
		}
		return { ...c, runId };
	};
	const fail = (note: string) => (log(pc.yellow(`parity ${o.slice}: ${note}`)), record({ outcome: "error", diffs: [], compared: 0, note }));
	const setupFail = (note: string, side: string) => (log(pc.yellow(`parity ${o.slice}: not compared, ${note}`)), { ...record({ outcome: "setup", diffs: [], compared: 0, note: `setup: ${note}` }), setup: { side } });
	// an app that does not start here (data reset, start, no answer) goes to its setup fixer with what failed, then is
	// started again (a few times per check at most): a hung server is as often a stopped database as broken code. Only
	// a new app whose own start still fails after that is main's code, the builder's
	const fixes = new Map<string, number>();
	const name = (side: string) => (side === LEGACY ? "the old app" : `the new ${side} app`);
	const boot: Boot = async (side) => {
		for (;;) {
			const b = await plainBoot(o.config, o.root)(side);
			const a = loadApps(o.root)[side];
			if (b.ok) {
				// it starts again: the next failure gets its own fixes
				if (a?.bootProbes || a?.bootProblem || a?.bootQuestion !== undefined) saveApp(o.root, side, { bootProbes: undefined, bootProblem: undefined, bootQuestion: undefined });
				return b;
			}
			if (!o.fixSetup || (fixes.get(side) ?? 0) >= MAX_SETUP_RETRIES) return b;
			fixes.set(side, (fixes.get(side) ?? 0) + 1);
			log(pc.yellow(`parity ${o.slice}: ${name(side)} did not start (${b.error.split("\n")[0]!.slice(0, 200)}): its setup is asked to fix it`));
			if (!(await o.fixSetup(side, b.error).catch(() => false))) return b;
		}
	};

	let apps = loadApps(o.root);
	if (!apps[LEGACY]?.up || !apps[LEGACY].recipe) return setupFail("the old app does not start here (br parity --probe)", LEGACY);
	const facts = sliceFacts(o.ledger, o.slice);
	const suite = loadSteps(o.root, o.slice);
	if (!facts.routes.length && !o.strict && !o.prepare && !suite?.checks?.length) return fail("this slice has no routes of its own to compare; prepare executable checks with br parity <slice> --prepare");
	if (o.strict) {
		if (!suite || !Array.isArray(suite.steps)) return fail("strict verification needs an existing steps.json (steps and executable checks); no suite is generated during verification");
		const issues = strictSuiteProblems(suite, facts.routes, o.root);
		if (!issues.length && suite.steps.length) {
			const invalid = stepsProblem(suite, facts.routes, o.config.target.stacks);
			if (invalid) issues.push(invalid);
		}
		if (suite.stacks && (!Array.isArray(suite.stacks) || suite.stacks.some((s) => !o.config.target.stacks.includes(s)))) issues.push("stacks must name configured target stacks");
		if (issues.length) return fail(issues.join("; "));
	}
	// `onlyAccepted` (the run): a slice not finished yet gets steps for, and compares, only the routes whose unit is
	// accepted; the others get their steps once their new code exists
	const waiting = o.onlyAccepted ? waitingRoutes(o.ledger, o.slice) : new Map<string, string>();
	const { files } = facts;
	const routes = readyRoutes(facts.routes, waiting);
	if (!routes.length && facts.routes.length && !o.strict) return { outcome: "error", diffs: [], compared: 0, note: `not compared yet: the units of its routes are not accepted (${[...new Set(waiting.values())].join(", ")})` };

	// the steps: written once per slice by the tester, checked by code
	const dir = sliceDir(o.root, o.slice);
	mkdirSync(dir, { recursive: true });
	// a test account on each app first, so the steps can log in (its setup model finds or makes one, a few times at most)
	if (!o.strict) await o.ensureLogins?.([...new Set([o.serverStack, ...(loadSteps(o.root, o.slice)?.steps ?? []).map((s) => s.target?.stack ?? o.serverStack)])]).catch((e) => log(pc.yellow(`parity ${o.slice}: test account: ${e?.message ?? e}`)));
	const login = loginFacts(o.root, o.config.target.stacks).login;
	let problem = o.rewrite || !existsSync(stepsPath(o.root, o.slice)) ? "" : stepsProblem(loadSteps(o.root, o.slice)!, routes, o.config.target.stacks, { login });
	// a suite that compares as it is: a preparation that cannot extend it still compares with it
	const usableBefore = !o.rewrite && !!suite && !problem;
	let unprepared: string | undefined;
	if (o.prepare && suite && !problem) problem = strictSuiteProblems(suite, routes, o.root).join("; ");
	if (!o.strict && (o.rewrite || !existsSync(stepsPath(o.root, o.slice)) || problem)) {
		const writer = o.writer ?? writeStepsWithModel;
		const ask = `Slice "${o.slice}". Its routes on the old app: ${routes.join(", ") || "none: this slice needs executable checks"}. The old handlers and the code they use (relative to ${o.config.source.path}): ${files.join(", ")}. The new project: ${o.config.target.path} (stacks ${o.config.target.stacks.join(", ")}; requests go to ${o.serverStack} unless a step's target.stack says otherwise). Write steps.json and try it on the old app until every step does what you meant.${o.prepare ? " Prepare for strict parity: retain existing scenarios and add real browser/data/command/effects checks for the missing behavior. Cover successful workflows, each relevant permission level and failure/boundary cases from the legacy handlers. No routes may be skipped. Do not delete scenarios to remove failures." : ""}${waiting.size ? ` The slice's other routes get their steps later, once their new code exists.` : ""}`;
		const backup = o.prepare ? mkdtempSync(join(tmpdir(), "br-parity-prepare-")) : undefined;
		let usable = false;
		let backedUp = false;
		const restore = () => {
			if (!backup || !backedUp) return;
			for (const path of ["steps.json", "checks"]) {
				rmSync(join(dir, path), { recursive: true, force: true });
				if (existsSync(join(backup, path))) cpSync(join(backup, path), join(dir, path), { recursive: true });
			}
		};
		try {
			for (const path of ["steps.json", "checks"]) if (backup && existsSync(join(dir, path))) cpSync(join(dir, path), join(backup, path), { recursive: true });
			backedUp = true;
			for (let i = 0; i < 2; i++) {
				await writer({ config: o.config, root: o.root, slice: o.slice, dir, stronger: !!o.prepare && i > 0, problem: problem ? `${ask}\n\nThe steps.json you wrote cannot be used: ${problem}` : ask }).catch((e) => log(pc.yellow(`parity ${o.slice}: step writer failed: ${e?.message ?? e}`)));
				const f = loadSteps(o.root, o.slice);
				problem = f ? stepsProblem(f, routes, o.config.target.stacks, { login }) : "steps.json is missing or not valid JSON";
				if (o.prepare && f && !problem) problem = [...strictSuiteProblems(f, routes, o.root), ...(suite ? retainedScenarioProblems(suite, f) : [])].join("; ");
				if (!problem) break;
				if (i === 0) restore();
			}
			if (problem && !(o.prepare && usableBefore)) return fail(`no usable steps: ${problem}`);
			if (problem) {
				unprepared = problem;
				log(pc.yellow(`parity ${o.slice}: the missing checks could not be written (${problem.slice(0, 300)}); compared with the existing steps`));
			} else usable = true;
		} finally {
			if (backup) {
				if (!usable) restore();
				rmSync(backup, { recursive: true, force: true });
			}
		}
	}
	const finalSuite = loadSteps(o.root, o.slice)!;
	const { steps, held } = holdBack(finalSuite.steps, waiting);
	if (finalSuite.checks !== undefined && !Array.isArray(finalSuite.checks)) return fail("checks must be an array");
	if (finalSuite.stacks !== undefined && !Array.isArray(finalSuite.stacks)) return fail("stacks must be an array");
	const checks = (finalSuite.checks ?? []).filter((c) => !o.onlyAccepted || !Array.isArray(c?.covers) || c.covers.every((id) => steps.some((s) => s.id === id && s.compare !== "none")));
	if (!o.strict && !steps.some((s) => s.compare !== "none") && !checks.length) return { outcome: "error", diffs: [], compared: 0, note: `not compared yet: the units of its routes are not accepted (${held.join(", ")})` };
	if (checks.length) {
		const invalid = strictSuiteProblems({ ...finalSuite, steps: finalSuite.steps.map((s) => s.compare === "page" ? { ...s, compare: "data" as const } : s) }, [], o.root);
		if (invalid.length) return fail(invalid.join("; "));
	}
	const suiteHash = digest(readFileSync(stepsPath(o.root, o.slice)));
	const inputs = await contractInputs(o.root, checks);
	const recipesHash = digest(JSON.stringify(Object.fromEntries(Object.entries(apps).map(([s, a]) => [s, a.recipe]))));
	const oldChecks: ContractResult[][] = [];
	const oldData: DataDump[] = [];
	let targetData: DataDump | undefined;
	const collectData = o.strict && o.config.db.strategy === "keep-schema";
	const initialData = collectData ? (data: DataDump) => { oldData.push(data); } : undefined;
	const afterOld = async () => { oldChecks.push(await runContracts(checks, { root: o.root, config: o.config, side: "legacy", slice: o.slice, appDir: appRoot(o.config, o.root, LEGACY), urls: { legacy: loadApps(o.root)[LEGACY]!.recipe!.ready } })); };

	// the old app twice (what differs between those two runs is noise), then the new app
	const old1 = await runOnOld(o.config, o.root, steps, boot, { slice: o.slice, strict: o.strict, after: checks.length ? afterOld : undefined, onInitialData: initialData });
	if (typeof old1 === "string") return setupFail(old1, LEGACY);
	const old2 = await runOnOld(o.config, o.root, steps, boot, { slice: o.slice, strict: o.strict, after: checks.length ? afterOld : undefined, onInitialData: initialData });
	if (typeof old2 === "string") return setupFail(old2, LEGACY);
	const stacks = [...new Set([o.serverStack, ...steps.map((s) => s.target?.stack ?? o.serverStack), ...(finalSuite.stacks ?? [])])];
	if (stacks.some((s) => !o.config.target.stacks.includes(s))) return fail("stacks must name configured target stacks");
	const down = stacks.filter((s) => !apps[s]?.up || !apps[s]!.recipe);
	if (down.length) return setupFail(`the new ${down.join(", ")} app does not start here (br parity --probe)`, down[0]!);
	const wt = await prepareTargetCopy(o.config, o.root, o.linkAll);
	let neu: StepResult[];
	let targetChecks: ContractResult[] = [];
	const targetCommit = await headOf(wt);
	let targetChanged = false;
	try {
		const stops: Array<() => Promise<void>> = [];
		try {
			for (const s of stacks) {
				const b = await boot(s);
				if (!b.ok) return b.stage === "start" ? { ...fail(`the new ${s} app did not start${fixes.has(s) ? " (its setup could not fix it)" : ""}: ${b.error}`), down: { stack: s, error: b.error } } : setupFail(`the new ${s} app did not start: ${b.error}`, s);
				stops.push(b.stop);
			}
			// the recipes as they are now: a setup fix may have saved new ones
			apps = loadApps(o.root);
			const recipes = new Map(stacks.map((s) => [s, apps[s]!.recipe as AppRecipe]));
			const withDump = [...recipes].find(([, r]) => r.dump);
			neu = await runSteps(steps, { side: "target", slice: o.slice, base: (s) => recipes.get(s.target?.stack ?? o.serverStack)!.ready, baseUrls: [...recipes.values()].map((r) => r.ready), dump: withDump ? (context) => dumpData(withDump[1], appRoot(o.config, o.root, withDump[0]), context) : undefined, strict: o.strict, onInitialData: collectData ? (data) => { targetData = data; } : undefined });
			if (checks.length) targetChecks = await runContracts(checks, { root: o.root, config: o.config, side: "target", slice: o.slice, appDir: appRoot(o.config, o.root, o.serverStack), urls: Object.fromEntries([...recipes].map(([s, r]) => [s, r.ready])), targetDir: wt });
			if (o.strict) targetChanged = targetCommit !== await headOf(wt) || await isDirty(wt);
		} finally {
			for (const stop of stops) await stop();
		}
	} finally {
		await removeWorktree(o.config.target.path, wt);
	}
	// written data is compared only when both apps keep the same tables and both can dump them
	const withData = o.config.db.strategy === "keep-schema" && !!apps[LEGACY]?.recipe?.dump && stacks.some((s) => apps[s]!.recipe!.dump);
	const c = compareRuns(steps, old1, old2, neu, withData, o.strict);
	// the steps the old app itself failed on go to its setup model: its fixture may lack what they need
	recordOldFailures(o.root, o.slice, c.notCompared.filter((n) => / \(the old app(?:'s second run)?: /.test(n)).map((n) => {
		const s = steps.find((x) => x.id === n.split(" ")[0]);
		return s ? `${s.id} ${s.method} ${s.path}${n.slice(s.id.length)}` : n;
	}));
	c.diffs.push(...contractDiffs(checks, steps, oldChecks[0] ?? [], oldChecks[1] ?? [], targetChecks));
	const problems = [...(o.strict ? [...c.notCompared, ...(c.unstable ?? [])] : []), ...contractProblems(checks, oldChecks[0] ?? [], oldChecks[1] ?? [], targetChecks, !o.strict)];
	let fixture: SliceEvidence["fixture"];
	if (o.strict && withData) {
		if (oldData.length !== 2 || !targetData) problems.push("initial database observations are missing; the seeded fixtures were not compared");
		else {
			fixture = { legacy: [oldData[0]!, oldData[1]!], target: targetData };
			// Matching partial dumps cannot establish that the other migrated tables were preserved.
			// Each database slice owns its schema units, so large whole-database observations need
			// only run in that slice rather than becoming a prerequisite of every HTTP journey.
			const tables = new Set<string>();
			for (const unit of o.ledger.listUnits()) {
				if (unit.kind !== "db_schema") continue;
				const meta = JSON.parse(unit.meta) as { slice?: string; tables?: unknown };
				if (meta.slice !== o.slice) continue;
				if (!Array.isArray(meta.tables) || !meta.tables.length || meta.tables.some((t) => typeof t !== "string" || !t.trim())) {
					problems.push(`database unit ${unit.id} has no valid inventoried table declarations`);
					continue;
				}
				for (const table of meta.tables) tables.add(table);
			}
			for (const table of [...tables].sort()) {
				const missing = [oldData[0]!, oldData[1]!, targetData].map((data, i) => Object.hasOwn(data, table) ? undefined : ["legacy first reset", "legacy second reset", "target reset"][i]).filter(Boolean);
				if (missing.length) problems.push(`initial database dump omits inventoried table ${table} (${missing.join(", ")})`);
			}
			if (differences(oldData[0], oldData[1]).length) problems.push("fixture: legacy seed data differs between resets");
			for (const d of differences(oldData[0], targetData, "data")) c.diffs.push({ step: "fixture", route: "data:fixture", kind: "data", path: d.path, legacy: d.a, target: d.b });
		}
	}
	if (o.strict) {
		if (targetChanged) problems.push("target parity worktree changed during replay");
		if (mainAt !== targetCommit || mainAt !== await headOf(o.config.target.path)) problems.push("target commit changed during verification");
		if (suiteHash !== digest(readFileSync(stepsPath(o.root, o.slice))) || JSON.stringify(inputs) !== JSON.stringify(await contractInputs(o.root, checks))) problems.push("suite or check inputs changed during verification");
		if (recipesHash !== digest(JSON.stringify(Object.fromEntries(Object.entries(loadApps(o.root)).map(([s, a]) => [s, a.recipe]))))) problems.push("app recipes changed during verification");
		if (o.config.db.strategy !== "none" && !withData && !checks.some((c) => c.kind === "data")) problems.push("database effects were not compared: supply compatible dumps or an executable data projection check");
		for (let i = 0; i < steps.length; i++) if (steps[i]!.compare === "redirect" && ![old1[i], old2[i]].every((r) => r?.status !== undefined && r.status >= 300 && r.status < 400)) problems.push(`${steps[i]!.id}: redirect-only comparison did not exercise a redirect; compare its response data`);
	}
	const evidence: SliceEvidence | undefined = o.strict || checks.length ? { version: 1, sourceCommit: await headOf(o.config.source.path), targetCommit, suiteHash, inputs, recipesHash, steps, suite: finalSuite, legacy: [old1, old2], target: neu, checks: { legacy: [oldChecks[0] ?? [], oldChecks[1] ?? []], target: targetChecks }, ...(fixture ? { fixture } : {}), problems } : undefined;
	// the old app's setup is asked (once) to let plain http reach its handlers
	const hop = steps.findIndex((s, i) => s.compare !== "none" && selfRedirect(old1[i]!));
	if (hop >= 0 && !apps[LEGACY]?.selfRedirect) saveApp(o.root, LEGACY, { selfRedirect: `${steps[hop]!.method} ${steps[hop]!.path} → ${old1[hop]!.status} ${old1[hop]!.location}` });
	const skipped = skippedRoutes(loadSteps(o.root, o.slice)!, routes);
	const note = [`${c.compared} step(s) compared`, checks.length ? `${checks.length} executable check(s) compared` : "", skipped.length ? `${skipped.length} of ${routes.length} route(s) skipped` : "", withData ? "written data compared" : "written data not compared", c.notCompared.length ? `not compared: ${c.notCompared.join(", ")}` : "", held.length ? `not compared yet (unit not accepted): ${held.join(", ")}` : ""].filter(Boolean).join("; ");
	if (c.newLoginFailed) log(pc.yellow(`parity ${o.slice}: the comparison could not log in to the new app (every page after the login went back to it): those pages are not compared and no unit is blamed`));
	const complete = !c.notCompared.length && !skipped.length && !held.length && !problems.length && !c.newLoginFailed && (c.compared > 0 || checks.length > 0);
	const res = record({ outcome: c.diffs.length ? "differs" : complete ? "same" : "error", diffs: c.diffs, compared: c.compared, note: `${c.newLoginFailed ? "the new app's login did not hold; " : ""}${note}${problems.length ? `; verification gaps: ${problems.join("; ")}` : ""}${unprepared ? `; missing checks not written: ${unprepared.slice(0, 300)}` : ""}`, ...(evidence ? { evidence } : {}), ...(unprepared ? { unprepared } : {}) }, steps.length, skipped.length);
	log(res.outcome === "same" ? pc.green(`parity ${o.slice}: compared scenarios match — ${note}`) : pc.yellow(`parity ${o.slice}: ${res.outcome} — ${res.note}`));
	return res;
}
