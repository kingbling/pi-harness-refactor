import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { TargetAdapter } from "../src/adapters/types.ts";
import { indexTarget } from "../src/inventory/target.ts";
import { Ledger } from "../src/ledger/db.ts";

describe("the target index", () => {
	it("holds no write lock while it waits for the parser: another connection writes at once", async () => {
		const dir = mkdtempSync(join(tmpdir(), "br-index-lock-"));
		const project = join(dir, "app");
		mkdirSync(join(project, "src"), { recursive: true });
		for (const f of ["a", "b"]) writeFileSync(join(project, "src", `${f}.ts`), `export class ${f.toUpperCase()} {}\n`);
		const path = join(dir, "ledger.sqlite");
		const ledger = new Ledger(path);
		// another handle (Pi, `br answer`, the run's decision dialog): a write must never wait on the index
		const other = new DatabaseSync(path, { timeout: 0 });
		const writes: string[] = [];
		const adapter = {
			id: "ts",
			layout: { sourceExtensions: [".ts"], ignoreDirs: [], isTestFile: () => false },
			indexFile: async (_d: string, rel: string) => {
				await new Promise((r) => setTimeout(r, 20)); // the parser runs off the thread
				try {
					other.exec(`INSERT INTO meta(key, value) VALUES ('w-${rel}', 'x')`);
					writes.push(rel);
				} catch (e) {
					writes.push(`refused: ${(e as Error).message}`);
				}
				return [{ id: `${rel}::X`, path: rel, kind: "class", name: "X", line: 1, tags: ["class"] }];
			},
		} as unknown as TargetAdapter;
		expect(await indexTarget(ledger, adapter, project, ["src/a.ts", "src/b.ts"])).toBe(2);
		expect(writes).toEqual(["src/a.ts", "src/b.ts"]);
		expect((ledger.db.prepare("SELECT COUNT(*) n FROM index_symbols WHERE side = 'target'").get() as { n: number }).n).toBe(2);
		other.close();
		ledger.close();
	});
});
