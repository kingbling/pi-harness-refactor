import { parentPort } from "node:worker_threads";
import { Ledger } from "../ledger/db.ts";
import { forecast } from "../run/forecast.ts";
import { totalSpend } from "../spend.ts";

/**
 * The footer's totals, read off Pi's thread: node:sqlite holds the thread for every query, and the forecast on a big
 * ledger takes 0.1–0.4 s (more while the disk is busy with worktree copies), which froze the Pi UI on each refresh.
 */
parentPort?.on("message", (m: { ledgerPath: string; root: string; running: boolean }) => {
	let ledger: Ledger | undefined;
	try {
		ledger = new Ledger(m.ledgerPath);
		const f = forecast(ledger);
		parentPort!.postMessage({ ok: true, d: { accepted: f.units.accepted, quarantined: f.units.quarantined, waiting: f.units.waiting, questions: ledger.ownerQuestions(m.running).length, spentUsd: totalSpend(m.root).usd, forecast: f } });
	} catch (e) {
		parentPort!.postMessage({ ok: false, error: String((e as Error)?.message ?? e) });
	} finally {
		ledger?.close();
	}
});
