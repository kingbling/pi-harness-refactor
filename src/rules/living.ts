import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getTargetAdapter } from "../adapters/registry.ts";
import { answerValue, askViaModel, loadBrief, type AskDeps } from "../jev/ask.ts";
import { composeRules, renderLayoutSection, rulesDir, stripLayout } from "./layout.ts";

/**
 * Living rules. The first version of a stack's rules is written at onboarding from the docs and a first look
 * at the repo; agents learn more on every unit. They propose (propose_rule), a curator (escalate model) merges
 * proposals into the next version:
 *  - additions/clarifications are merged without asking;
 *  - a change that makes already-accepted code wrong is "breaking": it becomes a question (via a model, with
 *    opinion) and is merged only after "apply";
 *  - each version is kept in history/RULES.v<n>.md; the layout section is always re-rendered from the adapter.
 */
export interface RuleProposal {
	id: number;
	stack: string;
	unit_id: string | null;
	kind: "add" | "change";
	text: string;
	why: string;
	evidence: string | null;
	status: "pending" | "approved" | "merged" | "rejected" | "asked" | "refused";
	version: number | null;
	question_id: number | null;
	created_at: string;
}

export function proposeRule(d: Pick<AskDeps, "ledger">, p: { stack: string; unitId?: string; kind: "add" | "change"; text: string; why: string; evidence?: string }): number {
	const dup = d.ledger.db.prepare("SELECT id FROM rule_proposals WHERE stack = ? AND text = ? AND status IN ('pending','approved','asked','refused')").get(p.stack, p.text) as { id: number } | undefined;
	if (dup) return dup.id;
	const r = d.ledger.db.prepare("INSERT INTO rule_proposals(stack, unit_id, kind, text, why, evidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(p.stack, p.unitId ?? null, p.kind, p.text, p.why, p.evidence ?? null, new Date().toISOString());
	return Number(r.lastInsertRowid);
}

export function rulesVersion(d: Pick<AskDeps, "ledger">, stack: string): number {
	return Number(d.ledger.getMeta(`rules_version:${stack}`) ?? "1");
}

/** Save a stack's rules as a new version (layout re-rendered from the adapter). Same text as now = no new version: the current one is returned. */
export async function saveRulesVersion(d: Pick<AskDeps, "ledger"> & { root: string }, stack: string, body: string, opts: { version?: number } = {}): Promise<number> {
	const adapter = await getTargetAdapter(stack);
	const dir = rulesDir(d.root, stack);
	mkdirSync(join(dir, "history"), { recursive: true });
	const md = composeRules(adapter, body);
	const path = join(dir, "RULES.md");
	if (opts.version === undefined && existsSync(path) && readFileSync(path, "utf8") === md) return rulesVersion(d, stack);
	const version = opts.version ?? rulesVersion(d, stack) + 1;
	writeFileSync(path, md);
	writeFileSync(join(dir, "history", `RULES.v${version}.md`), md);
	d.ledger.setMeta(`rules_version:${stack}`, String(version));
	return version;
}

/**
 * The layout section is code, not a model's words: when the adapter changed since RULES.md was written, it is
 * re-rendered (body kept) instead of stopping anyone. Returns the stacks whose section was out of date.
 */
export async function refreshRulesLayout(d: Pick<AskDeps, "ledger"> & { root: string }, stacks: string[]): Promise<string[]> {
	const out: string[] = [];
	for (const stack of stacks) {
		const path = join(rulesDir(d.root, stack), "RULES.md");
		if (!existsSync(path)) continue;
		const md = readFileSync(path, "utf8");
		if (md.includes(renderLayoutSection(await getTargetAdapter(stack)))) continue;
		await saveRulesVersion(d, stack, stripLayout(md));
		out.push(stack);
	}
	return out;
}

/**
 * Called by the scheduler after each accepted unit. Cheap no-op unless a stack has ≥ threshold proposals
 * (pending + approved). Without a client nothing is curated (proposals wait).
 */
export async function maybeCurateRules(d: AskDeps & { root: string }, opts: { threshold?: number; force?: boolean } = {}): Promise<{ versions: Record<string, number>; asked: number; costUsd: number; refused: Array<{ stack: string; id: number; text: string; reason: string }> }> {
	syncRuleAnswers(d);
	const result = { versions: {} as Record<string, number>, asked: 0, costUsd: 0, refused: [] as Array<{ stack: string; id: number; text: string; reason: string }> };
	if (!d.client) return result;
	for (const stack of d.config.target.stacks) {
		const open = d.ledger.db.prepare("SELECT * FROM rule_proposals WHERE stack = ? AND status IN ('pending','approved') ORDER BY id").all(stack) as unknown as RuleProposal[];
		// only proposals the curator has not seen count toward the threshold: ones it left out stay open for the next
		// curation but must not trigger a new one on every accept
		const seenKey = `rules_seen:${stack}`;
		const seen = Number(d.ledger.getMeta(seenKey) ?? "0");
		const fresh = open.filter((p) => p.id > seen || p.status === "approved").length;
		if (!fresh || (!opts.force && fresh < (opts.threshold ?? 5))) continue;
		d.ledger.setMeta(seenKey, String(Math.max(seen, ...open.map((p) => p.id))));
		const path = join(rulesDir(d.root, stack), "RULES.md");
		const current = existsSync(path) ? stripLayout(readFileSync(path, "utf8")).trim() : "";
		const role = d.config.models.escalate;
		const res = await d.client.chat({
			model: role.id,
			tier: role.tier as "default" | "flex" | "priority",
			effort: "medium",
			schema: {
				type: "object",
				additionalProperties: false,
				required: ["body", "merged", "rejected", "breaking"],
				properties: {
					body: { type: "string", description: "the complete new rules body (markdown, without the layout section)" },
					merged: { type: "array", items: { type: "number" } },
					rejected: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "reason"], properties: { id: { type: "number" }, reason: { type: "string" } } } },
					breaking: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "impact"], properties: { id: { type: "number" }, impact: { type: "string", description: "what already-migrated code would now violate" } } } },
				},
			},
			messages: [
				{ role: "system", content: `You curate the coding rules for the ${stack} side of an automated migration. Agents follow these rules with tiny context: keep them concrete, short (≤ 150 lines), non-contradictory, grounded in the evidence. Merge proposals that generalize; reject one-off or wrong ones with a reason. A proposal is BREAKING when code written under the current rules would violate it — do not merge breaking ones unless their status is "approved"; list them under breaking. Never add a module layout section: the layout is generated separately and is binding.` },
				{ role: "user", content: `Repo brief:\n${loadBrief(d.root).slice(0, 4000)}\n\nCurrent rules (v${rulesVersion(d, stack)}):\n${current}\n\nProposals:\n${JSON.stringify(open.map((p) => ({ id: p.id, kind: p.kind, status: p.status, text: p.text, why: p.why, evidence: p.evidence, unit: p.unit_id })), null, 1)}` },
			],
		});
		result.costUsd += res.usage.costUsd;
		const j = (res.json ?? {}) as { body?: string; merged?: number[]; rejected?: Array<{ id: number; reason: string }>; breaking?: Array<{ id: number; impact: string }> };
		if (!j.body?.trim()) continue;
		const before = rulesVersion(d, stack);
		const version = await saveRulesVersion(d, stack, j.body);
		if (version !== before) result.versions[stack] = version;
		for (const id of j.merged ?? []) d.ledger.db.prepare("UPDATE rule_proposals SET status = 'merged', version = ? WHERE id = ? AND stack = ?").run(version, id, stack);
		for (const r of j.rejected ?? []) {
			const p = open.find((x) => x.id === r.id);
			if (!p) continue;
			// the owner said apply and the curator still says no: final ("refused"), kept on the question with the
			// reason, never curated again; otherwise the owner's answer would put it back and the curator reject it forever
			const final = p.status === "approved";
			d.ledger.db.prepare("UPDATE rule_proposals SET status = ?, why = why || ' | rejected: ' || ? WHERE id = ?").run(final ? "refused" : "rejected", r.reason, p.id);
			if (!final) continue;
			if (p.question_id !== null) d.ledger.db.prepare("UPDATE questions SET context = json_set(COALESCE(context, '{}'), '$.curatorRefused', ?) WHERE id = ?").run(r.reason, p.question_id);
			result.refused.push({ stack, id: p.id, text: p.text, reason: r.reason });
		}
		for (const b of j.breaking ?? []) {
			const p = open.find((x) => x.id === b.id);
			if (!p || p.status === "approved") continue;
			const q = await askViaModel(d, {
				point: "rule_change",
				facts: `An agent proposed a ${stack} rule change: "${p.text}" (why: ${p.why}${p.evidence ? `; evidence: ${p.evidence}` : ""}). The curator says it is breaking: ${b.impact}. Applying it means later units follow the new rule; already-accepted code stays as it is until reworked.`,
				options: [
					{ value: "apply", facts: "adopt the rule from now on" },
					{ value: "reject", facts: "keep the current rules" },
				],
				agentOpinion: p.why,
				blocks: "none",
				askedBy: "curator",
				context: { proposal: p.id, stack },
			});
			result.costUsd += q.costUsd;
			result.asked++;
			d.ledger.db.prepare("UPDATE rule_proposals SET status = 'asked', question_id = ? WHERE id = ?").run(q.id, p.id);
		}
	}
	return result;
}

/** Answered rule-change questions: apply → approved (merged on the next curation), reject → rejected. The owner's later answer to a run-decided one changes it until it is merged, or until the curator refuses it after an apply (final). */
export function syncRuleAnswers(d: Pick<AskDeps, "ledger">): void {
	const rows = d.ledger.db.prepare("SELECT p.id, x.answer FROM rule_proposals p JOIN questions x ON x.id = p.question_id WHERE (p.status = 'asked' AND x.status IN ('answered','auto')) OR (p.status IN ('approved','rejected') AND x.status = 'answered')").all() as Array<{ id: number; answer: string }>;
	for (const r of rows) d.ledger.db.prepare("UPDATE rule_proposals SET status = ? WHERE id = ?").run(answerValue(r.answer) === "apply" ? "approved" : "rejected", r.id);
}
