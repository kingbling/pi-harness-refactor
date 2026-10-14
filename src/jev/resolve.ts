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
 * something changed or the owner must act; after MAX_RESOLVER_TRIES answers the owner decides. A parked or waiting unit's
 * question (quarantine, gate_env) never goes to the owner as "retry or leave": when the model's tries are used up or nothing a
 * model can do is left, the unit stays parked (br status lists it); only something a person must do or decide is
 * asked, in those words.
 */
export const RESOLVER = "resolver model";
/** Resolver answers on one point of one unit before the owner decides: a backstop, the model hands on earlier. */
export const MAX_RESOLVER_TRIES = 3;
/** Resolver calls that failed (provider down, no answer) before the question goes to the owner; tries wait longer each time. */
export const MAX_RESOLVER_FAILURES = 3;
const RESOLVER_RETRY_MS = 5 * 60_000;

/** Why a retry answer is no answer to this question (askStuckUnits' context.retry), or undefined when it is one. */
export function retryRefused(q: QuestionRow, answer: string, hint?: string): string | undefined {
  if (answerValue(answer).toLowerCase() !== "retry") return undefined;
  // "retry: <text>" carries its hint inline (optionFor, applyParkedAnswer read it the same way)
  const inline = /^retry: /i.test(answer) ? answer.slice(7).trim() : "";
  const ctx = q.context ? (JSON.parse(q.context) as { retry?: string; failureKind?: string }) : {};
  if (ctx.retry === "none") return "the unit's automatic tries are used up: a retry is no answer; a job (code_job, fix_job, layout_job) that changes main is";
  if (ctx.retry && !hint?.trim() && !inline) return `the unit was already retried on this kind of failure (${ctx.failureKind}) and it came back: a plain retry runs it again blind. Give a hint that changes the attempt (what to do differently, or what changed on main and how to use it), or call a job`;
  return undefined;
}

/** A parked or waiting unit's question (quarantine, an environment it fails on): its "leave" keeps it parked without asking the owner. */
const parks = (q: QuestionRow) => q.point === "quarantine" || q.point === "gate_env";

export type Resolution = { answer: string; why: string; hint?: string } | { owner: string } | { park: string } | { fix: string; then: string; stack?: string } | { code: string; then: string; stack?: string } | { layout: string; then: string; stack?: string };
/** A fix job: the big setup model changes the project setup on main for this question; returns what changed, or undefined. */
export type FixJob = (q: QuestionRow, what: string, stack?: string) => Promise<string | undefined>;
export const FIX_JOB = "setup model (fix job)";
/**
 * A code job: a model writes app code a unit needs but may not write (an endpoint, wiring, a shared fixture) on main, with tests.
 * { refused }: it wrote code that the check would not merge, and why.
 */
export type CodeJob = (q: QuestionRow, what: string, stack?: string) => Promise<string | { refused: string } | undefined>;
export const CODE_JOB = "code model (code job)";
/** A layout job: the stack's folder layout gets the slot the gate keeps refusing; applied when it only allows more, else the owner decides. */
export type LayoutJob = (q: QuestionRow, what: string, stack?: string) => Promise<{ applied: string } | { owner: string } | undefined>;
export const LAYOUT_JOB = "layout model (layout job)";
export type Resolver = (o: {
  config: Config;
  root: string;
  q: QuestionRow;
  /** the models' earlier answers on this point for this unit (and, marked with their unit, for others with the same problem), oldest first */
  earlier?: string[];
}) => Promise<Resolution | undefined>;

export async function resolveOpenQuestions(d: {
  ledger: Ledger;
  config: Config;
  root: string;
  resolver?: Resolver;
  /** runs the fix a resolver asks for (fix_job); without it such questions go to the owner */
  fixJob?: FixJob;
  /** runs the missing app code a resolver asks for (code_job); without it such questions go to the owner */
  codeJob?: CodeJob;
  /** widens a stack's folder layout as the resolver asks (layout_job); without it such questions go to the owner */
  layoutJob?: LayoutJob;
  /** when the plugin's code last changed: a question handed to the owner before that gets one more try (new tools may settle it) */
  pluginChangedAt?: number;
  log?: (l: string) => void;
}): Promise<{ answered: number; forOwner: number }> {
  let answered = 0;
  let forOwner = 0;
  for (const q of d.ledger.openQuestions()) {
    const ctx = q.context
      ? (JSON.parse(q.context) as { forOwner?: string; forOwnerAt?: number; resolverFailed?: number; resolverFailedAt?: number })
      : {};
    const again = ctx.forOwner !== undefined && !!d.pluginChangedAt && (ctx.forOwnerAt ?? 0) < d.pluginChangedAt;
    if (ctx.forOwner !== undefined && !again) continue;
    // the resolver failed on it lately (provider outage, rate limit): wait a little longer after each failure
    const failed = ctx.resolverFailed ?? 0;
    if (failed && Date.now() - (ctx.resolverFailedAt ?? 0) < failed * RESOLVER_RETRY_MS) continue;
    const { earlier, tries } = triedBefore(d.ledger, q);
    // what only a person can do, in those words: not "retry or leave"
    const askOwnerTo = (why: string) =>
      d.ledger.db.prepare("UPDATE questions SET question = ?, options = ? WHERE id = ?").run(`${q.unit_id} is parked until you do this: ${why}`, JSON.stringify(["retry — done, run it again", "leave — leave it parked"]), q.id);
    // a parked unit stays parked, quietly: br status lists it, the owner is not asked "retry or leave"
    const park = (why: string) => {
      d.ledger.answerQuestion(q.id, optionFor(q, "leave", why), RESOLVER);
      d.log?.(`question #${q.id} (${q.point} ${q.unit_id}): stays parked, the owner is not asked — ${why.slice(0, 160)}`);
      answered++;
    };
    if (tries >= MAX_RESOLVER_TRIES && !again && parks(q)) {
      park(`the resolver model answered this ${tries} times and it came back`);
      continue;
    }
    if (tries >= MAX_RESOLVER_TRIES && !again) {
      d.ledger.markForOwner(
        q.id,
        `the resolver model answered this ${tries} times and it came back`,
      );
      forOwner++;
      continue;
    }
    const r = await (d.resolver ?? resolveWithModel)({
      config: d.config,
      root: d.root,
      q,
      earlier,
    }).catch((e) => ({ failed: `the resolver model failed: ${e?.message ?? e}` }));
    if (d.ledger.getQuestion(q.id)?.status !== "open") continue; // answered meanwhile (owner, setup model …)
    if (!r || "failed" in r) {
      // a failed call says nothing about the question: it stays open and is tried again later; only after a few
      // failures in a row does the owner get it
      const why = r?.failed ?? "the resolver model gave no answer";
      if (failed + 1 < MAX_RESOLVER_FAILURES) {
        d.ledger.db
          .prepare("UPDATE questions SET context = json_set(COALESCE(context, '{}'), '$.resolverFailed', ?, '$.resolverFailedAt', ?) WHERE id = ?")
          .run(failed + 1, Date.now(), q.id);
        d.log?.(`question #${q.id}: ${why.slice(0, 160)}; tried again later`);
        continue;
      }
      d.ledger.db.prepare("UPDATE questions SET context = json_remove(context, '$.resolverFailed', '$.resolverFailedAt') WHERE id = ?").run(q.id);
      if (parks(q)) {
        park(`${why} (${failed + 1} times)`);
        continue;
      }
      d.ledger.markForOwner(q.id, `${why} (${failed + 1} times)`);
      forOwner++;
      continue;
    }
    if ("layout" in r) {
      const done = d.layoutJob
        ? await d.layoutJob(q, r.layout, r.stack).catch((e) => ({ owner: `the layout job failed: ${e?.message ?? e}` }))
        : undefined;
      if (d.ledger.getQuestion(q.id)?.status !== "open") continue;
      if (!done || "owner" in done) {
        const why = done?.owner ?? `a layout change is needed: ${r.layout}`;
        if (parks(q)) askOwnerTo(why);
        d.ledger.markForOwner(q.id, why);
        forOwner++;
        continue;
      }
      d.ledger.answerQuestion(q.id, optionFor(q, r.then, `the layout now allows: ${done.applied}`), LAYOUT_JOB);
      d.log?.(`question #${q.id} (${q.point}${q.unit_id ? ` ${q.unit_id}` : ""}) fixed by a layout job: ${done.applied.slice(0, 160)} → ${answerValue(r.then)}`);
      answered++;
      continue;
    }
    if ("fix" in r || "code" in r) {
      // the question waits while the job runs; a job that changed main answers it with the option the resolver chose (retry …)
      const [kind, job, what, by] = "fix" in r ? (["fix job", d.fixJob, r.fix, FIX_JOB] as const) : (["code job", d.codeJob, r.code, CODE_JOB] as const);
      const done = job
        ? await job(q, what, r.stack).catch((e) => (d.log?.(`${kind} for question #${q.id} failed: ${e?.message ?? e}`), undefined))
        : undefined;
      if (d.ledger.getQuestion(q.id)?.status !== "open") continue;
      const fixed = typeof done === "string" ? done : undefined;
      // a refused job did write something: the resolver sees why it stayed off main, not "changed nothing"
      const why = typeof done === "object" ? `a ${kind} wrote it but was not merged: ${done.refused.slice(0, 1500)} (asked for: ${what})` : `a ${kind} was tried and changed nothing: ${what}`;
      if (!fixed && parks(q)) {
        park(why);
        continue;
      }
      if (!fixed) {
        d.ledger.markForOwner(q.id, why);
        forOwner++;
        continue;
      }
      // what the job changed goes with the answer: the next attempt uses it instead of writing it again
      d.ledger.answerQuestion(q.id, optionFor(q, r.then, `what the ${kind} changed on main: ${fixed}`), by);
      d.log?.(`question #${q.id} (${q.point}${q.unit_id ? ` ${q.unit_id}` : ""}) fixed by a ${kind}: ${fixed.slice(0, 160)} → ${answerValue(r.then)}`);
      answered++;
      continue;
    }
    if ("park" in r && parks(q)) {
      park(r.park);
      continue;
    }
    if ("answer" in r && parks(q)) {
      // the code holds the line the prompt draws: a retry that changes nothing is not an answer
      const refused = retryRefused(q, r.answer, r.hint);
      if (refused) {
        park(`${refused} (the resolver model answered retry anyway)`);
        continue;
      }
    }
    if ("owner" in r || "park" in r) {
      const why = "owner" in r ? r.owner : r.park;
      if ("owner" in r && parks(q)) askOwnerTo(why);
      d.ledger.markForOwner(q.id, why);
      forOwner++;
      continue;
    }
    // the hint and what the model found go with the answer: a retry without them runs the unit again blind
    d.ledger.answerQuestion(q.id, optionFor(q, r.answer, [r.hint, r.why && `what the resolver found: ${r.why}`].filter(Boolean).join("\n")), RESOLVER);
    d.log?.(
      `question #${q.id} (${q.point}${q.unit_id ? ` ${q.unit_id}` : ""}) answered by the resolver model: ${answerValue(r.answer)} — ${r.why.slice(0, 160)}`,
    );
    answered++;
  }
  return { answered, forOwner };
}

/** Who answers for the run's models: their "retry" is one more try, never the owner's fresh set of tries. */
export const MODEL_ANSWERERS: readonly string[] = [RESOLVER, FIX_JOB, CODE_JOB, LAYOUT_JOB];

function triedBefore(ledger: Ledger, q: QuestionRow): { earlier: string[]; tries: number } {
  // a problem several units share (sameAs): the model sees what other units got, but only this unit's own answers count
  // as its tries; a resolver "leave" is no try either (it sends nothing back, it keeps the unit parked)
  const sameAs = q.context ? (JSON.parse(q.context) as { sameAs?: string }).sameAs : undefined;
  const rows = (
    ledger.db
      .prepare(
        `SELECT unit_id, answered_at, answer, answered_by FROM questions WHERE id != ? AND point = ? AND (unit_id IS ? OR json_extract(context, '$.sameAs') = ?) AND answered_by IN (?, ?, ?, ?) ORDER BY id`,
      )
      .all(q.id, q.point, q.unit_id, sameAs ?? null, ...MODEL_ANSWERERS) as Array<{ unit_id: string | null; answered_at: string; answer: string; answered_by: string }>
  ).filter((r) => !(r.answered_by === RESOLVER && answerValue(r.answer).toLowerCase() === "leave"));
  return {
    earlier: rows.map((r) => `${r.answered_at}${r.unit_id === q.unit_id ? "" : ` (unit ${r.unit_id})`}: ${r.answer}${r.answered_by === RESOLVER ? "" : ` (after a ${r.answered_by})`}`),
    tries: rows.filter((r) => r.unit_id === q.unit_id).length,
  };
}

export const resolveWithModel: Resolver = async ({ config, root, q, earlier }) => {
  let result: Resolution | undefined;
  const tool = (
    name: string,
    description: string,
    parameters: unknown,
    set: (p: any) => Resolution,
    refuse?: (p: any) => string | undefined,
  ) =>
    ({
      name,
      label: name,
      description,
      promptSnippet: `${name}: ${description}`,
      parameters,
      execute: async (_id: string, p: unknown) => {
        const no = refuse?.(p);
        if (no) return { content: [{ type: "text" as const, text: `not recorded: ${no}. Call another tool.` }], details: {} };
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
        "Answer the question: an option's value, or (where the question takes one) a short hint for the next attempt in your own words. why: what you read that settles it. hint: what the next attempt should do differently (the cause you found, the file and the change); it goes to the unit with your answer.",
        Type.Object({ answer: Type.String(), why: Type.String(), hint: Type.Optional(Type.String()) }),
        (p) => ({ answer: p.answer, why: p.why, hint: p.hint }),
        // a retry that changes nothing goes back to the model: it picks a job, a real hint, or says what is left
        (p) => (parks(q) ? retryRefused(q, p.answer, p.hint) : undefined),
      ),
      tool(
        "fix_job",
        "The cause is in the project setup (config, dependencies, tool and build files, environment files), not in app code: a model with write access to the new project fixes it on main while this question waits. It writes no app code. what: the problem and the change, concretely. then: the option value to answer once fixed (e.g. retry). stack: the target stack it is in, when the question names no unit.",
        Type.Object({ what: Type.String(), then: Type.String(), stack: Type.Optional(Type.String()) }),
        (p) => ({ fix: p.what, then: p.then, stack: p.stack }),
      ),
      tool(
        "code_job",
        "App code the unit needs is missing outside the unit's own files (an endpoint or API its screen calls, a service another module must expose, wiring into an entry file or router, a shared test fixture): a model writes it with tests on main while this question waits, then the unit runs again. what: exactly what to write and where, the legacy behaviour it must keep, and who uses it. then: the option value to answer once merged (e.g. retry). stack: the target stack the code goes in (it can differ from the unit's stack: a frontend unit's missing endpoint goes in the backend stack).",
        Type.Object({ what: Type.String(), then: Type.String(), stack: Type.Optional(Type.String()) }),
        (p) => ({ code: p.what, then: p.then, stack: p.stack }),
      ),
      tool(
        "layout_job",
        "The folder check keeps rejecting a path because the stack's layout (.bigrefactor/rules/<stack>/layout.json) has no slot for it, and moving the file is wrong (code next to it on main already lives there, or the framework needs it there). A model adds that slot to the layout; it is applied when it only allows more, else the owner decides. what: the path(s) to allow as a pattern (e.g. Security/{sub}/{Name}.php) and why they belong there. then: the option value to answer once applied (e.g. retry). stack: the target stack.",
        Type.Object({ what: Type.String(), then: Type.String(), stack: Type.Optional(Type.String()) }),
        (p) => ({ layout: p.what, then: p.then, stack: p.stack }),
      ),
      tool(
        "needs_owner",
        "Only a person can settle this (credentials, money, a business choice, something outside the code): say in one or two plain sentences what they must do or decide. Never \"retry or leave\".",
        Type.Object({ why: Type.String() }),
        (p) => ({ owner: p.why }),
      ),
      ...(parks(q)
        ? [
            tool(
              "leave_parked",
              "Nothing a model can do is left for this parked unit, and it needs nothing only a person can give: it stays parked (br status lists it) and the owner is not asked. why: what you checked and why no job or hint helps.",
              Type.Object({ why: Type.String() }),
              (p) => ({ park: p.why }),
            ),
          ]
        : []),
    ],
    systemPrompt: `An automated migration (${config.source.stack} → ${config.target.stacks.join(" + ")}) raised a question for its owner. Before the owner is bothered, you try to settle it. Legacy code: ${config.source.path}. New project: ${config.target.path}.
Read the files the question is about with your tools, then call exactly one tool:
- answer_question when the code, the facts and the owner's goals settle it. Never pick an option that says the owner did something (fixed the environment, raised a budget, edited a file by hand) — you cannot do that for them. A hint for the next attempt is fine when you found the cause and can say what to change.
- When the unit's own saved test is wrong (it contradicts itself or the legacy code), answer_question with retry and a hint naming the test and the exact change: the tester checks it again on the retry. fix_job and code_job cannot edit a unit's saved tests.
- fix_job when the cause is in the project setup and a model can change it (a missing file a config loads, a package, a service binding, a tool config, an env file): the fix runs first, the question waits; never send the owner a setup fix a model can make.
- code_job when app code is missing outside the unit's files (an endpoint, a service, wiring, a fixture the unit's tests need): a model writes it, the question waits. Missing code is never the owner's job, and "leave parked" or "retry" do not make it appear.
- A "write outside unit scope" red is never a code_job: the unit's own files (its stubs too) are its to write; answer_question with retry and a hint fixes it.
- layout_job when the folder check ("not an allowed file") keeps refusing a path and moving the file is wrong: look on main where code of the same kind already lives. A retry or a hint to "move it" does not help when nowhere allowed fits.
- needs_owner only when it needs something only a person can do or decide (credentials, money, a business choice, something outside the code). Missing code, a missing wiring or a red check is never that.${parks(q) ? "\n- leave_parked when nothing a model can do is left and nothing needs a person: the unit stays parked, the owner is not asked." : ""}${goalsText(config.goals) ? `\n\n${goalsText(config.goals)}` : ""}`,
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
          ? `This point was answered before (for this unit unless another unit is named), and it came back:\n${earlier.map((e) => `- ${e}`).join("\n")}\nThe same answer again only helps when something changed since (check: git log of the new project, a setup fix, a different error in the facts) or with a hint that changes what the next attempt does. If the cause is in the setup, call fix_job; if code outside the unit is missing, call code_job; if the folder layout has no slot for the path, call layout_job. If nothing a model can do is left, call ${parks(q) ? "leave_parked, or needs_owner when a person must do something (say what)" : "needs_owner and say what the owner must do"}.`
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
