import { parentPort } from "node:worker_threads";
import { Ledger } from "../ledger/db.ts";
import { loadConfig, findConfigPath } from "../config.ts";
import { headOf } from "../git.ts";
import { forecast } from "../run/forecast.ts";
import { totalSpend } from "../spend.ts";

/**
 * The footer's totals, read off Pi's thread: node:sqlite holds the thread for every query, and the forecast on a big
 * ledger takes 0.1–0.4 s (more while the disk is busy with worktree copies), which froze the Pi UI on each refresh.
 */
parentPort?.on("message", async (m: { ledgerPath: string; root: string; running: boolean }) => {
	// main's HEAD now: a strict parity pass for it is what lets the footer say 100%
	let targetHead: string | undefined;
	try {
		targetHead = await headOf(loadConfig(findConfigPath(m.root)).config.target.path);
	} catch {
		/* no config here: no pass counts */
	}
	let ledger: Ledger | undefined;
	try {
		ledger = new Ledger(m.ledgerPath);
		const f = forecast(ledger, { targetHead });
		parentPort!.postMessage({ ok: true, d: { accepted: f.units.accepted, quarantined: f.units.quarantined, waiting: f.units.waiting, questions: ledger.ownerQuestions(m.running).length, spentUsd: totalSpend(m.root).usd, forecast: f } });
	} catch (e) {
		parentPort!.postMessage({ ok: false, error: String((e as Error)?.message ?? e) });
	} finally {
		ledger?.close();
	}
});
