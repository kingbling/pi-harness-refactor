import { progress } from "../progress.ts";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import pc from "picocolors";
import type { Config } from "../config.ts";
import type { Ledger } from "../ledger/db.ts";
import { spawnLeaf } from "../sessions/spawn.ts";
import { askViaModel } from "../jev/ask.ts";
import type { ModelClient } from "../models/types.ts";
import { NOT_APP_DOC, validateNotApp } from "../inventory/not-app.ts";

/**
 * `br profile`: the plugin derives the legacy framework profile itself. The escalate model reads the
 * framework's loader, router, factories and base classes (read-only) and writes
 * `.bigrefactor/framework-profile.json` — data the source adapter interprets (loaders → file edges,
 * routes declared in code, scan-discovered entry points, concern table). Code then validates it by
 * re-running the inventory and comparing: load globs that resolve, routes found, dead-code count.
 * The built-in profile (gyro) is shown to the model as the worked example of the format.
 * Which folders are the framework is the model's call: it gets the top-level listing (a folder with its own .git
 * marked, a fact) instead of a name guess (CodeIgniter keeps its framework in system/, library/ can be app code).
 */
export async function generateProfile(config: Config, root: string, ledger: Ledger, opts: { force?: boolean; client?: ModelClient } = {}): Promise<void> {
	const out = join(root, ".bigrefactor", "framework-profile.json");
	if (existsSync(out) && !opts.force) {
		console.log(pc.dim(`profile already present at ${relative(root, out)} (use --force to regenerate)`));
		return;
	}
	const { getSourceAdapter } = await import("../adapters/registry.ts");
	const source = getSourceAdapter(config.source.stack);
	if (!source.profileExample) throw new Error(`the ${config.source.stack} adapter has no framework-profile support`);
	const { example, schemaDoc } = source.profileExample() as { example: { id: string }; schemaDoc: string };
	const src = config.source.path;
	const dirs = source.frameworkDirs?.(src) ?? [];
	const vendor = source.traits?.vendorDirs ?? [];
	const tree = topLevel(src, vendor);
	const stats = indexStats(ledger);
	const kinds = fileKinds(ledger);

	mkdirSync(join(root, ".bigrefactor", "sessions"), { recursive: true });
	const attempt = ledger.startAttempt("__init__", "profile", config.models.escalate.id);
	const session = await spawnLeaf({
		role: "setup",
		cwd: root,
		config,
		writeGlobs: [".bigrefactor/framework-profile.json"],
		protectedGlobs: [`${relative(root, config.target.path)}/**`],
		tools: ["read", "grep", "find", "ls", "write"],
		systemPrompt: `You reverse-engineer how a legacy ${config.source.stack} framework loads code by convention, so a migration tool can build an exact dependency graph without running the app.
You may READ anything under the legacy source at ${src} (it is read-only; never write there). You write exactly one file: .bigrefactor/framework-profile.json in the workspace.
Work like this: first decide from the top-level listing which folders hold the framework the app is built on (its loader, router, base classes; often a separate checkout) rather than the app's own code; read them to be sure. Then find the class loader / autoloader (string → file path), the router (how routes are declared: a table file, or objects created inside controllers, or attributes), the factories that build objects from strings (commands, views/templates, widgets), the directory-scan discovery at boot (controllers, access delegates, plugins), and the base-class families (ORM, HTTP, rendering, auth, commands, cache, mail, jobs, events, helpers, i18n, logging, install, tests). Quote the real code paths and extensions you saw; do not guess names.
${schemaDoc}
Also, for every app (any framework or none): ${NOT_APP_DOC}
Globs are relative to the legacy root; \`$1\`, \`$2\` are the call's positional string arguments (non-literal args are unknown: a glob using them is skipped unless the rule has "each": true, which applies the glob to every literal argument). Concern "match" is a case-insensitive regex over class/interface/function names; pick verdict platform when the target platform provides the concern, port when the classes contain application logic, drop when obsolete, review when unsure.`,
		transcriptPath: join(root, ".bigrefactor", "sessions", `__init__.profile.${attempt}.jsonl`),
		onToolCall: (e) => e.blocked && console.log(pc.dim(`  profile blocked: ${e.blocked}`)),
	});
	const prompt = `Top-level layout of the legacy source (depth 1; "[own .git]" marks a folder that is its own git checkout or submodule):\n${tree}${dirs.length ? `\nThe current profile's framework directories: ${dirs.join(", ")}` : ""}\n\nCurrent index: ${stats}${kinds ? `\nDotted file-name parts before the extension, and extensions, in the indexed legacy files (count): ${kinds}` : ""}\n\nWorked example of the format (another framework in another language, "${example.id}": copy its shape, never its names, folders or extensions):\n${JSON.stringify(example, null, 2)}\n\nNow read the framework source and write .bigrefactor/framework-profile.json for THIS framework. frameworkDirs are the folders you picked (an empty array when the app has no separate framework). Include every loader/factory string→file convention you can prove from the code, the route class pattern if routes are objects, the entry-point regex for every file that runs without being included (front controllers, CLI/console and cron scripts, what deploy and shell scripts call, files discovered by directory scan — look at bin/, scripts, crontabs, Makefile, docker files), legacyWords picked from the file-name parts above, impliedDeps for conventions that resolve at runtime by name (e.g. a model's command directory), a concerns table covering every base-class family under the framework directories, and notApp: the folders you saw that are not the app's own code (each with why). End the session right after writing the file.`;
	let res;
	try {
		res = await session.run(prompt);
	} finally {
		session.dispose();
	}
	// A user stop aborts the session: do not validate half-written output or file questions about it.
	progress.checkStopped();
	ledger.endAttempt(attempt, { outcome: res.error ? "error" : "done", costUsd: res.usage.cost, tokensIn: res.usage.input, tokensOut: res.usage.output });
	console.log(pc.dim(`  profile: ${res.toolCalls} tool calls, ${res.blocked} blocked, $${res.usage.cost.toFixed(4)}${res.error ? pc.red(` ERROR: ${res.error}`) : ""}`));
	if (!existsSync(out)) throw new Error("the model did not write .bigrefactor/framework-profile.json");

	// ---- validate (code): parse, then re-index and compare
	const json = JSON.parse(readFileSync(out, "utf8"));
	const problems = [...(source.validateProfile?.(json) ?? []), ...validateNotApp(json, src)];
	if (problems.length) {
		console.log(pc.yellow(`profile invalid: ${problems.join("; ")}`));
		await askViaModel({ ledger, config, root, client: opts.client }, { point: "profile_review", facts: `The generated framework profile (.bigrefactor/framework-profile.json) has problems: ${problems.join("; ")}.`, options: [{ value: "regenerate", facts: "re-run br profile --force" }, { value: "fix-by-hand", facts: "edit .bigrefactor/framework-profile.json" }], recommended: "regenerate", blocks: "none", askedBy: "init" });
		return;
	}
	source.reloadProfile?.(); // the adapter reads the new file
	const { inventory } = await import("../inventory/run.ts");
	await inventory(config, root, ledger);
	const after = indexStats(ledger);
	const num = (txt: string, k: string) => Number(new RegExp(`${k} (\\d+)`).exec(txt)?.[1] ?? 0);
	const regress: string[] = [];
	if (num(after, "routes") < num(stats, "routes")) regress.push(`routes ${num(stats, "routes")} → ${num(after, "routes")}`);
	if (num(after, "dead") > num(stats, "dead")) regress.push(`dead ${num(stats, "dead")} → ${num(after, "dead")}`);
	console.log(`  before: ${stats}\n  after:  ${after}`);
	if (regress.length) {
		console.log(pc.yellow(`profile lost coverage (${regress.join(", ")}); kept, but review it`));
		await askViaModel({ ledger, config, root, client: opts.client }, { point: "profile_review", facts: `The generated framework profile lost coverage compared to the built-in one: ${regress.join(", ")}. It was kept.`, options: [{ value: "keep", facts: "keep the generated profile" }, { value: "regenerate", facts: "re-run br profile --force" }, { value: "fix-by-hand", facts: "edit .bigrefactor/framework-profile.json" }], recommended: "fix-by-hand", blocks: "none", askedBy: "init" });
	} else console.log(pc.green(`profile ok: ${relative(root, out)}`));
	ledger.setMeta("framework_profile_generated_at", new Date().toISOString());
}

function indexStats(ledger: Ledger): string {
	const q = (sql: string) => (ledger.db.prepare(sql).get() as { n: number }).n;
	const files = q("SELECT COUNT(*) n FROM files");
	if (!files) return "no inventory yet";
	return `files ${files}, dead ${q("SELECT COUNT(*) n FROM files WHERE dead_code = 1")}, framework ${q("SELECT COUNT(*) n FROM files WHERE disposition = 'framework'")}, load edges ${q("SELECT COUNT(*) n FROM index_deps WHERE kind = 'load'")}, routes ${q("SELECT COUNT(*) n FROM index_routes WHERE side = 'source'")}, units ${q("SELECT COUNT(*) n FROM units")}`;
}

/** The legacy root, one level deep, for the model to pick the framework folders from; a folder's own .git is the one fact code adds. */
function topLevel(src: string, vendor: string[]): string {
	let out = "";
	for (const n of readdirSync(src).filter((n) => !n.startsWith(".") && !vendor.includes(n)).sort()) {
		const p = join(src, n);
		let isDir = false;
		try {
			isDir = statSync(p).isDirectory();
		} catch {
			continue;
		}
		out += isDir ? `${n}/${existsSync(join(p, ".git")) ? "  [own .git]" : ""}\n${listTree(p, 0, "  ", vendor)}` : `${n}\n`;
	}
	return out;
}

/** Facts for legacyWords: how often each dotted name part before the extension (x.cmd.php → cmd) and each extension occurs. */
function fileKinds(ledger: Ledger): string {
	const n = new Map<string, number>();
	for (const { path } of ledger.db.prepare("SELECT path FROM files").all() as Array<{ path: string }>) {
		const parts = path.split("/").pop()!.toLowerCase().split(".");
		if (parts.length < 2 || !parts[0]) continue;
		for (const w of parts.length >= 3 ? [parts.at(-2)!, `.${parts.at(-1)}`] : [`.${parts.at(-1)}`]) n.set(w, (n.get(w) ?? 0) + 1);
	}
	return [...n].filter(([w, c]) => c >= 2 || w.startsWith(".")).sort((a, b) => b[1] - a[1]).slice(0, 60).map(([w, c]) => `${w} ${c}`).join(", ");
}

function listTree(dir: string, depth: number, prefix: string, vendor: string[]): string {
	if (depth < 0 || !existsSync(dir)) return "";
	let out = "";
	for (const n of readdirSync(dir).filter((n) => n !== ".git" && !vendor.includes(n)).sort().slice(0, 40)) {
		const p = join(dir, n);
		let isDir = false;
		try {
			isDir = statSync(p).isDirectory();
		} catch {
			continue;
		}
		out += `${prefix}${n}${isDir ? "/" : ""}\n`;
		if (isDir) out += listTree(p, depth - 1, prefix + "  ", vendor);
	}
	return out;
}
