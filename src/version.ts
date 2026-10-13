import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The plugin's version as loaded: package version + the git commit of this checkout ("+" when it has uncommitted
 * changes). Read once when the module loads, so a long-running Pi shows the code it really runs, not what is on disk now.
 */
export const PLUGIN_VERSION = (() => {
	const dir = join(import.meta.dirname, "..");
	let v = "?";
	try {
		v = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string }).version ?? "?";
	} catch {
		/* no package.json */
	}
	try {
		const git = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		const sha = git(["rev-parse", "--short", "HEAD"]);
		const dirty = git(["status", "--porcelain", "--untracked-files=no", "--", "src"]) ? "+" : "";
		return `v${v} ${sha}${dirty}`;
	} catch {
		return `v${v}`;
	}
})();
