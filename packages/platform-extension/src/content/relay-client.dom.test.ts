/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The field frame pins the UI by browser-set origin, so the tests need a known one.
const EXT_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
vi.mock("./content-api", () => ({
	api: {
		runtime: {
			id: "abcdefghijklmnopabcdefghijklmnop",
			getURL: (p: string) => `${EXT_ORIGIN}/${p}`,
		},
	},
}));

import type { FrameRelay, RelayRect } from "./frame-relay";
import {
	closeRelayed,
	installRelayClient,
	relayedPickerIsLive,
	resetRelayClient,
	showRelayed,
} from "./relay-client";

const RECT: RelayRect = { x: 0, y: 8, width: 432, height: 32 };
const MATCHES = [{ id: "card-1", name: "Personal Visa", secondary: "•••• 4242" }];

const handlers = {
	onPick: vi.fn(),
	onPopout: vi.fn(),
	onHighlight: vi.fn(),
	onUseSuggested: vi.fn(),
	onRegenerate: vi.fn(),
};

/** A stand-in for the UI document's window: records what the field frame sends it. */
function fakeUiWindow(): Window & { sent: Array<{ message: unknown; targetOrigin: string }> } {
	const sent: Array<{ message: unknown; targetOrigin: string }> = [];
	return {
		sent,
		postMessage: (message: unknown, targetOrigin: string) => sent.push({ message, targetOrigin }),
	} as unknown as Window & { sent: Array<{ message: unknown; targetOrigin: string }> };
}

function deliver(data: unknown, source: Window | null, origin: string): void {
	window.dispatchEvent(new MessageEvent("message", { data, source, origin }));
}

/** The relayId the client minted, read off the anchor it asked the ancestors for. */
function openedRelayId(relay: { open: ReturnType<typeof vi.fn> }): string {
	return relay.open.mock.calls[0]![0] as string;
}

function makeRelay(): FrameRelay & { open: ReturnType<typeof vi.fn> } {
	return {
		isTop: () => false,
		needsRelay: () => true,
		open: vi.fn(),
		close: vi.fn(),
		onAnchor: vi.fn(),
		onClose: vi.fn(),
		dispose: vi.fn(),
	} as unknown as FrameRelay & { open: ReturnType<typeof vi.fn> };
}

let relay: FrameRelay & { open: ReturnType<typeof vi.fn> };

beforeEach(() => {
	vi.clearAllMocks();
	relay = makeRelay();
	installRelayClient(relay, handlers);
});

afterEach(() => {
	resetRelayClient();
});

describe("binding the UI", () => {
	it("pins a UI answering from an extension origin, then sends it the rows", () => {
		const ui = fakeUiWindow();
		showRelayed(RECT, { kind: "matches", matches: MATCHES, otpOnly: false });
		expect(relayedPickerIsLive()).toBe(false);

		deliver({ __tp: "tp-ui-here", relayId: openedRelayId(relay) }, ui, EXT_ORIGIN);

		expect(relayedPickerIsLive()).toBe(true);
		expect(ui.sent).toHaveLength(1);
		// Pinned to the exact origin, never "*": rows reach the UI document alone.
		expect(ui.sent[0]!.targetOrigin).toBe(EXT_ORIGIN);
		expect(ui.sent[0]!.message).toMatchObject({ type: "RENDER_MATCHES", matches: MATCHES });
	});

	it("refuses a page pretending to be the UI", () => {
		const attacker = fakeUiWindow();
		showRelayed(RECT, { kind: "matches", matches: MATCHES, otpOnly: false });

		// Right relayId (the page can read it off the relay chain), wrong origin.
		deliver(
			{ __tp: "tp-ui-here", relayId: openedRelayId(relay) },
			attacker,
			"https://evil.example",
		);

		expect(relayedPickerIsLive()).toBe(false);
		// The decisive assertion: no summaries were handed to the attacker.
		expect(attacker.sent).toHaveLength(0);
	});

	it("refuses another extension's origin", () => {
		const other = fakeUiWindow();
		showRelayed(RECT, { kind: "matches", matches: MATCHES, otpOnly: false });

		deliver(
			{ __tp: "tp-ui-here", relayId: openedRelayId(relay) },
			other,
			"chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
		);

		expect(relayedPickerIsLive()).toBe(false);
		expect(other.sent).toHaveLength(0);
	});

	it("refuses a reply carrying someone else's relayId", () => {
		const ui = fakeUiWindow();
		showRelayed(RECT, { kind: "matches", matches: MATCHES, otpOnly: false });

		deliver({ __tp: "tp-ui-here", relayId: "not-ours" }, ui, EXT_ORIGIN);

		expect(relayedPickerIsLive()).toBe(false);
		expect(ui.sent).toHaveLength(0);
	});

	it("does not rebind once pinned", () => {
		const ui = fakeUiWindow();
		const usurper = fakeUiWindow();
		showRelayed(RECT, { kind: "matches", matches: MATCHES, otpOnly: false });
		const id = openedRelayId(relay);
		deliver({ __tp: "tp-ui-here", relayId: id }, ui, EXT_ORIGIN);

		deliver({ __tp: "tp-ui-here", relayId: id }, usurper, EXT_ORIGIN);
		deliver({ type: "UI_PICK", entryId: "card-1" }, usurper, EXT_ORIGIN);

		expect(usurper.sent).toHaveLength(0);
		expect(handlers.onPick).not.toHaveBeenCalled();
	});
});

describe("honouring a pick", () => {
	function bind(): ReturnType<typeof fakeUiWindow> {
		const ui = fakeUiWindow();
		showRelayed(RECT, { kind: "matches", matches: MATCHES, otpOnly: false });
		deliver({ __tp: "tp-ui-here", relayId: openedRelayId(relay) }, ui, EXT_ORIGIN);
		return ui;
	}

	it("accepts a pick from the pinned UI for a rendered entry", () => {
		const ui = bind();

		deliver({ type: "UI_PICK", entryId: "card-1" }, ui, EXT_ORIGIN);

		expect(handlers.onPick).toHaveBeenCalledWith("card-1", false);
	});

	it("drops a pick for an entry that was never rendered", () => {
		// The UI document is reachable by anything in the tab, so a relabelled row must
		// not be able to name an entry we did not offer.
		const ui = bind();

		deliver({ type: "UI_PICK", entryId: "some-other-entry" }, ui, EXT_ORIGIN);

		expect(handlers.onPick).not.toHaveBeenCalled();
	});

	it("drops a pick posted by the page rather than the UI", () => {
		bind();
		const page = fakeUiWindow();

		deliver({ type: "UI_PICK", entryId: "card-1" }, page, "https://merchant.example");
		// Even from the right origin, a different window is not the pinned one.
		deliver({ type: "UI_PICK", entryId: "card-1" }, page, EXT_ORIGIN);

		expect(handlers.onPick).not.toHaveBeenCalled();
	});

	it("drops a pick whose origin no longer matches the pinned one", () => {
		const ui = bind();

		deliver({ type: "UI_PICK", entryId: "card-1" }, ui, "https://evil.example");

		expect(handlers.onPick).not.toHaveBeenCalled();
	});

	it("stops honouring picks once the picker is closed", () => {
		const ui = bind();
		closeRelayed();

		deliver({ type: "UI_PICK", entryId: "card-1" }, ui, EXT_ORIGIN);

		expect(handlers.onPick).not.toHaveBeenCalled();
		expect(relay.close).toHaveBeenCalled();
	});

	it("clears the rendered set when the vault locks mid-session", () => {
		const ui = bind();
		showRelayed(RECT, { kind: "locked" });

		deliver({ type: "UI_PICK", entryId: "card-1" }, ui, EXT_ORIGIN);

		expect(handlers.onPick).not.toHaveBeenCalled();
	});
});
