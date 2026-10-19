import type { FrameworkConcern } from "../types.ts";

/**
 * The framework profile's format, shared by every source adapter: `br profile` has a model write it, code checks it
 * here. Nothing in it is one language's: loaders, routes and concerns are whatever the framework has.
 */

/** Serializable profile (what `br profile` generates). `$1`, `$2`… in globs are the call's positional string arguments. */
export interface FrameworkProfileJson {
	id: string;
	frameworkDirs: string[];
	/** scope null/"" for plain function calls. `argPattern` lets one rule cover `Load::models('a','b')` (each: every literal arg). */
	loaders: Array<{ scope: string | null; method: string; globs: string[]; each?: boolean }>;
	impliedDeps?: Array<{ match: string; globs: string[] }>; // regex over the file path, `$1`… from the match groups
	entryPoint?: string; // regex
	routeClass?: string; // regex over `new X(` class names; args: first literal = url, next literal = handler method
	concerns: Array<{ match: string; concern: string; legacy: string; verdict: FrameworkConcern["verdict"] }>;
	/** Dotted file-name parts / extensions only legacy files carry (`x.cmd.php` → cmd), picked from the real suffixes. */
	legacyWords?: string[];
}

export const PROFILE_SCHEMA_DOC = `The file is JSON with: id (string); frameworkDirs (string[] path prefixes of the framework, relative to the legacy root, trailing slash); loaders (array of {scope: string|null, method: string, globs: string[], each?: boolean}) — scope is the class, module or namespace that qualifies the call (Load::models, Load.models, load.models; null for plain functions), method its name; [] when the framework finds code without such calls (annotations, dependency injection, plain imports); impliedDeps (array of {match: regex over a file path, globs: string[] with $1… from the match groups}); entryPoint (regex over the file paths that run without other code including them: web front controllers, CLI/console and cron scripts, scripts that deploy or shell scripts call, and files the framework discovers by directory scan at boot; files nothing reaches are treated as dead code); legacyWords (string[], lowercase: the dotted file-name parts and extensions that mark a LEGACY file kind, e.g. "tpl" for x.tpl.php; only parts a well-named new codebase would never use, never ordinary words like controller, model, service, test, handler); routeClass (regex over the route class names whose constructor takes the URL as first string literal and the handler method name as the next string literal: every route class the framework and the app construct; the app's own subclasses of a class it matches count as routes too; leave it out when routes are not objects); concerns (array of {match: regex over class/interface/function names, also the dotted or qualified names the app imports, extends or builds from an installed framework package (e.g. django.db.models, ActiveRecord::Base, org.springframework), concern: one of loading|orm|routing|auth|rendering|commands|cache|mail|jobs|events|helpers|i18n|logging|http|install|tests|misc, legacy: short description, verdict: platform|port|drop|review}).`;

const CONCERNS = new Set(["loading", "orm", "routing", "auth", "rendering", "commands", "cache", "mail", "jobs", "events", "helpers", "i18n", "logging", "http", "install", "tests", "misc"]);

/** Problems with a profile a model wrote; empty = fine. Loaders may be empty for any app: many frameworks load no file by a string. */
export function validateProfileJson(json: unknown): string[] {
	const j = json as Partial<FrameworkProfileJson>;
	const problems: string[] = [];
	if (!j || typeof j !== "object") return ["not an object"];
	if (!j.id) problems.push("missing id");
	if (!Array.isArray(j.frameworkDirs)) problems.push("frameworkDirs must be an array (empty when the app has no separate framework)");
	if (!Array.isArray(j.loaders)) problems.push("loaders must be an array ([] when the framework loads no file by a string)");
	for (const l of j.loaders ?? []) if (!l.method || !Array.isArray(l.globs) || !l.globs.length) problems.push(`loader ${JSON.stringify(l)} needs method + globs`);
	// a framework in the repo has base-class families; an app without one may have none
	if (!Array.isArray(j.concerns) || ((j.frameworkDirs?.length ?? 0) > 0 && j.concerns.length < 4)) problems.push("concerns must list at least 4 class families");
	for (const c of j.concerns ?? []) {
		if (!CONCERNS.has(c.concern)) problems.push(`unknown concern key ${c.concern}`);
		try {
			new RegExp(c.match);
		} catch {
			problems.push(`bad regex ${c.match}`);
		}
	}
	for (const r of [j.entryPoint, j.routeClass])
		if (r)
			try {
				new RegExp(r);
			} catch {
				problems.push(`bad regex ${r}`);
			}
	if (j.legacyWords !== undefined && (!Array.isArray(j.legacyWords) || j.legacyWords.some((w) => typeof w !== "string" || !/^[a-z0-9]+$/i.test(w)))) problems.push("legacyWords must be an array of single words");
	return problems;
}

/** A small Express (Node.js) profile: the second example `br profile` shows, so the model sees the format, not one language. */
export function expressProfileExample(): FrameworkProfileJson {
	return {
		id: "express",
		frameworkDirs: [], // an installed package, not in the repo
		loaders: [{ scope: "res", method: "render", globs: ["views/$1.ejs", "views/$1/index.ejs"] }],
		entryPoint: "^(server|app|index)\\.js$|(^|/)bin/[^/]+$|(^|/)scripts/[^/]+\\.js$",
		concerns: [
			{ match: "^(express|Router)$", concern: "routing", legacy: "express app and routers (app.get, router.post)", verdict: "platform" },
			{ match: "^(sequelize|Sequelize|Model|DataTypes)$", concern: "orm", legacy: "Sequelize models", verdict: "platform" },
			{ match: "^(passport|.*Strategy)$", concern: "auth", legacy: "passport login strategies", verdict: "port" },
			{ match: "^(nodemailer|createTransport)$", concern: "mail", legacy: "nodemailer mails", verdict: "platform" },
			{ match: "^(winston|morgan)$", concern: "logging", legacy: "request and app logs", verdict: "platform" },
		],
		legacyWords: ["ejs"],
	};
}
