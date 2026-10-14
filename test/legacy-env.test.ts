import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { SourceAdapter } from "../src/adapters/types.ts";
import { ConfigSchema } from "../src/config.ts";
import { describeTruthRun, fixLegacyEnv, legacyCopyTool, legacyEnvOutage, legacyRunTool, loadLegacyEnv, MAX_LEGACY_FIXES_PER_PROBLEM, notFromOldCode, probeLegacyEnv, verifyTruthOnOld, type LegacyFixer } from "../src/run/legacy-env.ts";

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
		expect((await verifyTruthOnOld(truthDir, config, source, root)).ok).toBe(false);
		const fixer: LegacyFixer = async (o) => {
			await call(legacyCopyTool(o.root, o.config), { why: "packages were never installed" });
			const copy = loadLegacyEnv(o.root, o.config).root;
			mkdirSync(join(copy, "deps"), { recursive: true });
			writeFileSync(join(copy, "deps", "lib.json"), '[{"symbol":"app.sh::run","inputs":[],"expected":1}]');
			return "installed the dependencies in a copy";
		};
		const fixed = await fixLegacyEnv({ config, root, source, problem: "cat: deps/lib.json: No such file", truthDir, signature: "truth: missing deps", fixer });
		expect(fixed).toBe("installed the dependencies in a copy");
		expect(await verifyTruthOnOld(truthDir, config, source, root)).toMatchObject({ ok: true, cases: [{ symbol: "app.sh::run" }] });
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

	it("the cases are the JSON array printed last; notices with a [ before it do not hide them", async () => {
		const { root, legacy, truthDir, config, source } = workspace();
		writeFileSync(join(legacy, "app.sh"), `echo "Notice: [deprecated] something"\necho '[{"symbol":"a::b",'\necho ' "inputs":[],"expected":1}]'\n`);
		expect(await verifyTruthOnOld(truthDir, config, source, root)).toMatchObject({ ok: true, cases: [{ symbol: "a::b" }] });
		writeFileSync(join(legacy, "app.sh"), `echo "Warning: [x] could not connect"\n`);
		expect((await verifyTruthOnOld(truthDir, config, source, root)).error).toMatch(/could not connect/);
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

	it("a value that is only part of a longer name in the script is not typed in; a quoted literal of its own is", () => {
		const files = ["app/commands/status.php"];
		const real = "<?php require 'app/commands/status.php'; $c = new StatusUnconfirmedCampaignCommand(); echo json_encode([['symbol'=>'x','inputs'=>null,'expected'=>$c->get_name()]]);";
		expect(notFromOldCode(real, [{ symbol: "x", inputs: null, expected: "Unconfirm" }], files)).toBeUndefined();
		const typed = "<?php require 'app/commands/status.php'; echo json_encode([['symbol'=>'x','inputs'=>null,'expected'=>'Unconfirm']]);";
		expect(notFromOldCode(typed, [{ symbol: "x", inputs: null, expected: "Unconfirm" }], files)).toMatch(/written into the script/);
		// a number inside a longer one is not typed in either
		expect(notFromOldCode("<?php require 'app/commands/status.php'; $x = 123456;", [{ symbol: "x", inputs: null, expected: 2345 }], files)).toBeUndefined();
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

	it("a probe that runs but prints the wrong shape gets code's own error back once, and is green when fixed", async () => {
		const { root, config, source } = workspace();
		const problems: string[] = [];
		const fixer: LegacyFixer = async (o) => {
			problems.push(o.problem);
			writeFileSync(o.script, problems.length === 1 ? "echo '[{\"id\":\"probe\",\"result\":\"1.23 M\"}]'\n" : "echo '[{\"symbol\":\"probe\",\"inputs\":[1234567],\"expected\":\"1.23 M\"}]'\n");
			return "it runs";
		};
		expect(await probeLegacyEnv({ config, root, source, fixer, log: () => {} })).toBe("run");
		expect(problems[0]).toMatch(/exactly this shape: \[\{"symbol": "probe"/);
		expect(problems[1]).toMatch(/refused it:[\s\S]*without a symbol id/);
	});

	it("a run command that reaches the probe but not the units' truth folders is refused", async () => {
		const { root, config, source } = workspace();
		const probeDir = join(root, ".bigrefactor", "legacy-env", "probe");
		mkdirSync(probeDir, { recursive: true });
		writeFileSync(join(probeDir, "cases.sh"), "echo '[]'\n");
		const tool = legacyRunTool(root, config, source);
		// like a container that mounts only the legacy-env folder
		const onlyProbe = { cmd: "sh", args: ["-c", 'case "$0" in */legacy-env/*) sh "$0";; *) echo "Could not open input file: $0" >&2; exit 1;; esac', "{script}"], why: "docker" };
		expect((await call(tool, onlyProbe)).content[0]!.text).toMatch(/^refused: the probe runs from[\s\S]*truth folders[\s\S]*Could not open input file/);
		expect(loadLegacyEnv(root, config).run).toBeUndefined();
		expect((await call(tool, { cmd: "sh", args: ["{script}"], why: "plain sh" })).content[0]!.text).toMatch(/^truth scripts run with/);
		expect(readdirSync(join(root, ".bigrefactor", "truth")).filter((n) => n.startsWith("__runcheck__"))).toEqual([]);
	});

	it("a saved run command that reaches the probe but no truth script is probed again (once per command), even with the owner's question open", async () => {
		const { root, config, source } = workspace();
		const probeDir = join(root, ".bigrefactor", "legacy-env", "probe");
		mkdirSync(probeDir, { recursive: true });
		writeFileSync(join(probeDir, "cases.sh"), `echo '[{"symbol":"probe","inputs":[],"expected":1}]'\n`);
		const onlyProbe = { cmd: "sh", args: ["-c", 'case "$0" in */legacy-env/*) sh "$0";; *) echo "Could not open input file: $0" >&2; exit 1;; esac', "{script}"] };
		writeFileSync(join(root, ".bigrefactor", "legacy-env.json"), JSON.stringify({ root: config.source.path, mode: "read", probeQuestion: 7, run: onlyProbe }));
		const problems: string[] = [];
		const stuck: LegacyFixer = async (o) => (problems.push(o.problem), "could not change it");
		const opts = { config, root, source, log: () => {}, answer: () => undefined };
		expect(await probeLegacyEnv({ ...opts, fixer: stuck })).toBe("read");
		expect(problems[0]).toMatch(/runs the probe but no unit's truth script[\s\S]*Could not open input file/);
		// the same command: not probed again
		expect(await probeLegacyEnv({ ...opts, fixer: stuck })).toBe("read");
		expect(problems).toHaveLength(1);
		// a new command (set by a unit's setup fix, say) that also fails is checked again; this fixer sets one that reaches both
		writeFileSync(join(root, ".bigrefactor", "legacy-env.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(root, ".bigrefactor", "legacy-env.json"), "utf8")), run: { ...onlyProbe, args: [...onlyProbe.args, "x"] } }));
		const fixed: LegacyFixer = async (o) => (await call(legacyRunTool(o.root, o.config, o.source), { cmd: "sh", args: ["{script}"], why: "mount it all" }), "set a run that reaches every script");
		expect(await probeLegacyEnv({ ...opts, fixer: fixed })).toBe("run");
	});


	it("a truth script that loads the old code by its absolute legacy-repo path still runs where the old code really is", async () => {
		const { root, config, source } = workspace();
		const elsewhere = join(root, "old-copy");
		mkdirSync(join(elsewhere, "lib"), { recursive: true });
		writeFileSync(join(elsewhere, "lib", "value.sh"), "V=7\n");
		writeFileSync(join(root, ".bigrefactor", "legacy-env.json"), JSON.stringify({ root: elsewhere, mode: "run" }));
		const dir = join(root, ".bigrefactor", "truth", "U1");
		mkdirSync(dir, { recursive: true });
		const script = join(dir, "cases.sh");
		writeFileSync(script, `. ${resolve(config.source.path)}/lib/value.sh\necho "[{\\"symbol\\":\\"s\\",\\"inputs\\":[],\\"expected\\":$V}]"\n`);
		const r = await verifyTruthOnOld(dir, config, source, root);
		expect(r).toMatchObject({ ok: true, cases: [{ expected: 7 }] });
		expect(readFileSync(script, "utf8")).toContain(resolve(config.source.path)); // the tester's script is untouched
	});

	it("a red probe nobody was asked about is probed once more (the machine may have changed), then decided", async () => {
		const { root, config, source } = workspace();
		let calls = 0;
		const red: LegacyFixer = async () => (calls++, "docker is not installed");
		// decided red before probes asked anything (an old legacy-env.json)
		writeFileSync(join(root, ".bigrefactor", "legacy-env.json"), JSON.stringify({ root: config.source.path, mode: "read" }));
		expect(await probeLegacyEnv({ config, root, source, fixer: red, log: () => {} })).toBe("read");
		expect(await probeLegacyEnv({ config, root, source, fixer: red, log: () => {} })).toBe("read");
		expect(calls).toBe(1);
		expect(loadLegacyEnv(root, config).probedAgain).toBe(true);
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
	it("an expected value that differs between two runs of the old code is refused, with the case and what to do", async () => {
		const { root, legacy, truthDir, config, source } = workspace();
		// a counter file stands in for a clock: each run prints a different created_at
		writeFileSync(join(legacy, "app.sh"), `n=$(cat n 2>/dev/null || echo 0); n=$((n+1)); echo $n > n\necho '[{"symbol":"a::b","inputs":[],"expected":{"total":5,"created_at":'$n'}}]'\n`);
		const r = await verifyTruthOnOld(truthDir, config, source, root);
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/differ between two runs[\s\S]*case #1\.created_at: \d+ then \d+[\s\S]*fixed input/);
		expect(r.error).not.toMatch(/total/);
		writeFileSync(join(legacy, "app.sh"), `echo '[{"symbol":"a::b","inputs":[],"expected":{"total":5}}]'\n`);
		expect((await verifyTruthOnOld(truthDir, config, source, root)).ok).toBe(true);
	});

	it("a probe that ran green and fails now means the runtime is down: waited for, over once it runs again, down when it stays red", async () => {
		const { root, legacy, config, source } = workspace();
		writeFileSync(join(root, ".bigrefactor", "legacy-env.json"), JSON.stringify({ root: legacy, mode: "run", run: { cmd: "sh", args: ["-c", 'test ! -e down && sh "$0"', "{script}"] } }));
		mkdirSync(join(root, ".bigrefactor", "legacy-env", "probe"), { recursive: true });
		writeFileSync(join(root, ".bigrefactor", "legacy-env", "probe", "cases.sh"), "echo '[]'\n");
		const wait = { tries: 3, waitMs: 50 };
		expect(await legacyEnvOutage(root, config, source, wait)).toBe("none");
		writeFileSync(join(legacy, "down"), "");
		expect(await legacyEnvOutage(root, config, source, wait)).toBe("down");
		setTimeout(() => rmSync(join(legacy, "down")), 20);
		expect(await legacyEnvOutage(root, config, source, wait)).toBe("over");
		// a workspace that never ran the old code has nothing to compare with
		writeFileSync(join(root, ".bigrefactor", "legacy-env.json"), JSON.stringify({ root: legacy, mode: "read" }));
		writeFileSync(join(legacy, "down"), "");
		expect(await legacyEnvOutage(root, config, source, wait)).toBe("none");
	});
});
