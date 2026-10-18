import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, normalize } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Config } from "../config.ts";
import { answerValue, askViaModel } from "../jev/ask.ts";
import type { Ledger } from "../ledger/db.ts";
import type { ModelClient } from "../models/types.ts";
import { PLAIN_LANGUAGE } from "../policy.ts";
import { spawnLeaf } from "../sessions/spawn.ts";
import type { NotAppFolder } from "./not-app.ts";

/**
 * What the framework turns on and off, read once by a model with tools (profile key `switches`):
 *  - off: folders of the app's own code the framework never loads, because the app switches them off (a module
 *    left out of the module list, a commented-out enable call, a plugin turned off in config). The inventory
 *    leaves them out, unless the owner answers keep (one question per folder, blocking nothing);
 *  - features: framework folders the app switches on that give users something to see or do (pages, routes,
 *    actions, mails). They are ported like app code (units), unless the owner answers leave-out;
 *  - routeSyntax: how the framework writes route paths (optional parts, rest-of-path, type marks), in plain words,
 *    so the task cards say what `!` or `*` in a legacy path means instead of copying it.
 * Nothing about a given framework is written in code: the model reads how this one loads things.
 */
export interface SwitchedFolder {
	path: string;
	why: string;
	/** The owner question about it (keep / drop, port / leave out). */
	question?: number;
	/** features: what users get from it. */
	what?: string;
}
export interface Switches {
	at: string;
	off: SwitchedFolder[];
	features: SwitchedFolder[];
	routeSyntax?: string;
}

const profilePath = (root: string) => join(root, ".bigrefactor", "framework-profile.json");

export function loadSwitches(root: string | undefined): Switches | undefined {
	if (!root || !existsSync(profilePath(root))) return undefined;
	try {
		const s = (JSON.parse(readFileSync(profilePath(root), "utf8")) as { switches?: Switches }).switches;
		return s && Array.isArray(s.off) && Array.isArray(s.features) ? s : undefined;
	} catch {
		return undefined;
	}
}

const slash = (p: string) => p.replace(/^\.?\/+/, "").replace(/\/?$/, "/");

/** Switched-off app folders the inventory leaves out (the owner did not answer keep), as notApp-like entries. */
export function switchedOff(root: string | undefined, ledger: Ledger): NotAppFolder[] {
	return (loadSwitches(root)?.off ?? [])
		.filter((f) => f.question === undefined || answerValue(ledger.getQuestion(f.question)?.answer) !== "keep")
		.map((f) => ({ path: slash(f.path), kind: "switched-off" as const, why: `switched off: ${f.why}` }));
}

/** Framework folders ported like app code (switched on, users see them; the owner did not answer leave-out). */
export function portedFeatures(root: string | undefined, ledger: Ledger): string[] {
	return (loadSwitches(root)?.features ?? []).filter((f) => f.question === undefined || answerValue(ledger.getQuestion(f.question)?.answer) !== "leave-out").map((f) => slash(f.path));
}

/** The framework's route path syntax in plain words, when a model described it. */
export function routeSyntax(root: string | undefined): string | undefined {
	return loadSwitches(root)?.routeSyntax?.trim() || undefined;
}

/**
 * One read-only session in the legacy repo writes `switches` into the framework profile (once; a session that
 * recorded nothing is asked again next time). Each folder gets one owner question, blocking nothing; until the
 * owner answers, the model's reading counts. Returns what was saved, or undefined when nothing changed.
 */
export async function healSwitches(o: { config: Config; root: string; ledger: Ledger; client?: ModelClient; spawn?: typeof spawnLeaf; frameworkDirs: string[]; log?: (l: string) => void }): Promise<{ switches: Switches; costUsd: number } | undefined> {
	const file = profilePath(o.root);
	if (!existsSync(file) || loadSwitches(o.root)) return undefined;
	const src = o.config.source.path;
	const inFramework = (p: string) => o.frameworkDirs.some((d) => p.startsWith(d));
	let got: { off: SwitchedFolder[]; features: SwitchedFolder[]; routeSyntax?: string } | undefined;
	const tool = {
		name: "record_switches",
		label: "Record what is switched on and off",
		description: "Record your findings (call it once at the end; a later call replaces the earlier one). off = folders of the app's OWN code the framework never loads because the app switches them off (say where: file and line). features = framework folders the app switches ON that give users something to see or do (pages, routes, actions on a list, mails); not plumbing. routeSyntax = how route paths are written in this framework, in a few plain sentences (what marks an optional part, the rest of the path, a typed parameter), or empty when routes are plain. Paths are folder paths relative to the legacy root.",
		promptSnippet: "record_switches: switched-off app folders, switched-on framework features, route path syntax",
		parameters: Type.Object({
			off: Type.Array(Type.Object({ path: Type.String(), why: Type.String() })),
			features: Type.Array(Type.Object({ path: Type.String(), what: Type.String(), why: Type.String() })),
			routeSyntax: Type.String(),
		}),
		execute: async (_id: string, p: { off: SwitchedFolder[]; features: SwitchedFolder[]; routeSyntax: string }) => {
			const problems: string[] = [];
			const clean = (list: SwitchedFolder[], framework: boolean) =>
				(list ?? []).flatMap((f) => {
					const path = slash(normalize(String(f.path ?? "")));
					if (!f.path || path.startsWith("..") || path.startsWith("/") || !existsSync(join(src, path))) return (problems.push(`${f.path}: no such folder under the legacy root`), []);
					if (inFramework(path) !== framework) return (problems.push(`${f.path}: ${framework ? "features must be framework folders" : "off must be the app's own folders, not the framework's"}`), []);
					return [{ path, why: String(f.why ?? "").trim(), ...(f.what ? { what: String(f.what).trim() } : {}) }];
				});
			got = { off: clean(p.off, false), features: clean(p.features, true), routeSyntax: String(p.routeSyntax ?? "").trim() || undefined };
			return { content: [{ type: "text" as const, text: `recorded ${got.off.length} switched-off folder(s), ${got.features.length} feature(s)${problems.length ? `; not recorded: ${problems.join("; ")} (call again with the fixed list)` : ""}` }], details: {} };
		},
	} as unknown as ToolDefinition;
	let cost = 0;
	let session: Awaited<ReturnType<typeof spawnLeaf>> | undefined;
	try {
		session = await (o.spawn ?? spawnLeaf)({
			role: "review",
			cwd: src,
			config: o.config,
			writeGlobs: [],
			customTools: [tool],
			transcriptPath: join(o.root, ".bigrefactor", "sessions", `__init__.switches.${Date.now()}.jsonl`),
			systemPrompt: `You read a legacy ${o.config.source.stack}${o.config.source.framework ? `/${o.config.source.framework}` : ""} app (${src}, read-only) to find what its framework turns on and off.${o.frameworkDirs.length ? ` The framework lives in ${o.frameworkDirs.join(", ")}.` : ""} Find in the framework's code how the app switches parts on or off (a list of modules or plugins it loads at start, an enable call, a config switch), then read where the app does it. Report:\n- off: the app's own folders (modules, plugins) that exist but are switched off, so nothing loads them (a commented-out or missing enable line). Only when you saw the switch;\n- features: framework folders the app switches on that add things users see or do (pages, routes, actions, mails), which the new app needs as well. Not plumbing (database, cache, logging);\n- routeSyntax: how this framework writes route paths, read from its router code.\nUse your tools (ls, find, grep, read) and quote the file and line in each why. Record with record_switches, then end with one line.\n\n${PLAIN_LANGUAGE}`,
		});
		const r = await session.run(`Find the switched-off app folders, the switched-on framework features and the route path syntax of the app at ${src}. Record them with record_switches.`);
		cost += r.usage.cost;
		if (r.error) o.log?.(`  switches: the session ended with an error (${r.error})`);
	} catch (e) {
		o.log?.(`  switches: no session (${(e as Error).message.split("\n")[0]}); asked again next run start`);
	} finally {
		session?.dispose();
	}
	if (!got) return undefined;
	const found = got;
	for (const f of found.off) {
		const q = await askViaModel({ ledger: o.ledger, config: o.config, root: o.root, client: o.client }, {
			point: "switched_off",
			facts: `${f.path} is the app's own code, but the app switches it off, so it never runs: ${f.why}\nIt is left out of the migration (code already moved stays as it is).`,
			options: [{ value: "drop", facts: `leave ${f.path} out` }, { value: "keep", facts: `migrate ${f.path} anyway (it will be switched on later)` }],
			recommended: "drop",
			blocks: "none",
			askedBy: "init",
			context: { folder: f.path },
		});
		cost += q.costUsd;
		f.question = q.id;
	}
	for (const f of found.features) {
		const q = await askViaModel({ ledger: o.ledger, config: o.config, root: o.root, client: o.client }, {
			point: "framework_feature",
			facts: `The app switches on the framework part ${f.path}, which gives users: ${f.what ?? "?"} (${f.why}). The new platform does not bring it by itself, so it is migrated like the app's own code.`,
			options: [{ value: "port", facts: `migrate ${f.path}` }, { value: "leave-out", facts: `the new app does without it` }],
			recommended: "port",
			blocks: "none",
			askedBy: "init",
			context: { folder: f.path },
		});
		cost += q.costUsd;
		f.question = q.id;
	}
	const switches: Switches = { at: new Date().toISOString(), ...found };
	const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	writeFileSync(file, JSON.stringify({ ...json, switches }, null, 2) + "\n");
	o.log?.(`  switches: ${switches.off.length} switched-off app folder(s)${switches.off.length ? ` (${switches.off.map((f) => f.path).join(", ")})` : ""}, ${switches.features.length} framework feature(s) to migrate${switches.features.length ? ` (${switches.features.map((f) => f.path).join(", ")})` : ""}${switches.routeSyntax ? ", route syntax noted" : ""}, $${cost.toFixed(4)}`);
	return { switches, costUsd: cost };
}
