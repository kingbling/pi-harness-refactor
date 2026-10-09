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
 * decide. Questions it hands on carry context.forOwner; those are the ones shown in the foreground. When the resolver
 * answered the same point for the same unit before and it came back, it sees those answers and decides whether
 * something changed or the owner must act; after MAX_RESOLVER_TRIES answers the owner decides.
 */
export const RESOLVER = "resolver model";
/** Resolver answers on one point of one unit before the owner decides: a backstop, the model hands on earlier. */
export const MAX_RESOLVER_TRIES = 3;

export type Resolution = { answer: string; why: string } | { owner: string } | { fix: string; then: string; stack?: string };
/** A fix job: the big setup model changes the project setup on main for this question; returns what changed, or undefined. */
export type FixJob = (q: QuestionRow, what: string, stack?: string) => Promise<string | undefined>;
export const FIX_JOB = "setup model (fix job)";
export type Resolver = (o: {
  config: Config;
  root: string;
  q: QuestionRow;
  /** the resolver's earlier answers on this point for this unit, oldest first (they came back) */
  earlier?: string[];
}) => Promise<Resolution | undefined>;

export async function resolveOpenQuestions(d: {
  ledger: Ledger;
  config: Config;
  root: string;
  resolver?: Resolver;
  /** runs the fix a resolver asks for (fix_job); without it such questions go to the owner */
  fixJob?: FixJob;
  log?: (l: string) => void;
}): Promise<{ answered: number; forOwner: number }> {
  let answered = 0;
  let forOwner = 0;
  for (const q of d.ledger.openQuestions()) {
    const ctx = q.context
      ? (JSON.parse(q.context) as { forOwner?: string })
      : {};
    if (ctx.forOwner !== undefined) continue;
    const earlier = triedBefore(d.ledger, q);
    if (earlier.length >= MAX_RESOLVER_TRIES) {
      d.ledger.markForOwner(
        q.id,
        `the resolver model answered this ${earlier.length} times and it came back`,
      );
      forOwner++;
      continue;
    }
    const r = await (d.resolver ?? resolveWithModel)({
      config: d.config,
      root: d.root,
      q,
      earlier,
    }).catch((e) => ({
      owner: `the resolver model failed: ${e?.message ?? e}`,
    }));
    if (d.ledger.getQuestion(q.id)?.status !== "open") continue; // answered meanwhile (owner, setup model …)
    if (r && "fix" in r) {
      // the question waits while the fix job runs; a fix answers it with the option the resolver chose (retry …)
      const fixed = d.fixJob
        ? await d.fixJob(q, r.fix, r.stack).catch((e) => (d.log?.(`fix job for question #${q.id} failed: ${e?.message ?? e}`), undefined))
        : undefined;
      if (d.ledger.getQuestion(q.id)?.status !== "open") continue;
      if (!fixed) {
        d.ledger.markForOwner(q.id, `a fix job was tried and changed nothing: ${r.fix}`);
        forOwner++;
        continue;
      }
      d.ledger.answerQuestion(q.id, optionFor(q, r.then), FIX_JOB);
      d.log?.(`question #${q.id} (${q.point}${q.unit_id ? ` ${q.unit_id}` : ""}) fixed by a fix job: ${fixed.slice(0, 160)} → ${answerValue(r.then)}`);
      answered++;
      continue;
    }
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

function triedBefore(ledger: Ledger, q: QuestionRow): string[] {
  return (
    ledger.db
      .prepare(
        "SELECT answered_at, answer FROM questions WHERE id != ? AND point = ? AND unit_id IS ? AND answered_by = ? ORDER BY id",
      )
      .all(q.id, q.point, q.unit_id, RESOLVER) as Array<{ answered_at: string; answer: string }>
  ).map((r) => `${r.answered_at}: ${r.answer}`);
}

export const resolveWithModel: Resolver = async ({ config, root, q, earlier }) => {
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
        "fix_job",
        "The cause is in the project setup (config, dependencies, tool files, wiring, assets, environment files), not in a unit's own code: a model with write access to the new project fixes it on main while this question waits. what: the problem and the change, concretely. then: the option value to answer once fixed (e.g. retry). stack: the target stack it is in, when the question names no unit.",
        Type.Object({ what: Type.String(), then: Type.String(), stack: Type.Optional(Type.String()) }),
        (p) => ({ fix: p.what, then: p.then, stack: p.stack }),
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
- fix_job when the cause is in the project setup and a model can change it (a missing file a config loads, a package, a service binding, a route, an env file): the fix runs first, the question waits; never send the owner a setup fix a model can make.
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
        earlier?.length
          ? `You answered this point for this unit before, and it came back:\n${earlier.map((e) => `- ${e}`).join("\n")}\nThe same answer again only helps when something changed since (check: git log of the new project, a setup fix, a different error in the facts) or with a hint that changes what the next attempt does. If the cause is in the setup, call fix_job. If nothing a model can do is left, call needs_owner and say what the owner must do.`
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
