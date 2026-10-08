import { DatabaseSync } from "node:sqlite";
import {
	DDL,
	REQUIRED_FOR_ACCEPTED,
	REQUIRED_FOR_TESTED,
	SYMBOL_TRANSITIONS,
	TERMINAL_SYMBOL_STATES,
	type EvidenceType,
	type MoveOp,
	type SymbolState,
	type UnitState,
	type QuestionBlocks,
	type QuestionRow,
} from "./schema.ts";

export class LedgerError extends Error {}

export interface SymbolRow {
	id: string;
	path: string;
	kind: string;
	name: string;
	exported: number;
	tier: string | null;
	unit_id: string | null;
	state: SymbolState;
	reason: string | null;
	evidence_id: number | null;
	updated_at: string;
}
export interface UnitRow {
	id: string;
	tier: string;
	kind: string | null;
	state: UnitState;
	attempts: number;
	cost_usd: number;
	model: string | null;
	worktree: string | null;
	branch: string | null;
	contract_path: string | null;
	deps: string;
	meta: string;
	updated_at: string;
}
export interface FileRow {
	path: string;
	hash: string;
	lang: string;
	loc: number;
	tier: string | null;
	dead_code: number;
	dead_code_reason: string | null;
	updated_at: string;
}

const now = () => new Date().toISOString();

/**
 * The ledger is the single source of truth. Every state change goes through `transition()`,
 * which enforces the allowed transition graph and the evidence requirements, and records a
 * `transitions` row so `br why` can replay the full history.
 */
export class Ledger {
	readonly db: DatabaseSync;

	constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec(DDL);
	}

	close(): void {
		this.db.close();
	}

	// ---- meta --------------------------------------------------------------

	getMeta(key: string): string | undefined {
		const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
		return row?.value;
	}
	setMeta(key: string, value: string): void {
		this.db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
	}

	// ---- files & symbols ---------------------------------------------------

	upsertFile(f: { path: string; hash: string; lang: string; loc: number } & Partial<FileRow>): void {
		this.db
			.prepare(
				`INSERT INTO files(path, hash, lang, loc, tier, dead_code, dead_code_reason, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, lang=excluded.lang, loc=excluded.loc,
           tier=COALESCE(excluded.tier, files.tier), updated_at=excluded.updated_at`,
			)
			.run(f.path, f.hash, f.lang, f.loc, f.tier ?? null, f.dead_code ?? 0, f.dead_code_reason ?? null, now());
	}

	upsertSymbol(s: { id: string; path: string; kind: string; name: string; exported?: boolean; tier?: string | null }): void {
		this.db
			.prepare(
				`INSERT INTO symbols(id, path, kind, name, exported, tier, state, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'discovered', ?)
         ON CONFLICT(id) DO UPDATE SET path=excluded.path, kind=excluded.kind, name=excluded.name,
           exported=excluded.exported, tier=COALESCE(excluded.tier, symbols.tier), updated_at=excluded.updated_at`,
			)
			.run(s.id, s.path, s.kind, s.name, s.exported === false ? 0 : 1, s.tier ?? null, now());
	}

	getSymbol(id: string): SymbolRow | undefined {
		return this.db.prepare("SELECT * FROM symbols WHERE id = ?").get(id) as unknown as SymbolRow | undefined;
	}
	symbolsOfUnit(unitId: string): SymbolRow[] {
		return this.db.prepare("SELECT * FROM symbols WHERE unit_id = ? ORDER BY path, name").all(unitId) as unknown as SymbolRow[];
	}
	symbolsOfFile(path: string): SymbolRow[] {
		return this.db.prepare("SELECT * FROM symbols WHERE path = ? ORDER BY name").all(path) as unknown as SymbolRow[];
	}

	/**
	 * Undo what an earlier inventory decided for a file (dead code, framework, regenerated) when a re-run
	 * finds it alive: flags cleared, symbols the inventory dropped go back to discovered. Recorded as a
	 * transition so `br why` shows it. Symbols a human or agent dropped are left alone.
	 */
	reviveFile(path: string, reason: string): number {
		this.db.prepare("UPDATE files SET dead_code = 0, dead_code_reason = NULL, disposition = NULL, updated_at = ? WHERE path = ?").run(now(), path);
		let n = 0;
		for (const s of this.symbolsOfFile(path)) {
			if (s.state !== "dropped") continue;
			const last = this.db.prepare("SELECT reason FROM transitions WHERE entity = 'symbol' AND entity_id = ? ORDER BY id DESC LIMIT 1").get(s.id) as { reason: string } | undefined;
			if (!last || !/^(dead code|framework|regenerated):/.test(last.reason ?? "")) continue;
			this.db.prepare("UPDATE symbols SET state = 'discovered', unit_id = NULL, updated_at = ? WHERE id = ?").run(now(), s.id);
			this.db.prepare("INSERT INTO transitions(entity, entity_id, from_state, to_state, reason, created_at) VALUES ('symbol', ?, 'dropped', 'discovered', ?, ?)").run(s.id, `inventory: ${reason}`, now());
			n++;
		}
		return n;
	}
	/** An inventory may drop a symbol only before work on it started: discovered, or clustered into a still-planned unit. */
	private inventoryMayDrop(s: SymbolRow): boolean {
		if (s.state === "discovered") return true;
		if (s.state !== "clustered") return false;
		const u = s.unit_id ? this.getUnit(s.unit_id) : undefined;
		return !u || u.state === "planned";
	}
	private dropFromInventory(s: SymbolRow, reason: string): void {
		this.transitionSymbol(s.id, "dropped", reason);
		if (s.unit_id) this.db.prepare("UPDATE symbols SET unit_id = NULL WHERE id = ?").run(s.id);
	}
	markDeadCode(path: string, reason: string): void {
		this.db.prepare("UPDATE files SET dead_code = 1, dead_code_reason = ?, updated_at = ? WHERE path = ?").run(reason, now(), path);
		for (const s of this.symbolsOfFile(path)) {
			if (this.inventoryMayDrop(s)) this.dropFromInventory(s, `dead code: ${reason}`);
		}
	}

	// ---- units -------------------------------------------------------------

	createUnit(u: { id: string; tier: string; kind?: string; deps?: string[]; meta?: Record<string, unknown>; symbolIds: string[] }): void {
		const tx = this.db.prepare(
			`INSERT INTO units(id, tier, kind, state, deps, meta, updated_at) VALUES (?, ?, ?, 'planned', ?, ?, ?)`,
		);
		tx.run(u.id, u.tier, u.kind ?? null, JSON.stringify(u.deps ?? []), JSON.stringify(u.meta ?? {}), now());
		for (const id of new Set(u.symbolIds)) {
			// never take a symbol away from a unit that already started (truth … accepted)
			const r = this.db.prepare("UPDATE symbols SET unit_id = ?, updated_at = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM units o WHERE o.id = symbols.unit_id AND o.state != 'planned')").run(u.id, now(), id);
			if (r.changes === 0) continue;
			if (this.getSymbol(id)?.state === "discovered") this.transitionSymbol(id, "clustered", `assigned to unit ${u.id}`);
		}
	}

	getUnit(id: string): UnitRow | undefined {
		return this.db.prepare("SELECT * FROM units WHERE id = ?").get(id) as unknown as UnitRow | undefined;
	}
	listUnits(where?: { state?: UnitState; tier?: string }): UnitRow[] {
		const conds: string[] = [];
		const args: unknown[] = [];
		if (where?.state) (conds.push("state = ?"), args.push(where.state));
		if (where?.tier) (conds.push("tier = ?"), args.push(where.tier));
		const sql = `SELECT * FROM units ${conds.length ? "WHERE " + conds.join(" AND ") : ""} ORDER BY tier, id`;
		return this.db.prepare(sql).all(...(args as any[])) as unknown as UnitRow[];
	}
	updateUnit(id: string, patch: Partial<Pick<UnitRow, "model" | "worktree" | "branch" | "kind">> & { meta?: Record<string, unknown> }): void {
		const u = this.getUnit(id);
		if (!u) throw new LedgerError(`unknown unit ${id}`);
		const meta = patch.meta ? JSON.stringify({ ...JSON.parse(u.meta), ...patch.meta }) : u.meta;
		this.db
			.prepare("UPDATE units SET model=?, worktree=?, branch=?, kind=?, meta=?, updated_at=? WHERE id=?")
			.run(patch.model ?? u.model, patch.worktree ?? u.worktree, patch.branch ?? u.branch, patch.kind ?? u.kind, meta, now(), id);
	}

	transitionUnit(id: string, to: UnitState, reason?: string): void {
		const u = this.getUnit(id);
		if (!u) throw new LedgerError(`unknown unit ${id}`);
		if (to === "accepted") {
			const missing = REQUIRED_FOR_ACCEPTED.filter((t) => !this.hasEvidence(id, t));
			if (missing.length) throw new LedgerError(`unit ${id} cannot be accepted; missing evidence: ${missing.join(", ")}`);
			const unproven = this.symbolsOfUnit(id).filter((s) => !["mapped", "dropped", "tested", "accepted"].includes(s.state));
			if (unproven.length) throw new LedgerError(`unit ${id} cannot be accepted; unproven symbols: ${unproven.map((s) => s.id).join(", ")}`);
		}
		this.db.prepare("UPDATE units SET state = ?, updated_at = ? WHERE id = ?").run(to, now(), id);
		this.recordTransition("unit", id, u.state, to, reason);
		if (to === "accepted") {
			for (const s of this.symbolsOfUnit(id)) {
				if (s.state === "tested" || s.state === "mapped") {
					if (s.state === "mapped") this.transitionSymbol(s.id, "tested", "unit accepted", undefined, true);
					this.transitionSymbol(s.id, "accepted", "unit accepted");
				}
			}
		}
	}

	// ---- symbol transitions ------------------------------------------------

	transitionSymbol(id: string, to: SymbolState, reason?: string, evidenceId?: number, skipEvidenceCheck = false): void {
		const s = this.getSymbol(id);
		if (!s) throw new LedgerError(`unknown symbol ${id}`);
		if (!SYMBOL_TRANSITIONS[s.state].includes(to)) {
			throw new LedgerError(`illegal symbol transition ${s.state} -> ${to} for ${id}`);
		}
		if (!skipEvidenceCheck && (to === "tested" || to === "accepted") && s.unit_id) {
			const required = to === "tested" ? REQUIRED_FOR_TESTED : REQUIRED_FOR_ACCEPTED;
			// read-not-run truth stands in for truth run on the old code (marked as such in truth_cases)
			const missing = required.filter((t) => !this.hasEvidence(s.unit_id!, t) && !(t === "truth_green_on_old" && this.hasEvidence(s.unit_id!, "truth_read")));
			if (missing.length) throw new LedgerError(`${id} -> ${to} needs evidence: ${missing.join(", ")}`);
		}
		this.db
			.prepare("UPDATE symbols SET state = ?, reason = COALESCE(?, reason), evidence_id = COALESCE(?, evidence_id), updated_at = ? WHERE id = ?")
			.run(to, reason ?? null, evidenceId ?? null, now(), id);
		this.recordTransition("symbol", id, s.state, to, reason, evidenceId);
	}

	/** Implementer proof: what happened to a source symbol. Moves the symbol to mapped/dropped. */
	prove(p: { unitId: string; srcSymbol: string; op: MoveOp; targetSymbols?: string[]; why: string; attemptId?: number }): void {
		const s = this.getSymbol(p.srcSymbol);
		if (!s) throw new LedgerError(`unknown symbol ${p.srcSymbol}`);
		if (s.unit_id !== p.unitId) throw new LedgerError(`${p.srcSymbol} is not in unit ${p.unitId}`);
		if (p.op !== "dropped" && !(p.targetSymbols?.length)) throw new LedgerError(`op ${p.op} requires targetSymbols`);
		if (!p.why.trim()) throw new LedgerError("why is required");
		this.db.prepare("DELETE FROM moves WHERE unit_id = ? AND src_symbol = ?").run(p.unitId, p.srcSymbol); // retries replace; history stays in attempts/transitions
		this.db
			.prepare("INSERT INTO moves(unit_id, src_symbol, op, target_symbols, why, attempt_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
			.run(p.unitId, p.srcSymbol, p.op, JSON.stringify(p.targetSymbols ?? []), p.why, p.attemptId ?? null, now());
		const to: SymbolState = p.op === "dropped" ? "dropped" : "mapped";
		if (s.state === "clustered") this.transitionSymbol(p.srcSymbol, "in_progress", "implementer started");
		const cur = this.getSymbol(p.srcSymbol)!;
		if (cur.state !== to) this.transitionSymbol(p.srcSymbol, to, `${p.op}: ${p.why}`);
	}

	movesOf(srcSymbol: string) {
		return this.db.prepare("SELECT * FROM moves WHERE src_symbol = ? ORDER BY id").all(srcSymbol) as Array<{
			id: number; unit_id: string; src_symbol: string; op: MoveOp; target_symbols: string; why: string; attempt_id: number | null; created_at: string;
		}>;
	}

	// ---- attempts, evidence, decisions ------------------------------------

	/** `unitId` starting with `__` is a system session (rules generation, init): recorded with no unit, role carries the name. */
	startAttempt(unitId: string, role: string, model?: string): number {
		const system = unitId.startsWith("__");
		const r = this.db
			.prepare("INSERT INTO attempts(unit_id, role, model, started_at) VALUES (?, ?, ?, ?)")
			.run(system ? null : unitId, system ? `${unitId}:${role}` : role, model ?? null, now());
		if (!system) this.db.prepare("UPDATE units SET attempts = attempts + 1, updated_at = ? WHERE id = ?").run(now(), unitId);
		return Number(r.lastInsertRowid);
	}
	endAttempt(id: number, r: { outcome: string; tokensIn?: number; tokensOut?: number; costUsd?: number; tierServed?: string; gateReport?: unknown }): void {
		this.db
			.prepare("UPDATE attempts SET outcome=?, tokens_in=?, tokens_out=?, cost_usd=?, tier_served=?, gate_report=?, ended_at=? WHERE id=?")
			.run(r.outcome, r.tokensIn ?? 0, r.tokensOut ?? 0, r.costUsd ?? 0, r.tierServed ?? null, r.gateReport ? JSON.stringify(r.gateReport) : null, now(), id);
		const a = this.db.prepare("SELECT unit_id FROM attempts WHERE id = ?").get(id) as { unit_id: string };
		this.db.prepare("UPDATE units SET cost_usd = cost_usd + ?, updated_at = ? WHERE id = ?").run(r.costUsd ?? 0, now(), a.unit_id);
	}
	attemptsOf(unitId: string) {
		return this.db.prepare("SELECT * FROM attempts WHERE unit_id = ? ORDER BY id").all(unitId) as Array<Record<string, unknown>>;
	}

	addEvidence(unitId: string, type: EvidenceType, payload: unknown = {}): number {
		const r = this.db.prepare("INSERT INTO evidence(unit_id, type, payload, created_at) VALUES (?, ?, ?, ?)").run(unitId, type, JSON.stringify(payload), now());
		return Number(r.lastInsertRowid);
	}
	hasEvidence(unitId: string, type: EvidenceType): boolean {
		return !!this.db.prepare("SELECT 1 FROM evidence WHERE unit_id = ? AND type = ? LIMIT 1").get(unitId, type);
	}
	evidenceOf(unitId: string) {
		return this.db.prepare("SELECT * FROM evidence WHERE unit_id = ? ORDER BY id").all(unitId) as Array<{ id: number; type: EvidenceType; payload: string; created_at: string }>;
	}

	recordDecision(d: { unitId?: string; point: string; model: string; stateHash: string; answers: unknown; confidence?: number; action?: string; costUsd?: number; latencyMs?: number }): number {
		const r = this.db
			.prepare("INSERT INTO decisions(unit_id, point, model, state_hash, answers, confidence, action, cost_usd, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
			.run(d.unitId ?? null, d.point, d.model, d.stateHash, JSON.stringify(d.answers), d.confidence ?? null, d.action ?? null, d.costUsd ?? 0, d.latencyMs ?? null, now());
		return Number(r.lastInsertRowid);
	}

	// ---- human questions ---------------------------------------------------

	/** The only way to ask a human. Returns the question id; the scheduler decides what waits via `blockedUnits()`. */
	askQuestion(q: { unitId?: string; point: string; question: string; options?: string[]; context?: unknown; blocks?: QuestionBlocks; askedBy: string; decisionId?: number }): number {
		const r = this.db
			.prepare("INSERT INTO questions(unit_id, point, question, options, context, blocks, asked_by, decision_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
			.run(q.unitId ?? null, q.point, q.question, q.options ? JSON.stringify(q.options) : null, q.context === undefined ? null : JSON.stringify(q.context), q.blocks ?? "unit", q.askedBy, q.decisionId ?? null, now());
		return Number(r.lastInsertRowid);
	}
	answerQuestion(id: number, answer: string, answeredBy = "human", status: "answered" | "auto" = "answered"): void {
		const q = this.getQuestion(id);
		if (!q) throw new LedgerError(`question ${id} not found`);
		// a question the run decided itself (status auto) stays open to the owner: their answer replaces the run's
		if (q.status !== "open" && !(q.status === "auto" && status === "answered")) throw new LedgerError(`question ${id} is already ${q.status}`);
		this.db.prepare("UPDATE questions SET status = ?, answer = ?, answered_by = ?, answered_at = ? WHERE id = ?").run(status, answer, answeredBy, now(), id);
		// A human answer to a question that mirrors a Jev decision is a calibration label for that decision.
		if (q.decision_id !== null && status === "answered") this.db.prepare("UPDATE decisions SET label = ? WHERE id = ?").run(answer, q.decision_id);
	}
	withdrawQuestion(id: number, reason: string): void {
		this.db.prepare("UPDATE questions SET status = 'withdrawn', answer = ?, answered_at = ? WHERE id = ? AND status = 'open'").run(`withdrawn: ${reason}`, now(), id);
	}
	getQuestion(id: number): QuestionRow | undefined {
		return this.db.prepare("SELECT * FROM questions WHERE id = ?").get(id) as unknown as QuestionRow | undefined;
	}
	/** Questions the run answered itself (askViaModel's own pick), newest first; `since` = ISO time. */
	ownDecisions(since = ""): QuestionRow[] {
		return this.db.prepare("SELECT * FROM questions WHERE status = 'auto' AND answered_by LIKE 'auto%' AND answered_at >= ? ORDER BY id DESC").all(since) as unknown as QuestionRow[];
	}
	openQuestions(): QuestionRow[] {
		return this.db.prepare("SELECT * FROM questions WHERE status = 'open' ORDER BY id").all() as unknown as QuestionRow[];
	}
	/**
	 * Units that must wait for open questions. Everything else keeps running.
	 *  none → nothing; unit → that unit; dependents → the unit and its transitive dependents; module → every unit sharing its top-level dir.
	 */
	/** The unit waits on a question another unit asked about the same problem. */
	addWaiter(questionId: number, unitId: string): void {
		this.db.prepare("INSERT OR IGNORE INTO question_waiters(question_id, unit_id) VALUES (?, ?)").run(questionId, unitId);
	}
	/** An open question about the same problem (point + key), if one was asked already. */
	openQuestionFor(point: string, sameAs: string): number | undefined {
		const r = this.db.prepare("SELECT id FROM questions WHERE status = 'open' AND point = ? AND json_extract(context, '$.sameAs') = ? ORDER BY id LIMIT 1").get(point, sameAs) as { id: number } | undefined;
		return r?.id;
	}
	blockedUnits(): Map<string, number[]> {
		const blocked = new Map<string, number[]>();
		const add = (unitId: string, qid: number) => blocked.set(unitId, [...(blocked.get(unitId) ?? []), qid]);
		const units = this.listUnits();
		const dependents = new Map<string, string[]>();
		for (const u of units) for (const d of JSON.parse(u.deps) as string[]) dependents.set(d, [...(dependents.get(d) ?? []), u.id]);
		for (const q of this.openQuestions()) {
			if (q.blocks !== "none") for (const w of this.db.prepare("SELECT unit_id FROM question_waiters WHERE question_id = ?").all(q.id) as Array<{ unit_id: string }>) add(w.unit_id, q.id);
			if (q.blocks === "none" || !q.unit_id) continue;
			add(q.unit_id, q.id);
			if (q.blocks === "dependents") {
				const stack = [q.unit_id];
				const seen = new Set<string>();
				while (stack.length) {
					const cur = stack.pop()!;
					for (const d of dependents.get(cur) ?? []) if (!seen.has(d)) { seen.add(d); add(d, q.id); stack.push(d); }
				}
			} else if (q.blocks === "module") {
				const u = this.getUnit(q.unit_id);
				const dir = u ? (JSON.parse(u.meta).files?.[0] as string | undefined)?.split("/").slice(0, -1).join("/") : undefined;
				if (dir !== undefined) for (const o of units) if ((JSON.parse(o.meta).files?.[0] as string | undefined)?.startsWith(dir + "/") || dir === "") add(o.id, q.id);
			}
		}
		return blocked;
	}

	private recordTransition(entity: "symbol" | "unit", entityId: string, from: string | null, to: string, reason?: string, evidenceId?: number): void {
		this.db
			.prepare("INSERT INTO transitions(entity, entity_id, from_state, to_state, reason, evidence_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
			.run(entity, entityId, from, to, reason ?? null, evidenceId ?? null, now());
	}
	transitionsOf(entity: "symbol" | "unit", entityId: string) {
		return this.db.prepare("SELECT * FROM transitions WHERE entity = ? AND entity_id = ? ORDER BY id").all(entity, entityId) as Array<{
			from_state: string | null; to_state: string; reason: string | null; evidence_id: number | null; created_at: string;
		}>;
	}

	// ---- invariants & status ----------------------------------------------

	/** Σ states == discovered symbols; lists what is still unaccounted. Cheap enough to run after every write batch. */
	checkInvariants(): { ok: boolean; problems: string[]; counts: Record<string, number> } {
		const counts: Record<string, number> = {};
		for (const r of this.db.prepare("SELECT state, COUNT(*) n FROM symbols GROUP BY state").all() as Array<{ state: string; n: number }>) counts[r.state] = r.n;
		const total = (this.db.prepare("SELECT COUNT(*) n FROM symbols").get() as { n: number }).n;
		const sum = Object.values(counts).reduce((a, b) => a + b, 0);
		const problems: string[] = [];
		if (sum !== total) problems.push(`state sum ${sum} != total ${total}`);
		const orphan = (this.db.prepare("SELECT COUNT(*) n FROM symbols WHERE state NOT IN ('discovered','dropped','quarantined') AND unit_id IS NULL").get() as { n: number }).n;
		if (orphan) problems.push(`${orphan} symbols past 'discovered' without a unit`);
		const badAccepted = (this.db.prepare(`SELECT COUNT(*) n FROM symbols s JOIN units u ON u.id = s.unit_id WHERE s.state = 'accepted' AND u.state != 'accepted'`).get() as { n: number }).n;
		if (badAccepted) problems.push(`${badAccepted} accepted symbols in non-accepted units`);
		return { ok: problems.length === 0, problems, counts };
	}

	unaccounted(): SymbolRow[] {
		const placeholders = TERMINAL_SYMBOL_STATES.map(() => "?").join(",");
		return this.db.prepare(`SELECT * FROM symbols WHERE state NOT IN (${placeholders}) ORDER BY path, name`).all(...TERMINAL_SYMBOL_STATES) as unknown as SymbolRow[];
	}

	/** Derived file state from its symbols. */
	/**
	 * Registration files (route tables, module wiring) are never migrated by agents: the target adapter
	 * regenerates their counterpart from the ledger. Their symbols are dropped with that reason so the
	 * file is accounted for, and `br why` says exactly where the information went.
	 */
	markRegenerated(path: string, reason: string): void {
		this.db.prepare("UPDATE files SET disposition = 'regenerated', dead_code_reason = ?, updated_at = ? WHERE path = ?").run(reason, now(), path);
		for (const s of this.symbolsOfFile(path)) {
			if (this.inventoryMayDrop(s)) this.dropFromInventory(s, `regenerated: ${reason}`);
		}
	}
	/** Framework files are mapped per concern (br frameworks), never migrated file by file. */
	markFramework(path: string, reason: string): void {
		this.db.prepare("UPDATE files SET disposition = 'framework', dead_code_reason = ?, updated_at = ? WHERE path = ?").run(reason, now(), path);
		for (const s of this.symbolsOfFile(path)) {
			if (this.inventoryMayDrop(s)) this.dropFromInventory(s, `framework: ${reason}`);
		}
	}
	fileState(path: string): "accepted" | "dead_code" | "regenerated" | "framework" | "in_progress" | "pending" | "quarantined" | "mixed" {
		const f = this.db.prepare("SELECT * FROM files WHERE path = ?").get(path) as unknown as FileRow & { disposition?: string | null } | undefined;
		if (!f) throw new LedgerError(`unknown file ${path}`);
		if (f.dead_code) return "dead_code";
		if (f.disposition === "regenerated") return "regenerated";
		if (f.disposition === "framework") return "framework";
		const states = new Set(this.symbolsOfFile(path).map((s) => s.state));
		if (states.size === 0) return "pending";
		if ([...states].every((s) => s === "accepted" || s === "dropped")) return "accepted";
		if (states.has("quarantined")) return "quarantined";
		if (states.has("in_progress") || states.has("mapped") || states.has("tested")) return "in_progress";
		if ([...states].every((s) => s === "discovered" || s === "clustered")) return "pending";
		return "mixed";
	}

	status() {
		const inv = this.checkInvariants();
		const files = (this.db.prepare("SELECT COUNT(*) n FROM files").get() as { n: number }).n;
		const dead = (this.db.prepare("SELECT COUNT(*) n FROM files WHERE dead_code = 1").get() as { n: number }).n;
		const regenerated = (this.db.prepare("SELECT COUNT(*) n FROM files WHERE disposition = 'regenerated'").get() as { n: number }).n;
		const framework = (this.db.prepare("SELECT COUNT(*) n FROM files WHERE disposition = 'framework'").get() as { n: number }).n;
		const unitsByState: Record<string, number> = {};
		for (const r of this.db.prepare("SELECT state, COUNT(*) n FROM units GROUP BY state").all() as Array<{ state: string; n: number }>) unitsByState[r.state] = r.n;
		const byTier = this.db
			.prepare(`SELECT u.tier, u.state, COUNT(*) n FROM units u GROUP BY u.tier, u.state ORDER BY u.tier`)
			.all() as Array<{ tier: string; state: string; n: number }>;
		const cost = (this.db.prepare("SELECT COALESCE(SUM(cost_usd),0) c FROM attempts").get() as { c: number }).c;
		const costByModel = this.db
			.prepare("SELECT COALESCE(model,'?') model, role, COUNT(*) n, COALESCE(SUM(cost_usd),0) c FROM attempts GROUP BY model, role")
			.all() as Array<{ model: string; role: string; n: number; c: number }>;
		const firstPass = this.db
			.prepare(`SELECT COUNT(*) n FROM units WHERE state = 'accepted' AND attempts <= 2`) // tester + 1 implementer attempt
			.get() as { n: number };
		const quarantine = this.listUnits({ state: "quarantined" }).map((u) => u.id);
		return {
			invariants: inv,
			symbols: inv.counts,
			unaccounted: this.unaccounted().length,
			files: { total: files, dead_code: dead, regenerated, framework },
			units: unitsByState,
			unitsByTier: byTier,
			firstPassAccepted: firstPass.n,
			costUsd: cost,
			costByModel,
			quarantine,
		};
	}

	/** Everything `br why` prints for a file or symbol. */
	why(idOrPath: string) {
		const sym = this.getSymbol(idOrPath);
		if (sym) {
			return {
				kind: "symbol" as const,
				symbol: sym,
				transitions: this.transitionsOf("symbol", sym.id),
				moves: this.movesOf(sym.id),
				unit: sym.unit_id ? this.getUnit(sym.unit_id) : undefined,
				evidence: sym.unit_id ? this.evidenceOf(sym.unit_id) : [],
				attempts: sym.unit_id ? this.attemptsOf(sym.unit_id) : [],
			};
		}
		const file = this.db.prepare("SELECT * FROM files WHERE path = ?").get(idOrPath) as unknown as FileRow | undefined;
		if (file) {
			return {
				kind: "file" as const,
				file,
				state: this.fileState(idOrPath),
				symbols: this.symbolsOfFile(idOrPath).map((s) => ({ ...s, moves: this.movesOf(s.id) })),
			};
		}
		return undefined;
	}
}
