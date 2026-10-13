import { appendFileSync, closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Every dollar the workspace spends, from every model call: direct API calls (Jev decisions, structured
 * chats in onboarding, advise, label, triage) and agent sessions (testers, implementers, rules, profile).
 * Append-only `.bigrefactor/spend.jsonl`, written at the two places all model traffic passes through, so
 * the total survives runs, restarts and onboarding reruns.
 */
export interface SpendEntry {
	at: string;
	usd: number;
	source: string;
	model?: string;
	/** Served by a subscription (Codex): the OpenRouter value of the call, not money paid. */
	subscription?: boolean;
}

/** The workspace this process works on: BR_WORKSPACE, else the cwd when it holds a bigrefactor config. */
export function workspaceRoot(): string | undefined {
	const env = process.env["BR_WORKSPACE"];
	if (env && existsSync(join(env, ".bigrefactor"))) return env;
	const cwd = process.cwd();
	return existsSync(join(cwd, "bigrefactor.config.json")) && existsSync(join(cwd, ".bigrefactor")) ? cwd : undefined;
}

const file = (root: string) => join(root, ".bigrefactor", "spend.jsonl");

export function recordSpend(usd: number, source: string, model?: string, o: { subscription?: boolean; root?: string } = {}): void {
	const root = o.root ?? workspaceRoot();
	if (!root || !(usd > 0)) return;
	try {
		appendFileSync(file(root), JSON.stringify({ at: new Date().toISOString(), usd, source, model, ...(o.subscription ? { subscription: true } : {}) } satisfies SpendEntry) + "\n");
	} catch {
		/* spend tracking must never break a model call */
	}
}

/** What the spend log held when last read: only lines added since are read again (the log grows to many MB). */
type SpendTally = { size: number; tail: string; usd: number; bySource: Record<string, number>; since?: string; paid: Array<[at: string, usd: number]> };
const tallies = new Map<string, SpendTally>();

function tally(root: string): SpendTally | undefined {
	const f = file(root);
	if (!existsSync(f)) return undefined;
	const size = statSync(f).size;
	let t = tallies.get(f);
	if (!t || size < t.size) t = { size: 0, tail: "", usd: 0, bySource: {}, paid: [] }; // new or truncated: read again
	if (size > t.size) {
		const buf = Buffer.alloc(size - t.size);
		const fd = openSync(f, "r");
		try {
			readSync(fd, buf, 0, buf.length, t.size);
		} finally {
			closeSync(fd);
		}
		const lines = (t.tail + buf.toString("utf8")).split("\n");
		t.tail = lines.pop() ?? ""; // a line still being written
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const e = JSON.parse(line) as SpendEntry;
				t.usd += e.usd;
				t.since ??= e.at;
				const k = e.source.split(":")[0]!;
				t.bySource[k] = (t.bySource[k] ?? 0) + e.usd;
				if (!e.subscription) t.paid.push([e.at, e.usd]);
			} catch {
				/* torn line */
			}
		}
		t.size = size;
	}
	tallies.set(f, t);
	return t;
}

/** Total spend of the workspace (all-time), split by source family. */
export function totalSpend(root: string): { usd: number; bySource: Record<string, number>; since?: string } {
	const t = tally(root);
	return t ? { usd: t.usd, bySource: { ...t.bySource }, since: t.since } : { usd: 0, bySource: {} };
}

/** Money actually paid since a time (subscription calls excluded): what the daily budget cap counts. */
export function paidSince(root: string, sinceIso: string): number {
	let usd = 0;
	for (const [at, u] of tally(root)?.paid ?? []) if (at >= sinceIso) usd += u;
	return usd;
}
