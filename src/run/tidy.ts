import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { getTargetAdapter } from "../adapters/registry.ts";
import type { Config } from "../config.ts";
import { projectDir } from "../init/init.ts";
import { answerValue, askViaModel, loadBrief } from "../jev/ask.ts";
import type { Ledger } from "../ledger/db.ts";
import type { ModelClient } from "../models/types.ts";
import { proposeRule } from "../rules/living.ts";
import { stackTagLike } from "../inventory/target.ts";

/**
 * Tidy review: keeps each area module professional and easy to find as it grows. Code checks (structure_ok,
 * the whole-tree drift report) catch shape violations; this catches what only reading can: names that no
 * longer say what a file does, a service that became a grab bag, two files doing one job, a helper that
 * belongs in shared. Every `every` accepted units of an area, a model reviews the area's tree, exports,
 * capability cards and drift findings and returns:
 *  - conventions worth stating → rule proposals (living rules curate them),
 *  - moves/renames/merges/splits → one question each (via a model, with opinion; blocks nothing).
 * An approved change becomes a tidy task the NEXT unit of that area performs (task card), so the gate checks
 * the result like any other change; `completeTidyTasks` closes tasks once the tree shows them done.
 */
export interface TidyTask {
	id: string;
	stack: string;
	area: string;
	op: "move" | "rename" | "merge" | "split";
	from: string[];
	to: string[];
	why: string;
	questionId: number;
	status: "asked" | "approved" | "rejected" | "done";
}

interface Deps {
	ledger: Ledger;
	config: Config;
	root: string;
	client?: ModelClient;
}

export async function maybeTidyReview(d: Deps, o: { stackId: string; area: string; every?: number; force?: boolean }): Promise<{ reviewed: boolean; asked: number; proposals: number; costUsd: number }> {
	syncTidyAnswers(d.ledger);
	const key = `tidy_count:${o.stackId}:${o.area}`;
	const n = Number(d.ledger.getMeta(key) ?? "0") + 1;
	d.ledger.setMeta(key, String(n));
	const none = { reviewed: false, asked: 0, proposals: 0, costUsd: 0 };
	if (!d.client || (!o.force && n < (o.every ?? 10))) return none;
	d.ledger.setMeta(key, "0");

	const adapter = await getTargetAdapter(o.stackId);
	const proj = projectDir(d.config, o.stackId);
	const areaDir = adapter.layout.moduleDir(o.area);
	const files = listFiles(join(proj, areaDir)).map((f) => relative(proj, f));
	if (!files.length) return none;
	const tree = files.map((f) => `${f} (${lineCount(join(proj, f))} lines)`).join("\n");
	const exports = d.ledger.db.prepare("SELECT path, kind, name FROM index_symbols WHERE side = 'target' AND path LIKE ? AND tags LIKE ? ORDER BY path, line").all(`${areaDir}/%`, stackTagLike(o.stackId)) as Array<{ path: string; kind: string; name: string }>;
	const cards = d.ledger.db.prepare("SELECT path, name, summary FROM capabilities WHERE stack = ? AND path LIKE ?").all(o.stackId, `${areaDir}/%`) as Array<{ path: string; name: string; summary: string }>;
	const drift = (d.ledger.getMeta(`drift:${o.stackId}`) ?? "").split("\n").filter((l) => l.startsWith(`${areaDir}/`)).slice(0, 40).join("\n");
	const open = tidyTasks(d.ledger, o.stackId, o.area).filter((t) => t.status === "asked" || t.status === "approved");
	const rejected = tidyTasks(d.ledger, o.stackId, o.area).filter((t) => t.status === "rejected");
	const sig = (op: string, from: string[], to: string[]) => `${op}|${[...from].sort().join(",")}|${[...to].sort().join(",")}`;
	const seen = new Set([...open, ...rejected].map((t) => sig(t.op, t.from, t.to)));

	const role = d.config.models.escalate;
	const res = await d.client.chat({
		model: role.id,
		tier: role.tier as "default" | "flex" | "priority",
		effort: "medium",
		schema: {
			type: "object",
			additionalProperties: false,
			required: ["changes", "conventions"],
			properties: {
				changes: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						required: ["op", "from", "to", "why"],
						properties: { op: { type: "string", enum: ["move", "rename", "merge", "split"] }, from: { type: "array", items: { type: "string" } }, to: { type: "array", items: { type: "string" } }, why: { type: "string" } },
					},
				},
				conventions: { type: "array", items: { type: "object", additionalProperties: false, required: ["text", "why"], properties: { text: { type: "string" }, why: { type: "string" } } } },
			},
		},
		messages: [
			{ role: "system", content: `You review one feature module of a codebase under migration for tidiness: a new developer must find things by name, every file has one clear job, names are professional and consistent, nothing reads like a legacy artifact. Propose only changes worth their cost (at most 6; never a new layer or abstraction the module does not need), all paths relative to the project and inside ${areaDir}/ or the shared dirs (${adapter.layout.sharedDirs.join(", ")}); never break the binding layout below. Conventions = patterns the whole stack should follow from now on.\n\nBinding layout:\n${adapter.layout.structureDoc}` },
			{ role: "user", content: `${loadBrief(d.root) ? `Repo brief:\n${loadBrief(d.root).slice(0, 2500)}\n\n` : ""}Area "${o.area}" (${o.stackId}):\n${tree}\n\nExports:\n${exports.map((e) => `${e.path}: ${e.kind} ${e.name}`).join("\n")}\n\nWhat the code does:\n${cards.map((c) => `${c.path} ${c.name}: ${c.summary}`).join("\n") || "(no cards)"}\n${drift ? `\nCode checks flagged:\n${drift}\n` : ""}${open.length ? `\nAlready pending (do not repeat):\n${open.map((t) => `${t.op} ${t.from.join(", ")} → ${t.to.join(", ")}`).join("\n")}` : ""}${rejected.length ? `\nRejected by the owner (never propose these again, nor variants of them):\n${rejected.map((t) => `${t.op} ${t.from.join(", ")} → ${t.to.join(", ")}`).join("\n")}` : ""}` },
		],
	});
	let cost = res.usage.costUsd;
	const j = (res.json ?? {}) as { changes?: Array<{ op: TidyTask["op"]; from: string[]; to: string[]; why: string }>; conventions?: Array<{ text: string; why: string }> };
	let proposals = 0;
	for (const c of j.conventions ?? []) {
		proposeRule(d, { stack: o.stackId, kind: "add", text: c.text, why: `tidy review of ${o.area}: ${c.why}` });
		proposals++;
	}
	const allowed = (p: string) => p.startsWith(`${areaDir}/`) || adapter.layout.sharedDirs.some((s) => p.startsWith(s));
	const tasks = loadTasks(d.ledger);
	let asked = 0;
	for (const c of j.changes ?? []) {
		if (!c.from.length || !c.to.length || ![...c.from, ...c.to].every(allowed) || seen.has(sig(c.op, c.from, c.to)) || onlyCase(c)) continue;
		const q = await askViaModel(d, {
			point: "tidy",
			facts: `Tidy review of area "${o.area}" (${o.stackId}) proposes: ${c.op} ${c.from.join(", ")} → ${c.to.join(", ")}. Reason: ${c.why}. If approved, the next unit of this area performs it (the builder's whole-project check after merges, which also runs all tests, catches broken imports); nothing waits for this answer.`,
			options: [{ value: "apply", facts: "do it with the next unit of the area" }, { value: "skip", facts: "leave the files as they are" }],
			recommended: "apply",
			agentOpinion: c.why,
			blocks: "none",
			askedBy: "tidy",
			context: { stack: o.stackId, area: o.area, change: c },
		});
		cost += q.costUsd;
		tasks.push({ id: `T${q.id}`, stack: o.stackId, area: o.area, op: c.op, from: c.from, to: c.to, why: c.why, questionId: q.id, status: "asked" });
		asked++;
	}
	saveTasks(d.ledger, tasks);
	return { reviewed: true, asked, proposals, costUsd: cost };
}

export function tidyTasks(ledger: Ledger, stack?: string, area?: string): TidyTask[] {
	syncTidyAnswers(ledger);
	return loadTasks(ledger).filter((t) => (!stack || t.stack === stack) && (!area || t.area === area));
}

/** Approved tidy tasks of an area, as task-card text for the next unit (empty = none). */
export function tidyTaskCard(ledger: Ledger, stack: string, area: string): string {
	syncTidyAnswers(ledger);
	const todo = tidyTasks(ledger, stack, area).filter((t) => t.status === "approved" && !onlyCase(t));
	return todo.map((t) => `- ${t.op}: ${t.from.join(", ")} → ${t.to.join(", ")} (${t.why}); update every import, keep behaviour identical`).join("\n");
}

/** After an accept: approved tasks whose sources are gone and targets exist are done. */
export function completeTidyTasks(ledger: Ledger, projectDirAbs: string, stack: string, area: string): string[] {
	const tasks = loadTasks(ledger);
	const done: string[] = [];
	for (const t of tasks) {
		if (t.stack !== stack || t.area !== area || t.status !== "approved") continue;
		// sources that are not also targets must be gone (a split may keep its source file)
		// (a case-only rename is skipped, see tidyMoves: on macOS its source "exists" as the target)
		const gone = t.op === "split" || t.from.filter((f) => !t.to.some((x) => x.toLowerCase() === f.toLowerCase())).every((f) => !existsSync(join(projectDirAbs, f)));
		if (gone && t.to.every((f) => existsSync(join(projectDirAbs, f)))) {
			t.status = "done";
			done.push(t.id);
		}
	}
	if (done.length) saveTasks(ledger, tasks);
	return done;
}

/** A rename that only changes letter case (Arangodb → ArangoDb). */
export function caseOnly(from: string, to: string): boolean {
	return from !== to && from.toLowerCase() === to.toLowerCase();
}
/** A move/rename whose every file only changes letter case: never asked, never handed to a unit. */
function onlyCase(t: Pick<TidyTask, "op" | "from" | "to">): boolean {
	return (t.op === "move" || t.op === "rename") && t.from.length === t.to.length && t.from.every((f, i) => caseOnly(f, t.to[i]!));
}

export function syncTidyAnswers(ledger: Ledger): void {
	const tasks = loadTasks(ledger);
	let changed = false;
	for (const t of tasks) {
		if (t.status !== "asked") continue;
		const q = ledger.getQuestion(t.questionId);
		if (!q || (q.status !== "answered" && q.status !== "auto")) continue;
		t.status = answerValue(q.answer) === "apply" ? "approved" : "rejected";
		changed = true;
	}
	if (changed) saveTasks(ledger, tasks);
}

function loadTasks(ledger: Ledger): TidyTask[] {
	return JSON.parse(ledger.getMeta("tidy_tasks") ?? "[]") as TidyTask[];
}
function saveTasks(ledger: Ledger, tasks: TidyTask[]): void {
	ledger.setMeta("tidy_tasks", JSON.stringify(tasks));
}

function listFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	for (const n of readdirSync(dir).sort()) {
		const p = join(dir, n);
		if (statSync(p).isDirectory()) out.push(...listFiles(p));
		else out.push(p);
	}
	return out;
}
function lineCount(p: string): number {
	try {
		return readFileSync(p, "utf8").split("\n").length;
	} catch {
		return 0;
	}
}
