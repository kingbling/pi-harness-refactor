import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getSourceAdapter, getTargetAdapter } from "../src/adapters/registry.ts";
import { ConfigSchema } from "../src/config.ts";
import { advise } from "../src/init/advise.ts";
import { init } from "../src/init/init.ts";
import { recommend, renderSurvey, surveySource, testsFact } from "../src/init/survey.ts";
import { openDecisions } from "../src/inventory/decisions.ts";
import { inventory } from "../src/inventory/run.ts";
import { Ledger } from "../src/ledger/db.ts";
import { FakeModelClient } from "../src/models/fake.ts";

const here = resolve(import.meta.dirname, "..");

function legacyWithData(name: string) {
	const ws = join(here, ".sim", name);
	rmSync(ws, { recursive: true, force: true });
	mkdirSync(join(ws, "legacy", "docker"), { recursive: true });
	cpSync(join(here, "fixtures", "mini-app"), join(ws, "legacy"), { recursive: true });
	writeFileSync(join(ws, "legacy", "docker", "docker-compose.yml"), "services:\n  db:\n    image: mariadb:11\n  docs:\n    image: arangodb:3.10.0\n  cache:\n    image: redis:7\n");
	writeFileSync(join(ws, "legacy", "composer.json"), JSON.stringify({ require: { php: ">=8.1", "ext-mysqli": "*", "phpoffice/phpspreadsheet": "^1.9", "acme/obscure-lib": "^2" } }));
	mkdirSync(join(ws, "legacy", "ui"), { recursive: true });
	writeFileSync(join(ws, "legacy", "ui", "App.vue"), "<template><div/></template>\n");
	return ws;
}

describe("init survey: facts from the repo, provisional values only", () => {
	it("finds data stores, UI and derives targets, db strategy and target path", async () => {
		const ws = legacyWithData("survey");
		const s = await surveySource(join(ws, "legacy"), getSourceAdapter("php"));
		expect(s.engines.map((e) => e.engine).sort()).toEqual(["arangodb", "mariadb", "redis"]);
		expect(s.files[".vue"]).toBe(1); // counted, not interpreted: the model reads what the files mean
		const r = recommend(s, "../legacy");
		expect(r.targets[0]).toBe("nestjs");
		expect(r.targets).toContain("react"); // provisional only: every role; the stack is judged by advise
		expect(r.dbFrom.sort()).toEqual(["arangodb", "mariadb"]); // redis is infrastructure, not data to migrate
		expect(r.dbStrategy).toBe("keep-schema");
		expect(r.targetPath).toBe("../legacy-new"); // beside the source, same as init
	});

	it("the source adapter's store kind decides what holds data (no closed word list); the fixed lists only without a kind", async () => {
		const ws = legacyWithData("survey-kinds");
		const php = getSourceAdapter("php");
		const adapter = { ...php, dbSignals: () => [{ engine: "cockroachdb", kind: "relational" as const, evidence: "go.mod: pgx" }, { engine: "mssql", kind: "relational" as const, evidence: "a DSN" }, { engine: "cassandra", kind: "document" as const, evidence: "gocql" }, { engine: "nats", kind: "queue" as const, evidence: "nats.go" }, { engine: "redis", kind: "cache" as const, evidence: "go-redis" }] };
		const s = await surveySource(join(ws, "legacy"), adapter);
		expect(s.engines.find((e) => e.engine === "redis")).toMatchObject({ kind: "cache" }); // the compose image gets the adapter's kind
		expect(recommend(s, "../legacy").dbFrom.sort()).toEqual(["arangodb", "cassandra", "cockroachdb", "mariadb", "mssql"]);
	});

	it("tests: never 'none found' from a folder-name list; a repo without a top-level test folder is 'not checked'", async () => {
		const ws = legacyWithData("survey-tests");
		const s = await surveySource(join(ws, "legacy"), getSourceAdapter("php"));
		expect(s.tests).toBeUndefined();
		expect(testsFact(s)).toMatch(/^not checked/);
		mkdirSync(join(ws, "legacy", "tests"), { recursive: true });
		expect(testsFact(await surveySource(join(ws, "legacy"), getSourceAdapter("php")))).toBe("tests");
		expect(renderSurvey(s, recommend(s, "../legacy"))).not.toMatch(/none found/);
	});

	it("br init --yes with only --source writes a config derived from the survey", async () => {
		const ws = legacyWithData("survey-init");
		const logs: string[] = [];
		await init(["--source", join(ws, "legacy"), "--yes", "--no-docs", "--no-llm"], { root: ws, prompter: { text: async (_m, i) => i, select: async (_m, o, i) => i ?? o[0]!.value, log: (l) => logs.push(l) } });
		const cfg = JSON.parse(readFileSync(join(ws, "bigrefactor.config.json"), "utf8"));
		expect(cfg.source.stack).toBe("php");
		expect(cfg.target.stacks).toEqual(["nestjs", "react"]);
		expect(cfg.target.path).toBe(join(ws, "legacy-new")); // new code goes next to the old folder
		expect(cfg.db.from.sort()).toEqual(["arangodb", "mariadb"]);
		expect(cfg.db.to).toBe("postgresql");
		expect(logs.join("\n")).toMatch(/found in the legacy repo/);
	});
});

describe("br advise: models make the judgment calls", () => {
	it("library successors and decision picks come from the model and become the recommendations", async () => {
		const ws = legacyWithData("advise");
		const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, db: { strategy: "keep-schema", from: ["mariadb", "arangodb"], to: "postgresql" }, models: {} });
		writeFileSync(join(ws, "bigrefactor.config.json"), JSON.stringify(config));
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
		await inventory(config, ws, ledger);
		const client = new FakeModelClient({
			chat: (req) => (req.schema ? { json: { libraries: [{ name: "acme/obscure-lib", verdict: "replace", successor: "obscure-ts", reason: "same API, maintained" }, { name: "phpoffice/phpspreadsheet", verdict: "replace", successor: "exceljs", reason: "xlsx read/write" }], classes: [] } } : undefined),
			decide: (req) => ("choice" in req.questions && "fold" in ((req.questions["choice"] as any).criteria ?? {}) ? { choice: "fold" } : {}),
		});
		const source = getSourceAdapter("php");
		const targets = [await getTargetAdapter("nestjs")];
		const r = await advise(config, ws, ledger, client, source, targets, () => {});
		expect(client.calls.some((c) => c.kind === "chat")).toBe(true);
		expect(client.calls.some((c) => c.kind === "decide")).toBe(true);
		expect(r.libraries).toBeGreaterThan(0);
		const ds = openDecisions(ledger, config, source, targets, ws);
		const lib = ds.find((d) => d.id === "lib:acme/obscure-lib");
		expect(lib?.recommended).toBe("replace:obscure-ts");
		expect(lib?.reason).toMatch(/maintained/);
		const store = ds.find((d) => d.id === "store:arangodb");
		expect(store?.recommended).toBe("fold"); // Jev's pick overrides the static "keep"
		expect(store?.confidence).toBeGreaterThan(0);
		// the Jev call is in the ledger for calibration
		// one Jev call per decision, each recorded for calibration
		expect((ledger.db.prepare("SELECT COUNT(*) n FROM decisions WHERE point = 'advise:store:arangodb'").get() as { n: number }).n).toBe(1);
		ledger.close();
	});
});

describe("OpenRouter client", () => {
	it("retries network-level failures (fetch failed) instead of aborting onboarding", async () => {
		const { OpenRouterClient } = await import("../src/models/openrouter.ts");
		let n = 0;
		const fetchImpl = (async () => {
			n++;
			if (n < 3) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
			return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { cost: 0 } }), { status: 200 });
		}) as unknown as typeof fetch;
		const c = new OpenRouterClient({ apiKey: "test", fetchImpl } as any);
		const r = await c.chat({ model: "m", messages: [{ role: "user", content: "x" }] });
		expect(r.text).toBe("ok");
		expect(n).toBe(3);
	}, 30_000);
	it("a 200 response carrying an error body (flex unavailable) falls back to the default tier instead of returning empty text", async () => {
		const { OpenRouterClient } = await import("../src/models/openrouter.ts");
		const tiers: unknown[] = [];
		const fetchImpl = (async (_u: string, init: RequestInit) => {
			const body = JSON.parse(String(init.body));
			tiers.push(body.service_tier ?? "default");
			if (body.service_tier === "flex") return new Response("\n  \n" + JSON.stringify({ error: { message: "Flex processing is temporarily unavailable.", code: 502 } }), { status: 200 });
			return new Response(JSON.stringify({ choices: [{ message: { content: "{\"a\":1}" } }], usage: { cost: 0.01 } }), { status: 200 });
		}) as unknown as typeof fetch;
		const c = new OpenRouterClient({ apiKey: "test", fetchImpl, flexRetries: 1 } as any);
		const r = await c.chat({ model: "m", tier: "flex", schema: { type: "object" }, messages: [{ role: "user", content: "x" }] });
		expect(r.json).toEqual({ a: 1 });
		expect(tiers).toEqual(["flex", "flex", "default"]);
	}, 60_000);
});

describe("advice hygiene", () => {
	it("splits prose successors into package + condition and keeps code defaults over unsure Jev picks", async () => {
		const ws = legacyWithData("advise-hygiene");
		const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, db: { strategy: "keep-schema", from: ["mariadb", "arangodb"], to: "postgresql" }, models: {} });
		writeFileSync(join(ws, "bigrefactor.config.json"), JSON.stringify(config));
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
		await inventory(config, ws, ledger);
		const client = new FakeModelClient({
			chat: (req) => (req.schema ? { json: { libraries: [{ name: "acme/obscure-lib", verdict: "replace", successor: "ssh2 (only if SFTP is used)", condition: "", reason: "SSH client" }], classes: [] } } : undefined),
			decide: (req) => Object.fromEntries(Object.entries(req.questions).map(([k, q]) => [k, { type: "choice", choice: Object.keys((q as any).criteria).find((c) => c !== "keep" && c !== "other") ?? "other", probabilities: {}, confidence: 0.2 }])) as any,
		});
		const source = getSourceAdapter("php");
		const targets = [await getTargetAdapter("nestjs")];
		const staticRec = openDecisions(ledger, config, source, targets, ws).find((d) => d.id === "store:arangodb")?.recommended;
		await advise(config, ws, ledger, client, source, targets, () => {});
		const ds = openDecisions(ledger, config, source, targets, ws);
		const lib = ds.find((d) => d.id === "lib:acme/obscure-lib")!;
		expect(lib.recommended).toBe("replace:ssh2");
		expect(lib.reason).toMatch(/only if SFTP is used/);
		const store = ds.find((d) => d.id === "store:arangodb")!;
		expect(store.recommended).toBe(staticRec);
		expect(store.reason).toMatch(/unsure \(20%/);
		ledger.close();
	});
});

describe("where each part goes: rated from the analyzed repo, not from the adapters we have", () => {
	it("every dimension is a decision with scored options; adapter gaps are flagged, never dropped; nothing anchors on code defaults", async () => {
		const ws = legacyWithData("advise-targets");
		const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs", "react"] }, db: { strategy: "keep-schema", from: ["mariadb", "arangodb"], to: "postgresql" }, models: {} });
		writeFileSync(join(ws, "bigrefactor.config.json"), JSON.stringify(config));
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
		await inventory(config, ws, ledger);
		const prompts: string[] = [];
		const client = new FakeModelClient({
			chat: (req) => {
				prompts.push(req.messages.map((m) => m.content).join("\n"));
				const props = (req.schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
				if ("dimensions" in props)
					return {
						json: {
							dimensions: [
								{ key: "server", now: "PHP framework", candidates: [{ id: "symfony", score: 82, reason: "stays in PHP" }, { id: "nestjs", score: 64, reason: "typed rewrite" }] },
								{ key: "ui", now: "server templates + Vue islands", candidates: [{ id: "vue", score: 78, reason: "Vue islands already carry the interactive UI" }, { id: "react", score: 60, reason: "larger hiring pool" }] },
								{ key: "data:mariadb", now: "MariaDB", candidates: [{ id: "mariadb", score: 70, reason: "keep" }, { id: "postgresql", score: 65, reason: "JSONB" }] },
								{ key: "data:arangodb", now: "ArangoDB", candidates: [{ id: "arangodb", score: 75, reason: "graph queries" }, { id: "drop", score: 10, reason: "used" }] },
							],
						},
					};
				// the phrasing model returns a single option: the question must still offer every option
				if ("questions" in props) return { json: { questions: [{ id: "target:ui", question: "Which UI?", options: [{ value: "vue", label: "Vue", hint: "" }], recommended: "vue", opinion: "keeps the component model" }] } };
				return req.schema ? { json: { libraries: [], classes: [], decisions: [] } } : { text: "brief" };
			},
			decide: () => ({ choice: "other" }),
		});
		const source = getSourceAdapter("php");
		const targets = await Promise.all(["nestjs", "react"].map((t) => getTargetAdapter(t)));
		await advise(config, ws, ledger, client, source, targets, () => {});
		const all = openDecisions(ledger, config, source, targets, ws);
		const ui = all.find((d) => d.id === "target:ui")!;
		expect(ui.recommended).toBe("vue");
		expect(ui.options.map((o) => o.value)).toEqual(expect.arrayContaining(["vue", "react", "none"]));
		expect(ui.options.find((o) => o.value === "vue")!.hint).toMatch(/no bigrefactor adapter yet/);
		expect(ui.options.find((o) => o.value === "vue")!.label).toMatch(/78\/100/);
		expect(all.find((d) => d.id === "target:server")!.recommended).toBe("symfony");
		expect(all.find((d) => d.id === "target:data:mariadb")!.recommended).toBe("mariadb");
		expect(all.some((d) => d.id === "store:arangodb")).toBe(false); // rated as a dimension instead
		// no model was told the provisional targets as fact, nor a code default to agree with
		expect(prompts.join("\n")).not.toMatch(/targets: nestjs \+ react|code_default/);
		// the repo brief is about the legacy repo only: its facts carry no target at all (decided or not)
		expect(prompts.find((p) => p.includes("Facts gathered from the legacy repo"))).not.toMatch(/target: |not decided yet/);
		for (const c of client.calls.filter((c) => c.kind === "decide")) expect(JSON.stringify((c.req as { state: unknown }).state)).not.toMatch(/current_recommendation/);
		for (const d of all) expect(d.options.length, d.id).toBeGreaterThan(1);
		const { pointHash } = await import("../src/jev/ask.ts");
		const p = { id: "x", topic: "t", intent: "i", evidence: "e", options: [{ value: "a" }, { value: "b" }] };
		expect(pointHash(p)).toBe(pointHash({ ...p, options: [{ value: "b" }, { value: "a" }] }));
		// answers land in config: server first, the data dimension sets the engine / store verdict
		const { applyDecision } = await import("../src/inventory/decisions.ts");
		applyDecision(ledger, config, ws, "target:server", "symfony");
		applyDecision(ledger, config, ws, "target:ui", "none");
		applyDecision(ledger, config, ws, "target:data:mariadb", "postgresql");
		applyDecision(ledger, config, ws, "target:data:arangodb", "arangodb");
		const cfg = JSON.parse(readFileSync(join(ws, "bigrefactor.config.json"), "utf8"));
		expect(cfg.target.stacks).toEqual(["symfony"]);
		expect(cfg.target.choices.react).toBeUndefined(); // no longer targeted: its choices are gone
		expect(cfg.db.to).toBe("postgresql");
		expect(cfg.db.stores.arangodb).toBe("keep");
		ledger.close();
	});
});
