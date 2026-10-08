/**
 * Jev question batteries. One speculative fan-out call per decision point: every question the
 * code might need is asked at once against a small, filtered state. Code thresholds act on the
 * answers; nothing here generates text.
 *
 * Rules (from TypeSafe's jaggedness notes): literal, exact conditions; no math/counting/dates;
 * no indirection; keep state small; put an explicit "other/unknown" option in every Choice.
 */
import type { DecisionAnswer, DecisionQuestion } from "../models/types.ts";

export type Battery = Record<string, DecisionQuestion>;

/**
 * Unit labels. Only literal, observable facts about the code in `summary` (Jev is confident on those);
 * difficulty is NOT asked — "how hard" is a judgment, so code derives it from these facts plus stats
 * (`unitDifficulty`). Low-confidence answers there were the norm (median 0.54 on a real repo). No "kind"
 * either: a one-word category clashed with the adapter's and told the implementer nothing; the task card
 * states the facts instead (unitFacts).
 */
export const ROUTE_UNIT: Battery = {
	needs_db: { type: "noul", instructions: "Does the code in `summary` read from or write to a database (SQL strings, ORM calls, or query builders)?" },
	has_ui: { type: "noul", instructions: "Does the code in `summary` render HTML, templates, or views?" },
	external_io: { type: "noul", instructions: "Does the code in `summary` send email, call external HTTP APIs, read or write files, or talk to queues?" },
	branching: { type: "noul", instructions: "Does the code in `summary` contain nested conditionals or loops inside conditionals (business decisions, not just rendering a list)?" },
};

/** Size points for difficulty: a 9,000-line file is harder than a 700-line one. */
export function sizePoints(loc: number): number {
	return loc > 5000 ? 3 : loc > 2000 ? 2 : loc > 600 ? 1 : 0;
}

/**
 * Difficulty from facts + stats, by code: each risk factor counts once, size by band (sizePoints); 0-1
 * mechanical, 2-3 moderate, 4+ hard. Facts are probabilities (code facts are 0/1, Jev facts its noul).
 * `confidence` is the probability of the returned level over every combination of the uncertain facts — not
 * the weakest fact.
 */
export function unitDifficulty(facts: Record<string, number | undefined>, stats: { loc: number; deps: number; cutDeps: number }): { level: "mechanical" | "moderate" | "hard"; factors: string[]; confidence: number } {
	const RISK = ["dynamic_refs", "raw_sql", "global_state", "external_io", "branching"];
	const fixed = sizePoints(stats.loc) + (stats.deps > 8 ? 1 : 0) + (stats.cutDeps > 0 ? 1 : 0);
	const levelOf = (n: number) => (n >= 4 ? "hard" : n >= 2 ? "moderate" : "mechanical") as "mechanical" | "moderate" | "hard";
	const pLevel: Record<string, number> = { mechanical: 0, moderate: 0, hard: 0 };
	const walk = (i: number, count: number, p: number) => {
		if (p === 0) return;
		if (i === RISK.length) {
			pLevel[levelOf(count + fixed)]! += p;
			return;
		}
		const q = Math.min(1, Math.max(0, facts[RISK[i]!] ?? 0));
		walk(i + 1, count + 1, p * q);
		walk(i + 1, count, p * (1 - q));
	};
	walk(0, 0, 1);
	const level = (Object.entries(pLevel).sort((a, b) => b[1] - a[1])[0]![0]) as "mechanical" | "moderate" | "hard";
	const yes = (k: string) => (facts[k] ?? 0) >= 0.5;
	const factors = [
		yes("dynamic_refs") && "dynamic references",
		yes("raw_sql") && "raw SQL",
		yes("global_state") && "global/session state",
		yes("external_io") && "external I/O",
		yes("branching") && "nested business logic",
		stats.loc > 600 && `${stats.loc} LOC${stats.loc > 2000 ? " (very large)" : ""}`,
		stats.deps > 8 && `${stats.deps} dependencies`,
		stats.cutDeps > 0 && "forward references (cycle cut)",
	].filter(Boolean) as string[];
	return { level, factors, confidence: Math.round(pLevel[level]! * 100) / 100 };
}

export const TRIAGE_GATE: Battery = {
	cause: {
		type: "choice",
		instructions: "What is the most likely cause of the failure in `gate_report`, given `stage` and `diff_stats`?",
		criteria: {
			impl_bug: "The generated code is wrong: type errors, wrong logic, failing assertions on behavior the tests pin",
			missing_pattern: "The code does not follow a required convention or misses an import/registration the project uses",
			interface_mismatch: "The code and the ported tests disagree on names, signatures, or module layout",
			test_bug: "The failing assertion is in a ported test (`failing_tests`) and the test itself looks wrong: it asserts something odd or sets things up wrongly",
			env: "Tooling or environment problem: missing dependency, timeout, container, network, flaky infra",
			scope: "The change touched files or paths outside the unit, or weakened tests",
			other: "Cannot tell from the report",
		},
	},
	same_as_previous: { type: "noul", instructions: "Is the failure in `gate_report` the same failure as in `previous_report`?" },
};

export const SYSTEMIC_FAILURE: Battery = {
	systemic: { type: "noul", instructions: "Do the failure causes in `recent_failures` point to one shared root cause rather than independent unit problems?" },
	kind: {
		type: "choice",
		instructions: "If `recent_failures` share a root cause, which is it?",
		criteria: {
			bad_rule_change: "A recently changed rule, convention, or prompt now rejects valid code",
			broken_env: "Tooling, container, dependency, or network problems",
			model_degradation: "The model output quality dropped: truncation, refusals, empty results",
			hard_batch: "The current batch of units is genuinely harder, failures are unrelated",
			other: "Cannot tell",
		},
	},
};

/**
 * One line for every Jev call: at or above it Jev's answer is acted on; below it a stronger model gives a second
 * opinion on the same evidence (decide `second`), and only an agreeing one lets the answer stand. Otherwise the
 * caller falls back to the code's default or asks the owner.
 */
export const JEV_ACT = 0.7;
/** Noul → confidence on the same 0..1 scale as Choice (distance from 0.5). */
export function noulConfidence(p: number): number {
	return Math.abs(2 * p - 1);
}

export function answerConfidence(a: DecisionAnswer): number {
	return a.type === "noul" ? noulConfidence(a.noul) : a.confidence;
}

export function choiceOf(a: DecisionAnswer | undefined): string | undefined {
	return a?.type === "choice" ? a.choice : undefined;
}
export function noulOf(a: DecisionAnswer | undefined): number {
	return a?.type === "noul" ? a.noul : 0.5;
}
