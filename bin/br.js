#!/usr/bin/env node
// Thin launcher: run the TypeScript CLI through tsx so the package needs no build step (Pi loads .ts too).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// the ledger is node's built-in sqlite: an older node fails with an unreadable import error, so say it plainly
const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 22 || (maj === 22 && min < 19)) {
	console.error(`bigrefactor needs node >= 22.19 (this is ${process.versions.node}): nvm install 22 && nvm use 22`);
	process.exit(1);
}
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "src", "cli.ts");
// Resolve tsx from this package, not from the caller's cwd: `br` runs from any workspace directory.
const tsx = import.meta.resolve("tsx");
const r = spawnSync(process.execPath, ["--import", tsx, cli, ...process.argv.slice(2)], { stdio: "inherit", cwd: process.cwd() });
process.exit(r.status ?? 1);
