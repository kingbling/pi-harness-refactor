/**
 * Two standing policies of the orchestrator, quoted verbatim in every prompt they apply to, so every model
 * works from the same text:
 *  - CODE_QUALITY: each unit leaves the code better than the legacy (naming, security, errors), never bigger
 *    than it needs to be.
 *  - PLAIN_LANGUAGE: everything the owner reads (questions, diagnoses, summaries) is short, plain tech language.
 */

export const CODE_QUALITY = `Code quality (every unit leaves the code better than the legacy, never bigger than it needs to be):
- Naming: clear, consistent names from the business domain and the stack's conventions; no legacy abbreviations, Hungarian prefixes or names of the old language's file kinds.
- Security: parameterized queries only (never string-built SQL); validate input at the boundary (request DTOs/schemas); escape output; keep every auth/permission check the legacy code had, at the same place in the flow; no secrets or credentials in code or logs; safe defaults (no eval, no shell strings from input, current hashing/crypto APIs).
- Errors: fail loudly with typed errors where the legacy code swallowed them, unless a caller observably depends on the silence (then record it as a quirk).
- Do NOT over-engineer: no new layers, patterns, interfaces, factories, config options or generic helpers the unit does not need today; no speculative "for later" code. The simplest clear code that satisfies the truth cases wins. Three plain lines beat one clever abstraction.
- A security or quality fix that changes what a caller observes is a quirk (recorded, the owner decides), never a silent change.`;

export const PLAIN_LANGUAGE = `Language for the owner: short sentences in plain, everyday tech language a developer who knows this app understands at once. Name the concrete file, feature, table or command. Never use this tool's internal words (unit, gate, slice, lane, truth case, Jev, ledger, tier) — say what they mean instead ("the invoice code", "the build check", "the tests from the old behaviour"). Explain any unavoidable technical term in a few words. No filler, no marketing tone.`;

/** What the owner can want from the migration; asked first in onboarding as checkboxes plus their own words. */
export const GOALS: Array<{ value: string; label: string; hint: string }> = [
	{ value: "new-stack", label: "move to the new stack", hint: "same features on the new framework and language" },
	{ value: "same-behaviour", label: "keep behaviour exactly as it is", hint: "users notice no difference; odd old behaviour is listed and you decide" },
	{ value: "clean-code", label: "cleaner code", hint: "clear names, simple structure, no copy-paste" },
	{ value: "security", label: "fix security problems", hint: "SQL injection, missing input checks, old password hashing" },
	{ value: "drop-unused", label: "drop features nobody uses", hint: "dead code and unused pages are not carried over" },
	{ value: "performance", label: "make it faster", hint: "slow queries and pages" },
	{ value: "new-db", label: "better database design", hint: "a new schema instead of copying the old tables" },
	{ value: "new-ui", label: "new look for the UI", hint: "modern screens instead of the same ones" },
];

export const DEFAULT_GOALS = ["new-stack", "same-behaviour", "clean-code", "security", "drop-unused"];

/** The owner's goals as one prompt section; empty when nothing was asked yet. */
export function goalsText(goals: { picked: string[]; note?: string } | undefined): string {
	if (!goals || (!goals.picked.length && !goals.note)) return "";
	const lines = goals.picked.map((v) => {
		const g = GOALS.find((x) => x.value === v);
		return `- ${g ? `${g.label} (${g.hint})` : v}`;
	});
	return `The owner's goals for this migration (weigh every choice against them; where a goal would change what callers observe, record it as a quirk instead of changing it silently):\n${lines.join("\n")}${goals.note ? `\nIn the owner's own words: "${goals.note}"` : ""}`;
}
