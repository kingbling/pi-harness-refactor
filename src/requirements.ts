import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import pc from "picocolors";
import { findConfigPath, loadConfig } from "./config.ts";

/**
 * What bigrefactor needs on this machine, checked at Pi startup (`/br check`, `br check`):
 *  - missing  = something will fail (the run cannot work);
 *  - degraded = works, but worse (paid fallback, questions in chat);
 *  - ok.
 * Stack-specific commands come from the workspace's adapters (the truth runner, build/test, package commands),
 * so the list follows the stacks in use and the core names no language.
 */
export interface Requirement {
	name: string;
	status: "ok" | "missing" | "degraded";
	why: string;
	fix?: string;
}

const MIN_NODE = [22, 19];

export async function checkRequirements(o: { cwd: string; tools?: string[] }): Promise<Requirement[]> {
	const out: Requirement[] = [];
	const [maj = 0, min = 0] = process.versions.node.split(".").map(Number);
	const nodeOk = maj > MIN_NODE[0]! || (maj === MIN_NODE[0] && min >= MIN_NODE[1]!);
	out.push({ name: `node ${process.versions.node}`, status: nodeOk ? "ok" : "missing", why: `needs node >= ${MIN_NODE.join(".")} (built-in sqlite)`, fix: nodeOk ? undefined : "nvm install 22 && nvm use 22" });
	out.push(command("git", "worktrees, commits per accepted unit", "install git"));
	out.push(astGrep());

	const { resolveOpenRouterKey } = await import("./models/openrouter.ts");
	let openrouter = true;
	try {
		resolveOpenRouterKey();
	} catch {
		openrouter = false;
	}
	out.push({ name: "OpenRouter login", status: openrouter ? "ok" : "missing", why: "the decision model (Jev) and the fallback for every model call", fix: openrouter ? undefined : "in Pi: /login openrouter (or set OPENROUTER_API_KEY)" });

	let codex = false;
	try {
		const { CODEX_PROVIDER, modelRuntime } = await import("./models/codex.ts");
		codex = (await modelRuntime()).hasConfiguredAuth(CODEX_PROVIDER);
	} catch {
		/* runtime unavailable: reported as not logged in */
	}
	out.push({ name: "Codex login", status: codex ? "ok" : "degraded", why: "agents and model calls run on the Codex subscription first; without it everything goes to paid OpenRouter", fix: codex ? undefined : "in Pi: /login openai-codex" });

	if (o.tools) {
		const has = o.tools.includes("ask_user_question");
		out.push({ name: "ask_user_question tool", status: has ? "ok" : "degraded", why: "onboarding asks its decisions in a dialog; without it they are asked in chat", fix: has ? undefined : "pi install npm:@juicesharp/rpiv-ask-user-question" });
	}

	// the stacks of this workspace: whatever commands their adapters run must exist
	const configPath = findConfigPath(o.cwd);
	if (configPath) {
		try {
			const { config } = loadConfig(configPath);
			const { getSourceAdapter, getTargetAdapter } = await import("./adapters/registry.ts");
			const needs = new Map<string, string>();
			const source = getSourceAdapter(config.source.stack);
			needs.set(source.truth.run(config.source.path, "x").cmd, `${source.id}: runs the legacy code for truth`);
			for (const id of config.target.stacks) {
				const t = await getTargetAdapter(id);
				const dir = config.target.path;
				for (const c of [t.build(dir).cmd, t.test(dir, []).cmd, t.toolchain.addPackages(dir, []).cmd]) if (!needs.has(c)) needs.set(c, `${id}: build, test and packages`);
			}
			for (const [cmd, why] of needs) out.push(command(cmd, why, `install ${cmd}`));
		} catch (e) {
			out.push({ name: "workspace config", status: "missing", why: String((e as Error)?.message ?? e).slice(0, 200), fix: "fix bigrefactor.config.json (br init)" });
		}
	}
	return out;
}

function command(cmd: string, why: string, fix: string): Requirement {
	const ok = /^[\w.+-]+$/.test(cmd) ? onPath(cmd) : existsSync(cmd);
	return { name: cmd, status: ok ? "ok" : "missing", why, fix: ok ? undefined : fix };
}

function onPath(cmd: string): boolean {
	try {
		execFileSync("sh", ["-c", `command -v ${cmd}`], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

function astGrep(): Requirement {
	let bin: string | undefined;
	try {
		const dir = dirname(createRequire(import.meta.url).resolve("@ast-grep/cli/package.json"));
		if (existsSync(join(dir, "ast-grep"))) bin = join(dir, "ast-grep");
	} catch {
		/* not installed with this package */
	}
	const ok = bin ? true : onPath("ast-grep");
	return { name: "ast-grep", status: ok ? "ok" : "missing", why: "the rules gate checks written code with ast-grep", fix: ok ? undefined : "pnpm install in the bigrefactor checkout (or install ast-grep)" };
}

export function renderRequirements(rs: Requirement[], o: { color?: boolean } = {}): string {
	const c = o.color === false ? { green: (s: string) => s, yellow: (s: string) => s, red: (s: string) => s, dim: (s: string) => s } : pc;
	const mark = (r: Requirement) => (r.status === "ok" ? c.green("ok      ") : r.status === "degraded" ? c.yellow("degraded") : c.red("MISSING "));
	return rs.map((r) => `${mark(r)} ${r.name.padEnd(24)} ${c.dim(r.why)}${r.fix ? `\n         → ${r.fix}` : ""}`).join("\n");
}

/** One line for a startup notice; undefined when everything is fine. */
export function requirementsNotice(rs: Requirement[]): string | undefined {
	const bad = rs.filter((r) => r.status !== "ok");
	if (!bad.length) return undefined;
	const missing = bad.filter((r) => r.status === "missing");
	return `bigrefactor: ${missing.length ? `missing ${missing.map((r) => r.name).join(", ")}` : ""}${missing.length && bad.length > missing.length ? "; " : ""}${bad.length > missing.length ? `degraded: ${bad.filter((r) => r.status === "degraded").map((r) => r.name).join(", ")}` : ""}\n${bad.map((r) => `  ${r.name}: ${r.fix ?? r.why}`).join("\n")}\n(/br check for details)`;
}
