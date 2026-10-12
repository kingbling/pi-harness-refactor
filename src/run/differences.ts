/** Shared by parity (old vs new app) and the truth check (two runs of the old code). */

export type Found = { path: string; a: unknown; b: unknown };

/** Every place two JSON values differ: object keys by name, arrays by position. */
export function differences(a: unknown, b: unknown, path = ""): Found[] {
	const obj = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);
	if (obj(a) && obj(b)) {
		const x = a as Record<string, unknown>;
		const y = b as Record<string, unknown>;
		return [...new Set([...Object.keys(x), ...Object.keys(y)])].flatMap((k) => differences(x[k], y[k], path ? `${path}.${k}` : k));
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		const out: Found[] = [];
		for (let i = 0; i < Math.max(a.length, b.length); i++) out.push(...differences(a[i], b[i], `${path}[${i}]`));
		return out;
	}
	return JSON.stringify(a) === JSON.stringify(b) ? [] : [{ path, a, b }];
}
