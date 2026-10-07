import { describe, expect, it } from "vitest";
import { checkRequirements, requirementsNotice } from "../src/requirements.ts";

/** At Pi startup bigrefactor says what is missing: other Pi packages it uses, logins, the tools its stacks run. */
describe("requirements", () => {
	it("a missing ask_user_question package is reported with its install command", async () => {
		const rs = await checkRequirements({ cwd: "/", tools: ["read", "bash"] });
		const ask = rs.find((r) => r.name === "ask_user_question tool")!;
		expect(ask.status).toBe("degraded");
		expect(requirementsNotice(rs)).toContain("pi install npm:@juicesharp/rpiv-ask-user-question");
	});

	it("says nothing when everything is there", () => {
		expect(requirementsNotice([{ name: "git", status: "ok", why: "" }])).toBeUndefined();
		expect(requirementsNotice([{ name: "php", status: "missing", why: "truth", fix: "install php" }])).toMatch(/missing php[\s\S]*install php/);
	});
});
