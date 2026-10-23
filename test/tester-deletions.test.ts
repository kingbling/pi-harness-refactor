import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nestjsAdapter } from "../src/adapters/target/nestjs.ts";
import { ConfigSchema, type Config } from "../src/config.ts";
import { Ledger } from "../src/ledger/db.ts";
import { antigamingCheck, gateFiles, type GateInput, type GateReport } from "../src/run/gate.ts";
import { runUnit } from "../src/run/unit.ts";
import type { LeafSession, SpawnOptions } from "../src/sessions/spawn.ts";

vi.mock("../src/adapters/registry.ts", async (original) => ({
	...await original<typeof import("../src/adapters/registry.ts")>(),
	getTargetAdapter: async () => adapter,
}));

const adapter = { ...nestjsAdapter, layout: { ...nestjsAdapter.layout, testFileGlobs: (dir: string) => [...nestjsAdapter.layout.testFileGlobs(dir), "tests/agency/**/*.spec.ts"] } };
const old = "tests/agency/old.spec.ts", renamed = "tests/agency/renamed.spec.ts";
const own = "src/features/agency/agency.service.spec.ts";
const ok = { toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } };
let root: string, target: string, ledger: Ledger, config: Config;
const write = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "br-tester-deletions-")); target = join(root, "target");
	write(join(root, "legacy/app/agency/create.cmd.php"), "<?php\n");
	config = ConfigSchema.parse({ source: { path: join(root, "legacy"), stack: "php" }, target: { path: target, stacks: ["nestjs"] }, models: {} });
	write(join(target, "package.json"), "{}");
	write(join(target, own), "it('u1#1', () => {});\n");
	write(join(target, old), "it('u0#1 accepted old behavior', () => {});\n");
	execFileSync("git", ["init", "-q"], { cwd: target });
	execFileSync("git", ["add", "-A"], { cwd: target });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "baseline"], { cwd: target });
	ledger = new Ledger(":memory:");
	ledger.createUnit({ id: "u1", tier: "T1", symbolIds: [], meta: { files: ["app/agency/create.cmd.php"], place: { stack: "nestjs", area: "agency", shared: false, source: "code" } } });
	ledger.addEvidence("u1", "truth_read", {});
	ledger.db.prepare("INSERT INTO truth_cases(id,unit_id,symbol_id,inputs,expected,verified_on_old,created_at) VALUES ('u1#1','u1','s','[]','1',0,'t')").run();
	write(join(root, ".bigrefactor/legacy-env.json"), JSON.stringify({ root: config.source.path, mode: "read" }));
	write(join(root, ".bigrefactor/truth/u1/cases.json"), JSON.stringify([{ symbol: "s", inputs: [], expected: 1 }]));
	write(join(root, ".bigrefactor/truth/u1/interface.md"), "src/features/agency/agency.service.ts exports AgencyService\n");
});
afterEach(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });

describe("the tester's deletion hand-over", () => {
	const run = async (approved: boolean) => {
		if (approved) ledger.setMeta("tests_disputed:u1", JSON.stringify([old]));
		const seen: Array<{ removed: string[]; files: string[]; ok: boolean; output: string }> = [];
		const spawn = async (o: SpawnOptions) => ({ run: async () => {
			if (o.role === "test") { rmSync(join(target, old), { force: true }); write(join(target, renamed), "it('u0#1 accepted old behavior', () => {});\n"); }
			else write(join(target, "src/features/agency/agency.service.ts"), "export class AgencyService {}\n");
			return { text: o.role === "test" ? "TESTER DONE" : "IMPLEMENTER DONE", ...ok };
		}, dispose() {} }) as unknown as LeafSession;
		const gate = async (g: GateInput): Promise<GateReport> => {
			const check = await antigamingCheck(g, await gateFiles(g), true);
			seen.push({ removed: [...g.removedTests ?? []], files: g.testFiles.map((f) => f.path), ...check });
			return { ok: true, steps: [], changedFiles: [], testFiles: g.testFiles.map((f) => f.path) };
		};
		await runUnit({ ledger, config, root, unitId: "u1", reuseTruth: true, retryNote: "For the tester: rename the disputed obsolete test and preserve its behavior", spawn: spawn as never, gate, log: () => {} });
		return seen;
	};

	it("hands the approved old path to the real anti-gaming check as absent, and the replacement as hashed", async () => {
		const seen = await run(true);
		expect(seen.length).toBeGreaterThan(0);
		expect(seen[0]).toMatchObject({ removed: [old], ok: true });
		expect(seen[0]!.files).toContain(renamed);
		expect(seen[0]!.files).not.toContain(old);
		expect(existsSync(join(target, old))).toBe(false);
	});

	it("puts back another unit's unsanctioned test deletion instead of handing it over as authorized", async () => {
		const seen = await run(false);
		expect(seen[0]!.removed).toEqual([]);
		expect(readFileSync(join(target, old), "utf8")).toContain("u0#1 accepted old behavior");
	});
});
