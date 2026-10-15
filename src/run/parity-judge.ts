import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import pc from "picocolors";
import { Type } from "typebox";
import type { Config } from "../config.ts";
import { askViaModel } from "../jev/ask.ts";
import type { Ledger } from "../ledger/db.ts";
import type { ModelClient } from "../models/types.ts";
import { PLAIN_LANGUAGE } from "../policy.ts";
import { spawnLeaf } from "../sessions/spawn.ts";
import { loadSteps, sliceFacts } from "./parity-check.ts";
import { fixUpLeft, loadApps, saveApp } from "./parity.ts";
import { askPendingQuirks, recordQuirk } from "./quirks.ts";
import { reopenUnit } from "./recheck.ts";

/**
 * The parity judge: each difference code found between the old and the new app is either the NEW app being wrong
 * (a bug: the unit that owns it is re-opened with the difference as its finding), the OLD app being odd (a quirk:
 * the owner decides keep or drop, as for the tester's quirks), or the test setup (how one app runs here: no unit
 * changes, that app's parity setup is asked once to fix it). "Fine" is not an answer the judge has: only what
 * differs between two runs of the old app is noise, and only the owner drops a behaviour.
 *
 * Code applies what was decided before the judge is asked: a difference at a place where the owner dropped the
 * quirk is allowed; where the owner kept it, the new app must match, so it is a bug of that quirk's unit.
 *
 * A bug whose cause is in code many slices share (how a logged-out request is answered, redirects, HTTPS) is a shared
 * cause: the judge names it once (a known one from the facts when it is the same behaviour, else a new one), and ONE
 * code job fixes it on main instead of a re-open of every unit; the slices it showed in are compared again after.
 */

export interface JudgeGroup {
	/** parity_diffs ids this verdict covers (one cause can show in several places). */
	diffs: number[];
	verdict: "bug" | "quirk" | "setup";
	/** The unit whose code (bug) or legacy behaviour (quirk) it is. */
	unit: string;
	/** setup: the app whose local setup causes it ("legacy" or a target stack). */
	app?: string;
	/** bug: what the new app does wrong; quirk: what the old app does, concretely; setup: what in that app's setup does it. */
	problem: string;
	/** bug: what to change. */
	fix?: string;
	/** quirk: why it looks unintended or intended, and whether to keep it. */
	why?: string;
	opinion?: "drop" | "keep";
	/** bug: the cause is in shared code, not this unit's own: the id of a known shared cause, or "new". */
	shared?: string;
}

/** A bug cause in code many slices share: one code job fixes it (ledger meta `parity_shared`). */
export interface SharedCause {
	id: string;
	problem: string;
	fix?: string;
	/** the slices it showed in: compared again once the job lands */
	slices: string[];
	/** a few of the differences, for the job */
	examples: string[];
	/** open = waiting for a job; landed = a job merged a fix (at `landedAt`); failed = the jobs did not fix it, units are re-opened */
	status: "open" | "running" | "landed" | "failed";
	jobs: number;
	landedAt?: string;
}

/** Code jobs one shared cause gets; after that its differences re-open the units as before. */
export const MAX_SHARED_JOBS = 2;
const SHARED_KEY = "parity_shared";
export const sharedCauses = (ledger: Ledger): SharedCause[] => JSON.parse(ledger.getMeta(SHARED_KEY) ?? "[]") as SharedCause[];
export function updateShared(ledger: Ledger, id: string, patch: Partial<SharedCause>): void {
	ledger.setMeta(SHARED_KEY, JSON.stringify(sharedCauses(ledger).map((c) => (c.id === id ? { ...c, ...patch } : c))));
}
/** At run start: a job cut off by the end of the last run is open again. */
export const resumeShared = (ledger: Ledger) => sharedCauses(ledger).filter((c) => c.status === "running").forEach((c) => updateShared(ledger, c.id, { status: "open" }));
/**
 * One code job for the first open shared cause (`job` runs it and says whether it merged a fix). Returns the slices to
 * compare again (landed: on the fix; failed for good: so the judge re-opens the units), or undefined when none is open.
 */
export async function runSharedJob(ledger: Ledger, job: (c: SharedCause) => Promise<boolean>, log: (l: string) => void = () => {}): Promise<{ id: string; slices: string[] } | undefined> {
	const c = sharedCauses(ledger).find((x) => x.status === "open");
	if (!c) return undefined;
	const n = c.jobs + 1;
	updateShared(ledger, c.id, { status: "running", jobs: n });
	const landed = await job({ ...c, jobs: n }).catch((e) => (log(`parity shared cause ${c.id}: ${e?.message ?? e}`), false));
	updateShared(ledger, c.id, landed ? { status: "landed", landedAt: new Date().toISOString() } : { status: n >= MAX_SHARED_JOBS ? "failed" : "open" });
	const slices = sharedCauses(ledger).find((x) => x.id === c.id)?.slices ?? c.slices;
	return { id: c.id, slices: landed || n >= MAX_SHARED_JOBS ? slices : [] };
}
/** What the code job for a shared cause is told. */
export const sharedJobText = (c: SharedCause) =>
	`The new app answers differently from the old one in the same way across slices ${c.slices.join(", ")} (parity check: the same requests sent to both apps). One cause in code those pages share, not in one page's own code:\n${c.problem}${c.fix ? `\nFix: ${c.fix}` : ""}\nSome of the differences:\n${c.examples.map((e) => `- ${e}`).join("\n")}\nRead the old code to see what it does, and fix it once in the shared code (or config) of the new app, so every route behaves like the old app here; do not change each page's code. Test the shared behaviour.`;

export type ParityJudge = (o: { config: Config; root: string; slice: string; facts: string; units: string[] }) => Promise<JudgeGroup[] | undefined>;

/** Re-opens per unit and parity: after this many, the owner is asked instead (the unit keeps failing the same comparison). */
export const MAX_PARITY_REOPENS = 2;

type DiffRow = { id: number; step: string; route: string; kind: string; path: string; legacy: string; target: string; status: string; quirk_id: number | null; unit_id: string | null };

export const judgeWithModel: ParityJudge = async (o) => {
	let groups: JudgeGroup[] | undefined;
	const verdictTool = {
		name: "parity_verdict",
		label: "Parity verdict",
		description: "Your verdict on every difference listed, grouped by cause. verdict bug = the new app is wrong (unit = the unit whose new code must change; problem and fix concrete enough to act on without asking). verdict quirk = the old app does something odd the new app does not copy (unit = the unit whose legacy code does it; problem = what the old app does; why; opinion drop = it looks unintended, keep = callers may rely on it). verdict setup = only how one app runs here causes it, no unit's code (app = that app's name from the facts, problem = what in its setup; unit may be empty). There is no 'fine': every difference is a bug, a quirk or setup.",
		promptSnippet: "parity_verdict: bug, quirk or setup for every difference, grouped by cause",
		parameters: Type.Object({
			groups: Type.Array(
				Type.Object({
					diffs: Type.Array(Type.Number()),
					verdict: Type.Union([Type.Literal("bug"), Type.Literal("quirk"), Type.Literal("setup")]),
					unit: Type.String(),
					app: Type.Optional(Type.String()),
					problem: Type.String(),
					fix: Type.Optional(Type.String()),
					why: Type.Optional(Type.String()),
					opinion: Type.Optional(Type.Union([Type.Literal("drop"), Type.Literal("keep")])),
					shared: Type.Optional(Type.String({ description: "bug only, when the facts list shared causes: the cause is in code many pages share (how a logged-out request is answered, redirects, HTTPS, headers every route gets), not in this unit's own code. The id of a known shared cause when it is the same behaviour, else \"new\". One job fixes it once; no unit is re-opened for it." })),
				}),
			),
		}),
		execute: async (_id: string, p: { groups: JudgeGroup[] }) => {
			groups = p.groups;
			return { content: [{ type: "text" as const, text: "verdict recorded; stop here" }], details: {} };
		},
	} as unknown as ToolDefinition;
	const session = await spawnLeaf({
		role: "review",
		cwd: o.config.target.path,
		config: o.config,
		writeGlobs: [],
		customTools: [verdictTool],
		transcriptPath: join(o.root, ".bigrefactor", "sessions", `__parity__.${o.slice}.judge.${Date.now()}.jsonl`),
		systemPrompt: `You judge differences between an OLD app (${o.config.source.stack}, at ${o.config.source.path}) and the NEW app migrated from it (${o.config.target.stacks.join(" + ")}, at ${o.config.target.path}). The same requests went to both; code compared the answers and what each wrote, and left out everything that differs between two runs of the old app. Read the old and the new code to find each difference's cause. A comment in the new code explaining a difference is a claim, not evidence: decide from what the old code does. Every difference is a bug (the new app is wrong), a quirk (the old app does something odd) or setup (only how one app runs here causes it: its address, its config, a database it lacks; the facts say how each app was set up); a difference in form alone is still a bug or a quirk (a new app answering 303 where the old one answered 302 changes what clients see: a bug, unless the old behaviour is itself odd). Setup only when no unit's code would change it. Name a unit from the list for each bug or quirk. When the facts list shared causes, a bug caused by code many pages share (not one page's own) is marked shared, so one job fixes it once. Answer with parity_verdict once.\n\n${PLAIN_LANGUAGE}`,
	});
	try {
		await session.run(o.facts);
		if (!groups) await session.run("You did not call parity_verdict. Call it now with a verdict for every difference.");
		return groups;
	} finally {
		session.dispose();
	}
};

/**
 * Judge the open differences of one parity run and act on them. Returns what happened, for the log.
 */
export async function judgeRun(o: {
	ledger: Ledger;
	config: Config;
	root: string;
	runId: number;
	slice: string;
	judge?: ParityJudge;
	client?: ModelClient;
	log?: (l: string) => void;
	/** a code job can take shared causes (off: their units are re-opened like any bug) */
	shared?: boolean;
}): Promise<{ reopened: string[]; bugs: number; quirks: number; setup: number; allowed: number; open: number; shared: string[] }> {
	const log = o.log ?? ((l: string) => console.log(l));
	const db = o.ledger.db;
	const rows = () => db.prepare("SELECT * FROM parity_diffs WHERE run_id = ? AND status = 'open' ORDER BY id").all(o.runId) as unknown as DiffRow[];
	const set = db.prepare("UPDATE parity_diffs SET status = ?, unit_id = ?, quirk_id = ?, note = ? WHERE id = ?");
	const bugs = new Map<string, string[]>();
	let allowed = 0;
	let quirks = 0;
	let setup = 0;

	// what the owner already decided at this place: dropped → allowed, kept → the new app must match
	for (const d of rows()) {
		const before = db
			.prepare("SELECT p.quirk_id, q.status, q.unit_id, q.behaviour FROM parity_diffs p JOIN quirks q ON q.id = p.quirk_id WHERE p.slice = ? AND p.step = ? AND p.path = ? AND p.run_id != ? ORDER BY p.id DESC LIMIT 1")
			.get(o.slice, d.step, d.path, o.runId) as { quirk_id: number; status: string; unit_id: string; behaviour: string } | undefined;
		if (before?.status === "dropped") (set.run("allowed", before.unit_id, before.quirk_id, "the owner dropped this old behaviour", d.id), allowed++);
		else if (before?.status === "kept") {
			const note = `the owner kept the old behaviour (${before.behaviour}); the new app must match it`;
			set.run("bug", before.unit_id, before.quirk_id, note, d.id);
			(bugs.get(before.unit_id) ?? bugs.set(before.unit_id, []).get(before.unit_id)!).push(`${describe(d)} — ${note}`);
		} else if (before) set.run("quirk", before.unit_id, before.quirk_id, "waiting for the owner's keep/drop", d.id), quirks++;
	}

	// a shared cause takes the group unless its jobs did not fix it: then its units are re-opened as before
	const sharedIds = new Set<string>();
	let sharedBugs = 0;
	const startedAt = (db.prepare("SELECT started_at FROM parity_runs WHERE id = ?").get(o.runId) as { started_at: string } | undefined)?.started_at ?? "";
	const sharedCause = (g: JudgeGroup, these: DiffRow[]): boolean => {
		const all = sharedCauses(o.ledger);
		let c = all.find((x) => x.id === g.shared);
		if (c?.status === "failed") return false;
		// a slice a failed cause showed in takes no new cause: its jobs did not fix it, the units do (bounds the jobs)
		if (!c && all.some((x) => x.status === "failed" && x.slices.includes(o.slice))) return false;
		const examples = these.map((d) => `${o.slice}: ${describe(d)}`);
		if (!c) {
			c = { id: `S${all.length + 1}`, problem: g.problem, fix: g.fix, slices: [], examples: [], status: "open", jobs: 0 };
			all.push(c);
		}
		if (!c.slices.includes(o.slice)) c.slices.push(o.slice);
		c.examples = [...c.examples, ...examples].slice(-12);
		// still differs on a main that has the fix: another job, a few at most, then the units
		if (c.status === "landed" && !(Date.parse(startedAt) <= Date.parse(c.landedAt ?? ""))) {
			if (c.jobs >= MAX_SHARED_JOBS) c.status = "failed";
			else c.status = "open";
		}
		o.ledger.setMeta(SHARED_KEY, JSON.stringify(all));
		if (c.status === "failed") return false;
		for (const d of these) set.run("bug", g.unit || null, null, `shared cause ${c.id}: ${g.problem}${g.fix ? ` Fix: ${g.fix}` : ""}`, d.id);
		sharedIds.add(c.id);
		sharedBugs++;
		return true;
	};

	const open = rows();
	if (open.length) {
		const { units, files } = sliceFacts(o.ledger, o.slice);
		const steps = loadSteps(o.root, o.slice)?.steps ?? [];
		const known = o.shared ? sharedCauses(o.ledger) : [];
		const unitList = units.map((u) => `${u.id} (${u.state}): ${(JSON.parse(o.ledger.getUnit(u.id)!.meta) as { files?: string[] }).files?.join(", ") ?? ""}`);
		const facts = [
			`Slice "${o.slice}". Its units and their legacy files (relative to the old repo):\n${unitList.join("\n")}`,
			`The requests (steps.json; "target" = how the new app was asked differently):\n${JSON.stringify(steps, null, 1).slice(0, 12_000)}`,
			`How each app runs here (its setup model's words):\n${Object.entries(loadApps(o.root)).map(([side, a]) => `${side}: ready at ${a.recipe?.ready ?? "?"}; ${a.said ?? ""}`).join("\n")}`,
			`The differences:\n${open.map((d) => `#${d.id} ${describe(d)}`).join("\n")}`,
			...(o.shared ? [`Shared causes (a bug in code many pages share; set "shared" on a bug group: a known id when it is the same behaviour, "new" for another one):\n${known.map((c) => `${c.id} (slices ${c.slices.join(", ")})${c.status === "failed" ? " FAILED: its jobs did not fix it, so its bugs go to the units; do not set shared for it" : ""}: ${c.problem}`).join("\n") || "none known yet"}`] : []),
		].join("\n\n");
		const groups = await (o.judge ?? judgeWithModel)({ config: o.config, root: o.root, slice: o.slice, facts, units: units.map((u) => u.id) }).catch((e) => (log(pc.yellow(`parity ${o.slice}: judge failed: ${e?.message ?? e}`)), undefined));
		const openIds = new Set(open.map((d) => d.id));
		const unitIds = new Set(o.ledger.listUnits().map((u) => u.id));
		const apps = loadApps(o.root);
		for (const g of groups ?? []) {
			const ids = g.diffs.filter((id) => openIds.has(id));
			if (!ids.length || (g.verdict === "setup" ? !g.app || !apps[g.app] : !unitIds.has(g.unit) || !["bug", "quirk"].includes(g.verdict))) continue;
			for (const id of ids) openIds.delete(id);
			const these = open.filter((d) => ids.includes(d.id));
			if (g.verdict === "setup") {
				// no unit is re-opened for how an app runs here: that app's parity setup is asked (once) to fix it
				for (const d of these) set.run("setup", null, null, `${g.app}: ${g.problem}`, d.id);
				if (fixUpLeft(apps[g.app!], "setup")) saveApp(o.root, g.app!, { setupProblem: `${these.map(describe).join("; ").slice(0, 1000)} — ${g.problem}` });
				setup += these.length;
			} else if (g.verdict === "bug" && o.shared && g.shared && sharedCause(g, these)) {
				// recorded once for the code job; no unit is re-opened for it
			} else if (g.verdict === "bug") {
				for (const d of these) set.run("bug", g.unit, null, `${g.problem}${g.fix ? ` Fix: ${g.fix}` : ""}`, d.id);
				(bugs.get(g.unit) ?? bugs.set(g.unit, []).get(g.unit)!).push(`${these.map(describe).join("; ")} — ${g.problem}${g.fix ? ` Fix: ${g.fix}` : ""}`);
			} else {
				// never auto-dropped: the kind the tester's own quirks may drop without asking is not used here
				const q = recordQuirk({ ledger: o.ledger, root: o.root }, { unitId: g.unit, symbolId: these[0]!.route, kind: g.opinion === "keep" ? "intentional" : "suspected_bug", behaviour: g.problem, example: these.map(describe).join("; ").slice(0, 1000), opinion: g.opinion ?? "drop", why: g.why ?? "found by comparing the old and the new app" });
				for (const d of these) set.run("quirk", g.unit, q.id, g.why ?? null, d.id);
				quirks += these.length;
				await askPendingQuirks({ ledger: o.ledger, config: o.config, root: o.root, client: o.client }, g.unit).catch(() => undefined);
			}
		}
	}

	// bugs: the unit goes back with the differences as its finding, a few times; then the owner is asked
	const reopened: string[] = [];
	for (const [unitId, found] of bugs) {
		const u = o.ledger.getUnit(unitId);
		if (u?.state !== "accepted") continue; // it is being worked on: the next parity check of the slice sees it again
		const { parityReopens: n = 0, parityLeft } = JSON.parse(u.meta) as { parityReopens?: number; parityLeft?: number };
		const note = `The new app answers differently from the old one (parity check of slice "${o.slice}": the same requests sent to both):\n${found.map((f) => `- ${f}`).join("\n")}\nMake the new code behave like the old code here.`;
		if (n < MAX_PARITY_REOPENS) {
			reopenUnit(o.ledger, unitId, note, `parity: answers differ from the old app (${found.length})`);
			o.ledger.updateUnit(unitId, { meta: { parityReopens: n + 1 } });
			reopened.push(unitId);
		} else if (parityLeft) {
			log(pc.dim(`parity ${o.slice}: ${unitId} still differs; the owner said to leave it (#${parityLeft})`));
		} else {
			await askViaModel(
				{ ledger: o.ledger, config: o.config, root: o.root, client: o.client },
				{ point: "parity", unitId, facts: `${note}\nThe unit was re-opened ${n} times for this and still differs.`, options: [{ value: "retry", facts: "re-open it once more" }, { value: "leave", facts: "leave it as it is" }], recommended: "leave", blocks: "none", askedBy: "parity", sameAs: `parity:${unitId}` },
			).catch(() => undefined);
		}
	}
	const bugCount = [...bugs.values()].reduce((a, b) => a + b.length, 0) + sharedBugs;
	const stillOpen = (db.prepare("SELECT COUNT(*) AS n FROM parity_diffs WHERE run_id = ? AND status = 'open'").get(o.runId) as { n: number }).n;
	log(pc.cyan(`parity ${o.slice}: ${bugCount} bug(s)${reopened.length ? ` → re-opened ${reopened.join(", ")}` : ""}${sharedIds.size ? ` → shared cause ${[...sharedIds].join(", ")} (one code job)` : ""}, ${quirks} quirk(s) for the owner, ${allowed} allowed${setup ? `, ${setup} from the test setup` : ""}${stillOpen ? `, ${stillOpen} not judged` : ""}`));
	return { reopened, bugs: bugCount, quirks, setup, allowed, open: stillOpen, shared: [...sharedIds] };
}

const short = (v: string | null, n = 200) => (v && v.length > n ? `${v.slice(0, n)}…` : (v ?? "null"));
const describe = (d: Pick<DiffRow, "step" | "route" | "kind" | "path" | "legacy" | "target">) => `step ${d.step} (${d.route}) ${d.kind}${d.path ? ` at ${d.path}` : ""}: old ${short(d.legacy)}, new ${short(d.target)}`;
