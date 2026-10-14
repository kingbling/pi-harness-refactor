import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSpend, paidSince, totalSpend } from "../src/spend.ts";

describe("the spend log", () => {
	it("counts lines added since the last read, a line still being written once it is whole, and starts over when the log is replaced", () => {
		const root = mkdtempSync(join(tmpdir(), "br-spend-"));
		mkdirSync(join(root, ".bigrefactor"));
		const f = join(root, ".bigrefactor", "spend.jsonl");
		const line = (at: string, usd: number, source: string, subscription?: boolean) => JSON.stringify({ at, usd, source, model: "m", ...(subscription ? { subscription } : {}) }) + "\n";
		writeFileSync(f, line("2026-10-01T00:00:00Z", 1, "unit:U1") + line("2026-10-02T00:00:00Z", 2, "parity:x", true));
		expect(totalSpend(root)).toEqual({ usd: 3, bySource: { unit: 1, parity: 2 }, since: "2026-10-01T00:00:00Z" });
		const next = line("2026-10-03T00:00:00Z", 4, "unit:U2");
		appendFileSync(f, next.slice(0, 10)); // half written
		expect(totalSpend(root).usd).toBe(3);
		appendFileSync(f, next.slice(10));
		expect(totalSpend(root).usd).toBe(7);
		expect(paidSince(root, "2026-10-02T00:00:00Z")).toBe(4); // the subscription call is not paid
		writeFileSync(f, line("2026-10-05T00:00:00Z", 0.5, "unit:U3"));
		expect(totalSpend(root)).toEqual({ usd: 0.5, bySource: { unit: 0.5 }, since: "2026-10-05T00:00:00Z" });
	});

	it("the first read of a big log goes in slices off the sync path, a line cut inside a multi-byte character included", async () => {
		const root = mkdtempSync(join(tmpdir(), "br-spend-"));
		mkdirSync(join(root, ".bigrefactor"));
		const f = join(root, ".bigrefactor", "spend.jsonl");
		// ~10 MB: three slices; every line carries "é" so slice ends fall inside characters too
		const lines = Array.from({ length: 60_000 }, (_, i) => JSON.stringify({ at: `2026-10-01T00:00:${String(i % 60).padStart(2, "0")}Z`, usd: 0.25, source: `unit:Ué${i}`, model: "m", pad: "x".repeat(100) }) + "\n");
		writeFileSync(f, lines.join(""));
		await loadSpend(root);
		expect(totalSpend(root)).toEqual({ usd: 15_000, bySource: { unit: 15_000 }, since: "2026-10-01T00:00:00Z" });
		// new lines after the slices are read by the sync path as before
		appendFileSync(f, JSON.stringify({ at: "2026-10-02T00:00:00Z", usd: 1, source: "parity:x" }) + "\n");
		expect(totalSpend(root).usd).toBe(15_001);
		await loadSpend(root); // nothing big left: no second read
		expect(totalSpend(root).usd).toBe(15_001);
	});

	it("a sync read while the slices load takes over without counting a line twice", async () => {
		const root = mkdtempSync(join(tmpdir(), "br-spend-"));
		mkdirSync(join(root, ".bigrefactor"));
		const f = join(root, ".bigrefactor", "spend.jsonl");
		writeFileSync(f, Array.from({ length: 60_000 }, () => JSON.stringify({ at: "2026-10-01T00:00:00Z", usd: 0.5, source: "unit:U1", pad: "x".repeat(100) }) + "\n").join(""));
		const loading = loadSpend(root);
		await new Promise((r) => setImmediate(r));
		expect(totalSpend(root).usd).toBe(30_000);
		await loading;
		expect(totalSpend(root).usd).toBe(30_000);
	});
});

