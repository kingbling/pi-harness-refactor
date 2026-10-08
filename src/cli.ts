import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { findConfigPath, loadConfig, statePath, type Config } from "./config.ts";
import { Ledger } from "./ledger/db.ts";
import { registerGeneratedTargets } from "./adapters/registry.ts";
import { renderStatus, renderWhy } from "./dashboard/status.ts";
import { OpenRouterClient } from "./models/openrouter.ts";
import type { ModelClient } from "./models/types.ts";

loadDotEnv();

const [cmd = "help", ...rest] = process.argv.slice(2);

const commands: Record<string, (args: string[]) => Promise<void>> = {
	help: async () => {
		console.log(`br — bigrefactor

  br init | br start           give the old and the new folder; everything else runs (gather → decide → build)
  br resume                    continue onboarding where it stopped (finished steps are skipped)
       flags: [--source <old> --target <new>] [--yes: accept every recommendation] [--no-llm: offline]
              [--to <target ids> --db keep-schema --choose <stack>.<key>=<option>,… --replace lib=pkg|drop,…] pre-decide items
  br onboard                   same as init (kept for scripts)
  br init --config-only        only write bigrefactor.config.json (no data gathering)
  br setup                     bootstrap target with each stack's official CLI, git init + commit
  br rules [--force|--relayout]  generate RULES.md, AGENTS.md chain, idioms.json, ast-grep rules per stack; --relayout re-renders only the layout section
  br docs fetch | <query>      refetch official docs / search them
  br inventory                 index source → symbols, units, tiers → ledger (re-run = drift report)
  br index-target              (re)index the new codebase: exports, shared helpers, docs → target_lookup/shared_lookup
  br simulate --level 1|2|3    prove the pipeline before touching the real repo
  br label                     Jev labels units (difficulty → model routing, kind, needs_db, has_ui), auth slices, unreached units → slices, placement
  br place [--force]           target stack + legacy area per unit (code → Jev → question); .bigrefactor/placement.json overrides
  br advise                    models judge what tables used to: library successors, unmapped framework classes (escalate model), open decisions (Jev)
  br decide [--json] [--answer id=value ...]   decision gate: everything the inventory cannot decide; run/L3 wait for it
  br profile [--force]         generate the legacy framework profile (loaders, routes-in-code, entry points, concerns) from the framework source; validated against the index
  br frameworks                what the legacy framework/libraries do, app reliance per concern, platform/port/drop verdicts
  br rule [<stack>:] <words>   change how the new code is organised, in plain words (checked by code, shown before it applies); no words: show the layouts
  br layout                    layout preflight: units per stack, top areas, shared units, target tree, problems (br run refuses on problems)
  br order [--no-llm]          database units from the schema, then vertical slices (foundation → auth → features) as scheduling priority; .bigrefactor/slices.json overrides
  br run [--dry] [--slice s] [--units a,b] [--limit n] [--force]   scheduler: agent pool + gate pool, worktree per unit, merge per accepted unit;
                               refuses on layout problems (--force starts anyway); pauses after the first units for a layout review question
  br requeue <unit...>|--all   put quarantined or parked (waiting on an answered question) units back into the queue
  br recheck [--limit n] [--again]   accepted units under the newer checks (truth from the old code, the reviewer model); failures go back to planned, code kept
  br status                    ledger dashboard
  br lanes [n] [--gates m]     show/change parallel units and gate slots; a running run applies it live
  br push [on|off] [remote]    push the migration branch to the target repo's remote after merges
  br forecast                  how far the migration is: done, open, spend and time left (with range)
  br questions | answer <id> <text>   open human questions (nothing unrelated waits on them)
  br why <symbol|path>         full history of one symbol or file
  br smoke                     verify configured models and the OpenRouter key
  br check                     what bigrefactor needs on this machine (logins, git, ast-grep, the stacks' tools) and what is missing
`);
	},
	status: async () => {
		const { ledger } = open();
		console.log(renderStatus(ledger));
	},
	lanes: async (args) => {
		const { lanes, parseLanesArgs } = await import("./run/lanes.ts");
		const { findConfigPath } = await import("./config.ts");
		const p = findConfigPath();
		if (!p) throw new Error("no bigrefactor.config.json here");
		console.log(lanes(p, parseLanesArgs(args)));
	},
	push: async (args) => {
		const { pushSetting } = await import("./run/push.ts");
		const { findConfigPath } = await import("./config.ts");
		const p = findConfigPath();
		if (!p) throw new Error("no bigrefactor.config.json here");
		console.log(pushSetting(p, args));
	},
	forecast: async () => {
		const { forecast, renderForecast } = await import("./run/forecast.ts");
		const { ledger } = open();
		console.log(renderForecast(forecast(ledger)));
	},
	why: async (args) => {
		const id = args[0];
		if (!id) throw new Error("usage: br why <symbol-id|path>");
		const { ledger } = open();
		console.log(renderWhy(ledger, id));
	},
	check: async () => {
		const { checkRequirements, renderRequirements } = await import("./requirements.ts");
		const rs = await checkRequirements({ cwd: process.cwd() });
		console.log(renderRequirements(rs));
		if (rs.some((r) => r.status === "missing")) process.exitCode = 1;
	},
	smoke: async () => {
		const { smoke } = await import("./smoke.ts");
		const cfgPath = findConfigPath();
		const config = cfgPath ? loadConfig(cfgPath).config : undefined;
		const client = new OpenRouterClient();
		const ok = await smoke(client, config);
		process.exitCode = ok ? 0 : 1;
	},
	// `br init` / `br start`: give the old and the new folder, everything else runs (onboarding).
	// `br resume`: continue where it stopped. `br init --config-only`: only write the config.
	init: async (args) => {
		if (args.includes("--config-only")) {
			const { init } = await import("./init/init.ts");
			await init(args.filter((a) => a !== "--config-only"));
			return;
		}
		const { onboard } = await import("./init/onboard.ts");
		const r = await onboard({ args });
		if (!r.ok) process.exitCode = 1;
	},
	start: async (args) => commands.init!(args),
	resume: async (args) => commands.onboard!(args),
	questions: async () => {
		const { ledger } = open();
		const qs = ledger.openQuestions();
		const own = ledger.ownDecisions();
		if (own.length) {
			console.log(pc.dim(`decided by the run from your goals (${own.length}; change one with br answer <id> <text>, or set run.ask to "all" to be asked instead):`));
			for (const q of own.slice(0, 10)) console.log(pc.dim(`  #${q.id} [${q.point}]${q.unit_id ? ` ${q.unit_id}` : ""} → ${q.answer}`));
			console.log("");
		}
		if (!qs.length) return console.log(pc.green("no open questions"));
		const blocked = ledger.blockedUnits();
		for (const q of qs) {
			const waiting = [...blocked.entries()].filter(([, ids]) => ids.includes(q.id)).map(([u]) => u);
			console.log(`${pc.bold(`#${q.id}`)} ${pc.dim(`[${q.point}] by ${q.asked_by}${q.unit_id ? ` on ${q.unit_id}` : ""}`)}\n  ${q.question}${q.options ? pc.dim(`\n  options: ${(JSON.parse(q.options) as string[]).join(" | ")}`) : ""}\n  ${waiting.length ? pc.yellow(`waiting: ${waiting.join(", ")}`) : pc.dim("blocks nothing")}\n`);
		}
		console.log(pc.dim("answer with: br answer <id> <text>"));
	},
	answer: async (args) => {
		const [id, ...text] = args;
		if (!id || !text.length) throw new Error("usage: br answer <id> <text>");
		const { ledger } = open();
		ledger.answerQuestion(Number(id), text.join(" "), process.env["USER"] ?? "human");
		console.log(pc.green(`answered #${id}`));
	},
	setup: async () => {
		const { setup } = await import("./init/init.ts");
		const { config, root } = loadConfig();
		await setup(config, root);
	},
	"index-target": async () => {
		const { indexTarget } = await import("./inventory/target.ts");
		const { projectDir } = await import("./init/init.ts");
		const { getTargetAdapter } = await import("./adapters/registry.ts");
		const { config, ledger } = open();
		let n = 0;
		for (const id of config.target.stacks) n += await indexTarget(ledger, await getTargetAdapter(id), projectDir(config, id));
		console.log(`indexed ${n} target symbols`);
	},
	rules: async (args) => {
		const { generateRules } = await import("./init/rules.ts");
		const { config, root, ledger } = open();
		const r = await generateRules(config, root, ledger, { force: args.includes("--force"), relayout: args.includes("--relayout"), client: makeClient() });
		console.log(`rules: ${r.files.length} files, $${r.costUsd.toFixed(4)}`);
	},
	docs: async (args) => {
		const { fetchDocs, searchDocs } = await import("./init/docs.ts");
		const { config, root } = loadConfig();
		if (args[0] === "fetch") {
			const entries = await fetchDocs(config, root, { force: true });
			console.log(`${entries.length} docs fetched`);
			return;
		}
		const q = args.join(" ");
		if (!q) throw new Error("usage: br docs fetch | br docs <query>");
		for (const h of searchDocs(root, q)) console.log(`${pc.cyan(`${h.tech}/${h.name}:${h.line}`)}\n${h.snippet}\n`);
	},
	inventory: async () => {
		const { inventory } = await import("./inventory/run.ts");
		const { config, root } = loadConfig();
		const ledger = new Ledger(statePath(root, "ledger.sqlite"));
		await inventory(config, root, ledger);
		console.log(renderStatus(ledger));
	},
	unit: async (args) => {
		// Hand-driven single unit (build-order step 2 / pilot). Live models, real target project, no scheduler.
		const id = args[0];
		if (!id) throw new Error("usage: br unit <unit-id> [--accept] [--reuse-truth]");
		const { runUnit } = await import("./run/unit.ts");
		const { config, root, ledger } = open();
		const r = await runUnit({ ledger, config, root, unitId: id, client: makeClient(), accept: args.includes("--accept"), reuseTruth: args.includes("--reuse-truth"), retry: args.includes("--retry") });
		console.log(`${r.unitId}: ${r.state} after ${r.attempts} attempt(s), $${r.costUsd.toFixed(4)}`);
		process.exitCode = r.state === "review" || r.state === "accepted" ? 0 : 1;
	},
	accept: async (args) => {
		const id = args[0];
		if (!id) throw new Error("usage: br accept <unit-id>");
		const { acceptUnit, afterAccept } = await import("./run/unit.ts");
		const { getTargetAdapter } = await import("./adapters/registry.ts");
		const { placeUnit } = await import("./run/placement.ts");
		const { projectDir } = await import("./init/init.ts");
		const { config, root, ledger } = open();
		const u = ledger.getUnit(id);
		if (!u) throw new Error(`unknown unit ${id}`);
		if (u.state !== "review") throw new Error(`unit ${id} is ${u.state}, not in review`);
		const { stackId, area } = placeUnit(config, u.meta, root);
		const sha = acceptUnit({ ledger, config, unitId: id }, projectDir(config, stackId), area);
		afterAccept(ledger, await getTargetAdapter(stackId), projectDir(config, stackId), stackId, area, (l) => console.log(l));
		console.log(pc.green(`accepted ${id}${sha ? ` @ ${sha.slice(0, 7)}` : ""}`));
	},
	simulate: async (args) => {
		const { simulate } = await import("./run/simulate.ts");
		const level = Number(flag(args, "--level") ?? "1") as 1 | 2 | 3;
		if (level === 3) await assertNoOpenDecisions();
		const sample = Number(flag(args, "--sample") ?? "10");
		await simulate({ level, sample });
	},
	run: async (args) => {
		// whole-target decisions refuse; scoped ones only block their units (run.ts reads them live)
		if (!args.includes("--dry")) await assertNoGlobalDecisions();
		const { run } = await import("./run/run.ts");
		const limit = flag(args, "--limit");
		await run({ units: flag(args, "--units")?.split(","), slice: flag(args, "--slice"), limit: limit ? Number(limit) : undefined, dry: args.includes("--dry"), force: args.includes("--force") });
	},
	requeue: async (args) => {
		// Put quarantined or waiting units back into the queue (after a fix). Worktree and branch are dropped; truth is kept.
		if (!args.length) throw new Error("usage: br requeue <unit-id...> | --all");
		const { requeueUnits } = await import("./run/run.ts");
		const { config, root, ledger } = open();
		for (const l of requeueUnits(ledger, config, root, args.includes("--all") ? "all" : args.filter((a) => !a.startsWith("--")), process.env["USER"] ?? "human")) console.log(/requeued$/.test(l) ? pc.green(l) : pc.yellow(l));
	},
	recheck: async (args) => {
		const { recheckAccepted } = await import("./run/recheck.ts");
		const { config, root, ledger } = open();
		const limit = flag(args, "--limit");
		await recheckAccepted({ ledger, config, root, limit: limit ? Number(limit) : undefined, again: args.includes("--again") });
	},
	onboard: async (args) => {
		const { onboard } = await import("./init/onboard.ts");
		const r = await onboard({ args });
		if (!r.ok) process.exitCode = 1;
	},
	profile: async (args) => {
		const { generateProfile } = await import("./init/profile.ts");
		const { config, ledger, root } = open();
		await generateProfile(config, root, ledger, { force: args.includes("--force"), client: makeClient() });
	},
	frameworks: async () => {
		const { planFrameworks, renderFrameworkPlan } = await import("./inventory/frameworks.ts");
		const { getSourceAdapter, getTargetAdapter } = await import("./adapters/registry.ts");
		const { config, ledger, root } = open();
		const source = getSourceAdapter(config.source.stack);
		source.frameworkDirs?.(config.source.path); // detect profile
		const targets = await Promise.all(config.target.stacks.map((s) => getTargetAdapter(s)));
		const { loadDecisions } = await import("./inventory/decisions.ts");
		console.log(renderFrameworkPlan(planFrameworks(ledger, source, targets, config.source.path, loadDecisions(root), config.target.choices)));
	},
	label: async () => {
		const { labelUnits } = await import("./init/label.ts");
		const { config, ledger, root } = open();
		const r = await labelUnits(config, root, ledger, makeClient());
		console.log(`labelled ${r.units} units (${r.hard} hard), auth slices: ${r.auth.join(", ") || "none"}, placed ${r.placed}, ${r.areas.placed} units placed in areas (${r.areas.asked} asked), $${r.costUsd.toFixed(4)}`);
	},
	place: async (args) => {
		const { resolvePlacements, placeUnit } = await import("./run/placement.ts");
		const { config, ledger, root } = open();
		const r = await resolvePlacements({ ledger, config, root, client: makeClient(), force: args.includes("--force"), curate: !args.includes("--no-curate"), log: (l) => console.log(l) });
		const n = new Map<string, number>();
		for (const u of ledger.listUnits()) {
			const p = placeUnit(config, u.meta, root);
			const k = `${p.stackId}:${p.shared ? "shared/" : ""}${p.area}`;
			n.set(k, (n.get(k) ?? 0) + 1);
		}
		console.log(`${r.placed} placed (${r.byModel} by Jev, ${r.shared} shared), ${r.asked} question(s) → br questions; ${n.size} modules:`);
		console.log([...n].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k}=${c}`).join("  "));
	},
	advise: async () => {
		const { advise } = await import("./init/advise.ts");
		const { getSourceAdapter, getTargetAdapter } = await import("./adapters/registry.ts");
		const { config, ledger, root } = open();
		const source = getSourceAdapter(config.source.stack);
		const targets = await Promise.all(config.target.stacks.map((s) => getTargetAdapter(s)));
		const r = await advise(config, root, ledger, makeClient(), source, targets);
		console.log(`advised ${r.libraries} libraries, ${r.classes} framework classes, ${r.decisions} decisions — $${r.costUsd.toFixed(4)}; see br decide`);
	},
	rule: async (args) => {
		const { ownerRule, layoutPreview } = await import("./rules/owner-layout.ts");
		const { loadLayoutRules } = await import("./rules/layout-rules.ts");
		const { getTargetAdapter } = await import("./adapters/registry.ts");
		const { projectDir, terminalPrompter } = await import("./init/init.ts");
		const { config, ledger, root } = open();
		const targets = await Promise.all(config.target.stacks.map((s) => getTargetAdapter(s)));
		const text = args.join(" ").trim();
		const named = /^([\w-]+):\s*/.exec(text);
		const t = named && targets.find((x) => x.id === named[1]) ? targets.find((x) => x.id === named[1])! : targets.length === 1 ? targets[0] : undefined;
		const words = (t && named?.[1] === t.id ? text.slice(named[0].length) : text).trim();
		if (!words) {
			for (const x of targets) console.log(`${pc.bold(x.id)}\n${(() => { const r = loadLayoutRules(root, x.id); return r ? layoutPreview(r) : "  no layout decided yet (built-in checks)"; })()}`);
			return;
		}
		if (!t) throw new Error(`name the stack: br rule <${targets.map((x) => x.id).join("|")}>: <words>`);
		console.log(await ownerRule({ root, stack: t.id, adapter: t, words, ui: terminalPrompter, client: makeClient(), model: config.models.escalate.id, projectDir: projectDir(config, t.id), ledger }));
	},
	decide: async (args) => {
		const { openDecisions, applyDecision, renderDecisions } = await import("./inventory/decisions.ts");
		const { getSourceAdapter, getTargetAdapter } = await import("./adapters/registry.ts");
		const { config, ledger, root } = open();
		const source = getSourceAdapter(config.source.stack);
		source.frameworkDirs?.(config.source.path);
		const targets = await Promise.all(config.target.stacks.map((s) => getTargetAdapter(s)));
		// every id=value after --answer counts (`--answer a=1 b=2` and `--answer a=1 --answer b=2`), up to the next flag
		const answers: string[] = [];
		for (let i = 0, on = false; i < args.length; i++) {
			if (args[i] === "--answer") on = true;
			else if (args[i]!.startsWith("--")) on = false;
			else if (on) answers.push(args[i]!);
		}
		for (const a of answers) {
			const eq = a.indexOf("=");
			if (eq < 0) throw new Error(`--answer expects id=value, got ${a}`);
			const note = applyDecision(ledger, config, root, a.slice(0, eq), a.slice(eq + 1), process.env["USER"] ?? "human");
			console.log(pc.green(`decided ${a.slice(0, eq)} = ${a.slice(eq + 1)}`) + (note ? pc.dim(`  ${note}`) : ""));
		}
		const { config: cfg2 } = open(); // answers may have changed the config
		const targets2 = await Promise.all(cfg2.target.stacks.map((s) => getTargetAdapter(s)));
		const ds = openDecisions(ledger, cfg2, source, targets2, root);
		if (args.includes("--json")) return console.log(JSON.stringify(ds, null, 2));
		if (!answers.length && !args.includes("--list") && ds.length && process.stdout.isTTY) {
			const { terminalPrompter } = await import("./init/init.ts");
			for (const d of ds) {
				const v = await terminalPrompter.select(`${d.question}\n   ${pc.dim(d.evidence)}`, d.options.map((o) => ({ value: o.value, label: o.label, hint: o.hint })), d.recommended);
				if (v === undefined) break;
				console.log(pc.dim(applyDecision(ledger, cfg2, root, d.id, v, process.env["USER"] ?? "human")));
			}
			return console.log(renderDecisions(openDecisions(ledger, open().config, source, targets2, root)));
		}
		console.log(renderDecisions(ds));
	},
	layout: async () => {
		const { checkLayout, renderLayout } = await import("./run/layout-check.ts");
		const { config, root, ledger } = open();
		const r = await checkLayout(config, root, ledger);
		for (const l of renderLayout(r)) console.log(l.startsWith("problem:") ? pc.red(l) : l.startsWith("warning:") ? pc.yellow(l) : l);
		if (r.problems.length) process.exitCode = 1;
	},
	order: async (args) => {
		const { planSlices, applySlicePlan, renderSlicePlan } = await import("./inventory/slices.ts");
		const { ledger, root, config } = open();
		// the DB units first (tables judged by a model, the owner's answer about unclear databases applied)
		const { planDbLane } = await import("./inventory/db.ts");
		const dbl = await planDbLane(ledger, config, { client: args.includes("--no-llm") ? undefined : makeClient(), root, log: (l) => console.log(l) });
		if (dbl.units.length) console.log(`database: ${dbl.units.length} unit(s) for ${dbl.tables - dbl.dropped} table(s), ${dbl.dropped} not migrated, ${dbl.removed.length} removed`);
		const p = join(root, ".bigrefactor", "slices.json");
		const overrides = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
		const plan = planSlices(ledger, overrides);
		applySlicePlan(ledger, plan);
		console.log(renderSlicePlan(plan));
	},
};

async function assertNoGlobalDecisions(): Promise<void> {
	const { decisionGate, renderGate } = await import("./run/decisions-gate.ts");
	const { getSourceAdapter, getTargetAdapter } = await import("./adapters/registry.ts");
	const { config, ledger, root } = open();
	const g = decisionGate(ledger, config, getSourceAdapter(config.source.stack), await Promise.all(config.target.stacks.map((s) => getTargetAdapter(s))), root);
	if (g.global.length) throw new Error(`${renderGate(g)[0]} — run \`br decide\` first`);
	for (const l of renderGate(g)) console.log(pc.yellow(l));
	if (g.scoped.length || g.free.length) console.log(pc.dim("the run continues with everything else; answer with `br decide` (another terminal works) and blocked units start"));
}

async function assertNoOpenDecisions(): Promise<void> {
	const { openDecisions } = await import("./inventory/decisions.ts");
	const { getSourceAdapter, getTargetAdapter } = await import("./adapters/registry.ts");
	const { config, ledger, root } = open();
	const source = getSourceAdapter(config.source.stack);
	source.frameworkDirs?.(config.source.path);
	const targets = await Promise.all(config.target.stacks.map((s) => getTargetAdapter(s)));
	const ds = openDecisions(ledger, config, source, targets, root);
	if (ds.length) throw new Error(`${ds.length} open decision(s): ${ds.map((d) => d.id).join(", ")} — run \`br decide\` first (nothing is defaulted silently)`);
}

function flag(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}

export function open(): { config: Config; root: string; ledger: Ledger } {
	const { config, root } = loadConfig();
	process.env["BR_WORKSPACE"] = root; // adapters find generated artifacts (framework profile) here
	registerGeneratedTargets(root);
	return { config, root, ledger: new Ledger(statePath(root, "ledger.sqlite")) };
}

export function makeClient(): ModelClient {
	return new OpenRouterClient();
}

function loadDotEnv() {
	for (const dir of [process.cwd(), join(import.meta.dirname, "..")]) {
		const p = join(dir, ".env");
		if (!existsSync(p)) continue;
		for (const line of readFileSync(p, "utf8").split("\n")) {
			const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
			if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2]!.replace(/^["']|["']$/g, "");
		}
	}
}

const handler = commands[cmd];
if (!handler) {
	console.error(pc.red(`unknown command: ${cmd}`));
	await commands["help"]!([]);
	process.exit(2);
}
try {
	await handler(rest);
} catch (e: any) {
	console.error(pc.red(e?.message ?? String(e)));
	if (process.env["BR_DEBUG"]) console.error(e);
	process.exit(1);
}
