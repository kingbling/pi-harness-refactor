import type { SourceAdapter, TargetAdapter } from "./types.ts";
import { phpAdapter } from "./source/php.ts";
import { fromManifest, loadManifests } from "./target/generated.ts";
import { fromSourceManifest, loadSourceManifests } from "./source/generated.ts";
import { withLayoutRules } from "../rules/layout-rules.ts";
import { withCommandOverrides } from "./command-overrides.ts";

const sources: Record<string, SourceAdapter> = { php: phpAdapter };
/** Source adapters a model wrote, with the workspace each belongs to (a long-lived Pi may serve several). */
const generatedSources = new Map<string, string>();
/** Built-in, or written for the current workspace. */
const inWorkspace = (id: string) => {
	const ws = generatedSources.get(id);
	return ws === undefined || !process.env["BR_WORKSPACE"] || ws === process.env["BR_WORKSPACE"];
};
/**
 * Target adapters load lazily; what init and placement need synchronously is declared next to the loader.
 * A test asserts every manifest matches its adapter (role, subdir, aliases).
 */
const targetManifest: Record<string, { role: "server" | "ui"; subdir: string; aliases: string[]; generated?: boolean; load: () => Promise<TargetAdapter> }> = {
	nestjs: { role: "server", subdir: "api", aliases: ["nest"], load: async () => (await import("./target/nestjs.ts")).nestjsAdapter },
	react: { role: "ui", subdir: "web", aliases: ["reactjs"], load: async () => (await import("./target/react.ts")).reactAdapter },
};
const targets: Record<string, () => Promise<TargetAdapter>> = Object.fromEntries(Object.entries(targetManifest).map(([id, m]) => [id, m.load]));

/** The source adapter, or undefined when neither a built-in nor a workspace-generated one has this id. */
export function findSourceAdapter(id: string): SourceAdapter | undefined {
	if ((!sources[id] || !inWorkspace(id)) && process.env["BR_WORKSPACE"]) registerGeneratedSources(process.env["BR_WORKSPACE"]);
	return sources[id] && inWorkspace(id) ? sources[id] : undefined;
}
export function getSourceAdapter(id: string): SourceAdapter {
	const a = findSourceAdapter(id);
	if (!a) throw new Error(`unknown source adapter "${id}" (have: ${Object.keys(sources).join(", ")}; br source-adapter has a model write one)`);
	return a;
}
export async function getTargetAdapter(id: string): Promise<TargetAdapter> {
	if (!targets[id] && process.env["BR_WORKSPACE"]) registerGeneratedTargets(process.env["BR_WORKSPACE"]);
	const f = targets[id];
	if (!f) throw new Error(`unknown target adapter "${id}" (have: ${Object.keys(targets).join(", ")})`);
	return offerable(withCommandOverrides(withLayoutRules(await f(), process.env["BR_WORKSPACE"]), process.env["BR_WORKSPACE"]));
}

/** Options setup cannot produce (`unavailable`) are never offered, recommended or resolved: a choice must be installable. */
function offerable(t: TargetAdapter): TargetAdapter {
	if (!t.stackChoices?.some((c) => c.options.some((o) => o.unavailable))) return t;
	return { ...t, stackChoices: t.stackChoices.map((c) => ({ ...c, options: c.options.filter((o) => !o.unavailable) })) };
}
/** Each target adapter's `subdir`, known without loading it. */
export const TARGET_SUBDIRS: Record<string, string> = Object.fromEntries(Object.entries(targetManifest).map(([id, m]) => [id, m.subdir]));
/** Each target adapter's `role`, known without loading it. */
export const TARGET_ROLES: Record<string, "server" | "ui"> = Object.fromEntries(Object.entries(targetManifest).map(([id, m]) => [id, m.role]));
/** A user's name for a target stack ("Nest", "reactjs") → its adapter id. */
export function targetIdFor(name: string): string | undefined {
	const n = name.toLowerCase();
	return Object.entries(targetManifest).find(([id, m]) => id === n || m.aliases.includes(n))?.[0];
}
export const knownSources = () => {
	if (process.env["BR_WORKSPACE"]) registerGeneratedSources(process.env["BR_WORKSPACE"]);
	return Object.keys(sources).filter(inWorkspace);
};

/**
 * Source adapters a model wrote for this workspace (`.bigrefactor/adapters/source/*.json`, verified before they
 * were saved) join the registry; hand-written adapters keep precedence. Idempotent; returns the ids added.
 */
export function registerGeneratedSources(root: string): string[] {
	const added: string[] = [];
	for (const m of loadSourceManifests(root)) {
		if (sources[m.id] && !generatedSources.has(m.id)) continue;
		sources[m.id] = fromSourceManifest(m, root);
		generatedSources.set(m.id, root);
		added.push(m.id);
	}
	return added;
}
export const knownTargets = () => Object.keys(targets);

/**
 * Adapters a model wrote for this workspace (`.bigrefactor/adapters/*.json`, verified before they were saved)
 * join the registry; hand-written adapters keep precedence. Idempotent; returns the ids added.
 */
export function registerGeneratedTargets(root: string): string[] {
	const added: string[] = [];
	for (const m of loadManifests(root)) {
		if (targetManifest[m.id] && !targetManifest[m.id]!.generated) continue;
		const adapter = fromManifest(m);
		targetManifest[m.id] = { role: m.role, subdir: m.subdir, aliases: m.aliases, generated: true, load: async () => adapter };
		targets[m.id] = targetManifest[m.id]!.load;
		TARGET_SUBDIRS[m.id] = m.subdir;
		TARGET_ROLES[m.id] = m.role;
		added.push(m.id);
	}
	return added;
}
