#!/usr/bin/env node
// Thin launcher: run the TypeScript CLI through tsx so the package needs no build step (Pi loads .ts too).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "src", "cli.ts");
// Resolve tsx from this package, not from the caller's cwd: `br` runs from any workspace directory.
const tsx = import.meta.resolve("tsx");
const r = spawnSync(process.execPath, ["--import", tsx, cli, ...process.argv.slice(2)], { stdio: "inherit", cwd: process.cwd() });
process.exit(r.status ?? 1);
