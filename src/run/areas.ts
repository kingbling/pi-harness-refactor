import { basename } from "node:path";

/** Area names (stack-neutral): leaf module, so source adapters can use it without an import cycle. */

/** Area a source adapter returns for cross-cutting foundation code (base classes, generic widgets): always shared. */
export const SHARED_AREA = "common";

/** `Billing_Items`, `billingItems` → `billing-items`. Areas are kebab-case without dots. */
export function kebab(s: string): string {
	return s
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** Cheap English singular for name matching: categories → category, boxes → box, players → player; status stays. */
export function singular(w: string): string {
	if (/ies$/.test(w) && w.length > 4) return w.slice(0, -3) + "y";
	if (/(ss|x|ch|sh|us)es$/.test(w)) return w.slice(0, -2);
	if (/s$/.test(w) && !/(ss|us|is)$/.test(w) && w.length > 3) return w.slice(0, -1);
	return w;
}

/** Directory names that say what a file IS (layer/kind), not which feature it belongs to. */
/** Layer words common to most stacks; a language adds its own conventions via SourceTraits.layerDirs. */
const LAYER_DIR = /^(src|source|lib|libs|app|apps|controllers?|models?|views?|templates?|services?|repositories|repos?|helpers?|utils?|components?|modules?|core|common|shared|public|web|http|legacy|base|domain|entities|entity|handlers?|actions?)$/i;
const KIND_SUFFIX = /(Controller|Repository|Repo|Service|Model|Facade|Handler|Helper|Manager|Factory|View|Template|Page|Action|Command)$/;

/**
 * Stack-neutral fallback: the outermost directory that names a feature (`billing/…` → billing); in a
 * layer-first tree (`controllers/InvoiceController.x`) the file's own name minus its kind suffix (→ invoice).
 */
export function genericArea(path: string, layerDirs: string[] = []): string {
	const parts = path.split("/").filter(Boolean);
	const file = parts.pop() ?? "unit";
	const dir = parts.find((d) => !LAYER_DIR.test(d) && !layerDirs.includes(d.toLowerCase()));
	if (dir) return kebab(dir) || SHARED_AREA;
	const stem = basename(file).split(".")[0]!;
	return kebab(stem.replace(KIND_SUFFIX, "") || stem) || SHARED_AREA;
}
