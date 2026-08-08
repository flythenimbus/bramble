/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import pciFrameHtml from "../fixtures/sites/shopify-card-number-frame.html?raw";
// Shopify checkout, payment step: the merchant frame holds only containers, every
// card input lives in a 47px cross-origin iframe. See docs/autofill.md.
import merchantFrameHtml from "../fixtures/sites/shopify-checkout-card.html?raw";
import { cardFieldsPresent, detectCardFields, isCardField } from "./detection";
import {
	type FrameRelay,
	installFrameRelay,
	MIN_PICKER_SPACE,
	type RelayRect,
} from "./frame-relay";

// Live checkout geometry: the card-number iframe, and the input inside it.
const FRAME_TOP = 320;
const FRAME_LEFT = 24;
const FRAME_HEIGHT = 47;
const FRAME_WIDTH = 432;
const INPUT_RECT: RelayRect = { x: 0, y: 8, width: 432, height: 32 };

// jsdom leaves MessageEvent.source null (jsdom#2745) and its Window proxies don't
// compare equal across realms, which is exactly what a hop authenticates on. So the
// receive path is driven with events carrying a real contentWindow, and the send
// path is asserted on the payload that lands. Only jsdom's delivery is bypassed.
function deliver(target: Window, data: unknown, source: Window | null): void {
	target.dispatchEvent(new MessageEvent("message", { data, source }));
}

/** Records the raw relay payloads a frame emits upward. */
function captureUpward(win: Window): unknown[] {
	const seen: unknown[] = [];
	win.addEventListener("message", (e) => seen.push(e.data));
	return seen;
}

/** Give an element a fixed layout box; jsdom has no layout engine. */
function stubRect(
	el: Element,
	rect: { x: number; y: number; width: number; height: number },
): void {
	el.getBoundingClientRect = () =>
		({
			x: rect.x,
			y: rect.y,
			left: rect.x,
			top: rect.y,
			width: rect.width,
			height: rect.height,
			right: rect.x + rect.width,
			bottom: rect.y + rect.height,
			toJSON: () => ({}),
		}) as DOMRect;
}

/** The frame's inner height is what clips a picker mounted inside it. */
function setViewportHeight(win: Window, height: number): void {
	Object.defineProperty(win, "innerHeight", { value: height, configurable: true });
}

/** postMessage is queued as a task, so let one drain before asserting on it. */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Write into the about:blank doc jsdom gives the frame, so it keeps its cross-origin src. */
function mountFrame(frameEl: HTMLIFrameElement, html: string): { win: Window; doc: Document } {
	const doc = frameEl.contentDocument;
	if (!doc) throw new Error("iframe has no contentDocument");
	doc.open();
	doc.write(html);
	doc.close();
	const win = frameEl.contentWindow;
	if (!win) throw new Error("iframe has no contentWindow");
	return { win, doc };
}

describe("shopify checkout - card fields in a cross-origin iframe", () => {
	let merchantRelay: FrameRelay;
	let pciRelay: FrameRelay;
	let frameEl: HTMLIFrameElement;
	let pci: { win: Window; doc: Document };

	beforeEach(() => {
		document.body.innerHTML = merchantFrameHtml;
		frameEl = document.querySelector<HTMLIFrameElement>("#number iframe")!;
		// jsdom ignores the fixture's frameborder="0", which browsers map to border: 0.
		frameEl.style.border = "0";
		stubRect(frameEl, { x: FRAME_LEFT, y: FRAME_TOP, width: FRAME_WIDTH, height: FRAME_HEIGHT });
		pci = mountFrame(frameEl, pciFrameHtml);
		setViewportHeight(pci.win, FRAME_HEIGHT);

		merchantRelay = installFrameRelay({ window, document });
		pciRelay = installFrameRelay({ window: pci.win, document: pci.doc });
	});

	it("finds no card fields in the merchant frame - it holds containers, not inputs", () => {
		expect(document.querySelector("#number")).not.toBeNull();
		expect(document.querySelector("#number input")).toBeNull();
		expect(cardFieldsPresent(detectCardFields(document))).toBe(false);
	});

	it("finds the real card field inside the payment frame", () => {
		const card = detectCardFields(pci.doc);
		expect(cardFieldsPresent(card)).toBe(true);
		expect(card.number?.id).toBe("number");
		expect(card.number?.hasAttribute("data-honeypot-field")).toBe(false);
		// The decoys carry real cc-* tokens, so one fill here populates the whole form.
		expect(card.name?.hasAttribute("data-honeypot-field")).toBe(true);
		expect(card.cvv?.hasAttribute("data-honeypot-field")).toBe(true);
		expect(isCardField(card, card.number!)).toBe(true);
	});

	it("cannot host the picker inside the payment frame", () => {
		// The bug: mounted at rect.bottom + 2, the picker lands past a 47px frame's
		// bottom, and an iframe cannot paint outside its own box.
		const pickerTop = INPUT_RECT.y + INPUT_RECT.height + 2;
		expect(pickerTop).toBeGreaterThan(pci.win.innerHeight - MIN_PICKER_SPACE);
		expect(pciRelay.isTop()).toBe(false);
		expect(pciRelay.needsRelay(INPUT_RECT)).toBe(true);
	});

	it("emits an anchor carrying only geometry and an opaque id", async () => {
		const upward = captureUpward(window);

		pciRelay.open("relay-1", INPUT_RECT);
		await flush();

		expect(upward).toEqual([{ __tp: "tp-relay-anchor", relayId: "relay-1", rect: INPUT_RECT }]);
		// The page can read this channel, so nothing else may ride it.
		const payload = JSON.stringify(upward[0]);
		expect(payload).not.toMatch(/entry|match|secret|cvv|number"\s*:\s*"\d/i);
	});

	it("translates a relayed anchor into merchant-frame coordinates", () => {
		const seen = vi.fn();
		merchantRelay.onAnchor(seen);

		deliver(
			window,
			{ __tp: "tp-relay-anchor", relayId: "relay-1", rect: INPUT_RECT },
			frameEl.contentWindow,
		);

		expect(seen).toHaveBeenCalledTimes(1);
		expect(seen.mock.calls[0]![0]).toEqual({
			relayId: "relay-1",
			rect: {
				x: FRAME_LEFT + INPUT_RECT.x,
				y: FRAME_TOP + INPUT_RECT.y,
				width: INPUT_RECT.width,
				height: INPUT_RECT.height,
			},
		});
	});

	it("relays a withdrawal so the host frame drops the picker", () => {
		const closed = vi.fn();
		merchantRelay.onClose(closed);

		deliver(window, { __tp: "tp-relay-close", relayId: "relay-1" }, frameEl.contentWindow);

		expect(closed).toHaveBeenCalledWith("relay-1");
	});

	it("does not treat the merchant frame itself as needing a relay", () => {
		expect(merchantRelay.isTop()).toBe(true);
		expect(merchantRelay.needsRelay(INPUT_RECT)).toBe(false);
	});

	it("ignores a relay message that did not come from a child frame", () => {
		// The page can post whatever it likes; only a real child window is honoured.
		const seen = vi.fn();
		merchantRelay.onAnchor(seen);

		deliver(window, { __tp: "tp-relay-anchor", relayId: "forged", rect: INPUT_RECT }, window);
		deliver(window, { __tp: "tp-relay-anchor", relayId: "forged", rect: INPUT_RECT }, null);

		expect(seen).not.toHaveBeenCalled();
	});

	it("ignores a relay message carrying a malformed rect", () => {
		const seen = vi.fn();
		merchantRelay.onAnchor(seen);

		for (const rect of [
			{ x: Number.NaN, y: 0, width: 1, height: 1 },
			{ x: 0, y: 0, width: -5, height: 1 },
			{ x: 1e9, y: 0, width: 1, height: 1 },
			{ x: 0, y: 0 },
			"nope",
		]) {
			deliver(window, { __tp: "tp-relay-anchor", relayId: "bad", rect }, frameEl.contentWindow);
		}

		expect(seen).not.toHaveBeenCalled();
	});
});

describe("relay accumulates offsets across nested frames", () => {
	it("adds every hop's frame offset on the way up", async () => {
		document.body.innerHTML = "<div id='host'></div>";

		const midEl = document.createElement("iframe");
		document.getElementById("host")!.appendChild(midEl);
		stubRect(midEl, { x: 10, y: 100, width: 600, height: 400 });
		const mid = mountFrame(midEl, "<body><div id='inner'></div></body>");

		const leafEl = mid.doc.createElement("iframe");
		mid.doc.getElementById("inner")!.appendChild(leafEl);
		stubRect(leafEl, { x: 5, y: 50, width: 400, height: 47 });
		const leaf = mountFrame(leafEl, "<body></body>");
		setViewportHeight(leaf.win, 47);

		const topRelay = installFrameRelay({ window, document });
		installFrameRelay({ window: mid.win, document: mid.doc });
		installFrameRelay({ window: leaf.win, document: leaf.doc });

		const seen = vi.fn();
		topRelay.onAnchor(seen);
		const atTop = captureUpward(window);

		// These frames keep the 2px default iframe border, so each hop adds that inset too.
		const BORDER = 2;

		// Hop 1: the middle frame adds its own offset and forwards upward.
		deliver(
			mid.win,
			{ __tp: "tp-relay-anchor", relayId: "nested", rect: { x: 2, y: 8, width: 300, height: 32 } },
			leafEl.contentWindow,
		);
		await flush();
		expect(atTop).toEqual([
			{
				__tp: "tp-relay-anchor",
				relayId: "nested",
				// 5 + 2 + border across, 50 + 8 + border down.
				rect: { x: 7 + BORDER, y: 58 + BORDER, width: 300, height: 32 },
			},
		]);

		// Hop 2: the top frame adds the middle frame's offset and hosts the picker.
		deliver(window, atTop[0], midEl.contentWindow);

		// 10 + 5 + 2 across, 100 + 50 + 8 down, plus a border per hop.
		expect(seen).toHaveBeenCalledTimes(1);
		expect(seen.mock.calls[0]![0].rect).toEqual({
			x: 17 + BORDER * 2,
			y: 158 + BORDER * 2,
			width: 300,
			height: 32,
		});
	});
});
