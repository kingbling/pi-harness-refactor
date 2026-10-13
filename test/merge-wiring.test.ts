import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWiringClash } from "../src/run/run.ts";
import { approvalStands } from "../src/run/unit.ts";

const clashed = "<<<<<<< HEAD\nroutes: home, offers\n=======\nroutes: home, users\n>>>>>>> feat: U1\n";

function fakeSpawn(write?: string) {
	const seen: { writeGlobs?: string[]; prompt?: string } = {};
	const spawn = (async (opts: any) => {
		seen.writeGlobs = opts.writeGlobs;
		return {
			run: async (prompt: string) => {
				seen.prompt = prompt;
				if (write !== undefined) writeFileSync(join(opts.cwd, "web/src/App.tsx"), write);
				return { text: "DONE", toolCalls: 1, blocked: 0, usage: { input: 0, output: 0, cost: 0 } };
			},
			dispose: () => undefined,
		};
	}) as any;
	return { spawn, seen };
}

describe("a merge conflict only in wiring files", () => {
	const setup = () => {
		const root = mkdtempSync(join(tmpdir(), "br-wiring-"));
		const wt = join(root, "wt");
		mkdirSync(join(wt, "web", "src"), { recursive: true });
		writeFileSync(join(wt, "web/src/App.tsx"), clashed);
		return { root, wt, config: {} as any };
	};

	it("is resolved by one short session that may write only the clashing files", async () => {
		const { root, wt, config } = setup();
		const { spawn, seen } = fakeSpawn("routes: home, offers, users\n");
		expect(await resolveWiringClash({ config, root, unitId: "U1", wt, files: ["web/src/App.tsx"], spawn })).toBe(true);
		expect(seen.writeGlobs).toEqual(["web/src/App.tsx"]);
		expect(seen.prompt).toMatch(/web\/src\/App\.tsx.*Keep both sides/);
		expect(readFileSync(join(wt, "web/src/App.tsx"), "utf8")).toBe("routes: home, offers, users\n");
	});

	it("is not resolved while a marker is left", async () => {
		const { root, wt, config } = setup();
		expect(await resolveWiringClash({ config, root, unitId: "U1", wt, files: ["web/src/App.tsx"], spawn: fakeSpawn().spawn })).toBe(false);
	});
});

describe("an approved review across merge rounds", () => {
	const r = { ok: true, judged: true, output: "fine" } as any;
	const approved = { files: { "src/App.tsx": "a1", "src/users/UsersPage.tsx": "u1" }, tests: "t1", r };
	const wiringOrClash = (f: string) => f === "src/App.tsx";

	it("stands when only clashing or wiring files changed since", () => {
		expect(approvalStands(approved, { files: { "src/App.tsx": "a2", "src/users/UsersPage.tsx": "u1" }, tests: "t1" }, wiringOrClash)).toBe(true);
	});

	it("does not stand when other code or the tests changed", () => {
		expect(approvalStands(approved, { files: { "src/App.tsx": "a1", "src/users/UsersPage.tsx": "u2" }, tests: "t1" }, wiringOrClash)).toBe(false);
		expect(approvalStands(approved, { files: { ...approved.files, "src/users/extra.ts": "x" }, tests: "t1" }, wiringOrClash)).toBe(false);
		expect(approvalStands(approved, { files: approved.files, tests: "t2" }, wiringOrClash)).toBe(false);
	});
});
