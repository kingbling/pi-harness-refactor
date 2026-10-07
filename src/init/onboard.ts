import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import pc from "picocolors";
import { progress } from "../progress.ts";
import { loadConfig, type Config } from "../config.ts";
import { Ledger } from "../ledger/db.ts";
import { type InitPrompter, init, setup, terminalPrompter } from "./init.ts";

/**
 * `br onboard`: the whole onboarding as one seamless, resumable flow. Every step is idempotent and
 * skipped when its artifact exists, so re-running after a crash or a `--force` on one step continues
 * where it stopped. Interactive questions all go through one prompter (terminal: clack; Pi: dialogs;
 * tests: a scripted prompter). `--yes` takes every recommendation; `--no-llm` skips the two
 * model-driven steps (framework profile, rules) for offline/e2e runs.
 *
 *   init → setup (official generators + chosen packages) → docs → inventory → profile → inventory
 *   → frameworks → decide → rules → order → status
 */
export interface OnboardOptions {
	root?: string;
	prompter?: InitPrompter;
	/** Passed through to `init` (--source, --stack, --target, --to, --db, --choose, --replace, --yes, --no-docs). */
	args?: string[];
	log?: (line: string) => void;
}

export interface OnboardReport {
	steps: Array<{ name: string; status: "done" | "skipped" | "failed"; note?: string; ms: number }>;
	openDecisions: number;
	ok: boolean;
}

export async function onboard(opts: OnboardOptions = {}): Promise<OnboardReport> {
	const root = resolve(opts.root ?? process.cwd());
	const args = opts.args ?? [];
	const ui = opts.prompter ?? terminalPrompter;
	const log = opts.log ?? ((l: string) => console.log(l));
	const yes = args.includes("--yes");
	const noLlm = args.includes("--no-llm");
	const report: OnboardReport = { steps: [], openDecisions: 0, ok: true };
	process.env["BR_WORKSPACE"] = root;

	const ABOUT: Record<string, string> = {
		init: "survey the old codebase: framework, data stores, UI, tests",
		inventory: "index every file and symbol, find dead code, cut cycles, build migration units",
		profile: "a model reads the legacy framework source and writes its conventions (loaders, routes, concerns)",
		frameworks: "map every legacy framework concern to the new platform (port / platform / drop)",
		advise: "models judge libraries, framework classes and the target stack; Jev weighs the other decisions",
		decide: "every open decision, each with a recommendation",
		setup: "bootstrap the new codebase with the official generators + chosen packages",
		docs: "fetch the official docs of every chosen technology for the agents",
		"inventory (after decisions)": "re-index with the decisions applied",
		label: "Jev rates every unit (difficulty → model, kind, needs_db, has_ui) and places unreached code",
		rules: "a model writes RULES.md, AGENTS.md, idioms and lint rules from the framework mapping",
		order: "order units into slices: foundation → auth → features",
	};
	progress.plan(ABOUT);
	const step = async (name: string, skipWhen: () => string | undefined, run: () => Promise<string | void>) => {
		const t0 = Date.now();
		progress.checkStopped();
		const skip = skipWhen();
		if (skip) {
			report.steps.push({ name, status: "skipped", note: skip, ms: 0 });
			progress.stepEnd(name, "skipped", skip);
			log(pc.dim(`○ ${name}: ${skip}`));
			return;
		}
		log(pc.bold(`▶ ${name}`) + (ABOUT[name] ? pc.dim(` — ${ABOUT[name]}`) : ""));
		progress.stepStart(name);
		try {
			const note = (await run()) ?? undefined;
			progress.checkStopped(); // a stop during the step aborts its model session; do not record it as done
			progress.stepEnd(name, "done", note);
			report.steps.push({ name, status: "done", note, ms: Date.now() - t0 });
			log(pc.green(`✓ ${name}${note ? pc.dim(`  ${note}`) : ""}`));
		} catch (e: any) {
			report.steps.push({ name, status: "failed", note: e?.message ?? String(e), ms: Date.now() - t0 });
			progress.stepEnd(name, "failed", e?.message ?? String(e));
			// where it broke: the first frames inside our code, so a TypeError is diagnosable from the panel
			if (e?.stack && !(e?.name === "Error" && /stopped by the user/.test(e.message))) for (const f of String(e.stack).split("\n").filter((l: string) => /\/src\//.test(l)).slice(0, 4)) progress.log(`    at ${f.trim().replace(/^at /, "").replace(/.*\/src\//, "src/")}`);
			report.ok = false;
			log(pc.red(`✗ ${name}: ${e?.message ?? e}`));
			throw e;
		}
	};
	const configPath = join(root, "bigrefactor.config.json");
	const has = (...parts: string[]) => existsSync(join(root, ...parts));
	let config!: Config;
	const reload = () => (config = loadConfig(configPath).config);
	const ledger = () => {
		mkdirSync(join(root, ".bigrefactor"), { recursive: true });
		return new Ledger(join(root, ".bigrefactor", "ledger.sqlite"));
	};

	try {
		await step("init", () => (has("bigrefactor.config.json") && !args.includes("--force") ? "config exists" : undefined), async () => {
			await init(args.filter((a) => a !== "--no-llm"), { root, prompter: ui, embedded: true });
		});
		reload();
		const { getSourceAdapter, getTargetAdapter } = await import("../adapters/registry.ts");
		const source = getSourceAdapter(config.source.stack);
		const targets = await Promise.all(config.target.stacks.map((s) => getTargetAdapter(s)));

		const { inventory } = await import("../inventory/run.ts");
		await step("inventory", () => (ledgerHasUnits(root) ? "ledger present (re-run `br inventory` for drift)" : undefined), async () => {
			const l = ledger();
			try {
				const r = await inventory(config, root, l);
				return `${r.units} units, ${r.dead.length} dead, ${r.framework} framework files`;
			} finally {
				l.close();
			}
		});

		await step("profile", () => (noLlm ? "skipped (--no-llm)" : !source.profileExample ? "adapter has no framework profiles" : has(".bigrefactor", "framework-profile.json") ? "profile present" : !(source.frameworkDirs?.(config.source.path) ?? []).length && !frameworkDirsLikely(config.source.path) ? "no framework directory detected" : undefined), async () => {
			const { generateProfile } = await import("./profile.ts");
			const l = ledger();
			try {
				await generateProfile(config, root, l);
			} finally {
				l.close();
			}
		});

		await step("frameworks", () => undefined, async () => {
			const { planFrameworks } = await import("../inventory/frameworks.ts");
			const { loadDecisions } = await import("../inventory/decisions.ts");
			source.frameworkDirs?.(config.source.path);
			const l = ledger();
			try {
				const plan = planFrameworks(l, source, targets, config.source.path, loadDecisions(root), config.target.choices);
				return `${plan.concerns.filter((c) => c.appRefs > 0).length} concerns in use, ${plan.unmapped.length} unmapped classes, ${plan.libraries.length} libraries`;
			} finally {
				l.close();
			}
		});

		await step("advise", () => (noLlm ? "skipped (--no-llm): static recommendations only" : undefined), async () => {
			const { advise } = await import("./advise.ts");
			const { OpenRouterClient } = await import("../models/openrouter.ts");
			const l = ledger();
			try {
				const r = await advise(config, root, l, new OpenRouterClient(), source, targets, (x) => log(x));
				return `${r.libraries} libraries, ${r.classes} framework classes, ${r.decisions} decisions advised, $${r.costUsd.toFixed(3)}`;
			} finally {
				l.close();
			}
		});

		await step("decide", () => undefined, async () => {
			const { openDecisions, applyDecision, renderDecisions } = await import("../inventory/decisions.ts");
			const l = ledger();
			try {
				let ds = openDecisions(l, config, source, targets, root);
				if (!ds.length) return "nothing to decide";
				const total = ds.length;
				if (yes) {
					for (const d of ds) if (d.recommended) applyDecision(l, config, root, d.id, d.recommended, "onboard --yes");
				} else {
					// one question first: accept every recommendation? (a typical run is a single answer)
					const withRec = ds.filter((d) => d.recommended);
					const accept = await ui.select(`${ds.length} open decisions. Accept the ${withRec.length} recommended answers and only review the rest?`, [{ value: "accept", label: "accept recommendations", hint: withRec.map((d) => `${d.id}=${d.recommended}`).slice(0, 8).join(", ") + (withRec.length > 8 ? ", …" : "") }, { value: "each", label: "ask me each one" }], "accept");
					if (accept === undefined) throw new Error("onboarding cancelled");
					if (accept === "accept") for (const d of withRec) applyDecision(l, config, root, d.id, d.recommended!, "human (accepted recommendations)");
					reload();
					ds = openDecisions(l, config, source, targets, root);
					for (const d of ds) {
						const v = await ui.select(`${d.question}\n   ${d.evidence}${d.reason ? `\n   why ${d.recommended}: ${d.reason}` : ""}`, d.options.map((o) => ({ value: o.value, label: o.value === d.recommended ? `${o.label} (recommended)` : o.label, hint: o.hint })), d.recommended);
						if (v === undefined) throw new Error("onboarding cancelled");
						applyDecision(l, config, root, d.id, v, "human (onboard)");
					}
				}
				reload();
				const left = openDecisions(l, config, source, targets, root);
				report.openDecisions = left.length;
				if (left.length) log(renderDecisions(left));
				return left.length ? `${total - left.length} decided, ${left.length} still open` : `${total} decided`;
			} finally {
				l.close();
			}
		});
		reload();
		const decidedTargets = await Promise.all(config.target.stacks.map((s) => getTargetAdapter(s)));
		targets.splice(0, targets.length, ...decidedTargets);
		// Bootstrapped = every project exists AND setup's final commit landed. An interrupted setup (half a
		// generator run, chosen packages not added) has files but no commit, so a resume redoes it idempotently.
		await step("setup", () => (config.target.stacks.every((s) => projectReady(config, s)) && targetHasCommit(config.target.path) ? "target already bootstrapped" : undefined), async () => {
			await setup(config, root);
		});

		await step("docs", () => (has(".bigrefactor", "docs", "index.json") || args.includes("--no-docs") ? "docs present" : undefined), async () => {
			const { fetchDocs } = await import("./docs.ts");
			const entries = await fetchDocs(config, root, { log: (l) => log(pc.dim(l)) });
			return `${entries.length} docs`;
		});

		// decisions may change the inventory (merge groups, slices): refresh once, cheap
		await step("inventory (after decisions)", () => undefined, async () => {
			const l = ledger();
			try {
				const r = await inventory(config, root, l);
				const { planFrameworks } = await import("../inventory/frameworks.ts");
				const { loadDecisions } = await import("../inventory/decisions.ts");
				planFrameworks(l, source, targets, config.source.path, loadDecisions(root), config.target.choices);
				return `${r.units} units`;
			} finally {
				l.close();
			}
		});

		await step("label", () => (noLlm ? "skipped (--no-llm): path heuristics only" : undefined), async () => {
			const { labelUnits } = await import("./label.ts");
			const { OpenRouterClient } = await import("../models/openrouter.ts");
			const l = ledger();
			try {
				const r = await labelUnits(config, root, l, new OpenRouterClient(), { log: (x) => log(x) });
				return `${r.units} units labelled (${r.hard} hard), auth: ${r.auth.join(", ") || "none"}, ${r.placed} unreached units placed, $${r.costUsd.toFixed(3)}`;
			} finally {
				l.close();
			}
		});

		await step("rules", () => (noLlm ? "skipped (--no-llm)" : has(".bigrefactor", "rules", "RULES.md") ? "rules present" : undefined), async () => {
			const { generateRules } = await import("./rules.ts");
			const l = ledger();
			try {
				const r = await generateRules(config, root, l, {});
				return `${r.files.length} files, $${r.costUsd.toFixed(2)}`;
			} finally {
				l.close();
			}
		});

		await step("order", () => undefined, async () => {
			const { planSlices, applySlicePlan } = await import("../inventory/slices.ts");
			const l = ledger();
			try {
				const p = join(root, ".bigrefactor", "slices.json");
				const plan = planSlices(l, existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {});
				applySlicePlan(l, plan);
				return `${plan.slices.length} slices, foundation ${plan.foundationSharePct}%`;
			} finally {
				l.close();
			}
		});
	} catch {
		/* step already recorded the failure */
	}

	if (report.ok) log(summary(root));
	const next = report.ok
		? report.openDecisions
			? `next: ${pc.cyan("br decide")} (${report.openDecisions} open) → ${pc.cyan("br simulate --level 1")} → ${pc.cyan("br run")}`
			: `next: ${pc.cyan("br simulate --level 1")} → ${pc.cyan("br run --limit 10")} (pilot) · ${pc.cyan("br status")} any time`
		: `onboarding stopped at "${report.steps.find((s) => s.status === "failed")?.name}"; fix and run ${pc.cyan("br resume")} — finished steps are skipped`;
	log(next);
	return report;
}

/** What onboarding produced, in a few lines a human reads at the end. */
function summary(root: string): string {
	const L: string[] = ["", pc.bold("onboarding summary")];
	try {
		const cfg = loadConfig(join(root, "bigrefactor.config.json")).config;
		L.push(`  old → new     ${cfg.source.path} (${cfg.source.stack}${cfg.source.framework ? "/" + cfg.source.framework : ""}) → ${cfg.target.path} (${cfg.target.stacks.join(" + ")})`);
		const ch = Object.entries(cfg.target.choices).flatMap(([t, c]) => Object.entries(c).map(([k, v]) => `${k}=${v}`));
		if (ch.length) L.push(`  stack         ${ch.join(", ")}`);
		L.push(`  data          ${cfg.db.strategy}${cfg.db.from.length ? `, ${cfg.db.from.join(" + ")} → ${cfg.db.to ?? "?"}` : ""}`);
	} catch { /* config unreadable: skip */ }
	const p = join(root, ".bigrefactor", "ledger.sqlite");
	if (existsSync(p)) {
		const l = new Ledger(p);
		try {
			const n = (q: string) => (l.db.prepare(q).get() as { n: number }).n;
			L.push(`  inventory     ${n("SELECT COUNT(*) n FROM files")} files, ${n("SELECT COUNT(*) n FROM units")} units, ${n("SELECT COUNT(*) n FROM files WHERE dead_code=1")} dead, ${n("SELECT COUNT(*) n FROM files WHERE disposition='framework'")} framework files`);
			const hard = n("SELECT COUNT(*) n FROM units WHERE json_extract(meta,'$.route.difficulty')='hard'");
			if (hard) L.push(`  routing       ${hard} units rated hard start on the escalate model`);
			const cost = n("SELECT CAST(ROUND(COALESCE(SUM(cost_usd),0)*1000) AS INTEGER) n FROM attempts") + n("SELECT CAST(ROUND(COALESCE(SUM(cost_usd),0)*1000) AS INTEGER) n FROM decisions");
			L.push(`  spent         $${(cost / 1000).toFixed(2)} on models so far`);
		} finally {
			l.close();
		}
	}
	const d = join(root, ".bigrefactor", "decisions.json");
	if (existsSync(d)) {
		const j = JSON.parse(readFileSync(d, "utf8")) as { answers: Record<string, { answer: string; by: string }> };
		const byModel = Object.values(j.answers).filter((a) => /recommend|--yes/.test(a.by)).length;
		L.push(`  decisions     ${Object.keys(j.answers).length} recorded (${byModel} recommendations accepted) → .bigrefactor/decisions.json, change any with br decide`);
	}
	L.push(`  artifacts     .bigrefactor/ (ledger, docs, rules, profile); the old folder was not touched`);
	return L.join("\n");
}

function projectReady(config: Config, stackId: string): boolean {
	const dir = config.target.stacks.length === 1 ? config.target.path : join(config.target.path, stackId === "nestjs" ? "api" : stackId === "react" ? "web" : stackId);
	return existsSync(join(dir, "package.json"));
}

function targetHasCommit(dir: string): boolean {
	try {
		execFileSync("git", ["-C", dir, "rev-parse", "--verify", "-q", "HEAD"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function ledgerHasUnits(root: string): boolean {
	const p = join(root, ".bigrefactor", "ledger.sqlite");
	if (!existsSync(p)) return false;
	const l = new Ledger(p);
	try {
		return (l.db.prepare("SELECT COUNT(*) n FROM units").get() as { n: number }).n > 0;
	} finally {
		l.close();
	}
}

function decisionsTouchInventory(root: string): boolean {
	const p = join(root, ".bigrefactor", "decisions.json");
	if (!existsSync(p)) return false;
	const d = JSON.parse(readFileSync(p, "utf8")) as { answers: Record<string, { answer: string }> };
	return Object.entries(d.answers).some(([k, v]) => k === "cycle-cuts" || k === "dynamic-slice" || (k === "frontend" && v.answer !== "backend-only"));
}

function frameworkDirsLikely(src: string): boolean {
	try {
		return readdirSync(src).some((n) => /framework|core|engine|-php$/i.test(n));
	} catch {
		return false;
	}
}
