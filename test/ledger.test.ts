import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ledger, LedgerError } from "../src/ledger/db.ts";
import { REQUIRED_FOR_ACCEPTED } from "../src/ledger/schema.ts";

function seed() {
	const l = new Ledger(":memory:");
	l.upsertFile({ path: "src/A.php", hash: "h1", lang: "php", loc: 10 });
	l.upsertFile({ path: "src/Dead.php", hash: "h2", lang: "php", loc: 5 });
	l.upsertSymbol({ id: "src/A.php::A::calc", path: "src/A.php", kind: "method", name: "A::calc" });
	l.upsertSymbol({ id: "src/A.php::A::fmt", path: "src/A.php", kind: "method", name: "A::fmt" });
	l.upsertSymbol({ id: "src/Dead.php::Dead::run", path: "src/Dead.php", kind: "method", name: "Dead::run" });
	return l;
}

describe("ledger invariants", () => {
	it("cannot accept unresolved weak tests even when every gate evidence type exists", () => {
		const l = seed();
		l.createUnit({ id: "U1", tier: "T1", symbolIds: [], meta: { weakTestsNote: "tests compare literals" } });
		for (const type of REQUIRED_FOR_ACCEPTED) l.addEvidence("U1", type, {});
		expect(() => l.transitionUnit("U1", "accepted")).toThrow(/unresolved weak tests/);
		expect(l.getUnit("U1")!.state).toBe("planned");
		l.updateUnit("U1", { meta: { weakTestsNote: undefined } });
		l.transitionUnit("U1", "accepted");
		expect(l.getUnit("U1")!.state).toBe("accepted");
		l.close();
	});
	it("starts with every symbol discovered and unaccounted", () => {
		const l = seed();
		const s = l.status();
		expect(s.invariants.ok).toBe(true);
		expect(s.symbols["discovered"]).toBe(3);
		expect(s.unaccounted).toBe(3);
	});

	it("clusters symbols into a unit and rejects illegal transitions", () => {
		const l = seed();
		l.createUnit({ id: "U1", tier: "T1", symbolIds: ["src/A.php::A::calc", "src/A.php::A::fmt"] });
		expect(l.getSymbol("src/A.php::A::calc")!.state).toBe("clustered");
		expect(() => l.transitionSymbol("src/A.php::A::calc", "accepted")).toThrow(LedgerError);
	});

	it("drops a clustered, not-started symbol when a re-inventory finds its file dead or framework", () => {
		const l = seed();
		l.createUnit({ id: "U1", tier: "T1", symbolIds: ["src/A.php::A::calc", "src/A.php::A::fmt"] });
		l.markDeadCode("src/A.php", "no inbound references");
		expect(l.getSymbol("src/A.php::A::calc")!.state).toBe("dropped");
		l.createUnit({ id: "U2", tier: "T1", symbolIds: ["src/Dead.php::Dead::run"] });
		l.markFramework("src/Dead.php", "legacy framework");
		expect(l.getSymbol("src/Dead.php::Dead::run")!.state).toBe("dropped");
	});

	it("cannot reach tested without truth + ported-test evidence", () => {
		const l = seed();
		l.createUnit({ id: "U1", tier: "T1", symbolIds: ["src/A.php::A::calc"] });
		l.prove({ unitId: "U1", srcSymbol: "src/A.php::A::calc", op: "moved", targetSymbols: ["src/a.ts::calc"], why: "1:1 port" });
		expect(l.getSymbol("src/A.php::A::calc")!.state).toBe("mapped");
		expect(() => l.transitionSymbol("src/A.php::A::calc", "tested")).toThrow(/needs evidence/);
		l.addEvidence("U1", "truth_green_on_old", { cases: 3 });
		l.addEvidence("U1", "ported_tests_green", { passed: 3 });
		l.transitionSymbol("src/A.php::A::calc", "tested");
		expect(l.getSymbol("src/A.php::A::calc")!.state).toBe("tested");
	});

	it("a symbol re-proved with another outcome moves through in_progress; a refused prove keeps the earlier move", () => {
		const l = seed();
		l.createUnit({ id: "U1", tier: "T1", symbolIds: ["src/A.php::A::calc"] });
		l.prove({ unitId: "U1", srcSymbol: "src/A.php::A::calc", op: "moved", targetSymbols: ["src/a.ts::calc"], why: "port" });
		l.prove({ unitId: "U1", srcSymbol: "src/A.php::A::calc", op: "dropped", why: "the view does it now" });
		expect(l.getSymbol("src/A.php::A::calc")!.state).toBe("dropped");
		l.prove({ unitId: "U1", srcSymbol: "src/A.php::A::calc", op: "moved", targetSymbols: ["src/a.ts::calc"], why: "needed after all" });
		expect(l.getSymbol("src/A.php::A::calc")!.state).toBe("mapped");
		l.transitionSymbol("src/A.php::A::calc", "quarantined", "test");
		expect(() => l.prove({ unitId: "U1", srcSymbol: "src/A.php::A::calc", op: "dropped", why: "x" })).toThrow(/illegal/);
		expect(l.movesOf("src/A.php::A::calc").map((m) => m.op)).toEqual(["moved"]);
	});

	it("first-pass accepted counts units with one implementer attempt (tester and reviewer attempts aside)", () => {
		const l = seed();
		l.createUnit({ id: "U1", tier: "T1", symbolIds: [] });
		for (const role of ["test", "implement", "review"]) l.startAttempt("U1", role);
		l.db.prepare("UPDATE units SET state = 'accepted'").run();
		expect(l.status().firstPassAccepted).toBe(1);
		l.startAttempt("U1", "escalate");
		expect(l.status().firstPassAccepted).toBe(0);
	});

	it("unit acceptance requires all gate evidence and proof for every symbol", () => {
		const l = seed();
		l.createUnit({ id: "U1", tier: "T1", symbolIds: ["src/A.php::A::calc", "src/A.php::A::fmt"] });
		l.prove({ unitId: "U1", srcSymbol: "src/A.php::A::calc", op: "moved", targetSymbols: ["src/a.ts::calc"], why: "port" });
		for (const t of ["symbolproof_ok", "build_ok", "lint_ok", "rules_ok", "antigaming_ok", "structure_ok", "wired_ok", "ported_tests_green", "truth_green_on_old"] as const) l.addEvidence("U1", t);
		// A::fmt is still only clustered → unproven
		expect(() => l.transitionUnit("U1", "accepted")).toThrow(/unproven symbols/);
		l.prove({ unitId: "U1", srcSymbol: "src/A.php::A::fmt", op: "dropped", why: "formatting now done by Intl in the view layer" });
		l.transitionUnit("U1", "accepted");
		expect(l.getSymbol("src/A.php::A::calc")!.state).toBe("accepted");
		expect(l.getSymbol("src/A.php::A::fmt")!.state).toBe("dropped");
		expect(l.fileState("src/A.php")).toBe("accepted");
	});

	it("prove requires a why and target symbols for non-drop ops", () => {
		const l = seed();
		l.createUnit({ id: "U1", tier: "T1", symbolIds: ["src/A.php::A::calc"] });
		expect(() => l.prove({ unitId: "U1", srcSymbol: "src/A.php::A::calc", op: "moved", why: "x" })).toThrow(/requires targetSymbols/);
		expect(() => l.prove({ unitId: "U1", srcSymbol: "src/A.php::A::calc", op: "dropped", why: " " })).toThrow(/why is required/);
	});

	it("dead code drops its symbols with a reason and keeps the sum invariant", () => {
		const l = seed();
		l.markDeadCode("src/Dead.php", "no static or literal references");
		expect(l.fileState("src/Dead.php")).toBe("dead_code");
		expect(l.getSymbol("src/Dead.php::Dead::run")!.state).toBe("dropped");
		expect(l.checkInvariants().ok).toBe(true);
		const why = l.why("src/Dead.php::Dead::run");
		expect(why?.kind).toBe("symbol");
		expect(why && why.kind === "symbol" ? why.transitions.at(-1)?.reason : "").toMatch(/dead code/);
	});
});

describe("ledger shared between processes", () => {
	it("a write while another process holds the lock waits for it instead of failing at once", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "br-ledger-")), "ledger.sqlite");
		new Ledger(path).close();
		const l = new Ledger(path);
		expect(l.db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 10_000 });
		// another process takes the write lock, says so, and lets go after a moment
		const holder = spawn(process.execPath, ["-e", `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(${JSON.stringify(path)}); db.exec("BEGIN IMMEDIATE"); db.exec("INSERT INTO meta(key, value) VALUES ('held', '1')"); console.log("locked"); setTimeout(() => { db.exec("COMMIT"); db.close(); }, 400);`]);
		const exited = new Promise((r) => holder.on("exit", r));
		await new Promise<void>((r) => holder.stdout.on("data", (d) => String(d).includes("locked") && r()));
		const t0 = Date.now();
		l.setMeta("mine", "2");
		expect(Date.now() - t0).toBeGreaterThan(100);
		expect(l.getMeta("held")).toBe("1");
		expect(l.getMeta("mine")).toBe("2");
		l.close();
		await exited;
	});
});
