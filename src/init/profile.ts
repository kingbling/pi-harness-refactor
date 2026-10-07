import { progress } from "../progress.ts";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import pc from "picocolors";
import type { Config } from "../config.ts";
import type { Ledger } from "../ledger/db.ts";
import { spawnLeaf } from "../sessions/spawn.ts";

/**
 * `br profile`: the plugin derives the legacy framework profile itself. The escalate model reads the
 * framework's loader, router, factories and base classes (read-only) and writes
 * `.bigrefactor/framework-profile.json` — data the source adapter interprets (loaders → file edges,
 * routes declared in code, scan-discovered entry points, concern table). Code then validates it by
 * re-running the inventory and comparing: load globs that resolve, routes found, dead-code count.
 * The built-in profile (gyro) is shown to the model as the worked example of the format.
 */
export async function generateProfile(config: Config, root: string, ledger: Ledger, opts: { force?: boolean } = {}): Promise<void> {
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
	const candidates = dirs.length ? dirs : detectFrameworkDirs(src);
	if (!candidates.length) {
		console.log(pc.yellow("no framework directory found (vendor-only app?) — nothing to profile"));
		return;
	}
	const tree = candidates.map((d) => `${d}\n${listTree(join(src, d), 2, "  ")}`).join("\n");
	const stats = indexStats(ledger);

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
Work like this: find the class loader / autoloader (string → file path), the router (how routes are declared: a table file, or objects created inside controllers, or attributes), the factories that build objects from strings (commands, views/templates, widgets), the directory-scan discovery at boot (controllers, access delegates, plugins), and the base-class families (ORM, HTTP, rendering, auth, commands, cache, mail, jobs, events, helpers, i18n, logging, install, tests). Quote the real code paths and extensions you saw; do not guess names.
${schemaDoc}
Globs are relative to the legacy root; \`$1\`, \`$2\` are the call's positional string arguments (non-literal args are unknown: a glob using them is skipped unless the rule has "each": true, which applies the glob to every literal argument). Concern "match" is a case-insensitive regex over class/interface/function names; pick verdict platform when the target platform provides the concern, port when the classes contain application logic, drop when obsolete, review when unsure.`,
		transcriptPath: join(root, ".bigrefactor", "sessions", `__init__.profile.${attempt}.jsonl`),
		onToolCall: (e) => e.blocked && console.log(pc.dim(`  profile blocked: ${e.blocked}`)),
	});
	const prompt = `Framework directories and their layout (depth 2):\n${tree}\n\nCurrent index without a profile: ${stats}\n\nWorked example of the format (another framework, "${example.id}"):\n${JSON.stringify(example, null, 2)}\n\nNow read the framework source and write .bigrefactor/framework-profile.json for THIS framework. Include every loader/factory string→file convention you can prove from the code, the route class pattern if routes are objects, the entry-point regex for files discovered by directory scan, impliedDeps for conventions that resolve at runtime by name (e.g. a model's command directory), and a concerns table covering every base-class family under the framework directories. End the session right after writing the file.`;
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
	const problems = source.validateProfile?.(json) ?? [];
	if (problems.length) {
		console.log(pc.yellow(`profile invalid: ${problems.join("; ")}`));
		ledger.askQuestion({ point: "profile_review", question: `framework-profile.json has problems: ${problems.join("; ")}. Fix by hand or re-run br profile --force?`, blocks: "none", askedBy: "init" });
		return;
	}
	source.reloadProfile?.(); // the generated file now wins over the built-in table
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
		ledger.askQuestion({ point: "profile_review", question: `Generated framework profile lost coverage: ${regress.join(", ")}. Edit .bigrefactor/framework-profile.json or re-run br profile --force.`, blocks: "none", askedBy: "init" });
	} else console.log(pc.green(`profile ok: ${relative(root, out)}`));
	ledger.setMeta("framework_profile_generated_at", new Date().toISOString());
}

function indexStats(ledger: Ledger): string {
	const q = (sql: string) => (ledger.db.prepare(sql).get() as { n: number }).n;
	const files = q("SELECT COUNT(*) n FROM files");
	if (!files) return "no inventory yet";
	return `files ${files}, dead ${q("SELECT COUNT(*) n FROM files WHERE dead_code = 1")}, framework ${q("SELECT COUNT(*) n FROM files WHERE disposition = 'framework'")}, load edges ${q("SELECT COUNT(*) n FROM index_deps WHERE kind = 'load'")}, routes ${q("SELECT COUNT(*) n FROM index_routes WHERE side = 'source'")}, units ${q("SELECT COUNT(*) n FROM units")}`;
}

/** Directories that look like a framework (many files, named like one, or a git submodule) when the adapter has no idea yet. */
function detectFrameworkDirs(src: string): string[] {
	const out: string[] = [];
	for (const n of readdirSync(src)) {
		if (["vendor", "node_modules", ".git", "app", "src", "tests", "docs"].includes(n)) continue;
		const p = join(src, n);
		try {
			if (!statSync(p).isDirectory()) continue;
		} catch {
			continue;
		}
		if (/framework|core|lib|engine|-php$/i.test(n) || existsSync(join(p, ".git"))) out.push(`${n}/`);
	}
	return out;
}

function listTree(dir: string, depth: number, prefix: string): string {
	if (depth < 0 || !existsSync(dir)) return "";
	let out = "";
	for (const n of readdirSync(dir).filter((n) => ![".git", "node_modules"].includes(n)).sort().slice(0, 40)) {
		const p = join(dir, n);
		let isDir = false;
		try {
			isDir = statSync(p).isDirectory();
		} catch {
			continue;
		}
		out += `${prefix}${n}${isDir ? "/" : ""}\n`;
		if (isDir) out += listTree(p, depth - 1, prefix + "  ");
	}
	return out;
}
