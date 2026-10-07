import { describe, expect, it } from "vitest";
import { isCapacityError, isTransientError, promptWithRecovery } from "../src/sessions/spawn.ts";

/** Scripted Pi session: each send() ends with the next scripted assistant error (undefined = clean turn). */
function scripted(errors: Array<string | undefined>) {
	const sent: string[] = [];
	const events: any[] = [];
	const slept: number[] = [];
	let pending: string | undefined;
	let tierSwitches = 0;
	return {
		sent,
		events,
		slept,
		tierSwitches: () => tierSwitches,
		opts: {
			send: async (p: string) => {
				sent.push(p);
				pending = errors.shift();
			},
			takeError: () => {
				const e = pending;
				pending = undefined;
				return e;
			},
			toDefaultTier: async () => {
				tierSwitches++;
			},
			record: (e: object) => events.push(e),
			sleep: async (ms: number) => {
				slept.push(ms);
			},
		},
	};
}

describe("session error recovery", () => {
	it("classifies Pi's leftover network errors as transient, not capacity", () => {
		for (const m of ["terminated", "Connection error.", "Request timed out.", "read ECONNRESET", "socket hang up"]) {
			expect(isTransientError(m)).toBe(true);
			expect(isCapacityError(m)).toBe(false);
		}
		expect(isTransientError("Flex processing is temporarily unavailable. Please try again later or use standard processing.")).toBe(false);
		expect(isTransientError("Invalid API key")).toBe(false);
	});

	it("continues the same session after a drop, with backoff, without a tier fallback", async () => {
		const s = scripted(["terminated", "Connection error.", undefined]);
		const err = await promptWithRecovery({ prompt: "TASK", ...s.opts });
		expect(err).toBeUndefined();
		expect(s.sent[0]).toBe("TASK");
		expect(s.sent.slice(1).every((p) => /cut off by a network error/.test(p))).toBe(true);
		expect(s.slept).toEqual([15_000, 60_000]);
		expect(s.tierSwitches()).toBe(0);
		expect(s.events.map((e) => e.type)).toEqual(["transient_retry", "transient_retry"]);
	});

	it("gives up after the cap and returns the error for the orchestrator", async () => {
		const s = scripted(["Request timed out.", "Request timed out.", "Request timed out."]);
		expect(await promptWithRecovery({ prompt: "TASK", ...s.opts })).toBe("Request timed out.");
		expect(s.sent).toHaveLength(3);
	});

	it("falls back to the standard tier once on flex capacity, then handles a drop there too", async () => {
		const s = scripted(["Flex processing is temporarily unavailable. Please try again later or use standard processing.", "socket hang up", undefined]);
		expect(await promptWithRecovery({ prompt: "TASK", ...s.opts })).toBeUndefined();
		expect(s.tierSwitches()).toBe(1);
		expect(s.sent[1]).toBe("TASK");
		expect(s.events.map((e) => e.type)).toEqual(["tier_fallback", "transient_retry"]);
	});

	it("does not retry non-transient errors or while the user is stopping", async () => {
		const a = scripted(["Invalid API key"]);
		expect(await promptWithRecovery({ prompt: "TASK", ...a.opts })).toBe("Invalid API key");
		expect(a.sent).toHaveLength(1);
		const b = scripted(["terminated"]);
		expect(await promptWithRecovery({ prompt: "TASK", ...b.opts, aborting: () => true })).toBe("terminated");
		expect(b.sent).toHaveLength(1);
	});
});
