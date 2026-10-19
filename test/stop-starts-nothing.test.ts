import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { commitAll, ensureRepo } from "../src/git.ts";
import { inventory } from "../src/inventory/run.ts";
import { Ledger } from "../src/ledger/db.ts";
import { FakeModelClient } from "../src/models/fake.ts";
import { runScheduler } from "../src/run/run.ts";
import type { LeafSession } from "../src/sessions/spawn.ts";

/**
 * A stop starts nothing new while the running lanes finish: the resolver model no longer settles questions (its
 * answers start code and setup jobs). On the live run a stop drained for 50 minutes and kept starting code jobs.
 */
const here = resolve(import.meta.dirname, "..");

describe("a stop starts nothing new", () => {
	it("a question asked while the lanes finish is not handed to the resolver", async () => {
		const ws = join(here, ".sim", "stop-starts-nothing");
		rmSync(ws, { recursive: true, force: true });
		cpSync(join(here, "fixtures", "mini-app"), join(ws, "legacy"), { recursive: true });
		const target = join(ws, "migrated");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "package.json"), JSON.stringify({ name: "sim", private: true }, null, 2));
		await ensureRepo(target, "migration/main");
		await commitAll(target, "chore: bootstrap");
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: target, stacks: ["nestjs"] }, models: {}, run: { agentConcurrency: 1, gateConcurrency: 1, minFreeDiskGb: 0 } });
		writeFileSync(join(ws, "bigrefactor.config.json"), JSON.stringify(config, null, 2));
		process.env["BR_WORKSPACE"] = ws;
		const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
		await inventory(config, ws, ledger);
		ledger.db.prepare("UPDATE units SET deps = '[]'").run();
		const before = ledger.askQuestion({ point: "budget", question: "daily cap reached", options: ["raise — raise it", "tomorrow — wait"], askedBy: "orchestrator" });
		let late: number | undefined;
		const resolved: number[] = [];
		await runScheduler({
			ledger,
			config,
			root: ws,
			client: new FakeModelClient({}),
			handleSigint: false,
			truthAhead: false,
			log: () => {},
			resolver: async ({ q }) => (resolved.push(q.id), { owner: "the owner's call" }),
			shouldStop: () => late !== undefined,
			// the lane's session asks a question and then works on past the stop, longer than a scheduling pass's resolver interval
			spawn: async () =>
				({
					run: async () => {
						late ??= ledger.askQuestion({ point: "budget", question: "asked while stopping", options: ["raise — raise it", "tomorrow — wait"], askedBy: "orchestrator" });
						await new Promise((r) => setTimeout(r, 6500));
						return { text: "", toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } };
					},
					dispose() {},
				}) as unknown as LeafSession,
			gate: async () => {
				throw new Error("test: no gate");
			},
		});
		expect(resolved).toContain(before);
		expect(late).toBeDefined();
		expect(resolved).not.toContain(late);
		ledger.close();
	}, 60_000);
});
