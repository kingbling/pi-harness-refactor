export const EXACT_JSON_VERSION = 1;

/** Canonical decimal notation, without expanding exponents or rounding through binary64. */
function decimalKey(text: string): string {
	const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
	if (!match) throw new Error(`invalid JSON number: ${text}`);
	const fraction = match[3] ?? "";
	let digits = `${match[2]}${fraction}`.replace(/^0+/, "");
	if (!digits) return match[1] ? "-0" : "0";
	const trimmed = digits.replace(/0+$/, "");
	const exponent = BigInt(match[4] ?? "0") - BigInt(fraction.length) + BigInt(digits.length - trimmed.length);
	digits = trimmed;
	return `${match[1]}${digits}${exponent === 0n ? "" : `e${exponent}`}`;
}

/** Only the parser creates these; an ordinary JSON object cannot impersonate a number. */
class ExactJsonNumber {
	readonly literal: string;
	#source: string;
	constructor(source: string) {
		this.literal = decimalKey(source);
		this.#source = source;
		Object.freeze(this);
	}
	toString(): string { return this.#source; }
	toJSON(): unknown {
		const raw = (JSON as unknown as { rawJSON?: (text: string) => unknown }).rawJSON;
		if (!raw) throw new Error("exact JSON evidence needs a runtime with JSON.rawJSON (Node 22.19 or newer)");
		return raw(this.literal);
	}
}

export const isExactJsonNumber = (value: unknown): value is ExactJsonNumber => value instanceof ExactJsonNumber;

/** Also distinguish non-finite native values and negative zero, rather than serializing them as null/zero. */
export function jsonNumberKey(value: unknown): string | undefined {
	if (isExactJsonNumber(value)) return value.literal;
	if (typeof value !== "number") return undefined;
	if (!Number.isFinite(value)) return `native:${String(value)}`;
	return Object.is(value, -0) ? "-0" : decimalKey(String(value));
}

/** Retain numbers whose JSON spelling would change value after the usual parse/stringify round trip. */
export function parseExactJson(text: string): unknown {
	return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
		if (typeof value !== "number") return value;
		if (context?.source === undefined) throw new Error("exact JSON parsing needs source-aware JSON.parse (Node 22.19 or newer)");
		const literal = decimalKey(context.source);
		return Number.isFinite(value) && !Object.is(value, -0) && literal === jsonNumberKey(value) ? value : new ExactJsonNumber(context.source);
	});
}
