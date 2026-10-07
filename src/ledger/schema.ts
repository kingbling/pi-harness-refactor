/**
 * Ledger schema. Symbol-level accounting is the no-loss guarantee; file state is derived.
 * Transitions happen only through `Ledger.transition()` (see db.ts), never via raw UPDATE.
 */

export const SYMBOL_STATES = [
	"discovered", // indexed, not yet assigned to a unit
	"clustered", // belongs to a unit, not started
	"in_progress", // a session is working on its unit
	"mapped", // implementer proved: src symbol -> target symbol(s)
	"dropped", // implementer proved: intentionally not migrated, with reason
	"tested", // mapped + ported tests green + truth evidence present
	"accepted", // gate green + review evidence; merged
	"quarantined", // needs a human
] as const;
export type SymbolState = (typeof SYMBOL_STATES)[number];

/** Terminal states count as "accounted". */
export const TERMINAL_SYMBOL_STATES: readonly SymbolState[] = ["accepted", "dropped", "quarantined"];

export const UNIT_STATES = [
	"planned",
	"truth", // tester session running / done
	"implementing",
	"gating",
	"review",
	"accepted",
	"quarantined",
] as const;
export type UnitState = (typeof UNIT_STATES)[number];

export const QUESTION_BLOCKS = ["none", "unit", "dependents", "module"] as const;
export type QuestionBlocks = (typeof QUESTION_BLOCKS)[number];
export interface QuestionRow {
	id: number;
	unit_id: string | null;
	point: string;
	question: string;
	options: string | null;
	context: string | null;
	blocks: QuestionBlocks;
	asked_by: string;
	status: "open" | "answered" | "withdrawn" | "auto";
	answer: string | null;
	answered_by: string | null;
	decision_id: number | null;
	created_at: string;
	answered_at: string | null;
}

export const EVIDENCE_TYPES = [
	"truth_green_on_old",
	"ported_tests_green",
	"goldens_green",
	"build_ok",
	"lint_ok",
	"rules_ok",
	"antigaming_ok",
	"symbolproof_ok",
	"review_pass",
	"human_approval",
	// tester ran before the deps landed; ported tests are saved under truth/<unit>/ported/
	"truth_ahead",
	// written files match the stack layout (area module, no per-legacy-file folders, no duplicate classes)
	"structure_ok",
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

/** Evidence required before a unit's symbols may become `tested` / `accepted`. */
export const REQUIRED_FOR_TESTED: readonly EvidenceType[] = ["truth_green_on_old", "ported_tests_green"];
export const REQUIRED_FOR_ACCEPTED: readonly EvidenceType[] = [
	"symbolproof_ok",
	"build_ok",
	"lint_ok",
	"rules_ok",
	"antigaming_ok",
	"structure_ok",
	"ported_tests_green",
];

export const MOVE_OPS = ["moved", "extracted", "merged_into", "inlined", "split", "dropped"] as const;
export type MoveOp = (typeof MOVE_OPS)[number];

/** Allowed symbol transitions. Anything else throws. */
export const SYMBOL_TRANSITIONS: Record<SymbolState, readonly SymbolState[]> = {
	discovered: ["clustered", "dropped", "quarantined"],
	// assigned to a unit but not started: a re-inventory may still find it dead, framework or regenerated
	clustered: ["in_progress", "dropped", "quarantined"],
	in_progress: ["mapped", "dropped", "clustered", "quarantined"],
	mapped: ["tested", "in_progress", "quarantined"],
	dropped: ["in_progress"], // a human can re-open
	tested: ["accepted", "in_progress", "quarantined"],
	accepted: [],
	quarantined: ["clustered", "dropped"],
};

export const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  lang TEXT NOT NULL,
  loc INTEGER NOT NULL DEFAULT 0,
  tier TEXT,
  dead_code INTEGER NOT NULL DEFAULT 0,
  dead_code_reason TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS symbols (
  id TEXT PRIMARY KEY,                -- e.g. "src/Billing/Invoice.php::Invoice::calc"
  path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  kind TEXT NOT NULL,                 -- class|function|method|const|route|template|...
  name TEXT NOT NULL,
  exported INTEGER NOT NULL DEFAULT 1,
  tier TEXT,
  unit_id TEXT REFERENCES units(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'discovered',
  reason TEXT,
  evidence_id INTEGER REFERENCES evidence(id),
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS symbols_state ON symbols(state);
CREATE INDEX IF NOT EXISTS symbols_unit ON symbols(unit_id);
CREATE INDEX IF NOT EXISTS symbols_path ON symbols(path);

CREATE TABLE IF NOT EXISTS units (
  id TEXT PRIMARY KEY,
  tier TEXT NOT NULL,
  kind TEXT,
  state TEXT NOT NULL DEFAULT 'planned',
  attempts INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  model TEXT,
  worktree TEXT,
  branch TEXT,
  contract_path TEXT,
  deps TEXT NOT NULL DEFAULT '[]',    -- JSON array of unit ids
  meta TEXT NOT NULL DEFAULT '{}',    -- JSON: difficulty, needs_db, has_ui, ...
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id TEXT REFERENCES units(id) ON DELETE CASCADE, -- NULL for system sessions (rules generation, init)
  role TEXT NOT NULL,                 -- tester|implementer|escalate|gate
  model TEXT,
  tier_served TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  outcome TEXT,                       -- ok|fail|aborted
  gate_report TEXT,                   -- JSON
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS attempts_unit ON attempts(unit_id);

CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_unit ON evidence(unit_id, type);

CREATE TABLE IF NOT EXISTS moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  src_symbol TEXT NOT NULL REFERENCES symbols(id),
  op TEXT NOT NULL,
  target_symbols TEXT NOT NULL DEFAULT '[]',  -- JSON array of "path::Name"
  why TEXT NOT NULL,
  attempt_id INTEGER REFERENCES attempts(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS moves_src ON moves(src_symbol);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id TEXT REFERENCES units(id) ON DELETE SET NULL,
  point TEXT NOT NULL,                -- route|triage|truth_triage|...
  model TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  answers TEXT NOT NULL,              -- JSON
  confidence REAL,
  action TEXT,
  label TEXT,                         -- human/pilot ground truth for calibration
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Human questions. Asking is allowed, but only through here, and it never pauses unrelated work:
-- "blocks" says exactly what waits (none = informational, unit, dependents = unit + everything downstream,
-- module). A human answer is copied to decisions.label to calibrate Jev for that point.
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id TEXT REFERENCES units(id) ON DELETE SET NULL,
  point TEXT NOT NULL,                -- same vocabulary as decisions.point when it mirrors a Jev decision
  question TEXT NOT NULL,
  options TEXT,                       -- JSON array of choices, null = free text
  context TEXT,                       -- JSON: what the asker saw (gate output, candidates, …)
  blocks TEXT NOT NULL DEFAULT 'unit',-- none|unit|dependents|module
  asked_by TEXT NOT NULL,             -- orchestrator|tester|implementer|gate|init
  status TEXT NOT NULL DEFAULT 'open',-- open|answered|withdrawn|auto  (auto = answered by a calibrated Jev)
  answer TEXT,
  answered_by TEXT,
  decision_id INTEGER REFERENCES decisions(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  answered_at TEXT
);
CREATE INDEX IF NOT EXISTS questions_status ON questions(status);

CREATE TABLE IF NOT EXISTS transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,               -- symbol|unit
  entity_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason TEXT,
  evidence_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS transitions_entity ON transitions(entity, entity_id);

-- code index (source and target)
CREATE TABLE IF NOT EXISTS index_symbols (
  id TEXT PRIMARY KEY, side TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
  line INTEGER, signature TEXT, exported INTEGER NOT NULL DEFAULT 1, ast_hash TEXT
);
CREATE INDEX IF NOT EXISTS index_symbols_name ON index_symbols(side, name);
CREATE TABLE IF NOT EXISTS index_deps (
  from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (from_id, to_id, kind)
);
CREATE TABLE IF NOT EXISTS index_routes (
  id TEXT PRIMARY KEY, side TEXT NOT NULL, method TEXT, path TEXT NOT NULL, handler_symbol TEXT
);
CREATE TABLE IF NOT EXISTS index_literal_refs (
  name TEXT NOT NULL, path TEXT NOT NULL, line INTEGER, PRIMARY KEY (name, path, line)
);
CREATE TABLE IF NOT EXISTS index_queries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, symbol_id TEXT NOT NULL, kind TEXT NOT NULL, tables TEXT NOT NULL DEFAULT '[]', text TEXT
);

-- Legacy quirks the tester noticed instead of pinning them blindly. Each carries the tester's opinion;
-- language artifacts with opinion drop are dropped without asking, the rest become questions (via a model).
CREATE TABLE IF NOT EXISTS quirks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  symbol_id TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- language_artifact|edge_case|suspected_bug|intentional
  behaviour TEXT NOT NULL,            -- what the old code does, concretely
  example TEXT,                       -- input → output on the old code
  opinion TEXT NOT NULL,              -- drop|keep (the tester's)
  why TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|asked|dropped|kept
  decided_by TEXT,                    -- auto|human|...
  applied TEXT,                       -- drop|keep: what the unit's tests currently follow
  question_id INTEGER REFERENCES questions(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS quirks_unit ON quirks(unit_id);

-- Living rules: units propose additions/changes to a stack's rules; a curator merges them into a new version.
CREATE TABLE IF NOT EXISTS rule_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stack TEXT NOT NULL,
  unit_id TEXT,
  kind TEXT NOT NULL,                 -- add|change
  text TEXT NOT NULL,
  why TEXT NOT NULL,
  evidence TEXT,                      -- file path(s) or symbol ids
  status TEXT NOT NULL DEFAULT 'pending', -- pending|merged|rejected|asked
  version INTEGER,                    -- rules version it was merged into
  question_id INTEGER REFERENCES questions(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rule_proposals_status ON rule_proposals(stack, status);

-- Capability cards: what accepted target code DOES, in domain words, written by a model after each accepted
-- unit; searched with FTS5 (porter stemming, bm25) by find_capability and the task card's reuse candidates.
CREATE TABLE IF NOT EXISTS capabilities (
  id TEXT PRIMARY KEY,                -- target symbol id
  stack TEXT NOT NULL,
  area TEXT,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,              -- one sentence, domain language
  terms TEXT NOT NULL,                -- domain words + synonyms, space separated
  io TEXT,                            -- inputs → outputs
  legacy TEXT NOT NULL DEFAULT '[]',  -- JSON legacy symbol ids it came from
  unit_id TEXT,
  created_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS capabilities_fts USING fts5(id UNINDEXED, name, summary, terms, tokenize = 'porter unicode61');

CREATE TABLE IF NOT EXISTS truth_cases (
  id TEXT PRIMARY KEY, unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  symbol_id TEXT NOT NULL, inputs TEXT NOT NULL, expected TEXT NOT NULL,
  verified_on_old INTEGER NOT NULL DEFAULT 0, ported_test_path TEXT, created_at TEXT NOT NULL
);
`;
