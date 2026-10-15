import { forecast, renderForecastLine } from "../run/forecast.ts";
import { buildParkedKey } from "../run/builder.ts";
import { renderLastRun, type RunRecord } from "../run/run.ts";
import pc from "picocolors";
import type { Ledger } from "../ledger/db.ts";

/**
 * Text renderer for the ledger status. Used by `br status` (terminal) and by the Pi extension
 * (`/br status` → transcript entry), so it must stay plain and compact; color: false yields pure text.
 */
/** `runLive`: a run is going on, so only the questions its resolver model handed on are the owner's (Ledger.ownerQuestions). */
export function renderStatus(ledger: Ledger, opts: { color?: boolean; runLive?: boolean } = {}): string {
	const s = ledger.status();
	const c = opts.color === false ? plain : pc;
	const lines: string[] = [];
	const inv = s.invariants.ok ? c.green("ok") : c.red(`VIOLATED: ${s.invariants.problems.join("; ")}`);
	lines.push(`${c.bold("bigrefactor")}  invariants: ${inv}`);
	{
		const r = ledger.getMeta("last_run");
		if (r) lines.push(c.dim(renderLastRun(JSON.parse(r) as RunRecord)));
		lines.push(renderForecastLine(forecast(ledger)) + c.dim("  (br forecast)"));
	}
	const totalSym = Object.values(s.symbols).reduce((a, b) => a + b, 0);
	const acc = (s.symbols["accepted"] ?? 0) + (s.symbols["dropped"] ?? 0);
	lines.push(`symbols ${bar(acc, totalSym)} ${acc}/${totalSym} accounted   unaccounted: ${s.unaccounted === 0 ? c.green("0") : c.yellow(String(s.unaccounted))}`);
	lines.push(`files ${s.files.total}  dead_code ${s.files.dead_code}  regenerated ${s.files.regenerated}  framework ${s.files.framework} (br frameworks)`);
	const u = s.units;
	lines.push(
		`units  planned ${u["planned"] ?? 0}  truth ${u["truth"] ?? 0}  implementing ${u["implementing"] ?? 0}  gating ${u["gating"] ?? 0}  review ${u["review"] ?? 0}  ${c.green("accepted " + (u["accepted"] ?? 0))}  ${c.red("quarantined " + (u["quarantined"] ?? 0))}`,
	);
	const tiers = new Map<string, Record<string, number>>();
	for (const r of s.unitsByTier) {
		const t = tiers.get(r.tier) ?? {};
		t[r.state] = r.n;
		tiers.set(r.tier, t);
	}
	for (const [tier, states] of [...tiers.entries()].sort()) {
		const tot = Object.values(states).reduce((a, b) => a + b, 0);
		lines.push(`  ${tier.padEnd(3)} ${bar(states["accepted"] ?? 0, tot)} ${states["accepted"] ?? 0}/${tot}`);
	}
	{
		// how sure the parity of accepted units is: truth run on the old code, read from it (not run), or none
		const t = ledger.db.prepare(`SELECT
			SUM(EXISTS (SELECT 1 FROM evidence e WHERE e.unit_id = u.id AND e.type = 'truth_green_on_old')) run,
			SUM(NOT EXISTS (SELECT 1 FROM evidence e WHERE e.unit_id = u.id AND e.type = 'truth_green_on_old') AND EXISTS (SELECT 1 FROM evidence e WHERE e.unit_id = u.id AND e.type = 'truth_read')) read,
			COUNT(*) n FROM units u WHERE u.state = 'accepted'`).get() as { run: number | null; read: number | null; n: number };
		if (t.n) lines.push(`truth of accepted  run on old code ${t.run ?? 0}  ${c.yellow(`read, not run ${t.read ?? 0}`)}  none ${t.n - (t.run ?? 0) - (t.read ?? 0)}`);
		// br recheck holds accepted units to the newer checks; meta.rechecked marks the ones it saw
		const notRechecked = ledger.listUnits().filter((u) => u.state === "accepted" && !JSON.parse(u.meta).rechecked).length;
		if (notRechecked) lines.push(c.yellow(`${notRechecked} accepted unit${notRechecked > 1 ? "s" : ""} not rechecked since the checks changed → br recheck`));
	}
	{
		// parity: the last comparison of each slice with the old app, and what its differences became
		const last = ledger.db.prepare("SELECT id, slice, outcome FROM parity_runs WHERE id IN (SELECT MAX(id) FROM parity_runs GROUP BY slice)").all() as Array<{ id: number; slice: string; outcome: string }>;
		if (last.length) {
			const by = (o: string) => last.filter((r) => r.outcome === o).length;
			const ids = last.map((r) => r.id);
			const diffs = ledger.db.prepare(`SELECT status, COUNT(*) AS n FROM parity_diffs WHERE run_id IN (${ids.map(() => "?").join(",")}) GROUP BY status`).all(...ids) as Array<{ status: string; n: number }>;
			const n = (st: string) => diffs.find((d) => d.status === st)?.n ?? 0;
			// "setup": an app did not start here, nothing was compared either
			const errors = last.filter((r) => r.outcome === "error" || r.outcome === "setup").map((r) => r.slice);
			lines.push(
				`parity  slices ${c.green(`same ${by("same")}`)}  ${by("differs") ? c.yellow(`differ ${by("differs")}`) : "differ 0"}  ${errors.length ? c.red(`not compared ${errors.length}`) : "not compared 0"}   differences: bugs ${n("bug")}  quirks ${n("quirk")}  allowed ${n("allowed")}  not judged ${n("open")}` +
					c.dim(errors.length ? `  (not compared: ${errors.slice(0, 3).join(", ")}${errors.length > 3 ? " …" : ""} → br parity <slice>)` : "  (br parity <slice>)"),
			);
		}
	}
	const accepted = u["accepted"] ?? 0;
	lines.push(`first-pass accepted ${s.firstPassAccepted}/${accepted}${accepted ? ` (${Math.round((100 * s.firstPassAccepted) / accepted)}%)` : ""}   cost $${s.costUsd.toFixed(3)}`);
	for (const r of s.costByModel) lines.push(`  ${r.role.padEnd(11)} ${r.model.padEnd(28)} ${String(r.n).padStart(4)} calls  $${r.c.toFixed(3)}`);
	if (s.quarantine.length) lines.push(c.red(`quarantine: ${s.quarantine.join(", ")}`));
	// parked by the resolver model: nothing a model can do is left, and nobody is asked about them
	const parked = ledger.listUnits({ state: "quarantined" }).filter((u) => JSON.parse(u.meta).parkedWhy).map((u) => u.id);
	if (parked.length) lines.push(c.dim(`  parked, no question (nothing a model can do is left): ${parked.slice(0, 8).join(", ")}${parked.length > 8 ? " …" : ""} → br requeue <unit> after a change`));
	// main red, the builder's code jobs could not fix it: no question, the builder stopped paying for it
	const redMain = ledger.db.prepare("SELECT key, value FROM meta WHERE key LIKE ? AND value != '' ORDER BY key").all(buildParkedKey("%")) as Array<{ key: string; value: string }>;
	for (const r of redMain) lines.push(c.yellow(`main of ${r.key.slice(buildParkedKey("").length)} parked red, no question: ${r.value}`));
	// accepted although the reviewer still found the tests weak after the tester's rounds (meta.weakTestsNote)
	const weak = ledger.listUnits({ state: "accepted" }).flatMap((u) => {
		const note = (JSON.parse(u.meta) as { weakTestsNote?: string }).weakTestsNote;
		return note ? [`    ${u.id}: ${(note.split("\n")[1] ?? note).slice(0, 160)}`] : [];
	});
	if (weak.length) lines.push(c.yellow(`accepted with tests the reviewer still finds weak (${weak.length}):`), ...weak.slice(0, 8).map((l) => c.dim(l)));
	const qs = ledger.ownerQuestions(!!opts.runLive);
	if (qs.length) {
		const waiting = ledger.blockedUnits().size;
		lines.push(c.yellow(`${qs.length} open question${qs.length > 1 ? "s" : ""} for you (${waiting} unit${waiting === 1 ? "" : "s"} waiting, everything else runs) → br questions`));
	}
	const handled = ledger.openQuestions().length - qs.length;
	if (handled) lines.push(c.dim(`${handled} being handled by the models`));
	const stale = ledger.listUnits().filter((u) => JSON.parse(u.meta).stale).length;
	if (stale) lines.push(c.yellow(`${stale} stale unit${stale > 1 ? "s" : ""}: source changed upstream since they were done; nothing redoes them yet → br why <unit>`));
	const commit = ledger.getMeta("source_commit");
	if (commit) lines.push(c.dim(`source pinned @ ${commit.slice(0, 7)}`));
	return lines.join("\n");
}

export function renderWhy(ledger: Ledger, idOrPath: string, opts: { color?: boolean } = {}): string {
	const w = ledger.why(idOrPath);
	if (!w) return `nothing in the ledger for "${idOrPath}"`;
	const c = opts.color === false ? plain : pc;
	const out: string[] = [];
	if (w.kind === "symbol") {
		out.push(`${c.bold(w.symbol.id)}  [${w.symbol.kind}]  state=${w.symbol.state}  unit=${w.symbol.unit_id ?? "-"}`);
		if (w.symbol.reason) out.push(`  reason: ${w.symbol.reason}`);
		for (const t of w.transitions) out.push(`  ${t.created_at}  ${t.from_state ?? "·"} → ${t.to_state}${t.reason ? `  (${t.reason})` : ""}`);
		for (const m of w.moves) out.push(`  move: ${m.op} → ${JSON.parse(m.target_symbols).join(", ") || "-"}  because ${m.why}`);
		for (const e of w.evidence) out.push(`  evidence #${e.id} ${e.type}`);
		for (const a of w.attempts) out.push(`  attempt #${a["id"]} ${a["role"]} ${a["model"] ?? ""} → ${a["outcome"] ?? "running"} $${Number(a["cost_usd"] ?? 0).toFixed(4)}`);
	} else {
		out.push(`${c.bold(w.file.path)}  state=${w.state}${w.file.dead_code ? `  dead_code: ${w.file.dead_code_reason}` : ""}`);
		for (const s of w.symbols) {
			out.push(`  ${s.name.padEnd(30)} ${s.state.padEnd(12)} ${s.moves.map((m) => `${m.op}→${JSON.parse(m.target_symbols).join(",")}`).join(" ")}`);
		}
	}
	return out.join("\n");
}

function bar(n: number, total: number, width = 20): string {
	if (!total) return "[" + " ".repeat(width) + "]";
	const filled = Math.round((width * n) / total);
	return "[" + "█".repeat(filled) + "░".repeat(width - filled) + "]";
}

const plain = new Proxy({} as typeof pc, { get: () => (s: string) => s });
