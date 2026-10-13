import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TargetAdapter } from "./types.ts";

/** A stack's gate commands can be replaced per workspace (.bigrefactor/commands/<stack>.json), e.g. by the setup fixer when a tool's new major version dropped a flag. */
export interface Cmd {
	cmd: string;
	args: string[];
}
/** testLenient: the test command with the runner's own flags so deprecations and notices alone do not fail a run. */
export type CommandStep = "build" | "lint" | "test" | "testLenient";
/** Per-workspace replacements of a stack's gate commands; `{files}` in an arg expands to the files (may be none). */
export type CommandOverrides = Partial<Record<CommandStep, Cmd>> & {
	why?: string;
	/** Dependency dirs a unit's worktree gets as a copy (copy-on-write where the disk can) instead of a link: tools that resolve real paths (autoloaders) would otherwise load the main project's code. */
	worktreeCopy?: string[];
};

export function overridesPath(root: string, stackId: string): string {
	return join(root, ".bigrefactor", "commands", `${stackId}.json`);
}

/** One line per setup fix made during the run: a new line means parked units may work now. */
export function setupLogPath(root: string, stackId: string): string {
	return join(root, ".bigrefactor", "commands", `${stackId}.fixes.log`);
}

/**
 * Log a fix that landed for a stack (a setup fix, a resolver's code job, a widened layout, a builder repair): the
 * quarantine heal pass sees the new line and re-checks the units it may unblock right away, without waiting an hour.
 */
export function noteFix(root: string, stackId: string, sha: string | undefined, what: string): void {
	mkdirSync(dirname(setupLogPath(root, stackId)), { recursive: true });
	appendFileSync(setupLogPath(root, stackId), `${new Date().toISOString()} ${sha ?? "override"} ${what.replace(/\s+/g, " ")}\n`);
}

export function loadCommandOverrides(root: string | undefined, stackId: string): CommandOverrides {
	if (!root || !existsSync(overridesPath(root, stackId))) return {};
	try {
		return JSON.parse(readFileSync(overridesPath(root, stackId), "utf8")) as CommandOverrides;
	} catch {
		return {};
	}
}

export function saveCommandOverride(root: string, stackId: string, step: CommandStep, c: Cmd, why: string): void {
	const cur = loadCommandOverrides(root, stackId);
	const p = overridesPath(root, stackId);
	mkdirSync(dirname(p), { recursive: true });
	writeFile(p, JSON.stringify({ ...cur, [step]: c, why: [cur.why, `${step}: ${why}`].filter(Boolean).join("; ") }, null, 2) + "\n");
}

/** What the setup fixer's own tools last wrote per overrides file: a session running meanwhile does not undo it. */
const written = new Map<string, string>();
function writeFile(p: string, text: string): void {
	writeFileSync(p, text);
	written.set(p, text);
}

/**
 * Holds the stack's overrides file as it is now; `restore()` puts it back and says whether anything had changed.
 * The file decides what every later gate runs, and sessions with bash (tester, builder, tidy) could rewrite it:
 * only the setup fixer may change it (through its tools, which may run meanwhile).
 */
export function keepOverrides(root: string, stackId: string): { restore: (evenTheFixers?: boolean) => boolean } {
	const p = overridesPath(root, stackId);
	const read = () => (existsSync(p) ? readFileSync(p, "utf8") : undefined);
	const before = read();
	return {
		restore: (evenTheFixers = false) => {
			const now = read();
			if (now === before || (!evenTheFixers && now !== undefined && now === written.get(p))) return false; // unchanged, or the setup fixer's change
			if (before === undefined) rmSync(p, { force: true });
			else (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, before));
			return true;
		},
	};
}

const expand = (c: Cmd, files: string[]): Cmd => ({ cmd: c.cmd, args: c.args.flatMap((a) => (a === "{files}" ? files : [a])) });

/** The adapter with this workspace's command overrides (read on every call: a fix applies at once). */
export function withCommandOverrides(adapter: TargetAdapter, root: string | undefined): TargetAdapter {
	if (!root) return adapter;
	const o = () => loadCommandOverrides(root, adapter.id);
	return {
		...adapter,
		build: (r, files = []) => (o().build ? expand(o().build!, files) : adapter.build(r, files)),
		lint: (r, files) => (o().lint ? expand(o().lint!, files) : adapter.lint(r, files)),
		test: (r, files) => (o().test ? expand(o().test!, files) : adapter.test(r, files)),
		testLenient: (r, files) => (o().testLenient ? expand(o().testLenient!, files) : adapter.testLenient?.(r, files)),
	};
}


export function saveWorktreeCopy(root: string, stackId: string, dir: string, why: string): void {
	const cur = loadCommandOverrides(root, stackId);
	const p = overridesPath(root, stackId);
	mkdirSync(dirname(p), { recursive: true });
	writeFile(p, JSON.stringify({ ...cur, worktreeCopy: [...new Set([...(cur.worktreeCopy ?? []), dir])], why: [cur.why, `worktree copy of ${dir}: ${why}`].filter(Boolean).join("; ") }, null, 2) + "\n");
}
