import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getSourceAdapter } from "../src/adapters/registry.ts";
import { exampleProfileJson } from "../src/adapters/source/php.ts";
import { ConfigSchema } from "../src/config.ts";
import { ROUTE_SUBCLASSES } from "../src/inventory/route-forms.ts";
import { inventory } from "../src/inventory/run.ts";
import { Ledger } from "../src/ledger/db.ts";
import { healStackKnowledge } from "../src/run/stack-heal.ts";

/**
 * The profile names the route classes the framework has; the app's own subclasses of them (at any depth) declare
 * routes the same way and are found from the index, not from a list. An index built before that is built again once.
 */
const here = resolve(import.meta.dirname, "..");

describe("route forms from the framework profile", () => {
	it("routes built with the app's own subclasses of a profile route class are indexed; an older index is rebuilt once at run start", async () => {
		const ws = join(here, ".sim", "route-forms");
		rmSync(ws, { recursive: true, force: true });
		mkdirSync(join(ws, ".bigrefactor"), { recursive: true });
		process.env["BR_WORKSPACE"] = ws;
		const put = (p: string, s: string) => (mkdirSync(join(ws, "legacy", p, ".."), { recursive: true }), writeFileSync(join(ws, "legacy", p), s));
		put("fw/routes/exactmatchroute.cls.php", "<?php\nclass ExactMatchRoute { function __construct($url, $ctl, $action) {} }\n");
		put("app/routes/agencyroute.cls.php", "<?php\nclass AgencyRoute extends ExactMatchRoute {}\n");
		put("app/routes/agencyforwardroute.cls.php", "<?php\nclass AgencyForwardRoute extends AgencyRoute {}\n");
		put("app/routes/notaroute.cls.php", "<?php\nclass NotARoute { function __construct($a, $b, $c) {} }\n");
		put(
			"app/controller/users.controller.php",
			"<?php\nclass UsersController {\n function get_routes() { return [\n  new ExactMatchRoute('https://users/list', $this, 'list'),\n  new AgencyRoute('https://users/{id:ui>}/edit', $this, 'edit'),\n  new AgencyForwardRoute('https://users/go', $this, 'go'),\n  new NotARoute('https://users/nope', $this, 'nope'),\n ]; }\n function action_list() { return 1; }\n function agencyaction_edit() { return 2; }\n function forwardaction_go() { return 3; }\n}\n",
		);
		put("index.php", "<?php\n$c = new UsersController();\n");
		const config = ConfigSchema.parse({ source: { path: join(ws, "legacy"), stack: "php" }, target: { path: join(ws, "migrated"), stacks: ["nestjs"] }, models: {} });
		const ledger = new Ledger(join(ws, ".bigrefactor", "ledger.sqlite"));
		writeFileSync(join(ws, ".bigrefactor", "framework-profile.json"), JSON.stringify({ ...exampleProfileJson(), frameworkDirs: ["fw/"], routeClass: "^ExactMatchRoute$", notApp: [] }));
		getSourceAdapter("php").reloadProfile?.();
		await inventory(config, ws, ledger);

		const routes = () => (ledger.db.prepare("SELECT path, handler_symbol h FROM index_routes WHERE side = 'source' ORDER BY path").all() as Array<{ path: string; h: string }>).map((r) => `${r.path} → ${r.h.split("::").slice(-1)[0]}`);
		expect(routes()).toEqual(["users/go → forwardaction_go", "users/list → action_list", "users/{id}/edit → agencyaction_edit"]);
		expect(JSON.parse(ledger.getMeta(ROUTE_SUBCLASSES)!)).toEqual(["AgencyForwardRoute", "AgencyRoute"]);

		// an index from before: only the profile's own class counted, and no marker
		ledger.db.prepare("DELETE FROM index_routes WHERE path != 'users/list'").run();
		ledger.db.prepare("DELETE FROM meta WHERE key = ?").run(ROUTE_SUBCLASSES);
		const log: string[] = [];
		await healStackKnowledge({ ledger, config, root: ws, log: (l) => log.push(l) });
		expect(routes()).toHaveLength(3);
		expect(log.join("\n")).toMatch(/1 → 3 routes \(AgencyForwardRoute, AgencyRoute\)/);
		// once: the next run start leaves it
		const again: string[] = [];
		await healStackKnowledge({ ledger, config, root: ws, log: (l) => again.push(l) });
		expect(again.join("\n")).not.toMatch(/routes/);
	});
});
