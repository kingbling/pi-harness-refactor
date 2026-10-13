import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { interfaceCodeFiles } from "../src/run/unit.ts";

/** The files interface.md tells the implementer to create, checked against the layout before it starts. */
describe("interfaceCodeFiles", () => {
	it("names the unit's own files that do not exist yet, without the target's folder prefix", () => {
		const dir = mkdtempSync(join(tmpdir(), "br-iface-"));
		mkdirSync(join(dir, "src/features/inventory/components"), { recursive: true });
		writeFileSync(join(dir, "src/features/inventory/components/SubnetDetails.tsx"), "");
		const md = [
			"Extend `src/features/inventory/pages/SubnetViewPage.tsx`.",
			"Reuse `src/features/inventory/components/SubnetDetails.tsx` and web/src/features/inventory/pages/InventoryNetworkPage.tsx.",
			"Legacy: app/modules/inventory/subnets.view.tpl.php; other area: src/features/offers/OffersPage.tsx",
		].join("\n");
		expect(interfaceCodeFiles(md, "web", "src/features/inventory", dir)).toEqual(["src/features/inventory/pages/SubnetViewPage.tsx", "src/features/inventory/pages/InventoryNetworkPage.tsx"]);
	});
});
