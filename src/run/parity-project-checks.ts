import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { TargetAdapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import { addWorktree, deleteBranch, headOf, isDirty, removeWorktree, wsBranch } from "../git.ts";
import { projectDir } from "../init/init.ts";
import { builderSteps, trackedFiles } from "./gate.ts";
import { runVerificationCommand } from "./parity-contracts.ts";

export interface ProjectValidation {
	head?: string;
	checks: Array<{ stack: string; step: string; cmd: string; args: string[]; tests?: string[]; ok: boolean; output: string }>;
	problems: string[];
}

/** Re-run build, lint, boot and all tracked ported tests on the final target snapshot without repair. */
export async function validateParityProjects(o: { config: Config; root: string; adapters: Map<string, TargetAdapter>; linkAll: (wt: string) => void | Promise<void>; log?: (line: string) => void }): Promise<ProjectValidation> {
	const repo = o.config.target.path;
	const wt = join(o.root, ".bigrefactor", "worktrees", "__parity-validation__");
	const branch = wsBranch(o.root, "parity-validation");
	const reset = async () => { await removeWorktree(repo, wt); await deleteBranch(repo, branch).catch(() => undefined); };
	await reset();
	await addWorktree(repo, wt, branch);
	const result: ProjectValidation = { head: await headOf(wt), checks: [], problems: [] };
	try {
		await o.linkAll(wt);
		for (const [stack, adapter] of o.adapters) {
			const dir = join(wt, relative(repo, projectDir(o.config, stack)));
			const files = await trackedFiles(dir);
			const code = files.filter((f) => adapter.layout.sourceExtensions.some((e) => f.endsWith(e)));
			const tests = code.filter((f) => adapter.layout.isTestFile(f));
			for (const f of tests) if (new RegExp(adapter.layout.skipMarker.source, adapter.layout.skipMarker.flags).test(readFileSync(join(dir, f), "utf8"))) result.problems.push(`${stack}: skipped/focused/incomplete test in ${f}`);
			const steps: Array<{ step: string; cmd: string; args: string[] }> = await builderSteps(adapter, dir);
			if (!steps.some((s) => s.step === "lint") && code.length) steps.push({ step: "lint", ...adapter.lint(dir, code) });
			if (tests.length) steps.push({ step: "test", ...adapter.test(dir, tests) });
			if (!steps.length) result.problems.push(`${stack}: no whole-project validation commands`);
			for (const s of steps) {
				o.log?.(`strict parity: ${stack} ${s.step}${s.step === "test" ? ` (${tests.length} test files)` : ""}`);
				try {
					const out = await runVerificationCommand(s, dir, 20 * 60_000, { ...process.env, CI: "1" });
					const output = [out.stdout, out.stderr].filter(Boolean).join("\n");
					const noTests = s.step === "test" && (!output.trim() || /no tests? (?:found|executed|ran)|(?:^|\n)\s*(?:tests?:?\s*0\b|0 tests?\b)/i.test(output));
					const skippedTests = s.step === "test" && /\b[1-9]\d*\s+(?:skipped|todo|pending)\b|\b(?:skipped|incomplete|pending)\s*:\s*[1-9]/i.test(output);
					result.checks.push({ stack, ...s, ...(s.step === "test" ? { tests } : {}), ok: !noTests && !skippedTests, output });
					if (noTests) result.problems.push(`${stack}: test command reported no tests executed`);
					if (skippedTests) result.problems.push(`${stack}: test command reported skipped/incomplete tests`);
				} catch (e) {
					result.checks.push({ stack, ...s, ...(s.step === "test" ? { tests } : {}), ok: false, output: String(e) });
					result.problems.push(`${stack}: ${s.step} failed on the final target snapshot`);
				}
			}
		}
		if (await isDirty(wt) || result.head !== await headOf(wt)) result.problems.push("whole-project checks modified the target snapshot");
		return result;
	} finally { await reset(); }
}
