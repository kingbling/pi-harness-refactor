import { appendFileSync, closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { open, stat } from "node:fs/promises";
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
		absorb(t, buf);
	}
	tallies.set(f, t);
	return t;
}

function absorb(t: SpendTally, buf: Buffer): void {
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
	t.size += buf.length;
}

/**
 * Read the spend log up to now in slices, giving the event loop back between them: the first read of a log of
 * many MB took a third of a second in one piece, and Pi runs it on its UI thread. Later reads (tally) add only new lines.
 */
export async function loadSpend(root: string): Promise<void> {
	const f = file(root);
	const size = await stat(f).then((s) => s.size, () => 0);
	let t = tallies.get(f);
	if (!size || (t && size >= t.size && size - t.size < 1 << 20)) return;
	if (!t || size < t.size) tallies.set(f, (t = { size: 0, tail: "", usd: 0, bySource: {}, paid: [] }));
	const fh = await open(f, "r");
	try {
		while (t.size < size && tallies.get(f) === t) {
			const at = t.size;
			const buf = Buffer.alloc(Math.min(4 << 20, size - at));
			const { bytesRead } = await fh.read(buf, 0, buf.length, at);
			// a sync read (tally) took over meanwhile: it has these bytes already
			if (!bytesRead || t.size !== at) break;
			// up to the last whole line: a slice cut inside a multi-byte character would spoil that line
			absorb(t, buf.subarray(0, buf.subarray(0, bytesRead).lastIndexOf(10) + 1 || bytesRead));
		}
	} finally {
		await fh.close();
	}
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
