/**
 * Live progress of a long-running job (onboarding today, `br run` later), stack-neutral and UI-free.
 * Producers (onboard steps, leaf sessions, console output of the steps) report into one process-wide
 * tracker; a UI (the Pi widget, a CLI spinner, the `br_progress` tool) subscribes and renders it.
 * `stop()` aborts the running model sessions and makes the next step boundary throw, so a stop is
 * clean and resumable (finished steps are skipped on resume).
 */
export interface StepState {
	name: string;
	status: "running" | "done" | "skipped" | "failed";
	note?: string;
	startedAt: number;
	endedAt?: number;
}

export interface ProgressSnapshot {
	job?: string;
	/** Planned step names in order (steps not started yet render as pending). */
	plan: string[];
	/** Step name → one-line explanation. */
	about: Record<string, string>;
	running: boolean;
	stopping: boolean;
	startedAt?: number;
	steps: StepState[];
	/** Recent activity, newest last (model tool calls, step output). */
	activity: string[];
	/** Most recently started model session (kept for single-session jobs like onboarding). */
	session?: AgentState;
	/** Every live model session, one per agent (unit × role in a run). */
	agents: AgentState[];
	/** Scheduler lanes (runs only): running/max, ready units, and why nothing new starts. */
	lanes?: { running: number; max: number; ready: number; ahead: number; reason?: string };
	/** Cost per unit/job label, accumulated over finished and live sessions. */
	costByLabel: Record<string, number>;
	costUsd: number;
	/** Codex (subscription) calls at list price: not spent, shown so their size is visible. */
	codexUsd: number;
	tokensIn: number;
	tokensOut: number;
	error?: string;
}

/** Usage of one model call or a sum of them: paid dollars, Codex list price (not paid), tokens. */
export interface UsageTally {
	costUsd: number;
	codexUsd: number;
	tokensIn: number;
	tokensOut: number;
}

export interface AgentState {
	id: number;
	/** What the agent works on, e.g. a unit id or "__init__". */
	label: string;
	role: string;
	model?: string;
	toolCalls: number;
	blocked: number;
	costUsd: number;
	codexUsd: number;
	tokensIn: number;
	tokensOut: number;
	lastTool?: string;
	since: number;
}

type Abortable = { abort(): Promise<void> | void };
const MAX_ACTIVITY = 200;

class ProgressTracker {
	private s: ProgressSnapshot = { plan: [], about: {}, running: false, stopping: false, steps: [], activity: [], agents: [], costByLabel: {}, costUsd: 0, codexUsd: 0, tokensIn: 0, tokensOut: 0 };
	private listeners = new Set<(s: ProgressSnapshot) => void>();
	private sessions = new Map<number, Abortable>();
	private nextId = 1;

	snapshot(): ProgressSnapshot {
		return structuredClone(this.s);
	}
	subscribe(fn: (s: ProgressSnapshot) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}
	private emit() {
		for (const fn of this.listeners) {
			try {
				fn(this.s);
			} catch {
				/* a broken listener must not break the job */
			}
		}
	}

	begin(job: string) {
		this.abortingNow = false;
		this.s = { job, plan: [], about: {}, running: true, stopping: false, startedAt: Date.now(), steps: [], activity: [], agents: [], costByLabel: {}, costUsd: 0, codexUsd: 0, tokensIn: 0, tokensOut: 0 };
		this.emit();
	}
	setLanes(l: NonNullable<ProgressSnapshot["lanes"]>) {
		const a = this.s.lanes;
		if (a && a.running === l.running && a.max === l.max && a.ready === l.ready && a.ahead === l.ahead && a.reason === l.reason) return;
		this.s.lanes = l;
		if (l.reason && l.reason !== a?.reason) this.log(`⏳ ${l.reason}`);
		this.emit();
	}
	plan(about: Record<string, string>) {
		this.s.plan = Object.keys(about);
		this.s.about = { ...about };
		this.emit();
	}
	end(error?: string) {
		this.abortingNow = false;
		this.s.running = false;
		this.s.stopping = false;
		this.s.session = undefined;
		this.s.agents = [];
		if (error) this.s.error = error;
		this.emit();
	}
	get running() {
		return this.s.running;
	}
	get stopping() {
		return this.s.stopping;
	}

	stepStart(name: string) {
		this.s.steps.push({ name, status: "running", startedAt: Date.now() });
		this.emit();
	}
	stepEnd(name: string, status: StepState["status"], note?: string) {
		const st = [...this.s.steps].reverse().find((x) => x.name === name && x.status === "running") ?? this.s.steps.find((x) => x.name === name);
		if (st) Object.assign(st, { status, note, endedAt: Date.now() });
		else this.s.steps.push({ name, status, note, startedAt: Date.now(), endedAt: Date.now() });
		this.emit();
	}

	log(line: string) {
		const clean = line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
		if (!clean.trim()) return;
		for (const l of clean.split("\n")) this.s.activity.push(l);
		if (this.s.activity.length > MAX_ACTIVITY) this.s.activity.splice(0, this.s.activity.length - MAX_ACTIVITY);
		this.emit();
	}

	/** A model session starts; returns its agent id for the calls below. */
	agentStart(label: string, role: string, model: string | undefined): number {
		const a: AgentState = { id: this.nextId++, label, role, model, toolCalls: 0, blocked: 0, costUsd: 0, codexUsd: 0, tokensIn: 0, tokensOut: 0, since: Date.now() };
		this.s.agents.push(a);
		this.s.session = a;
		this.emit();
		return a.id;
	}
	/** Register how to abort the agent's session once it exists. */
	agentAbortable(id: number, handle: Abortable) {
		this.sessions.set(id, handle);
	}
	private agent(id: number) {
		return this.s.agents.find((a) => a.id === id);
	}
	agentTool(id: number, toolName: string, detail: string, blocked?: string) {
		const a = this.agent(id);
		if (a) {
			a.toolCalls++;
			if (blocked) a.blocked++;
			a.lastTool = `${toolName} ${detail}`.slice(0, 160);
		}
		const who = a && this.s.agents.length > 1 ? `${short(a.label)} ${a.role} ` : "";
		this.log(blocked ? `  ⛔ ${who}${toolName} blocked: ${blocked}` : `  · ${who}${toolName} ${detail}`.slice(0, 200));
	}
	/** One assistant message of a model session. */
	agentUsage(id: number, u: UsageTally) {
		const a = this.agent(id);
		if (a) {
			addTally(a, u);
			this.s.costByLabel[a.label] = (this.s.costByLabel[a.label] ?? 0) + u.costUsd;
		}
		this.callUsage(u);
	}
	/** One direct model call (chat, decision) or a session message: counted in the job totals. */
	callUsage(u: UsageTally) {
		addTally(this.s, u);
		this.emit();
	}
	/** Job totals so far; `usageSince(tally())` gives what a stretch of work used. */
	tally(): UsageTally {
		return { costUsd: this.s.costUsd, codexUsd: this.s.codexUsd, tokensIn: this.s.tokensIn, tokensOut: this.s.tokensOut };
	}
	usageSince(before: UsageTally): string {
		const n = this.tally();
		return fmtUsage({ costUsd: n.costUsd - before.costUsd, codexUsd: n.codexUsd - before.codexUsd, tokensIn: n.tokensIn - before.tokensIn, tokensOut: n.tokensOut - before.tokensOut });
	}
	agentEnd(id: number) {
		this.sessions.delete(id);
		this.s.agents = this.s.agents.filter((a) => a.id !== id);
		this.s.session = this.s.agents[this.s.agents.length - 1];
		this.emit();
	}

	private abortingNow = false;
	/** True once live model sessions are being aborted (a drain lets them finish). */
	get aborting() {
		return this.abortingNow;
	}
	/**
	 * Stop the job. "abort": abort live model sessions; the next step boundary throws StoppedError.
	 * "drain": start nothing new, let running work finish (a migration run's units); a second stop aborts.
	 */
	async stop(mode: "abort" | "drain" = "abort"): Promise<void> {
		if (!this.s.running) return;
		if (mode === "drain" && !this.s.stopping) {
			this.s.stopping = true;
			this.log("■ stop requested: running units finish, no new ones start (stop again to abort them)");
			this.emit();
			return;
		}
		this.s.stopping = true;
		this.abortingNow = true;
		this.log("■ stop requested: aborting the running model session");
		this.emit();
		await Promise.all([...this.sessions.values()].map(async (h) => {
			try {
				await h.abort();
			} catch {
				/* already gone */
			}
		}));
	}
	/** Called at step boundaries by producers. */
	checkStopped() {
		if (this.s.stopping) throw new StoppedError();
	}
}

export class StoppedError extends Error {
	constructor() {
		super("stopped by the user");
	}
}

export const progress = new ProgressTracker();

function addTally(t: UsageTally, u: UsageTally) {
	t.costUsd += u.costUsd;
	t.codexUsd += u.codexUsd;
	t.tokensIn += u.tokensIn;
	t.tokensOut += u.tokensOut;
}

/** 950 → "950", 12345 → "12.3k", 4200000 → "4.2M" */
export function fmtTokens(n: number): string {
	return n < 1000 ? String(Math.round(n)) : n < 1e6 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1e6).toFixed(1)}M`;
}

/** "$0.0123 · codex ≈$0.0410 · 12.3k in / 1.2k out" (the Codex part only when Codex served something). */
export function fmtUsage(u: UsageTally, digits = 4): string {
	const codex = u.codexUsd > 0 ? ` · codex ≈$${u.codexUsd.toFixed(digits)}` : "";
	const tokens = u.tokensIn || u.tokensOut ? ` · ${fmtTokens(u.tokensIn)} in / ${fmtTokens(u.tokensOut)} out` : "";
	return `$${u.costUsd.toFixed(digits)}${codex}${tokens}`;
}

/** One-line summary of a tool call's arguments for the activity feed. */
export function describeArgs(input: Record<string, unknown>): string {
	const v = input["command"] ?? input["path"] ?? input["pattern"] ?? input["query"] ?? "";
	return String(v).replace(/\s+/g, " ").slice(0, 120);
}

/** Unit ids get long ("U004_interfaces_iactionwithtooltip_cls"): keep the number and a bit of the name. */
export function short(label: string, n = 22): string {
	return label.length <= n ? label : label.slice(0, n - 1) + "…";
}
