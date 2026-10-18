import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import pc from "picocolors";
import { Type } from "typebox";
import type { TargetAdapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import { addWorktree, deleteBranch, headOf, removeWorktree, wsBranch } from "../git.ts";
import { projectDir } from "../init/init.ts";
import type { Ledger } from "../ledger/db.ts";
import { PLAIN_LANGUAGE } from "../policy.ts";
import { exec } from "../proc.ts";
import { spawnLeaf } from "../sessions/spawn.ts";
import { runCmd } from "./builder.ts";
import { deadStubMarks } from "./stub-sweep.ts";

/**
 * The finish check: "all units accepted" only counts unit states. When no unit is left to run, this looks at the new
 * app as a whole for work no unit will do: stub marks left on main, pages whose data the app entry never hands in,
 * frontend calls no backend route serves, stacks not joined into one running app, migrations that fail on an empty
 * database. Code finds what is certain (the marks, the migration command); a read-only model finds the rest in the
 * code with its tools. Each gap becomes work the run already knows how to do (the stub sweep, a code job per stack,
 * which may change the entry files units may not); only what a person must decide becomes one owner question.
 */

export interface FinishItem {
	/** the stack whose project the fix goes in */
	stack: string;
	problem: string;
	fix: string;
	/** set when only a person can settle it (why) */
	human?: string;
}

export interface FinishReport {
	at: string;
	/** main's commit the check looked at */
	head: string;
	/** every TODO(br:...) mark on main, and those no unit will replace (owner accepted or no unit) */
	marks: number;
	deadMarks: number;
	items: FinishItem[];
	/** the run made it and handed its gaps on (an on-demand check only reports: the run still acts on that commit) */
	acted: boolean;
	/** items handed to code jobs, and how many of those jobs merged */
	handed: number;
	merged: number;
	/** the owner question for the items only a person can settle */
	asked?: number;
	/** the finder model ended without findings: the rest of the check still counts */
	notJudged?: string;
	/** not proven yet: accepted units whose expected values were read from the old code, never run; slices never compared with the old app */
	readNotRun: number;
	neverCompared: string[];
}

export const FINISH_META = "finish_check";
/** Items per code job: a job with many gaps would not finish; the next finish pass hands the rest. */
export const FINISH_BATCH = 12;
/** Finish passes per run: each one after a code job merged looks at the new main; past this the next run goes on. */
export const FINISH_PASSES = 3;

/** Finds the gaps a model must judge, in `dir` (the target repo on main). Undefined: it gave no answer. */
export type FinishFinder = (o: { config: Config; root: string; dir: string; facts: string }) => Promise<FinishItem[] | undefined>;

export const findWithModel: FinishFinder = async (o) => {
	let found: FinishItem[] | undefined;
	const tool = {
		name: "finish_findings",
		label: "Finish findings",
		description: "Your one list of gaps that keep the new app from working as one app. One item per gap: stack (the project where the fix goes), problem (file:line, what is missing), fix (concrete: the file and what to add). human: only when a person must decide it, with the reason; leave it out when code can be written for it.",
		promptSnippet: "finish_findings: the gaps you found (an empty list when there are none)",
		parameters: Type.Object({ items: Type.Array(Type.Object({ stack: Type.String(), problem: Type.String(), fix: Type.String(), human: Type.Optional(Type.String()) })) }),
		execute: async (_id: string, p: { items: FinishItem[] }) => {
			found = p.items;
			return { content: [{ type: "text" as const, text: "recorded; stop here" }], details: {} };
		},
	} as unknown as ToolDefinition;
	const session = await spawnLeaf({
		role: "review", // read tools only
		cwd: o.dir,
		config: o.config,
		writeGlobs: [],
		customTools: [tool],
		transcriptPath: join(o.root, ".bigrefactor", "sessions", `__finish__.${Date.now()}.jsonl`),
		systemPrompt: finishPrompt(o.config),
	});
	try {
		await session.run(o.facts);
		if (!found) await session.run("You ended without a list. Call finish_findings now, once (an empty list when there are no gaps).");
		return found;
	} finally {
		session.dispose();
	}
};

export function finishPrompt(config: Config): string {
	return `An automated migration of a ${config.source.stack} app to ${config.target.stacks.join(" + ")} has no work left to run. Check whether the new app really works as one running app. Read the code with your tools; do not guess. Look for:
1. Each stack's real entry point (the file the app starts from, and what it mounts or boots). Every value a page or route needs (a data loader, a prop, a service) that nothing on the path from that entry supplies, so the page falls into a placeholder, "unavailable" or empty branch when the app runs. Tests that hand the value in do not count.
2. Every backend URL the frontend calls that no backend route serves (compare the paths the frontend fetches with the routes the backend declares), and backend routes declared twice (same name or same path).
3. Whether the stacks are joined into one app, when the frontend and the backend are separate projects: in development (a dev server proxy to the backend, or the backend serving the frontend) and in production (the built frontend is served, and unknown paths go to it so deep links work). Each missing link is one gap.
A gap behind a TODO(br:<id>) mark whose <id> is in the open list below is fine: that work is still to come. Stub marks are handled on their own; do not list a mark as a gap only because it is there.
Then call finish_findings once. Set human only when a person must decide it (a choice only the owner can make, a secret, a server only they run); code jobs write everything else, entry files included.\n\n${PLAIN_LANGUAGE}`;
}

/** Every TODO(br:...) mark in `dir`'s tracked files (count only). */
export async function stubMarkCount(dir: string): Promise<number> {
	try {
		const out = await exec("git", ["grep", "-o", "-E", "TODO\\(br:[^)]+\\)", "--", "."], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
		return out.split("\n").filter(Boolean).length;
	} catch {
		return 0; // no match, or not a repo
	}
}

/** What is not proven by "accepted": expected values read but never run on the old code, slices never compared. */
export function notProven(ledger: Ledger): { readNotRun: number; neverCompared: string[] } {
	const readNotRun = (ledger.db.prepare("SELECT COUNT(*) n FROM units u WHERE u.state = 'accepted' AND EXISTS (SELECT 1 FROM evidence e WHERE e.unit_id = u.id AND e.type = 'truth_read') AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.unit_id = u.id AND e.type = 'truth_green_on_old')").get() as { n: number }).n;
	const compared = new Set((ledger.db.prepare("SELECT DISTINCT slice FROM parity_runs WHERE outcome IN ('same', 'differs')").all() as Array<{ slice: string }>).map((r) => r.slice));
	const slices = new Set(ledger.listUnits().map((u) => (JSON.parse(u.meta) as { slice?: string }).slice).filter((s): s is string => !!s));
	return { readNotRun, neverCompared: [...slices].filter((s) => !compared.has(s)).sort() };
}

const itemKey = (i: FinishItem) => createHash("sha1").update(`${i.stack}\0${i.problem}`).digest("hex").slice(0, 12);

export function lastFinish(ledger: Ledger): FinishReport | undefined {
	const r = ledger.getMeta(FINISH_META);
	return r ? (JSON.parse(r) as FinishReport) : undefined;
}

/** Whether the run checks main (at `head`) now: once per commit it acted on (a restart does not check it again), FINISH_PASSES a run. */
export function finishDue(ledger: Ledger, head: string | undefined, passes: number): boolean {
	const last = lastFinish(ledger);
	return !!head && passes < FINISH_PASSES && !(last?.head === head && last.acted);
}

/** One line for status and the end of the run. */
export function renderFinishLine(r: FinishReport): string {
	const open = r.items.filter((i) => !i.human).length;
	const human = r.items.filter((i) => i.human).length;
	return `finish check @ ${r.head.slice(0, 7)} (${r.at.slice(0, 16).replace("T", " ")}): stub marks ${r.marks} (${r.deadMarks} no unit will replace)  gaps ${open}${r.handed ? ` (${r.handed} to code jobs, ${r.merged} merged)` : ""}${human ? `  for you ${human}` : ""}${r.notJudged ? `  not judged: ${r.notJudged}` : ""}  not proven yet: ${r.readNotRun} accepted with expected values read, not run; ${r.neverCompared.length} slice(s) never compared with the old app${r.neverCompared.length ? ` (${r.neverCompared.slice(0, 4).join(", ")}${r.neverCompared.length > 4 ? " …" : ""})` : ""}`;
}

export async function finishCheck(o: {
	ledger: Ledger;
	config: Config;
	root: string;
	adapters: Map<string, TargetAdapter>;
	linkAll: (wt: string) => void | Promise<void>;
	log: (l: string) => void;
	/** names the worktree (the run and an on-demand check may run at once) */
	label?: string;
	finder?: FinishFinder;
	/** hands one stack's gaps to a code job; true when it merged. None: report only */
	codeJob?: (stackId: string, what: string) => Promise<boolean>;
	/** the stub sweep for a stack with marks no unit will replace (it hands each mark once) */
	sweep?: (stackId: string) => Promise<unknown> | undefined;
	/** asks the owner about the gaps only a person can settle; returns the question id */
	ask?: (facts: string, sameAs: string) => Promise<number | undefined>;
}): Promise<FinishReport> {
	const repo = o.config.target.path;
	const label = o.label ?? "finish";
	const wt = join(o.root, ".bigrefactor", "worktrees", `__${label}__`);
	const branch = wsBranch(o.root, label);
	const reset = async () => {
		await removeWorktree(repo, wt);
		await deleteBranch(repo, branch).catch(() => undefined);
	};
	await reset();
	await addWorktree(repo, wt, branch);
	try {
		await o.linkAll(wt);
		const head = (await headOf(wt)) ?? "";
		const dirOf = (id: string) => join(wt, relative(repo, projectDir(o.config, id)));
		// certain, by code: the marks left, and the migrations on an empty database (when the stack has a command for it)
		const marks = await stubMarkCount(wt);
		const dead = await deadStubMarks(o.ledger, wt);
		const items: FinishItem[] = [];
		for (const [id, a] of o.adapters) {
			const c = a.migrateFresh?.(dirOf(id));
			if (!c) continue;
			const err = await runCmd(c.cmd, c.args, dirOf(id), 6000);
			if (err !== undefined) items.push({ stack: id, problem: `the migrations fail on a new empty database ($ ${[c.cmd, ...c.args].join(" ")})`, fix: `make every migration apply in order on an empty database:\n${err}` });
		}
		// the rest a model finds in the code
		const open = o.ledger.listUnits().filter((u) => u.state !== "accepted").map((u) => `${u.id} (${u.state})`);
		const stacks = [...o.adapters].map(([id, a]) => `- ${id}: ${relative(repo, projectDir(o.config, id)) || "."}/ (${a.role})`);
		const facts = `The new app's repo is your working directory. Its projects:\n${stacks.join("\n")}\n\nOpen work (not done yet; ${open.length}):\n${open.slice(0, 300).join(", ") || "none"}${open.length > 300 ? ", …" : ""}`;
		let notJudged: string | undefined;
		const found = await (o.finder ?? findWithModel)({ config: o.config, root: o.root, dir: wt, facts }).catch((e) => ((notJudged = String(e?.message ?? e).slice(0, 200)), undefined));
		if (!found && !notJudged) notJudged = "the model gave no list";
		items.push(...(found ?? []).filter((i) => o.adapters.has(i.stack) || i.human));
		const report: FinishReport = { at: new Date().toISOString(), head, marks, deadMarks: dead.length, items, acted: !!o.codeJob, handed: 0, merged: 0, notJudged, ...notProven(o.ledger) };
		o.log(pc.cyan(renderFinishLine(report)));
		// work: the stub sweep, one code job per stack, one owner question
		if (o.sweep) for (const id of o.adapters.keys()) if ((await deadStubMarks(o.ledger, dirOf(id))).length) await o.sweep(id);
		for (const id of o.adapters.keys()) {
			const mine = items.filter((i) => i.stack === id && !i.human).slice(0, FINISH_BATCH);
			if (!mine.length || !o.codeJob) continue;
			report.handed += mine.length;
			if (await o.codeJob(id, finishJobText(mine)).catch(() => false)) report.merged += mine.length;
		}
		const human = items.filter((i) => i.human);
		if (human.length && o.ask) report.asked = await o.ask(`When no work was left, a check of the whole new app found ${human.length} thing(s) only you can settle:\n${human.map((i) => `- ${i.problem} (${i.human}). Suggested: ${i.fix}`).join("\n")}`, `finish:${human.map(itemKey).sort().join(",")}`).catch(() => undefined);
		o.ledger.setMeta(FINISH_META, JSON.stringify(report));
		return report;
	} finally {
		await reset();
	}
}

export function finishJobText(items: FinishItem[]): string {
	return `A check of the whole new app (after all work ran) found these gaps: the app does not work as one app until they are closed. Close each one: wire what the app's entry never supplies (entry files are yours to change), add the missing backend routes or point the frontend at the routes that exist (read the legacy code for the behaviour), join the stacks so they run as one app. Write tests for what you add. Leave every TODO(br:...) mark of work still open alone.
${items.map((i) => `- ${i.problem}\n  fix: ${i.fix}`).join("\n")}`;
}
