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
 * (`unitDifficulty`). Low-confidence answers there were the norm (median 0.54 on a real repo).
 */
export const ROUTE_UNIT: Battery = {
	kind: {
		type: "choice",
		instructions: "Which kind of code is described in `summary`?",
		criteria: {
			constants_config: "Constants, enums, configuration values, pure helpers with no I/O",
			domain_logic: "Business rules, calculations, validation, state machines",
			data_access: "Database reads/writes, queries, repositories, ORM usage",
			http_handler: "Route handlers, controllers, request/response handling, templates",
			cross_cutting: "Authentication, sessions, middleware, scheduled jobs, logging",
			other: "None of the above",
		},
	},
	needs_db: { type: "noul", instructions: "Does the code in `summary` read from or write to a database (SQL strings, ORM calls, or query builders)?" },
	has_ui: { type: "noul", instructions: "Does the code in `summary` render HTML, templates, or views?" },
	external_io: { type: "noul", instructions: "Does the code in `summary` send email, call external HTTP APIs, read or write files, or talk to queues?" },
	branching: { type: "noul", instructions: "Does the code in `summary` contain nested conditionals or loops inside conditionals (business decisions, not just rendering a list)?" },
};

/**
 * Difficulty from facts + stats, by code: each risk factor counts once; 0–1 mechanical, 2–3 moderate, ≥4 hard.
 * Facts are probabilities (code facts are 0/1, Jev facts its noul). `confidence` is the probability of the
 * returned level over every combination of the uncertain facts — not the weakest fact.
 */
export function unitDifficulty(facts: Record<string, number | undefined>, stats: { loc: number; deps: number; cutDeps: number }): { level: "mechanical" | "moderate" | "hard"; factors: string[]; confidence: number } {
	const RISK = ["dynamic_refs", "raw_sql", "global_state", "external_io", "branching"];
	const fixed = (stats.loc > 600 ? 1 : 0) + (stats.deps > 8 ? 1 : 0) + (stats.cutDeps > 0 ? 1 : 0);
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
		stats.loc > 600 && `${stats.loc} LOC`,
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
			test_bug: "The ported test itself is wrong or asserts something the old code never did",
			env: "Tooling or environment problem: missing dependency, timeout, container, network, flaky infra",
			scope: "The change touched files or paths outside the unit, or weakened tests",
			other: "Cannot tell from the report",
		},
	},
	retry_likely_to_help: { type: "noul", instructions: "Would giving the same model the exact `gate_report` and asking it to fix the code likely make the gate pass on the next attempt?" },
	same_as_previous: { type: "noul", instructions: "Is the failure in `gate_report` the same failure as in `previous_report`?" },
	escalate: { type: "noul", instructions: "Does fixing `gate_report` require understanding beyond the unit, such as cross-module design or unclear legacy semantics?" },
};

export const TRIAGE_TRUTH: Battery = {
	cause: {
		type: "choice",
		instructions: "The characterization test in `test` failed against the OLD code with `failure`. Why?",
		criteria: {
			wrong_expectation: "The test expects behavior the old code does not have; the expectation is wrong",
			flaky: "The failure depends on time, randomness, ordering, or external state",
			real_bug: "The old code's behavior is clearly a defect but it is the real current behavior",
			wrong_symbol: "The test targets the wrong function, class, or file",
			env: "Missing dependency, module loading, database, or runtime problem",
			other: "Cannot tell",
		},
	},
	keep_as_known_bug: { type: "noul", instructions: "If the old behavior in `failure` is a defect, is it still the behavior the new code must reproduce to stay compatible?" },
};

export const SAME_BEHAVIOR: Battery = {
	same_behavior: {
		type: "noul",
		instructions: "Do `a` and `b` compute the same result for the same inputs, ignoring naming, formatting, and comments?",
		criteria: { true: "Same inputs always produce the same outputs and side effects", false: "There is at least one input where they differ" },
	},
};

export const SLICE_SANITY: Battery = {
	coherent: { type: "noul", instructions: "Do the symbols listed in `symbols` belong to one feature or responsibility?" },
	too_big: { type: "noul", instructions: "Does `symbols` mix more than one unrelated feature that a developer would migrate separately?" },
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

/** Confidence bands → action; tuned per decision point on labeled outcomes. */
export interface Thresholds {
	act: number; // >= act → act automatically
	check: number; // >= check → act but flag; below → escalate
}
export const DEFAULT_THRESHOLDS: Record<string, Thresholds> = {
	route: { act: 0.6, check: 0.4 },
	triage_gate: { act: 0.7, check: 0.5 },
	triage_truth: { act: 0.7, check: 0.5 },
	same_behavior: { act: 0.9, check: 0.75 },
	slice_sanity: { act: 0.7, check: 0.5 },
	systemic: { act: 0.8, check: 0.6 },
};

export function band(confidence: number, t: Thresholds): "act" | "check" | "escalate" {
	if (confidence >= t.act) return "act";
	if (confidence >= t.check) return "check";
	return "escalate";
}

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
export function scoreOf(a: DecisionAnswer | undefined): number {
	return a?.type === "score" ? a.score : 0;
}
