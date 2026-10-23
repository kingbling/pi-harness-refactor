import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { lstat, readdir, readlink, realpath, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export interface FileProvenance {
	hash: string;
	files: Record<string, string>;
}

async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

/** Retain file names as well as bytes, so adding/removing a driver or adapter also changes its fingerprint. */
async function fingerprint(root: string, paths: string[], include: (path: string) => boolean = () => true): Promise<FileProvenance> {
	const files: Record<string, string> = {};
	const walk = async (path: string, ancestors: Set<string>) => {
		const info = await lstat(path);
		const link = info.isSymbolicLink() ? await readlink(path) : undefined;
		const actual = link === undefined ? info : await stat(path);
		const key = relative(root, path).replaceAll("\\", "/");
		if (actual.isDirectory()) {
			const canonical = await realpath(path);
			if (ancestors.has(canonical)) throw new Error(`verification input has a directory symlink cycle: ${path}`);
			const next = new Set([...ancestors, canonical]);
			if (link !== undefined) files[`${key}/@link`] = createHash("sha256").update(link).digest("hex");
			for (const name of (await readdir(path)).sort()) await walk(join(path, name), next);
		} else if (actual.isFile() && include(key)) {
			const bytes = await hashFile(path);
			files[key] = link === undefined ? bytes : createHash("sha256").update(JSON.stringify({ link, bytes })).digest("hex");
		} else if (!actual.isFile()) throw new Error(`verification input is not a regular file: ${path}`);
	};
	for (const p of paths.sort()) if (existsSync(join(root, p))) await walk(join(root, p), new Set());
	const ordered = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
	return { hash: createHash("sha256").update(JSON.stringify(ordered)).digest("hex"), files: ordered };
}

/** The implementation's location is authoritative, independently of version-watcher test overrides. */
export async function verificationEngine(pluginRoot = resolve(import.meta.dirname, "../..")): Promise<FileProvenance> {
	if (!existsSync(join(pluginRoot, "package.json")) || !existsSync(join(pluginRoot, "src"))) throw new Error("cannot fingerprint verification engine: package.json and src are required");
	return fingerprint(pluginRoot, ["package.json", "src", "bin"]);
}

/** Workspace-selected adapters, check commands and legacy runtime settings affect what verification executes. */
export function verificationWorkspace(root: string): Promise<FileProvenance> {
	return fingerprint(root, [".bigrefactor/adapters", ".bigrefactor/commands", ".bigrefactor/legacy-env.json", ".bigrefactor/framework-profile.json"], (p) => !p.endsWith(".log"));
}
