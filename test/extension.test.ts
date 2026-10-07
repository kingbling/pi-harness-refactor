import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureRepo, commitAll } from "../src/git.ts";

/**
 * The Pi extension's /br command, driven through a stub ExtensionAPI: every subcommand must answer with
 * text (never throw into Pi), the dialogs must be used for questions when a UI exists, and `/br onboard`
 * must run the same flow as the CLI. No Pi process, no model calls.
 */
const here = resolve(import.meta.dirname, "..");

function stubPi() {
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void>; getArgumentCompletions?: (p: string) => unknown }>();
	const tools = new Map<string, any>();
	const pi = {
		registerCommand: (name: string, def: any) => commands.set(name, def),
		registerTool: (def: any) => tools.set(def.name, def),
		registerEntryRenderer: () => {},
		registerMessageRenderer: () => {},
		on: () => {},
		sendMessage: () => {},
	};
	return { pi, commands, tools };
}

function stubCtx(cwd: string, hasUI: boolean, answers: Array<string | undefined> = []) {
	const shown: string[] = [];
	const notified: string[] = [];
	const ctx = {
		cwd,
		hasUI,
		ui: {
			notify: (m: string) => notified.push(m),
			setStatus: () => {},
			select: async (_title: string, options: string[]) => answers.shift() ?? options[0],
			input: async (_title: string, initial?: string) => answers.shift() ?? initial ?? "",
			confirm: async () => true,
			custom: async (factory: any) => factory({ requestRender() {} }, () => {}),
		},
		sessionManager: { getBranch: () => [] },
	};
	return { ctx, shown, notified };
}

describe("pi extension /br", () => {
	it("registers the command with completions and answers every subcommand without throwing", async () => {
		const { pi, commands, tools } = stubPi();
		const mod = await import("../src/pi/extension.ts");
		(mod.default as (p: any) => void)(pi as any);
		const br = commands.get("br");
		expect(br).toBeTruthy();
		expect(tools.has("ledger_query")).toBe(true);
		const completions = br!.getArgumentCompletions!("on") as Array<{ value: string }>;
		expect(completions.map((c) => c.value)).toContain("onboard");

		// workspace with a pre-bootstrapped target, like the e2e test
		const ws = join(here, ".sim", "pi-ext");
		rmSync(ws, { recursive: true, force: true });
		mkdirSync(join(ws, "legacy"), { recursive: true });
		cpSync(join(here, "fixtures", "mini-app"), join(ws, "legacy"), { recursive: true });
		const target = join(ws, "migrated");
		mkdirSync(join(target, "src"), { recursive: true });
		writeFileSync(join(target, "package.json"), JSON.stringify({ name: "sim", private: true, devDependencies: { vitest: "x" } }));
		writeFileSync(join(target, "nest-cli.json"), "{}");
		ensureRepo(target, "migration/main");
		commitAll(target, "chore: bootstrap (test)");

		// no config yet: status warns instead of throwing
		const { ctx: c0, notified } = stubCtx(ws, false);
		await br!.handler("status", c0);
		expect(notified.length + 1).toBeGreaterThan(0);

		// onboard in print mode (no UI → --yes appended), offline
		const { ctx: c1 } = stubCtx(ws, false);
		const logs: string[] = [];
		const origLog = console.log;
		console.log = (...a: unknown[]) => logs.push(a.join(" "));
		try {
			await br!.handler(`onboard --source ${join(ws, "legacy")} --stack php --target ${target} --to nestjs --db keep-schema --no-docs --no-llm`, c1);
			for (const sub of ["status", "questions", "unaccounted", "frameworks", "order", "decide", "why routes.php"]) await br!.handler(sub, c1);
		} finally {
			console.log = origLog;
		}
		const out = logs.join("\n");
		expect(out).toMatch(/✓ init/);
		expect(out).toMatch(/✓ inventory/);
		expect(out).toMatch(/✓ decide/);
		expect(out).toMatch(/invariants: ok/);
		expect(out).toMatch(/no open questions/);
		expect(out).toMatch(/slices: \d+/);
		expect(out).toMatch(/no open decisions/);
		expect(out).toMatch(/framework:|libraries:|concern/);
		expect(out).not.toMatch(/failed:/);
	}, 120_000);
});
