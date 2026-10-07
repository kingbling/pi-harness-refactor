import { Input, Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import pc from "picocolors";

/**
 * One question as a card (Pi): the question, why it is asked, every option with its description, the
 * recommended one marked and preselected. ↑/↓ or a number picks, Enter confirms, Esc cancels. A text
 * question shows an input prefilled with the recommended value. Replaces Pi's plain select/input, which
 * show no option descriptions, no context and no default value.
 */
export interface CardOption {
	value: string;
	label: string;
	description?: string;
}

export interface CardQuestion {
	/** First line: the question; following lines: context (evidence, why the recommendation). */
	message: string;
	options?: CardOption[];
	recommended?: string;
	/** Text question: an input prefilled with this value instead of options. */
	text?: { initial: string };
}

export class QuestionCard implements Component {
	/** What is asked (read by tests and callers that drive the card without a terminal). */
	readonly q: CardQuestion;
	private readonly done: (value: string | undefined) => void;
	private readonly input = new Input();
	private cursor: number;
	focused = false;

	constructor(q: CardQuestion, done: (value: string | undefined) => void) {
		this.q = q;
		this.done = done;
		const rec = (q.options ?? []).findIndex((o) => o.value === q.recommended);
		this.cursor = Math.max(0, rec);
		if (q.text) {
			this.input.setValue(q.text.initial);
			this.input.handleInput("\x1b[F"); // cursor to the end: typing extends the default instead of prefixing it
			this.input.focused = true;
			this.input.onSubmit = (v) => done(v.trim() || q.text!.initial);
			this.input.onEscape = () => done(undefined);
		}
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.q.text) return this.input.handleInput(data);
		const n = this.q.options?.length ?? 0;
		if (!n) return;
		if (matchesKey(data, Key.up)) this.cursor = (this.cursor + n - 1) % n;
		else if (matchesKey(data, Key.down)) this.cursor = (this.cursor + 1) % n;
		else if (matchesKey(data, Key.escape)) this.done(undefined);
		else if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) this.done(this.q.options![this.cursor]!.value);
		else if (/^[1-9]$/.test(data) && Number(data) <= n) this.done(this.q.options![Number(data) - 1]!.value);
	}

	render(width: number): string[] {
		const w = Math.max(30, width - 2);
		const wrap = (s: string, indent = "") => wrapTextWithAnsi(s, Math.max(10, w - indent.length)).map((l) => indent + l);
		const [question = "", ...context] = this.q.message.split("\n").map((l) => l.trim());
		const L: string[] = [pc.dim("─".repeat(w)), ...wrap(pc.bold(question))];
		for (const c of context.filter(Boolean)) L.push(...wrap(pc.dim(c), "  "));
		L.push("");
		if (this.q.text) {
			L.push(...this.input.render(w));
			L.push(pc.dim(this.q.text.initial ? `  recommended: ${this.q.text.initial} (prefilled) · Enter sends · Esc cancels` : "  Enter sends · Esc cancels"));
		} else {
			const opts = this.q.options ?? [];
			opts.forEach((o, i) => {
				const active = i === this.cursor;
				const rec = o.value === this.q.recommended ? pc.green(" (recommended)") : "";
				L.push(truncateToWidth(`${active ? pc.cyan("❯") : " "} ${i < 9 ? `${i + 1}.` : "  "} ${active ? pc.cyan(pc.bold(o.label)) : o.label}${rec}`, w));
				if (o.description) L.push(...wrap(pc.dim(o.description), "      "));
			});
			L.push("", pc.dim(`  ↑↓ move · ${opts.length > 1 ? `1-${Math.min(9, opts.length)} pick · ` : ""}Enter choose · Esc cancel`));
		}
		L.push(pc.dim("─".repeat(w)));
		return L;
	}
}
