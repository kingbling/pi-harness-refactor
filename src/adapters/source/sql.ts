/** SQL in string literals, any language: the tables a statement names (data-access signal, DB lane wiring). */
export const SQL_RES: RegExp[] = [
	/\bSELECT\b[\s\S]{0,400}?\bFROM\s+[`"]?([a-zA-Z_][a-zA-Z0-9_]*)/gi,
	/\bINSERT\s+INTO\s+[`"]?([a-zA-Z_][a-zA-Z0-9_]*)/gi,
	/\bUPDATE\s+[`"]?([a-zA-Z_][a-zA-Z0-9_]*)\s+SET\b/gi,
	/\bDELETE\s+FROM\s+[`"]?([a-zA-Z_][a-zA-Z0-9_]*)/gi,
	/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([a-zA-Z_][a-zA-Z0-9_]*)/gi,
	/\b(?:JOIN)\s+[`"]?([a-zA-Z_][a-zA-Z0-9_]*)/gi,
];

export function sqlTables(text: string): string[] {
	const tables = new Set<string>();
	for (const re of SQL_RES) for (const m of text.matchAll(re)) tables.add(m[1]!);
	return [...tables];
}
