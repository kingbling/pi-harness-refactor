import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		exclude: [".sim/**", "node_modules/**"],
		// tests never write to the owner's ~/.bigrefactor (recent source folders offered by init)
		env: { BR_HOME: mkdtempSync(join(tmpdir(), "br-home-")) },
	},
});
