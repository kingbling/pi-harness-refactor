import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Config } from "../config.ts";
import type { Ledger } from "../ledger/db.ts";
import type { QuestionRow } from "../ledger/schema.ts";
import { goalsText } from "../policy.ts";
import { spawnLeaf } from "../sessions/spawn.ts";
import { answerValue, loadBrief, optionFor } from "./ask.ts";

/**
 * Before an open question reaches the owner, a model with read tools tries it: it reads the legacy code, the new
 * project and the facts, then answers (an option, or a hint the next attempt gets) or says why only the owner can
 * decide. Questions it hands on carry context.forOwner; those are the ones shown in the foreground. Each question is
 * tried once; when the resolver already answered the same point for the same unit and it came back, the owner decides.
 */
export const RESOLVER = "resolver model";

export type Resolution = { answer: string; why: string } | { owner: string };
export type Resolver = (o: {
  config: Config;
  root: string;
  q: QuestionRow;
}) => Promise<Resolution | undefined>;

export async function resolveOpenQuestions(d: {
  ledger: Ledger;
  config: Config;
  root: string;
  resolver?: Resolver;
  log?: (l: string) => void;
}): Promise<{ answered: number; forOwner: number }> {
  let answered = 0;
  let forOwner = 0;
  for (const q of d.ledger.openQuestions()) {
    const ctx = q.context
      ? (JSON.parse(q.context) as { forOwner?: string })
      : {};
    if (ctx.forOwner !== undefined) continue;
    if (triedBefore(d.ledger, q)) {
      d.ledger.markForOwner(
        q.id,
        "the resolver model answered this before and it came back",
      );
      forOwner++;
      continue;
    }
    const r = await (d.resolver ?? resolveWithModel)({
      config: d.config,
      root: d.root,
      q,
    }).catch((e) => ({
      owner: `the resolver model failed: ${e?.message ?? e}`,
    }));
    if (d.ledger.getQuestion(q.id)?.status !== "open") continue; // answered meanwhile (owner, setup model …)
    if (!r || "owner" in r) {
      d.ledger.markForOwner(
        q.id,
        r?.owner ?? "the resolver model gave no answer",
      );
      forOwner++;
      continue;
    }
    d.ledger.answerQuestion(q.id, optionFor(q, r.answer), RESOLVER);
    d.log?.(
      `question #${q.id} (${q.point}${q.unit_id ? ` ${q.unit_id}` : ""}) answered by the resolver model: ${answerValue(r.answer)} — ${r.why.slice(0, 160)}`,
    );
    answered++;
  }
  return { answered, forOwner };
}

function triedBefore(ledger: Ledger, q: QuestionRow): boolean {
  return !!ledger.db
    .prepare(
      "SELECT 1 FROM questions WHERE id != ? AND point = ? AND unit_id IS ? AND answered_by = ?",
    )
    .get(q.id, q.point, q.unit_id, RESOLVER);
}

export const resolveWithModel: Resolver = async ({ config, root, q }) => {
  let result: Resolution | undefined;
  const tool = (
    name: string,
    description: string,
    parameters: unknown,
    set: (p: any) => Resolution,
  ) =>
    ({
      name,
      label: name,
      description,
      promptSnippet: `${name}: ${description}`,
      parameters,
      execute: async (_id: string, p: unknown) => {
        result = set(p);
        return {
          content: [{ type: "text" as const, text: "recorded; stop here" }],
          details: {},
        };
      },
    }) as unknown as ToolDefinition;
  const session = await spawnLeaf({
    role: "review",
    cwd: config.target.path,
    config,
    writeGlobs: [],
    customTools: [
      tool(
        "answer_question",
        "Answer the question: an option's value, or (where the question takes one) a short hint for the next attempt in your own words. why: what you read that settles it.",
        Type.Object({ answer: Type.String(), why: Type.String() }),
        (p) => ({ answer: p.answer, why: p.why }),
      ),
      tool(
        "needs_owner",
        "Only the owner can settle this: say why in one or two plain sentences (what they must do or decide).",
        Type.Object({ why: Type.String() }),
        (p) => ({ owner: p.why }),
      ),
    ],
    systemPrompt: `An automated migration (${config.source.stack} → ${config.target.stacks.join(" + ")}) raised a question for its owner. Before the owner is bothered, you try to settle it. Legacy code: ${config.source.path}. New project: ${config.target.path}.
Read the files the question is about with your tools, then call exactly one tool:
- answer_question when the code, the facts and the owner's goals settle it. Never pick an option that says the owner did something (fixed the environment, raised a budget, edited a file by hand) — you cannot do that for them. A hint for the next attempt is fine when you found the cause and can say what to change.
- needs_owner when it needs something only a person can do or decide (credentials, money, a business choice, a fix outside the code).${goalsText(config.goals) ? `\n\n${goalsText(config.goals)}` : ""}`,
  });
  try {
    const brief = loadBrief(root);
    await session.run(
      [
        `Question #${q.id} (${q.point}${q.unit_id ? `, unit ${q.unit_id}` : ""}):\n${q.question}`,
        q.options
          ? `Options:\n${(JSON.parse(q.options) as string[]).map((o) => `- ${o}`).join("\n")}`
          : "No options: answer in words.",
        q.context
          ? `Facts:\n${JSON.stringify(JSON.parse(q.context), null, 1).slice(0, 6000)}`
          : "",
        brief ? `What the legacy repo is:\n${brief.slice(0, 4000)}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
    return result;
  } finally {
    session.dispose();
  }
};
