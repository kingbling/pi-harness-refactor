import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getSourceAdapter, getTargetAdapter } from "../src/adapters/registry.ts";
import { exampleProfileJson } from "../src/adapters/source/php.ts";
import { ConfigSchema } from "../src/config.ts";
import { decisionPrompt, openDecisions, toPoint } from "../src/inventory/decisions.ts";
import { validateNotApp } from "../src/inventory/not-app.ts";
import { inventory } from "../src/inventory/run.ts";
import { briefPath, loadBrief, phraseDecisions, pointHash, repoBrief, repoFacts } from "../src/jev/ask.ts";
import { Ledger } from "../src/ledger/db.ts";
import { FakeModelClient } from "../src/models/fake.ts";
import type { LeafSession, SpawnOptions } from "../src/sessions/spawn.ts";

/**
 * Judgments about the legacy repo come from models that read it with tools, not from fixed lists: the repo brief
 * (legacy repo only; owner decisions are their own input), the folders that are not the app, and where two models
 * disagree the owner decides alone, seeing both views.
 */
const here = resolve(import.meta.dirname, "..");

function workspace(name: string) {
	const ws = join(here, ".sim", name);
	rmSync(ws, { recursive: true, force: true });
	mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
	cpSync(join(here, "fixtures", "mini-app"), join(ws, "legacy"), { recursive: true });
	process.env["BR_WORKSPACE"] = ws;
	const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, models: {} });
	writeFileSync(join(ws, "bigrefactor.config.json"), JSON.stringify(config));
	return { ws, config, ledger: new Ledger(join(ws, ".bigrefactor", "ledger.sqlite")) };
}

describe("repo brief: the legacy repo only, written by a session that reads it", () => {
	it("a read-only session writes it; no target talk in its input; owner decisions go to the phrasing model separately", async () => {
		const root = mkdtempSync(join(tmpdir(), "br-brief-"));
		const src = join(root, "legacy");
		mkdirSync(src, { recursive: true });
		writeFileSync(join(src, "CLAUDE.md"), "Services: api, worker. PHP 8.2. Vue apps in ui/.");
		const config = ConfigSchema.parse({ source: { path: src, stack: "php" }, target: { path: join(root, "new"), stacks: ["nestjs"] }, models: {} });
		mkdirSync(join(root, ".bigrefactor"), { recursive: true });
		writeFileSync(join(root, ".bigrefactor", "decisions.json"), JSON.stringify({ answers: { "target:server": { answer: "symfony" }, "target:ui": { answer: "react" } } }));
		const ledger = new Ledger(":memory:");
		ledger.createUnit({ id: "U1", tier: "T0", kind: "class", symbolIds: [] });
		// units carry their kind in a column (not in meta)
		expect(repoFacts(config, ledger, root)).toMatch(/units by kind: class=1/);

		// an older brief (written before the owner answered, with target talk) is written again
		writeFileSync(briefPath(root), "The migration target is not decided yet.\n");
		const seen: { opts?: SpawnOptions; task?: string } = {};
		const spawn = (async (opts: SpawnOptions): Promise<LeafSession> => {
			seen.opts = opts;
			return { run: async (task: string) => ((seen.task = task), { text: "# Brief\nAPI and worker services (CLAUDE.md), PHP 8.2, Vue apps in ui/.", toolCalls: 6, blocked: 0, usage: { input: 0, output: 0, cost: 0.02 } }), dispose() {} } as unknown as LeafSession;
		}) as never;
		const prompts: string[] = [];
		const client = new FakeModelClient({ chat: (req) => (prompts.push(req.messages.map((m) => m.content).join("\n")), { json: { questions: [] } }) });
		const b = await repoBrief({ ledger, config, root, client, spawn });
		expect(seen.opts).toMatchObject({ role: "review", cwd: src, writeGlobs: [] });
		expect(seen.opts!.systemPrompt).toMatch(/documentation .*manifests .*compose/);
		expect(seen.task).not.toMatch(/target|symfony|not decided/i);
		expect(b.brief).toMatch(/Vue apps/);
		expect(loadBrief(root)).toBe(b.brief + "\n");
		// written once: the next call reads it
		expect((await repoBrief({ ledger, config, root, client, spawn: (async () => { throw new Error("not again"); }) as never })).costUsd).toBe(0);

		await phraseDecisions({ ledger, config, root, client, spawn }, [{ id: "truth-env", topic: "truth", intent: "runnable?", evidence: "e", options: [{ value: "local" }, { value: "none" }] }]);
		expect(prompts.at(-1)).toMatch(/Owner decisions already made[^\n]*\n- target:server = symfony\n- target:ui = react/);
		expect(readFileSync(briefPath(root), "utf8")).not.toMatch(/not decided/);
	});
});

describe("two models disagree: the owner decides alone, with both views", () => {
	it("an advised pick the phrasing model disagrees with is marked; the prompt shows both", async () => {
		const { ws, config, ledger } = workspace("disagree");
		await inventory(config, ws, ledger);
		const source = getSourceAdapter("php");
		const targets = [await getTargetAdapter("nestjs")];
		const d0 = openDecisions(ledger, config, source, targets, ws, { raw: true }).find((d) => d.id === "db-strategy")!;
		const file = { answers: {}, advice: { "db-strategy": { value: "keep-schema", reason: "the schema is used everywhere" } } };
		writeFileSync(join(ws, ".bigrefactor", "decisions.json"), JSON.stringify(file));
		const advised = openDecisions(ledger, config, source, targets, ws, { raw: true }).find((d) => d.id === "db-strategy")!;
		const phrased = { question: "Keep the database as it is?", options: d0.options.map((o) => ({ value: o.value, label: o.label })), recommended: "new-schema", opinion: "the tables are half unused", by: "m", hash: pointHash(toPoint(advised)) };
		writeFileSync(join(ws, ".bigrefactor", "decisions.json"), JSON.stringify({ ...file, phrased: { "db-strategy": phrased } }));
		const d = openDecisions(ledger, config, source, targets, ws).find((x) => x.id === "db-strategy")!;
		expect(d.disagree).toEqual({ advised: { value: "keep-schema", why: expect.stringMatching(/schema is used everywhere/) }, phrased: { value: "new-schema", why: "the tables are half unused" } });
		expect(decisionPrompt(d)).toMatch(/the models disagree[\s\S]*keep-schema: the schema is used everywhere[\s\S]*new-schema: the tables are half unused/);
		// agreeing models: no mark
		writeFileSync(join(ws, ".bigrefactor", "decisions.json"), JSON.stringify({ ...file, phrased: { "db-strategy": { ...phrased, recommended: "keep-schema" } } }));
		expect(openDecisions(ledger, config, source, targets, ws).find((x) => x.id === "db-strategy")!.disagree).toBeUndefined();
	});
});

describe("folders that are not the app: the profile model's call, not a fixed list", () => {
	it("stubs and vendored code are left out; a vendored library becomes a library decision; docs are no longer dropped by name", async () => {
		const { ws, config, ledger } = workspace("not-app");
		const put = (p: string, s: string) => (mkdirSync(join(ws, "legacy", p, ".."), { recursive: true }), writeFileSync(join(ws, "legacy", p), s));
		put("app/3rdparty/phpmailer/class.phpmailer.php", "<?php\nclass PHPMailer { function send() { return true; } }\n");
		put("phpstan-stubs/macros.php", "<?php\nclass Route { }\n");
		put("docs/index.php", "<?php\necho 'api docs entry';\n");
		const notApp = [
			{ path: "app/3rdparty/phpmailer/", kind: "vendored", name: "phpmailer/phpmailer", why: "PHPMailer 5 copied into the repo" },
			{ path: "phpstan-stubs/", kind: "stubs", why: "static-analysis stubs, never loaded at runtime" },
		];
		expect(validateNotApp({ notApp }, config.source.path)).toEqual([]);
		expect(validateNotApp({ notApp: [{ path: "nowhere/", kind: "docs", why: "x" }, { path: "docs/", kind: "manuals", why: "x" }] }, config.source.path)).toEqual([expect.stringMatching(/nowhere\/ does not exist/), expect.stringMatching(/kind must be one of/)]);
		writeFileSync(join(ws, ".bigrefactor", "framework-profile.json"), JSON.stringify({ ...exampleProfileJson(), frameworkDirs: [], notApp }));
		getSourceAdapter("php").reloadProfile?.();
		await inventory(config, ws, ledger);
		const files = (ledger.db.prepare("SELECT path FROM files").all() as Array<{ path: string }>).map((f) => f.path);
		expect(files).toContain("docs/index.php");
		expect(files.some((f) => f.startsWith("app/3rdparty/") || f.startsWith("phpstan-stubs/"))).toBe(false);
		const lib = openDecisions(ledger, config, getSourceAdapter("php"), [await getTargetAdapter("nestjs")], ws).find((d) => d.id === "lib:phpmailer/phpmailer")!;
		expect(lib.evidence).toMatch(/vendored copy in app\/3rdparty\/phpmailer\/: PHPMailer 5 copied/);
	});
});
