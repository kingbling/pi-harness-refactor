import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		exclude: [".sim/**", "node_modules/**"],
	},
});
