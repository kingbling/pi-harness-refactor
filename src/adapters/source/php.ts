import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, normalize, relative } from "node:path";
import { captures, enclosing, normalizedAst, parse, registerGrammar, walk, type Node } from "../../inventory/treesitter.ts";

registerGrammar("php", "tree-sitter-php/tree-sitter-php.wasm");
import { placePhpFile } from "./php-place.ts";
import { SQL_RES } from "./sql.ts";
import type { CodeCall, CodeComment, CodeContainer, CodeFunction, ExternalDep, FileIndex, FrameworkConcern, IndexedDep, IndexedQuery, IndexedRoute, IndexedSymbol, SourceAdapter } from "../types.ts";

const SYMBOL_QUERY = `
(function_definition name: (name) @fn)
(class_declaration name: (name) @cls)
(interface_declaration name: (name) @iface)
(trait_declaration name: (name) @trait)
(enum_declaration name: (name) @enum)
(method_declaration name: (name) @method)
(const_declaration (const_element (name) @const))
`;

const DEP_QUERY = `
(function_call_expression function: (name) @call)
(scoped_call_expression scope: (name) @scope name: (name) @smeth)
(class_constant_access_expression (name) @cconst_scope (name) @cconst_name)
(object_creation_expression (name) @new)
(base_clause (name) @extends)
(class_interface_clause (name) @implements)
(use_declaration (name) @use_trait)
`;

const HTTP_MARKERS = ["$_GET", "$_POST", "$_REQUEST", "$_SERVER", "$_SESSION", "$_COOKIE", "header(", "http_response_code(", "ob_start("];
const TEMPLATE_RE = /(^|\/)(templates?|views?|resources\/views)\/|\.phtml$|\.blade\.php$/i;
const ROUTES_RE = /(^|\/)routes?(\/(web|api|console|channels|[a-z_]+))?\.php$/;

/**
 * Framework profiles: how a given PHP framework loads code by convention (string → file), registers
 * routes in code, and which of its classes map to which target-platform concern. Generic mechanism,
 * per-framework tables. gyro-php (One Tech Group) is the first; Laravel/Symfony profiles follow the same shape.
 */
interface PhpFrameworkProfile {
	id: string;
	detect(root: string): boolean;
	frameworkDirs: string[];
	/** `Scope::method(args)` (scope null for plain function calls) → file globs the call loads/renders. Args are positional; non-literals are undefined. */
	loaders(scope: string | null, method: string, args: Array<string | undefined>): string[];
	/** Files a file implies by convention (e.g. a model's commands directory reached through generic actions). */
	impliedDeps?(relPath: string): string[];
	/** Files that run without other code including them (front controllers, CLI/cron scripts, files a directory scan loads at boot): alive without inbound edges. */
	entryPoint?: RegExp;
	/** `new SomethingRoute('url', $this, 'method', …)` → {urlArg, handlerArg} when the class is a route. */
	routeClass?: RegExp;
	concerns: FrameworkConcern[];
	/** Legacy file kinds a target name must not carry (SourceAdapter.legacyWords). */
	legacyWords?: string[];
}

let activeProfile: PhpFrameworkProfile | undefined | null = null; // null = not detected yet
let activeKey = ""; // workspace|source root|profile mtime the cached profile belongs to
/**
 * The framework profile is the generated `.bigrefactor/framework-profile.json` of the workspace (written by
 * `br profile`, data not code). Without it no framework conventions are known.
 */
function profileFor(root: string): PhpFrameworkProfile | undefined {
	// The cache follows the workspace and the profile file: a long-lived process (Pi) may serve several
	// workspaces, and `br profile` may rewrite the file — a stale or missing profile makes every framework
	// class look unmapped (phantom decisions).
	const ws = process.env["BR_WORKSPACE"];
	const file = ws ? join(ws, ".bigrefactor", "framework-profile.json") : undefined;
	let mtime = 0;
	try {
		mtime = file ? statSync(file).mtimeMs : 0;
	} catch {
		/* no generated profile */
	}
	const key = `${ws ?? ""}|${root}|${mtime}`;
	if (key !== activeKey) {
		activeKey = key;
		activeProfile = null;
	}
	if (activeProfile === null) {
		activeProfile = undefined;
		if (file && existsSync(file)) {
			try {
				activeProfile = profileFromJson(JSON.parse(readFileSync(file, "utf8")) as FrameworkProfileJson);
			} catch (e) {
				throw new Error(`invalid ${file}: ${(e as Error).message}`);
			}
		}
	}
	return activeProfile;
}

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

export function profileFromJson(j: FrameworkProfileJson): PhpFrameworkProfile {
	const re = (x: string | undefined) => (x ? new RegExp(x, "i") : undefined);
	const fill = (g: string, args: Array<string | undefined>) => g.replace(/\$(\d)/g, (_, i) => args[Number(i) - 1] ?? "\u0000");
	return {
		id: j.id,
		detect: () => true,
		frameworkDirs: j.frameworkDirs,
		loaders(scope, method, args) {
			const out: string[] = [];
			for (const l of j.loaders) {
				if ((l.scope ?? null) !== (scope ?? null) || l.method !== method) continue;
				if (l.each) for (const a of args) { if (typeof a === "string") for (const g of l.globs) out.push(fill(g, [a])); }
				else for (const g of l.globs) { const f = fill(g, args); if (!f.includes("\u0000")) out.push(f); }
			}
			return out;
		},
		impliedDeps: (relPath) => (j.impliedDeps ?? []).flatMap((d) => { const m = new RegExp(d.match).exec(relPath); return m ? d.globs.map((g) => g.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? "")) : []; }),
		entryPoint: re(j.entryPoint),
		routeClass: re(j.routeClass),
		concerns: j.concerns.map((c) => ({ match: new RegExp(c.match, "i"), concern: c.concern, legacy: c.legacy, verdict: c.verdict })),
		legacyWords: j.legacyWords?.map((w) => w.toLowerCase()),
	};
}

/** A worked gyro profile: the example `br profile` shows the model (never used as a profile itself). */
export function exampleProfileJson(): FrameworkProfileJson {
	return {
		id: "gyro",
		frameworkDirs: ["gyro-php/"],
		loaders: [
			{ scope: "Load", method: "models", each: true, globs: ["**/model/**/$1.model.php", "**/model/**/$1.facade.php"] },
			{ scope: "Load", method: "components", each: true, globs: ["**/lib/components/**/$1.cls.php", "**/lib/components/**/$1.inc.php"] },
			{ scope: "Load", method: "interfaces", each: true, globs: ["**/lib/interfaces/**/$1.cls.php"] },
			{ scope: "Load", method: "commands", each: true, globs: ["**/behaviour/commands/$1.cmd.php"] },
			{ scope: "Load", method: "tools", each: true, globs: ["**/controller/tools/$1.cls.php"] },
			{ scope: "Load", method: "controllers", each: true, globs: ["**/controller/**/$1.controller.php"] },
			{ scope: "Load", method: "directories", each: true, globs: ["**/$1/*.php"] },
			{ scope: "Load", method: "enable_module", each: true, globs: ["**/modules/$1/**/*.php", "**/contributions/$1/**/*.php"] },
			{ scope: "Load", method: "files", each: true, globs: ["**/$1"] },
			{ scope: "CommandsFactory", method: "create_command", globs: ["**/behaviour/commands/$1/$2.cmd.php", "**/behaviour/commands/*/$2.cmd.php", "**/behaviour/commands/generics/$2.cmd.php"] },
			{ scope: "ViewFactory", method: "create_view", globs: ["**/view/templates/**/$2.tpl.php", "**/view/templates/**/$2"] },
			{ scope: null, method: "include_template", globs: ["**/view/templates/**/$1.tpl.php", "**/view/templates/**/$1"] },
		],
		impliedDeps: [{ match: "(^|/)model/classes/([a-z0-9_]+)\\.model\\.php$", globs: ["**/behaviour/commands/$2/*.cmd.php"] }],
		entryPoint: "(^|/)www/index\\.php$|(^|/)run_console\\.php$|(^|/)controller/[^/]+\\.controller\\.php$|(^|/)behaviour/accesscontrol/[^/]+\\.access\\.php$|(^|/)enabled\\.inc\\.php$",
		routeClass: "Route$",
		concerns: [
			{ match: "^(Load|Config|Constants?)$", concern: "loading", legacy: "convention loader (Load::models/components/commands) + constants", verdict: "platform" },
			{ match: "^(DB|DBQuery|DBDriver|DBField|DataObjectBase|DAO|DBTable|DBWhere|DBJoin|IDataObject|Query|DBSql|DBResult)", concern: "orm", legacy: "DataObject ORM, query builder, drivers", verdict: "platform" },
			{ match: "^(RouterBase|.*Route|Url|PageData|Dispatcher|RequestInfo|ControllerBase|IController|ControllerDefaultClassInstantiater|IRoute)$", concern: "routing", legacy: "routes declared in controllers (get_routes), PageData request bag", verdict: "platform" },
			{ match: "^(AccessControl|AccessControlBase|Users|Session|UserRoles?|Permissions?|Login|Password|Authenticat|IAccessControl)", concern: "auth", legacy: "session login, roles, per-route access checks", verdict: "port" },
			{ match: "^(View|ViewBase|ViewFactory|IView|IViewFactory|Template|Templater|.*View|.*Renderer|RenderDecorator|Widget.*|Form.*|Html|Formatter|IWidget|IRenderDecorator)$", concern: "rendering", legacy: "server-side PHP templates, widgets, render decorators", verdict: "platform" },
			{ match: "^(CommandsFactory|CommandBase|ICommand|.*Command|CommandChain|CommandComposite|CommandsFactoryBase)$", concern: "commands", legacy: "command objects for writes (create/update/delete/…)", verdict: "port" },
			{ match: "^(.*CacheManager|Cache|CacheBase|.*Cache|ICacheManager)$", concern: "cache", legacy: "page cache managers", verdict: "platform" },
			{ match: "^(Mail|MailMessage|Mailer|.*Mail)$", concern: "mail", legacy: "mail messages", verdict: "platform" },
			{ match: "^(Scheduler|Cron|Console|Task.*|Job.*|Queue)", concern: "jobs", legacy: "console runner, scheduled tasks", verdict: "platform" },
			{ match: "^(EventSource|Event.*|.*EventSink|Hook|IEventSink)", concern: "events", legacy: "event source / sinks", verdict: "platform" },
			{ match: "^(Arr|String|Str|Common|Date|DateTime|GyroDate|Number|Math|Util|Helpers?|Validation|Validator|Input|Sanitizer|Convert|Converter|ConverterFactory|IConverter|Filter.*)", concern: "helpers", legacy: "array/string/date helpers, validation, converters", verdict: "platform" },
			{ match: "^(Translator|Translation|I18n|Locale|GyroLocale|tr)$", concern: "i18n", legacy: "translation helper", verdict: "platform" },
			{ match: "^(Logger|Log|Debug|Sentry|ILogger)", concern: "logging", legacy: "file logger", verdict: "platform" },
			{ match: "^(Http|HttpRequest|HttpResponse|Response|Status|Url.*|Cookie|Header)", concern: "http", legacy: "HTTP primitives", verdict: "platform" },
			{ match: "^(Install|Systemupdate|SystemUpdate|Update|Migration|.*Update)", concern: "install", legacy: "install scripts & system updates (schema versioning)", verdict: "drop" },
			{ match: "^(Simpletest|.*Test|Mock.*|GyroUnitTestCase)", concern: "tests", legacy: "SimpleTest unit tests", verdict: "drop" },
			{ match: "^(Doxygen|Tidy|Phpinfo|Robots|Gsitemap|Mime|Offline|StaticPage|Json|Ajax|Status)", concern: "misc", legacy: "misc framework modules", verdict: "review" },
		],
		legacyWords: ["tpl", "cmd", "cls", "facade", "inc", "php", "phtml"],
	};
}
const CONTAINER_TYPES = ["class_declaration", "interface_declaration", "trait_declaration", "enum_declaration", "anonymous_class"];
/** Container name; anonymous classes get a synthetic one so their methods never merge into the enclosing class. */
const containerName = (n: Node | null): string | undefined => (!n ? undefined : n.type === "anonymous_class" ? `class@L${n.startPosition.row + 1}` : n.childForFieldName("name")?.text);
const FUNCTION_TYPES = ["method_declaration", "function_definition"];

/**
 * Route handler names are action names; the route class decides the method prefix (gyro: `action_x`,
 * `forwardaction_x`, `agencyaction_x`). Pick the class method that serves it, preferring one whose prefix the
 * route class name hints at, else plain `action_`.
 */
function routeHandler(symbols: IndexedSymbol[], cls: string, handler: string, routeClass: string): string {
	const methods = symbols.filter((s) => s.kind === "method" && s.name.startsWith(`${cls}::`)).map((s) => s.name.slice(cls.length + 2));
	const cands = methods.filter((m) => m === handler || new RegExp(`^[a-z]*action_${handler}$`, "i").test(m));
	if (cands.length <= 1) return cands[0] ?? handler;
	const hinted = cands.find((m) => m.indexOf("action_") > 0 && routeClass.toLowerCase().includes(m.slice(0, m.indexOf("action_")).toLowerCase()));
	return hinted ?? cands.find((m) => m === `action_${handler}`) ?? cands[0]!;
}

const typeName = (t: string | undefined): string | undefined => {
	const n = t?.replace(/^\?/, "").replace(/^\\/, "").split("|")[0]?.trim();
	return n && /^[A-Z_][\w\\]*$/i.test(n) && !/^(int|float|string|bool|array|mixed|void|null|callable|iterable|object|never|false|true)$/i.test(n) ? n.split("\\").pop() : undefined;
};

/** A comment's words without PHP comment markers (`//`, `#`, `/* *\/`, docblock `*`). */
const commentBody = (text: string): string =>
	text
		.split("\n")
		.map((l) => l.replace(/^\s*(\/\*+|\/\/+|#|\*(?!\/))\s?/, "").replace(/\s*\*+\/\s*$/, "").trimEnd())
		.join("\n")
		.trim();
const BANNER = /^(copyright|\(c\)|license|licence|all rights reserved|@author|\$Id[:$]|this (library|program|file) is free software)/im;
const SEPARATOR = /^[\s=*#+\-|_~.]*$/;

/** Commented-out code: the comment's text parses as PHP statements without errors. */
async function looksLikeCode(text: string): Promise<boolean> {
	const body = commentBody(text);
	if (!body || !/[;{}]\s*$/.test(body) || /^[A-Z][a-z]+\s+[a-z]+\s+[a-z]+/.test(body)) return false;
	try {
		const t = await parse("php", `<?php ${body}`);
		return !t.rootNode.hasError;
	} catch {
		return false;
	}
}

/** Functions (with comments, calls, local types) and containers of one parsed file. */
async function codeMap(root: Node, idOf: Map<number, string>): Promise<{ functions: CodeFunction[]; containers: CodeContainer[] }> {
	const functions: CodeFunction[] = [];
	const containers: CodeContainer[] = [];
	const fnNodes: Node[] = [];
	walk(root, (n) => {
		if (CONTAINER_TYPES.includes(n.type)) {
			const name = containerName(n);
			if (name) {
				const parent = n.namedChildren.find((c) => c?.type === "base_clause")?.namedChildren[0]?.text;
				const uses: string[] = [];
				walk(n.childForFieldName("body") ?? n, (u) => {
					if (u.type === "use_declaration") for (const x of u.namedChildren) if (x?.type === "name" || x?.type === "qualified_name") uses.push(x.text.split("\\").pop()!);
					return !FUNCTION_TYPES.includes(u.type);
				});
				containers.push({ name, parent: parent?.split("\\").pop(), uses: uses.length ? uses : undefined });
			}
		}
		if (FUNCTION_TYPES.includes(n.type)) fnNodes.push(n);
		return true;
	});
	for (const fn of fnNodes) {
		const id = idOf.get(fn.startIndex);
		if (!id) continue;
		// only methods belong to a class; a function declared inside a method is still a global function
		const container = fn.type === "method_declaration" ? containerName(enclosing(fn, CONTAINER_TYPES)) : undefined;
		const body = fn.childForFieldName("body");
		const comments: CodeComment[] = [];
		const toComment = async (c: Node, kind?: CodeComment["kind"]): Promise<CodeComment> => {
			const body = commentBody(c.text);
			return {
				line: c.startPosition.row + 1, endLine: c.endPosition.row + 1, col: c.startPosition.column, endCol: c.endPosition.column, text: c.text, body,
				kind: BANNER.test(body) || SEPARATOR.test(body) ? "banner" : (kind ?? ((await looksLikeCode(c.text)) ? "code" : "note")),
			};
		};
		// doc: the comment(s) right above the declaration (attributes may sit in between)
		for (let p = fn.previousNamedSibling; p && p.type === "comment"; p = p.previousNamedSibling) comments.unshift(await toComment(p, p.text.startsWith("/**") ? "doc" : undefined));
		const calls: CodeCall[] = [];
		const callAt = new Map<string, number>();
		const at = (n: Node) => `${n.startIndex}:${n.endIndex}`;
		const pending: Array<{ index: number; object: Node }> = [];
		const locals: Record<string, string> = {};
		const assigned: Record<string, number> = {};
		const assigns: Array<{ v: string; right: Node }> = [];
		for (const p of fn.childForFieldName("parameters")?.namedChildren ?? []) {
			const t = typeName(p?.childForFieldName("type")?.text);
			const v = p?.childForFieldName("name")?.text;
			if (t && v) locals[v] = t;
		}
		const inner: Node[] = [];
		if (body)
			walk(body, (n) => {
				if (n !== body && (FUNCTION_TYPES.includes(n.type) || CONTAINER_TYPES.includes(n.type))) return false;
				inner.push(n);
				return true;
			});
		for (const n of inner) {
			const line = n.startPosition.row + 1;
			if (n.type === "comment") comments.push(await toComment(n));
			else if (n.type === "function_call_expression") {
				const f = n.childForFieldName("function");
				if (f && (f.type === "name" || f.type === "qualified_name")) { callAt.set(at(n), calls.length); calls.push({ line, kind: "function", name: f.text.split("\\").pop()! }); }
			} else if (n.type === "scoped_call_expression") {
				const scope = n.childForFieldName("scope")?.text ?? "";
				const name = n.childForFieldName("name")?.text;
				if (name && /^\w+$/.test(name)) { callAt.set(at(n), calls.length); calls.push({ line, kind: "static", name, scope: /^(self|static)$/i.test(scope) ? "self" : /^parent$/i.test(scope) ? "parent" : scope.split("\\").pop() }); }
			} else if (n.type === "member_call_expression" || n.type === "nullsafe_member_call_expression") {
				const obj = n.childForFieldName("object");
				const name = n.childForFieldName("name")?.text;
				if (name && /^\w+$/.test(name) && obj) {
					const index = calls.length;
					callAt.set(at(n), index);
					calls.push({ line, kind: "member", name, receiver: obj.text === "$this" ? "this" : obj.type === "variable_name" ? obj.text : undefined });
					pending.push({ index, object: obj });
				}
			} else if (n.type === "object_creation_expression") {
				const t = n.namedChildren.find((x) => x?.type === "name" || x?.type === "qualified_name")?.text;
				if (t) { callAt.set(at(n), calls.length); calls.push({ line, kind: "new", name: t.split("\\").pop()! }); }
			} else if (n.type === "assignment_expression") {
				const l = n.childForFieldName("left");
				const r = n.childForFieldName("right");
				if (l?.type === "variable_name" && r) assigns.push({ v: l.text, right: r });
			}
		}
		for (const p of pending) {
			const idx = callAt.get(at(p.object));
			if (idx !== undefined) calls[p.index]!.receiverCall = idx;
		}
		for (const a of assigns) {
			if (a.right.type === "object_creation_expression") {
				const t = a.right.namedChildren.find((x) => x?.type === "name" || x?.type === "qualified_name")?.text;
				if (t) locals[a.v] ??= t.split("\\").pop()!;
			} else {
				const idx = callAt.get(at(a.right));
				if (idx !== undefined && !(a.v in locals)) assigned[a.v] = idx;
			}
		}
		// doc annotations: @var Type $x / @var $x Type / @param Type $x
		for (const c of comments) {
			for (const m of c.text.matchAll(/@(?:var|param)\s+([\\\w|?]+)\s+(\$\w+)|@var\s+(\$\w+)\s+([\\\w|?]+)/g)) {
				const [v, t] = m[2] ? [m[2], typeName(m[1])] : [m[3]!, typeName(m[4])];
				if (t && !(v in locals)) locals[v] = t;
			}
		}
		const name = fn.childForFieldName("name")?.text ?? "?";
		let returns = typeName(fn.childForFieldName("return_type")?.text);
		if (!returns) for (const c of comments) if (c.kind === "doc") returns = typeName(/@return\s+([\\\w|?]+)/.exec(c.text)?.[1]) ?? returns;
		if (returns && /^(self|static)$/i.test(returns)) returns = container;
		const head = fn.text.slice(0, body ? body.startIndex - fn.startIndex : undefined).replace(/\s+/g, " ").trim();
		functions.push({ id, container, name, line: fn.startPosition.row + 1, endLine: fn.endPosition.row + 1, signature: head, returns, comments, calls, locals, assigned });
	}
	return { functions, containers };
}

function stringArgs(callNode: Node | null): Array<string | undefined> {
	// `arguments` is a field on scoped/function calls but a plain child on object_creation_expression
	const args = callNode?.childForFieldName("arguments") ?? callNode?.namedChildren.find((n) => n?.type === "arguments") ?? null;
	return (args?.namedChildren ?? []).map((a) => {
		const v = a?.type === "argument" ? a.namedChildren[0] : a;
		if (v && (v.type === "string" || v.type === "encapsed_string") && !/\$/.test(v.text)) return v.text.replace(/^['"]|['"]$/g, "");
		return undefined;
	});
}

const SKIP_DIRS = new Set(["vendor", "node_modules", ".git", "storage", "cache", "dist", "build"]);
/** Count files matching `re` under `root`, at most `depth` levels deep, stopping early at `limit`. */
function countFiles(root: string, re: RegExp, depth: number, limit: number): number {
	let n = 0;
	const visit = (dir: string, d: number) => {
		if (n >= limit || d > depth) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (n >= limit) return;
			if (e.isDirectory()) {
				if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) visit(join(dir, e.name), d + 1);
			} else if (re.test(e.name)) n++;
		}
	};
	visit(root, 0);
	return n;
}

export const phpAdapter: SourceAdapter = {
	id: "php",
	names: { caseInsensitive: true },
	traits: {
		globalState: /\$_SESSION|\$_COOKIE|\$GLOBALS|^\s*global\s+\$|\bsession_(start|id|destroy)\(/m,
		languageArtifacts: ["loose truthiness/emptiness checks (empty(), == between strings and numbers)", "implicit type coercion of numeric strings", "arrays used as untyped records"],
		mutatingCommands: /\bcomposer\s+(install|update|require|remove)\b/,
		vendorDirs: ["vendor"],
	},
	include: ["**/*.php", "**/*.phtml", "**/*.inc"],
	exclude: ["**/vendor/**", "**/docs/**", "**/3rdparty/**", "**/third_party/**", "**/third-party/**", "**/node_modules/**", "**/.git/**", "**/tests/**", "**/test/**", "**/cache/**", "**/storage/**"],
	docs: [
		{ name: "PHP manual (language reference)", url: "https://www.php.net/manual/en/langref.php" },
		{ name: "PHPUnit", url: "https://docs.phpunit.de/" },
	],

	async detect(root) {
		if (!existsSync(root) || !statSync(root).isDirectory()) return { confidence: 0 };
		const fw = isGyroRoot(root) ? "gyro" : undefined;
		const composer = join(root, "composer.json");
		if (existsSync(composer)) {
			try {
				const c = JSON.parse(readFileSync(composer, "utf8"));
				const req = { ...(c.require ?? {}), ...(c["require-dev"] ?? {}) } as Record<string, string>;
				const framework = req["laravel/framework"] ? "laravel" : req["symfony/framework-bundle"] ? "symfony" : req["slim/slim"] ? "slim" : fw;
				return { confidence: 0.95, framework, version: req["php"] };
			} catch {
				return { confidence: 0.8, framework: fw };
			}
		}
		if (fw) return { confidence: 0.9, framework: fw };
		// No manifest: look at the files themselves (bounded walk, vendor-ish dirs skipped).
		const n = countFiles(root, /\.(php|phtml|inc)$/, 4, 200);
		if (n >= 20) return { confidence: 0.85 };
		if (n > 0) return { confidence: 0.7 };
		return { confidence: 0 };
	},

	async indexFile(root, relPath, source) {
		const tree = await parse("php", source);
		const hash = createHash("sha1").update(source).digest("hex");
		const loc = source.split("\n").length;
		const symbols: IndexedSymbol[] = [];
		const deps: IndexedDep[] = [];
		const queries: IndexedQuery[] = [];
		const literalRefs = new Set<string>();
		const dynamicMarkers = new Set<string>();

		// Unique per file: anonymous classes and conditional re-declarations repeat names, nothing may be lost.
		const seenIds = new Map<string, number>();
		const symId = (name: string) => {
			const base = `${relPath}::${name}`;
			const n = (seenIds.get(base) ?? 0) + 1;
			seenIds.set(base, n);
			return n === 1 ? base : `${base}#${n}`;
		};
		const enclosingClassName = (n: Node): string | undefined => containerName(enclosing(n, CONTAINER_TYPES));

		// --- symbols. Each declaration gets its id once; edges look it up by node (never mint again).
		const idOf = new Map<number, string>();
		const declId = (decl: Node, name: string) => {
			const id = symId(name);
			idOf.set(decl.startIndex, id);
			return id;
		};
		for (const c of await captures("php", tree, SYMBOL_QUERY)) {
			const name = c.node.text;
			const decl = c.node.parent!;
			const line = c.node.startPosition.row + 1;
			const endLine = decl.endPosition.row + 1;
			const body = decl.type === "const_element" ? decl : decl;
			const astHash = createHash("sha1").update(normalizedAst(body)).digest("hex").slice(0, 16);
			switch (c.name) {
				case "fn":
					symbols.push({ id: declId(decl, name), path: relPath, kind: "function", name, line, endLine, exported: true, astHash, signature: decl.childForFieldName("parameters")?.text });
					break;
				case "cls":
				case "iface":
				case "trait":
				case "enum":
					symbols.push({ id: declId(decl, name), path: relPath, kind: c.name === "cls" ? "class" : c.name === "iface" ? "interface" : c.name === "trait" ? "trait" : "enum", name, line, endLine, exported: true, astHash });
					break;
				case "method": {
					const cls = enclosingClassName(c.node) ?? "?";
					const isPrivate = /\bprivate\b/.test(decl.text.slice(0, decl.text.indexOf("function")));
					symbols.push({ id: declId(decl, `${cls}::${name}`), path: relPath, kind: "method", name: `${cls}::${name}`, line, endLine, exported: !isPrivate, astHash, signature: decl.childForFieldName("parameters")?.text });
					break;
				}
				case "const": {
					const cls = enclosingClassName(c.node);
					symbols.push({ id: declId(decl, cls ? `${cls}::${name}` : name), path: relPath, kind: "const", name: cls ? `${cls}::${name}` : name, line, endLine, exported: true });
					break;
				}
			}
		}

		const routes: IndexedRoute[] = [];
		// --- deps: edges are attributed to the enclosing function/method, else to the file.
		const owner = (n: Node): string => {
			const fn = enclosing(n, ["method_declaration", "function_definition"]);
			return (fn && idOf.get(fn.startIndex)) || relPath;
		};
		const classId = (n: Node): string => {
			const cls = enclosing(n, CONTAINER_TYPES);
			return (cls && idOf.get(cls.startIndex)) || relPath;
		};
		const caps = await captures("php", tree, DEP_QUERY);
		for (let i = 0; i < caps.length; i++) {
			const c = caps[i]!;
			const from = owner(c.node);
			switch (c.name) {
				case "call":
					if (/^(call_user_func|call_user_func_array|func_get_args|eval|create_function)$/.test(c.node.text)) dynamicMarkers.add(c.node.text);
					else {
						deps.push({ from, to: c.node.text, kind: "call" });
						const prof = profileFor(root);
						if (prof) for (const g of prof.loaders(null, c.node.text, stringArgs(c.node.parent))) deps.push({ from, to: `glob:${g}`, kind: "load" });
					}
					break;
				case "scope": {
					const meth = caps[i + 1];
					if (meth?.name === "smeth") {
						deps.push({ from, to: `${c.node.text}::${meth.node.text}`, kind: "static_call" });
						// convention loaders: Load::models('x') → file edge(s), by framework profile
						const prof = profileFor(root);
						if (prof) for (const g of prof.loaders(c.node.text, meth.node.text, stringArgs(c.node.parent))) deps.push({ from, to: `glob:${g}`, kind: "load" });
						i++;
					}
					break;
				}
				case "cconst_scope": {
					const nm = caps[i + 1];
					if (nm?.name === "cconst_name") {
						// Foo::class is a class reference, Foo::BAR a constant
						deps.push({ from, to: nm.node.text === "class" ? c.node.text : `${c.node.text}::${nm.node.text}`, kind: "use" });
						i++;
					}
					break;
				}
				case "new": {
					deps.push({ from, to: c.node.text, kind: "new" });
					// routes registered in code: new ExactMatchRoute('https://booking/partner/list', $this, 'agency_list', …)
					const prof = profileFor(root);
					if (prof?.routeClass?.test(c.node.text)) {
						const args = stringArgs(c.node.parent);
						const url = args[0];
						const handler = args.slice(1).find((a) => typeof a === "string");
						const cls = enclosingClassName(c.node);
						if (url && handler && cls && /^[a-z_][a-z0-9_]*$/i.test(handler)) {
							const path = url.replace(/^[a-z]+:\/\//, "").replace(/\{(\w+)[^}]*\}/g, "{$1}");
							routes.push({ id: `${relPath}#${routes.length + 1}`, method: "ANY", path, handlerSymbol: ((m) => symbols.find((s) => s.name === `${cls}::${m}`)?.id ?? `${cls}::${m}`)(routeHandler(symbols, cls, handler, c.node.text)) });
						}
					}
					break;
				}
				case "extends":
					deps.push({ from: classId(c.node), to: c.node.text, kind: "extends" });
					break;
				case "implements":
					deps.push({ from: classId(c.node), to: c.node.text, kind: "implements" });
					break;
				case "use_trait":
					deps.push({ from: classId(c.node), to: c.node.text, kind: "use" });
					break;
			}
		}

		// --- includes, dynamic constructs, string literals, SQL
		walk(tree.rootNode, (n) => {
			if (n.type === "require_once_expression" || n.type === "require_expression" || n.type === "include_once_expression" || n.type === "include_expression") {
				const target = resolveInclude(root, relPath, n.text);
				if (target) deps.push({ from: relPath, to: target, kind: "include" });
				else if (/\$/.test(n.text.replace("__DIR__", ""))) dynamicMarkers.add("variable include");
				return false;
			}
			if (n.type === "object_creation_expression" && n.namedChildren[0]?.type === "variable_name") dynamicMarkers.add("new $var");
			if (n.type === "string" || n.type === "encapsed_string") {
				const text = n.text.slice(1, -1);
				for (const m of text.matchAll(/\b([A-Z][A-Za-z0-9_]{2,})\b/g)) literalRefs.add(m[1]!);
				// resource keys ('users/mail/account.activated', 'campaign/edit'): matched against adapter.fileAliases
				if (/^[a-z0-9_.-]+(\/[a-z0-9_.-]+)*$/.test(text) && text.length >= 3 && text.length <= 120) literalRefs.add(text);
				const tables = new Set<string>();
				for (const re of SQL_RES) for (const m of text.matchAll(re)) tables.add(m[1]!);
				if (tables.size) queries.push({ symbolId: owner(n), kind: "sql", tables: [...tables], text: text.slice(0, 200) });
			}
			return true;
		});

		// Files without declarations (templates, route tables, scripts) get one synthetic symbol so the ledger accounts for every file.
		if (symbols.length === 0) {
			const isTemplate = TEMPLATE_RE.test(relPath) || /<\/?(html|body|div|table)\b|<\?=/.test(source);
			const isRoutes = ROUTES_RE.test(relPath);
			symbols.push({ id: symId(isTemplate ? "template" : isRoutes ? "routes" : "script"), path: relPath, kind: isTemplate ? "template" : isRoutes ? "route" : "other", name: relPath.split("/").pop()!, line: 1, exported: true });
		}

		for (const g of profileFor(root)?.impliedDeps?.(relPath) ?? []) deps.push({ from: relPath, to: `glob:${g}`, kind: "load" });
		const { functions, containers } = await codeMap(tree.rootNode, idOf);
		return { path: relPath, lang: "php", loc, hash, symbols, deps, routes, queries, literalRefs: [...literalRefs], dynamicMarkers: [...dynamicMarkers], functions, containers };
	},

	async indexRoutes(root) {
		// Plain-PHP route table: `['GET', '/path', [Cls::class, 'method']]`. Framework adapters add artisan/console dumps.
		const file = join(root, "routes.php");
		if (!existsSync(file)) return [];
		const src = readFileSync(file, "utf8");
		const out: IndexedRoute[] = [];
		for (const m of src.matchAll(/\[\s*'(GET|POST|PUT|PATCH|DELETE)'\s*,\s*'([^']+)'\s*,\s*\[\s*([A-Za-z_][A-Za-z0-9_\\]*)::class\s*,\s*'([^']+)'\s*\]/g)) {
			out.push({ id: `${m[1]} ${m[2]}`, method: m[1], path: m[2]!, handlerSymbol: `${m[3]!.split("\\").pop()}::${m[4]}` });
		}
		return out;
	},

	classifyTier(sym, file) {
		const text = readFileSync(join(process.env["BR_SOURCE_ROOT"] ?? "", file.path), "utf8").slice(0, 100_000);
		// no name-based "cross-cutting" tier: one symbol like isCommandInQueue made a whole feature T3. Whether code is
		// auth/jobs/logging is Jev's kind label (label_unit); tiers come from what the file does and its deps.
		if (TEMPLATE_RE.test(file.path) || ROUTES_RE.test(file.path)) return "T2";
		if (HTTP_MARKERS.some((m) => text.includes(m)) || /controllers?\//i.test(file.path)) return "T2";
		if (sym.kind === "const") return "T0";
		return undefined; // deps decide between T0 and T1
	},

	classifyKind(file) {
		if (TEMPLATE_RE.test(file.path)) return "template";
		if (ROUTES_RE.test(file.path)) return "routes";
		if (file.queries.length) return "data_access";
		return undefined;
	},

	isRegistrationFile(path) {
		return ROUTES_RE.test(path);
	},

	isEntryPoint(path) {
		// The framework profile names the entry points (its model read the repo: front controllers, CLI/cron scripts,
		// scan-discovered files). The common front-controller names stay as a floor: keeping a file alive is the safe
		// side, and before a file is dropped as dead Jev is asked about it (src/init/dead.ts).
		return /(^|\/)(index|app|bootstrap|run_console|start)(\.inc)?\.php$/.test(path) || /(^|\/)www\//.test(path) || (activeProfile?.entryPoint?.test(path) ?? false);
	},

	frameworkDirs(root) {
		return profileFor(root)?.frameworkDirs ?? [];
	},
	dbSignals(root) {
		const out: Array<{ engine: string; evidence: string }> = [];
		const composer = join(root, "composer.json");
		if (!existsSync(composer)) return out;
		let c: any;
		try { c = JSON.parse(readFileSync(composer, "utf8")); } catch { return out; }
		const req = { ...(c.require ?? {}), ...(c["require-dev"] ?? {}) } as Record<string, string>;
		const table: Array<[RegExp, string]> = [[/^ext-(mysqli|pdo_mysql)$/, "mysql"], [/^ext-(pgsql|pdo_pgsql)$/, "postgresql"], [/^ext-(pdo_sqlite|sqlite3)$/, "sqlite"], [/^ext-mongodb$|^mongodb\//, "mongodb"], [/arangodb/i, "arangodb"], [/^ext-redis$|^predis\//, "redis"]];
		for (const name of Object.keys(req)) for (const [re, engine] of table) if (re.test(name)) out.push({ engine, evidence: `composer.json requires ${name}` });
		return out;
	},
	reloadProfile() {
		activeProfile = null;
	},
	profileExample() {
		return {
			example: exampleProfileJson(),
			schemaDoc: `The file is JSON with: id (string); frameworkDirs (string[] path prefixes of the framework, relative to the legacy root, trailing slash); loaders (array of {scope: string|null, method: string, globs: string[], each?: boolean}) — scope is the class, module or namespace that qualifies the call (Load::models, Load.models, load.models; null for plain functions), method its name; impliedDeps (array of {match: regex over a file path, globs: string[] with $1… from the match groups}); entryPoint (regex over the file paths that run without other code including them: web front controllers, CLI/console and cron scripts, scripts that deploy or shell scripts call, and files the framework discovers by directory scan at boot; files nothing reaches are treated as dead code); legacyWords (string[], lowercase: the dotted file-name parts and extensions that mark a LEGACY file kind, e.g. "tpl" for x.tpl.php; only parts a well-named new codebase would never use, never ordinary words like controller, model, service, test, handler); routeClass (regex over class names whose constructor takes the URL as first string literal and the handler method name as the next string literal); concerns (array of {match: regex over class/interface/function names, concern: one of loading|orm|routing|auth|rendering|commands|cache|mail|jobs|events|helpers|i18n|logging|http|install|tests|misc, legacy: short description, verdict: platform|port|drop|review}).`,
		};
	},
	validateProfile(json) {
		const j = json as Partial<FrameworkProfileJson>;
		const problems: string[] = [];
		if (!j || typeof j !== "object") return ["not an object"];
		if (!j.id) problems.push("missing id");
		if (!Array.isArray(j.frameworkDirs)) problems.push("frameworkDirs must be an array (empty when the app has no separate framework)");
		// a framework has a loader and base-class families; an app without one (plain PHP) may have neither
		const fw = (j.frameworkDirs?.length ?? 0) > 0;
		if (!Array.isArray(j.loaders) || (fw && !j.loaders.length)) problems.push("loaders must be a non-empty array");
		for (const l of j.loaders ?? []) if (!l.method || !Array.isArray(l.globs) || !l.globs.length) problems.push(`loader ${JSON.stringify(l)} needs method + globs`);
		if (!Array.isArray(j.concerns) || (fw && j.concerns.length < 4)) problems.push("concerns must list at least 4 class families");
		const concernKeys = new Set(["loading", "orm", "routing", "auth", "rendering", "commands", "cache", "mail", "jobs", "events", "helpers", "i18n", "logging", "http", "install", "tests", "misc"]);
		for (const c of j.concerns ?? []) {
			if (!concernKeys.has(c.concern)) problems.push(`unknown concern key ${c.concern}`);
			try { new RegExp(c.match); } catch { problems.push(`bad regex ${c.match}`); }
		}
		for (const r of [j.entryPoint, j.routeClass]) if (r) { try { new RegExp(r); } catch { problems.push(`bad regex ${r}`); } }
		if (j.legacyWords !== undefined && (!Array.isArray(j.legacyWords) || j.legacyWords.some((w) => typeof w !== "string" || !/^[a-z0-9]+$/i.test(w)))) problems.push("legacyWords must be an array of single words");
		return problems;
	},
	// the profile's legacy file kinds (its model picked them from the real file suffixes); none without a profile
	get legacyWords() {
		return profileFor(process.env["BR_SOURCE_ROOT"] ?? "")?.legacyWords;
	},
	placeFile(path, root) {
		return placePhpFile(path, root, isGyroRoot);
	},
	unitGroupOf(path) {
		// model + facade of the same entity are one unit of meaning (gyro: x.model.php / x.facade.php)
		const m = /(^|\/)([a-z0-9_]+)\.(model|facade)\.php$/.exec(path);
		return m ? `${path.slice(0, m.index)}${m[1]}model:${m[2]}` : undefined;
	},
	fileAliases(path) {
		const out: string[] = [];
		const t = /(?:^|\/)(?:view\/)?templates\/[^/]+\/(.+?)(?:\.tpl)?\.php$/.exec(path) ?? /(?:^|\/)(?:resources\/)?views\/(.+?)(?:\.blade)?\.php$/.exec(path);
		if (t) out.push(t[1]!);
		const c = /(?:^|\/)commands\/(?:([a-z0-9_]+)\/)?([a-z0-9_.]+)\.cmd\.php$/.exec(path);
		if (c) out.push(c[2]!, c[1] ? `${c[1]}/${c[2]}` : c[2]!);
		return out;
	},
	get frameworkConcerns() {
		return activeProfile?.concerns ?? [];
	},
	externalDeps(root) {
		const out: ExternalDep[] = [];
		const composer = join(root, "composer.json");
		if (!existsSync(composer)) return out;
		let c: any;
		try { c = JSON.parse(readFileSync(composer, "utf8")); } catch { return out; }
		for (const [dev, block] of [[false, c.require ?? {}], [true, c["require-dev"] ?? {}]] as Array<[boolean, Record<string, string>]>) {
			for (const [name, version] of Object.entries(block)) {
				if (name === "php" || name.startsWith("ext-")) continue;
				out.push({ name, version, dev, verdict: "review" });
			}
		}
		return out;
	},

	truth: {
		scriptName: "cases.php",
		run: (_sourceRoot, scriptPath) => ({ cmd: "php", args: [scriptPath] }),
		instructions: "a PHP script that require()s the legacy files (paths relative to the legacy root; it is executed from there), executes each case and prints ONE JSON array via echo json_encode(...). Run it with bash (php <script>) and iterate until it exits 0 and prints valid JSON.",
	},

	oldTestCommand(root) {
		return existsSync(join(root, "vendor/bin/phpunit")) ? "vendor/bin/phpunit" : "phpunit";
	},
};

function resolveInclude(root: string, fromRel: string, expr: string): string | undefined {
	// `require_once __DIR__ . '/../Pricing.php'` → path relative to root
	const m = /__DIR__\s*\.\s*'([^']+)'/.exec(expr) ?? /['"]([^'"]+\.php)['"]/.exec(expr);
	if (!m) return undefined;
	const target = normalize(join(dirname(join(root, fromRel)), m[1]!));
	return existsSync(target) ? relative(root, target) : basename(m[1]!);
}

/** A gyro checkout: the framework vendored next to the app. */
function isGyroRoot(root: string): boolean {
	return existsSync(join(root, "gyro-php")) || existsSync(join(root, "gyro"));
}
