import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TargetAdapter } from "./types.ts";

/** A stack's gate commands can be replaced per workspace (.bigrefactor/commands/<stack>.json), e.g. by the setup fixer when a tool's new major version dropped a flag. */
export interface Cmd {
	cmd: string;
	args: string[];
}
/** Per-workspace replacements of a stack's gate commands; `{files}` in an arg expands to the files (may be none). */
export type CommandOverrides = Partial<Record<"build" | "lint" | "test", Cmd>> & {
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

export function loadCommandOverrides(root: string | undefined, stackId: string): CommandOverrides {
	if (!root || !existsSync(overridesPath(root, stackId))) return {};
	try {
		return JSON.parse(readFileSync(overridesPath(root, stackId), "utf8")) as CommandOverrides;
	} catch {
		return {};
	}
}

export function saveCommandOverride(root: string, stackId: string, step: "build" | "lint" | "test", c: Cmd, why: string): void {
	const cur = loadCommandOverrides(root, stackId);
	const p = overridesPath(root, stackId);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, JSON.stringify({ ...cur, [step]: c, why: [cur.why, `${step}: ${why}`].filter(Boolean).join("; ") }, null, 2) + "\n");
}

const expand = (c: Cmd, files: string[]): Cmd => ({ cmd: c.cmd, args: c.args.flatMap((a) => (a === "{files}" ? files : [a])) });

/** The adapter with this workspace's command overrides (read on every call: a fix applies at once). */
export function withCommandOverrides(adapter: TargetAdapter, root: string | undefined): TargetAdapter {
	if (!root) return adapter;
	const o = () => loadCommandOverrides(root, adapter.id);
	return {
		...adapter,
		build: (r) => o().build ?? adapter.build(r),
		lint: (r, files) => (o().lint ? expand(o().lint!, files) : adapter.lint(r, files)),
		test: (r, files) => (o().test ? expand(o().test!, files) : adapter.test(r, files)),
	};
}


export function saveWorktreeCopy(root: string, stackId: string, dir: string, why: string): void {
	const cur = loadCommandOverrides(root, stackId);
	const p = overridesPath(root, stackId);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, JSON.stringify({ ...cur, worktreeCopy: [...new Set([...(cur.worktreeCopy ?? []), dir])], why: [cur.why, `worktree copy of ${dir}: ${why}`].filter(Boolean).join("; ") }, null, 2) + "\n");
}
