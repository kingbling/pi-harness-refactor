import { readFileSync } from "node:fs";
import { join } from "node:path";
import { exec } from "./proc.ts";

/**
 * The plugin's version as loaded: package version + the git commit of this checkout ("+" when it has uncommitted
 * changes). Read once when the module loads, so a long-running Pi shows the code it really runs, not what is on disk now.
 * The commit is asked for in the background (a launch never blocks Pi): until it answers the version alone shows.
 */
let version = "v?";
export const pluginVersion = (): string => version;

const dir = join(import.meta.dirname, "..");
let v = "?";
try {
	v = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string }).version ?? "?";
} catch {
	/* no package.json */
}
version = `v${v}`;
const git = async (args: string[]) => (await exec("git", ["-C", dir, ...args])).trim();
void (async () => {
	try {
		const sha = await git(["rev-parse", "--short", "HEAD"]);
		const dirty = (await git(["status", "--porcelain", "--untracked-files=no", "--", "src"])) ? "+" : "";
		version = `v${v} ${sha}${dirty}`;
	} catch {
		/* not a checkout */
	}
})();
