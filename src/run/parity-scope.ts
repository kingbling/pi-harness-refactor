import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** These are test inputs, not exemptions for mismatching outputs. All are retained in the proof. */
export interface VerificationScope {
	version: 1;
	fixture: { name: string; files: string[] };
	/** Runtime configuration overlays only. Business behavior must still come from the pinned source. */
	legacyOverrides?: Array<{ path: string; why: string }>;
	/** The fixture files each app's setup model recorded (set_fixture_files); `fixture.files` is all of them. */
	by?: Record<string, string[]>;
	/** When the old app's fixture last changed (its files or their content): a new app's reset must load the same data again after it. */
	legacyAt?: string;
	legacyHash?: string;
}

export const scopePath = (root: string) => join(root, ".bigrefactor", "parity", "scope.json");

/** Why a recorded fixture file cannot be fingerprinted later, or undefined. */
export function fixtureFileProblem(root: string, f: string): string | undefined {
	const p = resolve(root, f);
	// the new app's parity worktree is made and removed for every check: its tracked files are the target commit's
	if (p.startsWith(join(resolve(root), ".bigrefactor", "worktrees") + "/")) return `${f} is inside a temporary worktree (removed after each check): record the file it is made from instead (keep local overlays in .bigrefactor/parity); the new app's own tracked files are covered by its commit`;
	if (!existsSync(p) || !statSync(p).isFile()) return `${f} is not a file (paths are relative to the workspace ${root}, or absolute)`;
	return undefined;
}

export function loadScope(root: string): VerificationScope {
	const scope = JSON.parse(readFileSync(scopePath(root), "utf8")) as VerificationScope;
	if (scope?.version !== 1 || typeof scope.fixture?.name !== "string" || !scope.fixture.name.trim() || !Array.isArray(scope.fixture.files) || !scope.fixture.files.length || scope.fixture.files.some((p) => typeof p !== "string" || !p.trim()))
		throw new Error("scope.json needs version:1 and fixture:{name,files:[snapshot/reset/config input paths]}");
	if (scope.legacyOverrides !== undefined && (!Array.isArray(scope.legacyOverrides) || scope.legacyOverrides.some((p) => !p || typeof p.path !== "string" || !p.path || p.path.startsWith("/") || p.path.split(/[\\/]/).includes("..") || typeof p.why !== "string" || !p.why.trim())))
		throw new Error("scope.json legacyOverrides need source-relative path and why");
	return scope;
}

/** The scope, or undefined when it is missing or invalid. */
export function scopeIfValid(root: string): VerificationScope | undefined {
	try {
		return loadScope(root);
	} catch {
		return undefined;
	}
}

/**
 * One app's fixture files (set_fixture_files): they replace what that app recorded before. The old app's
 * `overrides` replace its declared config overlays and mark its fixture as changed. Returns why it is refused.
 */
export function recordFixture(root: string, side: string, files: string[], overrides?: Array<{ path: string; why: string }>): string | undefined {
	if (!files.length) return "give at least one file (the seed data, the reset script)";
	for (const f of files) {
		const bad = fixtureFileProblem(root, f);
		if (bad) return bad;
	}
	if (overrides?.some((o) => !o.path || o.path.startsWith("/") || o.path.split(/[\\/]/).includes("..") || !o.why?.trim())) return "each override needs a path relative to the legacy repo and why";
	let cur: Partial<VerificationScope> = {};
	try {
		cur = JSON.parse(readFileSync(scopePath(root), "utf8")) as VerificationScope;
	} catch {
		/* a new scope */
	}
	const by = { ...(cur.by ?? {}), [side]: [...new Set(files)].sort() };
	// the old app's overrides replace the declared ones when given (an empty list clears them)
	const overlays = side === "legacy" && overrides ? overrides : cur.legacyOverrides;
	const hash = side === "legacy" ? createHash("sha256").update(JSON.stringify(by[side]!.map((f) => [f, createHash("sha256").update(readFileSync(resolve(root, f))).digest("hex")]))).digest("hex") : cur.legacyHash;
	const legacyAt = side === "legacy" && hash !== cur.legacyHash ? new Date().toISOString() : cur.legacyAt;
	const next: VerificationScope = {
		version: 1,
		fixture: { name: cur.fixture?.name || "migration-fixture", files: [...new Set(Object.values(by).flat())] },
		...(overlays?.length ? { legacyOverrides: overlays } : {}),
		by,
		...(legacyAt ? { legacyAt, legacyHash: hash } : {}),
	};
	mkdirSync(dirname(scopePath(root)), { recursive: true });
	writeFileSync(`${scopePath(root)}.tmp`, JSON.stringify(next, null, 2) + "\n");
	renameSync(`${scopePath(root)}.tmp`, scopePath(root));
	return undefined;
}
