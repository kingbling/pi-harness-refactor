import { forecast, renderForecastLine } from "../run/forecast.ts";
import { renderLastRun, type RunRecord } from "../run/run.ts";
import pc from "picocolors";
import type { Ledger } from "../ledger/db.ts";

/**
 * Text renderer for the ledger status. Used by `br status` (terminal) and by the Pi extension
 * (`/br status` → transcript entry), so it must stay plain and compact; color: false yields pure text.
 */
export function renderStatus(ledger: Ledger, opts: { color?: boolean } = {}): string {
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
	const accepted = u["accepted"] ?? 0;
	lines.push(`first-pass accepted ${s.firstPassAccepted}/${accepted}${accepted ? ` (${Math.round((100 * s.firstPassAccepted) / accepted)}%)` : ""}   cost $${s.costUsd.toFixed(3)}`);
	for (const r of s.costByModel) lines.push(`  ${r.role.padEnd(11)} ${r.model.padEnd(28)} ${String(r.n).padStart(4)} calls  $${r.c.toFixed(3)}`);
	if (s.quarantine.length) lines.push(c.red(`quarantine: ${s.quarantine.join(", ")}`));
	const qs = ledger.openQuestions();
	if (qs.length) {
		const waiting = ledger.blockedUnits().size;
		lines.push(c.yellow(`${qs.length} open question${qs.length > 1 ? "s" : ""} for you (${waiting} unit${waiting === 1 ? "" : "s"} waiting, everything else runs) → br questions`));
	}
	const stale = ledger.listUnits().filter((u) => JSON.parse(u.meta).stale).length;
	if (stale) lines.push(c.yellow(`${stale} stale unit${stale > 1 ? "s" : ""}: source changed upstream since they were done → br sweep --stale`));
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
