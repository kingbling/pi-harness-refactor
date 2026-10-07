import type { Diagnosis, TargetAdapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import { resolveChoices } from "../init/stack.ts";
import type { ModelClient } from "../models/types.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLAIN_LANGUAGE } from "../policy.ts";

/**
 * Environment doctor: when triage says a gate failure is not the code's fault, find out why before asking a
 * human. Adapter rules first (certain: e.g. a test imports another runner's package → the tests are wrong),
 * then the escalate model reading the gate output and the installed packages. The orchestrator acts on the result:
 *   retest / reimplement → done automatically (capped), the note goes into the next prompt
 *   fix                  → one exact command; the human is told it is easily fixable
 *   unknown              → the human gets the model's explanation
 */
export async function diagnoseFailure(o: { config: Config; adapter: TargetAdapter; projectDir: string; failedStep: string; output: string; client?: ModelClient }): Promise<Diagnosis> {
	const expected = resolveChoices(o.adapter, o.config.target.choices).flatMap((c) => c.option.packages ?? []);
	const rule = o.adapter.diagnose?.(o.projectDir, o.failedStep, o.output, o.adapter.layout.isTestFile, expected);
	if (rule) return rule;
	if (!o.client) return { action: "unknown", summary: "no rule matched and no model available", by: "rule" };
	const deps = o.adapter.toolchain.installedPackages(o.projectDir).join(", ");
	const schema = {
		type: "object",
		additionalProperties: false,
		required: ["action", "summary", "command", "note"],
		properties: {
			action: { type: "string", enum: ["retest", "reimplement", "fix", "unknown"] },
			summary: { type: "string", description: "one sentence: the cause" },
			command: { type: "string", description: "for fix: one exact shell command run in the project directory, else empty" },
			note: { type: "string", description: "for retest/reimplement: the instruction for the agent, else empty" },
		},
	};
	try {
		const r = await o.client.chat({
			model: o.config.models.escalate.id,
			tier: o.config.models.escalate.tier as "default" | "flex" | "priority",
			effort: "low",
			schema,
			messages: [
				{ role: "system", content: `You diagnose why a migration gate step failed. retest = the generated tests are wrong; reimplement = the generated code is wrong; fix = the project setup is missing something one command fixes; unknown = you cannot tell. Never propose editing tests to pass or skipping checks. The summary is shown to the owner.\n\n${PLAIN_LANGUAGE}` },
				{ role: "user", content: `Failed step: ${o.failedStep}\nInstalled packages: ${deps}\nStack choices: ${JSON.stringify(o.config.target.choices)}\nOutput:\n${o.output.replace(/\x1b\[[0-9;]*m/g, "").slice(0, 4000)}` },
			],
		});
		const j = r.json as { action: Diagnosis["action"]; summary: string; command: string; note: string } | undefined;
		if (j?.action) return { action: j.action, summary: j.summary, command: j.command || undefined, note: j.note || undefined, by: "model" };
	} catch {
		/* model unavailable */
	}
	return { action: "unknown", summary: "could not diagnose", by: "model" };
}
