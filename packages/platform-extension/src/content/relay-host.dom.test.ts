/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Inlined, not a const: vi.mock is hoisted above module scope, and relay-host reads
// getURL at import time.
vi.mock("./content-api", () => ({
	api: {
		runtime: {
			id: "abcdefghijklmnopabcdefghijklmnop",
			getURL: (p: string) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${p}`,
		},
	},
}));

const EXT_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
vi.mock("./lifecycle", () => ({ onTeardown: vi.fn() }));

import { closeRelayHost, destroyRelayHost, hostedFrameForTest, showRelayHost } from "./relay-host";

const ANCHOR = { relayId: "relay-1", rect: { x: 24, y: 320, width: 432, height: 32 } };

/** The host div relay-host appends; its shadow root is closed, so find it by shape. */
function hostEl(): HTMLElement | null {
	return document.body.querySelector<HTMLElement>("div[id^='tp-']");
}

function frameOf(): HTMLIFrameElement {
	// The shadow root is closed, so the frame is only reachable through the test seam.
	const frame = hostedFrameForTest();
	if (!frame) throw new Error("no hosted frame");
	return frame;
}

/** Run the rAF watchdog one tick. */
function tick(): Promise<void> {
	return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function stubRect(el: Element, r: { x: number; y: number; width: number; height: number }): void {
	el.getBoundingClientRect = () =>
		({
			x: r.x,
			y: r.y,
			left: r.x,
			top: r.y,
			width: r.width,
			height: r.height,
			right: r.x + r.width,
			bottom: r.y + r.height,
			toJSON: () => ({}),
		}) as DOMRect;
}

beforeEach(() => {
	document.body.innerHTML = "";
});

afterEach(() => {
	destroyRelayHost();
});

describe("hosting a descendant's picker", () => {
	it("mounts a closed-shadow host carrying the relay id", () => {
		showRelayHost(ANCHOR);

		const host = hostEl();
		expect(host).not.toBeNull();
		// Closed: the page cannot reach in and read the UI's src or its rows.
		expect(host!.shadowRoot).toBeNull();
		expect(host!.style.zIndex).toBe("2147483647");
	});

	it("parks the host just under the relayed rect", () => {
		showRelayHost(ANCHOR);

		expect(hostEl()!.style.transform).toBe("translate3d(24px, 354px, 0)");
	});

	it("re-parks rather than stacking a second host on repeat anchors", () => {
		showRelayHost(ANCHOR);
		showRelayHost({ relayId: "relay-1", rect: { ...ANCHOR.rect, y: 400 } });

		expect(document.body.querySelectorAll("div[id^='tp-']")).toHaveLength(1);
		expect(hostEl()!.style.transform).toBe("translate3d(24px, 434px, 0)");
	});

	it("replaces the host when a different relay takes over", () => {
		showRelayHost(ANCHOR);
		const first = hostEl();
		showRelayHost({ relayId: "relay-2", rect: ANCHOR.rect });

		expect(document.body.querySelectorAll("div[id^='tp-']")).toHaveLength(1);
		expect(hostEl()).not.toBe(first);
	});

	it("drops the host on withdrawal, and ignores a stale relay id", () => {
		showRelayHost(ANCHOR);

		closeRelayHost("some-other-relay");
		expect(hostEl()).not.toBeNull();

		closeRelayHost("relay-1");
		expect(hostEl()).toBeNull();
	});
});

describe("resize messages", () => {
	it("ignores a height posted by the page rather than the UI frame", () => {
		showRelayHost(ANCHOR);
		const before = frameOf().style.height;

		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "UI_RESIZE", height: 300 },
				source: window,
				origin: "https://merchant.example",
			}),
		);

		expect(frameOf().style.height).toBe(before);
	});

	it("ignores a height from our own frame on a non-extension origin", () => {
		showRelayHost(ANCHOR);
		const frame = frameOf();

		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "UI_RESIZE", height: 300 },
				source: frame.contentWindow,
				origin: "https://merchant.example",
			}),
		);

		expect(frame.style.height).toBe("0px");
	});

	it("ignores a height from a different frame of ours", () => {
		// The top frame can hold its own non-relayed picker iframe as well as this host,
		// and both speak from our origin, so origin alone is not enough to route a resize.
		showRelayHost(ANCHOR);
		const frame = frameOf();
		const other = document.createElement("iframe");
		document.body.appendChild(other);

		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "UI_RESIZE", height: 300 },
				source: other.contentWindow,
				origin: EXT_ORIGIN,
			}),
		);

		expect(frame.style.height).toBe("0px");
	});

	it("applies a height from the UI frame on our origin, clamped", () => {
		showRelayHost(ANCHOR);
		const frame = frameOf();

		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "UI_RESIZE", height: 99999 },
				source: frame.contentWindow,
				origin: EXT_ORIGIN,
			}),
		);

		expect(frame.style.height).toBe("400px");
	});
});

describe("clickjacking watchdog", () => {
	// The pick never passes through this frame, so trust cannot be checked at pick
	// time. Instead the host is destroyed the moment it stops being legible.
	async function mountRendered(): Promise<HTMLElement> {
		showRelayHost(ANCHOR);
		const host = hostEl()!;
		const frame = frameOf();
		// A zero-height frame is the normal pre-render state; give it a rendered size.
		stubRect(frame, { x: 24, y: 354, width: 432, height: 120 });
		stubRect(host, { x: 24, y: 354, width: 432, height: 120 });
		document.elementFromPoint = () => host;
		await tick();
		return host;
	}

	it("keeps a legible host alive", async () => {
		await mountRendered();
		await tick();

		expect(hostEl()).not.toBeNull();
	});

	it("tears the host down when the page makes it transparent", async () => {
		const host = await mountRendered();
		host.style.opacity = "0.2";
		await tick();

		expect(hostEl()).toBeNull();
	});

	it("tears the host down when the page hides it", async () => {
		const host = await mountRendered();
		host.style.visibility = "hidden";
		await tick();

		expect(hostEl()).toBeNull();
	});

	it("tears the host down when the page overlays it", async () => {
		const host = await mountRendered();
		const overlay = document.createElement("div");
		document.body.appendChild(overlay);
		document.elementFromPoint = () => overlay;
		await tick();

		expect(hostEl()).toBeNull();
		expect(host.isConnected).toBe(false);
	});

	it("tears the host down when the page shrinks it below legibility", async () => {
		const host = await mountRendered();
		stubRect(host, { x: 24, y: 354, width: 432, height: 4 });
		await tick();

		expect(hostEl()).toBeNull();
	});
});
