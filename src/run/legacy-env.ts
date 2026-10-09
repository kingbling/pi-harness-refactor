import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import pc from "picocolors";
import { Type } from "typebox";
import type { SourceAdapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import { loadDecisions } from "../inventory/decisions.ts";
import { PLAIN_LANGUAGE } from "../policy.ts";
import { spawnLeaf } from "../sessions/spawn.ts";

/**
 * Truth runs on the OLD code. Out of the box it runs in the legacy repo with this machine's tools; when that is
 * not enough (packages never installed, a runtime only in docker), the setup model prepares a runnable copy once:
 * a copy-on-write clone of the legacy repo in the workspace (the legacy repo itself stays read-only) where it may
 * install the dependencies, and/or a different run command. Saved per workspace in .bigrefactor/legacy-env.json;
 * code decides it worked by re-running a truth script that failed.
 */
export interface LegacyEnv {
	/** Where truth scripts run: the legacy repo, or the workspace copy. */
	root: string;
	/** How to run a script; "{script}" is replaced by its absolute path, "{root}" by `root`. Default: the source adapter's runner. */
	run?: { cmd: string; args: string[] };
	why?: string;
	/**
	 * Decided once at the start of a run (probeLegacyEnv): "run" = truth comes from running the old code;
	 * "read" = the old code cannot run here, so the tester writes expected values from reading it, marked as such.
	 * Unset = not probed yet. Delete legacy-env.json to probe again.
	 */
	mode?: TruthMode;
	/** The owner question asked once after a red probe (blocks nothing): "retry" makes the next run probe again. */
	probeQuestion?: number;
}

/** run = expected values recorded by running the old code; read = written from reading it (not run). */
export type TruthMode = "run" | "read";

const envPath = (root: string) => join(root, ".bigrefactor", "legacy-env.json");
const copyDir = (root: string) => join(root, ".bigrefactor", "legacy-env", "app");

export function loadLegacyEnv(root: string | undefined, config: Config): LegacyEnv {
	const fallback = { root: config.source.path };
	if (!root || !existsSync(envPath(root))) return fallback;
	try {
		const e = JSON.parse(readFileSync(envPath(root), "utf8")) as LegacyEnv;
		return e.root && existsSync(e.root) ? e : { ...fallback, run: e.run };
	} catch {
		return fallback;
	}
}

function saveLegacyEnv(root: string, config: Config, change: Partial<LegacyEnv>, why: string): LegacyEnv {
	const cur = loadLegacyEnv(root, config);
	const next = { ...cur, ...change, why: [cur.why, why].filter(Boolean).join("; ") };
	mkdirSync(join(root, ".bigrefactor"), { recursive: true });
	writeFileSync(envPath(root), JSON.stringify(next, null, 2) + "\n");
	return next;
}

/** The command the orchestrator runs a truth script with (and the tester should too). */
export function truthCommand(env: LegacyEnv, source: SourceAdapter, script: string): { cmd: string; args: string[]; cwd: string } {
	const fill = (a: string) => a.replaceAll("{script}", script).replaceAll("{root}", env.root);
	const c = env.run ? { cmd: fill(env.run.cmd), args: env.run.args.map(fill) } : source.truth.run(env.root, script);
	return { ...c, cwd: env.root };
}

export function describeTruthRun(root: string | undefined, config: Config, source: SourceAdapter, script: string): string {
	const c = truthCommand(loadLegacyEnv(root, config), source, script);
	return `cd ${c.cwd} && ${[c.cmd, ...c.args].join(" ")}`;
}

export type TruthCase = { symbol: string; inputs: unknown; expected: unknown };

/**
 * Case ids that stay put: a case already recorded (same symbol and inputs) keeps its id, a new one gets the next
 * free number. Never by position, so a case added or left out in a re-run does not shift the others' ids.
 */
export function caseIds(unitId: string, recorded: Array<{ id: string; symbol_id: string; inputs: string }>, cases: TruthCase[]): string[] {
	const left = [...recorded];
	let next = Math.max(0, ...recorded.map((r) => Number(r.id.slice(r.id.lastIndexOf("#") + 1)) || 0));
	return cases.map((c) => {
		const i = left.findIndex((r) => r.symbol_id === c.symbol && r.inputs === JSON.stringify(c.inputs));
		return i >= 0 ? left.splice(i, 1)[0]!.id : `${unitId}#${++next}`;
	});
}

/** Where the tester writes read-not-run cases when the old code cannot run: the same JSON array, no script. */
export const READ_CASES_FILE = "cases.json";

/**
 * Where the tester declares that a unit has no runtime behaviour to pin (only a contract, type declarations or
 * constants): {"reason": "..."}. With it, a missing or empty case list is accepted instead of rejected.
 */
export const NO_BEHAVIOUR_FILE = "no-behaviour.json";

/** The tester's reason why this unit has no runtime behaviour, or undefined when it did not declare that. */
export function noBehaviourReason(truthDirAbs: string): string | undefined {
	try {
		const r = String((JSON.parse(readFileSync(join(truthDirAbs, NO_BEHAVIOUR_FILE), "utf8")) as { reason?: unknown }).reason ?? "").trim();
		return r || undefined;
	} catch {
		return undefined;
	}
}

/** `none`: the unit has no runtime behaviour to pin (the tester's reason); `cases` is then empty. */
export type TruthResult = { ok: boolean; cases: TruthCase[]; error?: string; none?: string };

const NO_CASES_HINT = "(when the unit has no runtime behaviour at all, say so with no_behaviour_to_pin instead)";

/**
 * Code runs the tester's script on the old code and loads the cases: the tester never decides that truth is green.
 * With `legacyFiles` (the unit's legacy files) the script must load one of them and must not type the expected
 * values in: truth that the old code did not produce is no truth.
 */
export function verifyTruthOnOld(truthDirAbs: string, config: Config, source: SourceAdapter, root?: string, legacyFiles?: string[]): TruthResult {
	const script = join(truthDirAbs, source.truth.scriptName);
	const none = noBehaviourReason(truthDirAbs);
	if (!existsSync(script)) return none ? { ok: true, cases: [], none } : { ok: false, cases: [], error: `tester did not write ${source.truth.scriptName}` };
	try {
		const { cmd, args, cwd } = truthCommand(loadLegacyEnv(root, config), source, script);
		const out = execFileSync(cmd, args, { cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
		const start = out.indexOf("[");
		const cases = JSON.parse(out.slice(start)) as TruthCase[];
		if (!Array.isArray(cases) || !cases.length) return none ? { ok: true, cases: [], none } : { ok: false, cases: [], error: `${source.truth.scriptName} printed no cases ${NO_CASES_HINT}` };
		const bad = cases.filter((c) => typeof c.symbol !== "string");
		if (bad.length) return { ok: false, cases: [], error: `${bad.length} cases without a symbol id` };
		const invented = legacyFiles ? notFromOldCode(readFileSync(script, "utf8"), cases, legacyFiles) : undefined;
		if (invented) return { ok: false, cases: [], error: invented };
		return { ok: true, cases };
	} catch (e: any) {
		// stderr carries the runtime's own message ("Failed opening required …"); it is captured, never printed into the UI
		return { ok: false, cases: [], error: [e?.stderr, e?.stdout].map((x) => String(x ?? "").trim()).filter(Boolean).join("\n").slice(-800) || String(e?.message ?? e) };
	}
}

const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Whether the script names a legacy file the way some language loads it: by path or file name (require 'x.php'),
 * or by its last folder + name without the extension, joined by / . :: \ or " import " (billing.models,
 * from billing import models, com.acme.Invoice, require_relative 'app/models/invoice'), or by its folder as the
 * end of a quoted import (Go: "example.com/app/internal/billing").
 */
export function loadsFile(script: string, file: string): boolean {
	if (script.includes(file) || script.includes(basename(file))) return true;
	const segs = file.replace(/\.[^./]+$/, "").split("/").filter(Boolean);
	const sep = String.raw`(?:/|\.|::|\\|\s+import\s+)`;
	if (new RegExp(String.raw`(?<![\w])${segs.slice(-2).map(esc).join(sep)}(?![\w])`).test(script)) return true;
	const dir = segs.slice(0, -1);
	return dir.length > 0 && new RegExp(String.raw`(?<![\w])${dir.slice(-2).map(esc).join("/")}["'` + "`]").test(script);
}

/**
 * Why these cases were not produced by the old code, or undefined. Two cheap checks on the script text:
 * it names none of the unit's legacy files, or most expected values are written into the script itself
 * (a value that is also an input — a setter read back — does not count).
 */
export function notFromOldCode(script: string, cases: TruthCase[], legacyFiles: string[]): string | undefined {
	if (legacyFiles.length && !legacyFiles.some((f) => loadsFile(script, f))) return `the script loads none of this unit's legacy files (${legacyFiles.join(", ")}): the expected values must come from running them`;
	const leaves = (v: unknown): string[] =>
		typeof v === "string" ? (v.length >= 4 ? [v] : []) : typeof v === "number" ? (String(v).length >= 4 ? [String(v)] : []) : v && typeof v === "object" ? Object.values(v).flatMap(leaves) : [];
	let checked = 0;
	let typed = 0;
	for (const c of cases) {
		const inputs = JSON.stringify(c.inputs ?? null);
		const own = leaves(c.expected).filter((l) => !inputs.includes(l) && !inputs.includes(JSON.stringify(l).slice(1, -1)));
		if (!own.length) continue;
		checked++;
		if (own.every((l) => script.includes(l))) typed++;
	}
	return checked && typed * 2 > checked ? `${typed} of ${checked} cases have their expected values written into the script: run the legacy code and print what it returns, never type the result in` : undefined;
}

/** Read-not-run truth: the tester's cases.json, checked for shape only (nothing ran). */
export function loadReadTruth(truthDirAbs: string): TruthResult {
	const file = join(truthDirAbs, READ_CASES_FILE);
	const none = noBehaviourReason(truthDirAbs);
	if (!existsSync(file)) return none ? { ok: true, cases: [], none } : { ok: false, cases: [], error: `tester did not write ${READ_CASES_FILE}` };
	try {
		const cases = JSON.parse(readFileSync(file, "utf8")) as TruthCase[];
		if (!Array.isArray(cases) || !cases.length) return none ? { ok: true, cases: [], none } : { ok: false, cases: [], error: `${READ_CASES_FILE} holds no cases ${NO_CASES_HINT}` };
		if (cases.some((c) => typeof c?.symbol !== "string" || !("expected" in c))) return { ok: false, cases: [], error: `every case in ${READ_CASES_FILE} needs a symbol and an expected value` };
		return { ok: true, cases };
	} catch (e: any) {
		return { ok: false, cases: [], error: `${READ_CASES_FILE} is not valid JSON: ${e?.message ?? e}` };
	}
}

/** Asks the owner one question (blocks nothing); returns its id. */
export type ProbeAsker = (q: { facts: string; options: Array<{ value: string; facts: string }>; recommended: string }) => Promise<number | undefined>;
/** The owner's answer to the probe question: "retry" = probe again at the next run. */
export type ProbeAnswer = (questionId: number) => string | undefined;

/**
 * Once per workspace, before any unit: can single units of the old code be loaded and called here, with whatever
 * this machine has? (The whole app does not need to boot.) The setup model tries and writes a probe script; code
 * runs the probe. Green → "run", anything else → "read" (units then try a small script each, else read-not-run
 * truth), and the owner is asked once — blocking nothing — whether to probe again after setting something up.
 */
export async function probeLegacyEnv(o: { config: Config; root: string; source: SourceAdapter; fixer?: LegacyFixer; log?: (l: string) => void; ask?: ProbeAsker; answer?: ProbeAnswer }): Promise<TruthMode> {
	const log = o.log ?? ((l: string) => console.log(l));
	const cur = loadLegacyEnv(o.root, o.config);
	// read mode: probe again only when the owner said so (after installing something); otherwise decided
	const retry = cur.mode === "read" && cur.probeQuestion !== undefined && o.answer?.(cur.probeQuestion) === "retry";
	if (cur.mode && !retry) return cur.mode;
	const dir = join(o.root, ".bigrefactor", "legacy-env", "probe");
	mkdirSync(dir, { recursive: true });
	const script = join(dir, o.source.truth.scriptName);
	const db = o.config.db.schemaFiles?.length ? ` The old code uses ${o.config.db.from.join(" + ") || "a database"} (schema in ${o.config.db.schemaFiles.join(", ")}); a unit that needs no database is the better probe. Start a database only if one is needed and this machine can run it.` : "";
	const said = await (o.fixer ?? fixLegacyEnvWithModel)({
		config: o.config,
		root: o.root,
		source: o.source,
		script,
		probe: true,
		problem: `Nothing has run on the old code yet. Find out whether single units of the old code can be loaded and called with what this machine has (any installed runtime or tool; check which ones and their versions). The whole app does not need to boot: loading one real file of the old code (and what it needs) and calling one of its functions is enough. Install dependencies in a copy only if that unit needs them.${db} Then write the probe ${script}: it loads that file, calls ONE real function of the old code and prints its result as ${o.source.truth.instructions} Use the symbol id "probe". Try more than one way before giving up; if nothing works, say exactly what is missing.`,
	}).catch((e) => `setup model failed: ${e?.message ?? e}`);
	const ok = verifyTruthOnOld(dir, o.config, o.source, o.root).ok;
	const mode: TruthMode = ok ? "run" : "read";
	saveLegacyEnv(o.root, o.config, { mode, probeQuestion: undefined }, ok ? `probe green: ${said || "the old code runs"}` : `probe red: ${said || "the old code does not run here"}`);
	appendFileSync(join(o.root, ".bigrefactor", "legacy-env.log"), `${new Date().toISOString()} probe → ${mode}: ${String(said || "").replace(/\s+/g, " ")}\n`);
	if (ok) {
		log(pc.green(`truth: the old code runs here — expected values come from running it`));
		return mode;
	}
	log(pc.yellow(`truth: the old code could not be run here (${said || "probe red"}) — each unit still tries a small script; where that fails its truth is read from the code, marked in the ledger.`));
	const qid = await o
		.ask?.({
			facts: `Before the first unit, a setup model tried to load and call one unit of the old code on this machine and could not. What it said: ${said || "nothing"}. Units now try a small script each; where that fails, expected values are written from reading the code (marked "read, not run").`,
			options: [
				{ value: "retry", facts: "I installed or set up what is missing: try again at the next run" },
				{ value: "read", facts: "keep going like this" },
			],
			recommended: "read",
		})
		.catch(() => undefined);
	if (qid !== undefined) saveLegacyEnv(o.root, o.config, { probeQuestion: qid }, "");
	return mode;
}

// ---- the setup model's tools ----------------------------------------------------------------------------

const out = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

/** A copy-on-write clone of the legacy repo in the workspace: the one place dependencies may be installed. */
export function legacyCopyTool(root: string, config: Config): ToolDefinition {
	return {
		name: "make_legacy_copy",
		label: "Copy the legacy repo",
		description: `Make a copy of the read-only legacy repo (${config.source.path}) in the workspace and run truth scripts there from now on. Install the old code's dependencies in the copy, never in the legacy repo. Instant on disks that clone (copy-on-write).`,
		promptSnippet: "make_legacy_copy: a writable copy of the legacy repo where truth scripts run",
		parameters: Type.Object({ why: Type.String() }),
		execute: async (_id: string, p: { why: string }) => {
			const dst = copyDir(root);
			if (!existsSync(dst)) {
				mkdirSync(join(dst, ".."), { recursive: true });
				try {
					execFileSync("cp", process.platform === "darwin" ? ["-cR", config.source.path, dst] : ["-R", "--reflink=auto", config.source.path, dst], { stdio: ["ignore", "pipe", "pipe"] });
				} catch {
					cpSync(config.source.path, dst, { recursive: true, verbatimSymlinks: true });
				}
			}
			saveLegacyEnv(root, config, { root: dst }, p.why);
			return out(`the copy is at ${dst}; truth scripts run there from now on (cwd = the copy). Install the dependencies there.`);
		},
	} as unknown as ToolDefinition;
}

export function legacyRunTool(root: string, config: Config): ToolDefinition {
	return {
		name: "set_legacy_run",
		label: "Set the truth run command",
		description: `Set how a truth script runs on the old code, when the default does not fit (another binary or version, ini/memory flags, a container). "{script}" is replaced by the script's absolute path, "{root}" by the folder the old code runs in. The command runs with cwd = that folder and must print the script's output unchanged.`,
		promptSnippet: "set_legacy_run: the command truth scripts run with on the old code",
		parameters: Type.Object({ cmd: Type.String(), args: Type.Array(Type.String()), why: Type.String() }),
		execute: async (_id: string, p: { cmd: string; args: string[]; why: string }) => {
			if (![p.cmd, ...p.args].some((a) => a.includes("{script}"))) return out('refused: one arg must contain "{script}"');
			saveLegacyEnv(root, config, { run: { cmd: p.cmd, args: p.args } }, p.why);
			return out(`truth scripts run with: ${[p.cmd, ...p.args].join(" ")}`);
		},
	} as unknown as ToolDefinition;
}

/** Returns the model's one-sentence account of what it changed. */
export type LegacyFixer = (o: { config: Config; root: string; source: SourceAdapter; problem: string; script: string; probe?: boolean }) => Promise<string | void>;

export const fixLegacyEnvWithModel: LegacyFixer = async (o) => {
	console.log(pc.cyan(o.probe ? `  ${o.source.id}: can the old code run here? a model with tools tries to set it up` : `  ${o.source.id}: the old code does not run here; a model with tools sets up its environment`));
	const work = join(o.root, ".bigrefactor", "legacy-env");
	mkdirSync(work, { recursive: true });
	const truth = loadDecisions(o.root).truth;
	const env = loadLegacyEnv(o.root, o.config);
	const session = await spawnLeaf({
		role: "setup",
		cwd: work,
		config: o.config,
		writeGlobs: ["**"],
		protectedGlobs: [],
		customTools: [legacyCopyTool(o.root, o.config), legacyRunTool(o.root, o.config)],
		transcriptPath: join(o.root, ".bigrefactor", "sessions", `__setup__.legacy.${Date.now()}.jsonl`),
		systemPrompt: `You make the OLD ${o.source.id} code runnable on this machine, so a migration tool can run characterization scripts against it. The legacy repo (${o.config.source.path}) is read-only: never write into it. Use make_legacy_copy for a copy you may change (install the dependencies with the project's own package manager, as its manifest and docs say), and set_legacy_run when the run command itself must change. Check which tools this machine really has (versions, docker) before choosing a way. ${o.probe ? "You also write the probe script you are asked for; keep it tiny." : "Do not edit the script: it belongs to the tester; when it is the script itself that is wrong (not the environment), say so and stop."} Never interactive prompts, never servers left running (a database container the old code needs may stay up). End with one sentence saying what you did.\n\n${PLAIN_LANGUAGE}`,
	});
	try {
		const now = truthCommand(env, o.source, o.script);
		const r = await session.run(o.probe ? `${o.problem}\nRun it the way the tool will: cd ${now.cwd} && ${[now.cmd, ...now.args].join(" ")} (after set_legacy_run, with the command set).${truth ? ownerPreference(truth) : ""}` : `A characterization script fails on the old code:\n${o.problem.slice(-3000)}\n\nThe script: ${o.script}\nIt runs now as: cd ${now.cwd} && ${[now.cmd, ...now.args].join(" ")}${truth ? ownerPreference(truth) : ""}\nMake the environment such that this script runs green, then run it the way the tool will (with the command set) to confirm.`);
		const said = r.text.trim().split("\n").at(-1) ?? "";
		console.log(pc.dim(`  legacy setup model: ${r.toolCalls} tool calls, $${r.usage.cost.toFixed(4)} — ${said}${r.error ? pc.red(` ERROR: ${r.error}`) : ""}`));
		return said;
	} finally {
		session.dispose();
	}
};

/** The owner's setup answer is a preference, never a reason to give up: what this machine lacks is worked around. */
const ownerPreference = (truth: Record<string, string>) => `\nThe owner's preference for how the old app runs (from setup): ${JSON.stringify(truth)} (paths relative to the legacy repo). It is a preference, not a requirement: if this machine lacks what it needs (e.g. a tool that is not installed), use what the machine has instead.`;

let fixing: Promise<string | undefined> | undefined;
const tries = new Map<string, number>();
/** Tries per problem (the same error in different units), and in all: the run goes on, units then ask the owner. */
export const MAX_LEGACY_FIXES_PER_PROBLEM = 2;
export const MAX_LEGACY_FIXES = 10;

/**
 * A truth script that stays red after the tester's tries: the setup model fixes the old code's environment, once
 * for all units (units failing meanwhile wait for the running fix). It counts only when code then runs the failed
 * script green. Returns what changed, or undefined.
 */
export async function fixLegacyEnv(o: { config: Config; root: string; source: SourceAdapter; problem: string; truthDir: string; signature: string; fixer?: LegacyFixer }): Promise<string | undefined> {
	if (fixing) {
		const said = await fixing;
		return said && verifyTruthOnOld(o.truthDir, o.config, o.source, o.root).ok ? said : undefined;
	}
	if ((tries.get(o.signature) ?? 0) >= MAX_LEGACY_FIXES_PER_PROBLEM || (tries.get("") ?? 0) >= MAX_LEGACY_FIXES) return undefined;
	tries.set(o.signature, (tries.get(o.signature) ?? 0) + 1);
	tries.set("", (tries.get("") ?? 0) + 1);
	fixing = (async () => {
		const said = await (o.fixer ?? fixLegacyEnvWithModel)({ config: o.config, root: o.root, source: o.source, problem: o.problem, script: join(o.truthDir, o.source.truth.scriptName) });
		if (!verifyTruthOnOld(o.truthDir, o.config, o.source, o.root).ok) return undefined;
		const what = said || "the old code's environment was set up";
		const env = loadLegacyEnv(o.root, o.config);
		appendFileSync(join(o.root, ".bigrefactor", "legacy-env.log"), `${new Date().toISOString()} ${relative(o.root, resolve(env.root)) || env.root} ${what.replace(/\s+/g, " ")}\n`);
		return what;
	})().finally(() => (fixing = undefined));
	return fixing;
}
