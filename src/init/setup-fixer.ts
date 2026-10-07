import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import pc from "picocolors";
import { Type } from "typebox";
import { saveCommandOverride } from "../adapters/command-overrides.ts";
import type { TargetAdapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import { PLAIN_LANGUAGE } from "../policy.ts";
import { spawnLeaf } from "../sessions/spawn.ts";

/**
 * When a setup check fails (gate build/test on a fresh project, stack choices not installed), a model with tools
 * fixes it instead of the owner: it reads the error, runs commands in the new project (install, config) and, when
 * the stack's command itself no longer fits the installed tools (e.g. a flag a new major version removed), sets a
 * workspace override for that command. Code checks again afterwards; the model never decides that it worked.
 */

/** A command that cannot fail proves nothing: the gate would always be green. */
const NO_OP = /^(true|:|echo|exit|printf|sleep|yes)$/;

export function setCommandTool(root: string, stackId: string): ToolDefinition {
	return {
		name: "set_gate_command",
		label: "Set gate command",
		description: `Replace the ${stackId} gate's build, lint or test command for this workspace, when the built-in one does not fit the installed tools. Use "{files}" as one arg where the files go (lint: files to lint; test: test files to run; may be empty). It must really build/lint/test: commands that cannot fail are refused.`,
		promptSnippet: "set_gate_command: replace the stack's build/lint/test command for this workspace",
		parameters: Type.Object({ step: Type.Union([Type.Literal("build"), Type.Literal("lint"), Type.Literal("test")]), cmd: Type.String(), args: Type.Array(Type.String()), why: Type.String() }),
		execute: async (_id: string, p: { step: "build" | "lint" | "test"; cmd: string; args: string[]; why: string }) => {
			const out = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
			if (NO_OP.test(p.cmd.trim()) || /\|\|\s*(true|exit 0)|--passWithNoTests/.test(p.args.join(" "))) return out("refused: the command must be able to fail");
			saveCommandOverride(root, stackId, p.step, { cmd: p.cmd, args: p.args }, p.why);
			return out(`${p.step} command set to: ${[p.cmd, ...p.args].join(" ")} (the setup check runs again after your session)`);
		},
	} as unknown as ToolDefinition;
}

export type SetupFixer = (o: { config: Config; root: string; adapter: TargetAdapter; projectDir: string; problem: string; attempt: number }) => Promise<void>;

/** One model session that fixes the setup problem in the new project. */
export const fixSetupWithModel: SetupFixer = async (o) => {
	const b = o.adapter.build(o.projectDir);
	const t = o.adapter.test(o.projectDir, ["{files}"]);
	const l = o.adapter.lint(o.projectDir, ["{files}"]);
	const probe = o.adapter.probeTest?.(o.projectDir);
	console.log(pc.cyan(`  ${o.adapter.id}: setup check failed; a model with tools is fixing it (attempt ${o.attempt})`));
	const session = await spawnLeaf({
		role: "setup",
		cwd: o.projectDir,
		config: o.config,
		writeGlobs: ["**"],
		// test files may be written to try things: the code's own check writes its probe afresh, so a written test proves nothing
		protectedGlobs: [".git/**"],
		customTools: [setCommandTool(o.root, o.adapter.id)],
		transcriptPath: join(o.root, ".bigrefactor", "sessions", `__setup__.${o.adapter.id}.${o.attempt}.jsonl`),
		systemPrompt: `You set up a freshly generated ${o.adapter.id} project so a migration tool can build and test code in it. The tool checks the project with these commands (run in ${o.projectDir}):
- build: ${[b.cmd, ...b.args].join(" ")}
- lint: ${[l.cmd, ...l.args].join(" ")}
- test: ${[t.cmd, ...t.args].join(" ")}   ({files} = the test files to run)
${probe ? `The check writes ${probe.path} with this content, runs build, then lint and test with {files} = ${probe.path}, and also checks that the test command FAILS when the expectation is wrong:\n${probe.content}\nTo try it, write that file yourself and delete it afterwards.\n` : ""}Find the cause of the failure and fix it the way the tool's documentation says: install or configure what is missing, with the project's own package manager. When the command itself is wrong for the installed version (an option removed or renamed, a different runner), replace it with set_gate_command — check the tool's --help first. Never make checks pass by skipping or deleting tests, or by commands that cannot fail. Do not start dev servers or watch modes. Stop when the commands work; say in one sentence what you changed.

${PLAIN_LANGUAGE}`,
	});
	try {
		const r = await session.run(`The setup check failed:\n${o.problem.slice(-4000)}\n\nFix it, then run the failing command yourself to confirm.`);
		console.log(pc.dim(`  setup fix: ${r.toolCalls} tool calls, $${r.usage.cost.toFixed(4)} — ${r.text.trim().split("\n").at(-1) ?? ""}${r.error ? pc.red(` ERROR: ${r.error}`) : ""}`));
	} finally {
		session.dispose();
	}
};
