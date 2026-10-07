import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getSourceAdapter, getTargetAdapter } from "../src/adapters/registry.ts";
import { ConfigSchema } from "../src/config.ts";
import { advise } from "../src/init/advise.ts";
import { init } from "../src/init/init.ts";
import { recommend, surveySource } from "../src/init/survey.ts";
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
		expect(r.targetPath).toBe("./legacy-next");
	});

	it("br init --yes with only --source writes a config derived from the survey", async () => {
		const ws = legacyWithData("survey-init");
		const logs: string[] = [];
		await init(["--source", join(ws, "legacy"), "--yes", "--no-docs", "--no-llm"], { root: ws, prompter: { text: async (_m, i) => i, select: async (_m, o, i) => i ?? o[0]!.value, log: (l) => logs.push(l) } });
		const cfg = JSON.parse(readFileSync(join(ws, "bigrefactor.config.json"), "utf8"));
		expect(cfg.source.stack).toBe("php");
		expect(cfg.target.stacks).toEqual(["nestjs", "react"]);
		expect(cfg.target.path).toBe("./legacy-next");
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

describe("target stack: judged from the analyzed repo, not from the adapters we have", () => {
	it("a model reading the brief recommends the stack; adapter gaps are flagged, never dropped; nothing anchors on code defaults", async () => {
		const ws = legacyWithData("advise-targets");
		const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs", "react"] }, db: { strategy: "keep-schema", from: ["mariadb"], to: "postgresql" }, models: {} });
		writeFileSync(join(ws, "bigrefactor.config.json"), JSON.stringify(config));
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
		await inventory(config, ws, ledger);
		const prompts: string[] = [];
		const client = new FakeModelClient({
			chat: (req) => {
				prompts.push(req.messages.map((m) => m.content).join("\n"));
				const props = (req.schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
				if ("alternatives" in props) return { json: { recommended: { server: "nestjs", ui: "vue", reason: "Vue islands already carry the interactive UI" }, alternatives: [{ server: "nestjs", ui: "react", reason: "larger hiring pool" }] } };
				// the phrasing model returns a single option: the question must still offer every option
				if ("questions" in props) return { json: { questions: [{ id: "targets", question: "Which stack for the rewrite?", options: [{ value: "nestjs+vue", label: "NestJS + Vue", hint: "" }], recommended: "nestjs+vue", opinion: "keeps the component model" }] } };
				return req.schema ? { json: { libraries: [], classes: [], decisions: [] } } : { text: "brief" };
			},
			decide: () => ({ choice: "other" }),
		});
		const source = getSourceAdapter("php");
		const targets = await Promise.all(["nestjs", "react"].map((t) => getTargetAdapter(t)));
		await advise(config, ws, ledger, client, source, targets, () => {});
		const t = openDecisions(ledger, config, source, targets, ws).find((d) => d.id === "targets")!;
		expect(t.recommended).toBe("nestjs+vue");
		expect(t.options.map((o) => o.value)).toEqual(expect.arrayContaining(["nestjs+vue", "nestjs+react", "nestjs"]));
		expect(t.options.find((o) => o.value === "nestjs+vue")!.hint).toMatch(/no vue adapter/);
		// no model was told the provisional targets as fact, nor a code default to agree with
		expect(prompts.join("\n")).not.toMatch(/targets: nestjs \+ react|code_default/);
		expect(prompts.join("\n")).toMatch(/target stack: not decided yet/);
		for (const c of client.calls.filter((c) => c.kind === "decide")) expect(JSON.stringify((c.req as { state: unknown }).state)).not.toMatch(/current_recommendation/);
		// no decision without a choice; sharing an options list across decisions must not reorder another's
		const all = openDecisions(ledger, config, source, targets, ws);
		for (const d of all) expect(d.options.length, d.id).toBeGreaterThan(1);
		const { pointHash } = await import("../src/jev/ask.ts");
		const p = { id: "x", topic: "t", intent: "i", evidence: "e", options: [{ value: "a" }, { value: "b" }] };
		expect(pointHash(p)).toBe(pointHash({ ...p, options: [{ value: "b" }, { value: "a" }] }));
		ledger.close();
	});
});
