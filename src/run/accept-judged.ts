import type { TargetAdapter } from "../adapters/types.ts";
import type { Ledger } from "../ledger/db.ts";
import { runCmd } from "./builder.ts";
import { judgedAtMerge, wholeProjectSteps } from "./gate.ts";

/**
 * A hand accept (br accept, br unit --accept) commits the unit's code from main's checkout, and no merge check runs on
 * that path. Before it commits: a build/lint the gate deferred to the whole project runs now on that checkout and must
 * pass, and a wiring nobody judged refuses the accept. Returns why it cannot be accepted, or undefined. Nothing lands
 * on main without its verdicts.
 */
export async function judgeBeforeAccept(ledger: Ledger, adapter: TargetAdapter, dir: string, unitId: string): Promise<string | undefined> {
	const left = ledger.unjudged(unitId);
	const wiring = left.find((u) => u.type === "wired_ok");
	if (wiring) return `not judged: wired_ok (${wiring.note}); the reviewer judges it first (a run with a reviewer model)`;
	const owed = left.map((u) => u.type).filter((t) => t === "build_ok" || t === "lint_ok");
	if (!owed.length) return undefined;
	const steps = wholeProjectSteps(adapter, dir).filter((s) => owed.includes(`${s.step}_ok` as (typeof owed)[number]));
	const failed: string[] = [];
	for (const s of steps) {
		const err = await runCmd(s.cmd, s.args, dir);
		if (err !== undefined) failed.push(`$ ${[s.cmd, ...s.args].join(" ")}   (whole-project ${s.step})\n${err}`);
	}
	if (failed.length) return `the whole-project check fails with this unit in main's checkout, so its build is not judged green (fix main first, or let br run merge it: its merge check compares with main):\n${failed.join("\n\n")}`;
	judgedAtMerge(ledger, unitId, "the whole-project check passed in main's checkout with this unit (hand accept)");
	return undefined;
}
