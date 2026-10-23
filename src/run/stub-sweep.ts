import pc from "picocolors";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Config } from "../config.ts";
import type { Ledger } from "../ledger/db.ts";
import { PLAIN_LANGUAGE } from "../policy.ts";
import { exec } from "../proc.ts";
import { spawnLeaf } from "../sessions/spawn.ts";

/**
 * Stubs nobody will replace: a TODO(br:<owner>) mark on main whose owner is accepted (it will not run again) or
 * names no unit at all. Units are told not to copy such marks, but the ones already on main stay, keep being copied,
 * and leave production code stubbed for good. After a merge the run looks for them on main (every stack: a backend
 * unit's marks may sit in the frontend, where only a code job of that stack can replace them) and hands them to a
 * code job, which replaces the stub with real code (or points its callers at the code that exists).
 *
 * Older marks name their owner loosely (a legacy file name like "sales.controller", a short id like "U2159"). The
 * owner name is read as the exact unit id, else as a short "U<number>" id one unit starts with, else a model with
 * ledger lookups decides once which unit it means (kept in the ledger). A mark of a unit still to come is that unit's.
 */

export interface DeadMark {
	file: string;
	line: number;
	owner: string;
	/** the owner is an accepted unit (else it names no unit) */
	accepted: boolean;
	/** the unit the owner name stands for, when it is not the exact id */
	unit?: string;
	text: string;
}

const NAMES = "stub_owner_names";
/** Loose owner names a model looked at: name → the unit it means, or null for none. */
function ownerNames(ledger: Ledger): Record<string, string | null> {
	return JSON.parse(ledger.getMeta(NAMES) ?? "{}") as Record<string, string | null>;
}

/**
 * The unit a mark's owner name stands for: the exact id, a short "U<number>" id exactly one unit starts with, or
 * what the model decided for that name. Undefined: no unit (or not looked at yet).
 */
export function markOwner(ledger: Ledger, name: string): string | undefined {
	if (ledger.getUnit(name)) return name;
	if (/^U\d+$/.test(name)) {
		const rows = ledger.db.prepare("SELECT id FROM units WHERE id LIKE ? ESCAPE '\\' LIMIT 2").all(`${name}\\_%`) as Array<{ id: string }>;
		if (rows.length === 1) return rows[0]!.id;
	}
	const known = ownerNames(ledger)[name];
	return known && ledger.getUnit(known) ? known : undefined;
}

/** The names marks may use for this unit: its id, its short "U<number>" id when only it starts with it, and the loose names the model gave it. */
export function stubNames(ledger: Ledger, unitId: string): string[] {
	const short = /^(U\d+)_/.exec(unitId)?.[1];
	const names = [unitId, ...(short && markOwner(ledger, short) === unitId ? [short] : [])];
	for (const [n, u] of Object.entries(ownerNames(ledger))) if (u === unitId && !names.includes(n)) names.push(n);
	return names;
}

/** `git grep` arguments that find the marks of any of `names` (fixed strings). */
export function markPatterns(names: string[]): string[] {
	return ["-F", ...names.flatMap((n) => ["-e", `TODO(br:${n})`])];
}

/** Every mark in `dir`'s tracked files: file, line, owner name, the line's text. */
async function allMarks(dir: string): Promise<Array<{ file: string; line: number; owner: string; text: string }>> {
	let out: string;
	try {
		out = await exec("git", ["grep", "-n", "-E", "TODO\\(br:[^)]+\\)", "--", "."], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
	} catch {
		return []; // no match, or not a repo
	}
	const marks: Array<{ file: string; line: number; owner: string; text: string }> = [];
	for (const l of out.split("\n")) {
		const m = /^(.+?):(\d+):(.*)$/.exec(l);
		if (!m) continue;
		for (const o of m[3]!.matchAll(/TODO\(br:([^)]+)\)/g)) marks.push({ file: m[1]!, line: Number(m[2]), owner: o[1]!.trim(), text: m[3]!.trim().slice(0, 200) });
	}
	return marks;
}

/** Open units retain their stub ownership while a shared integration job works beside them. */
export async function reservedStubMarks(ledger: Ledger, dir: string, served: string[]): Promise<Array<{ file: string; line: number; owner: string; unit: string }>> {
	const marks: Array<{ file: string; line: number; owner: string; unit: string }> = [];
	for (const m of await allMarks(dir)) {
		const unit = markOwner(ledger, m.owner);
		if (unit && !served.includes(unit) && ledger.getUnit(unit)?.state !== "accepted") marks.push({ file: m.file, line: m.line, owner: m.owner, unit });
	}
	return marks;
}

/** The marks in `dir`'s tracked files whose owner is accepted or names no unit. */
export async function deadStubMarks(ledger: Ledger, dir: string): Promise<DeadMark[]> {
	const out: DeadMark[] = [];
	for (const m of await allMarks(dir)) {
		const unit = markOwner(ledger, m.owner);
		const u = unit ? ledger.getUnit(unit) : undefined;
		if (!u || u.state === "accepted") out.push({ ...m, accepted: !!u, ...(unit && unit !== m.owner ? { unit } : {}) });
	}
	return out;
}

/** The owner names in `dir`'s marks that are no unit id, no short id, and no model has looked at yet. */
export async function unknownOwnerNames(ledger: Ledger, dir: string): Promise<string[]> {
	const seen = ownerNames(ledger);
	return [...new Set((await allMarks(dir)).map((m) => m.owner))].filter((n) => !markOwner(ledger, n) && !(n in seen));
}

/** Decides which unit each loose owner name means; null when it means none. */
export type OwnerResolver = (names: string[]) => Promise<Record<string, string | null>>;

/**
 * A model with ledger lookups (unit ids, the units' legacy files, legacy symbols) and the legacy repo decides which
 * unit each loose owner name means. A name it gives no answer for counts as no unit.
 */
export function resolveOwnersWithModel(o: { ledger: Ledger; config: Config; spawn?: typeof spawnLeaf }): OwnerResolver {
	return async (names) => {
		const found: Record<string, string | null> = {};
		const lookup = {
			name: "unit_lookup",
			label: "Unit lookup",
			description: "Find migration units by a part of their id or of their legacy file paths (e.g. 'sales', 'booking.controller', 'U2159'). Returns id, state, stack and legacy files.",
			parameters: Type.Object({ query: Type.String() }),
			execute: async (_id: string, p: { query: string }) => {
				const q = `%${p.query}%`;
				const rows = o.ledger.db.prepare("SELECT id, state, meta FROM units WHERE id LIKE ? OR json_extract(meta, '$.files') LIKE ? ORDER BY id LIMIT 20").all(q, q) as Array<{ id: string; state: string; meta: string }>;
				const line = (r: { id: string; state: string; meta: string }) => {
					const m = JSON.parse(r.meta) as { files?: string[]; place?: { stack?: string } };
					return `${r.id} [${r.state}${m.place?.stack ? `, ${m.place.stack}` : ""}] ${(m.files ?? []).slice(0, 5).join(", ")}`;
				};
				return { content: [{ type: "text" as const, text: rows.length ? rows.map(line).join("\n") : `no unit matches "${p.query}"` }], details: {} };
			},
		};
		const symbols = {
			name: "symbol_lookup",
			label: "Symbol lookup",
			description: "Find a legacy symbol by its id or name: its file and the unit that migrates it.",
			parameters: Type.Object({ query: Type.String() }),
			execute: async (_id: string, p: { query: string }) => {
				const rows = o.ledger.db.prepare("SELECT id, unit_id FROM symbols WHERE id = ? OR name = ? OR id LIKE ? LIMIT 15").all(p.query, p.query, `%${p.query}%`) as Array<{ id: string; unit_id: string | null }>;
				return { content: [{ type: "text" as const, text: rows.length ? rows.map((r) => `${r.id} → unit ${r.unit_id ?? "-"}`).join("\n") : `no symbol matches "${p.query}"` }], details: {} };
			},
		};
		const verdict = {
			name: "stub_owners",
			label: "Stub owners",
			description: "Your answer: for each name, the exact unit id it means, or null when it means no unit (or more than one and none of them owns the stub).",
			parameters: Type.Object({ owners: Type.Array(Type.Object({ name: Type.String(), unit: Type.Union([Type.String(), Type.Null()]), why: Type.String() })) }),
			execute: async (_id: string, p: { owners: Array<{ name: string; unit: string | null }> }) => {
				const wrong: string[] = [];
				for (const a of p.owners) {
					if (!names.includes(a.name)) continue;
					if (a.unit && !o.ledger.getUnit(a.unit)) wrong.push(a.unit);
					else found[a.name] = a.unit ?? null;
				}
				return { content: [{ type: "text" as const, text: wrong.length ? `no such unit: ${wrong.join(", ")}; use exact ids from unit_lookup and call stub_owners again for those names` : "recorded; stop here" }], details: {} };
			},
		};
		const session = await (o.spawn ?? spawnLeaf)({
			role: "review",
			cwd: o.config.source.path,
			config: o.config,
			writeGlobs: [],
			customTools: [lookup, symbols, verdict] as unknown as ToolDefinition[],
			systemPrompt: `Code under migration has stub marks TODO(br:<owner>): the owner is the migration unit that replaces the stub with its code when it runs. Some marks name their owner loosely: a legacy file name ("sales.controller"), a short id ("U2159"), a few words. For each name below, find the one unit it means with your tools (unit_lookup searches unit ids and the units' legacy files; you are in the legacy repo, so you can read the file the name points at). Answer with stub_owners once: the exact unit id, or null when no unit migrates that code. When a name lists several units, pick the one whose code the stub stands for, else null.\n\n${PLAIN_LANGUAGE}`,
		});
		try {
			await session.run(`Owner names:\n${names.map((n) => `- ${n}`).join("\n")}`);
		} finally {
			session.dispose();
		}
		return found;
	};
}

/** Asks the resolver about the names no one has looked at yet and keeps its answers in the ledger. */
export async function learnOwnerNames(ledger: Ledger, names: string[], resolve: OwnerResolver, log: (l: string) => void): Promise<void> {
	if (!names.length) return;
	const got = await resolve(names);
	// a name without an answer is not asked again after every merge: it counts as no unit
	const known = { ...ownerNames(ledger), ...Object.fromEntries(names.map((n) => [n, got[n] ?? null])) };
	ledger.setMeta(NAMES, JSON.stringify(known));
	const named = Object.entries(got).filter(([, u]) => u);
	log(pc.cyan(`stub marks: ${named.length} of ${names.length} loose owner name(s) mean a unit${named.length ? ` (${named.slice(0, 5).map(([n, u]) => `${n} → ${u}`).join(", ")}${named.length > 5 ? ", …" : ""})` : ""}`));
}

const HANDED = "stub_sweep_handed";
const ASKED = "stub_sweep_asked";
/** Marks (key) whose spent tries were handed once to a code job of the other stacks (what the stubs wait for there). */
const BACKED = "stub_sweep_backed";
/** Marks per code job: a job with hundreds of stubs would not finish; the next merge hands the next ones. */
export const SWEEP_BATCH = 25;
/** Code jobs one mark gets: a job that did not merge (a race with a unit, a merge conflict) leaves the mark on main. */
export const SWEEP_TRIES = 3;

export function stubSweepPrompt(marks: DeadMark[], repo?: string): string {
	const who = (m: DeadMark) => (m.accepted ? `${m.unit ?? m.owner} is accepted` : "names no unit");
	return `Some code on main is still a stub marked TODO(br:<owner>), and no unit will ever come back to replace it: its owner is already accepted, or it names no unit. Replace each stub below with the real behaviour (read the legacy code for it), or point its callers at code that already does it (search the project), and remove the mark. Write tests for what you add. Leave every other TODO(br:...) mark alone.${repo ? ` The repo's other stacks are next to this project in ${repo}: an accepted owner's code may be there (e.g. the endpoint a page calls); read it to call it the way it works.` : ""}
${marks.map((m) => `- ${m.file}:${m.line}  TODO(br:${m.owner}) (${who(m)})  ${m.text}`).join("\n")}`;
}

/** For the other stacks: the stubs of one stack still wait for something there (often a frontend page waiting for its data). */
export function stubBackPrompt(marks: DeadMark[], stackId: string): string {
	return `Code jobs of the ${stackId} project could not replace the stubs below (TODO(br:<owner>) marks; no unit will come back for them). Most often they wait for something in THIS project: the data, route or endpoint the ${stackId} code needs (read the stub texts and the ${stackId} code around them, and the legacy code for the behaviour). Add what is missing here, with tests, the way this project already does it (search for a similar endpoint first). Do not edit the ${stackId} project; its stubs get another code job after yours.
${marks.map((m) => `- ${m.file}:${m.line}  TODO(br:${m.owner})  ${m.text}`).join("\n")}`;
}

/**
 * After merges: one sweep at a time per stack. Each mark (owner + file) goes to a code job up to SWEEP_TRIES times,
 * kept in the ledger so a new run counts on: marks no job has had come first, a mark still on main after its job is
 * tried again. A mark still there after its last try goes once to a code job of each other stack (a page's stub
 * often waits for its data or endpoint there), then gets one more try here. After that it stays for the finish check's
 * report: no "retry or leave" question to the owner (a model or code settles that). Owner answers "retry" to earlier
 * questions still give new tries.
 */
export function createStubSweep(o: {
	ledger: Ledger;
	/** the stack's project dir on main */
	dirOf: (stackId: string) => string;
	/** runs a code job for the stack; resolves when it ends */
	codeJob: (stackId: string, what: string) => Promise<unknown>;
	/** decides which unit loose owner names mean (none: such names count as no unit) */
	resolveOwners?: OwnerResolver;
	/** the target's other stacks, for marks this stack's jobs could not replace (none: those marks just stay) */
	otherStacks?: (stackId: string) => string[];
	/** the target repo, when it has several stacks (named in the job's prompt) */
	repo?: string;
	log: (l: string) => void;
}): { afterMerge(stackId: string): Promise<void> | undefined; idle(): Promise<unknown> } {
	const running = new Map<string, Promise<void>>();
	// older ledgers keep a list of keys handed once
	const handed = (): Record<string, number> => {
		const v = JSON.parse(o.ledger.getMeta(HANDED) ?? "{}") as string[] | Record<string, number>;
		return Array.isArray(v) ? Object.fromEntries(v.map((k) => [k, 1])) : v;
	};
	const sweep = async (stackId: string) => {
		const dir = o.dirOf(stackId);
		if (o.resolveOwners) await learnOwnerNames(o.ledger, await unknownOwnerNames(o.ledger, dir), o.resolveOwners, o.log).catch((e) => o.log(pc.yellow(`stub marks: loose owner names not resolved (${e?.message ?? e}); tried again after the next merge`)));
		const tries = handed();
		const key = (m: DeadMark) => `${stackId}\0${m.owner}\0${m.file}`;
		// marks the owner was asked about (key → question): "retry" gives them new tries, any other answer leaves them
		const asked = JSON.parse(o.ledger.getMeta(ASKED) ?? "{}") as Record<string, number | null>;
		for (const [k, q] of Object.entries(asked)) {
			const question = q ? o.ledger.getQuestion(q) : undefined;
			if (question?.answer && /^retry\b/i.test(question.answer.trim())) (tries[k] = 0), delete asked[k];
			// a question an earlier version asked and nobody answered: the other stacks' code job takes it over
			else if (q && question?.status === "open") o.ledger.db.prepare("UPDATE questions SET status = 'withdrawn', answer = ?, answered_at = ? WHERE id = ? AND status = 'open'").run("withdrawn: a code job of the other stacks adds what the stubs wait for, then they get one more try", new Date().toISOString(), q);
		}
		o.ledger.setMeta(ASKED, JSON.stringify(asked));
		const dead = await deadStubMarks(o.ledger, dir);
		// tries spent here: once, the other stacks get a code job for what the stubs wait for there, then one more try here
		const backed = JSON.parse(o.ledger.getMeta(BACKED) ?? "{}") as Record<string, 1>;
		const spent = dead.filter((m) => (tries[key(m)] ?? 0) >= SWEEP_TRIES && !backed[key(m)]).slice(0, SWEEP_BATCH);
		const others = o.otherStacks?.(stackId) ?? [];
		if (spent.length && others.length) {
			for (const m of spent) (backed[key(m)] = 1), (tries[key(m)] = SWEEP_TRIES - 1);
			o.ledger.setMeta(BACKED, JSON.stringify(backed));
			o.ledger.setMeta(HANDED, JSON.stringify(tries));
			o.log(pc.cyan(`stub sweep ${stackId}: ${spent.length} stub(s) still there after ${SWEEP_TRIES} code jobs: ${others.join(", ")} first adds what they wait for, then they get one more try`));
			for (const other of others) await o.codeJob(other, stubBackPrompt(spent, stackId));
			return;
		}
		const open = dead.filter((m) => (tries[key(m)] ?? 0) < SWEEP_TRIES);
		if (!open.length) return;
		// the marks with the fewest tries (none first): a mark tried before waits until every new one had its job.
		// Whole files at a time, so a file's stubs are replaced together
		const level = (f: string) => Math.min(...open.filter((m) => m.file === f).map((m) => tries[key(m)] ?? 0));
		const files = [...new Set(open.map((m) => m.file))].sort((a, b) => level(a) - level(b));
		const batch: DeadMark[] = [];
		for (const f of files) {
			const of = open.filter((m) => m.file === f);
			if (batch.length && (batch.length + of.length > SWEEP_BATCH || level(f) > level(files[0]!))) break;
			batch.push(...of);
		}
		for (const m of batch) tries[key(m)] = (tries[key(m)] ?? 0) + 1;
		o.ledger.setMeta(HANDED, JSON.stringify(tries));
		const again = batch.filter((m) => tries[key(m)]! > 1).length;
		o.log(pc.cyan(`stub sweep ${stackId}: ${batch.length} stub(s) no unit will replace go to a code job${again ? ` (${again} still there after an earlier job)` : ""} (${open.length - batch.length} left for later)`));
		await o.codeJob(stackId, stubSweepPrompt(batch, o.repo));
	};
	return {
		afterMerge(stackId) {
			if (running.has(stackId)) return undefined;
			const p = sweep(stackId)
				.catch((e) => o.log(pc.yellow(`stub sweep ${stackId} failed: ${e?.message ?? e}`)))
				.finally(() => running.delete(stackId));
			running.set(stackId, p);
			return p;
		},
		/** Resolves once no sweep runs: nothing of it outlives the run. */
		idle: () => Promise.all(running.values()),
	};
}
