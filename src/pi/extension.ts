import { forecast, renderForecast, type Forecast } from "../run/forecast.ts";
import { totalSpend } from "../spend.ts";
import { lanes, parseLanesArgs } from "../run/lanes.ts";
/**
 * Thin Pi shell for bigrefactor. The heavy lifting (sessions, gates, scheduler) runs in the `br`
 * CLI; this extension makes the ledger visible and queryable from inside any Pi session:
 *
 *   /br init [flags]      the init interview with Pi dialogs → bigrefactor.config.json in the cwd
 *   /br status            dashboard
 *   /br why <id|path>     full history of a symbol or file
 *   /br unaccounted       what is not yet in a terminal state
 *   /br questions         open questions; /br answer walks through them (or /br answer <id> <text>)
 *   ledger_query tool     read-only presets + SELECTs for the model
 *   br_init tool          the model sets a workspace up from a conversation ("migrate ../legacy to nestjs")
 *
 * Uses the Pi 1.0 ExtensionAPI surface. Command output is for the human: it goes into the session
 * as a custom entry (appendEntry + entry renderer), which the transcript shows but the model never
 * sees. The model reaches the ledger through ledger_query, so a 12k-line /br unaccounted costs no
 * context. Without a UI (print/json mode) output goes to the console.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { setOutputHost } from "../proc.ts";
import { QuestionCard, type CardAnswer, type CardQuestion } from "./question-card.ts";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { findConfigPath, loadConfig, STATE_DIR } from "../config.ts";
import { renderStatus, renderWhy } from "../dashboard/status.ts";
import type { InitPrompter, PromptOption } from "../init/init.ts";
import { Ledger } from "../ledger/db.ts";
import type { QuestionRow } from "../ledger/schema.ts";
import { groupQuestions, optionFor } from "../jev/ask.ts";
import { fmtUsage, progress, short, StoppedError, type AgentState, type ProgressSnapshot, type StepState } from "../progress.ts";
import pc from "picocolors";

/** Strip ANSI codes: init reuses the CLI's picocolors output, the transcript wants plain text. */
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Transcript entries longer than this are cut; the full list is one ledger_query away. */
const MAX_LINES = 200;

const SUBCOMMANDS: Record<string, string> = {
	status: "ledger dashboard",
	check: "what bigrefactor needs here (Pi packages, logins, the stacks' tools) and what is missing",
	forecast: "how far the migration is: done, open, spend and time left",
	lanes: "lanes [n] [gates m]: show/change parallel units live (running units finish)",
	push: "push [on|off] [remote]: push the migration branch to the target repo's remote after merges",
	why: "why <id|path>: full history of a symbol or file",
	unaccounted: "symbols not yet in a terminal state",
	questions: "open questions waiting for you (list)",
	requeue: "requeue <unit...> | --all: put quarantined or waiting units back into the queue (after a fix)",
	recheck: "recheck [--limit N] [--again]: accepted units under the newer checks; failures go back to planned with their code kept (background)",
	answer: "answer: walk through the open questions one dialog at a time (identical ones together) · answer <id> <text>",
	init: "init: give the old and the new folder; gathers data, asks the decisions, builds the workspace",
	start: "start: same as init",
	resume: "resume: continue onboarding where it stopped, then the migration if it already started",
	progress: "progress: what the running onboarding is doing right now (full activity log)",
	stop: "stop: stop the running job (a run lets running units finish; stop twice to abort them)",
	run: "run [--limit N] [--slice S] [--units a,b] [--dry] [--force]: migrate units in the background (live panel, /br stop); --force starts despite layout problems",
	onboard: "onboard [init flags] [--yes] [--no-llm]: whole onboarding, resumable (init → setup → docs → inventory → profile → frameworks → decide → rules → order)",
	decide: "decide [id=value ...]: open decisions the inventory could not make; run/L3 wait for them",
	frameworks: "frameworks: legacy framework & library mapping (platform | port | drop)",
	order: "order: vertical slice plan (foundation → auth → features)",
	rule: 'rule [stack:] <plain words>: change how the new code is organised, e.g. rule "sub-features in their own folder, no extended/" (checked by code, shown before it applies) · rule: show the current layouts',
	layout: "layout: preflight — units per stack, top areas, target tree, problems (run refuses on problems)",
};

interface BrEntry {
	title: string;
	text: string;
	/** Text carries its own ANSI colors (live job progress): rendered as is, not re-themed. */
	colored?: boolean;
}

/**
 * The init interview on Pi dialogs. Collected log lines end up in one transcript entry so the
 * result is persisted with the session.
 */
/** A question card (options with descriptions, recommendation preselected, or a prefilled text field); undefined = cancelled. */
const TYPE = "Type an answer…", SKIP = "Skip for now", QUIT = "Stop answering", SPLIT = "Answer these one by one";
/**
 * One question card for a group of open questions that ask the same thing (groupQuestions): its options, a typed
 * answer, skip or stop. Used by /br answer and, during a run, for questions no model could answer.
 */
export async function answerGroup(ctx: ExtensionContext, ledger: Ledger, qs: QuestionRow[], label: string, by: string, done: string[]): Promise<"quit" | "skipped" | "answered"> {
	const q = qs[0]!;
	const differ = qs.some((x) => x.question !== q.question);
	// the group's members: one line each, cut at the screen edge (the card scrolls when they do not fit)
	const members = differ ? [`${qs.length} questions, one answer for all:`, ...qs.map((x) => `· ${x.unit_id ?? x.point}: ${x.question.split("\n")[0]!}`)] : undefined;
	const head = `${label}${qs.length > 1 && !differ ? ` (same question for ${qs.length} units)` : ""} · ${q.unit_id ?? q.point}\n${q.question}`;
	const options = q.options ? (JSON.parse(q.options) as string[]) : [];
	const recommended = q.context ? (JSON.parse(q.context) as { recommended?: string }).recommended : undefined;
	const pick = await askCard(ctx, {
		message: head,
		...(members ? { details: members } : {}),
		recommended,
		options: [
			...options.map((o) => ({ value: o, label: o })),
			...(differ ? [{ value: SPLIT, label: SPLIT, description: "the texts differ: decide each one on its own" }] : []),
			{ value: TYPE, label: "Type an answer", description: "your own answer, in your words" },
			{ value: SKIP, label: SKIP, description: "stays open; only the code waiting on it waits" },
			{ value: QUIT, label: QUIT },
		],
	});
	if (pick === undefined || pick === QUIT) return "quit";
	if (pick === SKIP) return "skipped";
	if (pick === SPLIT) {
		for (const [j, x] of qs.entries()) if ((await answerGroup(ctx, ledger, [x], `${label}.${j + 1}`, by, done)) === "quit") return "quit";
		return "answered";
	}
	const answer = pick === TYPE ? (await askCard(ctx, { message: q.question, text: { initial: "" } }))?.trim() : pick;
	if (!answer) return "skipped";
	for (const x of qs) ledger.answerQuestion(x.id, pick === TYPE ? answer : optionFor(x, answer), by);
	done.push(`#${qs.map((x) => x.id).join(", #")} = ${answer}`);
	return "answered";
}

function askCard(ctx: ExtensionContext, q: CardQuestion & { multi?: undefined }): Promise<string | undefined>;
function askCard(ctx: ExtensionContext, q: CardQuestion): Promise<CardAnswer | undefined>;
function askCard(ctx: ExtensionContext, q: CardQuestion): Promise<CardAnswer | undefined> {
	return ctx.ui.custom<CardAnswer | undefined>((tui, _theme, _kb, done) => {
		const card = new QuestionCard(q, done);
		card.maxRows = () => Math.max(12, tui.terminal.rows - 2);
		const handle = card.handleInput.bind(card);
		card.handleInput = (data: string) => {
			handle(data);
			tui.requestRender();
		};
		return card;
	});
}

function piPrompter(ctx: ExtensionContext, lines: string[], hooks: { asking?: () => void; answered?: () => void } = {}): InitPrompter {
	const byLabel = (options: PromptOption[], label: string | undefined) => options.find((o) => (o.hint ? `${o.label} — ${o.hint}` : o.label) === label)?.value;
	const labels = (options: PromptOption[]) => options.map((o) => (o.hint ? `${o.label} — ${o.hint}` : o.label));
	return {
		text: async (message, initial) => {
			hooks.asking?.();
			// the card shows the recommended value prefilled (Pi's own input shows neither placeholder nor initial value)
			const v = ctx.hasUI ? await askCard(ctx, { message, text: { initial } }) : await ctx.ui.input(message, initial);
			hooks.answered?.();
			if (v === undefined) return undefined;
			return v.trim() || initial;
		},
		select: async (message, options, initial) => {
			hooks.asking?.();
			if (ctx.hasUI) {
				// one card: question, context lines, every option with its hint, the recommendation marked and preselected
				const v = await askCard(ctx, { message, recommended: initial, options: options.map((o) => ({ value: o.value, label: o.label.replace(/\s*\(recommended\)\s*$/, ""), description: o.hint })) });
				hooks.answered?.();
				return v;
			}
			// Put the suggested value first: Pi's select has no initialValue.
			const ordered = initial ? [...options.filter((o) => o.value === initial), ...options.filter((o) => o.value !== initial)] : options;
			const v = await ctx.ui.select(message, labels(ordered));
			hooks.answered?.();
			return byLabel(ordered, v);
		},
		multi: async (message, options, initial, other) => {
			hooks.asking?.();
			let got: { values: string[]; note: string } | undefined;
			if (ctx.hasUI) {
				// checkboxes, each with its description, plus a last row for the owner's own words
				const v = await askCard(ctx, { message, multi: { initial }, other, options: options.map((o) => ({ value: o.value, label: o.label, description: o.hint })) });
				got = v === undefined || typeof v === "string" ? undefined : v;
			} else {
				const note = await ctx.ui.input(`${message.split("\n")[0]} (picked: ${initial.join(", ")}; anything to add?)`, "");
				got = note === undefined ? undefined : { values: initial, note: note.trim() };
			}
			hooks.answered?.();
			return got;
		},
		log: (line) => lines.push(plain(line)),
	};
}

/** The ledger file for this cwd, or why there is none. Never creates it: reads must stay reads. */
function locateLedger(cwd: string): { path: string } | { missing: string } {
	const p = findConfigPath(cwd);
	if (!p) return { missing: "no bigrefactor.config.json here: run /br init (or `br init` in a terminal) first" };
	// Not statePath(): that mkdirs, and a read must not leave a .bigrefactor/ behind.
	const path = join(loadConfig(p).root, STATE_DIR, "ledger.sqlite");
	return existsSync(path) ? { path } : { missing: "no ledger yet: run `br setup` → `br inventory` in a terminal first" };
}

function openLedger(cwd: string): Ledger | undefined {
	const l = locateLedger(cwd);
	return "path" in l ? new Ledger(l.path) : undefined;
}

/** Durable totals from the ledger (not this run's counters): survive runs, stops and Pi restarts. */
interface Durable {
	accepted: number;
	quarantined: number;
	waiting: number;
	/** Open questions for the owner: what the human has to answer to release the waiting units (forOwnerCount). */
	questions: number;
	spentUsd: number;
	forecast: Forecast;
}
/** A migration run is going on in this process: its resolver model tries every open question before the owner. */
let runActive = false;
/**
 * Questions for the owner: during a run only those the resolver model handed on (context.forOwner); the others are
 * still with the models. Without a run nobody else answers, so every open question counts.
 */
export function forOwnerCount(ledger: Ledger, running = runActive): number {
	const open = ledger.openQuestions();
	return running ? open.filter((q) => q.context && JSON.parse(q.context).forOwner !== undefined).length : open.length;
}
export function durable(ledger: Ledger, root: string): Durable {
	const f = forecast(ledger);
	return { accepted: f.units.accepted, quarantined: f.units.quarantined, waiting: f.units.waiting, questions: forOwnerCount(ledger), spentUsd: totalSpend(root).usd, forecast: f };
}
let durableCache: { at: number; cwd: string; d: Durable } | undefined;
/** Cached for the panel, which repaints often: at most one ledger read per 5 s. */
function durableFor(cwd: string): Durable | undefined {
	if (durableCache && durableCache.cwd === cwd && Date.now() - durableCache.at < 5000) return durableCache.d;
	const l = locateLedger(cwd);
	if (!("path" in l)) return undefined;
	const ledger = new Ledger(l.path);
	try {
		durableCache = { at: Date.now(), cwd, d: durable(ledger, dirname(dirname(l.path))) };
		return durableCache.d;
	} catch {
		return undefined;
	} finally {
		ledger.close();
	}
}

const money = (x: number) => (x < 100 ? `$${x.toFixed(2)}` : `$${Math.round(x).toLocaleString("en-US")}`);
export function statusLine(ledger: Ledger, root: string): string {
	const d = durable(ledger, root);
	const f = d.forecast;
	const open = d.questions;
	const left = f.remaining ? ` · left ≈ ${money(f.remaining.usd[1])} (${money(f.remaining.usd[0])}–${money(f.remaining.usd[2])}), ${f.remaining.hours[1] < 48 ? `${f.remaining.hours[1].toFixed(1)} h` : `${(f.remaining.hours[1] / 24).toFixed(1)} days`} [${f.confidence}]` : "";
	return `br ${(f.progress * 100).toFixed(f.progress < 0.1 ? 1 : 0)}% · ✓ ${d.accepted}/${f.units.total} accepted · ■ ${d.quarantined} quarantined${d.waiting ? ` · ⏸ ${d.waiting} waiting` : ""} · spent ${money(d.spentUsd)} total${left}${open ? ` · ${open} question${open > 1 ? "s" : ""} for you (/br answer)` : ""}`;
}

/** Warnings: a toast with a UI, the console without one (print mode swallows notify). */
function warn(ctx: ExtensionContext, message: string): void {
	if (ctx.hasUI) ctx.ui.notify(message, "warning");
	else console.log(message);
}

/** Pi shows at most ~10 widget lines before "(widget truncated)". */
const WIDGET_MAX_LINES = 10;
const ELAPSED = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`);

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Spinner frame for running things: advances every SPIN_MS, the same frame everywhere in one paint. */
const SPIN_MS = 150;
export const spinner = (now = Date.now()) => SPINNER[Math.floor(now / SPIN_MS) % SPINNER.length]!;

/** "U004_interfaces_… tester luna · 23 calls · $0.004 · 1m02s · bash ls …" */
function agentLine(a: AgentState, now: number, width: number): string {
	const model = (a.model ?? "").split("/").pop() ?? "";
	const head = `${pc.magenta(spinner(now))} ${short(a.label, 26)} ${pc.bold(a.role)} ${pc.dim(model)}`;
	const stats = ` · ${a.toolCalls} calls${a.blocked ? pc.yellow(` · ${a.blocked} blocked`) : ""} · ${fmtUsage(a, 3)} · ${ELAPSED(now - a.since)}`;
	const last = a.lastTool ? pc.dim(` · ${a.lastTool}`) : "";
	const line = head + stats + last;
	return plain(line).length > width ? line.slice(0, line.length - (plain(line).length - width)) : line;
}

/** The live widget above the editor: step rail, what the current step is for, the model session, recent activity. */
export function renderProgress(s: ProgressSnapshot, width = 100, totals?: Durable): string[] {
	const now = Date.now();
	const L: string[] = [];
	const state = s.stopping ? pc.yellow(`${spinner(now)} stopping…`) : s.running ? pc.cyan(`${spinner(now)} running`) : s.error ? pc.red("stopped") : pc.green("finished");
	L.push(`${pc.bold("bigrefactor")} ${s.job ?? ""} · ${state} · ${ELAPSED(now - (s.startedAt ?? now))} · ${fmtUsage(s, 3)}${s.running ? pc.dim("   /br stop · /br progress · chat works meanwhile") : ""}`);
	const names = [...s.plan, ...s.steps.map((x) => x.name).filter((n) => !s.plan.includes(n))];
	const icon = (n: string) => {
		const st = [...s.steps].reverse().find((x) => x.name === n);
		if (!st) return pc.dim(`○ ${n}`);
		if (st.status === "running") return pc.cyan(pc.bold(`${spinner(now)} ${n}`));
		if (st.status === "done") return pc.green(`✓ ${n}`);
		if (st.status === "skipped") return pc.dim(`– ${n}`);
		return pc.red(`✗ ${n}`);
	};
	if (!s.plan.length) {
		// a run: counts + what is running now, not one chip per unit
		const n = (st: string) => s.steps.filter((x) => x.status === st).length;
		const runningNow = s.steps.filter((x) => x.status === "running");
		// totals are durable (ledger); "+N" is this run's share
		const run = (k: string) => (n(k) ? pc.dim(` (+${n(k)} this run)`) : "");
		const acc = totals ? totals.accepted : n("done");
		const qua = totals ? totals.quarantined : n("failed");
		const wai = totals ? totals.waiting : n("skipped");
		L.push(`${pc.green(`✓ ${acc} accepted`)}${run("done")}  ${qua ? pc.red(`■ ${qua} quarantined`) : pc.dim("■ 0 quarantined")}${run("failed")}${wai ? `  ${pc.yellow(`⏸ ${wai} waiting on ${totals?.questions ? `${totals.questions} question${totals.questions > 1 ? "s" : ""} for you: ${pc.bold("/br answer")}` : "a question"}`)}` : ""}  ${pc.cyan(`${runningNow.length ? spinner(now) : "▶"} ${runningNow.length} running`)}${runningNow.length ? pc.dim(`: ${runningNow.map((x) => `${x.name} ${ELAPSED(now - x.startedAt)}`).join(", ")}`) : ""}`.slice(0, width + 60));
		if (s.lanes) {
			const free = s.lanes.max - s.lanes.running;
			L.push(`${pc.bold(`lanes ${s.lanes.running}/${s.lanes.max}`)}${s.lanes.ahead ? pc.cyan(` · ${s.lanes.running - s.lanes.ahead} migrating, ${s.lanes.ahead} capturing truth ahead`) : ""}${s.lanes.reason ? pc.yellow(` · ${s.lanes.reason}${s.lanes.reasonSince ? ` (${ELAPSED(now - s.lanes.reasonSince)})` : ""}`) : free === 0 ? pc.dim(" · all busy: a new unit starts as soon as one finishes") : pc.dim(` · ${s.lanes.ready} more ready`)}`.slice(0, width + 40));
		}
		if (s.waiting) L.push(`${pc.yellow(`${spinner(now)} ${s.waiting.what}`)} ${pc.dim(`(${ELAPSED(now - s.waiting.since)})`)}`.slice(0, width + 20));
		if (totals) {
			const f = totals.forecast;
			L.push(pc.dim(`${(f.progress * 100).toFixed(f.progress < 0.1 ? 1 : 0)}% done · spent ${money(totals.spentUsd)} total${f.remaining ? ` · left ≈ ${money(f.remaining.usd[1])} (${money(f.remaining.usd[0])}–${money(f.remaining.usd[2])}) [${f.confidence}]` : ""} · /br forecast`.slice(0, width)));
		}
		const lastDone = [...s.steps].reverse().find((x) => x.status !== "running");
		if (lastDone) L.push(pc.dim(`last: ${lastDone.status === "done" ? "✓" : lastDone.status === "skipped" ? "⏸" : "■"} ${lastDone.name}${lastDone.note ? `  ${lastDone.note}` : ""}`.slice(0, width)));
		// one line per agent: every unit runs its own tester → implementer sessions, in parallel
		const room0 = WIDGET_MAX_LINES - L.length - 1;
		const agents = [...s.agents].sort((a, b) => a.since - b.since);
		const shown = agents.length > room0 ? agents.slice(0, Math.max(1, room0 - 1)) : agents;
		for (const a of shown) L.push(agentLine(a, now, width));
		if (shown.length < agents.length) L.push(pc.dim(`  +${agents.length - shown.length} more agents · /br progress lists all`));
		const room = Math.max(1, WIDGET_MAX_LINES - L.length);
		for (const a of s.activity.slice(-room)) L.push(pc.dim(a.slice(0, width)));
		return L;
	}
	// wrap the rail to the width
	let row = "";
	for (const n of names) {
		const piece = icon(n);
		if (plain(row).length + plain(piece).length + 2 > width && row) {
			L.push(row);
			row = "";
		}
		row += (row ? "  " : "") + piece;
	}
	if (row) L.push(row);
	const cur = [...s.steps].reverse().find((x) => x.status === "running");
	if (cur) L.push(`${pc.cyan(spinner(now))} ${pc.bold(cur.name)} ${pc.dim(`(${ELAPSED(now - cur.startedAt)})`)}: ${s.about[cur.name] ?? ""}`.slice(0, width + 20));
	const failed = [...s.steps].reverse().find((x) => x.status === "failed");
	if (!s.running && failed) {
		const byUser = /stopped by the user/.test(failed.note ?? "");
		L.push(byUser ? pc.yellow(`■ stopped during ${failed.name}: /br resume continues there (finished steps are skipped)`) : pc.red(`✗ ${failed.name}: ${failed.note ?? ""}`.slice(0, width + 20)));
		if (!byUser) L.push(pc.dim("fix the cause, then /br resume (finished steps are skipped) · /br progress shows the full log"));
	}
	for (const a of s.agents) L.push(agentLine(a, now, width));
	// Pi truncates tall widgets: fill the remaining room with the newest activity, never push the lines above out.
	const room = Math.max(1, WIDGET_MAX_LINES - L.length);
	for (const a of s.activity.slice(-room)) L.push(pc.dim(a.slice(0, width)));
	return L;
}

/** One chat line per step transition: "▶ advise — models judge …", "✓ advise 2m35s  13 libraries …". */
export function stepEntry(st: StepState, s: Pick<ProgressSnapshot, "about">): string {
	const took = st.endedAt ? pc.dim(` ${ELAPSED(st.endedAt - st.startedAt)}`) : "";
	const note = st.note ? pc.dim(`  ${st.note}`) : "";
	switch (st.status) {
		case "running":
			return `${pc.cyan(pc.bold(`▶ ${st.name}`))}${s.about[st.name] ? pc.dim(` — ${s.about[st.name]}`) : ""}`;
		case "done":
			return `${pc.green(`✓ ${st.name}`)}${took}${note}`;
		case "skipped":
			return `${pc.yellow(`– ${st.name}`)}${note}`;
		default:
			return `${pc.red(`✗ ${st.name}`)}${took}${st.note ? pc.red(`  ${st.note}`) : ""}`;
	}
}

interface JobOutcome {
	error?: string;
	/** Lines for the transcript summary after the step list. */
	lines?: string[];
	/** What to offer next (a dialog), run after the summary is posted. */
	next?: () => Promise<void>;
}

/**
 * Run a long job in the background: the command returns at once, chat stays usable, the widget shows
 * progress, /br stop stops it (drain for runs, abort for onboarding). Console output of the job is routed
 * into the activity feed (raw writes corrupt the TUI).
 */
function startJob(pi: ExtensionAPI, ctx: ExtensionContext, job: string, work: () => Promise<JobOutcome>): void {
	if (progress.running) return warn(ctx, `${progress.snapshot().job} is already running: /br progress to watch, /br stop to stop`);
	progress.begin(job);
	const width = () => Math.max(60, (process.stdout.columns ?? 100) - 4);
	let pending: NodeJS.Timeout | undefined;
	let footerAt = 0;
	let seenQuestions = 0; // toast once for questions already open at start, then for every new one
	let lastWidget = "";
	const paint = () => {
		pending = undefined;
		// the footer (durable totals, spend, forecast) follows the run too, at most every 10 s
		if (Date.now() - footerAt > 10_000) {
			footerAt = Date.now();
			try {
				refreshStatus(ctx);
			} catch {
				/* ledger busy: next tick */
			}
		}
		const totals = durableFor(ctx.cwd);
		if (totals && totals.questions > seenQuestions && ctx.hasUI) ctx.ui.notify(`bigrefactor: ${totals.questions} question${totals.questions > 1 ? "s" : ""} for you, units wait on them: /br answer`, "warning");
		if (totals) seenQuestions = totals.questions;
		if (!ctx.hasUI) return;
		// the spinner ticks every SPIN_MS: repaint only when the panel actually changed (frame, timers, content)
		const lines = renderProgress(progress.snapshot(), width(), totals);
		const key = lines.join("\n");
		if (key === lastWidget) return;
		lastWidget = key;
		ctx.ui.setWidget("br-progress", lines, { placement: "aboveEditor" } as any);
	};
	// step transitions go into the chat as they happen (one entry each; activity lines stay in the panel)
	const posted = new Map<number, string>();
	const postSteps = (s: ProgressSnapshot) => {
		if (!ctx.hasUI) return;
		s.steps.forEach((st, i) => {
			if (posted.get(i) === st.status) return;
			posted.set(i, st.status);
			// a migration run has one step per unit: only outcomes, not every start
			if (!s.plan.length && st.status === "running") return;
			pi.appendEntry<BrEntry>("br", { title: s.job ?? "job", text: stepEntry(st, s), colored: true });
		});
	};
	const unsub = progress.subscribe((s) => {
		postSteps(s);
		pending ??= setTimeout(paint, 150);
	});
	// fast while something runs (spinner), slow otherwise; elapsed timers move even when nothing is reported
	const tick = setInterval(() => (progress.running ? paint() : undefined), SPIN_MS);
	const orig = { log: console.log, error: console.error, warn: console.warn };
	const capture = (...a: unknown[]) => progress.log(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
	console.log = capture;
	console.error = capture;
	console.warn = capture;
	paint();
	void (async () => {
		let out: JobOutcome = {};
		try {
			out = await work();
		} catch (e: any) {
			out = { error: e instanceof StoppedError ? "stopped by the user" : (e?.message ?? String(e)) };
		} finally {
			Object.assign(console, orig);
			clearInterval(tick);
			progress.end(out.error);
			postSteps(progress.snapshot());
			unsub();
			paint();
		}
		const snap = progress.snapshot();
		const summary = [
			out.error ? `${job} stopped: ${out.error}` : `${job} finished in ${ELAPSED(Date.now() - (snap.startedAt ?? Date.now()))}, ${fmtUsage(snap, 3)}`,
			...snap.steps.map((x) => `${{ done: "✓", skipped: "–", failed: "✗", running: "▶" }[x.status]} ${x.name}${x.note ? `  ${x.note}` : ""}`),
			...(out.lines?.length ? ["", ...out.lines.map(plain)] : []),
		].join("\n");
		if (!ctx.hasUI) return orig.log(summary);
		ctx.ui.notify(out.error ? `bigrefactor: ${out.error}` : `bigrefactor: ${job} finished`, out.error ? "error" : "info");
		pi.sendMessage({ customType: "br", content: summary, display: true });
		setTimeout(() => !progress.running && ctx.ui.setWidget("br-progress", undefined), out.error ? 120_000 : 20_000);
		refreshStatus(ctx);
		await out.next?.().catch((e) => warn(ctx, String(e?.message ?? e)));
	})();
}

function startOnboarding(pi: ExtensionAPI, ctx: ExtensionContext, sub: string, flags: string[]): void {
	startJob(pi, ctx, sub === "resume" ? "onboarding (resume)" : "onboarding", async () => {
		const lines: string[] = [];
		const { onboard } = await import("../init/onboard.ts");
		// after the owner answered (and no next dialog follows within a moment), the chat says what runs now
		let resumeNote: NodeJS.Timeout | undefined;
		const hooks = {
			asking: () => clearTimeout(resumeNote),
			answered: () => {
				clearTimeout(resumeNote);
				resumeNote = setTimeout(() => {
					const s = progress.snapshot();
					const cur = [...s.steps].reverse().find((x) => x.status === "running");
					if (s.running && cur && ctx.hasUI) pi.appendEntry<BrEntry>("br", { title: s.job ?? "onboarding", text: `${pc.cyan("↳ answers received, working:")} ${pc.bold(cur.name)}${s.about[cur.name] ? pc.dim(` — ${s.about[cur.name]}`) : ""}`, colored: true });
				}, 1500);
			},
		};
		const r = await onboard({ root: ctx.cwd, args: ctx.hasUI ? flags : [...flags, "--yes"], prompter: piPrompter(ctx, lines, hooks), log: (l) => progress.log(l) }).finally(() => clearTimeout(resumeNote));
		if (!r.ok) return { error: r.steps.find((x) => x.status === "failed")?.note ?? "a step failed", lines: [...lines, "", "resume with /br resume (finished steps are skipped)"] };
		// Onboarding ends where migrating begins: offer the pilot right here instead of a terminal command.
		return {
			lines,
			next: async () => {
				if (!ctx.hasUI || r.openDecisions > 0) return;
				// A resume after the migration already began (e.g. Pi restarted mid-run) continues it: no first-run pilot offer.
				const ledger = openLedger(ctx.cwd);
				const units = ledger?.status().units ?? {};
				ledger?.close();
				const started = Object.entries(units).some(([state, n]) => state !== "planned" && n > 0);
				if (started) {
					const go = await ctx.ui.select(`Onboarding is done; the migration already started (${units.accepted ?? 0} accepted · ${units.quarantined ?? 0} quarantined · ${units.planned ?? 0} planned). Continue it?`, [
						"Continue the migration (accepted units are never redone; /br stop drains it)",
						"Not now (continue later with /br run)",
					]);
					if (go?.startsWith("Continue")) startRun(pi, ctx, []);
					return;
				}
				const go = await ctx.ui.select("Onboarding is done. Start migrating?", [
					"Pilot: migrate 10 units now (recommended first run)",
					"Migrate everything (runs until done; /br stop drains it)",
					"Not now (start later with /br run)",
				]);
				if (go?.startsWith("Pilot")) startRun(pi, ctx, ["--limit", "10"]);
				else if (go?.startsWith("Migrate everything")) startRun(pi, ctx, []);
			},
		};
	});
}

/** `/br run [--limit N] [--slice S] [--units a,b] [--dry]`: the migration scheduler as a background job. */
function startRun(pi: ExtensionAPI, ctx: ExtensionContext, flags: string[]): void {
	const flag = (n: string) => {
		const i = flags.indexOf(n);
		return i >= 0 ? flags[i + 1] : undefined;
	};
	const limit = flag("--limit") ? Number(flag("--limit")) : undefined;
	startJob(pi, ctx, limit ? `pilot run (${limit} units)` : "migration run", async () => {
		const cp = findConfigPath(ctx.cwd);
		if (!cp) return { error: "no bigrefactor.config.json here: run /br onboard first" };
		const { config, root } = loadConfig(cp);
		const { openDecisions } = await import("../inventory/decisions.ts");
		const { getSourceAdapter, getTargetAdapter } = await import("../adapters/registry.ts");
		const { runScheduler } = await import("../run/run.ts");
		const { OpenRouterClient } = await import("../models/openrouter.ts");
		const ledger = new Ledger(join(root, STATE_DIR, "ledger.sqlite"));
		let runDone = false;
		runActive = true;
		try {
			// Whole-target decisions refuse; every other open decision only blocks the units it affects and is
			// asked on the side (dialogs) while the run goes on. Answers release their units at the next loop.
			const { decisionGate, renderGate, liveBlocks } = await import("../run/decisions-gate.ts");
			const { applyDecision, decisionPrompt } = await import("../inventory/decisions.ts");
			const source = getSourceAdapter(config.source.stack);
			const targets = await Promise.all(config.target.stacks.map((s) => getTargetAdapter(s)));
			const g = decisionGate(ledger, config, source, targets, root);
			if (g.global.length && !flags.includes("--dry")) return { error: `${g.global.length} decision(s) change the whole target: answer them with /br decide first`, lines: g.global.map((d) => `· ${d.id}: ${d.question}`) };
			for (const l of renderGate(g)) progress.log(l);
			const blocked = liveBlocks(ledger, config, source, targets, root);
			const askOnTheSide = async () => {
				if (!ctx.hasUI) return;
				const asked = new Set<string>();
				for (;;) {
					const now = decisionGate(ledger, loadConfig(cp).config, source, targets, root);
					// blocking decisions first, biggest block first
					const next = [...now.scoped.sort((a, b) => b.units.length - a.units.length).map((x) => x.decision), ...now.free].find((d) => !asked.has(d.id));
					if (!next || progress.stopping) return;
					asked.add(next.id);
					const ui = piPrompter(ctx, []);
					const v = await ui.select(`decision while the run continues — ${decisionPrompt(next)}`, next.options.map((o) => ({ value: o.value, label: o.value === next.recommended ? `${o.label} (recommended)` : o.label, hint: o.hint })), next.recommended);
					if (v === undefined) {
						progress.log(`decision ${next.id} skipped: its units stay blocked (/br decide later)`);
						continue;
					}
					progress.log(`decided ${next.id} = ${v}  ${applyDecision(ledger, loadConfig(cp).config, root, next.id, v, "human (pi, during run)")}`);
				}
			};
			// Questions the resolver model could not settle (context.forOwner) come up as cards while the run goes on;
			// "Stop answering" ends the cards for this run (/br answer still works).
			const answerOnTheSide = async () => {
				if (!ctx.hasUI) return;
				const shown = new Set<number>();
				const done: string[] = [];
				// its own handle: a card still open when the run ends must still be able to save its answer
				const ledger = new Ledger(join(root, STATE_DIR, "ledger.sqlite"));
				try {
					while (!runDone && !progress.stopping) {
						const mine = ledger.openQuestions().filter((q) => !shown.has(q.id) && q.context && JSON.parse(q.context).forOwner !== undefined);
						const qs = groupQuestions(mine)[0];
						if (!qs) {
							await new Promise((r) => setTimeout(r, 5000));
							continue;
						}
						for (const q of qs) shown.add(q.id);
						const why = JSON.parse(qs[0]!.context!).forOwner as string;
						if ((await answerGroup(ctx, ledger, qs, `question while the run continues (${why})`, "human (pi, during run)", done)) === "quit") {
							progress.log("question cards off for this run: /br answer answers the rest");
							return;
						}
						for (const d of done.splice(0)) progress.log(`answered ${d}`);
					}
				} finally {
					ledger.close();
				}
			};
			if (!flags.includes("--dry"))
				void (async () => {
					await askOnTheSide().catch((e) => progress.log(`decision dialog failed: ${e?.message ?? e}`));
					await answerOnTheSide().catch((e) => progress.log(`question dialog failed: ${e?.message ?? e}`));
				})();
			// Scheduler lines → panel steps: "▶ <unit>" starts one, "✓ <unit> accepted" / "■ <unit>: …" / "✗ <unit>: …" end it.
			const log = (l: string) => {
				progress.log(l);
				const t = plain(l).trim();
				let m: RegExpExecArray | null;
				if ((m = /^▶ (\S+)/.exec(t))) progress.stepStart(m[1]!);
				else if ((m = /^✓ (\S+) accepted(.*)$/.exec(t))) progress.stepEnd(m[1]!, "done", m[2]!.trim());
				else if ((m = /^⏸ ([^:\s]+): (.*)$/.exec(t))) progress.stepEnd(m[1]!, "skipped", m[2]!);
				else if ((m = /^[■✗] ([^:\s]+): (.*)$/.exec(t))) progress.stepEnd(m[1]!, "failed", m[2]!);
			};
			const since = new Date().toISOString();
			const r = await runScheduler({ ledger, config, root, client: new OpenRouterClient(), limit, slice: flag("--slice"), units: flag("--units")?.split(","), dry: flags.includes("--dry"), force: flags.includes("--force"), log, onLanes: (l) => progress.setLanes(l), onWait: (w) => progress.wait(w), shouldStop: () => progress.stopping, handleSigint: false, blocked, waitForDecisions: ctx.hasUI });
			const questions = ledger.openQuestions().length;
			const own = ledger.ownDecisions(since).length;
			return { lines: [`${r.accepted} accepted · ${r.quarantined} quarantined · ${r.waiting} still planned · $${r.costUsd.toFixed(3)}`, ...(own ? [`${own} routine question(s) decided from your goals (br questions lists them; /br answer <id> <text> changes one)`] : []), ...(questions ? [`${questions} question(s) for you: /br answer`] : []), "continue with /br run (accepted units are never redone)"] };
		} finally {
			runDone = true;
			runActive = false;
			ledger.close();
		}
	});
}

/** Footer status: refreshed on session start and after every /br command, cleared when there is no ledger. */
function refreshStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const ledger = openLedger(ctx.cwd);
	if (!ledger) return ctx.ui.setStatus("bigrefactor", undefined);
	try {
		const l = locateLedger(ctx.cwd);
		ctx.ui.setStatus("bigrefactor", statusLine(ledger, "path" in l ? dirname(dirname(l.path)) : ctx.cwd));
	} finally {
		ledger.close();
	}
}

function truncate(text: string, more: string): string {
	const lines = text.split("\n");
	if (lines.length <= MAX_LINES) return text;
	return [...lines.slice(0, MAX_LINES), `… ${lines.length - MAX_LINES} more lines (${more})`].join("\n");
}

const PRESETS: Record<string, string> = {
	status: "status",
	unaccounted: "SELECT id, state, unit_id FROM symbols WHERE state NOT IN ('accepted','dropped','quarantined') ORDER BY path, name LIMIT 200",
	quarantine: "SELECT id, tier, attempts, cost_usd FROM units WHERE state = 'quarantined'",
	units: "SELECT id, tier, kind, state, attempts, round(cost_usd,4) cost FROM units ORDER BY tier, id",
	cost: "SELECT role, model, COUNT(*) calls, round(SUM(cost_usd),4) usd FROM attempts GROUP BY role, model",
	decisions: "SELECT point, COUNT(*) n, round(AVG(confidence),2) avg_conf FROM decisions GROUP BY point",
	questions: "SELECT id, unit_id, point, blocks, asked_by, question, options FROM questions WHERE status = 'open' ORDER BY id",
	// setup fixes on main during the run: what changed, what was put back (tests, migrated code), what the model said
	setup: "SELECT id, role, outcome, started_at, gate_report FROM attempts WHERE substr(role, 1, 10) = '__setup__:' ORDER BY id",
};

export default function (pi: ExtensionAPI) {
	// Pi draws the whole terminal: no command may write to it directly (see proc.ts outputCaptured)
	setOutputHost("ui");
	/** Human-facing output: a transcript entry outside the model's context, or the console without a UI. */
	const show = (ctx: ExtensionCommandContext, title: string, text: string) => {
		if (ctx.hasUI) pi.appendEntry<BrEntry>("br", { title, text });
		else console.log(text);
	};

	// Plain Text, not Markdown: symbol ids and role names carry underscores that Markdown would eat.
	pi.registerEntryRenderer<BrEntry>("br", (entry, _opts, theme) => {
		const d = entry.data;
		if (!d) return undefined;
		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(theme.fg("accent", `[br ${d.title}]`), 0, 0));
		box.addChild(new Text(d.colored ? d.text : theme.fg("customMessageText", d.text), 0, 0));
		return box;
	});

	pi.registerCommand("br", {
		description: "bigrefactor: init | status | forecast | lanes | push | why <id|path> | unaccounted | questions | answer [<id> <text>]",
		getArgumentCompletions: (prefix) => {
			if (/\s/.test(prefix)) return null;
			const items = Object.entries(SUBCOMMANDS)
				.filter(([name]) => name.startsWith(prefix))
				.map(([name, description]) => ({ value: name, label: name, description }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const [sub = "status", ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
			if (sub === "check") {
				const { checkRequirements, renderRequirements } = await import("../requirements.ts");
				show(ctx, "check", renderRequirements(await checkRequirements({ cwd: ctx.cwd, tools: pi.getAllTools().map((t) => t.name) }), { color: false }));
				return;
			}
			if (sub === "lanes") {
				const p = findConfigPath(ctx.cwd);
				if (!p) return warn(ctx, "no bigrefactor.config.json here");
				try {
					show(ctx, "lanes", lanes(p, parseLanesArgs(rest)));
				} catch (e: any) {
					warn(ctx, `lanes: ${e?.message ?? e}`);
				}
				return;
			}
			if (sub === "push") {
				const p = findConfigPath(ctx.cwd);
				if (!p) return warn(ctx, "no bigrefactor.config.json here");
				try {
					const { pushSetting } = await import("../run/push.ts");
					show(ctx, "push", pushSetting(p, rest));
				} catch (e: any) {
					warn(ctx, `push: ${e?.message ?? e}`);
				}
				return;
			}
			if (sub === "stop") {
				if (!progress.running) return warn(ctx, "nothing is running");
				// a run drains (running units finish) unless already draining; onboarding aborts its model step
				await progress.stop(/run/.test(progress.snapshot().job ?? "") ? "drain" : "abort");
				return;
			}
			if (sub === "run") {
				if (!ctx.hasUI) return warn(ctx, "use `br run` in a terminal outside the Pi TUI");
				return startRun(pi, ctx, rest);
			}
			if (sub === "recheck") {
				const i = rest.indexOf("--limit");
				return startJob(pi, ctx, "recheck of accepted units", async () => {
					const cp = findConfigPath(ctx.cwd);
					if (!cp) return { error: "no bigrefactor.config.json here" };
					const { config, root } = loadConfig(cp);
					const { recheckAccepted } = await import("../run/recheck.ts");
					const ledger = new Ledger(join(root, STATE_DIR, "ledger.sqlite"));
					try {
						const r = await recheckAccepted({ ledger, config, root, limit: i >= 0 ? Number(rest[i + 1]) : undefined, again: rest.includes("--again"), log: (l) => progress.log(l) });
						return { lines: [`${r.checked} checked · ${r.reopened.length} back to planned (code kept)${r.notJudged ? ` · ${r.notJudged} not judged` : ""}`, "continue with /br run"] };
					} finally {
						ledger.close();
					}
				});
			}
			if (sub === "progress") {
				const snap = progress.snapshot();
				if (!snap.startedAt) return warn(ctx, "no onboarding has run in this Pi session");
				const now = Date.now();
				const costs = Object.entries(snap.costByLabel).sort((a, b) => b[1] - a[1]);
				show(ctx, "progress", [
					...renderProgress(snap, 200).map(plain),
					...(snap.agents.length ? ["", `agents running (${snap.agents.length}):`, ...snap.agents.map((a) => plain(agentLine(a, now, 200)))] : []),
					...(costs.length ? ["", `cost per unit this job ($${snap.costUsd.toFixed(3)} total):`, ...costs.slice(0, 40).map(([k, v]) => `  ${v.toFixed(4).padStart(8)}  ${k}`)] : []),
					"",
					"activity:",
					...snap.activity.slice(-80),
				].join("\n"));
				return;
			}
			if (sub === "init" || sub === "start" || sub === "resume" || sub === "onboard") {
				if (rest.includes("--config-only")) {
					const lines: string[] = [];
					const flags = rest.filter((a) => a !== "--config-only");
					const { init } = await import("../init/init.ts");
					try {
						lines.push(`config ready: ${await init(ctx.hasUI ? flags : [...flags, "--yes"], { root: ctx.cwd, prompter: piPrompter(ctx, lines) })}`);
					} catch (e: any) {
						lines.push(`init failed: ${e?.message ?? e}`);
					}
					show(ctx, sub, lines.join("\n"));
					refreshStatus(ctx);
					return;
				}
				if (ctx.hasUI) return startOnboarding(pi, ctx, sub, rest);
				// Print/json mode: no widget, nothing to chat with meanwhile; run to completion and print.
				const { onboard } = await import("../init/onboard.ts");
				const lines: string[] = [];
				progress.begin("onboarding");
				try {
					const r = await onboard({ root: ctx.cwd, args: [...rest, "--yes"], prompter: piPrompter(ctx, lines), log: (l) => console.log(plain(l)) });
					if (!r.ok) console.log("(stopped; fix the cause and run /br resume — finished steps are skipped)");
				} finally {
					progress.end();
				}
				if (lines.length) console.log(lines.map(plain).join("\n"));
				return;
			}
			if (sub === "decide" || sub === "frameworks" || sub === "order" || sub === "rule") {
				const lines: string[] = [];
				try {
					const { loadConfig } = await import("../config.ts");
					const { findConfigPath } = await import("../config.ts");
					const cp = findConfigPath(ctx.cwd);
					if (!cp) return warn(ctx, "no bigrefactor.config.json here: run /br onboard first");
					const { config, root } = loadConfig(cp);
					process.env["BR_WORKSPACE"] = root;
					const { getSourceAdapter, getTargetAdapter, registerGeneratedTargets } = await import("../adapters/registry.ts");
					registerGeneratedTargets(root);
					const source = getSourceAdapter(config.source.stack);
					source.frameworkDirs?.(config.source.path);
					const targets = await Promise.all(config.target.stacks.map((s) => getTargetAdapter(s)));
					const ledger = new Ledger(join(root, ".bigrefactor", "ledger.sqlite"));
					try {
						if (sub === "rule") {
							const { ownerRule, layoutPreview } = await import("../rules/owner-layout.ts");
							const { loadLayoutRules } = await import("../rules/layout-rules.ts");
							const { projectDir } = await import("../init/init.ts");
							const ui = piPrompter(ctx, lines);
							// "nestjs: …" names the stack; one stack needs no name; otherwise ask
							const named = /^([\w-]+):\s*/.exec(rest.join(" "));
							const words = (named && targets.some((t) => t.id === named[1]) ? rest.join(" ").slice(named[0].length) : rest.join(" ")).trim().replace(/^["']|["']$/g, "");
							let stack = named && targets.some((t) => t.id === named[1]) ? named[1]! : targets.length === 1 ? targets[0]!.id : undefined;
							if (!words) {
								for (const t of targets) lines.push(`${t.id}:\n${(() => { const r = loadLayoutRules(root, t.id); return r ? layoutPreview(r) : "  no layout decided yet (built-in checks)"; })()}`);
							} else {
								stack ??= ctx.hasUI ? await ui.select("Which project should the rule apply to?", targets.map((t) => ({ value: t.id, label: t.id }))) : undefined;
								const t = targets.find((x) => x.id === stack);
								if (!t) lines.push("nothing changed (name the stack: rule <stack>: <words>)");
								else {
									const { OpenRouterClient } = await import("../models/openrouter.ts");
									lines.push(await ownerRule({ root, stack: t.id, adapter: t, words, ui, client: new OpenRouterClient(), model: config.models.escalate.id, projectDir: projectDir(config, t.id), ledger }));
								}
							}
						} else if (sub === "frameworks") {
							const { planFrameworks, renderFrameworkPlan } = await import("../inventory/frameworks.ts");
							const { loadDecisions } = await import("../inventory/decisions.ts");
							lines.push(renderFrameworkPlan(planFrameworks(ledger, source, targets, config.source.path, loadDecisions(root), config.target.choices)));
						} else if (sub === "order") {
							const { planSlices, applySlicePlan, renderSlicePlan } = await import("../inventory/slices.ts");
							const sp = join(root, ".bigrefactor", "slices.json");
							const plan = planSlices(ledger, existsSync(sp) ? JSON.parse(readFileSync(sp, "utf8")) : {});
							applySlicePlan(ledger, plan);
							lines.push(renderSlicePlan(plan));
						} else {
							const { openDecisions, applyDecision, renderDecisions, decisionPrompt } = await import("../inventory/decisions.ts");
							for (const a of rest) {
								const eq = a.indexOf("=");
								if (eq > 0) lines.push(`decided ${a.slice(0, eq)} = ${a.slice(eq + 1)}  ${applyDecision(ledger, config, root, a.slice(0, eq), a.slice(eq + 1), "human (pi)")}`);
							}
							const ds = openDecisions(ledger, loadConfig(cp).config, source, targets, root);
							if (ctx.hasUI) {
								const ui = piPrompter(ctx, lines);
								for (const d of ds) {
									const v = await ui.select(decisionPrompt(d), d.options.map((o) => ({ value: o.value, label: o.label, hint: o.hint })), d.recommended);
									if (v === undefined) break;
									lines.push(`decided ${d.id} = ${v}  ${applyDecision(ledger, config, root, d.id, v, "human (pi)")}`);
								}
								lines.push(renderDecisions(openDecisions(ledger, loadConfig(cp).config, source, targets, root)));
							} else lines.push(renderDecisions(ds));
						}
					} finally {
						ledger.close();
					}
				} catch (e: any) {
					lines.push(`${sub} failed: ${e?.message ?? e}`);
				}
				show(ctx, sub, lines.join("\n"));
				refreshStatus(ctx);
				return;
			}
			if (!(sub in SUBCOMMANDS)) return warn(ctx, `unknown subcommand "${sub}"; try ${Object.keys(SUBCOMMANDS).join(" | ")}`);
			const located = locateLedger(ctx.cwd);
			if ("missing" in located) return warn(ctx, located.missing);
			const ledger = new Ledger(located.path);
			try {
				// Interactive: one dialog per decision; questions that ask the same decision (groupQuestions) share one answer,
				// each stored as that question's own option. A group with differing texts lists its members and can be split.
				if (sub === "answer" && ctx.hasUI && !rest.length) {
					const done: string[] = [];
					// many questions: a model sums them up; the recommended answers can be taken in one go
					const all = ledger.openQuestions();
					if (all.length >= 3) {
						const { config } = loadConfig(findConfigPath(ctx.cwd)!);
						const { summarizeQuestions } = await import("../jev/ask.ts");
						const { OpenRouterClient } = await import("../models/openrouter.ts");
						const s = await summarizeQuestions({ config, client: process.env["BR_NO_LLM"] ? undefined : new OpenRouterClient() }, all);
						// questions the resolver model handed to the owner (context.forOwner) are never taken in bulk
						const easy = all.filter((q) => !s.lookAt.includes(q.id) && JSON.parse(q.context ?? "{}").forOwner === undefined);
						const ACCEPT = "accept", EACH = "each";
						const v = await askCard(ctx, {
							message: `${all.length} open questions${all.length > easy.length ? ` · ${all.length - easy.length} need you` : ""}\n${s.summary.join("\n")}`,
							recommended: easy.length ? ACCEPT : EACH,
							options: [
								...(easy.length ? [{ value: ACCEPT, label: `Take the recommended answer for ${easy.length}`, description: all.length > easy.length ? `then go through the ${all.length - easy.length} that need you` : "nothing left to answer after that" }] : []),
								{ value: EACH, label: "Go through them one by one" },
							],
						});
						if (v === undefined) return show(ctx, sub, "nothing answered");
						if (v === ACCEPT) {
							for (const q of easy) {
								const r = (JSON.parse(q.context ?? "{}") as { recommended?: string }).recommended;
								if (r) ledger.answerQuestion(q.id, optionFor(q, r), "human (pi, accepted the summary)");
							}
							done.push(`${easy.length} recommended answers taken: ${s.summary.slice(0, 3).join("; ")}`);
						}
					}
					const groups = groupQuestions(ledger.openQuestions());
					if (!groups.length) return show(ctx, sub, done.length ? `answered:\n${done.join("\n")}\nno open questions left` : "no open questions");
					for (const [i, qs] of groups.entries()) if ((await answerGroup(ctx, ledger, qs, `question ${i + 1}/${groups.length}`, "human (pi)", done)) === "quit") break;
					const left = ledger.openQuestions().length;
					show(ctx, sub, [done.length ? `answered:\n${done.join("\n")}` : "nothing answered", left ? `${left} still open: /br answer again` : "no open questions left", "a running migration picks the answers up at its next loop"].join("\n"));
					return;
				}
				let text: string;
				if (sub === "why") text = renderWhy(ledger, rest.join(" "), { color: false });
				else if (sub === "questions") {
					const qs = ledger.openQuestions();
					const blocked = ledger.blockedUnits();
					text = qs.length
						? qs.map((q) => `#${q.id} [${q.point}] ${q.question}${q.options ? `  (${(JSON.parse(q.options) as string[]).join(" | ")})` : ""}  waiting: ${[...blocked.entries()].filter(([, ids]) => ids.includes(q.id)).map(([u]) => u).join(", ") || "nothing"}`).join("\n") + "\n\n/br answer walks you through them (or /br answer <id> <text>)"
						: "no open questions";
				} else if (sub === "answer") {
					const [id, ...answer] = rest;
					if (!id || !answer.length) text = "usage: /br answer (guided) or /br answer <id> <text>";
					else {
						ledger.answerQuestion(Number(id), answer.join(" "), "human (pi)");
						text = `answered #${id}`;
					}
				} else if (sub === "requeue") {
					if (!rest.length) text = "usage: /br requeue <unit-id...> | --all";
					else {
						const { requeueUnits } = await import("../run/run.ts");
						const { config, root } = loadConfig(findConfigPath(ctx.cwd)!);
						text = requeueUnits(ledger, config, root, rest.includes("--all") ? "all" : rest.filter((a) => !a.startsWith("--")), "human (pi)").join("\n");
					}
				} else if (sub === "unaccounted") {
					const rows = ledger.unaccounted();
					text = rows.length ? truncate(rows.map((r) => `${r.state.padEnd(12)} ${r.id}`).join("\n"), "full list: `br status` in a terminal, or ask for ledger_query preset=unaccounted") : "all symbols accounted";
				} else if (sub === "forecast") text = renderForecast(forecast(ledger));
				else if (sub === "layout") {
					const { checkLayout, renderLayout } = await import("../run/layout-check.ts");
					const { config, root } = loadConfig(findConfigPath(ctx.cwd)!);
					text = await checkLayout(config, root, ledger).then((r) => renderLayout(r).join("\n"), (e) => `layout check failed: ${e?.message ?? e}`);
				}
				else text = renderStatus(ledger, { color: false });
				show(ctx, sub, text);
			} finally {
				ledger.close();
			}
			refreshStatus(ctx);
		},
	});

	pi.registerTool({
		name: "ledger_query",
		label: "Ledger query",
		description:
			"Read-only access to the bigrefactor migration ledger. `preset` is one of: status, unaccounted, quarantine, units, cost, decisions, questions, setup. Or pass a read-only `sql` SELECT. Use `why` with a symbol id or file path for its full history.",
		promptSnippet: "Query the migration ledger (status, unaccounted symbols, why a file is in its state).",
		parameters: Type.Object({
			preset: Type.Optional(Type.String({ description: "status | unaccounted | quarantine | units | cost | decisions | questions | setup" })),
			sql: Type.Optional(Type.String({ description: "A single read-only SELECT statement" })),
			why: Type.Optional(Type.String({ description: "Symbol id or file path to explain" })),
		}),
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
		execute: async (_id, params, _signal, _onUpdate, ctx) => {
			const located = locateLedger(ctx.cwd);
			if ("missing" in located) return { content: [{ type: "text", text: located.missing }], details: {}, isError: true };
			const ledger = new Ledger(located.path);
			try {
				if (params.why) return { content: [{ type: "text", text: renderWhy(ledger, params.why, { color: false }) }], details: {} };
				const sql = params.sql ?? PRESETS[params.preset ?? "status"];
				if (!sql) return { content: [{ type: "text", text: `unknown preset ${params.preset}` }], details: {}, isError: true };
				if (sql === "status") return { content: [{ type: "text", text: renderStatus(ledger, { color: false }) }], details: {} };
				if (!/^\s*select\b/i.test(sql) || /;\s*\S/.test(sql)) return { content: [{ type: "text", text: "only a single SELECT is allowed" }], details: {}, isError: true };
				const rows = ledger.db.prepare(sql).all();
				return { content: [{ type: "text", text: JSON.stringify(rows.slice(0, 200), null, 1) }], details: { rows: rows.length } };
			} catch (e: any) {
				return { content: [{ type: "text", text: `ledger error: ${e?.message ?? e}` }], details: {}, isError: true };
			} finally {
				ledger.close();
			}
		},
	});

	pi.registerTool({
		name: "br_progress",
		label: "bigrefactor progress",
		description: "What the bigrefactor onboarding running in this Pi session is doing right now: steps done/running/pending, the current model session (tool calls, blocked calls, cost) and the recent activity log. Use it whenever the user asks what is happening, why it is slow, or whether it is stuck. Pass stop=true only when the user explicitly asks to stop it.",
		promptSnippet: "Check what the running bigrefactor onboarding is doing (or stop it on request).",
		parameters: Type.Object({
			lines: Type.Optional(Type.Number({ description: "How many recent activity lines (default 40)" })),
			stop: Type.Optional(Type.Boolean({ description: "Stop the running onboarding (only on explicit user request)" })),
		}),
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
		execute: async (_id, params) => {
			if (params.stop) await progress.stop();
			const snap = progress.snapshot();
			if (!snap.startedAt) return { content: [{ type: "text", text: "no onboarding has run in this Pi session (start it with /br onboard)" }], details: { running: false } };
			const text = [...renderProgress(snap, 200).map(plain), "", "recent activity:", ...snap.activity.slice(-(params.lines ?? 40))].join("\n");
			return { content: [{ type: "text", text }], details: { running: snap.running } };
		},
	});

	pi.registerTool({
		name: "br_init",
		label: "bigrefactor init",
		description:
			"Create a bigrefactor migration workspace in the current directory (writes bigrefactor.config.json). The source stack is auto-detected; pass `stack` only when detection is ambiguous. Flow: (1) call with dryRun=true; the result has `ask`: questions pre-shaped for the `ask_user_question` tool (≤4 per call), each with a `values` map from option label to the exact string to pass back. (2) Ask the user with `ask_user_question` (in chat if that tool is missing): first `ask.gate`; only if they pick \"decide each\" the `ask.stack` batches; then the `ask.libraries` batches. (3) Call again with acceptDefaults=true or `choices` (the chosen values strings, \"<stack>.<key>=<option>\"), plus `replacements` (\"<legacy package>=<answer>\"; a typed free-text answer is the package name; \"=later\" entries are ignored). A real run without acceptDefaults or choices writes nothing and returns the questions. Never invent decisions the user did not make. Next steps after a real run happen in a terminal: `br setup`, `br inventory`.",
		promptSnippet: "Set up a migration workspace (source repo → target stacks) when the user wants to start migrating a codebase.",
		parameters: Type.Object({
			source: Type.String({ description: "Path to the legacy repo (relative to the cwd or absolute)" }),
			target: Type.String({ description: "Path for the new codebase, e.g. ./migrated" }),
			to: Type.Array(Type.String(), { description: "Target adapter ids: one server stack, optionally one ui stack (br init lists the known ones)" }),
			stack: Type.Optional(Type.String({ description: "Source stack id; omit to auto-detect" })),
			db: Type.Optional(Type.String({ description: "keep-schema (default) | new-schema | none" })),
			docs: Type.Optional(Type.Boolean({ description: "Fetch official docs for every technology (default true, needs network)" })),
			force: Type.Optional(Type.Boolean({ description: "Overwrite an existing bigrefactor.config.json" })),
			dryRun: Type.Optional(Type.Boolean({ description: "Write nothing; return the stack and library questions shaped for ask_user_question" })),
			acceptDefaults: Type.Optional(Type.Boolean({ description: "The user accepted the adapter defaults for now (the ask.gate answer); br advise judges them from the repo later" })),
			choices: Type.Optional(Type.Array(Type.String(), { description: "Stack decisions as \"<stack>.<key>=<option>\" strings, keys and options as the target adapters list them; unspecified keys take the default" })),
			replacements: Type.Optional(Type.Array(Type.String(), { description: "Legacy library decisions as \"<legacy package>=<answer>\"; answer = a package of the target ecosystem | platform | drop | port | later" })),
		}),
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		execute: async (_id, params, _signal, _onUpdate, ctx) => {
			const { init } = await import("../init/init.ts");
			const questions = async () => {
				const { stackQuestions, askUserQuestionBatches } = await import("../init/stack.ts");
				const { getSourceAdapter, getTargetAdapter, knownSources } = await import("../adapters/registry.ts");
				const { loadDecisions } = await import("../inventory/decisions.ts");
				const { resolve } = await import("node:path");
				const sourceRoot = resolve(ctx.cwd, params.source);
				let stackId = params.stack;
				if (!stackId) {
					const guesses = await Promise.all(knownSources().map(async (id) => ({ id, ...(await getSourceAdapter(id).detect(sourceRoot)) })));
					const best = guesses.sort((a, b) => b.confidence - a.confidence)[0];
					stackId = best && best.confidence > 0 ? best.id : undefined;
				}
				if (!stackId) return { error: `no source stack detected in ${params.source}: bigrefactor cannot read this language yet (br source-adapter has a model write the reader)` };
				const targets = await Promise.all(params.to.map((id) => getTargetAdapter(id)));
				const q = stackQuestions(getSourceAdapter(stackId), sourceRoot, targets, {}, loadDecisions(ctx.cwd).libraries);
				return { sourceStack: stackId, ask: askUserQuestionBatches(q, targets) };
			};
			const text = (t: string, isError = false, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: t }], details, isError });
			if (params.dryRun || (!params.acceptDefaults && !params.choices?.length)) {
				const q = await questions();
				if ("error" in q) return text(q.error!, true);
				if (params.dryRun) return text(JSON.stringify(q, null, 1), false, { dryRun: true });
				// Models tend to skip the dry run: refuse to write defaults nobody agreed to.
				return text(`DECISIONS REQUIRED: nothing was written. Ask the user these questions with ask_user_question, then call br_init again with acceptDefaults=true or choices, plus replacements.\n${JSON.stringify(q, null, 1)}`, true, { refused: true });
			}
			const args = ["--yes", "--source", params.source, "--target", params.target, "--to", params.to.join(",")];
			if (params.choices?.length) args.push("--choose", params.choices.join(","));
			const replacements = (params.replacements ?? []).filter((r) => !/=\s*later\s*$/i.test(r));
			if (replacements.length) args.push("--replace", replacements.join(","));
			if (params.stack) args.push("--stack", params.stack);
			if (params.db) args.push("--db", params.db);
			if (params.docs === false) args.push("--no-docs");
			if (params.force) args.push("--force");
			const lines: string[] = [];
			try {
				const path = await init(args, { root: ctx.cwd, prompter: piPrompter(ctx, lines) });
				lines.push(`config written: ${path}. Next (terminal): br setup → br inventory → br simulate --level 1.`);
				return { content: [{ type: "text", text: lines.join("\n") }], details: { path } };
			} catch (e: any) {
				lines.push(`init failed: ${e?.message ?? e}`);
				return { content: [{ type: "text", text: lines.join("\n") }], details: {}, isError: true };
			}
		},
	});

	// Keep the ledger in view: a one-line footer status, refreshed when a session starts.
	pi.on("session_start", async (_e, ctx) => {
		refreshStatus(ctx);
		// what this plugin needs (other Pi packages, logins, the stacks' tools): say at startup what is missing
		void import("../requirements.ts")
			.then(async ({ checkRequirements, requirementsNotice }) => {
				const notice = requirementsNotice(await checkRequirements({ cwd: ctx.cwd, tools: pi.getAllTools().map((t) => t.name) }));
				if (notice) warn(ctx, notice);
			})
			.catch(() => undefined);
	});
}
