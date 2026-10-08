import { dirname } from "node:path";

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

/**
 * A file's folder name: only a proposal for a file no area rule covers. Such a unit is never placed on it alone:
 * Jev chooses (the folder name is one candidate while no curated area set exists), else the owner is asked.
 * Which folders are business areas is the taxonomy model's call (taxonomy.ts writes the rules), not a word list.
 */
export function folderArea(path: string): string {
	return kebab(dirname(path).split("/").pop() ?? "") || SHARED_AREA;
}
