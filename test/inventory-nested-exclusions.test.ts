import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSourceAdapter } from "../src/adapters/registry.ts";
import { exampleProfileJson } from "../src/adapters/source/php.ts";
import { ConfigSchema } from "../src/config.ts";
import { leftOut, notAppOf, type NotAppFolder } from "../src/inventory/not-app.ts";
import { inventory } from "../src/inventory/run.ts";
import { Ledger } from "../src/ledger/db.ts";

const folders: NotAppFolder[] = [
	{ path: "fw/", kind: "vendored", why: "Framework source remains indexed for its application loaders." },
	{ path: "fw/simpletests/", kind: "tests", why: "Framework unit-test fixtures are not application code." },
];
const previousWorkspace = process.env["BR_WORKSPACE"];
afterEach(() => {
	if (previousWorkspace === undefined) delete process.env["BR_WORKSPACE"];
	else process.env["BR_WORKSPACE"] = previousWorkspace;
	getSourceAdapter("php").reloadProfile?.();
});

describe("specific exclusions inside a retained framework", () => {
	it.each([folders, [...folders].reverse()])("chooses the most specific folder independently of profile order: %j", (first, second) => {
		const ordered = [first, second];
		expect(notAppOf("fw/simpletests/routes.fixture.php", ordered)?.path).toBe("fw/simpletests/");
		expect(leftOut("fw/simpletests/routes.fixture.php", ordered, () => false, ["fw/"])).toBe(true);
		expect(leftOut("fw/controller/runtime.controller.php", ordered, () => false, ["fw/"])).toBe(false);
	});

	it("keeps an explicitly reached application entry while respecting nested non-application classification", () => {
		const ordered: NotAppFolder[] = [
			{ path: "tooling/", kind: "tooling", why: "Tools." },
			{ path: "tooling/copied/", kind: "vendored", why: "Copied library, even if its filename looks like an entry." },
		];
		expect(leftOut("tooling/serve.php", ordered, () => true)).toBe(false);
		expect(leftOut("tooling/copied/index.php", ordered, () => true)).toBe(true);
		expect(leftOut("application/routes.php", ordered, () => false)).toBe(false);
	});

	it("re-inventory removes only excluded fixture routes and retains runtime routes and started application work", async () => {
		const root = mkdtempSync(join(tmpdir(), "br-nested-route-exclusion-"));
		const legacy = join(root, "legacy");
		const put = (path: string, text: string) => {
			mkdirSync(join(legacy, path, ".."), { recursive: true });
			writeFileSync(join(legacy, path), text);
		};
		put("index.php", "<?php require 'app.php'; require 'fw/controller/runtime.controller.php'; app_run(); (new RuntimeController())->get_routes();");
		put("app.php", "<?php function app_run() { return 1; }");
		put("fw/controller/runtime.controller.php", "<?php class RuntimeController { function get_routes() { return [new RouteBase('runtime/action', $this, 'run')]; } function action_run() { return 1; } }");
		put("fw/simpletests/routes.fixture.php", "<?php class RouteBaseTest { function test_route() { return new RouteBase('fixture/only', $this, 'fake'); } function action_fake() { return 1; } }");
		mkdirSync(join(root, ".bigrefactor"), { recursive: true });
		const profilePath = join(root, ".bigrefactor", "framework-profile.json");
		const profile = { ...exampleProfileJson(), frameworkDirs: ["fw/"], routeClass: "RouteBase$", notApp: [folders[0]], entryPoint: "(^|/)index\\.php$|controller/.*\\.php$" };
		writeFileSync(profilePath, JSON.stringify(profile));
		process.env["BR_WORKSPACE"] = root;
		const config = ConfigSchema.parse({ source: { path: legacy, stack: "php" }, target: { path: join(root, "new"), stacks: ["nestjs"] }, models: {} });
		const ledger = new Ledger(join(root, ".bigrefactor", "ledger.sqlite"));
		try {
			await inventory(config, root, ledger);
			const routes = () => (ledger.db.prepare("SELECT path FROM index_routes WHERE side='source' ORDER BY path").all() as Array<{ path: string }>).map((r) => r.path);
			expect(routes()).toEqual(["fixture/only", "runtime/action"]);
			const application = ledger.listUnits().find((u) => (JSON.parse(u.meta).files as string[]).includes("app.php"))!;
			expect(application).toBeDefined();
			ledger.transitionUnit(application.id, "truth", "preserve active app work");
			writeFileSync(profilePath, JSON.stringify({ ...JSON.parse(readFileSync(profilePath, "utf8")), notApp: folders }));
			getSourceAdapter("php").reloadProfile?.();
			await inventory(config, root, ledger);
			expect(routes()).toEqual(["runtime/action"]);
			expect(ledger.getUnit(application.id)?.state).toBe("truth");
			expect(ledger.checkInvariants().ok).toBe(true);
		} finally { ledger.close(); }
	});
});
