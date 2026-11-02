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
vi.mock("./content-api", () => ({ api: { runtime: { sendMessage: vi.fn() } } }));
vi.mock("./i18n", () => ({ t: (k: string) => k }));

import { handleCornerPromptShow } from "./corner-prompt";

const prompt = {
	kind: "save-passkey" as const,
	promptId: "p1",
	hostname: "example.com",
	locked: false,
	intent: "create" as const,
	rpId: "example.com",
};

/** Mount the card with an open shadow root, so the test can reach its buttons. */
function mount(): ShadowRoot {
	const attach = Element.prototype.attachShadow;
	vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element) {
		return attach.call(this, { mode: "open" });
	});
	handleCornerPromptShow(prompt);
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
