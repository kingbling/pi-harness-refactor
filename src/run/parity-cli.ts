import { join, relative } from "node:path";
import { loadCommandOverrides } from "../adapters/command-overrides.ts";
import { getTargetAdapter } from "../adapters/registry.ts";
import type { Config } from "../config.ts";
import { projectDir } from "../init/init.ts";
import { answerValue, askViaModel } from "../jev/ask.ts";
import type { Ledger } from "../ledger/db.ts";
import type { ModelClient } from "../models/types.ts";
import { checkSlice } from "./parity-check.ts";
import { judgeRun } from "./parity-judge.ts";
import { probeApps } from "./parity.ts";
import { linkDependencies } from "./run.ts";

export const PARITY_USAGE = "parity --probe [--again] | parity <slice> [--rewrite] [--no-judge]";

/** `br parity` and `/br parity`: probe the apps, or compare one slice (and judge it). Returns the lines to show. */
export async function parityCommand(o: { ledger: Ledger; config: Config; root: string; client?: ModelClient; args: string[]; log?: (l: string) => void }): Promise<string[]> {
	const { ledger, config, root, client, args } = o;
	const slice = args.find((a) => !a.startsWith("--"));
	if (!args.includes("--probe") && !slice) throw new Error(`usage: ${PARITY_USAGE}`);
	const adapters = await Promise.all(config.target.stacks.map(async (id) => [id, await getTargetAdapter(id)] as const));
	const linkAll = async (wt: string) => {
		for (const [id, a] of adapters) await linkDependencies(projectDir(config, id), join(wt, relative(config.target.path, projectDir(config, id))), a.toolchain.worktreeLinks, loadCommandOverrides(root, id).worktreeCopy ?? []);
	};
	if (slice) {
		const serverStack = adapters.find(([, a]) => a.role === "server")?.[0] ?? config.target.stacks[0]!;
		const r = await checkSlice({ ledger, config, root, slice, linkAll, serverStack, rewrite: args.includes("--rewrite"), log: o.log });
		const lines = [`${slice}: ${r.outcome} — ${r.note}`];
		if (r.runId !== undefined && r.outcome === "differs" && !args.includes("--no-judge")) {
			const j = await judgeRun({ ledger, config, root, runId: r.runId, slice, client, log: o.log });
			lines.push(`judge: ${j.bugs} bug(s)${j.reopened.length ? ` → re-opened ${j.reopened.join(", ")}` : ""}, ${j.quirks} quirk(s) for you, ${j.allowed} allowed${j.setup ? `, ${j.setup} from the test setup (br parity --probe fixes it)` : ""}${j.open ? `, ${j.open} not judged` : ""}`);
		}
		for (const d of r.diffs.slice(0, 30)) lines.push(`  ${d.step} ${d.route} ${d.kind}${d.path ? ` ${d.path}` : ""}: old ${JSON.stringify(d.legacy)?.slice(0, 120)} · new ${JSON.stringify(d.target)?.slice(0, 120)}`);
		if (r.diffs.length > 30) lines.push(`  … ${r.diffs.length - 30} more (ledger: parity_diffs, run ${r.runId})`);
		return lines;
	}
	const up = await probeApps({
		config,
		root,
		linkAll,
		log: o.log,
		again: args.includes("--again"),
		ask: async (q) => (await askViaModel({ ledger, config, root, client }, { point: "parity_probe", facts: q.facts, options: q.options, recommended: q.recommended, blocks: "none", askedBy: "orchestrator" })).id,
		answer: (id) => answerValue(ledger.getQuestion(id)?.answer),
	});
	return Object.entries(up).map(([side, ok]) => `${side.padEnd(12)} ${ok ? "starts" : "does not start"}`);
}
