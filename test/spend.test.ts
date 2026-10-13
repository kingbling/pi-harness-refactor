import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { paidSince, totalSpend } from "../src/spend.ts";

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
});
