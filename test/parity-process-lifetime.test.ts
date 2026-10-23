import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

it("stops observation readers when the harness is killed without an exit event", async () => {
	const dir = mkdtempSync(join(tmpdir(), "br-observation-lifetime-")), marker = join(dir, "owned-reader.json");
	const reader = `require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,parent:process.ppid}));setInterval(()=>{},100);`;
	const recipe = { dir: ".", ready: "http://localhost:1", start: { cmd: process.execPath, args: [] }, dump: { cmd: process.execPath, args: ["-e", reader] } };
	const code = `import {dumpData} from ${JSON.stringify(new URL('../src/run/parity.ts',import.meta.url).href)};await dumpData(${JSON.stringify(recipe)},${JSON.stringify(dir)});`;
	const host = spawn(process.execPath, ["--import", new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).pathname, "--input-type=module", "-e", code], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
	let stderr = "", owned: { pid: number; parent: number } | undefined;
	host.stderr.on("data", b => { stderr = (stderr + b).slice(-2000); });
	try {
		for (let i=0;i<200 && !existsSync(marker);i++) { if (host.exitCode!==null) throw new Error(`Harness exited before reader startup: ${stderr}`); await sleep(50); }
		expect(existsSync(marker), stderr).toBe(true);
		owned = JSON.parse(readFileSync(marker, "utf8"));
		expect(alive(owned!.pid)).toBe(true);
		const terminal = new Promise(resolve => host.once("exit", resolve)); host.kill("SIGKILL"); await terminal;
		for (let i=0;i<100 && alive(owned!.pid);i++) await sleep(50);
		expect(alive(owned!.pid), "Native reader outlived its killed harness").toBe(false);
	} finally {
		// Only this test's recorded native reader, dedicated host group, and its direct guardian are eligible.
		if (owned) { try { process.kill(owned.pid, "SIGKILL"); } catch {} if (owned.parent!==host.pid) try { process.kill(-owned.parent, "SIGKILL"); } catch {} }
		if (host.pid) try { process.kill(-host.pid, "SIGKILL"); } catch {}
		host.stdout.destroy(); host.stderr.destroy(); rmSync(dir, { recursive: true, force: true });
	}
}, 20_000);
