import pc from "picocolors";
import type { Config } from "./config.ts";
import type { ModelClient } from "./models/types.ts";

/**
 * `br smoke`: every configured model id must exist in the catalog and answer one tiny live call,
 * on the configured tier. Prints what actually served it and what it cost.
 */
export async function smoke(client: ModelClient, config?: Config): Promise<boolean> {
	const roles = config?.models ?? {
		decide: { id: "typesafe/jev-1.13", tier: "default" as const, fallback: [] },
		implement: { id: "openai/gpt-6-luna", tier: "flex" as const, fallback: [] },
		test: { id: "openai/gpt-6-luna", tier: "flex" as const, fallback: [] },
		escalate: { id: "openai/gpt-6.1-sol", tier: "flex" as const, fallback: [] },
	};
	let ok = true;
	for (const [role, m] of Object.entries(roles)) {
		const t0 = Date.now();
		const line = (s: string) => console.log(`${role.padEnd(10)} ${m.id.padEnd(24)} ${m.tier.padEnd(8)} ${s}`);
		const r = await client.resolveModel(m.id);
		if (!r.exists) {
			ok = false;
			line(pc.red(`NOT IN CATALOG${r.note ? ` — ${r.note}` : ""}`));
			continue;
		}
		try {
			if (role === "decide") {
				const d = await client.decide({
					model: m.id,
					state: { text: "function add(a, b) { return a + b; }" },
					questions: {
						is_pure: { type: "noul", instructions: "Does `text` describe a function with no side effects?" },
						lang: { type: "choice", instructions: "Which language is `text` written in?", criteria: { javascript: "JavaScript or TypeScript", php: "PHP", python: "Python", other: "Something else" } },
					},
				});
				const lang = d.answers["lang"];
				const pure = d.answers["is_pure"];
				line(
					pc.green(`ok ${Date.now() - t0}ms`) +
						`  lang=${lang?.type === "choice" ? `${lang.choice}@${lang.confidence.toFixed(2)}` : "?"} pure=${pure?.type === "noul" ? pure.noul.toFixed(2) : "?"}  $${d.usage.costUsd.toFixed(6)}  ctx=${r.contextLength}`,
				);
			} else {
				const c = await client.chat({
					model: m.id,
					tier: m.tier,
					effort: "low",
					maxTokens: 20,
					messages: [{ role: "user", content: "Reply with exactly: ok" }],
				});
				line(
					pc.green(`ok ${Date.now() - t0}ms`) +
						`  served=${c.usage.model}${c.usage.tierServed ? `/${c.usage.tierServed}` : ""}  "${c.text.trim().slice(0, 20)}"  $${c.usage.costUsd.toFixed(6)}  in/out ${c.usage.inputTokens}/${c.usage.outputTokens}  $${r.pricing?.prompt}/$${r.pricing?.completion} per tok`,
				);
			}
		} catch (e: any) {
			ok = false;
			line(pc.red(`FAILED ${e?.message ?? e}`));
		}
	}
	return ok;
}
