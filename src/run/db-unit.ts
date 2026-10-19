import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import pc from "picocolors";
import { getTargetAdapter } from "../adapters/registry.ts";
import { projectDir } from "../init/init.ts";
import { schemaTextFor, type DbUnitMeta } from "../inventory/db.ts";
import { spawnLeaf } from "../sessions/spawn.ts";
import { disputeEarlierTestTool } from "../sessions/tools.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { findTests, runPortedTests } from "./ported.ts";
import { gitIgnoredDirs, skipDir } from "../inventory/ignored.ts";
import { fixRunSetup, fixSetupWithModel } from "../init/setup-fixer.ts";
import { DEFAULT_DATA_DIRS, errorSignature, run, runGate, renderGate, sha1, trackedFiles, type GateReport } from "./gate.ts";
import { reviewWithModel } from "./review.ts";
import type { TargetAdapter } from "../adapters/types.ts";
import type { Ledger } from "../ledger/db.ts";
import { triageGate } from "./triage.ts";
import { rulesText } from "./prompts.ts";
import type { UnitRunOptions, UnitRunResult } from "./unit.ts";
import { CODE_QUALITY, goalsText } from "../policy.ts";

/** The question (point) that settles once how engine behaviour the target cannot copy exactly is handled. */
export const ENGINE_SEMANTICS = "db_engine_semantics";
export const ENGINE_SEMANTICS_OPTIONS = [
	{ value: "comments", label: "write the differences down as comments next to the columns; they are not defects. Where the app relies on such behaviour (trimmed or case-insensitive input), the app's code does it" },
	{ value: "emulate", label: "copy the legacy behaviour in the new database where it can (case-insensitive types or collations, check constraints); what it cannot copy is written down as a comment" },
];

/**
 * How DB units and their reviewer treat engine behaviour the target engine cannot copy exactly (collation, padding,
 * case-insensitive matching, zero dates): the owner's (or the run's own) answer to the ENGINE_SEMANTICS question.
 * Not answered yet: such differences are written down and are not defects until it is.
 */
export function engineSemantics(ledger: Ledger): string {
	const row = ledger.db.prepare("SELECT answer FROM questions WHERE point = ? AND status IN ('answered', 'auto') ORDER BY id DESC LIMIT 1").get(ENGINE_SEMANTICS) as { answer: string } | undefined;
	const picked = row ? ENGINE_SEMANTICS_OPTIONS.find((o) => row.answer.startsWith(o.value)) : undefined;
	const rule = picked ? `${picked.value}: ${picked.label}` : row ? row.answer : `not decided yet; until it is, ${ENGINE_SEMANTICS_OPTIONS[0]!.label}`;
	return `Project decision on database behaviour the target engine cannot copy exactly (collation, trailing spaces in comparisons, case-insensitive matching and enum values, zero dates, time zones): ${rule}.`;
}

const TASK: Record<string, (m: DbUnitMeta & { group?: string }, dataDir: string) => string> = {
	db_schema: (m) =>
		`Migration lane (keep-schema): port these tables 1:1 to ${m.to ?? m.from.join("/")}. Same table and column names, every column, primary/unique keys, indexes and foreign keys kept; types translated from ${m.from.join("/")} to ${m.to ?? "the target engine"} without loss (lengths, precision, signedness, defaults, nullability). Engine behaviour the target cannot copy exactly (charset, collation, padding) follows the project decision on it. Write the schema for them in this stack's data-access approach (its ORM entities/models, or SQL/schema files when the stack has no ORM) and the initial migration that creates exactly this schema.`,
	db_design: (m, dataDir) =>
		`Refactor lane (new-schema): design the target schema for these tables in ${m.to ?? "the target engine"}: clear names, proper types, keys and constraints, normalized where the legacy schema duplicates data. Write the schema in this stack's data-access approach (its ORM entities/models, or SQL/schema files when the stack has no ORM), the migration that creates it, and ${dataDir}MAPPING.md with one line per legacy column: \`old_table.old_column → new_table.new_column (transformation)\`, or \`→ dropped (why)\`. Every legacy column appears in the mapping.`,
	db_data: (m, dataDir) =>
		`Data lane: write the data migration from ${m.from.join(" + ")} to ${m.to ?? "the target engine"} for every table (${m.strategy === "new-schema" ? `follow the MAPPING.md files under ${dataDir}` : "copy 1:1 into the ported schema"}). Idempotent and resumable (batches, upserts by key), keeps referential order, and verifies row counts per table at the end. Configuration by env vars only (source and target URLs), never hardcoded credentials.`,
};

/**
 * A unit of the DB lane: no legacy symbols and no characterization truth; the schema inputs are the truth.
 * One implementer session per attempt writes only in the stack's data dirs (plus tests there), then the
 * normal gate (scope, structure, build, lint, rules, tests) decides. Escalates after the implement attempts.
 */
export async function runDbUnit(o: UnitRunOptions, place: { stackId: string }): Promise<UnitRunResult> {
	const log = o.log ?? ((l: string) => console.log(l));
	const unit = o.ledger.getUnit(o.unitId)!;
	const meta = JSON.parse(unit.meta) as DbUnitMeta & { group?: string };
	const adapter = await getTargetAdapter(place.stackId);
	const targetProjectDir = o.workDir ? join(o.workDir, relative(o.config.target.path, projectDir(o.config, place.stackId))) : projectDir(o.config, place.stackId);
	// main's checkout: another unit's test that fails here counts only if it passes there (as for code units)
	const mainDir = o.workDir ? projectDir(o.config, place.stackId) : undefined;
	if (!adapter.toolchain.isProjectReady(targetProjectDir)) throw new Error(`target project missing at ${targetProjectDir}; run br setup`);
	const dataDirs = adapter.layout.dataDirs?.length ? adapter.layout.dataDirs : DEFAULT_DATA_DIRS;
	// tests go where the stack keeps tests for these folders, so the project's own test run finds them
	const testGlobs = [...new Set(dataDirs.flatMap((d) => adapter.layout.testFileGlobs(d.replace(/\/$/, ""))))];
	const writeGlobs = [...new Set([...dataDirs.map((d) => `${d}**`), ...testGlobs])];
	// a test home outside the data folders: a migration tool may load every file in its folder
	const testHome = testGlobs.find((g) => !dataDirs.some((d) => g.startsWith(d))) ?? testGlobs[0];
	const freshCmd = adapter.migrateFresh?.(targetProjectDir)?.cmd;
	const semantics = unit.kind === "db_data" ? "" : engineSemantics(o.ledger);
	const choices = o.config.target.choices[place.stackId] ?? {};
	const snapshot = o.config.db.snapshot ? (o.config.db.snapshot.startsWith("/") ? o.config.db.snapshot : join(o.config.source.path, o.config.db.snapshot)) : undefined;
	const schema = await schemaTextFor(o.config, meta.tables ?? []);
	const task = (TASK[unit.kind ?? ""] ?? TASK["db_schema"]!)(meta, dataDirs[0]!);
	// what earlier DB units wrote: the model reads them and orders its migration after every table it references
	const existing = await dataFiles(targetProjectDir, dataDirs, (p) => !adapter.layout.isTestFile(p), adapter.toolchain.ignoredPaths);
	// a reopened unit's own earlier tests are its to change: DB units have no truth cases to mark them as theirs
	const own = ownTests(o.ledger, o.unitId, adapter.layout.isTestFile);
	const system = [
		`You are the database engineer of a legacy rewrite (${o.config.source.stack} → ${place.stackId}). You work in the target project; write ONLY under ${dataDirs.join(", ")}, and tests at ${testGlobs.join(", ")}.`,
		`Engines: ${meta.from.join(" + ")} → ${meta.to ?? "unchanged"}. Strategy: ${meta.strategy}. Stack choices: ${JSON.stringify(choices)}.`,
		adapter.layout.dataAccessHint ? `Data access in this stack: ${adapter.layout.dataAccessHint}.` : "",
		`Tests: ${adapter.layout.testHint} Write at least one test at ${testHome ?? "the stack's test folder"} (the stack's test folder for them, so its own test run finds it) that proves the schema (the tables' columns as the stack's data-access code declares them, or the migration's DDL) — or for the data lane, the transformation on a small in-memory fixture. Tests must run without a live database. A test checks what its own unit's files create, not what other units' migrations hold (no counts or orders across them): other units add migrations after yours. Run check_my_tests after each change and before you finish. Another unit's test is never yours to change unless it is wrong: then dispute_test with evidence from the legacy schema.`,
		semantics,
		CODE_QUALITY,
		goalsText(o.config.goals),
		"Never write credentials. Never edit files outside your directories; other units build features on what you write, so names must match the legacy tables exactly unless your task says otherwise.",
		`Name files and migrations after the tables, never after the unit. A migration runs after every migration that creates a table it references (foreign keys, data copied from it): read the existing ones (ls, grep) and give yours a later version.${freshCmd ? " The gate applies all migrations in order to an empty database." : ""}`,
		rulesText(o.root, place.stackId),
	].filter(Boolean).join("\n\n");
	const prompt = [
		`# Database work (${unit.kind}${meta.group ? `, table group ${meta.group}` : ""})`,
		task,
		meta.tables?.length ? `\nTables (${meta.tables.length}): ${meta.tables.join(", ")}` : "",
		`\nFiles already in ${dataDirs.join(", ")} (earlier units' schema and migrations): ${existing.length ? existing.slice(0, 200).join(", ") : "none yet"}`,
		own.length ? `\nThis unit's own tests from an earlier run (yours to update when your schema change makes them wrong): ${own.join(", ")}` : "",
		snapshot ? `\nData dump: ${snapshot}${existsSync(snapshot) ? "" : " (not found on this machine)"} — read it for realistic fixtures; never commit it.` : "",
		o.config.db.url ? `\nLegacy connection: ${o.config.db.url} (an env var; introspection allowed, read-only).` : "",
		`\n## Legacy schema\n\`\`\`sql\n${schema || "(no schema inputs: br onboard --force-db to point at them)"}\n\`\`\``,
	].join("\n");

	if (unit.state === "planned") o.ledger.transitionUnit(o.unitId, "implementing", "db lane");
	const spawn = o.spawn ?? spawnLeaf;
	const gateFn = o.gate ?? runGate;
	const gateSlot = o.gateSlot ?? (<T>(fn: () => Promise<T>) => fn());
	const reviewer = o.reviewer === false ? undefined : (o.reviewer ?? (o.spawn ? undefined : reviewWithModel));
	// an earlier unit's test the session changed with evidence (dispute_test): kept at the gate, and the reviewer is told
	const disputed = new Map<string, string>();
	const tools: ToolDefinition[] = [
		{
			name: "check_my_tests",
			label: "Run my tests",
			description: "Run the gate's test step now: every test file in the data dirs, yours first, then the other units' (one that fails on main too does not count). Run it after each change and before you finish; the gate runs the same.",
			promptSnippet: "check_my_tests: run the gate's test step on the data dirs' tests now",
			parameters: Type.Object({}),
			execute: async () => {
				const r = await runPortedTests({ ledger: o.ledger, unitId: o.unitId, adapter, dir: targetProjectDir, tests: (await dataTests(targetProjectDir, dataDirs, adapter)).map((t) => t.path), mainDir, timeoutMs: 240_000, slot: gateSlot });
				return { content: [{ type: "text" as const, text: `${r.ok ? "TESTS GREEN" : "TESTS RED"}\n${r.output.slice(-6000)}` }], details: {} };
			},
		} as unknown as ToolDefinition,
		disputeEarlierTestTool({ ledger: o.ledger, config: o.config, unitId: o.unitId, root: o.root, targetProjectDir, adapter, onDispute: (d) => (disputed.set(d.test, `${d.why} (evidence: ${d.evidence})`), log(pc.yellow(`  db dispute: ${d.test} — ${d.why.slice(0, 160)}`))) }),
	];
	const maxImpl = o.config.run.maxImplementAttempts;
	const maxTotal = maxImpl + o.config.run.maxEscalateAttempts;
	let cost = 0;
	let gate: GateReport | undefined;
	let last = "";
	let n = 0;
	let previous: GateReport | undefined;
	let escalate = false;
	while (n < maxTotal) {
		n++;
		const role = escalate || n > maxImpl ? "escalate" : "implement";
		const attempt = o.ledger.startAttempt(o.unitId, role, o.config.models[role].id);
		const s = await spawn({ role, cwd: targetProjectDir, config: o.config, writeGlobs, protectedGlobs: adapter.protectedGlobs, systemPrompt: system, customTools: tools, transcriptPath: join(o.root, ".bigrefactor", "sessions", o.unitId, `${role}-${attempt}.jsonl`) });
		let res;
		try {
			res = await s.run(prompt + (last ? `\n\n## Previous attempt failed the gate\n${last}` : ""));
		} finally {
			s.dispose();
		}
		cost += res.usage.cost;
		log(pc.dim(`  db ${role} #${n}: ${res.toolCalls} tool calls, $${res.usage.cost.toFixed(4)}${res.error ? pc.red(` ERROR: ${res.error}`) : ""}`));
		if (o.ledger.getUnit(o.unitId)!.state === "implementing") o.ledger.transitionUnit(o.unitId, "gating", `attempt ${n}`);
		// the tests the session wrote are this unit's proof: hashed now, so the gate sees them untouched
		const testFiles = await dataTests(targetProjectDir, dataDirs, adapter);
		// the same reviewer as code units judges the schema and its tests (the review never holds a CPU slot)
		const review = reviewer
			? async (changedFiles: string[]) => {
					const ra = o.ledger.startAttempt(o.unitId, "review", o.config.models.escalate.id);
					const r = await reviewer({ ledger: o.ledger, config: o.config, root: o.root, unitId: o.unitId, adapter, targetProjectDir, moduleDir: dataDirs[0]!.replace(/\/$/, ""), legacyFiles: [], changedFiles, testFiles: testFiles.map((t) => t.path), writeGlobs, ownerNote: `This is a database unit. Its task: ${task}${meta.tables?.length ? ` Tables: ${meta.tables.join(", ")}.` : ""} Its tests run without a live database by design (the session is told so)${freshCmd ? "; the gate applies all migrations to an empty database in a step of its own" : ""}: do not ask for database-backed tests.${semantics ? ` ${semantics} A difference this decision covers is not a finding.` : ""}${disputed.size ? ` It changed earlier units' tests, saying they are wrong: ${[...disputed].map(([f, w]) => `${f}: ${w}`).join("; ")}. Judge each against the legacy schema; a change that only weakens a right test is a finding.` : ""}`, transcriptPath: join(o.root, ".bigrefactor", "sessions", o.unitId, `review-${ra}.jsonl`) });
					o.ledger.endAttempt(ra, { outcome: !r.judged ? "not_judged" : r.ok ? "review_ok" : "review_red", costUsd: r.costUsd ?? 0, gateReport: { output: r.output } });
					cost += r.costUsd ?? 0;
					return r;
				}
			: undefined;
		gate = await gateFn({ ledger: o.ledger, unitId: o.unitId, adapter, targetProjectDir, writeGlobs, testFiles, root: o.root, stackId: place.stackId, review, slot: gateSlot, mainDir, sanctioned: [...own, ...disputed.keys()] });
		gate = await unitNameStep(gate, o.unitId, targetProjectDir);
		gate = await migrateFreshStep(gate, { ledger: o.ledger, unitId: o.unitId, adapter, dir: targetProjectDir, mainDir, slot: gateSlot });
		o.ledger.endAttempt(attempt, { outcome: gate.ok ? "gate_green" : `gate_red:${gate.failedStep}`, costUsd: res.usage.cost, tokensIn: res.usage.input, tokensOut: res.usage.output, gateReport: gate });
		log(renderGate(gate));
		if (gate.ok) break;
		// the triage model reads the failure: a setup problem (missing env file, broken test bootstrap) is the setup
		// model's job, not another attempt at the schema; its retry/escalate/quarantine is followed like any unit's
		if (o.client) {
			const failedOut = gate.steps.find((x) => !x.ok)?.output ?? "";
			const t = await triageGate({ ledger: o.ledger, config: o.config, client: o.client, root: o.root }, o.unitId, gate, previous, n).catch(() => undefined);
			if (t) log(pc.dim(`  triage: ${t.cause} → ${t.action} (${t.reason})`));
			const setupFixer = o.setupFixer === false ? undefined : (o.setupFixer ?? (o.spawn ? undefined : fixSetupWithModel));
			if (t?.cause === "env" && setupFixer) {
				const fixed = await fixRunSetup({ config: o.config, root: o.root, adapter, projectDir: projectDir(o.config, place.stackId), fixer: setupFixer, ledger: o.ledger, lock: o.mergeLock, unitId: o.unitId, signature: errorSignature(gate.failedStep ?? "", failedOut), problem: `Gate step ${gate.failedStep} failed for database unit ${o.unitId} (files in ${dataDirs.join(", ")}). Triage: ${t.reason}. Fix the project setup, not the unit's files.\nThe unit works in its own git worktree (${targetProjectDir}); only files tracked in git (and the dependency dirs linked or copied into it: ${adapter.toolchain.worktreeLinks.join(", ") || "none"}) are there.\nGate output tail:\n${failedOut.slice(-3000)}` }).catch((e) => (log(pc.yellow(`  setup fix failed: ${e?.message ?? e}`)), undefined));
				if (fixed) {
					// parked without a question: the scheduler resubmits it on the fixed main (fresh worktree)
					o.ledger.updateUnit(o.unitId, { meta: { parked: { diagnosis: { summary: `the project setup was fixed (${fixed})`, note: t.reason } } } });
					o.ledger.transitionUnit(o.unitId, "implementing", "setup fixed; waits for a fresh worktree");
					log(pc.cyan(`  setup fixed by the model: ${fixed} — the unit runs again`));
					return { unitId: o.unitId, state: o.ledger.getUnit(o.unitId)!.state, attempts: n, gate, costUsd: cost };
				}
			}
			if (t?.action === "quarantine") break;
			if (t?.action === "escalate") escalate = true;
		}
		previous = gate;
		if (!testFiles.length) last = "no test files: write at least one test next to your schema files.\n";
		last += `failed step: ${gate.failedStep}\n${gate.steps.find((x) => !x.ok)?.output ?? ""}`;
		o.ledger.transitionUnit(o.unitId, "implementing", `gate failed: ${gate.failedStep}`);
	}
	if (gate?.ok) o.ledger.transitionUnit(o.unitId, "review", "gate green");
	else o.ledger.transitionUnit(o.unitId, "quarantined", `db lane: gate still red after ${n} attempts (${gate?.failedStep})`);
	return { unitId: o.unitId, state: o.ledger.getUnit(o.unitId)!.state, attempts: n, gate, costUsd: cost };
}

/**
 * New files the DB unit named after itself (DB_schema_x, DbSchemaX…): files are named after the tables, never the
 * unit (a structure finding). Skipped when the gate is already red.
 */
export async function unitNameStep(gate: GateReport, unitId: string, dir: string): Promise<GateReport> {
	if (!gate.ok) return gate;
	const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
	const tracked = new Set(await trackedFiles(dir));
	const named = gate.changedFiles.filter((f) => !tracked.has(f) && flat(basename(f)).includes(flat(unitId)));
	if (!named.length) return gate;
	const step = { name: "structure_ok" as const, ok: false, ms: 0, output: `files named after the unit ${unitId}, not after the tables they hold: ${named.join(", ")}. Rename them after the tables (and the classes in them).` };
	return { ...gate, ok: false, steps: [...gate.steps, step], failedStep: "structure_ok" };
}

/**
 * The DB lane's last gate step: every migration, in order, on a new empty database, with the command the adapter
 * declares (it points at a throwaway database). Skipped when the gate is already red or the adapter declares none.
 * A failure main's checkout (`mainDir`) has too, with the same error, is not this unit's: it passes with a warning
 * (no migrate_ok evidence), and the run start sends the unit whose migration fails back.
 */
export async function migrateFreshStep(gate: GateReport, o: { ledger: UnitRunOptions["ledger"]; unitId: string; adapter: TargetAdapter; dir: string; mainDir?: string; slot?: <T>(fn: () => Promise<T>) => Promise<T> }): Promise<GateReport> {
	const c = o.adapter.migrateFresh?.(o.dir);
	if (!gate.ok || !c?.cmd) return gate;
	const slot = o.slot ?? ((fn) => fn());
	const t0 = Date.now();
	const r = await slot(() => run(c.cmd, c.args, o.dir, 240_000));
	let ok = r.ok;
	let output = r.output.slice(-6000);
	if (!r.ok && o.mainDir && existsSync(o.mainDir)) {
		const m = o.adapter.migrateFresh?.(o.mainDir);
		const there = m?.cmd ? await slot(() => run(m.cmd, m.args, o.mainDir!, 240_000)) : undefined;
		// not when the error names a file this unit wrote: its own migration is its to fix
		const mine = namesFileOf(o.ledger, o.unitId, r.output, gate.changedFiles);
		if (!mine && there && !there.ok && errorSignature("migrate_ok", there.output) === errorSignature("migrate_ok", r.output)) {
			ok = true;
			output = `warning: the migrations fail on main too, with the same error: not counted against this unit\n${output}`;
		}
	}
	const ms = Date.now() - t0;
	if (r.ok) o.ledger.addEvidence(o.unitId, "migrate_ok", { ms });
	const step = { name: "migrate_ok" as const, ok, ms, output, exitCode: r.exitCode };
	return { ...gate, ok, steps: [...gate.steps, step], failedStep: ok ? undefined : "migrate_ok" };
}

/**
 * The command's output names a file this unit wrote (its green attempts' files, plus `extra`): by its name without the
 * extension, so a migration class name counts too. Test files and very short names are left out.
 */
export function namesFileOf(ledger: Ledger, unitId: string, output: string, extra: string[] = []): boolean {
	const rows = ledger.db.prepare("SELECT json_extract(gate_report, '$.changedFiles') files FROM attempts WHERE unit_id = ? AND outcome = 'gate_green' AND json_extract(gate_report, '$.changedFiles') IS NOT NULL").all(unitId) as Array<{ files: string }>;
	const files = [...rows.flatMap((r) => JSON.parse(r.files) as string[]), ...extra];
	const stems = [...new Set(files.map((f) => basename(f).replace(/\.[^.]+$/, "")))].filter((s) => s.length >= 6 && !/test/i.test(s));
	return stems.some((s) => output.includes(s));
}

/** The test files in the data dirs and where the stack keeps tests for them. */
async function dataTests(projectDir: string, dataDirs: string[], adapter: TargetAdapter): Promise<Array<{ path: string; sha1: string }>> {
	const files = new Set([...(await dataFiles(projectDir, dataDirs, adapter.layout.isTestFile, adapter.toolchain.ignoredPaths)), ...dataDirs.flatMap((d) => findTests(projectDir, d.replace(/\/$/, ""), adapter.layout))]);
	return [...files].sort().map((p) => ({ path: p, sha1: sha1(readFileSync(join(projectDir, p))) }));
}

/** Files under the data dirs that `keep` accepts, relative to the project; the toolchain's generated paths (`ignored`) and what git ignores are skipped. */
async function dataFiles(projectDir: string, dataDirs: string[], keep: (p: string) => boolean, ignored: string[] = []): Promise<string[]> {
	const skip = skipDir(projectDir, ignored, await gitIgnoredDirs(projectDir));
	const out: string[] = [];
	const walk = (rel: string) => {
		const abs = join(projectDir, rel);
		if (!existsSync(abs)) return;
		for (const n of readdirSync(abs)) {
			const r = rel ? `${rel}/${n}` : n;
			if (skip(join(projectDir, r))) continue;
			if (statSync(join(projectDir, r)).isDirectory()) walk(r);
			else if (keep(r)) out.push(r);
		}
	};
	for (const d of dataDirs) walk(d.replace(/\/$/, ""));
	return out;
}

/**
 * The tests this DB unit wrote in its green attempts (a reopened unit's own), less any another unit's green attempt
 * also wrote: those prove that unit's schema.
 */
export function ownTests(ledger: Ledger, unitId: string, isTestFile: (f: string) => boolean): string[] {
	const rows = ledger.db.prepare("SELECT unit_id, json_extract(gate_report, '$.changedFiles') files FROM attempts WHERE outcome = 'gate_green' AND json_extract(gate_report, '$.changedFiles') IS NOT NULL").all() as Array<{ unit_id: string; files: string }>;
	// a code job merged for one of the unit's questions wrote its tests for that unit (older jobs name the question only in their task)
	const jobs = ledger.db.prepare("SELECT json_extract(gate_report, '$.forUnit') forUnit, json_extract(gate_report, '$.what') what, json_extract(gate_report, '$.changedFiles') files FROM attempts WHERE unit_id IS NULL AND outcome = 'fixed' AND json_extract(gate_report, '$.changedFiles') IS NOT NULL").all() as Array<{ forUnit: string | null; what: string | null; files: string }>;
	const jobUnit = (j: (typeof jobs)[number]) => j.forUnit ?? ((q) => (q ? ledger.getQuestion(Number(q))?.unit_id : undefined))(/question #(\d+)/.exec(j.what ?? "")?.[1]);
	const mine = new Set<string>();
	const others = new Set<string>();
	for (const r of rows) for (const f of JSON.parse(r.files) as string[]) if (isTestFile(f)) (r.unit_id === unitId ? mine : others).add(f);
	for (const j of jobs) if (jobUnit(j) === unitId) for (const f of JSON.parse(j.files) as string[]) if (isTestFile(f)) mine.add(f);
	return [...mine].filter((f) => !others.has(f)).sort();
}
