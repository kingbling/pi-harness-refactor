import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { canonicalData, compareRuns, runSteps, type DataDump, type Step } from "../src/run/parity-check.ts";

describe("initial database observations", () => {
	it("compares tables as multisets, preserving duplicates and ordered JSON arrays within a row", () => {
		const a = { users: [{ name: "B", id: 2 }, { name: "A", id: 1 }, { name: "A", id: 1 }], settings: [{ payload: { z: 1, a: [2, 1] } }] };
		const b = { settings: [{ payload: { a: [2, 1], z: 1 } }], users: [{ id: 1, name: "A" }, { id: 2, name: "B" }, { id: 1, name: "A" }] };
		expect(canonicalData(a)).toEqual(canonicalData(b));
		expect(canonicalData(a).users).toHaveLength(3);
		expect(canonicalData(a).settings).toEqual([{ payload: { a: [2, 1], z: 1 } }]);
		expect(() => canonicalData({ broken: "not rows" } as unknown as DataDump)).toThrow(/array of rows/);
	});
	it("captures the seeded data before the first HTTP action changes it", async () => {
		const data = { users: [{ id: 1, name: "Before" }] };
		const server = createServer((_q, r) => { data.users[0]!.name = "After"; r.end("ok"); }).listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		let initial: DataDump | undefined;
		const step: Step = { id: "change", route: "POST /change", path: "/change", method: "POST", compare: "data" };
		try {
			const results = await runSteps([step], { side: "legacy", base: () => `http://127.0.0.1:${(server.address() as { port: number }).port}`, strict: true, dump: () => structuredClone(data), onInitialData: (d) => { initial = d; } });
			expect(initial).toEqual({ users: [{ id: 1, name: "Before" }] });
			expect(results[0]?.data).toEqual({ users: { added: [{ id: 1, name: "After" }], removed: [{ id: 1, name: "Before" }] } });
		} finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
	});
	it("captures and normalizes initial data for route-less executable suites too", async () => {
		let initial: DataDump | undefined;
		await runSteps([], { side: "legacy", base: () => "http://localhost:4000", baseUrls: ["http://localhost:4000"], dump: () => ({ links: [{ url: "http://localhost:4000/a" }] }), onInitialData: (d) => { initial = d; } });
		expect(initial?.links).toHaveLength(1);
		expect(JSON.stringify(initial)).not.toContain("localhost:4000");
	});
	it("preserves JSON response shape when a business field happens to be named base64", async () => {
		const server = createServer((q, r) => { r.setHeader("content-type", "application/json"); r.end(JSON.stringify(q.url === "/old" ? { base64: "SGVsbG8=" } : "Hello")); }).listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
		const step: Step = { id: "json", route: "GET /value", method: "GET", path: "/old", compare: "data", target: { path: "/new" } };
		try {
			const old = await runSteps([step], { side: "legacy", base: () => base, strict: true });
			const target = await runSteps([step], { side: "target", base: () => base, strict: true });
			expect(old[0]!.body).toEqual({ base64: "SGVsbG8=" });
			expect(target[0]!.body).toBe("Hello");
			expect(compareRuns([step], old, old, target, false, true).diffs).toMatchObject([{ kind: "body" }]);
		} finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
	});
});
