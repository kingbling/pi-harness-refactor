import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { setupLogPath } from "../src/adapters/command-overrides.ts";
import { ConfigSchema } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { FakeModelClient } from "../src/models/fake.ts";
import { askStuckUnits, healQuarantined } from "../src/run/run.ts";

/**
 * Self-heal and the quarantine questions wake a unit only for a change that concerns it: another stack's fix does
 * not count, a stuck unit runs again only when the decide model says the fix touches its failure, and units share
 * a question only when their last failures match.
 */
function workspace(stacks = ["nestjs"]) {
	const root = mkdtempSync(join(tmpdir(), "br-heal-related-"));
	mkdirSync(join(root, ".bigrefactor"), { recursive: true });
	const raw = { version: 1, source: { path: join(root, "legacy"), stack: "php" }, target: { path: join(root, "new"), stacks }, models: {} };
	writeFileSync(join(root, "bigrefactor.config.json"), JSON.stringify(raw));
	const config = ConfigSchema.parse(raw);
	const ledger = new Ledger(join(root, ".bigrefactor", "ledger.sqlite"));
	/** A unit quarantined after a red gate step with this output. */
	const quarantined = (id: string, stack: string, output: string, reason = "gate still red after 5 attempts (lint_ok)") => {
		const file = `src/${id}.php`;
		ledger.upsertFile({ path: file, hash: "h", lang: "php", loc: 10 });
		ledger.upsertSymbol({ id: `${file}::f`, path: file, kind: "function", name: "f" });
		ledger.createUnit({ id, tier: "T0", symbolIds: [`${file}::f`], meta: { files: [file], place: { stack, area: "billing", shared: false, source: "code" } } });
		ledger.transitionUnit(id, "truth", "t");
		ledger.transitionUnit(id, "implementing", "t");
		const a = ledger.startAttempt(id, "implement", "m");
		ledger.endAttempt(a, { outcome: "gate_red:lint_ok", gateReport: { ok: false, failedStep: "lint_ok", steps: [{ name: "lint_ok", ok: false, output }], changedFiles: [] } });
		ledger.transitionUnit(id, "quarantined", reason);
	};
	/** A setup fix logged for a stack, a minute from now (later than any quarantine of the test). */
	const fixLogged = (stack: string, line: string) => {
		const f = setupLogPath(root, stack);
		mkdirSync(dirname(f), { recursive: true });
		const at = new Date(Date.now() + 60_000);
		appendFileSync(f, `${at.toISOString()} override ${line}\n`);
		utimesSync(f, at, at);
	};
	const manifests = new Map(stacks.map((s) => [s, { toolchain: { manifestFiles: [] as string[] } }]));
	return { root, config, ledger, quarantined, fixLogged, manifests };
}

describe("self-heal wakes only units a change concerns", () => {
	it("a fix in another stack is no change for a unit; a fix in its own stack is", async () => {
		const { root, config, ledger, quarantined, fixLogged, manifests } = workspace(["nestjs", "react"]);
		quarantined("U1", "nestjs", "lint: memory exhausted");
		const heal = () => healQuarantined(ledger, config, root, new Set(), () => {}, manifests);
		expect(await heal()).toEqual([]);
		fixLogged("react", "vite gets a new plugin");
		expect(await heal()).toEqual([]);
		expect(ledger.getUnit("U1")!.state).toBe("quarantined");
		fixLogged("nestjs", "lint gets more memory");
		expect(await heal()).toEqual(["U1"]);
		ledger.close();
	});

	it("a stuck unit runs again only when the decide model says the fix touches its failure, and is not asked twice about one change", async () => {
		const { root, config, ledger, quarantined, fixLogged, manifests } = workspace();
		quarantined("U1", "nestjs", "PHPStan: Allowed memory size of 134217728 bytes exhausted");
		ledger.updateUnit("U1", { meta: { stuck: true, autoHeals: 1 } });
		fixLogged("nestjs", "the router gets a catch-all route");
		let touches = false;
		const client = new FakeModelClient({ decide: (req) => ("touches" in req.questions ? { touches } : {}) });
		const asked = () => client.calls.filter((c) => c.kind === "decide" && "touches" in (c.req as { questions: object }).questions);
		const heal = (since: number) => healQuarantined(ledger, config, root, new Set(), () => {}, manifests, { since, client });
		const change = Date.now() + 1000;
		expect(await heal(change)).toEqual([]);
		expect(ledger.getUnit("U1")!.state).toBe("quarantined");
		const state = (asked()[0]!.req as { state: { changes: string; failure: string } }).state;
		expect(state.changes).toMatch(/setup fix: .*catch-all route/);
		expect(state.failure).toMatch(/memory size of 134217728 bytes exhausted/);
		// the same change: the model is not asked again
		expect(await heal(change)).toEqual([]);
		expect(asked()).toHaveLength(1);
		// a newer change the model says touches the failure: it runs again
		touches = true;
		expect(await heal(change + 5000)).toEqual(["U1"]);
		expect(asked()).toHaveLength(2);
		expect(ledger.getUnit("U1")!.state).toBe("planned");
		ledger.close();
	});
});

describe("quarantine questions", () => {
	it("share one question only when the last failures match, whatever the unit id; the facts show the failure", async () => {
		const { root, config, ledger, quarantined } = workspace();
		quarantined("U1", "nestjs", "src/Billing/U1.php: Class Invoice not found");
		quarantined("U2", "nestjs", "src/Billing/U2.php: Class Invoice not found");
		quarantined("U3", "nestjs", "phpstan: Allowed memory size exhausted");
		for (const id of ["U1", "U2", "U3"]) ledger.updateUnit(id, { meta: { stuck: true, autoHeals: 1 } });
		expect(await askStuckUnits({ ledger, config, root })).toBe(2);
		const qs = ledger.openQuestions();
		expect(qs).toHaveLength(2);
		const sameAs = qs.map((q) => JSON.parse(q.context!).sameAs as string);
		expect(sameAs[0]).not.toBe(sameAs[1]);
		const shared = qs.find((q) => q.unit_id === "U1")!;
		expect(shared.question).toMatch(/Class Invoice not found/);
		expect(shared.question).not.toMatch(/nothing changed/);
		expect([...ledger.blockedUnits().entries()].filter(([, q]) => q.includes(shared.id)).map(([u]) => u).sort()).toEqual(["U1", "U2"]);
		ledger.close();
	});

	it("the owner's earlier answers on quarantine questions go to the phrasing model", async () => {
		const { root, config, ledger, quarantined } = workspace();
		const prompts: string[] = [];
		const client = new FakeModelClient({ chat: (req) => (prompts.push(req.messages.map((m) => m.content).join("\n")), undefined) });
		quarantined("U1", "nestjs", "Class Invoice not found");
		ledger.updateUnit("U1", { meta: { stuck: true, autoHeals: 1 } });
		await askStuckUnits({ ledger, config, root, client });
		expect(prompts.at(-1)).not.toContain("Owner's earlier answers");
		ledger.answerQuestion(ledger.openQuestions()[0]!.id, "retry — try again");
		quarantined("U2", "nestjs", "phpstan: Allowed memory size exhausted");
		ledger.updateUnit("U2", { meta: { stuck: true, autoHeals: 1 } });
		await askStuckUnits({ ledger, config, root, client });
		expect(prompts.at(-1)).toMatch(/Owner's earlier answers:\n- U1 was quarantined[^\n]*Class Invoice not found[^\n]*→ retry — try again/);
		ledger.close();
	});
});
