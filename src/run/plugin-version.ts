import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The plugin's version (package.json), so a running migration can start again on new plugin code without the owner
 * restarting Pi. Only a higher version counts: commits that do not raise it (work in progress, another session's
 * commits) never restart the run. The plugin folder is found from this file (BR_PLUGIN_DIR points a test elsewhere).
 */
export function pluginDir(): string {
	return process.env["BR_PLUGIN_DIR"] || fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
}

/** The plugin's package.json version, read off the thread; undefined when there is none (the feature is off). */
export async function pluginVersion(): Promise<string | undefined> {
	try {
		const v = (JSON.parse(await readFile(join(pluginDir(), "package.json"), "utf8")) as { version?: unknown }).version;
		return typeof v === "string" && /^\d+(\.\d+)*/.test(v) ? v : undefined;
	} catch {
		return undefined;
	}
}

/** True when version `a` is higher than `b` (numbers compared part by part: 0.1.10 > 0.1.9). */
export function higher(a: string, b: string): boolean {
	const p = (v: string) => (/^\d+(\.\d+)*/.exec(v)?.[0] ?? "0").split(".").map(Number);
	const x = p(a);
	const y = p(b);
	for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
	return false;
}

/** How often the version is read, and how long a new one must stay (a version raised in several pushes = one restart). Env overrides are for tests. */
export function newCodeTimings(): { checkMs: number; quietMs: number } {
	const n = (k: string, d: number) => (Number(process.env[k]) > 0 ? Number(process.env[k]) : d);
	return { checkMs: n("BR_NEW_CODE_CHECK_MS", 60_000), quietMs: n("BR_NEW_CODE_QUIET_MS", 60_000) };
}

/**
 * Resolves with the new version once it is higher than `from` and stayed the same for the quiet time; undefined when
 * `stopped()` turned true first.
 */
export async function waitForNewCode(from: string | undefined, stopped: () => boolean): Promise<string | undefined> {
	const { checkMs, quietMs } = newCodeTimings();
	let seen: { v: string; since: number } | undefined;
	for (;;) {
		// short naps, so a stop is noticed at once
		for (const t = Date.now(); Date.now() - t < checkMs; ) {
			if (stopped()) return undefined;
			await new Promise((r) => setTimeout(r, Math.min(250, checkMs)));
		}
		if (stopped()) return undefined;
		const v = await pluginVersion();
		if (!v || !from || !higher(v, from)) seen = undefined;
		else if (seen?.v !== v) seen = { v, since: Date.now() };
		else if (Date.now() - seen.since >= quietMs) return v;
	}
}
