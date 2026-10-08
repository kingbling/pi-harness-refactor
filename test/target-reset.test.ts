import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { resetForNewTarget } from "../src/run/target-reset.ts";

/**
 * The owner deleted the target project and set it up again but kept the workspace: the units accepted into the
 * old project have no code any more, and answers about the old project's files must not steer the new run.
 */
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
function commit(repo: string, file: string): string {
	writeFileSync(join(repo, file), "x\n");
	git(repo, "add", "-A");
	git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", file);
	return git(repo, "rev-parse", "HEAD");
}

function workspace() {
	const ws = mkdtempSync(join(tmpdir(), "br-reset-"));
	const repo = join(ws, "migrated");
	execFileSync("mkdir", ["-p", repo]);
	git(repo, "init", "-q", "-b", "main");
	commit(repo, "bootstrap.txt");
	const sha = commit(repo, "unit.txt");
	const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: repo, stacks: ["symfony"] }, models: {} });
	const ledger = new Ledger(":memory:");
	ledger.createUnit({ id: "U1", tier: "T1", symbolIds: [], meta: { files: ["a.php"], commit: sha } });
	ledger.createUnit({ id: "U2", tier: "T1", symbolIds: [], meta: { files: ["b.php"] } });
	ledger.createUnit({ id: "U3", tier: "T1", symbolIds: [], meta: { files: ["c.php"] } });
	ledger.db.prepare("UPDATE units SET state = 'accepted' WHERE id = 'U1'").run();
	ledger.transitionUnit("U2", "quarantined", "gate failed");
	const sample = ledger.askQuestion({ point: "layout_sample", question: "continue?", options: ["approve", "stop"], blocks: "none", askedBy: "orchestrator" });
	ledger.answerQuestion(sample, "stop", "human");
	ledger.setMeta("layout_sample", JSON.stringify({ question: sample }));
	const place = ledger.askQuestion({ unitId: "U3", point: "placement", question: "where?", options: ["a", "b"], blocks: "unit", askedBy: "placement" });
	ledger.answerQuestion(place, "a", "human");
	return { ws, repo, config, ledger, sample, place };
}

describe("a target project created anew", () => {
	it("puts the units worked on back to planned, drops the old project's answers, keeps the legacy-side ones", () => {
		const { ws, repo, config, ledger, sample, place } = workspace();
		rmSync(join(repo, ".git"), { recursive: true, force: true });
		git(repo, "init", "-q", "-b", "main");
		commit(repo, "bootstrap.txt");
		expect(resetForNewTarget(ledger, config, ws)?.sort()).toEqual(["U1", "U2"]);
		expect(ledger.getUnit("U1")!.state).toBe("planned");
		expect(JSON.parse(ledger.getUnit("U1")!.meta).commit).toBeUndefined();
		expect(ledger.getUnit("U2")!.state).toBe("planned");
		expect(ledger.getQuestion(sample)!.status).toBe("withdrawn");
		expect(ledger.getQuestion(sample)!.answer).toMatch(/^stop — withdrawn/);
		expect(ledger.getQuestion(place)!.status).toBe("answered");
		expect(ledger.getMeta("layout_sample")).toBe("{}");
		// nothing left to reset on the next start
		expect(resetForNewTarget(ledger, config, ws)).toBeUndefined();
	});
	it("does nothing while the accepted code is still in the project", () => {
		const { ws, config, ledger, sample } = workspace();
		expect(resetForNewTarget(ledger, config, ws)).toBeUndefined();
		expect(ledger.getUnit("U1")!.state).toBe("accepted");
		expect(ledger.getUnit("U2")!.state).toBe("quarantined");
		expect(ledger.getQuestion(sample)!.status).toBe("answered");
	});
});
