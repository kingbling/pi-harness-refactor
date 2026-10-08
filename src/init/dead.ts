import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Config } from "../config.ts";
import { decide } from "../jev/decide.ts";
import { JEV_ACT, noulConfidence, type Battery } from "../jev/questions.ts";
import { decisionsPath, loadDecisions } from "../inventory/decisions.ts";
import type { Ledger } from "../ledger/db.ts";
import type { ModelClient } from "../models/types.ts";

/** Files per Jev call: one call judges many files, the state stays small. */
const BATCH = 20;
const SKIP_DIRS = new Set([".git", "node_modules", "vendor", ".bigrefactor"]);

/**
 * `br dead` (onboarding step): the inventory's reachability walk drops files nothing reaches as dead code, but
 * it cannot see a cron line, a shell script calling `php x.php`, or a class name built from a string. Before a
 * dropped file stays dropped, Jev judges it: "could this still run?". Code adds the facts it has (why the walk
 * dropped it, which other files mention its name). Only a confident "no" keeps it dead; yes or unsure makes it an
 * entry point (decisions.json `liveness`, which the next inventory honours). Judged files are not asked again.
 */
export async function confirmDeadCode(config: Config, root: string, ledger: Ledger, client: ModelClient, opts: { log?: (l: string) => void } = {}): Promise<{ asked: number; alive: string[]; costUsd: number }> {
	const file = loadDecisions(root);
	const judged = file.liveness ?? {};
	const dead = (ledger.db.prepare("SELECT path, dead_code_reason r FROM files WHERE dead_code = 1 ORDER BY path").all() as Array<{ path: string; r: string | null }>).filter((f) => !judged[f.path]);
	if (!dead.length) return { asked: 0, alive: [], costUsd: 0 };
	const mentions = mentionsOf(config.source.path, dead.map((f) => f.path));
	const head = (p: string) => {
		try {
			return readFileSync(join(config.source.path, p), "utf8").replace(/^<\?php\s*/, "").slice(0, 300);
		} catch {
			return "";
		}
	};
	const alive: string[] = [];
	let cost = 0;
	for (let i = 0; i < dead.length; i += BATCH) {
		const batch = dead.slice(i, i + BATCH);
		const key = (j: number) => `f${j}`;
		const state = { app: config.source.framework ?? config.source.stack, files: Object.fromEntries(batch.map((f, j) => [key(j), { path: f.path, why: f.r ?? "no inbound references", mentionedIn: mentions.get(f.path) ?? [], start: head(f.path) }])) };
		const battery: Battery = Object.fromEntries(batch.map((f, j) => [key(j), { type: "noul", instructions: `No indexed code includes \`files.${key(j)}\` (${f.path}) or names its classes. Could it still run: started directly (web entry, CLI command, cron job, deploy or shell script; see mentionedIn), or loaded by a class or file name built from a string at runtime?` }]));
		try {
			const r = await decide({ client, ledger, model: config.models.decide.id, second: config.models.escalate.id }, "dead_code", state, battery, Object.keys(battery));
			cost += r.costUsd;
			batch.forEach((f, j) => {
				const a = r.answers[key(j)];
				const p = a?.type === "noul" ? a.noul : 0.5;
				// dropping is the risky side: only a confident "no" (or an agreed second opinion) keeps the file dead
				const sure = noulConfidence(p) >= JEV_ACT || r.secondOpinion === "agreed";
				const live = p >= 0.5 || !sure;
				judged[f.path] = { alive: live, why: `Jev (decision #${r.decisionId}): ${live ? "may run without inbound references" : "unreachable"} (p=${p.toFixed(2)})` };
				if (live) alive.push(f.path);
			});
		} catch (e) {
			opts.log?.(`  dead code: Jev failed on ${batch.length} files (${(e as Error).message.split("\n")[0]}); they stay dropped until the next run`);
		}
	}
	// persisted with the decisions so a re-inventory keeps the answer
	const fresh = loadDecisions(root);
	fresh.liveness = { ...fresh.liveness, ...judged };
	writeFileSync(decisionsPath(root), JSON.stringify(fresh, null, 2) + "\n");
	opts.log?.(`  dead code: ${dead.length} dropped files judged by Jev, ${alive.length} kept as entry points, $${cost.toFixed(4)}`);
	return { asked: dead.length, alive, costUsd: cost };
}

/** Which other files (any text: shell scripts, crontabs, Makefile, docker, PHP) mention each file's name. A fact for Jev. */
function mentionsOf(src: string, paths: string[]): Map<string, string[]> {
	const byName = new Map<string, string[]>();
	for (const p of paths) {
		const n = p.split("/").pop()!;
		(byName.get(n) ?? byName.set(n, []).get(n)!).push(p);
	}
	const out = new Map<string, string[]>();
	if (!byName.size) return out;
	const re = new RegExp([...byName.keys()].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
	const visit = (dir: string) => {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			if (SKIP_DIRS.has(name)) continue;
			const abs = join(dir, name);
			let st;
			try {
				st = statSync(abs);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				visit(abs);
				continue;
			}
			if (st.size > 256_000) continue;
			const rel = relative(src, abs).split(sep).join("/");
			let text: string;
			try {
				text = readFileSync(abs, "utf8");
			} catch {
				continue;
			}
			if (text.includes("\u0000")) continue; // binary
			for (const m of new Set(text.match(re) ?? []))
				for (const p of byName.get(m) ?? []) {
					if (p === rel) continue;
					const list = out.get(p) ?? out.set(p, []).get(p)!;
					if (list.length < 5) list.push(rel);
				}
		}
	};
	visit(src);
	return out;
}
