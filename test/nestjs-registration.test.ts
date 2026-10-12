import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nestjsAdapter } from "../src/adapters/target/nestjs.ts";

/** app.module.ts is rewritten after every accept: the project's own imports (forRoot, nested arrays) must survive. */
function project(appModule: string) {
	const root = mkdtempSync(join(tmpdir(), "br-nest-"));
	mkdirSync(join(root, "src", "users"), { recursive: true });
	writeFileSync(join(root, "src", "users", "users.module.ts"), "@Module({})\nexport class UsersModule {}\n");
	writeFileSync(join(root, "src", "app.module.ts"), appModule);
	return root;
}
const read = (root: string) => readFileSync(join(root, "src", "app.module.ts"), "utf8");

describe("nestjs app.module generation", () => {
	it("keeps the project's own imports and nested arrays, and is stable on a second pass", async () => {
		const root = project(`import { Module } from '@nestjs/common';\nimport { ConfigModule } from '@nestjs/config';\n\n@Module({\n  imports: [ConfigModule.forRoot({ load: [cfg] }), TypeOrmModule.forRoot({ entities: [User] })],\n})\nexport class AppModule {}\n`);
		expect(await nestjsAdapter.generateRegistration!(root, {} as never)).toEqual(["src/app.module.ts"]);
		const out = read(root);
		expect(out).toContain("imports: [...BR_MODULES, ConfigModule.forRoot({ load: [cfg] }), TypeOrmModule.forRoot({ entities: [User] })]");
		expect(out).toContain("const BR_MODULES = [UsersModule] as const;");
		expect(await nestjsAdapter.generateRegistration!(root, {} as never)).toEqual([]);
	});
	it("moves classes an older version wrote straight into the list into BR_MODULES", async () => {
		const root = project(`import { Module } from '@nestjs/common';\n// <bigrefactor:modules>\nimport { UsersModule } from './users/users.module';\nimport { GoneModule } from './gone/gone.module';\n// </bigrefactor:modules>\n\n@Module({\n  imports: [UsersModule, GoneModule, ConfigModule.forRoot()],\n})\nexport class AppModule {}\n`);
		await nestjsAdapter.generateRegistration!(root, {} as never);
		const out = read(root);
		expect(out).toContain("imports: [...BR_MODULES, ConfigModule.forRoot()]");
		expect(out).not.toContain("GoneModule");
	});
});
