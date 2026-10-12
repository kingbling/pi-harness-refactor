import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		exclude: [".sim/**", "node_modules/**"],
		// many tests run git and child processes: under a full parallel run 5 s (the default) is too tight and they
		// fail for time, not for what they check; a real hang still fails
		testTimeout: 30_000,
		// tests never write to the owner's ~/.bigrefactor (recent source folders offered by init)
		// and never call a real model from code paths that build their own client (the /br answer summary)
		env: { BR_HOME: mkdtempSync(join(tmpdir(), "br-home-")), BR_NO_LLM: "1" },
	},
});
