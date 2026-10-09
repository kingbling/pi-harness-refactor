import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { ExternalDep, SourceAdapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import type { Ledger } from "../ledger/db.ts";
import type { spawnLeaf } from "../sessions/spawn.ts";

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

/** The inventory leaves the file out: it is in a notApp folder, and not an entry point outside vendored code. */
export function leftOut(path: string, folders: NotAppFolder[], isEntryPoint?: (p: string) => boolean): boolean {
	const n = notAppOf(path, folders);
	return !!n && (n.kind === "vendored" || !isEntryPoint?.(path));
}

/**
 * A framework profile written before notApp existed: a small session reads the legacy repo and writes only the notApp
 * list (the rest of the profile stays as it is). Returns the folders added to the profile, or undefined when the
 * profile already has the list (or there is no profile, or the session wrote nothing usable: the next run asks again).
 */
export async function healNotApp(o: { config: Config; root: string; ledger: Ledger; spawn?: typeof spawnLeaf; log?: (l: string) => void }): Promise<NotAppFolder[] | undefined> {
	const profile = join(o.root, ".bigrefactor", "framework-profile.json");
	if (!existsSync(profile)) return undefined;
	const json = JSON.parse(readFileSync(profile, "utf8")) as Record<string, unknown>;
	if ("notApp" in json) return undefined;
	const src = o.config.source.path;
	const out = join(o.root, ".bigrefactor", "not-app.json");
	rmSync(out, { force: true });
	const attempt = o.ledger.startAttempt("__init__", "not-app", o.config.models.escalate.id);
	const session = await (o.spawn ?? (await import("../sessions/spawn.ts")).spawnLeaf)({
		role: "setup",
		cwd: o.root,
		config: o.config,
		writeGlobs: [".bigrefactor/not-app.json"],
		protectedGlobs: [`${relative(o.root, o.config.target.path)}/**`],
		tools: ["read", "grep", "find", "ls", "write"],
		systemPrompt: `You look through a legacy ${o.config.source.stack} repo at ${src} (read-only; never write there) and write exactly one file: .bigrefactor/not-app.json in the workspace, as {"notApp": [...]}.\n${NOT_APP_DOC}\nList the top-level folders yourself and look into every candidate before you list it. End the session right after writing the file.`,
		transcriptPath: join(o.root, ".bigrefactor", "sessions", `__init__.not-app.${attempt}.jsonl`),
	});
	let cost = 0;
	let list: Array<Partial<NotAppFolder>> | undefined;
	try {
		let task = `Write .bigrefactor/not-app.json for the legacy repo at ${src}.`;
		for (let i = 0; i < 2; i++) {
			const r = await session.run(task);
			cost += r.usage.cost;
			if (!existsSync(out)) break;
			const got = JSON.parse(readFileSync(out, "utf8")) as { notApp?: unknown };
			const problems = validateNotApp({ notApp: got.notApp ?? [] }, src);
			list = Array.isArray(got.notApp) ? got.notApp : [];
			if (!problems.length) break;
			task = `.bigrefactor/not-app.json has problems: ${problems.join("; ")}. Fix the file.`;
		}
	} catch (e: any) {
		o.log?.(`not-app folders: ${e?.message ?? e}`);
	} finally {
		session.dispose();
		o.ledger.endAttempt(attempt, { outcome: list ? "done" : "error", costUsd: cost });
	}
	if (!list) return undefined;
	// entries still wrong after the fix are left out; the rest is the model's list
	const folders = list.filter((f) => !validateNotApp({ notApp: [f] }, src).length) as NotAppFolder[];
	writeFileSync(profile, JSON.stringify({ ...json, notApp: folders }, null, 2) + "\n");
	return loadNotApp(o.root);
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
