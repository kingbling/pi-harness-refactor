import type { Ledger } from "../ledger/db.ts";

/**
 * How far is the migration, and what is left: measured from the ledger, extrapolated with stated assumptions.
 *
 * Work is counted in legacy lines, weighted by difficulty: a hard line costs more than a mechanical one. The
 * weights start as priors and are replaced by observed spend per line once a class has enough accepted units.
 * Spend includes failed and parked attempts, so retries are priced in. Time uses active run time (the union
 * of attempt intervals), so pauses between runs do not count.
 *
 * Early on the sample is small and skewed (leaves first: interfaces and tiny classes), so the range is wide
 * and the forecast says so.
 */
export interface Forecast {
	units: { total: number; accepted: number; inFlight: number; waiting: number; quarantined: number; planned: number };
	loc: { total: number; accepted: number };
	symbols: { total: number; done: number };
	/** 0..1, difficulty-weighted share of the work that is accepted */
	progress: number;
	byDifficulty: Array<{ level: string; units: number; accepted: number; loc: number; acceptedLoc: number; weight: number; weightFrom: "observed" | "prior" }>;
	spentUsd: number;
	activeHours: number;
	remaining: { usd: [number, number, number]; hours: [number, number, number] } | undefined;
	confidence: "none" | "low" | "medium" | "high";
	notes: string[];
}

/** Relative effort per line by difficulty before there is data (mechanical = 1). */
const PRIOR_WEIGHT: Record<string, number> = { mechanical: 1, moderate: 2.5, hard: 6 };
const MIN_OBSERVED = 8; // accepted units of a class before its own rate replaces the prior

export function forecast(ledger: Ledger): Forecast {
	const units = ledger.db
		.prepare("SELECT id, state, COALESCE(json_extract(meta,'$.loc'),0) loc, COALESCE(json_extract(meta,'$.route.difficulty'),'mechanical') d FROM units")
		.all() as Array<{ id: string; state: string; loc: number; d: string }>;
	const open = new Set((ledger.openQuestions() as Array<{ unit_id: string | null }>).map((q) => q.unit_id).filter(Boolean) as string[]);
	const count = (f: (u: (typeof units)[number]) => boolean) => units.filter(f).length;
	const inFlightStates = ["truth", "implementing", "gating", "review"];
	const u = {
		total: units.length,
		accepted: count((x) => x.state === "accepted"),
		waiting: count((x) => inFlightStates.includes(x.state) && open.has(x.id)),
		inFlight: count((x) => inFlightStates.includes(x.state) && !open.has(x.id)),
		quarantined: count((x) => x.state === "quarantined"),
		planned: count((x) => x.state === "planned"),
	};
	const sym = ledger.db.prepare("SELECT COUNT(*) total, SUM(state IN ('accepted','dropped')) done FROM symbols").get() as { total: number; done: number | null };

	// spend per accepted unit, to observe a per-line rate per difficulty
	const costOf = new Map((ledger.db.prepare("SELECT unit_id, SUM(cost_usd) c FROM attempts GROUP BY unit_id").all() as Array<{ unit_id: string; c: number }>).map((r) => [r.unit_id, r.c]));
	const spent = (ledger.db.prepare("SELECT COALESCE(SUM(cost_usd),0) c FROM attempts").get() as { c: number }).c + (ledger.db.prepare("SELECT COALESCE(SUM(cost_usd),0) c FROM decisions WHERE unit_id IS NOT NULL").get() as { c: number }).c;

	const levels = [...new Set(units.map((x) => x.d))].sort((a, b) => (PRIOR_WEIGHT[a] ?? 3) - (PRIOR_WEIGHT[b] ?? 3));
	const rateOf = (level: string) => {
		const acc = units.filter((x) => x.d === level && x.state === "accepted" && x.loc > 0);
		const loc = acc.reduce((a, x) => a + x.loc, 0);
		const usd = acc.reduce((a, x) => a + (costOf.get(x.id) ?? 0), 0);
		return { n: acc.length, perLoc: loc ? usd / loc : undefined };
	};
	const base = rateOf("mechanical");
	const byDifficulty = levels.map((level) => {
		const all = units.filter((x) => x.d === level);
		const r = rateOf(level);
		const observed = level !== "mechanical" && r.n >= MIN_OBSERVED && base.n >= MIN_OBSERVED && r.perLoc && base.perLoc;
		return {
			level,
			units: all.length,
			accepted: all.filter((x) => x.state === "accepted").length,
			loc: all.reduce((a, x) => a + x.loc, 0),
			acceptedLoc: all.filter((x) => x.state === "accepted").reduce((a, x) => a + x.loc, 0),
			weight: observed ? r.perLoc! / base.perLoc! : (PRIOR_WEIGHT[level] ?? 3),
			weightFrom: (observed ? "observed" : "prior") as "observed" | "prior",
		};
	});
	const work = byDifficulty.reduce((a, d) => a + d.loc * d.weight, 0);
	const doneWork = byDifficulty.reduce((a, d) => a + d.acceptedLoc * d.weight, 0);
	const leftWork = work - doneWork;

	// active hours: union of attempt intervals
	const iv = (ledger.db.prepare("SELECT started_at s, COALESCE(ended_at, started_at) e FROM attempts ORDER BY started_at").all() as Array<{ s: string; e: string }>).map((r) => [Date.parse(r.s), Date.parse(r.e)] as [number, number]);
	let activeMs = 0;
	let cur: [number, number] | undefined;
	for (const [s, e] of iv) {
		if (!cur || s > cur[1]) {
			if (cur) activeMs += cur[1] - cur[0];
			cur = [s, e];
		} else cur[1] = Math.max(cur[1], e);
	}
	if (cur) activeMs += cur[1] - cur[0];
	const activeHours = activeMs / 3_600_000;

	const notes: string[] = [];
	let remaining: Forecast["remaining"];
	const n = u.accepted;
	const confidence: Forecast["confidence"] = n < 5 ? "none" : n < 30 ? "low" : n < 150 ? "medium" : "high";
	if (n >= 5 && doneWork > 0) {
		// spend and time per unit of weighted work so far (failures included) → the rest
		const usd = (spent / doneWork) * leftWork;
		const hours = activeHours > 0 ? (activeHours / doneWork) * leftWork : 0;
		// range widens with a small sample: ±1/sqrt(n), at least ±25%, plus unobserved difficulty classes
		const unobserved = byDifficulty.filter((d) => d.weightFrom === "prior" && d.level !== "mechanical" && d.loc > 0);
		const spread = Math.max(0.25, 1 / Math.sqrt(n)) + (unobserved.length ? 0.25 : 0);
		const band = (x: number): [number, number, number] => [x * Math.max(0.2, 1 - spread), x, x * (1 + spread * 1.5)];
		remaining = { usd: band(usd), hours: band(hours) };
		if (unobserved.length) notes.push(`no accepted ${unobserved.map((d) => d.level).join("/")} units yet: their effort uses prior weights (${unobserved.map((d) => `${d.level} ×${d.weight}`).join(", ")})`);
		const accLoc = units.filter((x) => x.state === "accepted").reduce((a, x) => a + x.loc, 0) / Math.max(1, n);
		const allLoc = units.reduce((a, x) => a + x.loc, 0) / Math.max(1, units.length);
		if (accLoc < allLoc / 2) notes.push(`accepted units are small so far (avg ${Math.round(accLoc)} lines vs ${Math.round(allLoc)} overall): leaves go first, bigger units cost more per unit`);
	} else notes.push(`forecast after 5 accepted units (now ${n})`);
	if (u.waiting) notes.push(`${u.waiting} unit(s) wait on a question (br questions)`);
	if (u.quarantined) notes.push(`${u.quarantined} quarantined unit(s) need a human`);

	return {
		units: u,
		loc: { total: units.reduce((a, x) => a + x.loc, 0), accepted: units.filter((x) => x.state === "accepted").reduce((a, x) => a + x.loc, 0) },
		symbols: { total: sym.total, done: sym.done ?? 0 },
		progress: work ? doneWork / work : 0,
		byDifficulty,
		spentUsd: spent,
		activeHours,
		remaining,
		confidence,
		notes,
	};
}

const pct = (x: number) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;
const usd = (x: number) => (x < 10 ? `$${x.toFixed(2)}` : `$${Math.round(x).toLocaleString("en-US")}`);
const dur = (h: number) => (h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`);
const bar = (x: number, w = 30) => "█".repeat(Math.round(x * w)) + "░".repeat(w - Math.round(x * w));

/** One line for status panels. */
export function renderForecastLine(f: Forecast): string {
	const rest = f.remaining ? ` · left ≈ ${usd(f.remaining.usd[1])} (${usd(f.remaining.usd[0])}–${usd(f.remaining.usd[2])}), ${dur(f.remaining.hours[1])} active` : "";
	return `progress ${pct(f.progress)} of the work · ${f.units.accepted}/${f.units.total} units · spent ${usd(f.spentUsd)}${rest} [${f.confidence} confidence]`;
}

export function renderForecast(f: Forecast): string {
	const L: string[] = [];
	L.push(`migration progress  ${bar(f.progress)} ${pct(f.progress)}  (difficulty-weighted work)`);
	L.push("");
	L.push(`done      ${f.units.accepted} units accepted · ${f.loc.accepted.toLocaleString("en-US")} of ${f.loc.total.toLocaleString("en-US")} legacy lines (${pct(f.loc.total ? f.loc.accepted / f.loc.total : 0)}) · symbols done or dropped ${f.symbols.done.toLocaleString("en-US")}/${f.symbols.total.toLocaleString("en-US")}`);
	L.push(`open      ${f.units.planned} planned · ${f.units.inFlight} in flight · ${f.units.waiting} waiting on a question · ${f.units.quarantined} quarantined`);
	L.push("");
	L.push(`${"difficulty".padEnd(11)} ${"units".padStart(6)} ${"accepted".padStart(9)} ${"lines".padStart(8)}  weight`);
	for (const d of f.byDifficulty) L.push(`${d.level.padEnd(11)} ${String(d.units).padStart(6)} ${String(d.accepted).padStart(9)} ${d.loc.toLocaleString("en-US").padStart(8)}  ×${d.weight.toFixed(1)} (${d.weightFrom})`);
	L.push("");
	L.push(`spent     ${usd(f.spentUsd)} in ${dur(f.activeHours)} of active run time`);
	if (f.remaining) {
		L.push(`left      ${usd(f.remaining.usd[1])}  (range ${usd(f.remaining.usd[0])}–${usd(f.remaining.usd[2])})`);
		L.push(`          ${dur(f.remaining.hours[1])} active run time at the current concurrency  (range ${dur(f.remaining.hours[0])}–${dur(f.remaining.hours[2])})`);
	}
	L.push(`confidence ${f.confidence} (${f.units.accepted} accepted units; medium from 30, high from 150)`);
	for (const n of f.notes) L.push(`  · ${n}`);
	return L.join("\n");
}
