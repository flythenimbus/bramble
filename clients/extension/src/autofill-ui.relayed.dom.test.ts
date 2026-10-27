/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Relayed mode: the top frame hosts our element, but the pick goes straight to the field's frame
// and never passes the content script's early-click guard. So this document keeps it: a click is
// honoured only once the picker has sat still, and the host frame reports every move it makes.
// See docs/autofill.md.

const FIELD_ORIGIN = "https://pci.example";
const MATCH = { id: "entry-1", name: "Personal Visa", secondary: "•••• 4242" };

Element.prototype.scrollIntoView = () => {};

let reportVisible: (isVisible: boolean) => void = () => {
	throw new Error("the picker never observed its visibility");
};
class FakeIntersectionObserver {
	constructor(cb: (entries: { isVisible: boolean }[]) => void) {
		reportVisible = (isVisible) => cb([{ isVisible }]);
	}
	observe(): void {}
	disconnect(): void {}
}
Object.defineProperty(FakeIntersectionObserver.prototype, "trackVisibility", { value: false });
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersectionObserver;

let clock = 10_000;
vi.spyOn(performance, "now").mockImplementation(() => clock);

let mousedown: ((e: Event) => void) | null = null;
const addEventListener = document.addEventListener.bind(document);
document.addEventListener = ((type: string, fn: EventListener, opts?: AddEventListenerOptions) => {
	if (type === "mousedown") mousedown = fn;
	addEventListener(type, fn, opts);
}) as typeof document.addEventListener;
history.replaceState(
	null,
	"",
	"/autofill-ui.html?relayId=relay-1&parentOrigin=https%3A%2F%2Fmerchant.example",
);
// jsdom's top window is its own parent and peer, so this sees everything we post.
const posted: unknown[] = [];
vi.spyOn(window, "postMessage").mockImplementation(((m: unknown) => {
	posted.push(m);
}) as typeof window.postMessage);
await import("./autofill-ui");
document.addEventListener = addEventListener;

/** A message from the field's frame (the peer) or, for UI_MOVED, the host frame. */
function deliver(data: unknown, origin = FIELD_ORIGIN): void {
	window.dispatchEvent(new MessageEvent("message", { data, origin, source: window }));
}

function clickRow(): void {
	const row = document.querySelector("[data-entry-id]");
	if (!row || !mousedown) throw new Error("no row rendered");
	const inner = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
	mousedown(
		new Proxy(inner, {
			get(event, property) {
				if (property === "isTrusted") return true;
				if (property === "target") return row;
				const value = Reflect.get(event, property, event);
				return typeof value === "function" ? value.bind(event) : value;
			},
		}),
	);
}

const picks = () => posted.filter((m) => (m as { type?: string }).type === "UI_PICK");

describe("autofill-ui relayed: a click waits for the picker to sit still", () => {
	beforeEach(async () => {
		posted.length = 0;
		document.body.innerHTML = "";
		clock = 10_000;
		deliver({ type: "RENDER_MATCHES", matches: [MATCH] });
		await vi.waitFor(() => expect(document.querySelector("[data-entry-id]")).not.toBeNull());
		reportVisible(true);
	});

	it("refuses a click just after the rows appear", () => {
		clock += 100;
		clickRow();

		expect(picks()).toEqual([]);
		// Early, not hidden: the keyboard hint is for an obscured picker.
		expect(document.querySelector(".tp-hint")).toBeNull();
	});

	it("takes a click once the rows have sat still", () => {
		clock += 600;
		clickRow();

		expect(picks()).toEqual([
			{ type: "UI_PICK", entryId: MATCH.id, otpOnly: false, pointer: true },
		]);
	});

	it("refuses a click just after the host frame moves it, then takes one", () => {
		clock += 600;
		deliver({ type: "UI_MOVED" }, "https://merchant.example");
		clock += 100;
		clickRow();
		expect(picks()).toEqual([]);

		clock += 500;
		clickRow();
		expect(picks()).toHaveLength(1);
	});

	it("does not hold keyboard picks to it", () => {
		deliver({ type: "UI_KEY", key: "ArrowDown" });
		deliver({ type: "UI_KEY", key: "Enter" });

		expect(picks()).toEqual([{ type: "UI_PICK", entryId: MATCH.id, otpOnly: false }]);
	});
});
