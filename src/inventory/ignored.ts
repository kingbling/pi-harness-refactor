import { basename, relative } from "node:path";
import { exec } from "../proc.ts";

/**
 * Folders under `dir` that git ignores (dependencies, build output, caches: whatever the repo's .gitignore says),
 * relative to `dir`, without the trailing slash. Empty when `dir` is in no git repo or inside an ignored folder.
 */
export async function gitIgnoredDirs(dir: string): Promise<Set<string>> {
	try {
		const listed = (await exec("git", ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], { cwd: dir, maxBuffer: 64 * 1024 * 1024 })).split("\0").filter((l) => l.endsWith("/"));
		if (!listed.length) return new Set();
		// the list also names untracked folders that only hold ignored files: check-ignore keeps the ignored ones
		const out = await exec("git", ["check-ignore", "--", ...listed], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
		return new Set(out.split("\n").filter(Boolean).map((l) => l.replace(/\/$/, "")));
	} catch {
		return new Set(); // no repo, or nothing ignored (check-ignore exits 1)
	}
}

/**
 * Which files and folders a scan of `root` skips (true = skip): dot names, the folders the adapters name (`names`:
 * a source adapter's vendorDirs, a target's ignoreDirs or ignoredPaths), and `ignored` (gitIgnoredDirs of `root`).
 * `abs` is an absolute path.
 */
export function skipDir(root: string, names: string[] = [], ignored: Set<string> = new Set()): (abs: string) => boolean {
	const named = new Set(names.map((n) => n.replace(/^\/|\/$/g, "")));
	return (abs) => {
		const rel = relative(root, abs).split("\\").join("/");
		return basename(abs).startsWith(".") || named.has(basename(abs)) || named.has(rel) || ignored.has(rel);
	};
}
