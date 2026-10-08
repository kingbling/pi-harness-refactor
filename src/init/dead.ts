import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Config } from "../config.ts";
import { askViaModel } from "../jev/ask.ts";
import { decisionsPath, loadDecisions } from "../inventory/decisions.ts";
import type { Ledger } from "../ledger/db.ts";
import type { ModelClient } from "../models/types.ts";
import { PLAIN_LANGUAGE } from "../policy.ts";
import { spawnLeaf } from "../sessions/spawn.ts";

type Verdict = { path: string; verdict: "alive" | "dead" | "unsure"; evidence: string };

/**
 * `br dead` (onboarding step): the inventory's reachability walk drops files nothing reaches as dead code, but it
 * cannot see a cron line, a shell script calling a file, or a class name built from a string. Before a dropped file
 * stays dropped, ONE read-only tool session (read/grep/find/ls in the legacy repo) checks the candidates folder by
 * folder, with the framework profile's facts (entry points, what it says is obsolete), and records alive / dead /
 * unsure with the evidence it found.
 *  - alive or unsure → an entry point (decisions.json `liveness`, honoured by the next inventory): dropping is the risky side;
 *  - dead → ONE owner question per folder ("drop app/install/old (14 files)?", blocks nothing); the files stay
 *    dropped unless the owner answers keep (the inventory reads the answer).
 * Judged files are not checked again; files the session left without a verdict are checked next time.
 */
export async function confirmDeadCode(config: Config, root: string, ledger: Ledger, client: ModelClient | undefined, opts: { log?: (l: string) => void; spawn?: typeof spawnLeaf } = {}): Promise<{ asked: number; alive: string[]; questions: number; costUsd: number }> {
	const file = loadDecisions(root);
	const judged = file.liveness ?? {};
	const dead = (ledger.db.prepare("SELECT path, dead_code_reason r FROM files WHERE dead_code = 1 ORDER BY path").all() as Array<{ path: string; r: string | null }>).filter((f) => !judged[f.path]);
	if (!dead.length) return { asked: 0, alive: [], questions: 0, costUsd: 0 };
	const byFolder = new Map<string, Array<{ path: string; r: string | null }>>();
	for (const f of dead) (byFolder.get(dirname(f.path)) ?? byFolder.set(dirname(f.path), []).get(dirname(f.path))!).push(f);

	const verdicts = new Map<string, Verdict>();
	const candidates = new Set(dead.map((f) => f.path));
	const judgeTool = {
		name: "judge_files",
		label: "Judge dropped files",
		description: "Record your verdict for dropped files (call it once per folder, or more often). alive = it still runs or is loaded (say by what); dead = nothing starts or loads it any more (say how you checked); unsure = you could not tell. evidence names the file/line you saw.",
		promptSnippet: "judge_files: record alive/dead/unsure + evidence for dropped files",
		parameters: Type.Object({ files: Type.Array(Type.Object({ path: Type.String(), verdict: Type.Union([Type.Literal("alive"), Type.Literal("dead"), Type.Literal("unsure")]), evidence: Type.String() })) }),
		execute: async (_id: string, p: { files: Verdict[] }) => {
			const known = p.files.filter((f) => candidates.has(f.path));
			for (const f of known) verdicts.set(f.path, f);
			const left = [...candidates].filter((c) => !verdicts.has(c)).length;
			return { content: [{ type: "text" as const, text: `recorded ${known.length}${known.length < p.files.length ? ` (${p.files.length - known.length} paths are not candidates)` : ""}; ${left} left` }], details: {} };
		},
	} as unknown as ToolDefinition;

	let cost = 0;
	let session: Awaited<ReturnType<typeof spawnLeaf>> | undefined;
	try {
		session = await (opts.spawn ?? spawnLeaf)({
			role: "review",
			cwd: config.source.path,
			config,
			writeGlobs: [],
			customTools: [judgeTool],
			transcriptPath: join(root, ".bigrefactor", "sessions", `__init__.dead.${Date.now()}.jsonl`),
			systemPrompt: `You check files of a legacy ${config.source.stack}${config.source.framework ? `/${config.source.framework}` : ""} app (${config.source.path}, read-only) that no other code includes or names: are they dead, or do they still run? Something may start them without an include: a web entry point, a CLI command, a cron line, a deploy or shell script, a container file, a class or file name built from a string at runtime, a directory scan of the framework. Use your tools: grep the repo for each file's name and its classes, read the files and what might start them. Work folder by folder and record verdicts with judge_files as you go. Obsolete one-off scripts (installers and upgrades already run, old exports) are dead even when a doc mentions them. Be concrete in the evidence.\n\n${PLAIN_LANGUAGE}`,
		});
		const r = await session.run(`Framework facts (from the framework profile):\n${profileFacts(root)}\n\nFiles nothing reaches, by folder (why the inventory dropped them):\n${[...byFolder].map(([dir, fs]) => `${dir}/ (${fs.length})\n${fs.map((f) => `  ${f.path}${f.r ? ` — ${f.r}` : ""}`).join("\n")}`).join("\n")}\n\nJudge every file with judge_files, then end with one line.`);
		cost += r.usage.cost;
		if (r.error) opts.log?.(`  dead code: the session ended with an error (${r.error}); files without a verdict are checked next time`);
	} catch (e) {
		opts.log?.(`  dead code: no session (${(e as Error).message.split("\n")[0]}); the files stay dropped until the next check`);
	} finally {
		session?.dispose();
	}

	const alive: string[] = [];
	const deadByFolder = new Map<string, Verdict[]>();
	for (const v of verdicts.values()) {
		if (v.verdict === "dead") (deadByFolder.get(dirname(v.path)) ?? deadByFolder.set(dirname(v.path), []).get(dirname(v.path))!).push(v);
		else {
			judged[v.path] = { alive: true, why: `${v.verdict === "unsure" ? "unsure, kept" : "still runs"}: ${v.evidence}` };
			alive.push(v.path);
		}
	}
	// leaning dead: one question per folder; the files stay dropped unless the owner keeps them
	for (const [dir, vs] of deadByFolder) {
		const q = await askViaModel(
			{ ledger, config, root, client },
			{
				point: "dead_code",
				facts: `${vs.length} file(s) in ${dir}/ are reached by no other code, and a model that searched the repo found nothing that still starts them:\n${vs.map((v) => `- ${v.path}: ${v.evidence}`).join("\n").slice(0, 3000)}\nDropped files are not migrated.`,
				options: [
					{ value: "drop", facts: `drop ${dir}/ (${vs.length} files): not migrated` },
					{ value: "keep", facts: "keep them: they are migrated like the rest" },
				],
				recommended: "drop",
				blocks: "none",
				askedBy: "init",
				context: { files: vs.map((v) => v.path) },
			},
		);
		cost += q.costUsd;
		for (const v of vs) judged[v.path] = { alive: false, why: `dead: ${v.evidence}`, question: q.id };
	}
	// persisted with the decisions so a re-inventory keeps the answer
	const fresh = loadDecisions(root);
	fresh.liveness = { ...fresh.liveness, ...judged };
	writeFileSync(decisionsPath(root), JSON.stringify(fresh, null, 2) + "\n");
	opts.log?.(`  dead code: ${verdicts.size}/${dead.length} dropped files checked, ${alive.length} kept as entry points, ${deadByFolder.size} folder question(s) for you, $${cost.toFixed(4)}`);
	return { asked: verdicts.size, alive, questions: deadByFolder.size, costUsd: cost };
}

/** What the framework profile says about entry points, obsolete concerns and folders that are not the app. */
function profileFacts(root: string): string {
	const p = join(root, ".bigrefactor", "framework-profile.json");
	if (!existsSync(p)) return "(no framework profile)";
	try {
		const j = JSON.parse(readFileSync(p, "utf8")) as { entryPoint?: string; concerns?: Array<{ concern: string; legacy: string; verdict: string; match: string }>; notApp?: unknown };
		return [
			j.entryPoint ? `entry points (regex over paths): ${j.entryPoint}` : "",
			...(j.concerns ?? []).map((c) => `concern ${c.concern} (${c.legacy}; classes /${c.match}/): ${c.verdict}`),
			j.notApp ? `not the app's own code: ${JSON.stringify(j.notApp)}` : "",
		].filter(Boolean).join("\n");
	} catch {
		return "(framework profile unreadable)";
	}
}
