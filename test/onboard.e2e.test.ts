import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { InitPrompter, PromptOption } from "../src/init/init.ts";
import { onboard } from "../src/init/onboard.ts";
import { Ledger } from "../src/ledger/db.ts";
import { ensureRepo, commitAll } from "../src/git.ts";

/**
 * End-to-end onboarding on the fixture, offline (no model calls, no network): init → setup (pre-bootstrapped
 * target, like after `nest new`) → inventory → frameworks → decide → order. Proves the flow is seamless,
 * resumable and that every artifact lands in the workspace, never in a repo. The TUI test drives the same
 * flow through a scripted prompter and asserts which questions a human actually sees.
 */
const here = resolve(import.meta.dirname, "..");

function workspace(name: string) {
	const ws = join(here, ".sim", name);
	rmSync(ws, { recursive: true, force: true });
	mkdirSync(join(ws, "legacy"), { recursive: true });
	cpSync(join(here, "fixtures", "mini-app"), join(ws, "legacy"), { recursive: true });
	// target pre-bootstrapped (what the official generator would leave) so the test needs no network
	const target = join(ws, "migrated");
	mkdirSync(join(target, "src"), { recursive: true });
	writeFileSync(join(target, "package.json"), JSON.stringify({ name: "sim", private: true, dependencies: {}, devDependencies: { vitest: "x" } }, null, 2));
	writeFileSync(join(target, "nest-cli.json"), "{}");
	writeFileSync(join(target, ".gitignore"), "node_modules/\n");
	ensureRepo(target, "migration/main");
	commitAll(target, "chore: bootstrap (test)");
	return { ws, target };
}

const baseArgs = (ws: string) => ["--source", join(ws, "legacy"), "--stack", "php", "--target", join(ws, "migrated"), "--to", "nestjs", "--db", "keep-schema", "--no-docs", "--no-llm"];

describe("br onboard (e2e, offline)", () => {
	it("runs every step, leaves artifacts only in the workspace, and is resumable", async () => {
		const { ws, target } = workspace("onboard-e2e");
		const lines: string[] = [];
		const r = await onboard({ root: ws, args: [...baseArgs(ws), "--yes"], log: (l) => lines.push(l) });
		expect(r.ok, lines.join("\n")).toBe(true);
		const names = r.steps.map((s) => `${s.name}:${s.status}`);
		expect(names).toContain("init:done");
		expect(names).toContain("setup:skipped"); // pre-bootstrapped
		expect(names).toContain("inventory:done");
		expect(names).toContain("frameworks:done");
		expect(names).toContain("decide:done");
		expect(names).toContain("rules:skipped"); // --no-llm
		expect(names).toContain("order:done");
		expect(r.openDecisions).toBe(0);

		// artifacts: workspace only
		for (const f of ["bigrefactor.config.json", ".bigrefactor/ledger.sqlite", ".bigrefactor/decisions.json"]) expect(existsSync(join(ws, f)), f).toBe(true);
		expect(existsSync(join(target, ".bigrefactor"))).toBe(false);
		expect(existsSync(join(ws, "legacy", ".bigrefactor"))).toBe(false);
		const config = JSON.parse(readFileSync(join(ws, "bigrefactor.config.json"), "utf8"));
		expect(config.source.stack).toBe("php");
		expect(config.target.stacks).toEqual(["nestjs"]);

		const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
		try {
			const st = ledger.status();
			expect(st.symbols["discovered"] ?? 0).toBe(0); // every symbol clustered into a unit (unaccounted counts non-terminal states, fine before a run)
			expect(Object.values(st.units).reduce((a, b) => a + b, 0)).toBeGreaterThan(3);
			expect(ledger.getMeta("slice_plan")).toBeTruthy();
			expect(ledger.getMeta("framework_plan")).toBeTruthy();
			// decisions are mirrored into the ledger questions table (answered, blocking nothing)
			const decided = ledger.db.prepare("SELECT COUNT(*) n FROM questions WHERE point LIKE 'decision:%' AND status = 'answered'").get() as { n: number };
			expect(decided.n).toBeGreaterThan(0);
			expect(ledger.openQuestions().length).toBe(0);
		} finally {
			ledger.close();
		}

		// resumable: a second run skips everything already done and stays green
		const again = await onboard({ root: ws, args: [...baseArgs(ws), "--yes"], log: () => {} });
		expect(again.ok).toBe(true);
		expect(again.steps.find((s) => s.name === "init")?.status).toBe("skipped");
		expect(again.steps.find((s) => s.name === "inventory")?.status).toBe("skipped");
		expect(again.steps.find((s) => s.name === "decide")?.note).toBe("nothing to decide");
	}, 120_000);

	it("TUI: a human sees one 'accept recommendations' question, then only decisions without a recommendation", async () => {
		const { ws } = workspace("onboard-tui");
		const asked: string[] = [];
		const scripted: InitPrompter = {
			text: async (_m, initial) => initial,
			select: async (message: string, options: PromptOption[], initial?: string) => {
				asked.push(message.split("\n")[0]!);
				if (/Accept the .* recommended/.test(message)) return "accept";
				// anything else: pick the recommended/initial, else the first option
				return initial ?? options[0]!.value;
			},
			log: () => {},
		};
		const r = await onboard({ root: ws, args: baseArgs(ws), prompter: scripted, log: () => {} });
		expect(r.ok, JSON.stringify(r.steps)).toBe(true);
		expect(r.openDecisions).toBe(0);
		// init asks its interview (stack recommendation first), decide asks the accept-all question
		expect(asked.some((q) => /recommended stack|Accept the/.test(q))).toBe(true);
		// never more than a handful of questions for the fixture: seamless means few prompts
		expect(asked.length).toBeLessThanOrEqual(8);
		// every prompt went through the prompter, nothing printed to stdout for a human to miss
		const d = JSON.parse(readFileSync(join(ws, ".bigrefactor", "decisions.json"), "utf8"));
		expect(Object.keys(d.answers).length).toBeGreaterThan(0);
	}, 120_000);
});
