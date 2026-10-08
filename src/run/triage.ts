import type { Config } from "../config.ts";
import { decide, setDecisionAction } from "../jev/decide.ts";
import { band, choiceOf, DEFAULT_THRESHOLDS, noulOf, TRIAGE_GATE } from "../jev/questions.ts";
import type { Ledger } from "../ledger/db.ts";
import type { DecisionAnswer, ModelClient } from "../models/types.ts";
import { errorSignature, type GateReport } from "./gate.ts";
import { askViaModel } from "../jev/ask.ts";

/**
 * Jev at the gate. Rules for using Jev well: the state is small and literal (the failing step's output
 * tail + a few numbers), every question is typed, several questions go in ONE call, confidence decides
 * whether code acts, asks for a label, or hands over. Jev never auto-accepts code; it only picks the
 * next step of the unit's playbook.
 */
export type TriageAction = "retry" | "escalate" | "retest" | "quarantine" | "ask_human";

export interface Triage {
	action: TriageAction;
	cause: string;
	confidence: number;
	band: "act" | "check" | "escalate";
	decisionId: number;
	questionId?: number;
	reason: string;
}

export interface TriageDeps {
	ledger: Ledger;
	config: Config;
	client: ModelClient;
	root?: string;
}

export async function triageGate(d: TriageDeps, unitId: string, gate: GateReport, previous: GateReport | undefined, attemptNo: number): Promise<Triage> {
	const failed = gate.steps.find((s) => !s.ok);
	const maxImpl = d.config.run.maxImplementAttempts;
	const maxTotal = maxImpl + d.config.run.maxEscalateAttempts;
	// Deterministic shortcuts: the gate already knows these; no model needed.
	if (failed?.name === "symbolproof_ok") return deterministic(d, unitId, "scope", attemptNo < maxTotal ? "retry" : "quarantine", "unproven symbols — implementer must call ledger_prove");
	if (failed?.name === "antigaming_ok") {
		// The same code-level problems twice in a row (and no escalation) means the environment or the gate is wrong,
		// not the model: stop burning attempts and ask (only this unit waits).
		const prevFailed = previous?.steps.find((s) => !s.ok);
		if (prevFailed?.name === "antigaming_ok" && prevFailed.output === failed.output) {
			const { id: q } = await askViaModel(d, { unitId, point: "gate_env", facts: `The anti-gaming check failed identically on two consecutive attempts of ${unitId}, so the implementer cannot fix it. Output:\n${failed.output.slice(-1500)}\nChanged files: ${gate.changedFiles.join(", ")}\nAfter a fix: br requeue ${unitId}.`, options: [{ value: "fixed", facts: "I fixed the environment / protected globs; requeue the unit" }, { value: "quarantine", facts: "leave the unit quarantined" }], recommended: "fixed", context: { output: failed.output.slice(-1500), changed: gate.changedFiles }, blocks: "unit", askedBy: "orchestrator" });
			const t = deterministic(d, unitId, "env", "ask_human", "identical anti-gaming failure twice → not the model's fault");
			return { ...t, questionId: q };
		}
		return deterministic(d, unitId, "scope", attemptNo < maxTotal ? "retry" : "quarantine", "scope/test tampering caught by code");
	}

	// Build errors located only in protected test files are the tester's to fix: the implementer cannot edit them.
	if (failed?.name === "build_ok" && gate.testFiles?.length) {
		const errFiles = [...failed.output.matchAll(/^([^\s(:]+\.[A-Za-z0-9]+)[(:]/gm)].map((m) => m[1]!);
		if (errFiles.length && errFiles.every((f) => gate.testFiles!.some((t) => f.endsWith(t)))) return deterministic(d, unitId, "test_bug", "retest", "build errors only in the ported tests → tester re-ports");
	}

	// State the decision model can actually reason on: not just the tail of the log, but what kind of failure it is.
	const out = failed?.output ?? "";
	const body = (out.startsWith("$ ") ? out.split("\n").slice(1).join("\n") : out).trim(); // drop the "$ cmd" line
	const errFilesAll = [...new Set([...out.matchAll(/(?:^|\s)([\w./-]+\/[\w.-]+\.[A-Za-z0-9]{1,5})(?=[(:]| )/gm)].map((m) => m[1]!))];
	const testFiles = gate.testFiles ?? [];
	const state = {
		stage: failed?.name ?? "unknown",
		attempt: attemptNo,
		tool_produced_output: body.length > 0,
		exit_code: failed?.exitCode ?? null,
		timed_out: /\[timed out\]/.test(out),
		error_files: errFilesAll.slice(0, 20),
		errors_in_protected_tests_only: errFilesAll.length > 0 && errFilesAll.every((f) => testFiles.some((t) => f.endsWith(t))),
		errors_in_changed_files: errFilesAll.filter((f) => gate.changedFiles.some((c) => f.endsWith(c))).length,
		gate_report: out.slice(-3000),
		previous_report: previous?.steps.find((s) => !s.ok)?.output.slice(-1500) ?? "",
		previous_stage: previous?.failedStep ?? null,
		diff_stats: { changed_files: gate.changedFiles.length, files: gate.changedFiles.slice(0, 20) },
	};
	// what code does with Jev's answers (the confidence band comes after)
	const playbook = (answers: Record<string, DecisionAnswer>): { action: TriageAction; reason: string } => {
		const cause = choiceOf(answers["cause"]) ?? "other";
		const retryHelps = noulOf(answers["retry_likely_to_help"]);
		const same = previous ? noulOf(answers["same_as_previous"]) : 0;
		const needsEscalation = noulOf(answers["escalate"]);
		if (attemptNo >= maxTotal) return { action: "quarantine", reason: `attempt cap ${maxTotal} reached` };
		if (cause === "test_bug" || cause === "interface_mismatch") return { action: "retest", reason: `${cause}: tester re-ports interface/tests` };
		if (cause === "env") return { action: "ask_human", reason: "environment problem, not code" };
		// A tool that printed nothing is an environment problem, whatever the model thinks.
		if (!state.tool_produced_output && state.exit_code !== null) return { action: "ask_human", reason: `gate tool exited ${state.exit_code} without output` };
		// Byte-identical failure twice: a stronger model is not the answer, a human is (only this unit waits).
		if (state.previous_report && state.previous_report === out.slice(-1500)) return { action: "ask_human", reason: "identical failure on consecutive attempts" };
		if (needsEscalation > 0.7 || (same > 0.7 && attemptNo >= 2)) return { action: "escalate", reason: needsEscalation > 0.7 ? "needs cross-unit understanding" : "same failure class twice → stronger model" };
		if (attemptNo >= maxImpl) return { action: "escalate", reason: "implement attempts exhausted" };
		return { action: "retry", reason: retryHelps >= 0.5 ? "retry with the exact gate output" : "retry (escalation needs positive evidence)" };
	};
	let dec;
	try {
		// a second opinion only where an unsure answer changes the action: retry and quarantine happen either way,
		// an environment cause is asked either way
		const matters = (a: Record<string, DecisionAnswer>) => {
			const p = playbook(a);
			return p.action === "retest" || p.action === "escalate";
		};
		dec = await decide({ client: d.client, ledger: d.ledger, model: d.config.models.decide.id, second: d.config.models.escalate.id, secondWhen: matters }, "triage_gate", state, TRIAGE_GATE, ["cause"], unitId);
	} catch (e) {
		// the decision model is unavailable: the playbook still runs, by code (retry → escalate → quarantine)
		const action: TriageAction = attemptNo >= maxTotal ? "quarantine" : attemptNo >= maxImpl ? "escalate" : "retry";
		return deterministic(d, unitId, "other", action, `decision model unavailable (${String((e as Error)?.message ?? e).slice(0, 120)}); playbook by attempt count`);
	}
	const cause = choiceOf(dec.answers["cause"]) ?? "other";
	const b = band(dec.confidence, DEFAULT_THRESHOLDS["triage_gate"]!);
	let { action, reason } = playbook(dec.answers);
	// Very low confidence on anything but a cheap retry: hand over instead of guessing. Otherwise code acts and
	// nobody is asked: the outcome of the next attempt is the label, not an owner's guess at a cause code.
	if (b === "escalate" && action !== "retry" && action !== "quarantine") {
		action = "ask_human";
		reason = `${reason} (decision model unsure: ${dec.confidence.toFixed(2)})`;
	}

	let questionId: number | undefined;
	if (action === "ask_human") {
		const asked = await askViaModel(d, {
			unitId,
			point: "triage_gate",
			facts: `Gate step ${state.stage} failed on attempt ${attemptNo} of ${unitId}: ${reason}.${cause === "other" ? "" : ` Likely cause: ${cause}.`} Only this unit waits; the answer is applied when it arrives. Any other text you type is handed to the next attempt as a hint.\nGate output tail:\n${state.gate_report.slice(-1500)}`,
			options: HUMAN_ACTIONS,
			recommended: cause === "env" || !state.tool_produced_output ? "fixed" : "retry",
			context: { gate_tail: state.gate_report.slice(-1500), exit_code: state.exit_code, files: state.diff_stats.files, cause },
			// an environment problem is the same for every unit it hits: one question for all of them
			sameAs: cause === "env" ? errorSignature(gate.failedStep ?? "", failed?.output ?? "") : undefined,
			blocks: "unit",
			askedBy: "orchestrator",
			decisionId: dec.decisionId,
		});
		questionId = asked.id;
		// the run answered it itself (model and triage agree on a plain retry): nobody waits
		if (asked.decided === "retry") {
			action = "retry";
			reason = `${reason}; retried without asking (question #${asked.id})`;
		}
	}
	setDecisionAction(d.ledger, dec.decisionId, action);
	return { action, cause, confidence: dec.confidence, band: b, decisionId: dec.decisionId, questionId, reason };
}

/** What an owner can tell a parked unit to do; the scheduler applies the answer (applyParkedAnswer in run.ts). */
export const HUMAN_ACTIONS: Array<{ value: string; facts: string }> = [
	{ value: "fixed", facts: "the environment or setup is fixed: run the unit again" },
	{ value: "retry", facts: "run the unit again as it is (type a hint instead to steer it)" },
	{ value: "quarantine", facts: "stop: leave the unit for a human to port" },
];

function deterministic(d: TriageDeps, unitId: string, cause: string, action: TriageAction, reason: string): Triage {
	const id = d.ledger.recordDecision({ unitId, point: "triage_gate", model: "code", stateHash: "deterministic", answers: { cause }, confidence: 1, action });
	return { action, cause, confidence: 1, band: "act", decisionId: id, reason };
}
