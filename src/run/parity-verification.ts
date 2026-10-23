import { EXACT_JSON_VERSION } from "./exact-json.ts";
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config } from "../config.ts";
import { headOf, isDirty } from "../git.ts";
import type { Ledger } from "../ledger/db.ts";
import { REQUIRED_FOR_ACCEPTED } from "../ledger/schema.ts";
import { checkSlice, loadSteps, sliceFacts, type SliceCheck, type Step } from "./parity-check.ts";
import { contractInputs, digest, routeCovered, strictSuiteProblems } from "./parity-contracts.ts";
import { lastFinish, notProven } from "./finish-check.ts";
import { loadApps, appRoot, LEGACY } from "./parity.ts";
import { acquireRunLock, liveRun } from "./run-lock.ts";
import { pluginVersion } from "./plugin-version.ts";
import type { ProjectValidation } from "./parity-project-checks.ts";
import { projectDir } from "../init/init.ts";
import { mentionsCase } from "./ported.ts";
import { assessChanges, changeDecisionProblems, type VerifiedChange } from "./parity-changes.ts";
import { verificationEngine, verificationWorkspace, type FileProvenance } from "./parity-provenance.ts";
import { legacyTree } from "./parity-legacy-tree.ts";

export const VERIFICATION_META = "parity_verification";

/** These are test inputs, not exemptions for mismatching outputs. All are retained in the proof. */
export interface VerificationScope {
	version: 1;
	fixture: { name: string; files: string[] };
	/** Runtime configuration overlays only. Business behavior must still come from the pinned source. */
	legacyOverrides?: Array<{ path: string; why: string }>;
}

interface Snapshot {
	engine: { plugin?: string; node: string; comparator: "strict-v3"; code: FileProvenance };
	workspaceInputs: FileProvenance;
	legacyRoot: string;
	config: Config;
	recipes: ReturnType<typeof loadApps>;
	sourceCommit: string;
	targetCommit: string;
	configHash: string;
	recipesHash: string;
	scope: VerificationScope;
	scopeHash: string;
	fixture: Record<string, string>;
	legacyTreeHash: string;
	legacyFiles: number;
	sourceSubmodules: Record<string, string>;
	suites: Record<string, { hash: string; inputs: Record<string, string> }>;
	ledgerHash: string;
}

export interface VerificationReport {
	version: 1;
	at: string;
	status: "passed" | "blocked" | "failed";
	/** This is evidence for this declared suite, never a proof of all possible inputs. */
	claim: "declared behavior suite";
	requiredSlices: string[];
	sourceCommit?: string;
	targetCommit?: string;
	problems: string[];
	snapshot?: Snapshot;
	projectValidation?: ProjectValidation;
	runs: Array<{ slice: string; runId?: number; outcome: string; note: string; evidence?: string; hash?: string; changes?: VerifiedChange[] }>;
}

const suitePath = (root: string, slice: string) => join(root, ".bigrefactor", "parity", "slices", slice.replace(/[^\w.-]+/g, "_"), "steps.json");
export const verificationPath = (root: string) => join(root, ".bigrefactor", "parity", "verification.json");

/** Streams large snapshots rather than loading a production dump into the host's memory. */
async function fileHash(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

function slicesOf(ledger: Ledger): string[] {
	return [...new Set(ledger.listUnits().map((u) => (JSON.parse(u.meta) as { slice?: string }).slice).filter((s): s is string => !!s))].sort();
}

/** Preconditions independent of historical parity labels or a model's verdict about differences. */
export function migrationProblems(ledger: Ledger, targetCommit?: string, explicitScenarios: Step[] = []): string[] {
	const problems = [...ledger.checkInvariants().problems];
	const units = ledger.listUnits();
	if (!units.length) problems.push("no migration units inventoried");
	const open = units.filter((u) => u.state !== "accepted");
	if (open.length) problems.push(`${open.length} units are not accepted (including parked units): ${open.slice(0, 8).map((u) => u.id).join(", ")}`);
	const noSlice = units.filter((u) => !(JSON.parse(u.meta) as { slice?: string }).slice);
	if (noSlice.length) problems.push(`${noSlice.length} units have no verification slice`);
	const files = new Set(units.flatMap((u) => (JSON.parse(u.meta) as { files?: string[] }).files ?? []));
	const unowned = (ledger.db.prepare("SELECT method, path, handler_symbol FROM index_routes WHERE side = 'source'").all() as Array<{ method: string | null; path: string; handler_symbol: string | null }>).filter((r) => (!r.handler_symbol || !files.has(r.handler_symbol.split("::")[0]!)) && !routeCovered(explicitScenarios, `${r.method ?? "ANY"} ${r.path}`));
	if (unowned.length) problems.push(`${unowned.length} source routes have no inventoried unit owner or explicit compared scenario and would escape slice verification`);
	const unaccounted = ledger.db.prepare("SELECT COUNT(*) n FROM symbols WHERE state NOT IN ('accepted','dropped')").get() as { n: number };
	if (unaccounted.n) problems.push(`${unaccounted.n} symbols are not accepted or dropped`);
	const truth = notProven(ledger);
	if (truth.readNotRun) problems.push(`${truth.readNotRun} accepted units have truth read but never run on legacy (br recheck / truth upgrade)`);
	const cases = ledger.db.prepare("SELECT COUNT(*) n FROM truth_cases WHERE verified_on_old = 0 OR ported_test_path IS NULL").get() as { n: number };
	if (cases.n) problems.push(`${cases.n} truth cases lack legacy execution or a linked ported test`);
	const oldNumeric = ledger.db.prepare("SELECT COUNT(*) n FROM truth_cases WHERE verified_on_old = 1 AND numeric_version < ?").get(EXACT_JSON_VERSION) as { n: number };
	if (oldNumeric.n) problems.push(`${oldNumeric.n} legacy truth cases predate exact JSON parsing and need revalidation (br run / truth upgrade)`);
	const missing = ledger.db.prepare(`SELECT COUNT(*) n FROM units u WHERE state = 'accepted' AND (SELECT COUNT(DISTINCT type) FROM evidence e WHERE e.unit_id = u.id AND type IN (${REQUIRED_FOR_ACCEPTED.map(() => "?").join(",")})) < ?`).get(...REQUIRED_FOR_ACCEPTED, REQUIRED_FOR_ACCEPTED.length) as { n: number };
	if (missing.n) problems.push(`${missing.n} accepted units lack required gate evidence (br recheck)`);
	const noTruth = ledger.db.prepare("SELECT COUNT(*) n FROM units u WHERE state = 'accepted' AND COALESCE(kind,'') NOT LIKE 'db_%' AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.unit_id = u.id AND type IN ('truth_green_on_old','truth_none'))").get() as { n: number };
	if (noTruth.n) problems.push(`${noTruth.n} accepted behavior units have neither runtime truth nor a checked no-behavior declaration`);
	const noCases = ledger.db.prepare("SELECT COUNT(*) n FROM units u WHERE state = 'accepted' AND COALESCE(kind,'') NOT LIKE 'db_%' AND NOT EXISTS (SELECT 1 FROM truth_cases c WHERE c.unit_id = u.id) AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.unit_id = u.id AND type = 'truth_none')").get() as { n: number };
	if (noCases.n) problems.push(`${noCases.n} accepted behavior units have no recorded truth cases or checked no-behavior declaration`);
	const quirks = ledger.db.prepare("SELECT COUNT(*) n FROM quirks WHERE status IN ('pending','asked') OR (status='kept' AND applied IS NOT 'keep') OR (status='dropped' AND applied IS NOT 'drop')").get() as { n: number };
	if (quirks.n) problems.push(`${quirks.n} quirk decisions are unresolved or not applied to tests (br run reconciles accepted units)`);
	const weak = units.filter((u) => !!(JSON.parse(u.meta) as { weakTestsNote?: string }).weakTestsNote);
	if (weak.length) problems.push(`${weak.length} units still have unresolved weak-test findings`);
	const stale = units.filter((u) => !!(JSON.parse(u.meta) as { stale?: boolean }).stale);
	if (stale.length) problems.push(`${stale.length} units have stale source evidence`);
	const finish = lastFinish(ledger);
	if (!finish || !targetCommit || finish.head !== targetCommit) problems.push("no finish check for the target commit (br finish)");
	else {
		if (finish.notJudged) problems.push(`finish check was not judged: ${finish.notJudged}`);
		if (finish.marks || finish.items.length) problems.push(`finish check still has ${finish.marks} stub marks and ${finish.items.length} gaps; recheck after repairs`);
	}
	const deferred = ledger.db.prepare("SELECT COUNT(DISTINCT unit_id) n FROM evidence WHERE id IN (SELECT MAX(id) FROM evidence GROUP BY unit_id, type) AND json_extract(payload, '$.judged') = 0").get() as { n: number };
	if (deferred.n) problems.push(`${deferred.n} units have checks that were not judged`);
	return problems;
}

function loadScope(root: string): VerificationScope {
	const scope = JSON.parse(readFileSync(join(root, ".bigrefactor", "parity", "scope.json"), "utf8")) as VerificationScope;
	if (scope?.version !== 1 || typeof scope.fixture?.name !== "string" || !scope.fixture.name.trim() || !Array.isArray(scope.fixture.files) || !scope.fixture.files.length || scope.fixture.files.some((p) => typeof p !== "string" || !p.trim()))
		throw new Error("scope.json needs version:1 and fixture:{name,files:[snapshot/reset/config input paths]}");
	if (scope.legacyOverrides !== undefined && (!Array.isArray(scope.legacyOverrides) || scope.legacyOverrides.some((p) => !p || typeof p.path !== "string" || !p.path || p.path.startsWith("/") || p.path.split(/[\\/]/).includes("..") || typeof p.why !== "string" || !p.why.trim())))
		throw new Error("scope.json legacyOverrides need source-relative path and why");
	return scope;
}

async function snapshot(o: VerifyOptions): Promise<Snapshot> {
	const sourceCommit = await headOf(o.config.source.path), targetCommit = await headOf(o.config.target.path);
	if (!sourceCommit || !targetCommit) throw new Error("both apps need committed git snapshots");
	const scope = loadScope(o.root);
	const fixture: Record<string, string> = {};
	for (const p of scope.fixture.files) fixture[p] = await fileHash(resolve(o.root, p));
	const legacy = appRoot(o.config, o.root, LEGACY);
	const tree = await legacyTree(o.config.source.path, legacy, sourceCommit, (scope.legacyOverrides ?? []).map((p) => p.path));
	if (tree.mismatches.length) throw new Error(`legacy runtime copy differs from pinned source in ${tree.mismatches.length} file(s): ${tree.mismatches.slice(0, 8).join(", ")}; restore it or declare documented configuration overlays in scope.json`);
	const suites: Snapshot["suites"] = {};
	for (const slice of slicesOf(o.ledger)) {
		const suite = loadSteps(o.root, slice);
		if (!suite) throw new Error(`${slice}: missing steps.json`);
		suites[slice] = { hash: digest(readFileSync(suitePath(o.root, slice))), inputs: await contractInputs(o.root, suite.checks ?? []) };
	}
	const state = {
		units: o.ledger.db.prepare("SELECT id, state, meta FROM units ORDER BY id").all(),
		symbols: o.ledger.db.prepare("SELECT id, state, unit_id FROM symbols ORDER BY id").all(),
		routes: o.ledger.db.prepare("SELECT method, path, handler_symbol FROM index_routes WHERE side = 'source' ORDER BY method, path, handler_symbol").all(),
		truth: o.ledger.db.prepare("SELECT * FROM truth_cases ORDER BY id").all(),
		quirks: o.ledger.db.prepare("SELECT * FROM quirks ORDER BY id").all(),
		quirkAnswers: o.ledger.db.prepare("SELECT id, status, answer, answered_by FROM questions WHERE id IN (SELECT question_id FROM quirks) ORDER BY id").all(),
		evidence: o.ledger.db.prepare("SELECT unit_id, type, MAX(id) id FROM evidence GROUP BY unit_id, type ORDER BY unit_id, type").all(),
		finish: lastFinish(o.ledger),
	};
	// Retain the recipes, excluding mutable probe counters and model notes.
	const recipes = Object.fromEntries(Object.entries(loadApps(o.root)).map(([s, a]) => [s, { recipe: a.recipe }]));
	const [code, workspaceInputs] = await Promise.all([verificationEngine(), verificationWorkspace(o.root)]);
	return { engine: { plugin: await pluginVersion(), node: process.version, comparator: "strict-v3", code }, workspaceInputs, legacyRoot: legacy, config: o.config, recipes, sourceCommit, targetCommit, configHash: digest(JSON.stringify(o.config)), recipesHash: digest(JSON.stringify(Object.fromEntries(Object.entries(recipes).map(([s, a]) => [s, a.recipe])))), scope, scopeHash: digest(JSON.stringify(scope)), fixture, legacyTreeHash: tree.hash, legacyFiles: tree.files, sourceSubmodules: tree.submodules, suites, ledgerHash: digest(JSON.stringify(state)) };
}

interface VerifyOptions {
	ledger: Ledger;
	config: Config;
	root: string;
	linkAll: (wt: string) => void | Promise<void>;
	serverStack: string;
	/** Read-only readiness report; never labels old comparisons as a new verified pass. */
	reportOnly?: boolean;
	/** br run verifies at its end while it holds the workspace lock itself. */
	runHolds?: boolean;
	log?: (line: string) => void;
	validateProjects?: () => Promise<ProjectValidation>;
}

/** Extra scenarios in a required slice can verify endpoints supplied by the target platform, without fake code units. */
function explicitScenarios(o: VerifyOptions): Step[] {
	return slicesOf(o.ledger).flatMap((slice) => {
		const steps = loadSteps(o.root, slice)?.steps;
		return Array.isArray(steps) ? steps.filter((s) => s && typeof s.route === "string" && typeof s.method === "string" && ["data", "page", "redirect"].includes(s.compare)) : [];
	});
}

export async function verifyParity(o: VerifyOptions): Promise<VerificationReport> {
	const log = o.log ?? (() => {});
	const report: VerificationReport = { version: 1, at: new Date().toISOString(), status: "blocked", claim: "declared behavior suite", requiredSlices: slicesOf(o.ledger), problems: [], runs: [] };
	const pid = liveRun(o.root);
	const own = !!o.runHolds && pid === process.pid;
	if (pid !== undefined && !own) report.problems.push(`workspace is held by a live run or parity check (pid ${pid}); verify after it finishes`);
	const release = !o.reportOnly && pid === undefined ? acquireRunLock(o.root) : () => {};
	try {
		report.sourceCommit = await headOf(o.config.source.path);
		report.targetCommit = await headOf(o.config.target.path);
		report.problems.push(...migrationProblems(o.ledger, report.targetCommit, explicitScenarios(o)));
		const pinned = o.config.source.commit ?? o.ledger.getMeta("source_commit");
		if (!pinned || report.sourceCommit !== pinned) report.problems.push("legacy HEAD does not match a pinned source commit");
		for (const [name, path] of [["legacy", o.config.source.path], ["target", o.config.target.path]])
			if (await isDirty(path!).catch(() => true)) report.problems.push(`${name} checkout has uncommitted changes; verification requires a clean pinned checkout`);
		const apps = loadApps(o.root);
		if (!apps[LEGACY]?.up || !apps[LEGACY]?.recipe) report.problems.push("legacy app has no working start recipe (br parity --probe)");
		if (resolve(appRoot(o.config, o.root, LEGACY)) === resolve(o.config.source.path)) report.problems.push("legacy must run in a workspace copy; the pinned source repo is read-only");
		if (!apps[o.serverStack]?.up || !apps[o.serverStack]?.recipe) report.problems.push(`${o.serverStack} has no working start recipe (br parity --probe)`);
		if (o.config.db.strategy !== "none" && (!apps[LEGACY]?.recipe?.reset || !apps[o.serverStack]?.recipe?.reset))
			report.problems.push("database verification needs deterministic reset recipes on both sides");
		if (o.config.db.strategy === "keep-schema" && (!apps[LEGACY]?.recipe?.dump || !apps[o.serverStack]?.recipe?.dump))
			report.problems.push("keep-schema verification needs data dump recipes on both sides");
		try { loadScope(o.root); } catch (e) { report.problems.push(`fixture provenance is missing/invalid: ${String(e)}`); }
		for (const slice of slicesOf(o.ledger)) {
			const file = loadSteps(o.root, slice);
			if (!file || !Array.isArray(file.steps)) report.problems.push(`${slice}: missing/invalid steps.json; author its scenarios before verification`);
			else {
				report.problems.push(...strictSuiteProblems(file, sliceFacts(o.ledger, slice).routes, o.root).map((p) => `${slice}: ${p}`));
				report.problems.push(...changeDecisionProblems(file, o.ledger).map((p) => `${slice}: ${p}`));
			}
		}
		// Different slice names cannot overwrite the same suite/evidence directory.
		const paths = slicesOf(o.ledger).map((s) => suitePath(o.root, s));
		if (new Set(paths).size !== paths.length) report.problems.push("slice names collide after path sanitization");
		if (o.reportOnly) report.problems.push("readiness report only: a fresh full replay is required (br parity --verify)");
		if (!o.validateProjects) report.problems.push("whole-project validation is unavailable; final build/lint/ported tests must run on the verified commit");
		if (!report.problems.length) {
			log("strict parity: fingerprinting pinned code, fixture files, runtime overlays and suites");
			try { report.snapshot = await snapshot(o); } catch (e) { report.problems.push(String(e)); }
		}
		if (!report.problems.length && report.snapshot) {
			try {
				report.projectValidation = await o.validateProjects!();
				report.problems.push(...report.projectValidation.problems);
				if (report.projectValidation.head !== report.targetCommit || !report.projectValidation.checks.length || report.projectValidation.checks.some((c) => !c.ok)) report.problems.push("whole-project checks did not pass on the frozen target commit");
				const tested = new Set(report.projectValidation.checks.filter((c) => c.step === "test" && c.ok).flatMap((c) => (c.tests ?? []).map((p) => `${c.stack}:${p}`)));
				const cases = o.ledger.db.prepare("SELECT c.id, c.ported_test_path, json_extract(u.meta,'$.place.stack') stack FROM truth_cases c JOIN units u ON u.id = c.unit_id WHERE c.ported_test_path IS NOT NULL").all() as Array<{ id: string; ported_test_path: string; stack: string | null }>;
				const contents = new Map<string, string>();
				let missing = 0;
				for (const c of cases) {
					const stack = c.stack ?? (o.config.target.stacks.length === 1 ? o.config.target.stacks[0] : undefined);
					const key = `${stack}:${c.ported_test_path}`;
					if (!stack || !tested.has(key)) { missing++; continue; }
					if (!contents.has(key)) contents.set(key, readFileSync(join(projectDir(o.config, stack), c.ported_test_path), "utf8"));
					if (!mentionsCase(contents.get(key)!, c.id)) missing++;
				}
				if (missing) report.problems.push(`${missing} linked truth cases were not present in test files executed by the final project checks`);
			} catch (e) { report.problems.push(`whole-project validation failed: ${String(e)}`); }
			for (const slice of slicesOf(o.ledger)) {
				if (liveRun(o.root) !== process.pid) { report.problems.push("workspace ownership changed during verification"); break; }
				log(`strict parity: replaying ${slice} on legacy twice and target once`);
				let r: SliceCheck;
				try { r = await checkSlice({ ...o, log, slice, strict: true }); }
				catch (e) { report.problems.push(`${slice}: verification failed: ${String(e)}`); continue; }
				const evidence = r.runId === undefined ? undefined : join(".bigrefactor", "parity", "evidence", `${r.runId}.json`);
				const changes = r.evidence ? assessChanges(r.evidence.suite, o.ledger, r.evidence, r.diffs) : { verified: [], unexplained: r.diffs, problems: [] };
				const specified = r.outcome === "differs" && changes.verified.length > 0 && !changes.unexplained.length && !changes.problems.length && !!r.evidence && !r.evidence.problems.length;
				report.runs.push({ slice, runId: r.runId, outcome: specified ? "accepted-changes" : r.outcome, note: r.note, ...(changes.verified.length ? { changes: changes.verified } : {}), ...(r.evidence && evidence ? { evidence, hash: digest(readFileSync(join(o.root, evidence))) } : {}) });
				report.problems.push(...changes.problems.map((p) => `${slice}: ${p}`));
				for (const d of changes.unexplained) report.problems.push(`${slice}: ${d.step.startsWith("check:") ? `check ${d.step.slice(6)}` : d.step}: differs at ${d.path || d.kind}`);
				if ((r.outcome !== "same" && !specified) || changes.unexplained.length || !r.evidence || r.evidence.problems.length || changes.problems.length)
					report.problems.push(`${slice}: ${r.outcome}; ${r.note}`);
				if (r.evidence && (r.evidence.targetCommit !== report.targetCommit || r.evidence.sourceCommit !== report.sourceCommit)) report.problems.push(`${slice}: tested a different source/target commit`);
				if (r.evidence && (r.evidence.suiteHash !== report.snapshot.suites[slice]?.hash || JSON.stringify(r.evidence.inputs) !== JSON.stringify(report.snapshot.suites[slice]?.inputs) || r.evidence.recipesHash !== report.snapshot.recipesHash)) report.problems.push(`${slice}: suite, check inputs or recipes differ from the frozen verification snapshot`);
			}
			try {
				if (JSON.stringify(report.snapshot) !== JSON.stringify(await snapshot(o))) report.problems.push("verification inputs, migration evidence or code changed during replay; run again on frozen inputs");
			} catch (e) { report.problems.push(`cannot revalidate verification inputs: ${String(e)}`); }
			for (const [name, path] of [["legacy", o.config.source.path], ["target", o.config.target.path]])
				if (await isDirty(path!).catch(() => true)) report.problems.push(`${name} checkout changed during replay`);
			report.problems.push(...migrationProblems(o.ledger, report.targetCommit, explicitScenarios(o)));
			if (liveRun(o.root) !== process.pid) report.problems.push("workspace ownership changed during verification");
			report.status = report.problems.length ? "failed" : "passed";
		}
		report.at = new Date().toISOString();
		if (!o.reportOnly) {
			const path = verificationPath(o.root);
			mkdirSync(join(o.root, ".bigrefactor", "parity"), { recursive: true });
			writeFileSync(`${path}.tmp`, JSON.stringify(report, null, 2) + "\n");
			renameSync(`${path}.tmp`, path);
			o.ledger.setMeta(VERIFICATION_META, JSON.stringify({ at: report.at, status: report.status, targetCommit: report.targetCommit, sourceCommit: report.sourceCommit, hash: digest(readFileSync(path)), suites: report.runs.length }));
		}
		return report;
	} finally { release(); }
}

export function renderVerification(report: VerificationReport): string[] {
	const groups = new Map<string, string[]>();
	const problems: string[] = [];
	for (const p of report.problems) {
		const match = /^([^:]+): (page [^:]+: needs a browser check|no compared scenario for)/.exec(p);
		if (!match) { problems.push(p); continue; }
		const key = `${match[1]}: ${match[2]!.startsWith("page") ? "missing browser coverage" : "missing HTTP scenarios"}`;
		const entries = groups.get(key) ?? [];
		entries.push(p); groups.set(key, entries);
	}
	for (const [key, entries] of groups) problems.push(`${key}: ${entries.length} (${entries.slice(0, 2).map((s) => s.slice(s.indexOf(":") + 2)).join("; ")}${entries.length > 2 ? "; …" : ""})`);
	return [
		`strict parity ${report.status} @ ${report.targetCommit?.slice(0, 9) ?? "unknown commit"}: ${report.runs.filter((r) => r.outcome === "same" || r.outcome === "accepted-changes").length}/${report.requiredSlices.length} suites verified${report.runs.some((r) => r.changes?.length) ? ` (${report.runs.reduce((n, r) => n + (r.changes?.length ?? 0), 0)} recorded behavior change(s) verified)` : ""}; scope: ${report.claim}`,
		...problems.slice(0, 40).map((p) => `  ${p}`),
		...(problems.length > 40 ? [`  ${problems.length - 40} more groups; use --json for the complete report`] : []),
		report.status === "passed" ? "All declared scenarios matched or reproduced their explicit recorded behavior changes on this commit; this does not establish behavior outside the recorded suite." : "Unit acceptance and decisions to leave differences cannot establish a parity pass.",
	];
}

/** Historical evidence is labelled historical; status never certifies changing inputs from a cached pass. */
export function verificationSummary(ledger: Ledger): string {
	const stored = ledger.getMeta(VERIFICATION_META);
	if (stored) {
		try {
			const r = JSON.parse(stored) as { at: string; status: string; targetCommit?: string };
			return `last strict parity replay: ${r.status} @ ${r.targetCommit?.slice(0, 9) ?? "unknown"} (${r.at}); verify current inputs with br parity --verify`;
		} catch { /* invalid historical metadata cannot establish a pass */ }
	}
	return "strict parity not verified → br parity --verify (unit progress does not measure parity)";
}
