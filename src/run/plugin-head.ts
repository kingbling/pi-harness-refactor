import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * The plugin's own git commit, so a running migration can start again on new plugin code without the owner
 * restarting Pi. The plugin folder is found from this file (BR_PLUGIN_HEAD_DIR points a test at another repo).
 * Not a git checkout (an installed package): no HEAD, the feature is off.
 */
export function pluginDir(): string {
	return process.env["BR_PLUGIN_HEAD_DIR"] || fileURLToPath(new URL("../..", import.meta.url));
}

/** `git rev-parse HEAD` in the plugin folder, off the thread; undefined when it is not a git checkout. */
export function pluginHead(): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("git", ["rev-parse", "HEAD"], { cwd: pluginDir(), timeout: 10_000 }, (err, out) => resolve(err ? undefined : out.trim() || undefined));
	});
}

/** How often HEAD is read, and how long a new HEAD must stay the same (a burst of commits = one restart). Env overrides are for tests. */
export function newCodeTimings(): { checkMs: number; quietMs: number } {
	const n = (k: string, d: number) => (Number(process.env[k]) > 0 ? Number(process.env[k]) : d);
	return { checkMs: n("BR_NEW_CODE_CHECK_MS", 60_000), quietMs: n("BR_NEW_CODE_QUIET_MS", 120_000) };
}

/**
 * Resolves with the new HEAD once it differs from `from` and stayed the same for the quiet time; undefined when
 * `stopped()` turned true first.
 */
export async function waitForNewCode(from: string | undefined, stopped: () => boolean): Promise<string | undefined> {
	const { checkMs, quietMs } = newCodeTimings();
	let seen: { head: string; since: number } | undefined;
	for (;;) {
		// short naps, so a stop is noticed at once
		for (const t = Date.now(); Date.now() - t < checkMs; ) {
			if (stopped()) return undefined;
			await new Promise((r) => setTimeout(r, Math.min(250, checkMs)));
		}
		if (stopped()) return undefined;
		const head = await pluginHead();
		if (!head || head === from) seen = undefined;
		else if (seen?.head !== head) seen = { head, since: Date.now() };
		else if (Date.now() - seen.since >= quietMs) return head;
	}
}
