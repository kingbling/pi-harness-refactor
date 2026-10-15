import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import pc from "picocolors";
import { Type } from "typebox";
import type { Config } from "../config.ts";
import { headOf, removeWorktree } from "../git.ts";
import type { Ledger } from "../ledger/db.ts";
import { PLAIN_LANGUAGE } from "../policy.ts";
import { spawnLeaf } from "../sessions/spawn.ts";
import { differences } from "./differences.ts";
import { holdBack, waitingRoutes } from "./parity-partial.ts";
import { appRoot, bootApp, dumpData, fixUpLeft, LEGACY, loadApps, prepareTargetCopy, saveApp, type AppRecipe } from "./parity.ts";

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
	/** What is compared: data = status, redirect, body and written data; redirect = status, redirect and written data; page = status and written data (the HTML is compared later); none = nothing. */
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
}

export interface StepsFile {
	steps: Step[];
	/** route → why it has no step (it cannot be called on its own, it needs an outside service …). */
	skipped?: Record<string, string>;
}

export interface StepResult {
	status?: number;
	location?: string;
	body?: unknown;
	/** What the step wrote: table → rows added and removed (only steps that may write, only when the app has a dump). */
	data?: Record<string, { added: unknown[]; removed: unknown[] }>;
	error?: string;
}

export interface Diff {
	step: string;
	route: string;
	kind: "status" | "redirect" | "body" | "data" | "error";
	path: string;
	legacy: unknown;
	target: unknown;
}

const sliceDir = (root: string, slice: string) => join(root, ".bigrefactor", "parity", "slices", slice.replace(/[^\w.-]+/g, "_"));
const stepsPath = (root: string, slice: string) => join(sliceDir(root, slice), "steps.json");

/** The slice's routes on the old side ("GET /invoices") and its units' legacy files. */
export function sliceFacts(ledger: Ledger, slice: string): { routes: string[]; files: string[]; units: Array<{ id: string; state: string }> } {
	const units = ledger.db.prepare("SELECT id, state, meta FROM units WHERE json_extract(meta, '$.slice') = ?").all(slice) as Array<{ id: string; state: string; meta: string }>;
	const files = units.flatMap((u) => (JSON.parse(u.meta) as { files?: string[] }).files ?? []);
	const own = new Set(files);
	const rows = ledger.db.prepare("SELECT method, path, handler_symbol FROM index_routes WHERE side = 'source'").all() as Array<{ method: string | null; path: string; handler_symbol: string | null }>;
	const routes = [...new Set(rows.filter((r) => r.handler_symbol && own.has(r.handler_symbol.split("::")[0]!)).map((r) => `${r.method ?? "ANY"} ${r.path}`))];
	return { routes, files, units: units.map((u) => ({ id: u.id, state: u.state })) };
}

/** The slice's units that hold one of its routes' handlers: once these are accepted, the slice can be compared. */
export function routeOwners(ledger: Ledger, slice: string): Array<{ id: string; state: string }> {
	const units = ledger.listUnits().filter((u) => (JSON.parse(u.meta) as { slice?: string }).slice === slice);
	const rows = ledger.db.prepare("SELECT handler_symbol FROM index_routes WHERE side = 'source' AND handler_symbol IS NOT NULL").all() as Array<{ handler_symbol: string }>;
	const handlers = new Set(rows.map((r) => r.handler_symbol.split("::")[0]!));
	return units.filter((u) => ((JSON.parse(u.meta) as { files?: string[] }).files ?? []).some((f) => handlers.has(f))).map((u) => ({ id: u.id, state: u.state }));
}

/** Why these steps cannot be used, or undefined. Every slice route needs a step or a reason it has none. */
const routeKey = (r: unknown) => String(r ?? "").trim().replace(/^[A-Z]+(?:\|[A-Z]+)*\s+/, "").replace(/^\/+/, "");

export function stepsProblem(f: StepsFile, routes: string[], stacks: string[]): string | undefined {
	if (!Array.isArray(f?.steps) || !f.steps.length) return "steps.json needs a non-empty steps array";
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
	return undefined;
}

export function loadSteps(root: string, slice: string): StepsFile | undefined {
	try {
		return JSON.parse(readFileSync(stepsPath(root, slice), "utf8")) as StepsFile;
	} catch {
		return undefined;
	}
}

// ---- running steps against one app ----------------------------------------------------------------------

const WRITES = (m: string) => !/^(GET|HEAD|OPTIONS)$/i.test(m);

function fill<T>(v: T, vars: Map<string, string>): T {
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
		if (added.length || left.length) out[t] = { added, removed: left.map((r) => JSON.parse(r) as unknown) };
	}
	return out;
}

/**
 * Send the steps to one running app, in order, with one cookie jar (a login holds). `side` picks the request
 * shape: the old app gets the step as written, the new app the step with its `target` changes.
 */
export async function runSteps(steps: Step[], o: { side: "legacy" | "target"; base: (s: Step) => string; dump?: () => Record<string, unknown[]> | Promise<Record<string, unknown[]>> }): Promise<StepResult[]> {
	const vars = new Map<string, string>();
	const jar = new Map<string, string>();
	let data = await o.dump?.();
	const results: StepResult[] = [];
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
			const text = await res.text();
			try {
				r.body = JSON.parse(text);
			} catch {
				r.body = text;
			}
			const headText = [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n");
			for (const [n, re] of Object.entries(s.save ?? {})) {
				const m = new RegExp(re).exec(headText) ?? new RegExp(re).exec(text);
				if (m?.[1] !== undefined) vars.set(n, m[1]);
			}
		} catch (e: any) {
			r.error = String(e?.cause?.message ?? e?.message ?? e);
		}
		if (o.dump && WRITES(method)) {
			try {
				const after = await o.dump();
				r.data = dataChanges(data ?? {}, after);
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
function view(s: Step, r: StepResult, withData: boolean): Record<string, unknown> | undefined {
	if (s.compare === "none") return undefined;
	const v: Record<string, unknown> = {};
	v["status"] = r.status;
	if (s.compare === "redirect" || s.compare === "data") v["redirect"] = r.location ?? null;
	if (s.compare === "data") v["body"] = r.body;
	if (withData && r.data) v["data"] = r.data;
	return v;
}

/** The old app sent the request on to itself over another scheme (http → https): no handler answered it. */
export const selfRedirect = (r: StepResult) => (r.status ?? 0) >= 300 && (r.status ?? 0) < 400 && /^\w+:\/\/\(this app\)/.test(r.location ?? "");

const covers = (noise: string, path: string) => path === noise || path.startsWith(`${noise}.`) || path.startsWith(`${noise}[`);

/**
 * The real differences between the old app (two runs) and the new app. Only what differs between the two old runs
 * is ignored. A step the old app itself fails on (no answer, 5xx, in either run) proves nothing and is listed as not compared,
 * and so is one it only redirects to itself on https: both apps forcing https says nothing about the handler.
 */
export function compareRuns(steps: Step[], old1: StepResult[], old2: StepResult[], neu: StepResult[], withData: boolean): { diffs: Diff[]; compared: number; notCompared: string[] } {
	const diffs: Diff[] = [];
	const notCompared: string[] = [];
	let compared = 0;
	steps.forEach((s, i) => {
		const a = old1[i]!;
		if (s.compare === "none") return;
		if (a.error || (a.status ?? 0) >= 500) return void notCompared.push(`${s.id} (the old app: ${a.error ?? `status ${a.status}`})`);
		if (selfRedirect(a)) return void notCompared.push(`${s.id} (the old app only redirects it to itself: ${a.status} → ${a.location})`);
		// a failed second old run would make everything look like noise and hide every real difference
		const a2 = old2[i]!;
		if (a2.error || (a2.status ?? 0) >= 500) return void notCompared.push(`${s.id} (the old app's second run: ${a2.error ?? `status ${a2.status}`})`);
		compared++;
		const b = neu[i]!;
		if (b.error && b.status === undefined) return void diffs.push({ step: s.id, route: s.route, kind: "error", path: "", legacy: view(s, a, withData), target: b.error });
		const noise = differences(view(s, a, withData), view(s, a2, withData)).map((d) => d.path);
		for (const d of differences(view(s, a, withData), view(s, b, withData))) {
			if (noise.some((n) => covers(n, d.path))) continue;
			const top = d.path.split(/[.[]/)[0]!;
			diffs.push({ step: s.id, route: s.route, kind: top === "redirect" ? "redirect" : top === "body" ? "body" : top === "data" ? "data" : "status", path: d.path, legacy: d.a, target: d.b });
		}
	});
	return { diffs, compared, notCompared };
}

// ---- the tester that writes the steps ---------------------------------------------------------------------

/** Start the old app (data reset first), send the steps, stop it. */
async function runOnOld(config: Config, root: string, steps: Step[]): Promise<StepResult[] | string> {
	const recipe = loadApps(root)[LEGACY]?.recipe;
	if (!recipe) return "the old app has no start recipe (br parity --probe)";
	const dir = appRoot(config, root, LEGACY);
	const b = await bootApp(recipe, dir);
	if (!b.ok) {
		// it started when it was set up: its setup here (data reset, start) is asked to fix that
		if (fixUpLeft(loadApps(root)[LEGACY], "setup") && !loadApps(root)[LEGACY]?.setupProblem) saveApp(root, LEGACY, { setupProblem: `the old app did not start for a slice check: ${String(b.error).slice(0, 1000)}` });
		return `the old app did not start: ${b.error}`;
	}
	try {
		return await runSteps(steps, { side: "legacy", base: () => recipe.ready, dump: recipe.dump ? () => dumpData(recipe, dir) : undefined });
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
			if (!f?.steps?.length) return { content: [{ type: "text", text: "steps.json is missing or has no steps" }], details: {} };
			const r = await runOnOld(config, root, f.steps);
			const text = typeof r === "string" ? r : f.steps.map((s, i) => `${s.id} ${s.method} ${s.path} → ${r[i]!.error ? `ERROR ${r[i]!.error}` : `${r[i]!.status}${r[i]!.location ? ` → ${r[i]!.location}` : ""} ${short(r[i]!.body)}${r[i]!.data && Object.keys(r[i]!.data!).length ? ` wrote ${short(r[i]!.data, 200)}` : ""}`}`).join("\n");
			return { content: [{ type: "text", text }], details: {} };
		},
	} as unknown as ToolDefinition;
}

/** Returns the model's last sentence. */
export type StepWriter = (o: { config: Config; root: string; slice: string; dir: string; problem: string }) => Promise<string | void>;

export const writeStepsWithModel: StepWriter = async (o) => {
	const session = await spawnLeaf({
		role: "test",
		cwd: o.dir,
		config: o.config,
		writeGlobs: ["steps.json"],
		protectedGlobs: [],
		customTools: [tryOnOldTool(o.config, o.root, o.slice)],
		transcriptPath: join(o.root, ".bigrefactor", "sessions", `__parity__.${o.slice}.steps.${Date.now()}.jsonl`),
		systemPrompt: `You write the HTTP requests a migration tool sends to the OLD app and to the NEW app, to compare their answers. Write them to steps.json in your folder. You try them on the old app with try_on_old_app; you never see the new app's answers, and you never shape a request to make the apps look alike. Read the old handlers to know what each route expects (parameters, form fields, login, tokens) and the new project to know where each route went.\n\nsteps.json: {"steps": [Step, …], "skipped": {"<route>": "why it has no step"}}. A Step: {"id": "s1", "route": "<one of the slice routes, or setup>", "compare": "data" | "redirect" | "page" | "none", "method": "GET", "path": "/…", "headers"?: {}, "body"?: <JSON>, "form"?: {field: value}, "save"?: {"name": "regex with one group"}, "target"?: {"method"?, "path"?, "headers"?, "body"?, "form"?, "stack"?}, "why"?: "…"}.\n- compare: data = an answer with data (JSON or text) where status, redirect and body must match; redirect = status and where it sends to; page = an HTML page (its status and what it writes are compared, not its HTML); none = preparation such as a login.\n- Steps run in order with one cookie jar, so a login step holds for the steps after it. "{{name}}" in a later step is replaced by a value saved earlier (a CSRF token, a new id).\n- target: only what the new app needs differently (the route moved, it takes JSON instead of a form, another target stack answers it: ${o.config.target.stacks.join(", ")}).\n- Every slice route gets at least one compared step, or a reason in skipped. ${loadApps(o.root)[LEGACY]?.recipe?.reset ? "Steps that write data are fine: the data is reset before every run." : "The data is NOT reset between runs: a step that writes must still work when it runs again (use new names, or save the id it creates)."}\nEnd with one sentence.\n\n${PLAIN_LANGUAGE}`,
	});
	try {
		const r = await session.run(o.problem);
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
	outcome: "same" | "differs" | "error";
	diffs: Diff[];
	compared: number;
	note: string;
	/** The new app of this stack did not start on main: a main problem for the builder, not only a parity error. */
	down?: { stack: string; error: string };
}

/**
 * Compare one slice: steps (written once, `rewrite` writes them anew), the old app run twice, the new app once in a
 * fresh worktree of main, differences into the ledger. Needs both apps' recipes (br parity --probe).
 */
export async function checkSlice(o: { ledger: Ledger; config: Config; root: string; slice: string; linkAll: (wt: string) => void | Promise<void>; serverStack: string; writer?: StepWriter; rewrite?: boolean; onlyAccepted?: boolean; log?: (l: string) => void }): Promise<SliceCheck> {
	const log = o.log ?? ((l: string) => console.log(l));
	const startedAt = new Date().toISOString();
	const mainAt = await headOf(o.config.target.path);
	const record = (c: Omit<SliceCheck, "runId">, steps = 0): SliceCheck => {
		const runId = Number(o.ledger.db.prepare("INSERT INTO parity_runs(slice, outcome, steps, compared, note, started_at, ended_at, commit_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(o.slice, c.outcome, steps, c.compared, c.note, startedAt, new Date().toISOString(), mainAt ?? null).lastInsertRowid);
		const ins = o.ledger.db.prepare("INSERT INTO parity_diffs(run_id, slice, step, route, kind, path, legacy, target) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
		for (const d of c.diffs) ins.run(runId, o.slice, d.step, d.route, d.kind, d.path, JSON.stringify(d.legacy ?? null), JSON.stringify(d.target ?? null));
		return { ...c, runId };
	};
	const fail = (note: string) => (log(pc.yellow(`parity ${o.slice}: ${note}`)), record({ outcome: "error", diffs: [], compared: 0, note }));

	const apps = loadApps(o.root);
	if (!apps[LEGACY]?.up || !apps[LEGACY].recipe) return fail("the old app does not start here (br parity --probe)");
	const { routes, files } = sliceFacts(o.ledger, o.slice);
	if (!routes.length) return fail("this slice has no routes of its own to compare");

	// the steps: written once per slice by the tester, checked by code
	const dir = sliceDir(o.root, o.slice);
	mkdirSync(dir, { recursive: true });
	let problem = o.rewrite || !existsSync(stepsPath(o.root, o.slice)) ? "" : stepsProblem(loadSteps(o.root, o.slice)!, routes, o.config.target.stacks);
	if (o.rewrite || !existsSync(stepsPath(o.root, o.slice)) || problem) {
		const writer = o.writer ?? writeStepsWithModel;
		const ask = `Slice "${o.slice}". Its routes on the old app: ${routes.join(", ")}. The old handlers and the code they use (relative to ${o.config.source.path}): ${files.join(", ")}. The new project: ${o.config.target.path} (stacks ${o.config.target.stacks.join(", ")}; requests go to ${o.serverStack} unless a step's target.stack says otherwise). Write steps.json and try it on the old app until every step does what you meant.`;
		for (let i = 0; i < 2; i++) {
			await writer({ config: o.config, root: o.root, slice: o.slice, dir, problem: problem ? `${ask}\n\nThe steps.json you wrote cannot be used: ${problem}` : ask }).catch((e) => log(pc.yellow(`parity ${o.slice}: step writer failed: ${e?.message ?? e}`)));
			const f = loadSteps(o.root, o.slice);
			problem = f ? stepsProblem(f, routes, o.config.target.stacks) : "steps.json is missing or not valid JSON";
			if (!problem) break;
		}
		if (problem) return fail(`no usable steps: ${problem}`);
	}
	// `onlyAccepted` (the run): a slice not finished yet compares only the steps of routes whose unit is accepted
	const { steps, held } = o.onlyAccepted ? holdBack(loadSteps(o.root, o.slice)!.steps, waitingRoutes(o.ledger, o.slice)) : { steps: loadSteps(o.root, o.slice)!.steps, held: [] };
	if (!steps.some((s) => s.compare !== "none")) return { outcome: "error", diffs: [], compared: 0, note: `not compared yet: the units of its routes are not accepted (${held.join(", ")})` };

	// the old app twice (what differs between those two runs is noise), then the new app
	const old1 = await runOnOld(o.config, o.root, steps);
	if (typeof old1 === "string") return fail(old1);
	const old2 = await runOnOld(o.config, o.root, steps);
	if (typeof old2 === "string") return fail(old2);
	const stacks = [...new Set(steps.map((s) => s.target?.stack ?? o.serverStack))];
	const down = stacks.filter((s) => !apps[s]?.up || !apps[s]!.recipe);
	if (down.length) return fail(`the new ${down.join(", ")} app does not start here (br parity --probe)`);
	const wt = await prepareTargetCopy(o.config, o.root, o.linkAll);
	let neu: StepResult[];
	try {
		const recipes = new Map(stacks.map((s) => [s, apps[s]!.recipe as AppRecipe]));
		const stops: Array<() => Promise<void>> = [];
		try {
			for (const [s, r] of recipes) {
				const b = await bootApp(r, appRoot(o.config, o.root, s));
				if (!b.ok) return { ...fail(`the new ${s} app did not start: ${b.error}`), down: { stack: s, error: b.error } };
				stops.push(b.stop);
			}
			const withDump = [...recipes].find(([, r]) => r.dump);
			neu = await runSteps(steps, { side: "target", base: (s) => recipes.get(s.target?.stack ?? o.serverStack)!.ready, dump: withDump ? () => dumpData(withDump[1], appRoot(o.config, o.root, withDump[0])) : undefined });
		} finally {
			for (const stop of stops) await stop();
		}
	} finally {
		await removeWorktree(o.config.target.path, wt);
	}
	// written data is compared only when both apps keep the same tables and both can dump them
	const withData = o.config.db.strategy === "keep-schema" && !!apps[LEGACY].recipe!.dump && stacks.some((s) => apps[s]!.recipe!.dump);
	const c = compareRuns(steps, old1, old2, neu, withData);
	// the old app's setup is asked (once) to let plain http reach its handlers
	const hop = steps.findIndex((s, i) => s.compare !== "none" && selfRedirect(old1[i]!));
	if (hop >= 0 && !apps[LEGACY].selfRedirect) saveApp(o.root, LEGACY, { selfRedirect: `${steps[hop]!.method} ${steps[hop]!.path} → ${old1[hop]!.status} ${old1[hop]!.location}` });
	const note = [`${c.compared} step(s) compared`, withData ? "written data compared" : "written data not compared", c.notCompared.length ? `not compared: ${c.notCompared.join(", ")}` : "", held.length ? `not compared yet (unit not accepted): ${held.join(", ")}` : ""].filter(Boolean).join("; ");
	const res = record({ outcome: c.diffs.length ? "differs" : c.compared ? "same" : "error", diffs: c.diffs, compared: c.compared, note }, steps.length);
	log(c.diffs.length ? pc.yellow(`parity ${o.slice}: ${c.diffs.length} difference(s) in ${new Set(c.diffs.map((d) => d.step)).size} step(s) — ${note}`) : pc.green(`parity ${o.slice}: the new app answers like the old one — ${note}`));
	return res;
}
