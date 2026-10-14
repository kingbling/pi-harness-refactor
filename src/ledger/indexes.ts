import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const building = new Map<string, Promise<void>>();

/**
 * The big-table indexes (schema.ts BIG_TABLE_INDEXES), built in a worker thread: an index build writes, so a run
 * waits for this (awaited, Pi stays live) before it starts writing to the ledger. Never rejects: without the
 * indexes the queries are only slower.
 */
export function ensureLedgerIndexes(path: string): Promise<void> {
	if (!existsSync(path)) return Promise.resolve();
	let p = building.get(path);
	if (!p) {
		p = new Promise<void>((resolve) => {
			try {
				// the package has no build step: the worker loads its .ts through tsx, like bin/br.js does
				const w = new Worker(new URL("./index-worker.ts", import.meta.url), { workerData: { path }, execArgv: ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href] });
				w.once("message", () => resolve());
				w.once("error", () => resolve());
				w.once("exit", () => resolve());
			} catch {
				resolve();
			}
		});
		building.set(path, p);
	}
	return p;
}
