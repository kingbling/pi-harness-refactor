import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireRunLock, liveRun } from "../src/run/run-lock.ts";

let root: string;
const lock = () => join(root, ".bigrefactor/run.lock");
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "br-atomic-lock-")); mkdirSync(join(root, ".bigrefactor")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const worker = [
	"import { writeFileSync, existsSync } from 'node:fs';",
	"import { acquireRunLock } from " + JSON.stringify(new URL("../src/run/run-lock.ts", import.meta.url).href) + ";",
	"const [root,name]=process.argv.slice(1), kill=process.kill.bind(process);",
	// Deterministically reproduce both contenders observing the same stale PID before either may write.
	"process.kill=(pid,...args)=>{if(pid===99999999){writeFileSync(root+'/'+name+'.ready','');while(!existsSync(root+'/go'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);throw Object.assign(new Error('stale'),{code:'ESRCH'});}return kill(pid,...args)};",
	"let release;try{release=acquireRunLock(root);console.log(JSON.stringify({acquired:true}));}catch(e){console.log(JSON.stringify({acquired:false,error:e.message}));}",
	"while(!existsSync(root+'/release'))await new Promise(r=>setTimeout(r,5));release?.();",
].join("\n");

function start(name: string) {
	const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
	const child = spawn(process.execPath, ["--import", loader, "--input-type=module", "-e", worker, root, name], { stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	const result = new Promise<{ acquired: boolean; error?: string }>((resolve, reject) => {
		child.stdout!.on("data", (c: Buffer) => { output += c.toString(); if (output.includes("\n")) resolve(JSON.parse(output.split("\n")[0]!)); });
		child.on("error", reject);
	});
	return { child, result, done: once(child, "close") };
}

async function waitFor(condition: () => boolean) {
	const deadline = Date.now() + 10_000;
	while (!condition()) { if (Date.now() > deadline) throw new Error("lock worker rendezvous timed out"); await new Promise((r) => setTimeout(r, 5)); }
}

describe("atomic workspace ownership", () => {
	it("only one process can recover a stale lock, even when both already observed it as stale", async () => {
		writeFileSync(lock(), "99999999");
		const jobs = [start("a"), start("b")];
		try {
			await waitFor(() => ["a", "b"].every((n) => existsSync(join(root, n + ".ready"))));
			writeFileSync(join(root, "go"), "");
			const results = await Promise.all(jobs.map((j) => j.result));
			expect(results.filter((r) => r.acquired)).toHaveLength(1);
			expect(results.find((r) => !r.acquired)?.error).toMatch(/already going/);
		} finally {
			writeFileSync(join(root, "go"), ""); writeFileSync(join(root, "release"), "");
			await Promise.all(jobs.map((j) => j.done));
		}
		expect(liveRun(root)).toBeUndefined();
	}, 15_000);

	it("recovers after the owning process crashes, and release is idempotent", async () => {
		const job = start("owner");
		try {
			expect(await job.result).toEqual({ acquired: true });
			job.child.kill("SIGKILL"); await job.done;
			const release = acquireRunLock(root);
			expect(liveRun(root)).toBe(process.pid);
			expect(() => acquireRunLock(root)).toThrow(/already going/);
			release(); release();
			expect(liveRun(root)).toBeUndefined();
		} finally { job.child.kill("SIGKILL"); await job.done; }
	}, 15_000);

	it("does not strand the lease when writing its PID fails", () => {
		mkdirSync(lock());
		expect(() => acquireRunLock(root)).toThrow();
		rmSync(lock(), { recursive: true });
		const release = acquireRunLock(root);
		expect(liveRun(root)).toBe(process.pid);
		release();
	});
	it("keeps exclusive ownership even if its PID file disappears before release", () => {
		const release = acquireRunLock(root);
		rmSync(lock());
		expect(() => acquireRunLock(root)).toThrow(/already going/);
		release();
		const next = acquireRunLock(root);
		expect(liveRun(root)).toBe(process.pid);
		next();
	});

	it("respects the PID lock of an older plugin process without creating a second owner", () => {
		writeFileSync(lock(), String(process.pid));
		expect(() => acquireRunLock(root)).toThrow(/already going/);
		expect(existsSync(lock() + ".sqlite")).toBe(false);
		expect(liveRun(root)).toBe(process.pid);
	});
});
