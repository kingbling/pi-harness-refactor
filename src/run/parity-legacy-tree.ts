import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { join } from "node:path";
import { git, headOf } from "../git.ts";

export interface LegacyTreeProvenance {
	hash: string;
	files: number;
	submodules: Record<string, string>;
	mismatches: string[];
}

async function fileFingerprint(path: string): Promise<unknown> {
	let info;
	try { info = await lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" }; throw e; }
	// Git stores a symlink's target text, not the bytes behind it (which can be a directory).
	if (info.isSymbolicLink()) return { kind: "symlink", target: await readlink(path) };
	if (!info.isFile()) return { kind: "other" };
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return { kind: "file", executable: !!(info.mode & 0o111), hash: hash.digest("hex") };
}

/** Enumerate the pinned Git tree, descending through initialized submodules at their exact recorded revisions. */
export async function legacyTree(source: string, runtime: string, revision: string, overrides: string[] = []): Promise<LegacyTreeProvenance> {
	const tree = createHash("sha256"), allowed = new Set(overrides);
	const result: LegacyTreeProvenance = { hash: "", files: 0, submodules: {}, mismatches: [] };
	const walk = async (repo: string, commit: string, prefix: string) => {
		const records = (await git(repo, ["ls-tree", "-r", "-z", commit])).split("\0").filter(Boolean);
		for (const record of records) {
			const match = /^(\d+) (blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(record);
			if (!match) throw new Error(`cannot read pinned legacy tree entry: ${record.slice(0, 160)}`);
			const mode = match[1]!, kind = match[2]!, object = match[3]!, name = match[4]!;
			const path = prefix + name;
			if (kind === "commit") {
				const nested = join(repo, name);
				if (!existsSync(join(nested, ".git"))) throw new Error(`legacy submodule ${path} is not initialized at pinned revision ${object}; initialize it before verifying`);
				const head = await headOf(nested);
				if (head !== object) throw new Error(`legacy submodule ${path} is at ${head ?? "no commit"}, expected pinned revision ${object}`);
				result.submodules[path] = object;
				tree.update(JSON.stringify([path, "submodule", object]));
				await walk(nested, object, `${path}/`);
				continue;
			}
			const [original, actual] = await Promise.all([fileFingerprint(join(source, path)), fileFingerprint(join(runtime, path))]);
			tree.update(JSON.stringify([path, mode, actual]));
			result.files++;
			if (JSON.stringify(original) !== JSON.stringify(actual) && !allowed.has(path)) result.mismatches.push(path);
		}
	};
	await walk(source, revision, "");
	result.hash = tree.digest("hex");
	return result;
}
