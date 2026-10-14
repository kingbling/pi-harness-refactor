import { join } from "node:path";
import pc from "picocolors";
import { findConfigPath, loadConfig, STATE_DIR } from "../config.ts";
import { Ledger } from "../ledger/db.ts";
import { setOutputHost } from "../proc.ts";
import { progress, StoppedError } from "../progress.ts";
import type { ChildArgs, FromChild, ToChild } from "../pi/run-process.ts";

/**
 * Pi's migration run, in its own process (started by src/pi/run-process.ts). Everything the run does (ledger queries,
 * model tool calls, scheduling) holds this process's thread, never Pi's: Pi only draws what this process sends.
 *   out: the progress snapshot (newest only, at most every 200 ms), a decision to ask, decisions done, done
 *   in:  stop (drain) / abort, an answer, a log line from Pi's side
 * When Pi goes away (IPC disconnect) the run stops as after /br stop and the process ends.
 */
const send = (m: FromChild) => {
	if (process.connected) process.send!(m);
};

let sentAt = 0;
let pending: NodeJS.Timeout | undefined;
const flush = () => {
	clearTimeout(pending);
	pending = undefined;
	sentAt = Date.now();
	send({ type: "progress", snap: progress.snapshot() });
};

const answers = new Map<string, (v: string | undefined) => void>();
process.on("message", (m: ToChild) => {
	if (m.type === "stop") void progress.stop("drain");
	else if (m.type === "abort") void progress.stop("abort");
	else if (m.type === "log") progress.log(m.line);
	else if (m.type === "answer") {
		answers.get(m.id)?.(m.value);
		answers.delete(m.id);
	}
});
// Pi is gone: same as /br stop (running units finish), then the process ends; open questions get no answer
process.on("disconnect", () => {
	for (const done of answers.values()) done(undefined);
	answers.clear();
	if (progress.running && !progress.stopping) void progress.stop("drain");
});
// a stray error in a lane must not end the whole run (inside Pi the host caught these)
process.on("uncaughtException", (e) => progress.log(pc.red(`run error: ${String(e?.stack ?? e).slice(0, 600)}`)));
process.on("unhandledRejection", (e: any) => progress.log(pc.red(`run error: ${String(e?.stack ?? e).slice(0, 600)}`)));

async function work(a: ChildArgs): Promise<{ error?: string; lines?: string[] }> {
	const flags = a.flags;
	const flag = (n: string) => {
		const i = flags.indexOf(n);
		return i >= 0 ? flags[i + 1] : undefined;
	};
	const dry = flags.includes("--dry");
	const limit = flag("--limit") ? Number(flag("--limit")) : undefined;
	const cp = findConfigPath(a.cwd);
	if (!cp) return { error: "no bigrefactor.config.json here: run /br onboard first" };
	const { config, root } = loadConfig(cp);
	const { getSourceAdapter, getTargetAdapter } = await import("../adapters/registry.ts");
	// tests put a scripted scheduler here; a real run always takes the real one
	const { runScheduler } = (process.env["BR_RUN_CHILD_SCHEDULER"] ? await import(process.env["BR_RUN_CHILD_SCHEDULER"]) : await import("./run.ts")) as typeof import("./run.ts");
	const { OpenRouterClient } = await import("../models/openrouter.ts");
	// one run per workspace (a br run in a terminal counts too)
	const { acquireRunLock } = await import("./run-lock.ts");
	const release = dry ? () => {} : acquireRunLock(root);
	const ledger = new Ledger(join(root, STATE_DIR, "ledger.sqlite"));
	let runDone = false;
	try {
		// Whole-target decisions refuse; every other open decision only blocks the units it affects and is
		// asked on the side (Pi's dialogs) while the run goes on. Answers release their units at the next loop.
		const { decisionGate, renderGate, liveBlocks } = await import("./decisions-gate.ts");
		const { applyDecision, decisionPrompt } = await import("../inventory/decisions.ts");
		const source = getSourceAdapter(config.source.stack);
		const targets = await Promise.all(config.target.stacks.map((s) => getTargetAdapter(s)));
		const g = await decisionGate(ledger, config, source, targets, root);
		if (g.global.length && !dry) return { error: `${g.global.length} decision(s) change the whole target: answer them with /br decide first`, lines: g.global.map((d) => `· ${d.id}: ${d.question}`) };
		for (const l of renderGate(g)) progress.log(l);
		const blocked = liveBlocks(ledger, config, source, targets, root);
		// the next open decision is worked out here; Pi shows the dialog and sends the answer back
		const askOnTheSide = async () => {
			const asked = new Set<string>();
			for (;;) {
				const now = await decisionGate(ledger, loadConfig(cp).config, source, targets, root);
				// blocking decisions first, biggest block first
				const next = [...now.scoped.sort((x, y) => y.units.length - x.units.length).map((x) => x.decision), ...now.free].find((d) => !asked.has(d.id));
				if (!next || runDone || progress.stopping || !process.connected) return;
				asked.add(next.id);
				const options = next.options.map((o) => ({ value: o.value, label: o.value === next.recommended ? `${o.label} (recommended)` : o.label, hint: o.hint }));
				const v = await new Promise<string | undefined>((resolve) => {
					answers.set(next.id, resolve);
					send({ type: "ask", id: next.id, prompt: `decision while the run continues — ${decisionPrompt(next)}`, options, recommended: next.recommended });
				});
				if (v === undefined) {
					progress.log(`decision ${next.id} skipped: its units stay blocked (/br decide later)`);
					continue;
				}
				progress.log(`decided ${next.id} = ${v}  ${applyDecision(ledger, loadConfig(cp).config, root, next.id, v, "human (pi, during run)")}`);
			}
		};
		if (!dry && a.hasUI)
			void askOnTheSide()
				.catch((e) => progress.log(`decision dialog failed: ${e?.message ?? e}`))
				.finally(() => send({ type: "decisions-done" }));
		// Scheduler lines → panel steps: "▶ <unit>" starts one, "✓ <unit> accepted" / "■ <unit>: …" / "✗ <unit>: …" end it.
		const log = (l: string) => {
			progress.log(l);
			const t = l.replace(/\x1b\[[0-9;]*m/g, "").trim();
			let m: RegExpExecArray | null;
			if ((m = /^▶ (\S+)/.exec(t))) progress.stepStart(m[1]!);
			else if ((m = /^✓ (\S+) accepted(.*)$/.exec(t))) progress.stepEnd(m[1]!, "done", m[2]!.trim());
			else if ((m = /^⏸ ([^:\s]+): (.*)$/.exec(t))) progress.stepEnd(m[1]!, "skipped", m[2]!);
			else if ((m = /^[■✗] ([^:\s]+): (.*)$/.exec(t))) progress.stepEnd(m[1]!, "failed", m[2]!);
		};
		const since = new Date().toISOString();
		// a run never dies on an error: it starts again after a pause (longer each time), until /br stop
		// (errors in a pass are caught inside the scheduler; what reaches here happened while no unit ran)
		let r: Awaited<ReturnType<typeof runScheduler>>;
		for (let crashes = 0; ; ) {
			try {
				r = await runScheduler({ ledger, config: crashes ? loadConfig(cp).config : config, root, client: new OpenRouterClient(), limit, slice: flag("--slice"), units: flag("--units")?.split(","), dry, force: flags.includes("--force"), log, onLanes: (l) => progress.setLanes(l), onWait: (w) => progress.wait(w), shouldStop: () => progress.stopping, handleSigint: false, blocked, waitForDecisions: a.hasUI });
				break;
			} catch (e: any) {
				if (progress.stopping || dry) throw e;
				const pause = Math.min(600, 15 * 2 ** crashes++);
				progress.log(pc.red(`run error: ${String(e?.message ?? e).slice(0, 600)}\n  the run starts again in ${pause}s (/br stop ends it)`));
				progress.wait("starting again after an error");
				for (let t = 0; t < pause && !progress.stopping; t++) await new Promise((res) => setTimeout(res, 1000));
				progress.wait(undefined);
				if (progress.stopping) throw e;
			}
		}
		const questions = ledger.openQuestions().length;
		const own = ledger.ownDecisions(since).length;
		return { lines: [`${r.accepted} accepted · ${r.quarantined} quarantined · ${r.waiting} still planned · $${r.costUsd.toFixed(3)}`, ...(own ? [`${own} routine question(s) decided from your goals (br questions lists them; /br answer <id> <text> changes one)`] : []), ...(questions ? [`${questions} question(s) for you: /br answer`] : []), "continue with /br run (accepted units are never redone)"] };
	} finally {
		runDone = true;
		release();
		ledger.close();
	}
}

async function main(a: ChildArgs) {
	// no terminal here: every command's output is captured, console lines go into the feed Pi shows
	setOutputHost("ui");
	const capture = (...x: unknown[]) => progress.log(x.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" "));
	console.log = capture;
	console.error = capture;
	console.warn = capture;
	progress.begin(a.job);
	progress.subscribe(() => {
		pending ??= setTimeout(flush, Math.max(0, 200 - (Date.now() - sentAt)));
	});
	let out: { error?: string; lines?: string[] };
	try {
		out = await work(a);
	} catch (e: any) {
		out = { error: e instanceof StoppedError ? "stopped by the user" : String(e?.message ?? e) };
	}
	flush();
	if (!process.connected) process.exit(0);
	process.send!({ type: "done", ok: !out.error, ...out } satisfies FromChild, () => process.exit(0));
}

if (process.env["BR_RUN_CHILD"] === "1" && process.send) void main(JSON.parse(process.argv[2] ?? "{}") as ChildArgs);
