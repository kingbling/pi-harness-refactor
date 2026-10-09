import type { Config } from "../config.ts";
import { decide, setDecisionAction } from "../jev/decide.ts";
import { choiceOf, JEV_ACT, noulOf, TRIAGE_GATE } from "../jev/questions.ts";
import type { Ledger } from "../ledger/db.ts";
import type { DecisionAnswer, ModelClient } from "../models/types.ts";
import { errorSignature, findingKey, NOTHING_WRITTEN, type GateReport } from "./gate.ts";

/**
 * Jev at the gate. Rules for using Jev well: the state is small and literal (the failing step's output
 * tail + a few numbers), every question is typed, several questions go in ONE call, confidence decides
 * whether code acts, asks for a label, or hands over. Jev never auto-accepts code; it only picks the
 * next step of the unit's playbook.
 */
// ask_human asks nobody here: unit.ts lets the doctor and the setup model try first and asks only when they cannot help.
export type TriageAction = "retry" | "escalate" | "retest" | "quarantine" | "ask_human";

export interface Triage {
	action: TriageAction;
	cause: string;
	confidence: number;
	/** confidence at or above JEV_ACT: code acts on Jev's answer */
	sure: boolean;
	decisionId: number;
	reason: string;
}

export interface TriageDeps {
	ledger: Ledger;
	config: Config;
	client: ModelClient;
	root?: string;
}

/** The tester re-ported before this gate (or before an earlier one with the same finding); `progress`: it changed a test, a truth file or interface.md. */
export interface LastRetest {
	progress: boolean;
}

export async function triageGate(d: TriageDeps, unitId: string, gate: GateReport, previous: GateReport | undefined, attemptNo: number, lastRetest?: LastRetest): Promise<Triage> {
	const failed = gate.steps.find((s) => !s.ok);
	const maxImpl = d.config.run.maxImplementAttempts;
	const maxTotal = maxImpl + d.config.run.maxEscalateAttempts;
	// Deterministic shortcuts: the gate already knows these; no model needed.
	if (failed?.name === "symbolproof_ok") return deterministic(d, unitId, "scope", attemptNo < maxTotal ? "retry" : "quarantine", "unproven symbols — implementer must call ledger_prove");
	if (failed?.name === "antigaming_ok") {
		// The same problems twice in a row (and no escalation) means the environment or the gate is wrong, not the
		// model: stop burning attempts (only this unit waits; unit.ts lets the doctor and the setup model try, then asks
		// once). Not when the problem is the implementer's own to fix: having written nothing is answered by another
		// attempt that is told so, never by the owner.
		const prevFailed = previous?.steps.find((s) => !s.ok);
		const own = failed.output.split("\n").every((l) => l.trim() === NOTHING_WRITTEN);
		if (!own && prevFailed?.name === "antigaming_ok" && prevFailed.output === failed.output) return deterministic(d, unitId, "env", "ask_human", "identical anti-gaming failure twice → not the model's fault");
		if (own) return deterministic(d, unitId, "scope", attemptNo < maxTotal ? "retry" : "quarantine", `${NOTHING_WRITTEN}: the implementer is told and tries again`);
		return deterministic(d, unitId, "scope", attemptNo < maxTotal ? "retry" : "quarantine", "scope/test tampering caught by code");
	}

	// State the decision model can actually reason on: not just the tail of the log, but what kind of failure it is.
	const out = failed?.output ?? "";
	const body = (out.startsWith("$ ") ? out.split("\n").slice(1).join("\n") : out).trim(); // drop the "$ cmd" line
	// files the errors name (the command line lists every changed file: it is not an error)
	const errFilesAll = [...new Set([...body.matchAll(/(?:^|\s)([\w./-]+\/[\w.-]+\.[A-Za-z0-9]{1,5})(?=[(:]| )/gm)].map((m) => m[1]!))];
	const testFiles = gate.testFiles ?? [];
	const inTests = errFilesAll.length > 0 && errFilesAll.every((f) => testFiles.some((t) => samePath(f, t)));

	// the tests that failed, as the output names them: the ported test files it mentions, and test-runner failure lines
	const failingTests = [...new Set([...testFiles.filter((t) => out.includes(t) || out.includes(t.split("/").pop()!)), ...[...out.matchAll(/^\s*(?:FAIL|FAILED|✗|×|✕|\d+\))\s+(.{3,160})$/gm)].map((m) => m[1]!.trim())])].slice(0, 20);
	const state = {
		stage: failed?.name ?? "unknown",
		attempt: attemptNo,
		tool_produced_output: body.length > 0,
		exit_code: failed?.exitCode ?? null,
		timed_out: /\[timed out\]/.test(out),
		error_files: errFilesAll.slice(0, 20),
		failing_tests: failingTests,
		errors_in_protected_tests_only: inTests,
		errors_in_changed_files: errFilesAll.filter((f) => gate.changedFiles.some((c) => samePath(f, c))).length,
		gate_report: out.slice(-3000),
		previous_report: previous?.steps.find((s) => !s.ok)?.output.slice(-1500) ?? "",
		previous_stage: previous?.failedStep ?? null,
		same_finding_as_previous: sameFinding(gate, previous),
		diff_stats: { changed_files: gate.changedFiles.length, files: gate.changedFiles.slice(0, 20) },
	};
	// what code does with Jev's answers (how sure it is comes after)
	const playbook = (answers: Record<string, DecisionAnswer>): { action: TriageAction; reason: string } => {
		const cause = choiceOf(answers["cause"]) ?? "other";
		const same = previous ? noulOf(answers["same_as_previous"]) : 0;
		if (attemptNo >= maxTotal) return { action: "quarantine", reason: `attempt cap ${maxTotal} reached` };
		if (cause === "test_bug" || cause === "interface_mismatch") {
			// a retest just ran and did not help (the same finding came back, or it changed nothing): never a second one in a row
			if (lastRetest && (state.same_finding_as_previous || !lastRetest.progress)) return { action: "escalate", reason: `${cause}, but the last retest ${lastRetest.progress ? "did not change the finding" : "changed nothing"} → stronger model` };
			return { action: "retest", reason: `${cause}: tester re-ports interface/tests` };
		}
		if (cause === "env") return { action: "ask_human", reason: "environment problem, not code" };
		// A tool that printed nothing is an environment problem, whatever the model thinks.
		if (!state.tool_produced_output && state.exit_code !== null) return { action: "ask_human", reason: `gate tool exited ${state.exit_code} without output` };
		if (same > JEV_ACT && attemptNo >= 2) return { action: "escalate", reason: "same failure class twice → stronger model" };
		if (attemptNo >= maxImpl) return { action: "escalate", reason: "implement attempts exhausted" };
		return { action: "retry", reason: "retry with the exact gate output" };
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
	const sure = dec.confidence >= JEV_ACT;
	let { action, reason } = playbook(dec.answers);
	// Unsure between code causes (test or code, interface): act on the best guess, nobody is asked. The owner cannot
	// tell a test fault from a code fault better than a model; the next attempt's outcome is the label, the attempt
	// cap bounds the cost. Only an environment cause goes the asking route (doctor and setup model first).
	if (!sure) reason = `${reason} (decision model unsure: ${dec.confidence.toFixed(2)}; acting on its best guess)`;
	// ask_human asks nobody yet: unit.ts lets the doctor and the setup model try first (most such failures never needed a person)
	setDecisionAction(d.ledger, dec.decisionId, action);
	return { action, cause, confidence: dec.confidence, sure, decisionId: dec.decisionId, reason };
}

/** The same finding as the previous gate: same step, same places (maybe new words). */
export function sameFinding(gate: GateReport, previous: GateReport | undefined): boolean {
	const failed = gate.steps.find((s) => !s.ok);
	return !!failed && !!previous && previous.failedStep === failed.name && findingKey(failed.name, previous.steps.find((s) => !s.ok)?.output ?? "") === findingKey(failed.name, failed.output);
}

/** One path names the other: tools print paths relative to the project, the repo or absolute, so either may be the longer one. */
function samePath(a: string, b: string): boolean {
	const x = a.replace(/^\.\//, "");
	const y = b.replace(/^\.\//, "");
	return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

function deterministic(d: TriageDeps, unitId: string, cause: string, action: TriageAction, reason: string): Triage {
	const id = d.ledger.recordDecision({ unitId, point: "triage_gate", model: "code", stateHash: "deterministic", answers: { cause }, confidence: 1, action });
	return { action, cause, confidence: 1, sure: true, decisionId: id, reason };
}
