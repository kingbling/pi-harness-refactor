import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { exec } from "../proc.ts";
import type { ModelClient } from "../models/types.ts";
import type { TargetAdapter } from "./types.ts";

/**
 * Where a built-in stack registers a new feature by hand (the route table, the component that mounts it) is the
 * project's fact, not the adapter's: a model finds it in the project's files once and it is saved per workspace.
 * Generated adapters keep theirs in the manifest (healWiringFiles).
 */
export function wiringFilesPath(root: string, stackId: string): string {
	return join(root, ".bigrefactor", "rules", stackId, "wiring.json");
}

export function loadWiringFiles(root: string, stackId: string): string[] | undefined {
	try {
		const saved = JSON.parse(readFileSync(wiringFilesPath(root, stackId), "utf8")) as { wiringFiles?: unknown };
		return Array.isArray(saved.wiringFiles) ? saved.wiringFiles.filter((p): p is string => typeof p === "string") : undefined;
	} catch {
		return undefined;
	}
}

function saveWiringFiles(root: string, stackId: string, files: string[]): void {
	const p = wiringFilesPath(root, stackId);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(`${p}.tmp`, JSON.stringify({ wiringFiles: files }, null, 2) + "\n");
	renameSync(`${p}.tmp`, p);
}

/** A built-in adapter that names no wiring files of its own gets the ones found for this workspace. */
export function withWiringFiles(adapter: TargetAdapter, root: string | undefined): TargetAdapter {
	if (!root || adapter.generateRegistration || adapter.layout.wiringFiles) return adapter;
	const found = loadWiringFiles(root, adapter.id);
	return found ? { ...adapter, layout: { ...adapter.layout, wiringFiles: found } } : adapter;
}

const isGlob = (p: string) => /[*?[{]/.test(p);

/**
 * Run start: a built-in stack that registers features by hand and has no saved wiring files yet, or whose saved
 * list names a file the project no longer has, gets one question: the project's tracked files (shallowest first,
 * where route tables and main modules live) and the stack's layout go to the model, which names the files. Only
 * files that exist (or globs) are kept. Returns true when the list was saved.
 */
export async function healBuiltinWiring(root: string, adapter: TargetAdapter, projectDir: string, opts: { client: ModelClient; model: string; log?: (l: string) => void }): Promise<boolean> {
	if (adapter.generateRegistration || adapter.layout.wiringFiles || !existsSync(projectDir)) return false;
	const saved = loadWiringFiles(root, adapter.id);
	const gone = (saved ?? []).filter((p) => !isGlob(p) && !existsSync(join(projectDir, p)));
	if (saved && !gone.length) return false;
	const files = await exec("git", ["-C", projectDir, "ls-files"]).then(
		(out) => out.split("\n").filter(Boolean),
		() => [] as string[],
	);
	if (!files.length) return false;
	const shallow = [...files].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
	const listing = `${shallow.slice(0, 400).join("\n")}${shallow.length > 400 ? `\n… ${shallow.length - 400} more` : ""}`;
	const res = await opts.client.chat({
		model: opts.model,
		effort: "medium",
		schema: { type: "object", additionalProperties: false, required: ["wiringFiles"], properties: { wiringFiles: { type: "array", items: { type: "string" } } } },
		messages: [
			{ role: "system", content: "You name the files where a project registers a new feature by hand (its route table, the component or main module that mounts the routes or pages), as project-relative paths of files that exist in the listing. Answer [] when the framework finds new code on its own (file-system routing, annotations)." },
			{
				role: "user",
				content: `${gone.length ? `The saved wiring files ${gone.join(", ")} are gone from the project.\n\n` : ""}Stack: ${adapter.id}. Feature folders: ${adapter.layout.moduleDir("{area}")}. Layout:\n${adapter.layout.structureDoc}\n\nThe project's tracked files:\n${listing}\n\nAnswer only wiringFiles.`,
			},
		],
	});
	const named = (((res.json ?? {}) as { wiringFiles?: unknown }).wiringFiles ?? []) as unknown[];
	const wiring = named.filter((p): p is string => typeof p === "string" && !!p && !p.startsWith("/") && !p.includes("..") && (isGlob(p) || existsSync(join(projectDir, p))));
	const dropped = named.filter((p) => typeof p === "string" && !wiring.includes(p));
	if (gone.length && !wiring.length) {
		// keep what still exists of the old list rather than nothing
		const kept = (saved ?? []).filter((p) => !gone.includes(p));
		saveWiringFiles(root, adapter.id, kept);
		opts.log?.(`  ${adapter.id}: wiring files ${gone.join(", ")} are gone and the model named none: kept ${kept.join(", ") || "none"}`);
		return true;
	}
	saveWiringFiles(root, adapter.id, wiring);
	opts.log?.(`  ${adapter.id}: wiring files ${wiring.join(", ") || "none"}${dropped.length ? ` (left out, not in the project: ${dropped.join(", ")})` : ""}`);
	return true;
}
