import { join, relative } from "node:path";
import { loadCommandOverrides } from "../adapters/command-overrides.ts";
import { getTargetAdapter } from "../adapters/registry.ts";
import type { Config } from "../config.ts";
import { projectDir } from "../init/init.ts";
import type { Ledger } from "../ledger/db.ts";
import { finishCheck, renderFinishLine } from "./finish-check.ts";
import { linkDependencies } from "./run.ts";
import { verificationSummary } from "./parity-verification.ts";

/**
 * `br finish` and `/br finish`: the finish check on demand, as a report. It hands nothing on: when no unit is left
 * to run, br run does the same check and sends what it finds to code jobs (and asks you what only you can settle).
 */
export async function finishCommand(o: { ledger: Ledger; config: Config; root: string; log?: (l: string) => void }): Promise<string[]> {
	const { ledger, config, root } = o;
	process.env["BR_WORKSPACE"] = root; // generated stacks' adapters and layout live in this workspace
	const adapters = new Map(await Promise.all(config.target.stacks.map(async (id) => [id, await getTargetAdapter(id)] as const)));
	const linkAll = async (wt: string) => {
		for (const [id, a] of adapters) await linkDependencies(projectDir(config, id), join(wt, relative(config.target.path, projectDir(config, id))), a.toolchain.worktreeLinks, loadCommandOverrides(root, id).worktreeCopy ?? []);
	};
	const r = await finishCheck({ ledger, config, root, adapters, linkAll, log: o.log ?? (() => {}), label: "finish-now" });
	return [
		renderFinishLine(r),
		verificationSummary(ledger),
		...r.items.map((i) => `  ${i.human ? "for you" : i.stack}: ${i.problem}\n    → ${i.fix.split("\n")[0]}${i.human ? ` (${i.human})` : ""}`),
		r.items.some((i) => !i.human) ? "br run hands these to code jobs when no unit is left to run" : "",
	].filter(Boolean);
}
