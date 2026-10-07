import type { SourceAdapter, TargetAdapter } from "./types.ts";
import { phpAdapter } from "./source/php.ts";

const sources: Record<string, SourceAdapter> = { php: phpAdapter };
const targets: Record<string, () => Promise<TargetAdapter>> = {
	nestjs: async () => (await import("./target/nestjs.ts")).nestjsAdapter,
	react: async () => (await import("./target/react.ts")).reactAdapter,
};

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
/** Static mirror of each target adapter's `subdir` (adapters load lazily; init needs this synchronously). */
export const TARGET_SUBDIRS: Record<string, string> = { nestjs: "api", react: "web" };
/** Static mirror of each target adapter's `role` (placement is synchronous; adapters load lazily). */
export const TARGET_ROLES: Record<string, "server" | "ui"> = { nestjs: "server", react: "ui" };
export const knownSources = () => Object.keys(sources);
export const knownTargets = () => Object.keys(targets);
