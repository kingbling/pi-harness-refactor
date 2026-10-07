import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { kebab, SHARED_AREA, singular } from "../../run/areas.ts";

/**
 * Placement for PHP sources: legacy area + surface per file (see SourceAdapter.placeFile).
 *
 * gyro apps are layer-first (view/templates/<theme>/<area>/, behaviour/commands/<area>/, model/classes/<name>.model.php,
 * lib/components/<name>.cls.php); the feature is the directory below the layer or the file's name without its kind
 * suffix. Names are canonicalized against the app's own vocabulary, read once per source root:
 *  - primary roots: template and command directories (the app's own feature split);
 *  - secondary roots: model names.
 * A name maps to the root it equals or starts with (longest primary, then longest secondary; `x2y` link tables → x),
 * singular/plural converge and the most used spelling wins. Framework-free foundation (base classes, traits,
 * generic widgets, page shells) goes to SHARED_AREA; what the path cannot tell (entry scripts, unmatched helpers) is
 * left undefined for the model step.
 */

const COMMON = SHARED_AREA;
/** Directories below a layer that hold shared pieces, not a feature. */
const SHARED_DIRS = new Set(["ajax", "common", "vue", "widgets", "widget", "menu", "page", "inc", "js", "css", "shared", "mail", "mails", "layout", "partials", "generics", "base", "traits", "interfaces", "fields", "tools", "utils", "helpers", "exceptions", "routes", "renderdecorators"]);
const TEMPLATE_RE = /(^|\/)(templates?|views?|resources\/views)\/|\.phtml$|\.blade\.php$|\.tpl\.php$/i;
const MAIL_RE = /(^|\/)mails?\/|\.mail\.[a-z.]*php$/i;
const GYRO_SHAPE = /(^|\/)(view\/templates|behaviour\/commands|behaviour\/accesscontrol|model\/classes|lib\/components)\//;

export function phpSurface(path: string): "server" | "ui" {
	return TEMPLATE_RE.test(path) && !MAIL_RE.test(path) ? "ui" : "server";
}

const gyroRoots = new Map<string, boolean>();
/** Undefined when the path says nothing certain about its feature (the core then asks a model). */
export function placePhpFile(path: string, root: string | undefined, isGyro: (root: string) => boolean): { area: string; surface: "server" | "ui" } | undefined {
	const gyro = root ? (gyroRoots.get(root) ?? gyroRoots.set(root, isGyro(root)).get(root)!) : GYRO_SHAPE.test(path);
	if (!gyro) return undefined;
	const area = gyroArea(path, root ? vocabFor(root) : EMPTY);
	return area ? { area, surface: phpSurface(path) } : undefined;
}

interface Vocab {
	/** singular key → spelling to show */
	display: Map<string, string>;
	primary: string[]; // singular keys, longest first
	secondary: string[]; // shortest first
	/** first dot-segment of top-level components → file count (families of ≥2 get their own area) */
	families: Map<string, number>;
}
const EMPTY: Vocab = { display: new Map(), primary: [], secondary: [], families: new Map() };

const stem = (file: string) => basename(file).split(".")[0]!;
/** `releasecampaign2releaseplayer` → `releasecampaign`; `Billing_Items` → `billingitem` (match key). */
const key = (raw: string) => singular(entity(raw).toLowerCase().replace(/[^a-z0-9]/g, ""));
/** The entity a name is about: `x2y` link tables → x; `playerdetails`, `agencyextras` → player, agency. */
const entity = (raw: string) => raw.replace(/^([a-z]+)2[a-z0-9_]+$/i, "$1").replace(/^(.{3,}?)[-_]?(details?|extras?)$/i, "$1");

function gyroArea(path: string, v: Vocab): string | undefined {
	const mod = /(?:^|\/)(?:modules|contributions)\/([^/]+)\/(.+)$/.exec(path);
	if (mod) {
		const inner = gyroArea(mod[2]!, v);
		return !inner || inner === COMMON ? kebab(mod[1]!.split(".")[0]!) : inner;
	}
	let m: RegExpExecArray | null;
	if ((m = /(?:^|\/)view\/templates\/[^/]+\/(.+)$/.exec(path))) {
		const segs = m[1]!.split("/");
		if (segs.length === 1) return COMMON; // page shells (page, index, admin, blank…)
		return SHARED_DIRS.has(segs[0]!) ? COMMON : canon(segs[0]!, v);
	}
	if (/(?:^|\/)view\/translations\//.test(path)) return "i18n";
	if (/(?:^|\/)view\//.test(path)) return COMMON; // widgets
	if ((m = /(?:^|\/)behaviour\/commands\/(.+)$/.exec(path))) {
		const segs = m[1]!.split("/");
		if (SHARED_DIRS.has(segs[0]!)) return COMMON;
		return segs.length > 1 ? canon(segs[0]!, v) : match(stem(segs[0]!), v);
	}
	if ((m = /(?:^|\/)model\/classes\/(.+)$/.exec(path))) {
		const segs = m[1]!.split("/");
		return segs.length > 1 ? match(stem(segs.at(-1)!), v) : canon(stem(segs[0]!), v);
	}
	if ((m = /(?:^|\/)lib\/components\/(.+)$/.exec(path))) {
		const segs = m[1]!.split("/");
		if (segs.length > 1) return SHARED_DIRS.has(segs[0]!) ? match(stem(segs.at(-1)!), v) : canon(segs[0]!, v); // utils/releasemediafileinfo → releasemediafile
		const s = stem(segs[0]!);
		return match(s, v) ?? ((v.families.get(key(s)) ?? 0) >= 2 ? kebab(s) : undefined);
	}
	if ((m = /(?:^|\/)lib\/interfaces\/i?([^/]+)$/.exec(path))) return match(stem(m[1]!), v); // iplannable → plannings
	if ((m = /(?:^|\/)lib\/[^/]+\/([^/]+)$/.exec(path))) return match(stem(m[1]!), v); // helpers, exceptions
	if ((m = /(?:^|\/)controller\/([^/]+)$/.exec(path))) return canon(stem(m[1]!), v);
	if (/(?:^|\/)controller\//.test(path)) return COMMON; // base controllers, routes, traits, tools
	if ((m = /(?:^|\/)behaviour\/([^/]+)\/([^/]+)$/.exec(path))) return SHARED_DIRS.has(m[1]!) ? COMMON : canon(stem(m[2]!), v); // accesscontrol, confirmation handlers
	if (/(?:^|\/)behaviour\//.test(path)) return COMMON;
	if ((m = /(?:^|\/)(dashboards?)\//.exec(path))) return canon(m[1]!, v);
	return undefined; // entry scripts, bootstrap, stubs: the model decides
}

/** The area a name belongs to: its vocabulary root, else the name itself. */
function canon(raw: string, v: Vocab): string {
	return match(raw, v) ?? (kebab(raw) || COMMON);
}

function match(raw: string, v: Vocab): string | undefined {
	const k = key(raw);
	if (!k) return undefined;
	// primary: longest root (the app's own feature split stays); secondary: shortest (player, playerhistory → player)
	const hit = v.primary.find((r) => k.startsWith(r)) ?? v.secondary.find((r) => k.startsWith(r));
	return hit ? v.display.get(hit) : undefined;
}

const vocabs = new Map<string, Vocab>();
function vocabFor(root: string): Vocab {
	let v = vocabs.get(root);
	if (v) return v;
	const files: string[] = [];
	const skip = /^(vendor|node_modules|3rdparty|third_party|tests?|docs|cache|gyro-php|gyro)$|^\./;
	const walk = (rel: string, depth: number) => {
		if (depth > 10) return;
		let entries;
		try {
			entries = readdirSync(join(root, rel), { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) {
				if (!skip.test(e.name)) walk(p, depth + 1);
			} else if (/\.(php|phtml|inc)$/.test(e.name)) files.push(p);
		}
	};
	walk("", 0);
	v = buildVocab(files);
	vocabs.set(root, v);
	return v;
}

/** Exported for tests: the vocabulary of a file list. */
export function buildVocab(files: string[]): Vocab {
	const spellings = new Map<string, Map<string, number>>();
	const primary = new Set<string>();
	const secondary = new Set<string>();
	const families = new Map<string, number>();
	const add = (raw: string, set: Set<string>) => {
		const k = key(raw);
		if (k.length < 3 || SHARED_DIRS.has(raw)) return;
		set.add(k);
		const base = entity(raw);
		const name = kebab(base);
		const s = spellings.get(k) ?? new Map<string, number>();
		s.set(name, (s.get(name) ?? 0) + (base === raw ? 1 : 0)); // `players` beats `player` from `playerdetails`
		spellings.set(k, s);
	};
	for (const f of files) {
		let m: RegExpExecArray | null;
		if ((m = /(?:^|\/)view\/templates\/[^/]+\/([^/]+)\/./.exec(f))) add(m[1]!, primary);
		else if ((m = /(?:^|\/)behaviour\/commands\/([^/]+)\/./.exec(f))) add(m[1]!, primary);
		else if ((m = /(?:^|\/)model\/classes\/([^/]+)\.(?:model|facade)\.php$/.exec(f))) add(m[1]!, secondary);
		else if ((m = /(?:^|\/)lib\/components\/([^/]+)$/.exec(f))) families.set(key(stem(m[1]!)), (families.get(key(stem(m[1]!))) ?? 0) + 1);
	}
	const display = new Map<string, string>();
	for (const [k, s] of spellings) display.set(k, [...s].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))[0]![0]);
	const byLength = (xs: Set<string>, dir: 1 | -1) => [...xs].sort((a, b) => dir * (a.length - b.length) || a.localeCompare(b));
	return { display, primary: byLength(primary, -1), secondary: byLength(secondary, 1), families };
}
