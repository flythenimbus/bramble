/**
 * @vitest-environment jsdom
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// The picker document sits in the page's DOM, so `window.parent` is the page and anything
// arriving on it may be the page's own script (GHSA-mvjj-4qqq-xr7h). Only the port the content
// script hands over may drive it. See docs/autofill.md.

const PAGE_ORIGIN = "https://example.com";
const MATCH = { id: "entry-1", name: "Example", secondary: "user@example.com" };

Element.prototype.scrollIntoView = () => {};

// jsdom has no IntersectionObserver. This one stands in for Chromium's v2, and the tests say
// what the browser would report.
let observerInit: Record<string, unknown> = {};
let reportVisible: (isVisible: boolean) => void = () => {
	throw new Error("the picker never observed its visibility");
};
class FakeIntersectionObserver {
	constructor(cb: (entries: { isVisible: boolean }[]) => void, init: Record<string, unknown>) {
		observerInit = init;
		reportVisible = (isVisible) => cb([{ isVisible }]);
	}
	observe(): void {}
	disconnect(): void {}
}
Object.defineProperty(FakeIntersectionObserver.prototype, "trackVisibility", { value: false });
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersectionObserver;

// Catch the document mousedown listener as it is added: jsdom will not mark an event trusted,
// so the click tests hand it a stand-in that is.
let mousedown: ((e: Event) => void) | null = null;
const addEventListener = document.addEventListener.bind(document);
document.addEventListener = ((type: string, fn: EventListener, opts?: AddEventListenerOptions) => {
	if (type === "mousedown") mousedown = fn;
	addEventListener(type, fn, opts);
}) as typeof document.addEventListener;
history.replaceState(null, "", `/autofill-ui.html?parentOrigin=${encodeURIComponent(PAGE_ORIGIN)}`);
// jsdom's top window is its own parent, so this sees everything posted to the page.
const toPage: unknown[] = [];
vi.spyOn(window, "postMessage").mockImplementation(((m: unknown) => {
	toPage.push(m);
}) as typeof window.postMessage);
await import("./autofill-ui");
document.addEventListener = addEventListener;

function fromPage(data: unknown, ports: MessagePort[] = []): void {
	const e = new MessageEvent("message", { data, origin: PAGE_ORIGIN, source: window });
	Object.defineProperty(e, "ports", { value: ports });
	window.dispatchEvent(e);
}

// The port the iframe adopted, kept for the cases after the hand-over.
let adopted: { port: MessagePort; received: unknown[] } | null = null;
afterAll(() => adopted?.port.close());

function connect(): { port: MessagePort; received: unknown[] } {
	const { port1, port2 } = new MessageChannel();
	const received: unknown[] = [];
	port1.onmessage = (e) => received.push(e.data);
	fromPage({ type: "UI_CONNECT" }, [port2]);
	return { port: port1, received };
}

describe("autofill-ui: who may drive the picker", () => {
	it("ignores rows and keys posted on the page window", async () => {
		fromPage({ type: "RENDER_MATCHES", matches: [MATCH] });
		fromPage({ type: "UI_KEY", key: "ArrowDown" });
		fromPage({ type: "UI_KEY", key: "Enter" });
		await new Promise((r) => setTimeout(r, 0));

		expect(toPage).not.toContainEqual(expect.objectContaining({ type: "UI_PICK" }));
		expect(document.querySelector("[data-entry-id]")).toBeNull();
	});

	it("takes rows and keys over the port it is handed, and answers there", async () => {
		const { port, received } = connect();
		port.postMessage({ type: "RENDER_MATCHES", matches: [MATCH] });
		port.postMessage({ type: "UI_KEY", key: "ArrowDown" });
		port.postMessage({ type: "UI_KEY", key: "Enter" });

		await vi.waitFor(() =>
			expect(received).toContainEqual({ type: "UI_PICK", entryId: MATCH.id, otpOnly: false }),
		);
		expect(received[0]).toEqual({ type: "UI_CONNECTED" });
		expect(toPage).not.toContainEqual(expect.objectContaining({ type: "UI_PICK" }));
		adopted = { port, received };
	});

	it("does not let a second port take the channel over", async () => {
		const { port, received } = connect();
		port.postMessage({ type: "RENDER_MATCHES", matches: [MATCH] });
		port.postMessage({ type: "UI_KEY", key: "ArrowDown" });
		port.postMessage({ type: "UI_KEY", key: "Enter" });
		await new Promise((r) => setTimeout(r, 20));

		expect(received).toEqual([]);
		port.close();
	});
});

// Chromium can vouch that the picker is unobscured and unfiltered on screen (IntersectionObserver
// v2), which catches a pointer-events: none decoy painted over it that no hit test sees. Clicks
// wait for that; keyboard picks are deliberate and do not.
describe("autofill-ui: clicks need the browser to vouch the picker is visible", () => {
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

	let since = 0;
	beforeEach(async () => {
		if (!adopted) throw new Error("the hand-over case did not leave a port");
		// Cleared first, so the wait below is for THIS render and not the last case's rows.
		document.body.innerHTML = "";
		adopted.port.postMessage({ type: "RENDER_MATCHES", matches: [MATCH] });
		await vi.waitFor(() => expect(document.querySelector("[data-entry-id]")).not.toBeNull());
		since = adopted.received.length;
	});
	const sent = () => adopted!.received.slice(since);

	it("asks the browser to track visibility", () => {
		expect(observerInit).toMatchObject({ trackVisibility: true });
		expect(observerInit.delay).toBeGreaterThanOrEqual(100);
	});

	it("refuses a click while the browser reports it obscured, and points to the keyboard", async () => {
		reportVisible(false);

		clickRow();
		await new Promise((r) => setTimeout(r, 20));

		expect(sent()).not.toContainEqual(expect.objectContaining({ type: "UI_PICK" }));
		expect(document.querySelector(".tp-hint")?.textContent).toBe("pickerUseKeyboard");
	});

	it("takes a click once the browser reports it visible, marked as a click", async () => {
		reportVisible(true);

		clickRow();

		await vi.waitFor(() =>
			expect(sent()).toContainEqual({
				type: "UI_PICK",
				entryId: MATCH.id,
				otpOnly: false,
				pointer: true,
			}),
		);
	});

	it("does not hold keyboard picks to it", async () => {
		reportVisible(false);

		adopted!.port.postMessage({ type: "UI_KEY", key: "ArrowDown" });
		adopted!.port.postMessage({ type: "UI_KEY", key: "Enter" });

		await vi.waitFor(() =>
			expect(sent()).toContainEqual({ type: "UI_PICK", entryId: MATCH.id, otpOnly: false }),
		);
	});
});
