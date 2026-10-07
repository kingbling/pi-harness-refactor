import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

/** One model role. `tier` is an OpenRouter service tier, not a model-id suffix. */
export const ModelRoleSchema = z.object({
	id: z.string(),
	tier: z.enum(["default", "flex", "priority"]).default("default"),
	/** Models to try, in order, after `id` fails (capacity 429s, 5xx). */
	fallback: z.array(z.string()).default([]),
	/** Reasoning effort passed through when the model supports it. */
	effort: z.enum(["none", "low", "medium", "high", "xhigh", "max"]).optional(),
});
export type ModelRole = z.infer<typeof ModelRoleSchema>;

export const ConfigSchema = z.object({
	version: z.literal(1).default(1),
	/** Absolute or config-relative path to the legacy repo. */
	/**
	 * The legacy repo is READ-ONLY: agents index and read it, nothing is ever written or committed
	 * there. `commit` pins the git HEAD the inventory was taken at; `br inventory` re-run later
	 * reports drift against it (new commits upstream) and marks affected units stale.
	 */
	source: z.object({
		path: z.string(),
		stack: z.string(), // adapter id, e.g. "php"
		framework: z.string().optional(),
		version: z.string().optional(),
		commit: z.string().optional(),
	}),
	/** The new codebase: a git repo we own. Bootstrapped with each stack's official CLI, committed by the orchestrator. */
	target: z.object({
		path: z.string(),
		stacks: z.array(z.string()).min(1), // adapter ids, e.g. ["nestjs", "react"]
		/** Stack decisions per target: { nestjs: { orm: "prisma", … }, react: { styling: "tailwind" } }. Missing key = adapter default. */
		choices: z.record(z.string(), z.record(z.string(), z.string())).default({}),
		git: z
			.object({
				branch: z.string().default("migration/main"),
				/** When to commit: every accepted unit, or when a whole module (all units of a dir) is accepted. */
				commitOn: z.enum(["unit", "module"]).default("unit"),
			})
			.prefault({}),
	}),
	/** Inventory knobs: cycles larger than maxSccFiles are cut deterministically (units carry the cut edges as cutDeps). */
	inventory: z.object({ maxSccFiles: z.number().int().positive().default(12), mergeGroups: z.boolean().default(false) }).prefault({}),
	/** Official docs fetched at init per technology, stored under .bigrefactor/docs/<tech>/ for agents and rule generation. */
	docs: z
		.object({
			fetchedAt: z.string().optional(),
			extra: z.array(z.object({ name: z.string(), url: z.string() })).default([]),
		})
		.prefault({}),
	db: z
		.object({
			strategy: z.enum(["keep-schema", "new-schema", "none"]).default("keep-schema"),
			/** Legacy engine(s) and the target engine; `from !== to` means keep-schema runs through an engine translation step (types, DDL, SQL dialect). */
			from: z.array(z.string()).default([]),
			to: z.string().optional(),
			/** Decision per extra store (br decide): keep | fold | drop. */
			stores: z.record(z.string(), z.enum(["keep", "fold", "drop"])).default({}),
			/** Schema inputs (files or dirs, relative to the old codebase): SQL dumps, migrations/, .sqlite, schema.prisma … */
			schemaFiles: z.array(z.string()).default([]),
			/** Connection for introspection as `env:VAR` (the URL itself, with its password, is never stored). */
			url: z.string().optional(),
			/** Exports of non-SQL stores (ArangoDB, MongoDB …), per engine: dump folders or files. */
			exports: z.record(z.string(), z.string()).default({}),
			/** Data dump the data-migration unit loads and verifies against. */
			snapshot: z.string().optional(),
			/** When onboarding asked for the DB inputs (asked once; `br onboard --force-db` asks again). */
			inputsAt: z.string().optional(),
		})
		.prefault({ strategy: "keep-schema" }),
	/** What the owner wants from this migration (asked first in onboarding): the picked goals plus their own words. Every model prompt quotes it. */
	goals: z
		.object({
			picked: z.array(z.string()).default([]),
			note: z.string().optional(),
			/** When onboarding asked (asked once; `br onboard --force-goals` asks again). */
			askedAt: z.string().optional(),
		})
		.prefault({}),
	models: z.object({
		decide: ModelRoleSchema.default({ id: "typesafe/jev-1.13", tier: "default", fallback: [] }),
		implement: ModelRoleSchema.default({ id: "openai/gpt-6-luna", tier: "flex", fallback: ["openai/gpt-6-luna"] }),
		test: ModelRoleSchema.default({ id: "openai/gpt-6-luna", tier: "flex", fallback: ["openai/gpt-6-luna"] }),
		escalate: ModelRoleSchema.default({ id: "openai/gpt-6.1-sol", tier: "flex", fallback: ["openai/gpt-6-luna-pro"] }),
	}),
	provider: z
		.object({
			kind: z.literal("openrouter").default("openrouter"),
			/** Env var holding the key; auth.json from ~/.pi/agent is used when unset. */
			apiKeyEnv: z.string().default("OPENROUTER_API_KEY"),
		})
		.prefault({ kind: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY" }),
	run: z
		.object({
			agentConcurrency: z.number().int().min(1).default(8),
			gateConcurrency: z.number().int().min(1).default(2),
			maxImplementAttempts: z.number().int().min(1).default(3),
			maxEscalateAttempts: z.number().int().min(0).default(2),
			budgetUsdPerDay: z.number().positive().default(200),
			/** Packed task-card context above this triggers a pre-split; a session exceeding it in total usage is aborted. */
			maxUnitTokens: z.number().int().default(250_000),
			/** A leaf session with no model/tool activity for this long is aborted (outcome idle_timeout). */
			idleMs: z.number().int().default(300_000),
			/** `br run` pauses after this many accepted units for a layout review question (0 = off). */
			sampleSize: z.number().int().min(0).default(10),
			/** "unsure": the run decides routine questions itself when the model and the code agree (your goals guide both); "all": ask every one. */
			ask: z.enum(["unsure", "all"]).default("unsure"),
		})
		.prefault({}),
	/** Set by `br simulate --level 3`; `br run` refuses to start when missing. */
	simulatedAt: z.string().optional(),
});
export type Config = z.infer<typeof ConfigSchema>;

export const CONFIG_FILE = "bigrefactor.config.json";
export const STATE_DIR = ".bigrefactor";

export function findConfigPath(start = process.cwd()): string | undefined {
	let dir = resolve(start);
	for (;;) {
		const p = join(dir, CONFIG_FILE);
		if (existsSync(p)) return p;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export function loadConfig(path = findConfigPath()): { config: Config; path: string; root: string } {
	if (!path) throw new Error(`No ${CONFIG_FILE} found. Run \`br init\` first.`);
	const raw = JSON.parse(readFileSync(path, "utf8"));
	const config = ConfigSchema.parse(raw);
	const root = dirname(path);
	config.source.path = resolve(root, config.source.path);
	config.target.path = resolve(root, config.target.path);
	// the workspace's own files (generated stack adapters, layout rules) are found from here, on every path that loads a config
	process.env["BR_WORKSPACE"] = root;
	return { config, path, root };
}

export function saveConfig(root: string, config: Config): string {
	const path = join(root, CONFIG_FILE);
	mkdirSync(root, { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
	return path;
}

export function statePath(root: string, ...parts: string[]): string {
	const p = join(root, STATE_DIR, ...parts);
	mkdirSync(dirname(p), { recursive: true });
	return p;
}
