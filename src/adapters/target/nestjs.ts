import { runCommand } from "../../proc.ts";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { TargetAdapter } from "../types.ts";
import { indexTsFile, tsLayoutBase, nodeToolchain, tsProjectNotes, tsVerifyChoices, tsDiagnose, tsProbeTest } from "./ts-index.ts";
import { NEST_LAYOUT, tsCheckStructure, tsCheckTree, tsFileFindings, tsModuleDir, tsStructureDoc } from "./ts-structure.ts";

/**
 * Fresh setup is NOT model-generated: the official Nest CLI bootstraps the project
 * (folder structure, tsconfig, jest, eslint, prettier) exactly as the docs describe.
 * Docs fetched at init are used for rules and by agents, not to invent a layout.
 */
export const nestjsAdapter: TargetAdapter = {
	id: "nestjs",
	role: "server",
	subdir: "api",
	aliases: ["nest"],
	toolchain: nodeToolchain(),
	layout: {
		...tsLayoutBase(),
		dataAccessHint: "DTOs required; keep-schema: tables stay as they are",

		// one legacy area = one feature module; units of the same area extend its files, never fork them
		moduleDir: tsModuleDir,
		astGrepLanguages: ["TypeScript"],
		structureDoc: tsStructureDoc("server"),
		checkStructure: (files, moduleDir, area, projectDir, ctx) => tsCheckStructure(files, moduleDir, area, projectDir, "server", ctx),
		checkTree: (projectDir, only) => tsCheckTree(projectDir, "server", only),
		fileFindings: tsFileFindings,
		testFileGlobs: (dir) => [`${dir}/**/*.spec.ts`, `${dir}/**/*.test.ts`],
		testHint: "*.spec.ts files (vitest/jest `describe`/`it`/`expect`) next to the code they test",
	},
	layoutRules: NEST_LAYOUT,
	indexFile: (root, rel) => indexTsFile(root, rel, { sharedDirs: tsLayoutBase().sharedDirs, decoratorKinds: { Controller: "controller", Module: "module", Injectable: "service" }, nameKinds: [[/Repository$|Repo$/, "repository"], [/Dto$|Request$|Response$/, "dto"]] }),
	projectNotes: (root) => tsProjectNotes(root),
	verifyChoices: (root, chosen) => tsVerifyChoices(root, chosen),
	diagnose: (root, step, output, isTest, expected) => tsDiagnose(root, step, output, isTest, expected),
	probeTest: (root) => tsProbeTest(root),
	docs: [
		{ name: "NestJS", url: "https://docs.nestjs.com/" },
		{ name: "NestJS CLI", url: "https://docs.nestjs.com/cli/overview" },
		{ name: "NestJS testing", url: "https://docs.nestjs.com/fundamentals/testing" },
	],
	// Decisions asked at init; each option brings its docs and platform text (see src/init/stack.ts).
	stackChoices: [
		{
			key: "orm",
			question: "Data access / ORM",
			default: "prisma",
			options: [
				{ id: "prisma", label: "Prisma", hint: "schema-first, generated client, migrations", docs: [{ name: "Prisma", url: "https://www.prisma.io/docs/llms.txt" }], platform: { orm: "Prisma schema + repositories", install: "Prisma migrations" }, packages: ["prisma", "@prisma/client"] },
				{ id: "typeorm", label: "TypeORM", hint: "decorator entities, Nest's @nestjs/typeorm", docs: [{ name: "TypeORM", url: "https://typeorm.io/" }, { name: "NestJS TypeORM", url: "https://docs.nestjs.com/techniques/database" }], platform: { orm: "TypeORM entities + repositories via @nestjs/typeorm", install: "TypeORM migrations" }, packages: ["typeorm", "@nestjs/typeorm"] },
				{ id: "drizzle", label: "Drizzle", hint: "SQL-like TypeScript schema, lightweight", docs: [{ name: "Drizzle", url: "https://orm.drizzle.team/llms.txt" }], platform: { orm: "Drizzle schema + typed queries", install: "drizzle-kit migrations" }, packages: ["drizzle-orm", "drizzle-kit"] },
				{ id: "mikro-orm", label: "MikroORM", hint: "unit of work, identity map", docs: [{ name: "MikroORM", url: "https://mikro-orm.io/docs/" }], platform: { orm: "MikroORM entities + repositories via @mikro-orm/nestjs", install: "MikroORM migrations" }, packages: ["@mikro-orm/core", "@mikro-orm/nestjs"] },
			],
		},
		{
			key: "database",
			question: "Database engine for the new code",
			default: "postgres",
			options: [
				{ id: "postgres", label: "PostgreSQL", platform: { orm_db: "PostgreSQL" } },
				{ id: "mysql", label: "MySQL / MariaDB", platform: { orm_db: "MySQL" } },
				{ id: "sqlite", label: "SQLite", hint: "small deployments, tests", platform: { orm_db: "SQLite" } },
				{ id: "legacy", label: "Keep the legacy engine", hint: "whatever the old app uses; keep-schema stays 1:1", platform: { orm_db: "the legacy engine, unchanged" } },
			],
		},
		{
			key: "validation",
			question: "Request validation",
			default: "class-validator",
			options: [
				{ id: "class-validator", label: "class-validator + class-transformer", hint: "Nest's default ValidationPipe", docs: [{ name: "class-validator", url: "https://github.com/typestack/class-validator#readme" }], platform: { routing: "@Controller/@Get/@Post decorators; DTOs validated by class-validator" }, packages: ["class-validator", "class-transformer"] },
				{ id: "zod", label: "zod (nestjs-zod)", hint: "schema-first DTOs, inferred types", docs: [{ name: "zod", url: "https://zod.dev/llms.txt" }, { name: "nestjs-zod", url: "https://github.com/BenLorantfy/nestjs-zod#readme" }], platform: { routing: "@Controller/@Get/@Post decorators; DTOs from zod schemas via nestjs-zod" }, packages: ["zod", "nestjs-zod"] },
			],
		},
		{
			key: "auth",
			question: "Authentication",
			default: "jwt",
			options: [
				{ id: "jwt", label: "JWT bearer (Passport)", hint: "stateless, fits a separate web client", docs: [{ name: "NestJS authentication", url: "https://docs.nestjs.com/security/authentication" }], platform: { auth: "Guards + passport-jwt; roles via custom decorators (rules ported from legacy access control)" }, packages: ["@nestjs/passport", "passport", "passport-jwt", "@nestjs/jwt"] },
				{ id: "session", label: "Server sessions (cookies)", hint: "closest to the legacy behaviour", docs: [{ name: "NestJS sessions", url: "https://docs.nestjs.com/techniques/session" }], platform: { auth: "Guards + express-session cookies; roles via custom decorators (rules ported from legacy access control)" }, packages: ["express-session", "@nestjs/passport", "passport", "passport-local"] },
			],
		},
		{
			key: "tests",
			question: "Test runner",
			default: "vitest",
			options: [
				{ id: "vitest", label: "vitest", hint: "what Nest CLI 11 scaffolds", docs: [{ name: "Vitest", url: "https://vitest.dev/guide/" }], platform: { tests: "vitest" } },
				{ id: "jest", label: "Jest", unavailable: "Nest CLI 11 scaffolds vitest; switching the runner to Jest is not automated", docs: [{ name: "Jest", url: "https://jestjs.io/docs/getting-started" }], platform: { tests: "Jest" } },
			],
		},
	],
	platform: {
		loading: "Nest modules + dependency injection; @nestjs/config",
		orm: "Prisma schema + repositories",
		routing: "@Controller/@Get/@Post decorators; DTOs validated by class-validator",
		auth: "Guards + Passport strategies; roles via custom decorators (rules ported from legacy access control)",
		rendering: "JSON endpoints only; UI lives in the web target",
		commands: "application services (optionally @nestjs/cqrs command handlers); business logic ported",
		cache: "@nestjs/cache-manager + HTTP cache headers",
		mail: "@nestjs-modules/mailer (nodemailer)",
		jobs: "@nestjs/schedule for cron; BullMQ for queues",
		events: "@nestjs/event-emitter",
		helpers: "TypeScript stdlib; src/shared/* helpers (shared_lookup)",
		i18n: "nestjs-i18n",
		logging: "Nest Logger (pino) + @sentry/node",
		http: "Express request/response via Nest",
		install: "Prisma migrations",
		tests: "vitest",
	},
	protectedGlobs: ["**/*.spec.ts", "**/*.test.ts", "**/*.e2e-spec.ts", "test/**", "**/__goldens__/**", "**/truth/**", "jest.config.*", "vitest.config.*", "**/package.json", "pnpm-lock.yaml", "**/tsconfig*.json", "nest-cli.json", "eslint.config.*", ".oxlintrc.json", "src/app.module.ts", "src/main.ts"],
	async generateRegistration(root) {
		// app.module.ts is owned by the orchestrator: import every feature module found under src/<dir>/*.module.ts.
		const appModule = join(root, "src", "app.module.ts");
		if (!existsSync(appModule)) return [];
		const mods: Array<{ cls: string; from: string }> = [];
		const walk = (dir: string) => {
			for (const n of readdirSync(dir)) {
				const p = join(dir, n);
				if (statSync(p).isDirectory()) walk(p);
				else if (/\.module\.ts$/.test(n) && p !== appModule) {
					const src = readFileSync(p, "utf8");
					const m = /@Module\([\s\S]*?\)\s*export\s+class\s+(\w+)/.exec(src);
					if (m) mods.push({ cls: m[1]!, from: "./" + relative(join(root, "src"), p).replace(/\\/g, "/").replace(/\.ts$/, "") });
				}
			}
		};
		walk(join(root, "src"));
		mods.sort((a, b) => a.from.localeCompare(b.from));
		const cur = readFileSync(appModule, "utf8");
		if (!mods.length && !cur.includes("// <bigrefactor:modules>")) return []; // nothing to wire yet: leave the scaffold untouched
		const ext = /from '\.\/[^']+\.js'/.test(cur) ? ".js" : ""; // NodeNext scaffolds import with .js
		const begin = "// <bigrefactor:modules>";
		const end = "// </bigrefactor:modules>";
		const importsBlock = mods.map((m) => `import { ${m.cls} } from '${m.from}${ext}';`).join("\n");
		const listBlock = mods.map((m) => m.cls).join(", ");
		let next: string;
		if (cur.includes(begin)) {
			next = cur.replace(new RegExp(`${begin}[\\s\\S]*?${end}`), `${begin}\n${importsBlock}\n${end}`).replace(/imports:\s*\[[^\]]*\]/, `imports: [${listBlock}]`);
		} else {
			// first time: inject the marker block after the last import and fill `imports: []`
			const lastImport = cur.lastIndexOf("\nimport ");
			const cut = lastImport >= 0 ? cur.indexOf("\n", lastImport + 1) + 1 : 0;
			next = cur.slice(0, cut) + `${begin}\n${importsBlock}\n${end}\n` + cur.slice(cut);
			next = next.replace(/imports:\s*\[[^\]]*\]/, `imports: [${listBlock}]`);
		}
		if (next === cur) return [];
		writeFileSync(appModule, next);
		return ["src/app.module.ts"];
	},

	generatedFiles: ["src/app.module.ts"],
	patternKinds: ["controller", "service", "dto", "repository", "guard", "module", "test"],

	async detect(root) {
		const pkg = join(root, "package.json");
		if (!existsSync(pkg)) return { confidence: 0 };
		try {
			const p = JSON.parse(readFileSync(pkg, "utf8"));
			const v = p.dependencies?.["@nestjs/core"];
			return { confidence: v ? 0.95 : 0.1, version: v };
		} catch {
			return { confidence: 0.1 };
		}
	},

	async scaffoldProject(root) {
		if (existsSync(join(root, "nest-cli.json"))) return;
		mkdirSync(dirname(root), { recursive: true });
		// `nest new <name>` creates the folder; --skip-git because the parent target repo owns git.
		await runCommand("npx", ["--yes", "@nestjs/cli@latest", "new", basename(root), "--package-manager", "pnpm", "--skip-git", "--strict", "--language", "TS"], { cwd: dirname(root) });
	},

	// The generator decides the toolchain (Nest CLI 11 ships vitest + oxlint; older ones jest + eslint). Read, don't assume.
	build: () => ({ cmd: "npx", args: ["tsc", "-p", "tsconfig.json", "--noEmit"] }),
	lint: (root, files) => (devDeps(root).has("oxlint") ? { cmd: "npx", args: ["oxlint", "--type-aware", ...files] } : { cmd: "npx", args: ["eslint", "--cache", ...files] }),
	test: (root, related) =>
		devDeps(root).has("vitest")
			? { cmd: "npx", args: ["vitest", "run", "--reporter=dot", ...(related.length ? ["--changed=false", "related", ...related] : [])] }
			: { cmd: "npx", args: ["jest", "--ci", "--silent", ...(related.length ? ["--findRelatedTests", ...related] : [])] },
};

function devDeps(root: string): Set<string> {
	try {
		const p = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		return new Set([...Object.keys(p.devDependencies ?? {}), ...Object.keys(p.dependencies ?? {})]);
	} catch {
		return new Set();
	}
}
