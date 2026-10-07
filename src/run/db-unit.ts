import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import pc from "picocolors";
import { getTargetAdapter } from "../adapters/registry.ts";
import { projectDir } from "../init/init.ts";
import { schemaTextFor, type DbUnitMeta } from "../inventory/db.ts";
import { spawnLeaf } from "../sessions/spawn.ts";
import { runGate, renderGate, sha1, type GateReport } from "./gate.ts";
import { rulesText } from "./prompts.ts";
import type { UnitRunOptions, UnitRunResult } from "./unit.ts";
import { CODE_QUALITY } from "../policy.ts";

/** Fallback when a target adapter declares no data dirs. */
const DEFAULT_DATA_DIRS = ["db/", "migrations/"];

const TASK: Record<string, (m: DbUnitMeta & { group?: string }, dataDir: string) => string> = {
	db_schema: (m) =>
		`Migration lane (keep-schema): port these tables 1:1 to ${m.to ?? m.from.join("/")}. Same table and column names, every column, primary/unique keys, indexes and foreign keys kept; types translated from ${m.from.join("/")} to ${m.to ?? "the target engine"} without loss (lengths, precision, signedness, defaults, nullability, charset/collation notes as comments). Write the ORM schema/entities for them and the initial migration that creates exactly this schema.`,
	db_design: (m, dataDir) =>
		`Refactor lane (new-schema): design the target schema for these tables in ${m.to ?? "the target engine"}: clear names, proper types, keys and constraints, normalized where the legacy schema duplicates data. Write the ORM schema/entities, the migration that creates it, and ${dataDir}MAPPING.md with one line per legacy column: \`old_table.old_column → new_table.new_column (transformation)\`, or \`→ dropped (why)\`. Every legacy column appears in the mapping.`,
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
	const system = [
		`You are the database engineer of a legacy rewrite (${o.config.source.stack} → ${place.stackId}). You work in the target project; write ONLY under ${dataDirs.join(", ")}.`,
		`Engines: ${meta.from.join(" + ")} → ${meta.to ?? "unchanged"}. Strategy: ${meta.strategy}. Stack choices: ${JSON.stringify(choices)}.`,
		adapter.layout.dataAccessHint ? `Data access in this stack: ${adapter.layout.dataAccessHint}.` : "",
		`Tests: ${adapter.layout.testHint} Write at least one test next to your files that proves the schema (entity/column metadata or the migration's DDL) — or for the data lane, the transformation on a small in-memory fixture. Tests must run without a live database.`,
		CODE_QUALITY,
		"Never write credentials. Never edit files outside your directories; other units build features on what you write, so names must match the legacy tables exactly unless your task says otherwise.",
		rulesText(o.root, place.stackId),
	].filter(Boolean).join("\n\n");
	const prompt = [
		`# ${o.unitId} (${unit.kind}${meta.group ? `, table group ${meta.group}` : ""})`,
		task,
		meta.tables?.length ? `\nTables (${meta.tables.length}): ${meta.tables.join(", ")}` : "",
		snapshot ? `\nData dump: ${snapshot}${existsSync(snapshot) ? "" : " (not found on this machine)"} — read it for realistic fixtures; never commit it.` : "",
		o.config.db.url ? `\nLegacy connection: ${o.config.db.url} (an env var; introspection allowed, read-only).` : "",
		`\n## Legacy schema\n\`\`\`sql\n${schema || "(no schema inputs: br onboard --force-db to point at them)"}\n\`\`\``,
	].join("\n");

	if (unit.state === "planned") o.ledger.transitionUnit(o.unitId, "implementing", "db lane");
	const spawn = o.spawn ?? spawnLeaf;
	const gateFn = o.gate ?? runGate;
	const gateSlot = o.gateSlot ?? (<T>(fn: () => Promise<T>) => fn());
	const maxImpl = o.config.run.maxImplementAttempts;
	const maxTotal = maxImpl + o.config.run.maxEscalateAttempts;
	let cost = 0;
	let gate: GateReport | undefined;
	let last = "";
	let n = 0;
	while (n < maxTotal) {
		n++;
		const role = n > maxImpl ? "escalate" : "implement";
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
		gate = await gateSlot(() => gateFn({ ledger: o.ledger, unitId: o.unitId, adapter, targetProjectDir, writeGlobs, testFiles, root: o.root, stackId: place.stackId }));
		o.ledger.endAttempt(attempt, { outcome: gate.ok ? "gate_green" : `gate_red:${gate.failedStep}`, costUsd: res.usage.cost, tokensIn: res.usage.input, tokensOut: res.usage.output, gateReport: gate });
		log(renderGate(gate));
		if (gate.ok) break;
		if (!testFiles.length) last = "no test files: write at least one test next to your schema files.\n";
		last += `failed step: ${gate.failedStep}\n${gate.steps.find((x) => !x.ok)?.output ?? ""}`;
		o.ledger.transitionUnit(o.unitId, "implementing", `gate failed: ${gate.failedStep}`);
	}
	if (gate?.ok) o.ledger.transitionUnit(o.unitId, "review", "gate green");
	else o.ledger.transitionUnit(o.unitId, "quarantined", `db lane: gate still red after ${n} attempts (${gate?.failedStep})`);
	return { unitId: o.unitId, state: o.ledger.getUnit(o.unitId)!.state, attempts: n, gate, costUsd: cost };
}

function dataTests(projectDir: string, dataDirs: string[], isTest: (p: string) => boolean): Array<{ path: string; sha1: string }> {
	const out: Array<{ path: string; sha1: string }> = [];
	const walk = (rel: string) => {
		const abs = join(projectDir, rel);
		if (!existsSync(abs)) return;
		for (const n of readdirSync(abs)) {
			if (n === "node_modules") continue;
			const r = rel ? `${rel}/${n}` : n;
			if (statSync(join(projectDir, r)).isDirectory()) walk(r);
			else if (isTest(r)) out.push({ path: r, sha1: sha1(readFileSync(join(projectDir, r))) });
		}
	};
	for (const d of dataDirs) walk(d.replace(/\/$/, ""));
	return out;
}
