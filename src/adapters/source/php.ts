import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, normalize, relative } from "node:path";
import { captures, enclosing, normalizedAst, parse, walk, type Node } from "../../inventory/treesitter.ts";
import type { ExternalDep, FileIndex, FrameworkConcern, IndexedDep, IndexedQuery, IndexedRoute, IndexedSymbol, SourceAdapter } from "../types.ts";

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
const CROSS_CUTTING = /auth|session|middleware|cron|job|queue|logger|logging|csrf|guard/i;
const SQL_RES: RegExp[] = [
	/\bSELECT\b[\s\S]{0,400}?\bFROM\s+[`"]?([a-zA-Z_][a-zA-Z0-9_]*)/gi,
	/\bINSERT\s+INTO\s+[`"]?([a-zA-Z_][a-zA-Z0-9_]*)/gi,
	/\bUPDATE\s+[`"]?([a-zA-Z_][a-zA-Z0-9_]*)\s+SET\b/gi,
	/\bDELETE\s+FROM\s+[`"]?([a-zA-Z_][a-zA-Z0-9_]*)/gi,
	/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([a-zA-Z_][a-zA-Z0-9_]*)/gi,
	/\b(?:JOIN)\s+[`"]?([a-zA-Z_][a-zA-Z0-9_]*)/gi,
];

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
	/** Files discovered by directory scan at boot (controllers, access delegates…): alive without inbound edges. */
	entryPoint?: RegExp;
	/** `new SomethingRoute('url', $this, 'method', …)` → {urlArg, handlerArg} when the class is a route. */
	routeClass?: RegExp;
	concerns: FrameworkConcern[];
}

const GYRO: PhpFrameworkProfile = {
	id: "gyro",
	detect: (root) => existsSync(join(root, "gyro-php")) || existsSync(join(root, "gyro")),
	frameworkDirs: ["gyro-php/"],
	loaders(scope, method, args) {
		const lits = args.filter((a): a is string => typeof a === "string");
		const tpl = (name: string) => [`**/view/templates/**/${name}.tpl.php`, `**/view/templates/**/${name}`];
		if (scope === null) {
			if (method === "include_template" && args[0]) return tpl(args[0]);
			return [];
		}
		if (scope === "Load") {
			switch (method) {
				case "models": return lits.flatMap((m) => [`**/model/**/${m}.model.php`, `**/model/**/${m}.facade.php`]);
				case "components": return lits.flatMap((c) => [`**/lib/components/**/${c}.cls.php`, `**/lib/components/**/${c}.inc.php`]);
				case "interfaces": return lits.map((c) => `**/lib/interfaces/**/${c}.cls.php`);
				case "commands": return lits.map((c) => `**/behaviour/commands/${c}.cmd.php`);
				case "tools": return lits.map((t) => `**/controller/tools/${t}.cls.php`);
				case "controllers": return lits.map((c) => `**/controller/**/${c}.controller.php`);
				case "directories": return lits.map((d) => `**/${d}/*.php`);
				case "enable_module": return lits.flatMap((m) => [`**/modules/${m}/**/*.php`, `**/contributions/${m}/**/*.php`]);
				case "files": return lits.map((f) => `**/${f}`);
				default: return [];
			}
		}
		if (scope === "CommandsFactory" && method === "create_command" && typeof args[1] === "string") {
			const cmd = args[1];
			const inst = typeof args[0] === "string" ? [args[0] === "" ? "app" : args[0]] : ["*"]; // object → its table name: any model's command dir
			return [...inst.map((i) => `**/behaviour/commands/${i}/${cmd}.cmd.php`), `**/behaviour/commands/generics/${cmd}.cmd.php`];
		}
		if (scope === "ViewFactory" && method === "create_view" && typeof args[1] === "string") return tpl(args[1]);
		return [];
	},
	impliedDeps(relPath) {
		// generic model actions (edit/delete/create/status…) resolve commands by the model's table name at runtime
		const m = /(^|\/)model\/classes\/([a-z0-9_]+)\.model\.php$/.exec(relPath);
		return m ? [`**/behaviour/commands/${m[2]}/*.cmd.php`] : [];
	},
	entryPoint: /(^|\/)controller\/[^/]+\.controller\.php$|(^|\/)behaviour\/accesscontrol\/[^/]+\.access\.php$|(^|\/)enabled\.inc\.php$/,
	routeClass: /Route$/,
	concerns: [
		{ match: /^(Load|Config|Constants?)$/i, concern: "loading", legacy: "convention loader (Load::models/components/commands) + constants", verdict: "platform" },
		{ match: /^(DB|DBQuery|DBDriver|DBField|DataObjectBase|DAO|DBTable|DBWhere|DBJoin|IDataObject|Query|DBSql|DBResult)/i, concern: "orm", legacy: "DataObject ORM, query builder, drivers", verdict: "platform" },
		{ match: /^(RouterBase|.*Route|Url|PageData|Dispatcher|RequestInfo|ControllerBase|IController|ControllerDefaultClassInstantiater|IRoute)$/i, concern: "routing", legacy: "routes declared in controllers (get_routes), PageData request bag", verdict: "platform" },
		{ match: /^(AccessControl|AccessControlBase|Users|Session|UserRoles?|Permissions?|Login|Password|Authenticat|IAccessControl)/i, concern: "auth", legacy: "session login, roles, per-route access checks", verdict: "port" },
		{ match: /^(View|ViewBase|ViewFactory|IView|IViewFactory|Template|Templater|.*View|.*Renderer|RenderDecorator|Widget.*|Form.*|Html|Formatter|IWidget|IRenderDecorator)$/i, concern: "rendering", legacy: "server-side PHP templates, widgets, render decorators", verdict: "platform" },
		{ match: /^(CommandsFactory|CommandBase|ICommand|.*Command|CommandChain|CommandComposite|CommandsFactoryBase)$/i, concern: "commands", legacy: "command objects for writes (create/update/delete/…)", verdict: "port" },
		{ match: /^(.*CacheManager|Cache|CacheBase|.*Cache|ICacheManager)$/i, concern: "cache", legacy: "page cache managers", verdict: "platform" },
		{ match: /^(Mail|MailMessage|Mailer|.*Mail)$/i, concern: "mail", legacy: "mail messages", verdict: "platform" },
		{ match: /^(Scheduler|Cron|Console|Task.*|Job.*|Queue)/i, concern: "jobs", legacy: "console runner, scheduled tasks", verdict: "platform" },
		{ match: /^(EventSource|Event.*|.*EventSink|Hook|IEventSink)/i, concern: "events", legacy: "event source / sinks", verdict: "platform" },
		{ match: /^(Arr|String|Str|Common|Date|DateTime|GyroDate|Number|Math|Util|Helpers?|Validation|Validator|Input|Sanitizer|Convert|Converter|ConverterFactory|IConverter|Filter.*)/i, concern: "helpers", legacy: "array/string/date helpers, validation, converters", verdict: "platform" },
		{ match: /^(Translator|Translation|I18n|Locale|GyroLocale|tr)$/i, concern: "i18n", legacy: "translation helper", verdict: "platform" },
		{ match: /^(Logger|Log|Debug|Sentry|ILogger)/i, concern: "logging", legacy: "file logger", verdict: "platform" },
		{ match: /^(Http|HttpRequest|HttpResponse|Response|Status|Url.*|Cookie|Header)/i, concern: "http", legacy: "HTTP primitives", verdict: "platform" },
		{ match: /^(Install|Systemupdate|SystemUpdate|Update|Migration|.*Update)/i, concern: "install", legacy: "install scripts & system updates (schema versioning)", verdict: "drop" },
		{ match: /^(Simpletest|.*Test|Mock.*|GyroUnitTestCase)/i, concern: "tests", legacy: "SimpleTest unit tests", verdict: "drop" },
		{ match: /^(Doxygen|Tidy|Phpinfo|Robots|Gsitemap|Mime|Offline|StaticPage|Json|Ajax|Status)/i, concern: "misc", legacy: "misc framework modules", verdict: "review" },
	],
};

/** composer package → successor on a TypeScript platform (stack-neutral key: what the lib does). */
const COMPOSER_SUCCESSORS: Record<string, { successor: string; verdict: ExternalDep["verdict"]; note?: string }> = {
	"phpoffice/phpspreadsheet": { successor: "exceljs", verdict: "replace" },
	"phpoffice/phpexcel": { successor: "exceljs", verdict: "replace" },
	"tecnickcom/tcpdf": { successor: "pdfkit / puppeteer (HTML→PDF)", verdict: "replace" },
	"dompdf/dompdf": { successor: "puppeteer (HTML→PDF)", verdict: "replace" },
	"mpdf/mpdf": { successor: "puppeteer (HTML→PDF)", verdict: "replace" },
	"symfony/http-foundation": { successor: "platform HTTP layer", verdict: "platform" },
	"symfony/yaml": { successor: "yaml", verdict: "replace" },
	"symfony/console": { successor: "nest-commander / commander", verdict: "replace" },
	"guzzlehttp/guzzle": { successor: "fetch / axios", verdict: "replace" },
	"monolog/monolog": { successor: "platform logger (pino)", verdict: "platform" },
	"sentry/sentry": { successor: "@sentry/node", verdict: "replace" },
	"sentry/sdk": { successor: "@sentry/node", verdict: "replace" },
	"ramsey/uuid": { successor: "crypto.randomUUID", verdict: "replace" },
	"nesbot/carbon": { successor: "date-fns / luxon", verdict: "replace" },
	"league/csv": { successor: "csv-parse / csv-stringify", verdict: "replace" },
	"phpmailer/phpmailer": { successor: "nodemailer", verdict: "replace" },
	"swiftmailer/swiftmailer": { successor: "nodemailer", verdict: "replace" },
	"predis/predis": { successor: "ioredis", verdict: "replace" },
	"aws/aws-sdk-php": { successor: "@aws-sdk/*", verdict: "replace" },
	"google/apiclient": { successor: "googleapis", verdict: "replace" },
	"firebase/php-jwt": { successor: "jose / @nestjs/jwt", verdict: "replace" },
	"intervention/image": { successor: "sharp", verdict: "replace" },
	"phpunit/phpunit": { successor: "vitest", verdict: "drop", note: "legacy tests are the truth oracle; not ported as-is" },
	"phpstan/phpstan": { successor: "tsc + oxlint", verdict: "drop" },
	"rector/rector": { successor: "—", verdict: "drop" },
	"squizlabs/php_codesniffer": { successor: "oxlint / biome", verdict: "drop" },
	"friendsofphp/php-cs-fixer": { successor: "biome / prettier", verdict: "drop" },
	"vlucas/phpdotenv": { successor: "platform config (dotenv)", verdict: "platform" },
	"triagens/arangodb": { successor: "arangojs", verdict: "review", note: "second data store: see the store decision" },
	"james-heinrich/getid3": { successor: "music-metadata", verdict: "review", note: "audio/video metadata" },
	"setasign/fpdf": { successor: "pdfkit", verdict: "review", note: "PDF generation; puppeteer if layouts are HTML-like" },
	"phpfastcache/phpfastcache": { successor: "platform cache (cache-manager)", verdict: "review" },
	"phpseclib/phpseclib": { successor: "node:crypto / ssh2", verdict: "review", note: "depends on which parts are used (RSA? SFTP?)" },
};

const PROFILES: PhpFrameworkProfile[] = [GYRO];
let activeProfile: PhpFrameworkProfile | undefined | null = null; // null = not detected yet
let activeKey = ""; // workspace|source root|profile mtime the cached profile belongs to
/**
 * Profile resolution: a generated `.bigrefactor/framework-profile.json` in the workspace (written by
 * `br profile`, data not code) wins; the built-in tables are the fallback and the worked example.
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
		const builtin = PROFILES.find((p) => p.detect(root));
		if (file && existsSync(file)) {
			let generated: PhpFrameworkProfile;
			try {
				generated = profileFromJson(JSON.parse(readFileSync(file, "utf8")) as FrameworkProfileJson);
			} catch (e) {
				throw new Error(`invalid ${file}: ${(e as Error).message}`);
			}
			// the generated profile augments a matching built-in one: union of conventions, generated concerns first
			activeProfile = builtin && builtin.id === generated.id ? mergeProfiles(generated, builtin) : generated;
		} else activeProfile = builtin;
	}
	return activeProfile;
}

function mergeProfiles(a: PhpFrameworkProfile, b: PhpFrameworkProfile): PhpFrameworkProfile {
	const either = (x?: RegExp, y?: RegExp) => (x && y ? new RegExp(`(?:${x.source})|(?:${y.source})`, "i") : x ?? y);
	return {
		id: a.id,
		detect: () => true,
		frameworkDirs: [...new Set([...a.frameworkDirs, ...b.frameworkDirs])],
		loaders: (scope, method, args) => [...new Set([...a.loaders(scope, method, args), ...b.loaders(scope, method, args)])],
		impliedDeps: (p) => [...new Set([...(a.impliedDeps?.(p) ?? []), ...(b.impliedDeps?.(p) ?? [])])],
		entryPoint: either(a.entryPoint, b.entryPoint),
		routeClass: either(a.routeClass, b.routeClass),
		concerns: [...a.concerns, ...b.concerns],
	};
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
	};
}

/** The built-in profile as data: the example `br profile` shows the model, and the proof that JSON expresses everything the code path needs. */
export function builtinProfileJson(): FrameworkProfileJson {
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
		entryPoint: "(^|/)controller/[^/]+\\.controller\\.php$|(^|/)behaviour/accesscontrol/[^/]+\\.access\\.php$|(^|/)enabled\\.inc\\.php$",
		routeClass: "Route$",
		concerns: GYRO.concerns.map((c) => ({ match: c.match.source, concern: c.concern, legacy: c.legacy, verdict: c.verdict })),
	};
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
	include: ["**/*.php", "**/*.phtml", "**/*.inc"],
	exclude: ["**/vendor/**", "**/docs/**", "**/3rdparty/**", "**/third_party/**", "**/third-party/**", "**/node_modules/**", "**/.git/**", "**/tests/**", "**/test/**", "**/cache/**", "**/storage/**"],
	docs: [
		{ name: "PHP manual (language reference)", url: "https://www.php.net/manual/en/langref.php" },
		{ name: "PHPUnit", url: "https://docs.phpunit.de/" },
	],

	async detect(root) {
		if (!existsSync(root) || !statSync(root).isDirectory()) return { confidence: 0 };
		// Not profileFor(): that memoises the indexing run's profile; detect must judge this root alone.
		const profile = PROFILES.find((p) => p.detect(root));
		const composer = join(root, "composer.json");
		if (existsSync(composer)) {
			try {
				const c = JSON.parse(readFileSync(composer, "utf8"));
				const req = { ...(c.require ?? {}), ...(c["require-dev"] ?? {}) } as Record<string, string>;
				const framework = req["laravel/framework"] ? "laravel" : req["symfony/framework-bundle"] ? "symfony" : req["slim/slim"] ? "slim" : profile?.id;
				return { confidence: 0.95, framework, version: req["php"] };
			} catch {
				return { confidence: 0.8, framework: profile?.id };
			}
		}
		if (profile) return { confidence: 0.9, framework: profile.id };
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
		const enclosingClassName = (n: Node): string | undefined => {
			const cls = enclosing(n, ["class_declaration", "interface_declaration", "trait_declaration", "enum_declaration"]);
			return cls?.childForFieldName("name")?.text;
		};

		// --- symbols
		for (const c of await captures("php", tree, SYMBOL_QUERY)) {
			const name = c.node.text;
			const decl = c.node.parent!;
			const line = c.node.startPosition.row + 1;
			const body = decl.type === "const_element" ? decl : decl;
			const astHash = createHash("sha1").update(normalizedAst(body)).digest("hex").slice(0, 16);
			switch (c.name) {
				case "fn":
					symbols.push({ id: symId(name), path: relPath, kind: "function", name, line, exported: true, astHash, signature: decl.childForFieldName("parameters")?.text });
					break;
				case "cls":
				case "iface":
				case "trait":
				case "enum":
					symbols.push({ id: symId(name), path: relPath, kind: c.name === "cls" ? "class" : c.name === "iface" ? "interface" : c.name === "trait" ? "trait" : "enum", name, line, exported: true, astHash });
					break;
				case "method": {
					const cls = enclosingClassName(c.node) ?? "?";
					const isPrivate = /\bprivate\b/.test(decl.text.slice(0, decl.text.indexOf("function")));
					symbols.push({ id: symId(`${cls}::${name}`), path: relPath, kind: "method", name: `${cls}::${name}`, line, exported: !isPrivate, astHash, signature: decl.childForFieldName("parameters")?.text });
					break;
				}
				case "const": {
					const cls = enclosingClassName(c.node);
					symbols.push({ id: symId(cls ? `${cls}::${name}` : name), path: relPath, kind: "const", name: cls ? `${cls}::${name}` : name, line, exported: true });
					break;
				}
			}
		}

		const routes: IndexedRoute[] = [];
		// --- deps: edges are attributed to the enclosing function/method, else to the file.
		const owner = (n: Node): string => {
			const fn = enclosing(n, ["method_declaration", "function_definition"]);
			if (!fn) return relPath;
			const name = fn.childForFieldName("name")?.text ?? "?";
			if (fn.type === "method_declaration") return symId(`${enclosingClassName(fn) ?? "?"}::${name}`);
			return symId(name);
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
							routes.push({ id: `${relPath}#${routes.length + 1}`, method: "ANY", path, handlerSymbol: symId(`${cls}::${handler}`) });
						}
					}
					break;
				}
				case "extends":
					deps.push({ from: symId(enclosingClassName(c.node) ?? "?"), to: c.node.text, kind: "extends" });
					break;
				case "implements":
					deps.push({ from: symId(enclosingClassName(c.node) ?? "?"), to: c.node.text, kind: "implements" });
					break;
				case "use_trait":
					deps.push({ from: symId(enclosingClassName(c.node) ?? "?"), to: c.node.text, kind: "use" });
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
		return { path: relPath, lang: "php", loc, hash, symbols, deps, routes, queries, literalRefs: [...literalRefs], dynamicMarkers: [...dynamicMarkers] };
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
		if (CROSS_CUTTING.test(file.path) || CROSS_CUTTING.test(sym.name)) return "T3";
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
			example: builtinProfileJson(),
			schemaDoc: `The file is JSON with: id (string); frameworkDirs (string[] path prefixes of the framework, relative to the legacy root, trailing slash); loaders (array of {scope: string|null, method: string, globs: string[], each?: boolean}) — scope is the class of a static call (null for plain functions), method its name; impliedDeps (array of {match: regex over a file path, globs: string[] with $1… from the match groups}); entryPoint (regex over file paths discovered by directory scan at boot); routeClass (regex over class names whose constructor takes the URL as first string literal and the handler method name as the next string literal); concerns (array of {match: regex over class/interface/function names, concern: one of loading|orm|routing|auth|rendering|commands|cache|mail|jobs|events|helpers|i18n|logging|http|install|tests|misc, legacy: short description, verdict: platform|port|drop|review}).`,
		};
	},
	validateProfile(json) {
		const j = json as Partial<FrameworkProfileJson>;
		const problems: string[] = [];
		if (!j || typeof j !== "object") return ["not an object"];
		if (!j.id) problems.push("missing id");
		if (!Array.isArray(j.frameworkDirs) || !j.frameworkDirs.length) problems.push("frameworkDirs must be a non-empty array");
		if (!Array.isArray(j.loaders) || !j.loaders.length) problems.push("loaders must be a non-empty array");
		for (const l of j.loaders ?? []) if (!l.method || !Array.isArray(l.globs) || !l.globs.length) problems.push(`loader ${JSON.stringify(l)} needs method + globs`);
		if (!Array.isArray(j.concerns) || j.concerns.length < 4) problems.push("concerns must list at least 4 class families");
		const concernKeys = new Set(["loading", "orm", "routing", "auth", "rendering", "commands", "cache", "mail", "jobs", "events", "helpers", "i18n", "logging", "http", "install", "tests", "misc"]);
		for (const c of j.concerns ?? []) {
			if (!concernKeys.has(c.concern)) problems.push(`unknown concern key ${c.concern}`);
			try { new RegExp(c.match); } catch { problems.push(`bad regex ${c.match}`); }
		}
		for (const r of [j.entryPoint, j.routeClass]) if (r) { try { new RegExp(r); } catch { problems.push(`bad regex ${r}`); } }
		return problems;
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
				const norm = (n: string) => n.split("/")[1]!.replace(/[-_]?php$/i, "").replace(/^php[-_]?/i, "");
				const fork = name.includes("/") && !(name in COMPOSER_SUCCESSORS) ? Object.keys(COMPOSER_SUCCESSORS).find((k) => norm(k) === norm(name)) : undefined;
				const hit = COMPOSER_SUCCESSORS[name] ?? (fork ? COMPOSER_SUCCESSORS[fork] : undefined);
				out.push({ name, version, dev, successor: hit?.successor, verdict: hit?.verdict ?? "review", note: hit?.note ?? (fork ? `fork of ${fork}` : undefined) });
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
