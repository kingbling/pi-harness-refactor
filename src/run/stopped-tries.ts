import type { Config } from "../config.ts";
import type { Ledger } from "../ledger/db.ts";
import { stubOwnersAcceptedSince } from "./gate.ts";

/** The gate step's output when the run stopped before the review judged the try. */
export const NOT_JUDGED_STOPPING = "not judged: the run is stopping";

/** A try whose gate holds no verdict: the run stopped before its review judged it, so it is no used try. */
export const unjudgedByStop = (report?: { steps: Array<{ ok: boolean; output: string }> }): boolean => !!report?.steps.some((s) => !s.ok && s.output.startsWith(NOT_JUDGED_STOPPING));

/**
 * Units parked at the attempt cap with tries a stop cut off before they were judged (each counted as a used try
 * before 0.4.54): planned again with those tries back, their open park question withdrawn. Once per unit.
 * On the live run the 07:03 stop cut off 27 tries, and U696, U797, U798, U806 and U846 were parked at the cap
 * within an hour of the next start.
 */
export function returnStoppedTries(ledger: Ledger, config: Config): string[] {
	const maxTotal = config.run.maxImplementAttempts + config.run.maxEscalateAttempts;
	const rows = ledger.db
		.prepare(
			`SELECT u.id, p.reason why, p.created_at at FROM units u
			 LEFT JOIN transitions p ON p.id = (SELECT t.id FROM transitions t WHERE t.entity = 'unit' AND t.entity_id = u.id AND t.to_state = 'quarantined' ORDER BY t.created_at DESC LIMIT 1) WHERE u.state = 'quarantined' AND json_extract(u.meta, '$.stopTriesReturned') IS NULL`,
		)
		.all() as Array<{ id: string; why: string | null; at: string | null }>;
	const out: string[] = [];
	for (const r of rows) {
		// parked for its used-up tries ("gate still red after 5 attempts …; attempt cap 5 reached" or a triage note instead of the cap)
		if (!/attempt cap|gate still red after \d+ attempts/.test(r.why ?? "")) continue;
		// the owner chose to leave it parked since: that stands
		if (ledger.db.prepare("SELECT 1 FROM questions WHERE unit_id = ? AND point = 'quarantine' AND answered_by LIKE 'human%' AND answer LIKE 'leave%' AND answered_at >= ?").get(r.id, r.at)) continue;
		const stopped = (ledger.db.prepare("SELECT gate_report FROM attempts WHERE unit_id = ? AND outcome = 'stopped' AND gate_report IS NOT NULL").all(r.id) as Array<{ gate_report: string }>).filter((a) => unjudgedByStop(JSON.parse(a.gate_report))).length;
		if (!stopped) continue;
		for (const q of ledger.openQuestions().filter((x) => x.unit_id === r.id && x.point === "quarantine")) ledger.withdrawQuestion(q.id, `a stop cut off ${stopped} of its tries before they were judged: it gets them back`);
		ledger.updateUnit(r.id, { meta: { stopTriesReturned: stopped, triesUsed: Math.max(0, maxTotal - stopped) } });
		ledger.transitionUnit(r.id, "planned", `${stopped} try(s) a stop cut off before they were judged are given back`);
		out.push(`${r.id} (${stopped})`);
	}
	// a unit a stop sent back to planned with the cut-off try counted (a stop before 0.4.54): its next run counts one try less
	const back = ledger.db
		.prepare(
			`SELECT u.id, json_extract(u.meta, '$.triesUsed') used, a.id attempt, a.gate_report report FROM units u
			 JOIN attempts a ON a.id = (SELECT b.id FROM attempts b WHERE b.unit_id = u.id ORDER BY b.id DESC LIMIT 1)
			 WHERE u.state = 'planned' AND json_extract(u.meta, '$.triesUsed') > 0 AND a.outcome = 'stopped' AND a.gate_report IS NOT NULL
			   AND IFNULL(json_extract(u.meta, '$.stopNotCounted'), 0) <> a.id AND json_extract(u.meta, '$.stopTriesReturned') IS NULL`,
		)
		.all() as Array<{ id: string; used: number; attempt: number; report: string }>;
	for (const r of back) {
		if (!unjudgedByStop(JSON.parse(r.report))) continue;
		ledger.updateUnit(r.id, { meta: { triesUsed: r.used - 1, stopNotCounted: r.attempt } });
		out.push(`${r.id} (1)`);
	}
	return out;
}

/**
 * Units parked at the cap whose last try the scope step refused only for stubs whose owner was accepted while that try
 * ran (before 0.4.58 it counted): planned again with one try left, their open park question withdrawn. Once per unit.
 */
export function returnLateStubTries(ledger: Ledger, config: Config): string[] {
	const maxTotal = config.run.maxImplementAttempts + config.run.maxEscalateAttempts;
	const rows = ledger.db
		.prepare(
			`SELECT u.id, a.started_at since, a.gate_report report FROM units u
			 JOIN attempts a ON a.id = (SELECT b.id FROM attempts b WHERE b.unit_id = u.id AND b.gate_report IS NOT NULL ORDER BY b.id DESC LIMIT 1)
			 WHERE u.state = 'quarantined' AND json_extract(u.meta, '$.lateStubTryReturned') IS NULL AND json_extract(a.gate_report, '$.failedStep') = 'antigaming_ok'`,
		)
		.all() as Array<{ id: string; since: string; report: string }>;
	const out: string[] = [];
	for (const r of rows) {
		const report = JSON.parse(r.report) as { steps: Array<{ ok: boolean; output: string }> };
		const late = stubOwnersAcceptedSince(ledger, report.steps.find((s) => !s.ok)?.output ?? "", r.since);
		if (!late) continue;
		for (const q of ledger.openQuestions().filter((x) => x.unit_id === r.id && x.point === "quarantine")) ledger.withdrawQuestion(q.id, `its last try was refused only for stubs of ${late.join(", ")}, accepted while it ran: it gets the try back`);
		ledger.updateUnit(r.id, { meta: { lateStubTryReturned: true, triesUsed: maxTotal - 1, retryNote: `${late.join(", ")} was accepted while your last try ran: its stubs (TODO(br:${late[0]})) no longer stand. Use its code (target_lookup) instead.` } });
		ledger.transitionUnit(r.id, "planned", `its last try was refused only for stubs of ${late.join(", ")}, accepted while it ran: the try is given back`);
		out.push(r.id);
	}
	return out;
}
