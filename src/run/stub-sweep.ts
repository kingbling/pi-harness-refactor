import pc from "picocolors";
import type { Ledger } from "../ledger/db.ts";
import { exec } from "../proc.ts";

/**
 * Stubs nobody will replace: a TODO(br:<owner>) mark on main whose owner is accepted (it will not run again) or
 * names no unit at all. Units are told not to copy such marks, but the ones already on main stay, keep being copied,
 * and leave production code stubbed for good. After a merge the run looks for them on main and hands each one once
 * to a code job, which replaces the stub with real code (or points its callers at the code that exists).
 */

export interface DeadMark {
	file: string;
	line: number;
	owner: string;
	/** the owner is an accepted unit (else it names no unit) */
	accepted: boolean;
	text: string;
}

/** The marks in `dir`'s tracked files whose owner is accepted or names no unit. */
export async function deadStubMarks(ledger: Ledger, dir: string): Promise<DeadMark[]> {
	let out: string;
	try {
		out = await exec("git", ["grep", "-n", "-E", "TODO\\(br:[^)]+\\)", "--", "."], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
	} catch {
		return []; // no match, or not a repo
	}
	const marks: DeadMark[] = [];
	for (const l of out.split("\n")) {
		const m = /^(.+?):(\d+):(.*)$/.exec(l);
		if (!m) continue;
		for (const o of m[3]!.matchAll(/TODO\(br:([^)]+)\)/g)) {
			const owner = o[1]!.trim();
			const u = ledger.getUnit(owner);
			if (!u || u.state === "accepted") marks.push({ file: m[1]!, line: Number(m[2]), owner, accepted: !!u, text: m[3]!.trim().slice(0, 200) });
		}
	}
	return marks;
}

const HANDED = "stub_sweep_handed";
/** Marks per code job: a job with hundreds of stubs would not finish; the next merge hands the next ones. */
export const SWEEP_BATCH = 25;

export function stubSweepPrompt(marks: DeadMark[]): string {
	return `Some code on main is still a stub marked TODO(br:<owner>), and no unit will ever come back to replace it: its owner is already accepted, or it names no unit. Replace each stub below with the real behaviour (read the legacy code for it), or point its callers at code that already does it (search the project), and remove the mark. Write tests for what you add. Leave every other TODO(br:...) mark alone.
${marks.map((m) => `- ${m.file}:${m.line}  TODO(br:${m.owner}) (${m.accepted ? `${m.owner} is accepted` : "names no unit"})  ${m.text}`).join("\n")}`;
}

/**
 * After merges: one sweep at a time per stack; each mark (owner + file) is handed once, kept in the ledger so a new
 * run does not hand it again. A job that does not merge leaves its marks handed: they are not tried after every merge.
 */
export function createStubSweep(o: {
	ledger: Ledger;
	/** the stack's project dir on main */
	dirOf: (stackId: string) => string;
	/** runs a code job for the stack; resolves when it ends */
	codeJob: (stackId: string, what: string) => Promise<unknown>;
	log: (l: string) => void;
}): { afterMerge(stackId: string): Promise<void> | undefined; idle(): Promise<unknown> } {
	const running = new Map<string, Promise<void>>();
	const handed = (): Set<string> => new Set(JSON.parse(o.ledger.getMeta(HANDED) ?? "[]") as string[]);
	const sweep = async (stackId: string) => {
		const done = handed();
		const key = (m: DeadMark) => `${stackId}\0${m.owner}\0${m.file}`;
		const fresh = (await deadStubMarks(o.ledger, o.dirOf(stackId))).filter((m) => !done.has(key(m)));
		if (!fresh.length) return;
		// whole files at a time, so a file's stubs are replaced together
		const files = [...new Set(fresh.map((m) => m.file))];
		const batch: DeadMark[] = [];
		for (const f of files) {
			const of = fresh.filter((m) => m.file === f);
			if (batch.length && batch.length + of.length > SWEEP_BATCH) break;
			batch.push(...of);
		}
		for (const m of batch) done.add(key(m));
		o.ledger.setMeta(HANDED, JSON.stringify([...done]));
		o.log(pc.cyan(`stub sweep ${stackId}: ${batch.length} stub(s) no unit will replace go to a code job (${fresh.length - batch.length} left for later)`));
		await o.codeJob(stackId, stubSweepPrompt(batch));
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
