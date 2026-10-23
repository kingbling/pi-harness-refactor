import { isExactJsonNumber, parseExactJson } from "./exact-json.ts";
import { createHash } from "node:crypto";
import { observationEnvironment, observationTimeoutMs, runVerificationCommand } from "./parity-command.ts";
export { runVerificationCommand } from "./parity-command.ts";
import { accessSync, constants, createReadStream, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "../config.ts";
import { differences } from "./differences.ts";
import type { Diff, Step, StepsFile } from "./parity-check.ts";
import { changeShapeProblems } from "./parity-changes.ts";

/** Executable observations, for behavior HTTP status/body comparisons cannot establish. */
export interface ParityContract {
	id: string;
	kind: "browser" | "data" | "command" | "effects";
	/** Compared step ids this contract exercises, e.g. the pages a browser journey opens. */
	covers: string[];
	why: string;
	command: { cmd: string; args: string[] };
	/** Scripts/fixtures used by the command, relative to the workspace (absolute paths also work). */
	inputs: string[];
	/** Budget for this complete observation, in milliseconds (default two minutes, maximum one day). */
	timeoutMs?: number;
}

export interface ContractResult {
	id: string;
	observations?: Record<string, unknown>;
	error?: string;
}

export const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export async function contractInputs(root: string, contracts: ParityContract[]): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const p of [...new Set(contracts.flatMap((c) => c.inputs))].sort()) {
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(resolve(root, p))) hash.update(chunk);
		out[p] = hash.digest("hex");
	}
	return out;
}

const pathOf = (route: string) => route.trim().replace(/^[A-Z]+(?:\|[A-Z]+)*\s+/, "").replace(/^\/+/, "");
const methodsOf = (route: string) => /^([A-Z]+(?:\|[A-Z]+)*)\s+/.exec(route.trim())?.[1]?.split("|") ?? ["ANY"];

/** Method matters: a GET scenario cannot cover an indexed POST endpoint at the same path. */
export function coversRoute(step: Step, route: string): boolean {
	return step.compare !== "none" && pathOf(step.route) === pathOf(route) && (methodsOf(route).includes("ANY") || methodsOf(route).includes(step.method.toUpperCase()));
}

/** A framework-supplied endpoint still needs every indexed method exercised, even without a ported source unit. */
export function routeCovered(steps: Step[], route: string): boolean {
	return methodsOf(route).every((method) => steps.some((s) => coversRoute(s, `${method} ${pathOf(route)}`)));
}

/** Preparation can add coverage and adapt target mappings, but cannot silently discard source scenarios. */
export function retainedScenarioProblems(before: StepsFile, after: StepsFile): string[] {
	const problems: string[] = [];
	for (const previous of before.steps) {
		const next = after.steps.find((s) => s.id === previous.id);
		const sourceRequest = (s: Step) => ({ id: s.id, route: s.route, compare: s.compare, method: s.method, path: s.path, headers: s.headers, form: s.form, body: s.body, save: s.save });
		if (!next || differences(sourceRequest(previous), sourceRequest(next)).length) problems.push(`preparation must retain the legacy scenario ${previous.id}; use --rewrite explicitly to replace source scenarios`);
		if (next && (previous.response === "bytes" && next.response !== "bytes" || previous.responseHeaders?.some((h) => !next.responseHeaders?.includes(h)))) problems.push(`preparation must retain response checks for ${previous.id}`);
	}
	for (const c of before.checks ?? []) if (!(after.checks ?? []).some((n) => n.id === c.id)) problems.push(`preparation must retain executable check ${c.id}`);
	for (const c of before.changes ?? []) if (differences(c, (after.changes ?? []).find((n) => n.id === c.id)).length) problems.push(`preparation must retain declared behavior change ${c.id}`);
	return problems;
}

/** Strict verification consumes an existing suite. It never asks a model to rewrite it until it passes. */
export function strictSuiteProblems(file: StepsFile, routes: string[], root: string): string[] {
	const problems: string[] = [];
	if (!Array.isArray(file.steps)) return ["steps must be an array"];
	const stepIds = new Set<string>();
	for (const s of file.steps) {
		if (s?.id === "fixture") return ["HTTP step id fixture is reserved for the initial database comparison"];
		if (!s || typeof s.id !== "string" || !s.id || stepIds.has(s.id) || typeof s.route !== "string" || !s.route.trim()
			|| typeof s.method !== "string" || !/^[A-Z]+$/i.test(s.method) || typeof s.path !== "string" || !s.path.startsWith("/")
			|| !["none", "data", "page", "redirect"].includes(s.compare) || (s.response !== undefined && s.response !== "bytes")
			|| (s.responseHeaders !== undefined && (!Array.isArray(s.responseHeaders) || s.responseHeaders.some((h) => typeof h !== "string" || !h.trim()))))
			return ["steps need distinct ids, route, method, absolute path, valid compare/response/responseHeaders"];
		stepIds.add(s.id);
	}
	const checks = file.checks ?? [];
	if (!Array.isArray(checks)) return ["checks must be an array"];
	const ids = new Set<string>();
	for (const c of checks) {
		if (!c || typeof c.id !== "string" || !c.id || ids.has(c.id) || stepIds.has(`check:${c.id}`)) return ["checks need distinct non-empty ids and must not collide with HTTP step ids"];
		ids.add(c.id);
		try { observationTimeoutMs(c.timeoutMs, 120_000); } catch (e) { return [`check ${c.id}: ${String(e)}`]; }
		if (!["browser", "data", "command", "effects"].includes(c.kind) || typeof c.why !== "string" || !c.why.trim()
			|| !Array.isArray(c.covers) || c.covers.some((id) => !file.steps.some((s) => s.id === id && s.compare !== "none"))
			|| !c.command || typeof c.command.cmd !== "string" || !c.command.cmd.trim() || !Array.isArray(c.command.args) || c.command.args.some((a) => typeof a !== "string")
			|| !Array.isArray(c.inputs) || !c.inputs.length || c.inputs.some((p) => typeof p !== "string" || !p.trim()))
			return [`check ${c.id}: needs kind, why, covers (compared step ids), command {cmd,args}, and non-empty inputs`];
	}
	try {
		for (const p of checks.flatMap((c) => c.inputs)) {
			accessSync(resolve(root, p), constants.R_OK);
			if (!statSync(resolve(root, p)).isFile()) throw new Error(`${p} is not a file`);
		}
	} catch (e) { problems.push(`check input cannot be read: ${String(e)}`); }
	for (const route of routes) {
		const methods = methodsOf(route);
		for (const method of methods) if (!file.steps.some((s) => coversRoute(s, `${method} ${pathOf(route)}`)))
			problems.push(`no compared scenario for ${method} ${pathOf(route)} (skipping a route cannot establish parity)`);
	}
	for (const s of file.steps) if (s.compare === "page" && !checks.some((c) => c.kind === "browser" && c.covers.includes(s.id)))
		problems.push(`page ${s.id}: needs a browser check through the real app entry; status alone does not verify the page`);
	if (!routes.length && !checks.length) problems.push("this slice has no HTTP routes: add an executable data/command/browser/effects check");
	problems.push(...changeShapeProblems(file));
	return problems;
}

/** A driver runs against each reset app, twice on legacy. Stdout is a JSON object of actual observations. */
export async function runContracts(checks: ParityContract[], o: { root: string; config: Config; side: "legacy" | "target"; appDir: string; urls: Record<string, string>; targetDir?: string; slice?: string; timeoutMs?: number }): Promise<ContractResult[]> {
	const out: ContractResult[] = [];
	for (const c of checks) {
		try {
			const { stdout: raw } = await runVerificationCommand(c.command, o.root, observationTimeoutMs(o.timeoutMs ?? c.timeoutMs, 120_000), {
				...process.env, BR_PARITY_SIDE: o.side, BR_PARITY_APP_DIR: o.appDir,
				BR_PARITY_URLS: JSON.stringify(o.urls), BR_PARITY_SOURCE_DIR: o.config.source.path,
				BR_PARITY_TARGET_DIR: o.targetDir ?? "", BR_PARITY_CHECK: c.id,
				...observationEnvironment({ side: o.side, slice: o.slice, phase: "contract" }),
			});
			const observations = parseExactJson(raw);
			if (!observations || typeof observations !== "object" || isExactJsonNumber(observations) || Array.isArray(observations) || !Object.keys(observations).length)
				throw new Error("stdout must be a non-empty JSON object of observed values");
			out.push({ id: c.id, observations: observations as Record<string, unknown> });
		} catch (e) { out.push({ id: c.id, error: String(e).slice(-2000) }); }
	}
	return out;
}

export function contractProblems(checks: ParityContract[], old1: ContractResult[], old2: ContractResult[], target: ContractResult[], compare = true): string[] {
	const problems: string[] = [];
	for (const c of checks) {
		const a = old1.find((r) => r.id === c.id), b = old2.find((r) => r.id === c.id), n = target.find((r) => r.id === c.id);
		if (!a?.observations || !b?.observations || !n?.observations || a.error || b.error || n.error) {
			problems.push(`check ${c.id} did not complete: ${a?.error ?? b?.error ?? n?.error ?? "missing observations"}`);
			continue;
		}
		if (differences(a.observations, b.observations).length) problems.push(`check ${c.id}: legacy observations are not repeatable`);
		if (compare) for (const d of differences(a.observations, n.observations)) problems.push(`check ${c.id}: differs at ${d.path}`);
	}
	return problems;
}

/** Stable executable observations also feed the ordinary resolver/reopen loop. */
export function contractDiffs(checks: ParityContract[], steps: Step[], old1: ContractResult[], old2: ContractResult[], target: ContractResult[]): Diff[] {
	const out: Diff[] = [];
	for (const c of checks) {
		const a = old1.find((r) => r.id === c.id), b = old2.find((r) => r.id === c.id), n = target.find((r) => r.id === c.id);
		if (!a?.observations || !b?.observations || a.error || b.error || differences(a.observations, b.observations).length) continue;
		const route = steps.find((s) => c.covers.includes(s.id))?.route ?? `check:${c.id}`;
		if (n?.error || !n?.observations) out.push({ step: `check:${c.id}`, route, kind: "error", path: "", legacy: a.observations, target: n?.error ?? "missing observations" });
		else for (const d of differences(a.observations, n.observations)) out.push({ step: `check:${c.id}`, route, kind: "body", path: d.path, legacy: d.a, target: d.b });
	}
	return out;
}
