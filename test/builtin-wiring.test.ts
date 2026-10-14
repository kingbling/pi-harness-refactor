import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reactAdapter } from "../src/adapters/target/react.ts";
import { healBuiltinWiring, loadWiringFiles, withWiringFiles } from "../src/adapters/wiring.ts";
import { FakeModelClient } from "../src/models/fake.ts";

/**
 * The React adapter names no wiring file of its own (it used to name src/routes.tsx, which the project did not
 * have): a model finds the project's route files from its tracked files once, and only files that exist are kept.
 */
describe("built-in stack wiring files come from the project", () => {
	function project(): { root: string; proj: string } {
		const root = mkdtempSync(join(tmpdir(), "br-wiring-"));
		const proj = join(root, "web");
		mkdirSync(join(proj, "src", "features", "offers"), { recursive: true });
		writeFileSync(join(proj, "src", "App.tsx"), "export default function App() { return null; }\n");
		writeFileSync(join(proj, "src", "main.tsx"), "import App from './App';\n");
		writeFileSync(join(proj, "src", "features", "offers", "OffersPage.tsx"), "export const OffersPage = () => null;\n");
		const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: proj });
		git("init", "-q");
		git("add", "-A");
		git("commit", "-qm", "init");
		return { root, proj };
	}

	it("the adapter itself names none", () => {
		expect(reactAdapter.layout.wiringFiles).toBeUndefined();
	});

	it("a model names them from the tracked files; a file the project does not have is left out; asked once", async () => {
		const { root, proj } = project();
		const client = new FakeModelClient({ chat: () => ({ json: { wiringFiles: ["src/routes.tsx", "src/App.tsx"] } }) });
		const log: string[] = [];
		expect(await healBuiltinWiring(root, reactAdapter, proj, { client, model: "m", log: (l) => log.push(l) })).toBe(true);
		expect(JSON.stringify(client.calls[0]!.req)).toContain("src/App.tsx");
		expect(loadWiringFiles(root, "react")).toEqual(["src/App.tsx"]);
		expect(log.join("\n")).toMatch(/left out, not in the project: src\/routes\.tsx/);
		expect(withWiringFiles(reactAdapter, root).layout.wiringFiles).toEqual(["src/App.tsx"]);
		// saved and still there: no new question
		expect(await healBuiltinWiring(root, reactAdapter, proj, { client, model: "m" })).toBe(false);
		expect(client.calls.length).toBe(1);
	});

	it("a saved file the project no longer has is asked again", async () => {
		const { root, proj } = project();
		await healBuiltinWiring(root, reactAdapter, proj, { client: new FakeModelClient({ chat: () => ({ json: { wiringFiles: ["src/App.tsx"] } }) }), model: "m" });
		rmSync(join(proj, "src", "App.tsx"));
		writeFileSync(join(proj, "src", "router.tsx"), "export const routes = [];\n");
		const client = new FakeModelClient({ chat: () => ({ json: { wiringFiles: ["src/router.tsx"] } }) });
		expect(await healBuiltinWiring(root, reactAdapter, proj, { client, model: "m" })).toBe(true);
		expect(JSON.stringify(client.calls[0]!.req)).toMatch(/src\/App\.tsx are gone/);
		expect(loadWiringFiles(root, "react")).toEqual(["src/router.tsx"]);
	});

	it("a workspace with nothing found keeps the adapter as it is", () => {
		const root = mkdtempSync(join(tmpdir(), "br-wiring-none-"));
		expect(withWiringFiles(reactAdapter, root).layout.wiringFiles).toBeUndefined();
	});
});
