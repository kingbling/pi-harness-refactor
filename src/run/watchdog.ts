import { appendFileSync, mkdirSync } from "node:fs";
import { Session } from "node:inspector";
import { join } from "node:path";

/**
 * Freeze watchdog, in the run process and in Pi while a run goes on: anything that holds Pi's event loop freezes
 * the whole UI. A timer that should fire every 200 ms measures how late it came; a delay of
 * more than a second is written to .bigrefactor/blocked.log with the step the run was in, so a freeze can be traced.
 * The step is process-wide (whatever lane set it last), so the line also names what really held the thread: V8's
 * sampling profiler runs all along (one sample every 20 ms, cheap) and the samples of the held stretch name the
 * functions it was in.
 */
let step = "starting";

/** What the run does now (cheap: one assignment). The watchdog names it when the loop was blocked. */
export function setStep(label: string): void {
	step = label;
}

type Frame = { functionName: string; url: string; lineNumber: number };
type Profile = { nodes: Array<{ id: number; callFrame: Frame; children?: number[] }>; startTime: number; endTime: number; samples?: number[]; timeDeltas?: number[] };

const SAMPLE_US = 20_000;

/** V8's sampling profiler on this thread; `take` hands over the samples so far and starts a fresh profile. */
function sampler(): { take(cb: (p: Profile | undefined) => void): void; stop(): void } | undefined {
	try {
		const s = new Session();
		s.connect();
		s.post("Profiler.enable");
		s.post("Profiler.setSamplingInterval", { interval: SAMPLE_US });
		s.post("Profiler.start");
		return {
			take(cb) {
				s.post("Profiler.stop", (err, r) => {
					s.post("Profiler.start");
					cb(err ? undefined : (r as { profile: Profile }).profile);
				});
			},
			stop() {
				s.post("Profiler.stop", () => s.disconnect());
			},
		};
	} catch {
		return undefined; // no inspector in this runtime: the step alone names the freeze
	}
}

const SPECIAL: Record<string, string> = {
	"(idle)": "nothing (the thread was idle: the machine did not run this process)",
	"(program)": "native code outside JavaScript",
	"(garbage collector)": "garbage collection",
};
const short = (f: Frame) => `${f.functionName || "(anonymous)"}${f.url ? ` (${f.url.replace(/^file:\/\//, "").split("/").slice(-2).join("/")}:${f.lineNumber + 1})` : ""}`;

/**
 * What the samples of the last `ms` of `p` were in, most samples first: the innermost frame, and the plugin's own
 * function (src/) it was called from when that is another one. Undefined when there are no samples to read.
 */
export function heldBy(p: Profile, ms: number): string | undefined {
	if (!p.samples?.length || !p.timeDeltas) return undefined;
	const byId = new Map(p.nodes.map((n) => [n.id, n]));
	const parent = new Map<number, number>();
	for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
	const from = p.endTime - ms * 1000 - SAMPLE_US;
	const counts = new Map<string, number>();
	let t = p.startTime;
	let n = 0;
	p.samples.forEach((id, i) => {
		t += p.timeDeltas![i] ?? 0;
		if (t < from) return;
		const leaf = byId.get(id)!.callFrame;
		let what = SPECIAL[leaf.functionName] ?? short(leaf);
		// the plugin's own function that was running, when the leaf is a library or a builtin
		for (let at: number | undefined = id; at !== undefined && !SPECIAL[leaf.functionName]; at = parent.get(at)) {
			const f = byId.get(at)!.callFrame;
			if (/\/src\/[^/]+\/.*\.ts$/.test(f.url) || /\/src\/[^/]+\.ts$/.test(f.url)) {
				if (at !== id) what += ` ← ${short(f)}`;
				break;
			}
		}
		counts.set(what, (counts.get(what) ?? 0) + 1);
		n++;
	});
	if (!n) return undefined;
	return [...counts]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 2)
		.map(([w, c]) => `${w} ${Math.round((c / n) * 100)}%`)
		.join("; ");
}

/** Start watching; returns the stop function. */
export function startWatchdog(root: string, log: (line: string) => void, o: { everyMs?: number; blockedMs?: number; step?: string } = {}): () => void {
	const every = o.everyMs ?? 200;
	const limit = o.blockedMs ?? 1000;
	const prof = sampler();
	let profiledSince = performance.now();
	let last = performance.now();
	const write = (line: string) => {
		try {
			mkdirSync(join(root, ".bigrefactor"), { recursive: true });
			appendFileSync(join(root, ".bigrefactor", "blocked.log"), line + "\n");
		} catch {
			/* the log is a help, never a reason to fail */
		}
		log(line);
	};
	const timer = setInterval(() => {
		const now = performance.now();
		const late = now - last - every;
		last = now;
		if (late <= limit) {
			// a fresh profile each minute: the samples kept stay few
			if (prof && now - profiledSince > 60_000) (prof.take(() => {}), (profiledSince = now));
			return;
		}
		// the run lives in its own process under Pi: its freezes do not hold Pi's screen
		const who = process.env["BR_RUN_CHILD"] === "1" ? "the run process" : "Pi";
		const line = `${new Date().toISOString()} ${who} was blocked ${(late / 1000).toFixed(1)} s (last step: ${o.step ?? step})`;
		if (!prof) return write(line);
		profiledSince = now;
		prof.take((p) => {
			const held = p && heldBy(p, late);
			write(held ? `${line}; held by: ${held}` : line);
		});
	}, every);
	timer.unref();
	return () => {
		clearInterval(timer);
		prof?.stop();
	};
}
