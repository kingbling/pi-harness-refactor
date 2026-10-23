import { describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger/db.ts";
import { forecast, renderForecast, renderForecastLine, renderParityShare } from "../src/run/forecast.ts";

const HEAD = "a".repeat(40);

describe("forecast verification provenance", () => {
 it("counts a strict pass only for main's current commit, with every unit accepted and nothing compared since", () => {
  const ledger = new Ledger(":memory:");
  try {
   ledger.createUnit({ id: "U1", tier: "T0", symbolIds: [] });
   ledger.updateUnit("U1", { meta: { loc: 100, slice: "jobs" } });
   ledger.db.exec("UPDATE units SET state='accepted'");
   ledger.db.prepare("INSERT INTO parity_runs(slice,outcome,started_at) VALUES ('jobs','same','2026-10-01T00:00:00Z')").run();
   ledger.setMeta("parity_verification", JSON.stringify({ status: "passed", targetCommit: HEAD, at: "2026-10-01T01:00:00Z" }));
   const now = forecast(ledger, { targetHead: HEAD });
   expect(now.parity.verified).toBe(true);
   expect(now.done).toBe(1);
   expect(renderForecastLine(now)).toContain("progress 100% done");
   expect(renderParityShare(now)).toContain("verified @ aaaaaaaaa");
   // a caller that does not know main's HEAD, or a newer commit: history only
   expect(forecast(ledger).parity.verified).toBe(false);
   const moved = forecast(ledger, { targetHead: "b".repeat(40) });
   expect(moved.parity.verified).toBe(false);
   expect(moved.done).toBeLessThan(1);
   expect(renderParityShare(moved)).toContain("last strict replay passed @ aaaaaaaaa (historical)");
   // a slice compared again after the pass (a new suite, a reopened unit) opens it again
   ledger.db.prepare("INSERT INTO parity_runs(slice,outcome,started_at) VALUES ('jobs','same','2026-10-01T02:00:00Z')").run();
   expect(forecast(ledger, { targetHead: HEAD }).parity.verified).toBe(false);
  } finally { ledger.close(); }
 });

 it("never shows 100% while a unit is open, and never more than 99% without a pass", () => {
  const ledger = new Ledger(":memory:");
  try {
   ledger.createUnit({ id: "U1", tier: "T0", symbolIds: [] });
   ledger.createUnit({ id: "U2", tier: "T0", symbolIds: [] });
   ledger.updateUnit("U1", { meta: { loc: 100, slice: "jobs" } });
   ledger.updateUnit("U2", { meta: { loc: 100, slice: "jobs" } });
   ledger.db.exec("UPDATE units SET state='accepted' WHERE id='U1'");
   ledger.setMeta("parity_verification", JSON.stringify({ status: "passed", targetCommit: HEAD, at: "2026-10-01T01:00:00Z" }));
   expect(forecast(ledger, { targetHead: HEAD }).parity.verified).toBe(false);
   ledger.db.exec("UPDATE units SET state='accepted'");
   ledger.db.prepare("INSERT INTO parity_runs(slice,outcome,started_at) VALUES ('jobs','same','2026-10-01T02:00:00Z')").run();
   const all = forecast(ledger, { targetHead: HEAD });
   // all code migrated and every slice same, but the last strict replay is older than that comparison
   expect(all.progress).toBe(1);
   expect(all.done).toBe(0.99);
   expect(renderForecastLine(all)).toContain("progress 99% done (migrated 100% · parity 1/1 slices same, not verified");
  } finally { ledger.close(); }
 });

 it("does not accept incomplete or malformed metadata as a current pass", () => {
  const ledger = new Ledger(":memory:");
  try {
   for (const metadata of ['{"status":"passed"}', `{"status":"passed","targetCommit":"${HEAD}"}`, 'null', '[]', '{broken']) {
    ledger.setMeta("parity_verification", metadata);
    const result = forecast(ledger, { targetHead: HEAD });
    expect(result.parity.verified).toBe(false);
    expect(result.done).toBeLessThan(1);
    expect(() => renderForecast(result)).not.toThrow();
   }
  } finally { ledger.close(); }
 });

 it("counts only current slices and their latest comparisons", () => {
  const ledger = new Ledger(":memory:");
  try {
   ledger.createUnit({ id: "U1", tier: "T0", symbolIds: [] });
   ledger.updateUnit("U1", { meta: { loc: 10, slice: "current" } });
   const add = (slice: string, outcome: string) => ledger.db.prepare("INSERT INTO parity_runs(slice,outcome,started_at) VALUES (?,?,?)").run(slice, outcome, "2026-10-01T00:00:00Z");
   add("retired1", "same"); add("retired2", "same"); add("current", "same");
   let result = forecast(ledger);
   expect(result.parity).toMatchObject({ slices: 1, same: 1, verified: false });
   expect(() => renderForecast(result)).not.toThrow();
   add("current", "differs"); result = forecast(ledger);
   expect(result.parity.same).toBe(0);
   expect(renderParityShare(result)).toContain("parity 0/1 slices same, not verified");
  } finally { ledger.close(); }
 });
});
