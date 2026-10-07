import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

/**
 * Every dollar the workspace spends, from every model call: direct API calls (Jev decisions, structured
 * chats in onboarding, advise, label, triage) and agent sessions (testers, implementers, rules, profile).
 * Append-only `.bigrefactor/spend.jsonl`, written at the two places all model traffic passes through, so
 * the total survives runs, restarts and onboarding reruns.
 *
 * The first write backfills what the ledger already recorded before this log existed (attempts and
 * decisions); onboarding spend from before that point was never recorded and is not guessed.
 */
export interface SpendEntry {
	at: string;
	usd: number;
	source: string;
	model?: string;
}

/** The workspace this process works on: BR_WORKSPACE, else the cwd when it holds a bigrefactor config. */
export function workspaceRoot(): string | undefined {
	const env = process.env["BR_WORKSPACE"];
	if (env && existsSync(join(env, ".bigrefactor"))) return env;
	const cwd = process.cwd();
	return existsSync(join(cwd, "bigrefactor.config.json")) && existsSync(join(cwd, ".bigrefactor")) ? cwd : undefined;
}

const file = (root: string) => join(root, ".bigrefactor", "spend.jsonl");

export function recordSpend(usd: number, source: string, model?: string, root = workspaceRoot()): void {
	if (!root || !(usd > 0)) return;
	try {
		const f = file(root);
		if (!existsSync(f)) {
			const before = ledgerRecorded(root);
			if (before > 0) appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), usd: before, source: "backfill: ledger attempts + decisions before spend tracking" } satisfies SpendEntry) + "\n");
		}
		appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), usd, source, model } satisfies SpendEntry) + "\n");
	} catch {
		/* spend tracking must never break a model call */
	}
}

/** Total spend of the workspace (all-time), split by source family. */
export function totalSpend(root: string): { usd: number; bySource: Record<string, number>; since?: string } {
	const f = file(root);
	if (!existsSync(f)) {
		const before = ledgerRecorded(root);
		return { usd: before, bySource: before ? { "ledger (before tracking)": before } : {} };
	}
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

function ledgerRecorded(root: string): number {
	const p = join(root, ".bigrefactor", "ledger.sqlite");
	if (!existsSync(p)) return 0;
	try {
		const db = new DatabaseSync(p, { readOnly: true });
		try {
			const a = (db.prepare("SELECT COALESCE(SUM(cost_usd),0) c FROM attempts").get() as { c: number }).c;
			const d = (db.prepare("SELECT COALESCE(SUM(cost_usd),0) c FROM decisions").get() as { c: number }).c;
			return a + d;
		} finally {
			db.close();
		}
	} catch {
		return 0;
	}
}
