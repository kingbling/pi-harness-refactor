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

describe("init survey: defaults come from the repo, not from code", () => {
	it("finds data stores, UI and derives targets, db strategy and target path", async () => {
		const ws = legacyWithData("survey");
		const s = await surveySource(join(ws, "legacy"), getSourceAdapter("php"));
		expect(s.engines.map((e) => e.engine).sort()).toEqual(["arangodb", "mariadb", "redis"]);
		expect(s.ui.templates + (s.ui.components["vue"] ?? 0)).toBeGreaterThan(0);
		const r = recommend(s, "../legacy");
		expect(r.targets[0]).toBe("nestjs");
		expect(r.targets).toContain("react"); // UI present; no vue adapter → first web target
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
		expect(store.reason).toMatch(/unsure \(20%\)/);
		ledger.close();
	});
});
