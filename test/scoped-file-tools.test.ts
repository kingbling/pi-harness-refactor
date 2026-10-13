import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scopedFileTools } from "../src/sessions/spawn.ts";
let cwd: string;
let tools: ReturnType<typeof scopedFileTools>;
const call = (name: string, params: unknown) => tools.find((t) => t.name === name)!.execute("test", params, undefined, undefined, {} as never);
beforeEach(() => {
 cwd = mkdtempSync(join(tmpdir(), "br-files-"));
 for (const dir of ["pages", "shared", "legacy", "outside"]) mkdirSync(join(cwd, dir));
 tools = scopedFileTools({ cwd, sourceRoot: join(cwd, "legacy"), writeGlobs: ["pages/**", "legacy/**"], protectedGlobs: ["**/*.test.tsx"], appendOnlyGlobs: ["shared/**"] });
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));
describe("scoped file tools", () => {
 it("removes only the obsolete shim", async () => {
  writeFileSync(join(cwd, "pages/NetworkDashboardPage.tsx"), "shim");
  writeFileSync(join(cwd, "pages/DashboardsNetworkPage.tsx"), "behaviour");
  await call("remove_file", { path: "pages/NetworkDashboardPage.tsx" });
  expect(existsSync(join(cwd, "pages/NetworkDashboardPage.tsx"))).toBe(false);
  expect(readFileSync(join(cwd, "pages/DashboardsNetworkPage.tsx"), "utf8")).toBe("behaviour");
 });
 it("renames without overwriting an existing replacement", async () => {
  writeFileSync(join(cwd, "pages/old.tsx"), "behaviour");
  await call("rename_file", { path: "pages/old.tsx", destination: "pages/new.tsx" });
  expect(existsSync(join(cwd, "pages/old.tsx"))).toBe(false);
  expect(readFileSync(join(cwd, "pages/new.tsx"), "utf8")).toBe("behaviour");
  writeFileSync(join(cwd, "pages/old.tsx"), "shim");
  await expect(call("rename_file", { path: "pages/old.tsx", destination: "pages/new.tsx" })).rejects.toThrow("already exists");
  expect(existsSync(join(cwd, "pages/old.tsx"))).toBe(true);
 });
 it("rejects protected tests, shared, legacy, directories and symlink escapes", async () => {
  for (const path of ["pages/page.test.tsx", "shared/helper.ts", "legacy/old.php", "outside/file.ts"]) {
   writeFileSync(join(cwd, path), "preserve");
   await expect(call("remove_file", { path })).rejects.toThrow();
   expect(existsSync(join(cwd, path))).toBe(true);
  }
  await expect(call("remove_file", { path: "pages" })).rejects.toThrow();
  symlinkSync(join(cwd, "outside"), join(cwd, "pages/link"));
  await expect(call("remove_file", { path: "pages/link/file.ts" })).rejects.toThrow();
  symlinkSync(join(cwd, "outside/file.ts"), join(cwd, "pages/link.ts"));
  await expect(call("remove_file", { path: "pages/link.ts" })).rejects.toThrow("regular files");
  writeFileSync(join(cwd, "pages/own.tsx"), "preserve");
  await expect(call("rename_file", { path: "pages/own.tsx", destination: "outside/new.tsx" })).rejects.toThrow();
  expect(existsSync(join(cwd, "pages/own.tsx"))).toBe(true);
 });
});
