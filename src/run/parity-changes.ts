import type { Ledger } from "../ledger/db.ts";
import type { Diff, SliceEvidence, StepsFile } from "./parity-check.ts";
import { differences } from "./differences.ts";
import { quirksOf, type QuirkRow } from "./quirks.ts";

/** Exact observations for an intentional change, never a wildcard or an instruction to ignore differences. */
export interface ExpectedChange {
	step: string;
	kind: Exclude<Diff["kind"], "error">;
	legacy: unknown;
	target: unknown;
}

export interface BehaviorChange {
	id: string;
	quirkId: number;
	why: string;
	expected: ExpectedChange[];
}

export interface VerifiedChange extends BehaviorChange {
	decision: Pick<QuirkRow, "unit_id" | "symbol_id" | "behaviour" | "decided_by" | "question_id">;
}

export function changeShapeProblems(suite: StepsFile): string[] {
	if (suite.changes === undefined) return [];
	if (!Array.isArray(suite.changes)) return ["changes must be an array"];
	const ids = new Set<string>(), observations = new Set<string>();
	for (const c of suite.changes) {
		if (!c || typeof c.id !== "string" || !c.id.trim() || ids.has(c.id) || !Number.isSafeInteger(c.quirkId) || c.quirkId < 1 || typeof c.why !== "string" || !c.why.trim() || !Array.isArray(c.expected) || !c.expected.length)
			return ["changes need distinct ids, a positive quirkId, why, and non-empty expected observations"];
		ids.add(c.id);
		for (const e of c.expected) {
			if (!e || typeof e.step !== "string" || !["status", "redirect", "body", "data", "header"].includes(e.kind) || !Object.hasOwn(e, "legacy") || !Object.hasOwn(e, "target") || e.legacy === undefined || e.target === undefined || !differences(e.legacy, e.target).length)
				return [`change ${c.id}: each observation needs step, kind (never error), and different explicit legacy/target values`];
			const check = (suite.checks ?? []).some((c) => `check:${c.id}` === e.step);
			const fixture = e.step === "fixture" && e.kind === "data";
			if (!suite.steps.some((s) => s.id === e.step && s.compare !== "none") && !check && !fixture) return [`change ${c.id}: unknown compared step/check ${e.step}`];
			if (check && e.kind !== "body") return [`change ${c.id}: executable check observations use kind body`];
			if (e.kind === "status" && [e.legacy, e.target].some((s) => !Number.isInteger(s) || Number(s) < 100 || Number(s) >= 500)) return [`change ${c.id}: status expectations must be HTTP statuses below 500`];
			const key = JSON.stringify([e.step, e.kind]);
			if (observations.has(key)) return [`change ${c.id}: duplicate expectation for ${e.step} ${e.kind}`];
			observations.add(key);
		}
	}
	return [];
}

/** A historical leave/allowed verdict alone never authorizes a strict verification change. */
export function changeDecisionProblems(suite: StepsFile, ledger: Ledger): string[] {
	const shape = changeShapeProblems(suite);
	if (shape.length) return shape;
	const rows = new Map(quirksOf({ ledger }).map((q) => [q.id, q]));
	return (suite.changes ?? []).flatMap((c) => {
		const q = rows.get(c.quirkId);
		return !q || q.status !== "dropped" || !q.decided_by || ledger.getUnit(q.unit_id)?.state !== "accepted"
			? [`change ${c.id}: quirk #${c.quirkId} needs a recorded DROP decision and an accepted owning unit`]
			: [];
	});
}

/** Both old runs and the target must equal the complete specified observation, including every object field. */
export function assessChanges(suite: StepsFile, ledger: Ledger, evidence: SliceEvidence, diffs: Diff[]): { verified: VerifiedChange[]; unexplained: Diff[]; problems: string[] } {
	const problems = changeDecisionProblems(suite, ledger);
	if (problems.length) return { verified: [], unexplained: diffs, problems };
	const covered = new Set<Diff>();
	const verified: VerifiedChange[] = [];
	const observe = (e: ExpectedChange, side: "old1" | "old2" | "target"): unknown => {
		if (e.step === "fixture" && e.kind === "data") return side === "target" ? evidence.fixture?.target : evidence.fixture?.legacy[side === "old1" ? 0 : 1];
		const check = (suite.checks ?? []).find((c) => `check:${c.id}` === e.step);
		if (check) {
			const rows = side === "target" ? evidence.checks.target : evidence.checks.legacy[side === "old1" ? 0 : 1];
			const r = rows.find((r) => r.id === check.id);
			return r && !r.error ? r.observations : undefined;
		}
		const index = evidence.steps.findIndex((s) => s.id === e.step);
		const rows = side === "target" ? evidence.target : evidence.legacy[side === "old1" ? 0 : 1];
		const r = rows[index];
		if (!r || r.error) return undefined;
		const key = e.kind === "redirect" ? "location" : e.kind === "header" ? "headers" : e.kind;
		return r[key] ?? null;
	};
	const rows = new Map(quirksOf({ ledger }).map((q) => [q.id, q]));
	for (const c of suite.changes ?? []) {
		const local: Diff[] = [];
		let ok = true;
		for (const e of c.expected) {
			const found = diffs.filter((d) => d.step === e.step && d.kind === e.kind);
			if (!found.length || differences(observe(e, "old1"), e.legacy).length || differences(observe(e, "old2"), e.legacy).length || differences(observe(e, "target"), e.target).length) {
				problems.push(`change ${c.id}: ${e.step} ${e.kind} did not reproduce both specified legacy results and the intended target result`);
				ok = false;
			} else local.push(...found);
		}
		if (ok) {
			for (const d of local) covered.add(d);
			const q = rows.get(c.quirkId)!;
			verified.push({ ...c, decision: { unit_id: q.unit_id, symbol_id: q.symbol_id, behaviour: q.behaviour, decided_by: q.decided_by, question_id: q.question_id } });
		}
	}
	return { verified, unexplained: diffs.filter((d) => !covered.has(d)), problems };
}
