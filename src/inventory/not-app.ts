import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExternalDep, SourceAdapter } from "../adapters/types.ts";

/**
 * Folders of the legacy repo that are not the app's own code (tooling, static-analysis stubs, vendored libraries,
 * docs, one-off scripts, tests), as the framework-profile model found them while it read the repo
 * (`notApp` in .bigrefactor/framework-profile.json, with a reason each). Language-neutral: the inventory leaves them
 * out on top of the adapter's minimal defaults, and a vendored library becomes a library decision like a
 * package-manager dependency.
 */
export const NOT_APP_KINDS = ["tooling", "stubs", "vendored", "docs", "scripts", "tests"] as const;
export interface NotAppFolder {
	/** Folder prefix relative to the legacy root, trailing slash. */
	path: string;
	kind: (typeof NOT_APP_KINDS)[number];
	why: string;
	/** Vendored: the library's name. */
	name?: string;
}

/** The text the profile model gets about `notApp` (its part of the profile format). */
export const NOT_APP_DOC = `notApp (array of {path: folder prefix relative to the legacy root with a trailing slash, kind: ${NOT_APP_KINDS.join("|")}, why: what you saw, name?: the library's name when kind is vendored}): folders that are NOT the app's own code to migrate — build/dev tooling, static-analysis stubs, third-party libraries copied into the repo (vendored, not installed by the package manager), documentation, one-off scripts (installers/upgrades already run), test suites. Only folders you looked into; never a folder that holds entry points or app code; [] when there are none.`;

export function loadNotApp(workspace: string | undefined): NotAppFolder[] {
	const p = workspace ? join(workspace, ".bigrefactor", "framework-profile.json") : undefined;
	if (!p || !existsSync(p)) return [];
	try {
		const j = JSON.parse(readFileSync(p, "utf8")) as { notApp?: NotAppFolder[] };
		return Array.isArray(j.notApp) ? j.notApp.filter((f) => f && typeof f.path === "string" && f.path.replace(/^\.?\/+/, "")).map((f) => ({ ...f, path: f.path.replace(/^\.?\/+/, "").replace(/\/?$/, "/") })) : [];
	} catch {
		return [];
	}
}

export function notAppOf(path: string, folders: NotAppFolder[]): NotAppFolder | undefined {
	return folders.find((f) => path.startsWith(f.path));
}

/** Problems with the profile's notApp list (shape; every folder must exist in the legacy repo). */
export function validateNotApp(json: unknown, sourceRoot: string): string[] {
	const list = (json as { notApp?: unknown }).notApp;
	if (list === undefined) return [];
	if (!Array.isArray(list)) return ["notApp must be an array"];
	const problems: string[] = [];
	for (const f of list as Array<Partial<NotAppFolder>>) {
		if (!f || typeof f.path !== "string" || !f.path) problems.push(`notApp entry ${JSON.stringify(f)} needs a path`);
		else if (!existsSync(join(sourceRoot, f.path))) problems.push(`notApp folder ${f.path} does not exist in the legacy repo`);
		if (!NOT_APP_KINDS.includes(f?.kind as NotAppFolder["kind"])) problems.push(`notApp ${f?.path}: kind must be one of ${NOT_APP_KINDS.join("|")}`);
		if (!f?.why) problems.push(`notApp ${f?.path}: say why`);
	}
	return problems;
}

/** The legacy app's libraries: the package manager's (adapter) plus vendored folders the profile model found. */
export function legacyLibraries(source: SourceAdapter, sourceRoot: string): ExternalDep[] {
	const deps = source.externalDeps?.(sourceRoot) ?? [];
	const vendored = loadNotApp(process.env["BR_WORKSPACE"])
		.filter((f) => f.kind === "vendored")
		.map((f): ExternalDep => ({ name: f.name?.trim() || basename(f.path), verdict: "review", note: `vendored copy in ${f.path}: ${f.why}` }));
	return [...deps, ...vendored.filter((v) => !deps.some((d) => d.name === v.name))];
}
