// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Anti-clickjacking on the passkey card: a page could fade or cover the card while it sits under
// the cursor, turning an ordinary click into consent to sign in or save a passkey.

const h = vi.hoisted(() => ({ legible: true, sent: [] as unknown[] }));

vi.mock("./legibility", () => ({ EARLY_CLICK_MS: 500, isLegible: () => h.legible }));
vi.mock("./lifecycle", () => ({
	isExtensionAlive: () => true,
	markExtensionDead: vi.fn(),
	onTeardown: vi.fn(),
	safeSendMessage: (m: unknown) => h.sent.push(m),
}));
vi.mock("./content-api", () => ({
	api: {
		runtime: {
			sendMessage: vi.fn(),
			getURL: (path: string) => `chrome-extension://bramble/${path}`,
		},
	},
}));
vi.mock("./i18n", () => ({ t: (k: string) => k }));

import { handleCornerField, handleCornerPromptShow } from "./corner-prompt";
import type { CornerPromptPayload } from "./types";

const prompt = {
	kind: "save-passkey" as const,
	promptId: "p1",
	hostname: "example.com",
	locked: false,
	intent: "create" as const,
	rpId: "example.com",
};

const attachShadow = Element.prototype.attachShadow;

/** Mount the card with an open shadow root, so the test can reach its buttons. */
function mount(payload: CornerPromptPayload = prompt): ShadowRoot {
	vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element) {
		return attachShadow.call(this, { mode: "open" });
	});
	handleCornerPromptShow(payload);
	const root = document.getElementById("bramble-corner-prompt")?.shadowRoot;
	if (!root) throw new Error("card not mounted");
	return root;
}

const approve = (root: ShadowRoot) =>
	root.querySelector<HTMLElement>('[data-tp-action="passkey-approve"]')?.click();

beforeEach(() => {
	vi.useFakeTimers();
	h.legible = true;
	h.sent = [];
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	document.body.innerHTML = "";
});

describe("passkey card consent", () => {
	it("ignores an approve on a card the page has hidden or covered", () => {
		const root = mount();
		vi.advanceTimersByTime(1000);
		h.legible = false;
		approve(root);
		expect(h.sent).toEqual([]);
		expect(document.getElementById("bramble-corner-prompt")).not.toBeNull();
	});

	it("ignores an approve in the first moments after the card appears", () => {
		const root = mount();
		approve(root);
		expect(h.sent).toEqual([]);

		vi.advanceTimersByTime(600);
		approve(root);
		expect(h.sent).toEqual([
			{ type: "PASSKEY_PROMPT_RESPONSE", payload: { promptId: "p1", approved: true } },
		]);
	});
});

// A box in the page's own document hands the page every key typed into it, closed shadow root
// or not. The card's Username is typed in an extension-origin frame, and the box left in the
// page takes no typing at all.
describe("save card username", () => {
	const save = {
		kind: "save-login" as const,
		promptId: "p2",
		hostname: "example.com",
		locked: false,
		username: "alice",
		password: "pw",
	};

	function card(payload: CornerPromptPayload = save) {
		const root = mount(payload);
		const box = root.querySelector<HTMLInputElement>("#tp-username");
		const frame = root.querySelector<HTMLIFrameElement>("iframe.tp-field");
		if (!box || !frame) throw new Error("card has no Username box");
		const id = new URL(frame.src).searchParams.get("id") ?? "";
		// jsdom gives a frame in a shadow root no window; this one records what the card posts.
		const pings: { type?: string; n?: number }[] = [];
		Object.defineProperty(frame, "contentWindow", {
			value: { postMessage: (m: { type?: string; n?: number }) => pings.push(m) },
		});
		const click = (action: string) =>
			root.querySelector<HTMLElement>(`[data-tp-action="${action}"]`)?.click();
		return { root, box, frame, id, pings, click };
	}

	const response = (extra: Record<string, unknown>) => ({
		type: "CORNER_PROMPT_RESPONSE",
		payload: { promptId: "p2", ...extra },
	});

	it("leaves a read-only box in the page and loads the frame beside it, unseen", () => {
		const { box, frame, id } = card();
		expect(box.readOnly).toBe(true);
		expect(box.value).toBe("alice");
		expect(frame.hidden).toBe(true);
		expect(frame.src).toBe(`chrome-extension://bramble/corner-field.html?id=${id}`);
		expect(id).toMatch(/^[0-9a-f]{32}$/);
	});

	it("gives the frame the captured username, and nothing to any other id", () => {
		const { id } = card();
		expect(handleCornerField({ id, op: "open" })).toEqual({ ok: true, data: { value: "alice" } });
		expect(handleCornerField({ id: "someone-else", op: "open" })).toEqual({ ok: false });
		expect(handleCornerField({ id: "someone-else", op: "value", value: "x" })).toEqual({
			ok: false,
		});
		expect(handleCornerField(undefined)).toEqual({ ok: false });
	});

	it("swaps the frame in once it reports", () => {
		const { box, frame, id } = card();
		expect(handleCornerField({ id, op: "value", value: "alice" })).toEqual({ ok: true });
		expect(frame.hidden).toBe(false);
		expect(box.hidden).toBe(true);
	});

	it("saves what the frame holds at the click", async () => {
		const { id, pings, click } = card();
		handleCornerField({ id, op: "value", value: "alice" });
		handleCornerField({ id, op: "value", value: "caro" });

		click("save");
		expect(h.sent).toEqual([]);
		expect(pings).toEqual([{ type: "CORNER_FIELD_FLUSH", n: expect.any(Number) }]);
		handleCornerField({ id, op: "value", value: "carol", flush: pings[0]?.n });
		await vi.advanceTimersByTimeAsync(0);

		expect(h.sent).toEqual([response({ action: "save", editedUsername: "carol" })]);
		expect(document.getElementById("bramble-corner-prompt")).toBeNull();
	});

	it("saves the last text the frame pushed if it never answers", async () => {
		const { id, click } = card();
		handleCornerField({ id, op: "value", value: "carol" });

		click("save");
		await vi.advanceTimersByTimeAsync(999);
		expect(h.sent).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(h.sent).toEqual([response({ action: "save", editedUsername: "carol" })]);
	});

	it("does not wait on an answer to some other flush", async () => {
		const { id, pings, click } = card();
		handleCornerField({ id, op: "value", value: "carol" });

		click("save");
		handleCornerField({ id, op: "value", value: "stale", flush: (pings[0]?.n ?? 0) + 1 });
		await vi.advanceTimersByTimeAsync(0);
		expect(h.sent).toEqual([]);
	});

	it("takes one save, however many clicks land while it is in flight", async () => {
		const { id, pings, click } = card();
		handleCornerField({ id, op: "value", value: "carol" });

		click("save");
		click("save");
		click("dismiss");
		handleCornerField({ id, op: "value", value: "carol", flush: pings[0]?.n });
		await vi.advanceTimersByTimeAsync(0);
		expect(h.sent).toEqual([response({ action: "save", editedUsername: "carol" })]);
	});

	it("sends no edit from a card whose frame never loaded", async () => {
		const { pings, click } = card();
		click("save");
		await vi.advanceTimersByTimeAsync(0);
		expect(pings).toEqual([]);
		expect(h.sent).toEqual([response({ action: "save" })]);
	});

	it("carries the edit through an unlock too", async () => {
		const { id, pings, click } = card({ ...save, locked: true });
		handleCornerField({ id, op: "value", value: "carol" });

		click("save-unlock-first");
		handleCornerField({ id, op: "value", value: "carol", flush: pings[0]?.n });
		await vi.advanceTimersByTimeAsync(0);
		expect(h.sent).toEqual([response({ action: "save-unlock-first", editedUsername: "carol" })]);
	});

	it("hands a reloaded frame back what was typed", () => {
		const { id } = card();
		handleCornerField({ id, op: "value", value: "carol" });
		expect(handleCornerField({ id, op: "open" })).toEqual({ ok: true, data: { value: "carol" } });
	});

	it("forgets the frame with the card", async () => {
		const { id, click } = card();
		handleCornerField({ id, op: "value", value: "carol" });
		click("dismiss");
		expect(handleCornerField({ id, op: "open" })).toEqual({ ok: false });
		expect(handleCornerField({ id, op: "value", value: "late" })).toEqual({ ok: false });
	});

	it("drops a save whose card was replaced while it waited", async () => {
		const { id, click } = card();
		handleCornerField({ id, op: "value", value: "carol" });
		click("save");
		handleCornerPromptShow({ ...save, promptId: "p3" });
		await vi.advanceTimersByTimeAsync(1000);
		expect(h.sent).toEqual([]);
		expect(document.getElementById("bramble-corner-prompt")).not.toBeNull();
	});

	it("puts no frame on a card with nothing to type", () => {
		const root = mount({
			kind: "update-login",
			promptId: "p4",
			hostname: "example.com",
			locked: false,
			candidates: [{ id: "e1", name: "Example", username: "alice" }],
			newPassword: "pw2",
		});
		expect(root.querySelector("iframe")).toBeNull();
		expect(mount().querySelector("iframe")).toBeNull();
	});
});
