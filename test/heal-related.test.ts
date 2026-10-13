import { appendFileSync, mkdirSync, readFileSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { setupLogPath } from "../src/adapters/command-overrides.ts";
import { ConfigSchema } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { FakeModelClient } from "../src/models/fake.ts";
import { ownerAnswersOn } from "../src/jev/ask.ts";
import { errorSignature } from "../src/run/gate.ts";
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
		expect(state.changes).toMatch(/fix: .*catch-all route/);
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

	it("the decide model unavailable: the unit stays as it is this pass, it is not made stuck", async () => {
		const { root, config, ledger, quarantined, fixLogged, manifests } = workspace();
		quarantined("U1", "nestjs", "src/Billing/U1.php: Class Invoice not found");
		// it failed the same way once before: with the change counted as none, it would be stuck at once
		ledger.updateUnit("U1", { meta: { autoHeals: 1, healedFrom: errorSignature("quarantine", "gate still red after 5 attempts (lint_ok)") } });
		fixLogged("nestjs", "phpunit runs each test in isolation");
		let down = true;
		const client = new FakeModelClient({ decide: () => (down ? (() => { throw new Error("provider down"); })() : { touches: true }) });
		const heal = (since: number) => healQuarantined(ledger, config, root, new Set(), () => {}, manifests, { since, client });
		const change = Date.now() + 1000;
		expect(await heal(change)).toEqual([]);
		const meta = JSON.parse(ledger.getUnit("U1")!.meta);
		expect([meta.stuck, meta.healChecked]).toEqual([undefined, undefined]);
		// the model is back next pass: it is asked about the same change
		down = false;
		expect(await heal(change)).toEqual(["U1"]);
		ledger.close();
	});
});

describe("self-heal asks about every change and keeps the unit's code", () => {
	it("a unit not yet stuck also runs again on a change only when the decide model says it touches its own failure", async () => {
		const { root, config, ledger, quarantined, fixLogged, manifests } = workspace();
		quarantined("U1", "nestjs", "src/Billing/U1.php: Class Invoice not found");
		fixLogged("nestjs", "phpunit runs each test in isolation");
		let touches = false;
		const client = new FakeModelClient({ decide: (req) => ("touches" in req.questions ? { touches } : {}) });
		const asked = () => client.calls.filter((c) => c.kind === "decide" && "touches" in (c.req as { questions: object }).questions);
		const heal = (since: number) => healQuarantined(ledger, config, root, new Set(), () => {}, manifests, { since, client });
		const change = Date.now() + 1000;
		expect(await heal(change)).toEqual([]);
		expect((asked()[0]!.req as { state: { failure: string } }).state.failure).toMatch(/Class Invoice not found/);
		expect(ledger.getUnit("U1")!.state).toBe("quarantined");
		touches = true;
		expect(await heal(change + 5000)).toEqual(["U1"]);
		ledger.close();
	});

	it("a self-heal requeue keeps the unit's code and the next start puts it on current main; an owner's requeue drops it", async () => {
		const { root, config, ledger } = workspace();
		const { keepUnitWork, requeueUnits, restoreKeptWork } = await import("../src/run/run.ts");
		const { addWorktree } = await import("../src/git.ts");
		const { execFileSync } = await import("node:child_process");
		const repo = config.target.path;
		const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
		mkdirSync(repo, { recursive: true });
		git(repo, "init", "-q", "-b", "main");
		writeFileSync(join(repo, "a.txt"), "a\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-q", "-m", "init");
		for (const id of ["U1", "U2"]) {
			ledger.createUnit({ id, tier: "T0", symbolIds: [], meta: {} });
			ledger.transitionUnit(id, "truth", "t");
			ledger.transitionUnit(id, "quarantined", "gate still red after 5 attempts (wired_ok)");
			const wt = join(root, "wt", id);
			addWorktree(repo, wt, `unit/${id}`);
			writeFileSync(join(wt, `${id}.txt`), "code\n");
			ledger.updateUnit(id, { meta: { keptWork: keepUnitWork(wt, id), reviewFindings: [`- ${id}.txt:1: stub → port it`] } });
			git(repo, "worktree", "remove", "--force", wt);
		}
		requeueUnits(ledger, config, root, ["U1"], "self-heal", { keepCode: true });
		requeueUnits(ledger, config, root, ["U2"], "owner", { human: true });
		const kept = JSON.parse(ledger.getUnit("U1")!.meta).keptWork as string;
		expect(kept).toBeTruthy();
		expect(git(repo, "branch", "--list", "unit/*")).toBe("unit/U1");
		// the owner's requeue drops the code, and with it the reviewer's findings about that code
		expect(JSON.parse(ledger.getUnit("U2")!.meta)).not.toHaveProperty("keptWork");
		expect(JSON.parse(ledger.getUnit("U2")!.meta)).not.toHaveProperty("reviewFindings");
		// main moved on meanwhile: the code comes back on top of it, uncommitted as it was
		writeFileSync(join(repo, "b.txt"), "b\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-q", "-m", "another unit");
		const wt = join(root, "wt", "U1-again");
		addWorktree(repo, wt, "unit/U1");
		expect(restoreKeptWork(ledger, wt, "U1")).toEqual([]);
		expect(git(wt, "status", "--porcelain")).toBe("?? U1.txt");
		// the kept code is used once; the findings about it stay with it
		expect(JSON.parse(ledger.getUnit("U1")!.meta)).not.toHaveProperty("keptWork");
		expect(JSON.parse(ledger.getUnit("U1")!.meta).reviewFindings).toEqual(["- U1.txt:1: stub → port it"]);
		expect(git(wt, "ls-files")).toContain("b.txt");
		// main wrote the same file another way: the code comes back with both sides in that file, the findings stay
		writeFileSync(join(repo, "U1.txt"), "other\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-q", "-m", "clash");
		const wt2 = join(root, "wt", "U1-clash");
		addWorktree(repo, wt2, "unit/U1-clash");
		ledger.updateUnit("U1", { meta: { keptWork: kept } });
		expect(restoreKeptWork(ledger, wt2, "U1")).toEqual(["U1.txt"]);
		expect(readFileSync(join(wt2, "U1.txt"), "utf8")).toMatch(/<<<<<<< HEAD\nother\n=======\ncode\n>>>>>>> /);
		expect(JSON.parse(ledger.getUnit("U1")!.meta).reviewFindings).toEqual(["- U1.txt:1: stub → port it"]);
		// a kept commit that is gone cannot be put back: the unit starts clean, without the findings about it
		const wt3 = join(root, "wt", "U1-gone");
		addWorktree(repo, wt3, "unit/U1-gone");
		ledger.updateUnit("U1", { meta: { keptWork: "0".repeat(40) } });
		expect(restoreKeptWork(ledger, wt3, "U1")).toBeUndefined();
		expect(git(wt3, "status", "--porcelain")).toBe("");
		expect(JSON.parse(ledger.getUnit("U1")!.meta)).not.toHaveProperty("reviewFindings");
		ledger.close();
	});
});

describe("the code a quarantined unit keeps", () => {
	it("is not kept when its last gate failed antigaming_ok: the same files would fail it again", async () => {
		const { ledger, quarantined } = workspace();
		const { mayKeepCode } = await import("../src/run/run.ts");
		quarantined("U1", "nestjs", "lint: 2 errors");
		expect(mayKeepCode(ledger, "U1")).toBe(true);
		const a = ledger.startAttempt("U1", "implement", "m");
		ledger.endAttempt(a, { outcome: "gate_red:antigaming_ok", gateReport: { ok: false, failedStep: "antigaming_ok", steps: [] } });
		// a review after it is no gate outcome: the gate's antigaming_ok still decides
		ledger.endAttempt(ledger.startAttempt("U1", "review", "m"), { outcome: "review_red" });
		expect(mayKeepCode(ledger, "U1")).toBe(false);
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

	it("only the owner's earlier answers on the same failure go to the phrasing model, each with what happened after it", async () => {
		const { root, config, ledger, quarantined } = workspace();
		const prompts: string[] = [];
		const client = new FakeModelClient({ chat: (req) => (prompts.push(req.messages.map((m) => m.content).join("\n")), undefined) });
		quarantined("U1", "nestjs", "Class Invoice not found");
		ledger.updateUnit("U1", { meta: { stuck: true, autoHeals: 1 } });
		await askStuckUnits({ ledger, config, root, client });
		expect(prompts.at(-1)).not.toContain("Owner's earlier answers");
		const first = ledger.openQuestions()[0]!;
		ledger.answerQuestion(first.id, "retry — try again");
		// another failure: the answer on U1 says nothing about it
		quarantined("U2", "nestjs", "phpstan: Allowed memory size exhausted");
		ledger.updateUnit("U2", { meta: { stuck: true, autoHeals: 1 } });
		await askStuckUnits({ ledger, config, root, client });
		expect(prompts.at(-1)).not.toContain("Owner's earlier answers");
		// U1 ran again and failed the same way (asked and answered by the resolver); U3 now fails like U1 did
		ledger.answerQuestion(ledger.askQuestion({ unitId: "U1", point: "quarantine", question: "again", context: JSON.parse(first.context!), askedBy: "orchestrator" }), "leave", "resolver model");
		quarantined("U3", "nestjs", "Class Invoice not found");
		ledger.updateUnit("U3", { meta: { stuck: true, autoHeals: 1 } });
		await askStuckUnits({ ledger, config, root, client });
		expect(prompts.at(-1)).toMatch(/Owner's earlier answers:\n- U1 was quarantined[^\n]*Class Invoice not found[^\n]*→ retry — try again → after it: failed the same way again/);
		expect(prompts.at(-1)).toMatch(/a retry that failed the same way again counts against a plain retry/);
		ledger.close();
	});

	it("an earlier answer whose unit passed afterwards says so", async () => {
		const { root, config, ledger, quarantined } = workspace();
		quarantined("U1", "nestjs", "Class Invoice not found");
		ledger.updateUnit("U1", { meta: { stuck: true, autoHeals: 1 } });
		await askStuckUnits({ ledger, config, root });
		const q = ledger.openQuestions()[0]!;
		ledger.answerQuestion(q.id, "retry — try again");
		const sameAs = JSON.parse(q.context!).sameAs as string;
		ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = 'U1'").run();
		expect(ownerAnswersOn(ledger, "quarantine", sameAs)).toMatch(/→ retry — try again → after it: the unit then passed$/);
		expect(ownerAnswersOn(ledger, "quarantine", "quarantine: something else")).toBe("");
		ledger.close();
	});
});
