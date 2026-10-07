import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "../proc.ts";

/**
 * Git submodules of the old codebase that were never downloaded (`git clone` without --recursive): their
 * folder is empty. A framework kept as a submodule (e.g. gyro-php) then looks absent: its conventions
 * cannot be read and the old code cannot run for the characterization tests. Checked on every onboarding
 * start; the owner downloads them (the old repo is otherwise never written) or continues knowingly.
 */
export interface Submodule {
	path: string;
	url?: string;
}

export function emptySubmodules(sourceRoot: string): Submodule[] {
	const f = join(sourceRoot, ".gitmodules");
	if (!existsSync(f)) return [];
	const out: Submodule[] = [];
	let cur: Submodule | undefined;
	for (const line of readFileSync(f, "utf8").split("\n")) {
		if (/^\s*\[submodule\b/.test(line)) {
			if (cur?.path) out.push(cur);
			cur = { path: "" };
			continue;
		}
		const m = /^\s*(path|url)\s*=\s*(.+?)\s*$/.exec(line);
		if (m && cur) cur[m[1] as "path" | "url"] = m[2]!;
	}
	if (cur?.path) out.push(cur);
	return out.filter((s) => {
		const dir = join(sourceRoot, s.path);
		try {
			return !existsSync(dir) || readdirSync(dir).length === 0;
		} catch {
			return true;
		}
	});
}

export interface SubmodulePrompter {
	select(message: string, options: Array<{ value: string; label: string; hint?: string }>, initial?: string): Promise<string | undefined>;
	log(line: string): void;
}

/** Ask until the submodules are there or the owner continues without them. `--yes` stops with the command. */
export async function ensureSubmodules(sourceRoot: string, ui: SubmodulePrompter, yes: boolean, run: typeof runCommand = runCommand): Promise<"ok" | "skipped"> {
	let missing = emptySubmodules(sourceRoot);
	let lastError = "";
	while (missing.length) {
		const names = missing.map((s) => s.path).join(", ");
		const cmd = `git -C ${sourceRoot} submodule update --init --recursive`;
		if (yes) throw new Error(`the old codebase has submodules that were never downloaded (${names}); run \`${cmd}\` and start again`);
		const v = await ui.select(
			`The old codebase uses submodules that were never downloaded: ${missing.map((s) => `${s.path}${s.url ? ` (${s.url})` : ""}`).join(", ")}.\n   Without them that code is missing: a framework's conventions cannot be read and the old code cannot run for the tests.${lastError ? `\n   last attempt failed: ${lastError}` : ""}`,
			[
				{ value: "download", label: "download them now (recommended)", hint: cmd },
				{ value: "check", label: "I downloaded them myself, check again" },
				{ value: "skip", label: "continue without them", hint: "not recommended: the code in them is treated as absent" },
			],
			"download",
		);
		if (v === undefined) throw new Error("onboarding cancelled");
		if (v === "skip") return "skipped";
		if (v === "download") {
			try {
				await run("git", ["-C", sourceRoot, "submodule", "update", "--init", "--recursive"], { cwd: sourceRoot });
				lastError = "";
			} catch (e: any) {
				// the last line is git's reason (e.g. "Permission denied (publickey)." = no SSH access to the submodule)
				lastError = String(e?.message ?? e).split("\n").map((l) => l.trim()).filter(Boolean).at(-1)?.slice(0, 300) ?? "unknown error";
			}
		}
		missing = emptySubmodules(sourceRoot);
		if (!missing.length) ui.log(`submodules downloaded: ${names}`);
	}
	return "ok";
}
