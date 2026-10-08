import { appendFileSync, existsSync, readFileSync } from "node:fs";
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

/** Total spend of the workspace (all-time), split by source family. */
export function totalSpend(root: string): { usd: number; bySource: Record<string, number>; since?: string } {
	const f = file(root);
	if (!existsSync(f)) return { usd: 0, bySource: {} };
	let usd = 0;
	let since: string | undefined;
	const bySource: Record<string, number> = {};
	for (const line of readFileSync(f, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line) as SpendEntry;
			usd += e.usd;
			since ??= e.at;
			const k = e.source.split(":")[0]!;
			bySource[k] = (bySource[k] ?? 0) + e.usd;
		} catch {
			/* torn line */
		}
	}
	return { usd, bySource, since };
}

/** Money actually paid since a time (subscription calls excluded): what the daily budget cap counts. */
export function paidSince(root: string, sinceIso: string): number {
	const f = file(root);
	if (!existsSync(f)) return 0;
	let usd = 0;
	for (const line of readFileSync(f, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line) as SpendEntry;
			if (!e.subscription && e.at >= sinceIso) usd += e.usd;
		} catch {
			/* torn line */
		}
	}
	return usd;
}
