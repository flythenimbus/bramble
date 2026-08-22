/**
 * @vitest-environment jsdom
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Issue #59: the observer used to drop the field-model cache and re-query on
// every childList batch, so a page that rewrites itself continuously (YouTube)
// paid a full page scan twice a second, in every frame, hidden tabs included.
// Its own file because content.dom.test.ts fires the teardown callback, which
// disconnects the observer for the rest of that module's life.

// Answers nothing: these cases count the queries that go out, not what comes back.
const safeRequest = vi.fn((_message: { type?: string }) => Promise.resolve(undefined));
let teardown: (() => void) | null = null;
vi.mock("./lifecycle", () => ({
	safeSendMessage: vi.fn(),
	safeRequest: (message: unknown) => safeRequest(message as never),
	onTeardown: (cb: () => void) => {
		teardown = cb;
	},
}));
vi.mock("./picker", () => ({
	picker: {
		showMatches: vi.fn(),
		showLocked: vi.fn(),
		remove: vi.fn(),
		removeDropdown: vi.fn(),
		reposition: vi.fn(),
		activeHost: () => null,
		anchorField: () => null,
		clickIsOnAnchor: () => false,
		handleKey: () => false,
		onPick: vi.fn(),
		onUnlockRequest: vi.fn(),
		onDismiss: vi.fn(),
		onUseSuggested: vi.fn(),
		onRegenerate: vi.fn(),
	},
}));
vi.mock("./corner-prompt", () => ({
	handleCornerPromptShow: vi.fn(),
	queryCornerPrompt: vi.fn(),
}));
vi.mock("./capture", () => ({ maybeCommitCapture: vi.fn(), onPasswordEnter: vi.fn() }));
vi.mock("./fill", () => ({
	fillCard: vi.fn(),
	fillCustomFields: vi.fn(),
	fillForm: vi.fn(() => ({ filled: true, passwordField: null })),
	fillOtp: vi.fn(),
	fillPasswordFields: vi.fn(() => true),
	isFilling: () => false,
	submitFromField: vi.fn(),
}));

(globalThis as unknown as { chrome: unknown }).chrome = {
	runtime: {
		onMessage: { addListener: vi.fn() },
		sendMessage: vi.fn(),
		getURL: (path: string) => path,
	},
};

await import("./content");
const { invalidatePageFields } = await import("./field-model");

const queryCount = (): number =>
	safeRequest.mock.calls.filter(([message]) => message?.type === "AUTOFILL_QUERY").length;

/** Deliver the observer's records, then run the coalescing timer. */
const settle = async (): Promise<void> => {
	await vi.advanceTimersByTimeAsync(700);
};

describe("content: mutation-driven re-query (issue #59)", () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		document.body.innerHTML = `
			<form>
				<input id="user" type="email" name="email" />
				<input id="pass" type="password" name="password" />
			</form>`;
		invalidatePageFields();
		// That setup is itself a mutation; let it drain before counting.
		await settle();
		safeRequest.mockClear();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// The observer outlives every case in this file; leaving it connected means a
	// delivery lands after the jsdom globals are gone.
	afterAll(() => {
		teardown?.();
	});

	it("ignores churn that cannot hold a field", async () => {
		for (let i = 0; i < 20; i += 1) {
			const div = document.createElement("div");
			div.append(document.createElement("span"));
			document.body.append(div);
		}
		await settle();
		expect(queryCount()).toBe(0);
	});

	it("re-queries when a field-bearing node appears", async () => {
		const form = document.createElement("form");
		form.innerHTML = `<input type="password" name="new" />`;
		document.body.append(form);
		await settle();
		expect(queryCount()).toBe(1);
	});

	it("re-queries when a custom element appears, whose shadow tree it cannot see", async () => {
		document.body.append(document.createElement("x-login-form"));
		await settle();
		expect(queryCount()).toBe(1);
	});

	it("coalesces a burst of field changes into one re-query", async () => {
		for (let i = 0; i < 10; i += 1) {
			const input = document.createElement("input");
			input.type = "text";
			document.body.append(input);
		}
		await settle();
		expect(queryCount()).toBe(1);
	});

	it("holds the re-query while the tab is hidden and catches up on return", async () => {
		const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
		const state = vi
			.spyOn(document, "visibilityState", "get")
			.mockReturnValue("hidden" as DocumentVisibilityState);
		document.body.append(document.createElement("input"));
		await settle();
		expect(queryCount()).toBe(0);

		hidden.mockReturnValue(false);
		state.mockReturnValue("visible" as DocumentVisibilityState);
		document.dispatchEvent(new Event("visibilitychange"));
		await settle();
		expect(queryCount()).toBe(1);
		hidden.mockRestore();
		state.mockRestore();
	});
});
