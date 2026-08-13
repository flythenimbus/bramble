/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadFixture } from "../fixtures/load";
import { invalidatePageFields } from "./field-model";
import { fillOtp } from "./fill";

// Segmented one-time-code widgets are all the same shape and none of them fill
// the same way: one distributes a code dropped whole into its first box, one
// takes a character at a time, one ignores its boxes entirely and reads a
// hidden mirror input. The doubles below stand in for each, and they are
// *controlled* like the real ones: every re-render overwrites the DOM with the
// widget's own state, so a write it didn't understand leaves the boxes empty
// exactly as it does on the page.

type Accepts = "char" | "whole" | "paste" | "mirror";

class Widget {
	readonly boxes: HTMLInputElement[];
	readonly mirror: HTMLInputElement | null;
	state: string[];

	constructor(
		private readonly accepts: Accepts,
		opts: { boxes?: number; mirror?: boolean; boxAttrs?: string } = {},
	) {
		const count = opts.boxes ?? 6;
		this.state = Array.from({ length: count }, () => "");
		const attrs = opts.boxAttrs ?? 'maxlength="1"';
		document.body.innerHTML = `
			<div role="group">
				${Array.from(
					{ length: count },
					(_, i) =>
						`<input id="b${i}" type="text" inputmode="numeric" autocomplete="one-time-code" ${attrs} value="">`,
				).join("")}
			</div>
			${opts.mirror ? '<input id="mirror" type="text" autocomplete="one-time-code" maxlength="6" pattern="\\d{6}" aria-hidden="true" tabindex="-1" value="">' : ""}
		`;
		this.boxes = Array.from(document.querySelectorAll<HTMLInputElement>('[role="group"] input'));
		this.mirror = document.querySelector<HTMLInputElement>("#mirror");

		this.boxes.forEach((box, i) => {
			box.addEventListener("input", (e) => {
				const data = e instanceof InputEvent ? (e.data ?? "") : "";
				if (this.accepts === "char" && data.length === 1) this.state[i] = data;
				if (this.accepts === "whole" && data.length > 1) this.spread(data);
				this.render();
			});
			box.addEventListener("paste", (e) => {
				if (this.accepts !== "paste") return;
				this.spread((e as ClipboardEvent).clipboardData?.getData("text/plain") ?? "");
				this.render();
			});
		});
		this.mirror?.addEventListener("input", () => {
			// The mirror is this widget's source of truth, so it believes an empty
			// write too: that is the reset that used to blank a correct fill.
			if (this.accepts === "mirror") this.spread(this.mirror?.value ?? "");
			this.render();
		});
	}

	private spread(code: string): void {
		this.state = this.state.map((_, i) => code[i] ?? "");
	}

	/** What a re-render does: the widget's state wins over whatever is in the DOM. */
	private render(): void {
		this.boxes.forEach((box, i) => {
			box.value = this.state[i] ?? "";
		});
		if (this.mirror) this.mirror.value = this.state.join("");
	}

	get value(): string {
		return this.state.join("");
	}
}

beforeEach(() => {
	document.body.innerHTML = "";
	invalidatePageFields();
});

describe("fillOtp: segmented widgets", () => {
	it("types a character into each box", () => {
		const w = new Widget("char");
		expect(fillOtp("123456")).toBe(true);
		expect(w.value).toBe("123456");
		expect(w.boxes.map((b) => b.value)).toEqual(["1", "2", "3", "4", "5", "6"]);
	});

	it("hands the whole code to a widget that spreads it itself", () => {
		const w = new Widget("whole");
		expect(fillOtp("123456")).toBe(true);
		expect(w.value).toBe("123456");
	});

	it("leaves no digits behind when the first attempt is refused", () => {
		// The whole-code attempt goes into box 1 before we know it won't take.
		const w = new Widget("char");
		fillOtp("123456");
		expect(w.boxes[0]?.value).toBe("1");
	});

	it("fills a widget driven only by its hidden mirror", () => {
		const w = new Widget("mirror", { mirror: true });
		expect(fillOtp("123456")).toBe(true);
		expect(w.value).toBe("123456");
		expect(w.mirror?.value).toBe("123456");
	});

	it("never writes an empty value into the mirror", () => {
		// The bug: the mirror answers the same one-time-code query as the boxes, so
		// it was filled as if it were a seventh box and got code[6], the empty
		// string, which reset the widget we had just filled correctly.
		const w = new Widget("char", { mirror: true });
		expect(fillOtp("123456")).toBe(true);
		expect(w.boxes.map((b) => b.value)).toEqual(["1", "2", "3", "4", "5", "6"]);
		expect(w.mirror?.value).toBe("123456");
	});

	it("fills boxes that declare their width with a pattern instead of maxlength", () => {
		const w = new Widget("char", { boxAttrs: 'pattern="\\d{1}"' });
		expect(fillOtp("123456")).toBe(true);
		expect(w.value).toBe("123456");
	});

	it("fills a 4-box widget from a 6-digit code without spilling", () => {
		const w = new Widget("char", { boxes: 4 });
		expect(fillOtp("1234")).toBe(true);
		expect(w.boxes.map((b) => b.value)).toEqual(["1", "2", "3", "4"]);
	});
});

describe("fillOtp: paste-only widgets", () => {
	// jsdom has neither constructor, so a widget that distributes a code only
	// from onPaste can't be reached without standing them up first.
	const g = globalThis as unknown as { ClipboardEvent?: unknown; DataTransfer?: unknown };

	beforeEach(() => {
		class FakeDataTransfer {
			private readonly items = new Map<string, string>();
			setData(type: string, value: string): void {
				this.items.set(type, value);
			}
			getData(type: string): string {
				return this.items.get(type) ?? "";
			}
		}
		class FakeClipboardEvent extends Event {
			readonly clipboardData: FakeDataTransfer | null;
			constructor(type: string, init: EventInit & { clipboardData?: FakeDataTransfer }) {
				super(type, init);
				this.clipboardData = init.clipboardData ?? null;
			}
		}
		g.DataTransfer = FakeDataTransfer;
		g.ClipboardEvent = FakeClipboardEvent;
	});

	afterEach(() => {
		g.DataTransfer = undefined;
		g.ClipboardEvent = undefined;
	});

	it("pastes the whole code into the first box", () => {
		const w = new Widget("paste");
		expect(fillOtp("123456")).toBe(true);
		expect(w.value).toBe("123456");
	});
});

describe("fillOtp: single field", () => {
	it("writes the whole code into a lone field", () => {
		document.body.innerHTML = '<input id="a" autocomplete="one-time-code" type="text">';
		const el = document.querySelector<HTMLInputElement>("#a")!;
		expect(fillOtp("123456")).toBe(true);
		expect(el.value).toBe("123456");
	});

	it("reports nothing filled when the page has no code field", () => {
		document.body.innerHTML = '<input id="a" type="text" name="street">';
		expect(fillOtp("123456")).toBe(false);
	});

	it("does nothing without a code", () => {
		document.body.innerHTML = '<input id="a" autocomplete="one-time-code" type="text">';
		expect(fillOtp(undefined)).toBe(false);
	});
});

describe("fillOtp: cloudflare fixture", () => {
	it("puts one digit in each box and the whole code in the mirror", () => {
		loadFixture("cloudflare-2fa");
		expect(fillOtp("123456")).toBe(true);
		const boxes = Array.from(
			document.querySelectorAll<HTMLInputElement>('[role="group"] input'),
		).map((el) => el.value);
		expect(boxes).toEqual(["1", "2", "3", "4", "5", "6"]);
		const mirror = document.querySelector<HTMLInputElement>('input[aria-hidden="true"]');
		expect(mirror?.value).toBe("123456");
	});
});
