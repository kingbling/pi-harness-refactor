import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { getSourceAdapter, getTargetAdapter } from "../adapters/registry.ts";
import { statePath, type Config } from "../config.ts";
import { effectiveDocs } from "./stack.ts";

export interface DocEntry {
	tech: string;
	name: string;
	url: string;
	file: string; // path under .bigrefactor/docs
	bytes: number;
	kind: "llms.txt" | "llms-full.txt" | "html->text" | "text";
	fetchedAt: string;
}

const MAX_BYTES = 1_500_000;

/**
 * Fetch official docs for every technology involved (source stack + every target stack + extras)
 * into `.bigrefactor/docs/<tech>/`. Prefers `llms.txt` / `llms-full.txt` at the site root (LLM-ready),
 * otherwise strips the HTML. Agents pull from these via the `docs_lookup` tool; rule generation
 * at init validates its rules against them. Pure code, no model calls.
 */
export async function fetchDocs(config: Config, root: string, opts: { force?: boolean; log?: (line: string) => void } = {}): Promise<DocEntry[]> {
	// Progress goes through `log` so a host UI (the Pi extension) can capture it instead of it leaking to stdout.
	const log = opts.log ?? ((l: string) => console.log(l));
	const dir = statePath(root, "docs");
	const indexPath = join(dir, "index.json");
	if (!opts.force && existsSync(indexPath)) return JSON.parse(readFileSync(indexPath, "utf8")) as DocEntry[];

	const sources: Array<{ tech: string; name: string; url: string }> = [];
	const src = getSourceAdapter(config.source.stack);
	for (const d of src.docs) sources.push({ tech: src.id, ...d });
	for (const id of config.target.stacks) {
		const t = await getTargetAdapter(id);
		for (const d of effectiveDocs(t, config.target.choices)) sources.push({ tech: t.id, ...d });
	}
	for (const d of config.docs.extra) sources.push({ tech: "extra", ...d });

	const entries: DocEntry[] = [];
	const byUrl = new Map<string, DocEntry>(); // several doc pages of one site resolve to the same llms-full.txt
	for (const s of sources) {
		try {
			const e = await fetchOne(dir, s, byUrl);
			if (byUrl.has(e.url) && byUrl.get(e.url)!.file !== e.file) {
				log(pc.dim(`  ${s.tech}: ${s.name} (same as ${byUrl.get(e.url)!.name})`));
				continue;
			}
			byUrl.set(e.url, e);
			entries.push(e);
			log(pc.dim(`  ${s.tech}: ${s.name} ${(e.bytes / 1024).toFixed(0)} KB`));
		} catch (err: any) {
			log(pc.yellow(`  ${s.tech}: ${s.name} FAILED ${err?.message ?? err}`));
		}
	}
	writeFileSync(indexPath, JSON.stringify(entries, null, 2));
	return entries;
}

async function fetchOne(dir: string, s: { tech: string; name: string; url: string }, already: Map<string, DocEntry>): Promise<DocEntry> {
	const techDir = join(dir, s.tech);
	mkdirSync(techDir, { recursive: true });
	const slug = s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
	const origin = new URL(s.url).origin;
	for (const u of [`${origin}/llms-full.txt`, `${origin}/llms.txt`]) {
		const hit = already.get(u);
		if (hit) return { ...hit, name: s.name };
	}

	// 1) explicit llms.txt url, 2) llms-full.txt / llms.txt at origin, 3) the page itself.
	const candidates: Array<{ url: string; kind: DocEntry["kind"] }> = s.url.endsWith("llms.txt") || s.url.endsWith("llms-full.txt")
		? [{ url: s.url, kind: s.url.endsWith("full.txt") ? "llms-full.txt" : "llms.txt" }]
		: [
				{ url: `${origin}/llms-full.txt`, kind: "llms-full.txt" },
				{ url: `${origin}/llms.txt`, kind: "llms.txt" },
				{ url: s.url, kind: "html->text" },
			];
	for (const c of candidates) {
		const res = await fetch(c.url, { headers: { "user-agent": "bigrefactor/0.1 (+docs fetch)", accept: "text/plain, text/markdown, text/html" }, redirect: "follow", signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
		if (!res?.ok) continue;
		const ct = res.headers.get("content-type") ?? "";
		let text = await res.text();
		if (c.kind !== "html->text" && /text\/html/.test(ct)) continue; // SPA fallback page pretending to be llms.txt
		if (/text\/html/.test(ct)) text = htmlToText(text);
		if (text.trim().length < 500) continue;
		if (text.length > MAX_BYTES) text = text.slice(0, MAX_BYTES) + "\n\n[truncated by bigrefactor]\n";
		const file = join(s.tech, `${slug}.md`);
		writeFileSync(join(dir, file), `# ${s.name}\n\nsource: ${c.url}\n\n${text}`);
		return { tech: s.tech, name: s.name, url: c.url, file, bytes: text.length, kind: c.kind, fetchedAt: new Date().toISOString() };
	}
	throw new Error("no fetchable representation");
}

function htmlToText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<footer[\s\S]*?<\/footer>/gi, "")
		.replace(/<pre[\s\S]*?>([\s\S]*?)<\/pre>/gi, (_, c) => "\n```\n" + c.replace(/<[^>]+>/g, "") + "\n```\n")
		.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l, c) => `\n${"#".repeat(Number(l))} ${c.replace(/<[^>]+>/g, "")}\n`)
		.replace(/<(li)[^>]*>/gi, "\n- ")
		.replace(/<\/(p|div|tr|br|h\d)>|<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Grep-style lookup over fetched docs; what the `docs_lookup` agent tool calls. */
export function searchDocs(root: string, query: string, opts: { tech?: string; limit?: number } = {}): Array<{ tech: string; name: string; line: number; snippet: string }> {
	const dir = statePath(root, "docs");
	const indexPath = join(dir, "index.json");
	if (!existsSync(indexPath)) return [];
	const entries = (JSON.parse(readFileSync(indexPath, "utf8")) as DocEntry[]).filter((e) => !opts.tech || e.tech === opts.tech);
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	const hits: Array<{ tech: string; name: string; line: number; snippet: string; score: number }> = [];
	for (const e of entries) {
		const lines = readFileSync(join(dir, e.file), "utf8").split("\n");
		for (let i = 0; i < lines.length; i++) {
			const l = lines[i]!.toLowerCase();
			const score = terms.reduce((a, t) => a + (l.includes(t) ? 1 : 0), 0);
			if (score === terms.length) hits.push({ tech: e.tech, name: e.name, line: i + 1, snippet: lines.slice(Math.max(0, i - 2), i + 6).join("\n"), score });
		}
	}
	return hits.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 8);
}
