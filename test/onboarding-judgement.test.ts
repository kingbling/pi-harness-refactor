import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { exampleProfileJson, phpAdapter } from "../src/adapters/source/php.ts";
import { ConfigSchema } from "../src/config.ts";
import { confirmDeadCode } from "../src/init/dead.ts";
import { inventory } from "../src/inventory/run.ts";
import { Ledger } from "../src/ledger/db.ts";
import type { LeafSession, SpawnOptions } from "../src/sessions/spawn.ts";

/**
 * Judgement moved from fixed lists to models: Jev confirms dead code before it stays dropped, the profile model
 * picks legacy file kinds, and a symbol name alone no longer makes a file "cross-cutting" (T3).
 */
const here = resolve(import.meta.dirname, "..");

/** A scripted dead-code session: calls judge_files with `verdicts(paths)`; records the options and the task. */
const deadSession = (verdicts: (paths: string[]) => Array<{ path: string; verdict: string; evidence: string }>, seen: { opts?: SpawnOptions; task?: string } = {}) =>
	(async (opts: SpawnOptions): Promise<LeafSession> => {
		seen.opts = opts;
		return {
			run: async (task: string) => {
				seen.task = task;
				const paths = [...task.matchAll(/^ {2}(\S+\.php)/gm)].map((m) => m[1]!);
				await (opts.customTools!.find((t) => t.name === "judge_files") as unknown as { execute: (i: string, p: object) => Promise<unknown> }).execute("x", { files: verdicts(paths) });
				return { text: "done", toolCalls: 3, blocked: 0, usage: { input: 0, output: 0, cost: 0.01 } };
			},
			dispose() {},
		} as unknown as LeafSession;
	}) as never;

function deadWorkspace(name: string) {
	const ws = join(here, ".sim", name);
	rmSync(ws, { recursive: true, force: true });
	mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
	cpSync(join(here, "fixtures", "mini-app"), join(ws, "legacy"), { recursive: true });
	process.env["BR_WORKSPACE"] = ws;
	const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, models: {} });
	return { ws, config, ledger: new Ledger(join(ws, ".bigrefactor", "ledger.sqlite")) };
}

describe("dead code: a model with tools checks before a file stays dropped", () => {
	it("still-running files are kept; dead ones become one owner question per folder; keep brings them back", async () => {
		const { ws, config, ledger } = deadWorkspace("dead-confirm");
		mkdirSync(join(ws, "legacy", "cron"), { recursive: true });
		mkdirSync(join(ws, "legacy", "scripts"), { recursive: true });
		writeFileSync(join(ws, "legacy", "cron", "nightly.php"), "<?php\nfunction nightly_report() { return 1; }\n");
		writeFileSync(join(ws, "legacy", "scripts", "cron.sh"), "#!/bin/sh\nphp cron/nightly.php\n");
		writeFileSync(join(ws, "legacy", "legacy", "old_import.php"), "<?php\nfunction old_import() { return 2; }\n");
		writeFileSync(join(ws, ".bigrefactor", "framework-profile.json"), JSON.stringify({ ...exampleProfileJson(), frameworkDirs: [] }));
		const first = await inventory(config, ws, ledger);
		expect(first.dead).toEqual(expect.arrayContaining(["cron/nightly.php", "legacy/old_export.php", "legacy/old_import.php"]));

		const seen: { opts?: SpawnOptions; task?: string } = {};
		const spawn = deadSession((paths) => paths.map((p) => (p === "cron/nightly.php" ? { path: p, verdict: "alive", evidence: "scripts/cron.sh runs it" } : { path: p, verdict: "dead", evidence: "nothing names it" })), seen);
		const r = await confirmDeadCode(config, ws, ledger, undefined, { spawn });
		// one read-only session in the legacy repo, with the framework profile's facts
		expect(seen.opts).toMatchObject({ role: "review", cwd: config.source.path, writeGlobs: [] });
		expect(seen.task).toMatch(/concern install .*: drop/);
		expect(r.alive).toEqual(["cron/nightly.php"]);
		// the two dead files of legacy/ are ONE question, recommended drop, blocking nothing
		const qs = ledger.openQuestions().filter((q) => q.point === "dead_code");
		expect(qs).toHaveLength(r.questions);
		const legacyQ = qs.find((q) => q.question.includes("legacy/old_export.php"))!;
		expect(legacyQ.question).toMatch(/2 file\(s\) in legacy\//);
		expect(legacyQ.blocks).toBe("none");

		const liveness = JSON.parse(readFileSync(join(ws, ".bigrefactor", "decisions.json"), "utf8")).liveness;
		expect(liveness["cron/nightly.php"].alive).toBe(true);
		expect(liveness["legacy/old_export.php"]).toMatchObject({ alive: false, question: legacyQ.id });

		// unanswered: the dead files stay dropped; the cron script is a unit again
		const second = await inventory(config, ws, ledger);
		expect(second.dead).not.toContain("cron/nightly.php");
		expect(second.dead).toContain("legacy/old_export.php");
		expect(ledger.listUnits().some((u) => (JSON.parse(u.meta).files as string[]).includes("cron/nightly.php"))).toBe(true);
		// the owner keeps the folder: its files come back
		ledger.answerQuestion(legacyQ.id, "keep — keep them");
		const third = await inventory(config, ws, ledger);
		expect(third.dead).not.toContain("legacy/old_export.php");
		expect(third.dead).not.toContain("legacy/old_import.php");
		// judged files are not checked again
		expect((await confirmDeadCode(config, ws, ledger, undefined, { spawn })).asked).toBe(0);
	});

	it("unsure keeps the file; no session leaves the files unjudged for the next check", async () => {
		const { ws, config, ledger } = deadWorkspace("dead-unsure");
		await inventory(config, ws, ledger);
		expect((await confirmDeadCode(config, ws, ledger, undefined, { spawn: (async () => { throw new Error("provider down"); }) as never })).asked).toBe(0);
		expect(JSON.parse(readFileSync(join(ws, ".bigrefactor", "decisions.json"), "utf8")).liveness).toEqual({});
		const r = await confirmDeadCode(config, ws, ledger, undefined, { spawn: deadSession((paths) => paths.map((p) => ({ path: p, verdict: "unsure", evidence: "a string-built class name might load it" }))) });
		expect(r.alive).toEqual(["legacy/old_export.php"]);
		expect(ledger.openQuestions().filter((q) => q.point === "dead_code")).toHaveLength(0);
	});
});

describe("framework profile: the model's picks", () => {
	it("legacy file kinds come from the profile; none without one", () => {
		const ws = join(here, ".sim", "profile-words");
		rmSync(ws, { recursive: true, force: true });
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		process.env["BR_WORKSPACE"] = ws;
		phpAdapter.reloadProfile?.();
		expect(phpAdapter.legacyWords).toBeUndefined();
		writeFileSync(join(ws, ".bigrefactor", "framework-profile.json"), JSON.stringify({ ...exampleProfileJson(), legacyWords: ["tpl", "cmd"] }));
		phpAdapter.reloadProfile?.();
		expect(phpAdapter.legacyWords).toEqual(["tpl", "cmd"]);
	});

	it("an app without a separate framework is a valid profile; legacyWords must be single words", () => {
		expect(phpAdapter.validateProfile!({ id: "plain", frameworkDirs: [], loaders: [], concerns: [], entryPoint: "(^|/)bin/[^/]+\\.php$" })).toEqual([]);
		expect(phpAdapter.validateProfile!({ ...exampleProfileJson(), legacyWords: ["x.tpl"] })).toContainEqual(expect.stringMatching(/legacyWords/));
		expect(phpAdapter.validateProfile!({ ...exampleProfileJson(), loaders: [] })).toContainEqual(expect.stringMatching(/loaders/));
	});
});

describe("tiers: no name-based cross-cutting tier", () => {
	it("a method named isCommandInQueue does not make its file T3", () => {
		const ws = join(here, ".sim", "tier-names");
		rmSync(ws, { recursive: true, force: true });
		mkdirSync(join(ws, "app", "reportqueue"), { recursive: true });
		writeFileSync(join(ws, "app", "reportqueue", "report.php"), "<?php\nclass Report { function isCommandInQueue() { return 1; } }\n");
		process.env["BR_SOURCE_ROOT"] = ws;
		const file = { path: "app/reportqueue/report.php", lang: "php", loc: 2, hash: "", symbols: [], deps: [], routes: [], queries: [], literalRefs: [], dynamicMarkers: [] };
		expect(phpAdapter.classifyTier!({ id: "s", path: file.path, kind: "method", name: "Report::isCommandInQueue", line: 2, exported: true }, file as never)).toBeUndefined();
	});
});
