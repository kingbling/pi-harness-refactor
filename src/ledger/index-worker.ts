import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { BIG_TABLE_INDEXES } from "./schema.ts";

/** Builds the big-table indexes off Pi's thread (seconds on an old ledger, a no-op once they exist). */
const db = new DatabaseSync(workerData.path as string, { timeout: 60_000 });
try {
	db.exec(BIG_TABLE_INDEXES);
	parentPort?.postMessage({ ok: true });
} catch (e) {
	parentPort?.postMessage({ ok: false, error: String((e as Error)?.message ?? e) });
} finally {
	db.close();
}
