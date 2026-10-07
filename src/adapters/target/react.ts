import { runCommand } from "../../proc.ts";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { TargetAdapter } from "../types.ts";
import { indexTsFile, tsLayoutBase, nodeToolchain, tsProjectNotes, tsVerifyChoices, tsDiagnose, tsProbeTest } from "./ts-index.ts";
import { tsCheckStructure, tsCheckTree, tsModuleDir, tsStructureDoc } from "./ts-structure.ts";

/** Fresh setup via the official Vite scaffolder (`create vite --template react-ts`), not model-generated. */
export const reactAdapter: TargetAdapter = {
	id: "react",
	role: "ui",
	subdir: "web",
	aliases: ["reactjs"],
	toolchain: nodeToolchain(),
	layout: {
		...tsLayoutBase(),

		// one legacy area = one feature module; units of the same area extend its files, never fork them
		moduleDir: tsModuleDir,
		astGrepLanguages: ["TypeScript", "Tsx"],
		structureDoc: tsStructureDoc("ui"),
		checkStructure: (files, moduleDir, area, projectDir, ctx) => tsCheckStructure(files, moduleDir, area, projectDir, "ui", ctx),
		checkTree: (projectDir, only) => tsCheckTree(projectDir, "ui", only),
		testFileGlobs: (dir) => [`${dir}/**/*.test.tsx`, `${dir}/**/*.test.ts`],
		testHint: "*.test.tsx files (vitest + @testing-library/react) next to the component",
	},
	indexFile: (root, rel) => indexTsFile(root, rel, { sharedDirs: tsLayoutBase().sharedDirs, nameKinds: [[/Page$/, "page"], [/^use[A-Z]/, "hook"]] }),
	projectNotes: (root) => tsProjectNotes(root),
	verifyChoices: (root, chosen) => tsVerifyChoices(root, chosen),
	diagnose: (root, step, output, isTest, expected) => tsDiagnose(root, step, output, isTest, expected),
	probeTest: (root) => tsProbeTest(root),
	docs: [
		{ name: "React", url: "https://react.dev/reference/react" },
		{ name: "Vite", url: "https://vite.dev/guide/" },
		{ name: "Testing Library", url: "https://testing-library.com/docs/react-testing-library/intro/" },
		{ name: "Vitest", url: "https://vitest.dev/guide/" },
	],
	// Decisions asked at init; each option brings its docs and platform text (see src/init/stack.ts).
	stackChoices: [
		{
			key: "styling",
			question: "Styling",
			default: "tailwind",
			options: [
				{ id: "tailwind", label: "Tailwind CSS", hint: "utility classes, no CSS files per component", docs: [{ name: "Tailwind CSS", url: "https://tailwindcss.com/docs" }], platform: { styling: "Tailwind utility classes; shared tokens in src/styles" }, packages: ["tailwindcss", "@tailwindcss/vite"] },
				{ id: "css-modules", label: "CSS Modules", hint: "one .module.css per component, Vite built-in", platform: { styling: "CSS Modules (*.module.css) per component" } },
				{ id: "styled-components", label: "styled-components", hint: "CSS-in-JS", docs: [{ name: "styled-components", url: "https://styled-components.com/docs" }], platform: { styling: "styled-components per component" }, packages: ["styled-components"] },
				{ id: "mui", label: "MUI (Material UI)", hint: "component kit + theme", docs: [{ name: "MUI", url: "https://mui.com/material-ui/getting-started/" }], platform: { styling: "MUI components + theme; sx prop for one-offs" }, packages: ["@mui/material", "@emotion/react", "@emotion/styled"] },
			],
		},
		{
			key: "data",
			question: "Server data / API client",
			default: "tanstack-query",
			options: [
				{ id: "tanstack-query", label: "TanStack Query", hint: "caching, retries, mutations", docs: [{ name: "TanStack Query", url: "https://tanstack.com/query/latest/docs/framework/react/overview" }], platform: { data: "TanStack Query hooks over a typed fetch client (src/api)" }, packages: ["@tanstack/react-query"] },
				{ id: "swr", label: "SWR", docs: [{ name: "SWR", url: "https://swr.vercel.app/docs/getting-started" }], platform: { data: "SWR hooks over a typed fetch client (src/api)" }, packages: ["swr"] },
				{ id: "redux-toolkit", label: "Redux Toolkit + RTK Query", docs: [{ name: "Redux Toolkit", url: "https://redux-toolkit.js.org/introduction/getting-started" }], platform: { data: "RTK Query endpoints; store in src/store" }, packages: ["@reduxjs/toolkit", "react-redux"] },
				{ id: "fetch", label: "Plain fetch hooks", hint: "no library", platform: { data: "hand-written hooks over a typed fetch client (src/api)" } },
			],
		},
		{
			key: "router",
			question: "Routing",
			default: "react-router",
			options: [
				{ id: "react-router", label: "React Router", docs: [{ name: "React Router", url: "https://reactrouter.com/home" }], platform: { routing: "react-router routes mirroring legacy URLs" }, packages: ["react-router"] },
				{ id: "tanstack-router", label: "TanStack Router", hint: "type-safe routes", docs: [{ name: "TanStack Router", url: "https://tanstack.com/router/latest/docs/framework/react/overview" }], platform: { routing: "TanStack Router file routes mirroring legacy URLs" }, packages: ["@tanstack/react-router"] },
			],
		},
		{
			key: "forms",
			question: "Forms",
			default: "react-hook-form",
			options: [
				{ id: "react-hook-form", label: "react-hook-form + zod", docs: [{ name: "react-hook-form", url: "https://react-hook-form.com/docs" }], platform: { forms: "react-hook-form with zod resolvers" }, packages: ["react-hook-form", "zod", "@hookform/resolvers"] },
				{ id: "none", label: "Controlled inputs, no library", platform: { forms: "controlled components, validation in hooks" } },
			],
		},
	],
	platform: {
		rendering: "React components per feature (src/features/*), data via the API target",
		routing: "react-router routes mirroring legacy URLs",
		i18n: "react-i18next",
		helpers: "TypeScript stdlib; src/shared/* helpers",
		tests: "vitest + Testing Library",
	},
	protectedGlobs: ["**/*.test.tsx", "**/*.test.ts", "**/__goldens__/**", "vite.config.*", "vitest.config.*", "package.json", "pnpm-lock.yaml", "tsconfig*.json", "src/main.tsx", "src/routes.tsx"],
	generatedFiles: ["src/routes.tsx"],
	patternKinds: ["page", "component", "hook", "api-client", "test"],

	async detect(root) {
		return { confidence: existsSync(join(root, "vite.config.ts")) ? 0.8 : 0 };
	},

	async scaffoldProject(root) {
		const pkg = join(root, "package.json");
		const hasVitest = existsSync(pkg) && /"vitest"/.test(readFileSync(pkg, "utf8"));
		if (existsSync(join(root, "vite.config.ts")) && hasVitest) return;
		if (existsSync(join(root, "vite.config.ts"))) {
			// interrupted earlier run: the generator finished, the test toolchain was never added
			await runCommand("pnpm", ["install"], { cwd: root });
			await runCommand("pnpm", ["add", "-D", "vitest", "@testing-library/react", "@testing-library/jest-dom", "jsdom"], { cwd: root });
			return;
		}
		mkdirSync(dirname(root), { recursive: true });
		// Never interactive and never "install and start dev": inside Pi a prompt or a dev server takes the terminal over.
		await runCommand("pnpm", ["create", "vite@latest", basename(root), "--template", "react-ts", "--no-interactive", "--no-immediate"], { cwd: dirname(root) });
		await runCommand("pnpm", ["install"], { cwd: root });
		await runCommand("pnpm", ["add", "-D", "vitest", "@testing-library/react", "@testing-library/jest-dom", "jsdom"], { cwd: root });
	},

	async scaffoldUnit(root, unit) {
		const dir = join(root, reactAdapter.layout.moduleDir(unit.name.replace(/[^a-z0-9-]/gi, "-").toLowerCase()));
		mkdirSync(dir, { recursive: true });
		return [dir];
	},

	build: () => ({ cmd: "npx", args: ["tsc", "-p", "tsconfig.app.json", "--noEmit"] }),
	lint: (_root, files) => ({ cmd: "npx", args: ["eslint", "--cache", ...files] }),
	test: (_root, related) => ({ cmd: "npx", args: ["vitest", "run", ...(related.length ? ["--related", ...related] : [])] }),
};
