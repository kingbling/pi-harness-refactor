import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import pc from "picocolors";
import { getTargetAdapter } from "../adapters/registry.ts";
import { projectDir } from "../init/init.ts";
import { schemaTextFor, type DbUnitMeta } from "../inventory/db.ts";
import { spawnLeaf } from "../sessions/spawn.ts";
import { fixRunSetup, fixSetupWithModel } from "../init/setup-fixer.ts";
import { errorSignature, run, runGate, renderGate, sha1, type GateReport } from "./gate.ts";
import { reviewWithModel } from "./review.ts";
import type { TargetAdapter } from "../adapters/types.ts";
import { triageGate } from "./triage.ts";
import { rulesText } from "./prompts.ts";
import type { UnitRunOptions, UnitRunResult } from "./unit.ts";
import { CODE_QUALITY, goalsText } from "../policy.ts";

/** Fallback when a target adapter declares no data dirs. */
const DEFAULT_DATA_DIRS = ["db/", "migrations/"];

const TASK: Record<string, (m: DbUnitMeta & { group?: string }, dataDir: string) => string> = {
	db_schema: (m) =>
		`Migration lane (keep-schema): port these tables 1:1 to ${m.to ?? m.from.join("/")}. Same table and column names, every column, primary/unique keys, indexes and foreign keys kept; types translated from ${m.from.join("/")} to ${m.to ?? "the target engine"} without loss (lengths, precision, signedness, defaults, nullability, charset/collation notes as comments). Write the schema for them in this stack's data-access approach (its ORM entities/models, or SQL/schema files when the stack has no ORM) and the initial migration that creates exactly this schema.`,
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
	if (!adapter.toolchain.isProjectReady(targetProjectDir)) throw new Error(`target project missing at ${targetProjectDir}; run br setup`);
	const dataDirs = adapter.layout.dataDirs?.length ? adapter.layout.dataDirs : DEFAULT_DATA_DIRS;
	const writeGlobs = [...new Set(dataDirs.flatMap((d) => [`${d}**`, ...adapter.layout.testFileGlobs(d.replace(/\/$/, ""))]))];
	const choices = o.config.target.choices[place.stackId] ?? {};
	const snapshot = o.config.db.snapshot ? (o.config.db.snapshot.startsWith("/") ? o.config.db.snapshot : join(o.config.source.path, o.config.db.snapshot)) : undefined;
	const schema = await schemaTextFor(o.config, meta.tables ?? []);
	const task = (TASK[unit.kind ?? ""] ?? TASK["db_schema"]!)(meta, dataDirs[0]!);
	// what earlier DB units wrote: the model reads them and orders its migration after every table it references
	const existing = dataFiles(targetProjectDir, dataDirs, (p) => !adapter.layout.isTestFile(p));
	const system = [
		`You are the database engineer of a legacy rewrite (${o.config.source.stack} → ${place.stackId}). You work in the target project; write ONLY under ${dataDirs.join(", ")}.`,
		`Engines: ${meta.from.join(" + ")} → ${meta.to ?? "unchanged"}. Strategy: ${meta.strategy}. Stack choices: ${JSON.stringify(choices)}.`,
		adapter.layout.dataAccessHint ? `Data access in this stack: ${adapter.layout.dataAccessHint}.` : "",
		`Tests: ${adapter.layout.testHint} Write at least one test next to your files that proves the schema (the tables' columns as the stack's data-access code declares them, or the migration's DDL) — or for the data lane, the transformation on a small in-memory fixture. Tests must run without a live database.`,
		CODE_QUALITY,
		goalsText(o.config.goals),
		"Never write credentials. Never edit files outside your directories; other units build features on what you write, so names must match the legacy tables exactly unless your task says otherwise.",
		`Name files and migrations after the tables, never after the unit. A migration runs after every migration that creates a table it references (foreign keys, data copied from it): read the existing ones (ls, grep) and give yours a later version.${adapter.migrateFresh ? " The gate applies all migrations in order to an empty database." : ""}`,
		rulesText(o.root, place.stackId),
	].filter(Boolean).join("\n\n");
	const prompt = [
		`# Database work (${unit.kind}${meta.group ? `, table group ${meta.group}` : ""})`,
		task,
		meta.tables?.length ? `\nTables (${meta.tables.length}): ${meta.tables.join(", ")}` : "",
		`\nFiles already in ${dataDirs.join(", ")} (earlier units' schema and migrations): ${existing.length ? existing.slice(0, 200).join(", ") : "none yet"}`,
		snapshot ? `\nData dump: ${snapshot}${existsSync(snapshot) ? "" : " (not found on this machine)"} — read it for realistic fixtures; never commit it.` : "",
		o.config.db.url ? `\nLegacy connection: ${o.config.db.url} (an env var; introspection allowed, read-only).` : "",
		`\n## Legacy schema\n\`\`\`sql\n${schema || "(no schema inputs: br onboard --force-db to point at them)"}\n\`\`\``,
	].join("\n");

	if (unit.state === "planned") o.ledger.transitionUnit(o.unitId, "implementing", "db lane");
	const spawn = o.spawn ?? spawnLeaf;
	const gateFn = o.gate ?? runGate;
	const gateSlot = o.gateSlot ?? (<T>(fn: () => Promise<T>) => fn());
	const reviewer = o.reviewer === false ? undefined : (o.reviewer ?? (o.spawn ? undefined : reviewWithModel));
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
		const s = await spawn({ role, cwd: targetProjectDir, config: o.config, writeGlobs, protectedGlobs: adapter.protectedGlobs, systemPrompt: system, transcriptPath: join(o.root, ".bigrefactor", "sessions", o.unitId, `${role}-${attempt}.jsonl`) });
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
		const testFiles = dataTests(targetProjectDir, dataDirs, adapter.layout.isTestFile);
		// the same reviewer as code units judges the schema and its tests (the review never holds a CPU slot)
		const review = reviewer
			? async (changedFiles: string[]) => {
					const ra = o.ledger.startAttempt(o.unitId, "review", o.config.models.escalate.id);
					const r = await reviewer({ ledger: o.ledger, config: o.config, root: o.root, unitId: o.unitId, adapter, targetProjectDir, moduleDir: dataDirs[0]!.replace(/\/$/, ""), legacyFiles: [], changedFiles, testFiles: testFiles.map((t) => t.path), writeGlobs, ownerNote: `This is a database unit. Its task: ${task}${meta.tables?.length ? ` Tables: ${meta.tables.join(", ")}.` : ""}`, transcriptPath: join(o.root, ".bigrefactor", "sessions", o.unitId, `review-${ra}.jsonl`) });
					o.ledger.endAttempt(ra, { outcome: !r.judged ? "not_judged" : r.ok ? "review_ok" : "review_red", costUsd: r.costUsd ?? 0, gateReport: { output: r.output } });
					cost += r.costUsd ?? 0;
					return r;
				}
			: undefined;
		gate = await gateFn({ ledger: o.ledger, unitId: o.unitId, adapter, targetProjectDir, writeGlobs, testFiles, root: o.root, stackId: place.stackId, review, slot: gateSlot });
		gate = await migrateFreshStep(gate, { ledger: o.ledger, unitId: o.unitId, adapter, dir: targetProjectDir, slot: gateSlot });
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
				const fixed = await fixRunSetup({ config: o.config, root: o.root, adapter, projectDir: projectDir(o.config, place.stackId), fixer: setupFixer, ledger: o.ledger, lock: o.mergeLock, signature: errorSignature(gate.failedStep ?? "", failedOut), problem: `Gate step ${gate.failedStep} failed for database unit ${o.unitId} (files in ${dataDirs.join(", ")}). Triage: ${t.reason}. Fix the project setup, not the unit's files.\nThe unit works in its own git worktree (${targetProjectDir}); only files tracked in git (and the dependency dirs linked or copied into it: ${adapter.toolchain.worktreeLinks.join(", ") || "none"}) are there.\nGate output tail:\n${failedOut.slice(-3000)}` }).catch((e) => (log(pc.yellow(`  setup fix failed: ${e?.message ?? e}`)), undefined));
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
 * The DB lane's last gate step: every migration, in order, on a new empty database, with the command the adapter
 * declares (it points at a throwaway database). Skipped when the gate is already red or the adapter declares none.
 */
export async function migrateFreshStep(gate: GateReport, o: { ledger: UnitRunOptions["ledger"]; unitId: string; adapter: TargetAdapter; dir: string; slot?: <T>(fn: () => Promise<T>) => Promise<T> }): Promise<GateReport> {
	const c = o.adapter.migrateFresh?.(o.dir);
	if (!gate.ok || !c) return gate;
	const t0 = Date.now();
	const r = await (o.slot ?? ((fn) => fn()))(() => run(c.cmd, c.args, o.dir, 240_000));
	const ms = Date.now() - t0;
	if (r.ok) o.ledger.addEvidence(o.unitId, "migrate_ok", { ms });
	const step = { name: "migrate_ok" as const, ok: r.ok, ms, output: r.output.slice(-6000), exitCode: r.exitCode };
	return { ...gate, ok: r.ok, steps: [...gate.steps, step], failedStep: r.ok ? undefined : "migrate_ok" };
}

function dataTests(projectDir: string, dataDirs: string[], isTest: (p: string) => boolean): Array<{ path: string; sha1: string }> {
	return dataFiles(projectDir, dataDirs, isTest).map((p) => ({ path: p, sha1: sha1(readFileSync(join(projectDir, p))) }));
}

/** Files under the data dirs that `keep` accepts, relative to the project. */
function dataFiles(projectDir: string, dataDirs: string[], keep: (p: string) => boolean): string[] {
	const out: string[] = [];
	const walk = (rel: string) => {
		const abs = join(projectDir, rel);
		if (!existsSync(abs)) return;
		for (const n of readdirSync(abs)) {
			if (n === "node_modules") continue;
			const r = rel ? `${rel}/${n}` : n;
			if (statSync(join(projectDir, r)).isDirectory()) walk(r);
			else if (keep(r)) out.push(r);
		}
	};
	for (const d of dataDirs) walk(d.replace(/\/$/, ""));
	return out;
}
