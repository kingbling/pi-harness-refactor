import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SourceAdapter } from "../src/adapters/types.ts";
import { ConfigSchema } from "../src/config.ts";
import { describeTruthRun, fixLegacyEnv, legacyCopyTool, legacyRunTool, loadLegacyEnv, MAX_LEGACY_FIXES_PER_PROBLEM, notFromOldCode, probeLegacyEnv, verifyTruthOnOld, type LegacyFixer } from "../src/run/legacy-env.ts";

/**
 * The old code runs for truth in its own environment: when its packages are missing, the setup model makes a
 * workspace copy (the legacy repo stays untouched) and installs them there; code re-runs the failed script.
 */
function workspace() {
	const root = mkdtempSync(join(tmpdir(), "br-legacy-"));
	const legacy = join(root, "legacy");
	mkdirSync(legacy, { recursive: true });
	writeFileSync(join(legacy, "app.sh"), "cat deps/lib.json\n"); // needs a dependency that was never installed
	const truthDir = join(root, ".bigrefactor", "truth", "U1");
	mkdirSync(truthDir, { recursive: true });
	writeFileSync(join(truthDir, "cases.sh"), "sh app.sh\n");
	const config = ConfigSchema.parse({ source: { path: legacy, stack: "php" }, target: { path: join(root, "new"), stacks: ["nestjs"] }, models: {} });
	const source = { id: "shell", truth: { scriptName: "cases.sh", run: (_r: string, s: string) => ({ cmd: "sh", args: [s] }), instructions: "" } } as unknown as SourceAdapter;
	return { root, legacy, truthDir, config, source };
}
const call = (t: unknown, p: object) => (t as { execute: (id: string, p: object) => Promise<{ content: Array<{ text: string }> }> }).execute("x", p);

describe("the old code's environment", () => {
	it("is the legacy repo until the setup model makes a copy; the copy gets the dependencies, the repo stays read-only", async () => {
		const { root, legacy, truthDir, config, source } = workspace();
		expect(verifyTruthOnOld(truthDir, config, source, root).ok).toBe(false);
		const fixer: LegacyFixer = async (o) => {
			await call(legacyCopyTool(o.root, o.config), { why: "packages were never installed" });
			const copy = loadLegacyEnv(o.root, o.config).root;
			mkdirSync(join(copy, "deps"), { recursive: true });
			writeFileSync(join(copy, "deps", "lib.json"), '[{"symbol":"app.sh::run","inputs":[],"expected":1}]');
			return "installed the dependencies in a copy";
		};
		const fixed = await fixLegacyEnv({ config, root, source, problem: "cat: deps/lib.json: No such file", truthDir, signature: "truth: missing deps", fixer });
		expect(fixed).toBe("installed the dependencies in a copy");
		expect(verifyTruthOnOld(truthDir, config, source, root)).toMatchObject({ ok: true, cases: [{ symbol: "app.sh::run" }] });
		expect(existsSync(join(legacy, "deps"))).toBe(false);
		expect(describeTruthRun(root, config, source, "/t/cases.sh")).toBe(`cd ${loadLegacyEnv(root, config).root} && sh /t/cases.sh`);
		expect(readFileSync(join(root, ".bigrefactor", "legacy-env.log"), "utf8")).toMatch(/installed the dependencies/);
	});

	it("a session after which the script still fails is no fix, and one problem gets only so many tries", async () => {
		const { root, truthDir, config, source } = workspace();
		let calls = 0;
		const nothing: LegacyFixer = async () => (calls++, "looked around");
		for (let i = 0; i < MAX_LEGACY_FIXES_PER_PROBLEM + 1; i++) expect(await fixLegacyEnv({ config, root, source, problem: "x", truthDir, signature: "truth: same", fixer: nothing })).toBeUndefined();
		expect(calls).toBe(MAX_LEGACY_FIXES_PER_PROBLEM);
		// the next run (its own config) gets its own tries
		const next = { ...config };
		expect(await fixLegacyEnv({ config: next, root, source, problem: "x", truthDir, signature: "truth: same", fixer: nothing })).toBeUndefined();
		expect(calls).toBe(MAX_LEGACY_FIXES_PER_PROBLEM + 1);
	});

	it("the cases are the JSON array printed last; notices with a [ before it do not hide them", () => {
		const { root, legacy, truthDir, config, source } = workspace();
		writeFileSync(join(legacy, "app.sh"), `echo "Notice: [deprecated] something"\necho '[{"symbol":"a::b",'\necho ' "inputs":[],"expected":1}]'\n`);
		expect(verifyTruthOnOld(truthDir, config, source, root)).toMatchObject({ ok: true, cases: [{ symbol: "a::b" }] });
		writeFileSync(join(legacy, "app.sh"), `echo "Warning: [x] could not connect"\n`);
		expect(verifyTruthOnOld(truthDir, config, source, root).error).toMatch(/could not connect/);
	});

	it("the run command can change, but must run the script", async () => {
		const { root, config, source } = workspace();
		expect((await call(legacyRunTool(root, config), { cmd: "true", args: [], why: "cheat" })).content[0]!.text).toMatch(/refused/);
		await call(legacyRunTool(root, config), { cmd: "sh", args: ["-e", "{script}"], why: "stop on the first error" });
		expect(describeTruthRun(root, config, source, "/t/cases.sh")).toBe(`cd ${config.source.path} && sh -e /t/cases.sh`);
	});

	it("truth the old code did not produce is rejected: no legacy file loaded, or the results typed into the script", () => {
		const files = ["app/model/offer.php"];
		expect(notFromOldCode("<?php echo json_encode([]);", [], files)).toMatch(/loads none/);
		const typed = "<?php require 'app/model/offer.php'; class Fake { function get() { return 123.45; } } echo json_encode([['symbol'=>'x','inputs'=>null,'expected'=>123.45]]);";
		expect(notFromOldCode(typed, [{ symbol: "x", inputs: null, expected: 123.45 }], files)).toMatch(/written into the script/);
		const real = "<?php require 'app/model/offer.php'; $o = new Offer('Acme Ltd'); echo json_encode([['symbol'=>'x','inputs'=>['Acme Ltd'],'expected'=>[$o->name(), $o->net()]]]);";
		expect(notFromOldCode(real, [{ symbol: "x", inputs: ["Acme Ltd"], expected: ["Acme Ltd", 84.03] }], files)).toBeUndefined();
	});

	it("a script loading the unit by module or class name (Python, Java, Ruby, Go) loads the legacy file", () => {
		const loads = (script: string, file: string) => notFromOldCode(script, [], [file]) === undefined;
		expect(loads("from billing.models import Invoice\nprint(json.dumps([]))", "billing/models.py")).toBe(true);
		expect(loads("from billing import models", "billing/models.py")).toBe(true);
		expect(loads("import com.acme.billing.Invoice;", "src/main/java/com/acme/billing/Invoice.java")).toBe(true);
		expect(loads("require_relative 'app/models/invoice'", "app/models/invoice.rb")).toBe(true);
		expect(loads('import "example.com/shop/internal/billing"', "internal/billing/invoice.go")).toBe(true);
		// still rejected: a script that names none of them
		expect(loads("import json\nprint(json.dumps([]))", "billing/models.py")).toBe(false);
		expect(loads("from billing.models_old import X", "billing/models.py")).toBe(false);
	});

	it("whether the old code runs is decided once per workspace by a probe the setup model writes", async () => {
		const { root, config, source } = workspace();
		let calls = 0;
		const green: LegacyFixer = async (o) => (calls++, writeFileSync(o.script, "echo '[{\"symbol\":\"probe\",\"inputs\":null,\"expected\":\"ok\"}]'\n"), "it runs");
		expect(await probeLegacyEnv({ config, root, source, fixer: green, log: () => {} })).toBe("run");
		expect(await probeLegacyEnv({ config, root, source, fixer: green, log: () => {} })).toBe("run");
		expect(calls).toBe(1);
		const other = workspace();
		expect(await probeLegacyEnv({ ...other, fixer: async () => "no php on this machine", log: () => {} })).toBe("read");
		expect(loadLegacyEnv(other.root, other.config).mode).toBe("read");
	});

	it("the probe asks for single units with whatever this machine has; red asks the owner once, and retry probes again", async () => {
		const { root, config, source } = workspace();
		const problems: string[] = [];
		const asked: Array<{ facts: string; recommended: string }> = [];
		const answers = new Map<number, string>();
		const red: LegacyFixer = async (o) => (problems.push(o.problem), "docker is not installed");
		const opts = { config, root, source, log: () => {}, ask: async (q: { facts: string; recommended: string }) => (asked.push(q), 41), answer: (id: number) => answers.get(id) };
		expect(await probeLegacyEnv({ ...opts, fixer: red })).toBe("read");
		expect(problems[0]).toMatch(/single units of the old code can be loaded and called with what this machine has/);
		expect(problems[0]).not.toMatch(/cannot run on this machine, say why and stop/);
		expect(asked).toHaveLength(1);
		expect(asked[0]!.facts).toMatch(/docker is not installed/);
		// unanswered (or "read"): decided, nobody probes or asks again
		expect(await probeLegacyEnv({ ...opts, fixer: red })).toBe("read");
		expect(problems).toHaveLength(1);
		expect(asked).toHaveLength(1);
		// the owner installed something: the next run probes again
		answers.set(41, "retry");
		const green: LegacyFixer = async (o) => (writeFileSync(o.script, "echo '[{\"symbol\":\"probe\",\"inputs\":null,\"expected\":\"ok\"}]'\n"), "plain php loads the class");
		expect(await probeLegacyEnv({ ...opts, fixer: green })).toBe("run");
		expect(loadLegacyEnv(root, config).probeQuestion).toBeUndefined();
	});
});

describe("truth that changes from run to run", () => {
	it("an expected value that differs between two runs of the old code is refused, with the case and what to do", () => {
		const { root, legacy, truthDir, config, source } = workspace();
		// a counter file stands in for a clock: each run prints a different created_at
		writeFileSync(join(legacy, "app.sh"), `n=$(cat n 2>/dev/null || echo 0); n=$((n+1)); echo $n > n\necho '[{"symbol":"a::b","inputs":[],"expected":{"total":5,"created_at":'$n'}}]'\n`);
		const r = verifyTruthOnOld(truthDir, config, source, root);
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/differ between two runs[\s\S]*case #1\.created_at: \d+ then \d+[\s\S]*fixed input/);
		expect(r.error).not.toMatch(/total/);
		writeFileSync(join(legacy, "app.sh"), `echo '[{"symbol":"a::b","inputs":[],"expected":{"total":5}}]'\n`);
		expect(verifyTruthOnOld(truthDir, config, source, root).ok).toBe(true);
	});
});
