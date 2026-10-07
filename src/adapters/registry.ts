import type { SourceAdapter, TargetAdapter } from "./types.ts";
import { phpAdapter } from "./source/php.ts";

const sources: Record<string, SourceAdapter> = { php: phpAdapter };
/**
 * Target adapters load lazily; what init and placement need synchronously is declared next to the loader.
 * A test asserts every manifest matches its adapter (role, subdir, aliases).
 */
const targetManifest: Record<string, { role: "server" | "ui"; subdir: string; aliases: string[]; load: () => Promise<TargetAdapter> }> = {
	nestjs: { role: "server", subdir: "api", aliases: ["nest"], load: async () => (await import("./target/nestjs.ts")).nestjsAdapter },
	react: { role: "ui", subdir: "web", aliases: ["reactjs"], load: async () => (await import("./target/react.ts")).reactAdapter },
};
const targets = Object.fromEntries(Object.entries(targetManifest).map(([id, m]) => [id, m.load]));

export function getSourceAdapter(id: string): SourceAdapter {
	const a = sources[id];
	if (!a) throw new Error(`unknown source adapter "${id}" (have: ${Object.keys(sources).join(", ")})`);
	return a;
}
export async function getTargetAdapter(id: string): Promise<TargetAdapter> {
	const f = targets[id];
	if (!f) throw new Error(`unknown target adapter "${id}" (have: ${Object.keys(targets).join(", ")})`);
	return offerable(await f());
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
export const knownSources = () => Object.keys(sources);
export const knownTargets = () => Object.keys(targets);
