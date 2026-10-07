import { Input, Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import pc from "picocolors";

/**
 * One question as a card (Pi): the question, why it is asked, every option with its description, the
 * recommended one marked and preselected. ↑/↓ or a number picks, Enter confirms, Esc cancels. A text
 * question shows an input prefilled with the recommended value. A checkbox question (`multi`) toggles
 * options with Space or a number and sends them with Enter. `other` adds a last row to type your own
 * words: with checkboxes they go along as a note, otherwise they are the answer. Replaces Pi's plain
 * select/input, which show no option descriptions, no context and no default value.
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
	/** Checkboxes: several options can be picked; these start checked. */
	multi?: { initial: string[] };
	/** A last row to type your own answer; this is its hint while empty. */
	other?: string;
}

/** Single choice and text: the value (or the typed text); checkboxes: the checked values and the typed note. */
export type CardAnswer = string | { values: string[]; note: string };

export class QuestionCard implements Component {
	/** What is asked (read by tests and callers that drive the card without a terminal). */
	readonly q: CardQuestion;
	private readonly done: (value: CardAnswer | undefined) => void;
	private readonly input: Input;
	private readonly checked: Set<string>;
	private cursor: number;
	focused = false;

	constructor(q: CardQuestion, done: (value: CardAnswer | undefined) => void) {
		this.q = q;
		this.done = done;
		this.input = new Input(q.text ? {} : { prompt: "", placeholder: q.other ?? "" });
		this.checked = new Set(q.multi?.initial ?? []);
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

	private get rows(): number {
		return (this.q.options?.length ?? 0) + (this.q.other !== undefined ? 1 : 0);
	}

	private get onOther(): boolean {
		return this.q.other !== undefined && this.cursor === (this.q.options?.length ?? 0);
	}

	private submit(): void {
		const note = this.input.getValue().trim();
		if (this.q.multi) return this.done({ values: (this.q.options ?? []).map((o) => o.value).filter((v) => this.checked.has(v)), note });
		if (this.onOther) {
			if (note) this.done(note); // nothing typed yet: Enter does nothing
			return;
		}
		this.done(this.q.options![this.cursor]!.value);
	}

	private toggle(i: number): void {
		const v = this.q.options?.[i]?.value;
		if (v === undefined) return;
		if (this.checked.has(v)) this.checked.delete(v);
		else this.checked.add(v);
	}

	handleInput(data: string): void {
		if (this.q.text) return this.input.handleInput(data);
		const n = this.rows;
		if (!n) return;
		if (matchesKey(data, Key.up)) this.cursor = (this.cursor + n - 1) % n;
		else if (matchesKey(data, Key.down)) this.cursor = (this.cursor + 1) % n;
		else if (matchesKey(data, Key.escape)) this.done(undefined);
		else if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) this.submit();
		else if (this.onOther) this.input.handleInput(data); // typing your own words: digits and spaces are text here
		else if (this.q.multi && data === " ") this.toggle(this.cursor);
		else if (/^[1-9]$/.test(data) && Number(data) <= (this.q.options?.length ?? 0)) {
			if (this.q.multi) this.toggle(Number(data) - 1);
			else this.done(this.q.options![Number(data) - 1]!.value);
		}
		this.input.focused = this.onOther;
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
				const box = this.q.multi ? (this.checked.has(o.value) ? pc.green("[✔] ") : "[ ] ") : "";
				L.push(truncateToWidth(`${active ? pc.cyan("❯") : " "} ${i < 9 ? `${i + 1}.` : "  "} ${box}${active ? pc.cyan(pc.bold(o.label)) : o.label}${rec}`, w));
				if (o.description) L.push(...wrap(pc.dim(o.description), this.q.multi ? "          " : "      "));
			});
			if (this.q.other !== undefined) {
				const active = this.onOther;
				const typed = this.input.getValue();
				const field = active ? this.input.render(Math.max(10, w - 6))[0]! : typed ? typed : pc.dim(this.q.other);
				L.push(truncateToWidth(`${active ? pc.cyan("❯") : " "} ${pc.yellow("✎")}  ${field}`, w));
			}
			const keys = this.q.multi
				? `  ↑↓ move · Space or 1-${Math.min(9, opts.length)} check/uncheck · ${this.q.other !== undefined ? "last row: type your own · " : ""}Enter send · Esc cancel`
				: `  ↑↓ move · ${opts.length > 1 ? `1-${Math.min(9, opts.length)} pick · ` : ""}${this.q.other !== undefined ? "last row: type your own · " : ""}Enter choose · Esc cancel`;
			L.push("", pc.dim(keys));
		}
		L.push(pc.dim("─".repeat(w)));
		return L;
	}
}
