/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	defaultOffscreen,
	extensionSender,
	loadBackground,
	pageSender,
	setAutofillIndex,
	TEST_VEK_KEY,
} from "../test/test-harness";
import { invalidatePageFields } from "./field-model";

// Regression for issue #20: unlocking the vault while a "Vault locked" picker is open must
// replace it with suggestions in place, even though unlocking (via the toolbar/pop-out) moves
// focus off the page. The whole render path used to gate on a currently-focused field, so the
// stale locked row survived until the user clicked away and refocused.

// Stateful picker mock mirroring the real facade's host/anchor lifecycle.
const pickerState: {
	host: { contains(target: Node): boolean } | null;
	anchor: HTMLInputElement | null;
} = {
	host: null,
	anchor: null,
};
const showMatches = vi.fn((_matches: unknown, field: HTMLInputElement, _opts?: unknown) => {
	pickerState.host = { contains: () => false };
	pickerState.anchor = field;
});
const showLocked = vi.fn((field: HTMLInputElement) => {
	pickerState.host = { contains: () => false };
	pickerState.anchor = field;
});
const removePicker = vi.fn(() => {
	pickerState.host = null;
	pickerState.anchor = null;
});
// Captured content-side callbacks for the suggested-password row and the unlock request.
let onSuggestedCb: (() => void) | null = null;
let regenerateCb: (() => void) | null = null;
let unlockCb: ((field: HTMLInputElement | null) => void) | null = null;
let pickCb: ((entryId: string, otpOnly: boolean) => void) | null = null;
vi.mock("./picker", () => ({
	picker: {
		showMatches,
		showLocked,
		remove: removePicker,
		removeDropdown: vi.fn(),
		reposition: vi.fn(),
		activeHost: () => pickerState.host,
		anchorField: () => pickerState.anchor,
		clickIsOnAnchor: () => false,
		handleKey: () => false,
		onPick: (cb: (entryId: string, otpOnly: boolean) => void) => {
			pickCb = cb;
		},
		onUnlockRequest: (cb: (field: HTMLInputElement | null) => void) => {
			unlockCb = cb;
		},
		onDismiss: vi.fn(),
		onUseSuggested: (cb: () => void) => {
			onSuggestedCb = cb;
		},
		onRegenerate: (cb: () => void) => {
			regenerateCb = cb;
		},
	},
}));

const safeSendMessage = vi.fn();
const safeRequest = vi.fn();
const pendingQueryResponses: Array<(response: unknown) => void> = [];
const pendingSelectResponses: Array<(response: unknown) => void> = [];
let submitRevalidationResponder:
	| ((message: { sessionGeneration: number }) => Promise<unknown>)
	| null = null;
let teardownCallback: (() => void) | null = null;
vi.mock("./lifecycle", () => ({
	safeSendMessage: (m: unknown) => safeSendMessage(m),
	// Model the original request's direct reply. The test helper below resolves this
	// synchronously so existing DOM assertions stay focused on picker policy.
	safeRequest: (m: { type?: string }) => {
		safeRequest(m);
		if (m.type === "AUTOFILL_REVALIDATE_SUBMIT") {
			const message = m as { sessionGeneration: number };
			return (
				submitRevalidationResponder?.(message) ??
				Promise.resolve({ ok: true, data: { sessionGeneration: message.sessionGeneration } })
			);
		}
		return {
			// biome-ignore lint/suspicious/noThenProperty: the test harness resolves a one-shot reply synchronously.
			then: (cb: (response: unknown) => void) => {
				if (m.type === "AUTOFILL_QUERY") pendingQueryResponses.push(cb);
				if (m.type === "AUTOFILL_SELECT") pendingSelectResponses.push(cb);
				return Promise.resolve();
			},
		};
	},
	onTeardown: (cb: () => void) => {
		teardownCallback = cb;
	},
}));
vi.mock("./corner-prompt", () => ({ handleCornerPromptShow: vi.fn(), queryCornerPrompt: vi.fn() }));
vi.mock("./capture", () => ({ maybeCommitCapture: vi.fn(), onPasswordEnter: vi.fn() }));
const fillPasswordFields = vi.fn(() => true);
const fillForm = vi.fn((): { filled: boolean; passwordField: HTMLInputElement | null } => ({
	filled: true,
	passwordField: null,
}));
const submitFromField = vi.fn();
vi.mock("./fill", () => ({
	fillCard: vi.fn(),
	fillCustomFields: vi.fn(),
	fillForm,
	fillOtp: vi.fn(),
	fillPasswordFields,
	isFilling: () => false,
	submitFromField,
}));

type MessageListener = (
	message: unknown,
	sender: unknown,
	sendResponse: (v: unknown) => void,
) => unknown;
let onMessage: MessageListener | null = null;

// content-api reads globalThis.chrome at import; set it before importing content.ts so the
// module's top-level onMessage listener registers against this mock.
(globalThis as unknown as { chrome: unknown }).chrome = {
	runtime: {
		onMessage: {
			addListener: (fn: MessageListener) => {
				onMessage = fn;
			},
		},
		sendMessage: vi.fn(),
		getURL: (p: string) => p,
	},
};

const trustedInteractionListeners = new Map<string, EventListener>();
const nativeAddEventListener = document.addEventListener.bind(document);
document.addEventListener = ((
	type: string,
	listener: EventListenerOrEventListenerObject,
	options?: boolean | AddEventListenerOptions,
) => {
	if (
		(type === "pointerdown" || type === "mousedown" || type === "input") &&
		typeof listener === "function"
	) {
		trustedInteractionListeners.set(type, listener);
	}
	nativeAddEventListener(type, listener, options);
}) as typeof document.addEventListener;
await import("./content");
document.addEventListener = nativeAddEventListener;

function dispatchTrustedInteraction(
	type: "pointerdown" | "mousedown" | "input",
	target: HTMLElement,
): void {
	const nativeEvent = new MouseEvent(type, { bubbles: true, composed: true });
	const event = new Proxy(nativeEvent, {
		get(inner, property) {
			if (property === "isTrusted") return true;
			if (property === "composedPath") return () => [target, document.body, document, window];
			const value = Reflect.get(inner, property, inner);
			return typeof value === "function" ? value.bind(inner) : value;
		},
	});
	trustedInteractionListeners.get(type)?.(event);
}

const send = (message: unknown): void => {
	if ((message as { type?: string })?.type === "AUTOFILL_MATCHES") {
		pendingQueryResponses.pop()?.({ ok: true, data: (message as { payload: unknown }).payload });
		return;
	}
	onMessage?.(message, {}, () => {});
};
const replySelect = (response: unknown): void => pendingSelectResponses.pop()?.(response);
const result = (over: Partial<Record<string, unknown>>) => ({
	logins: [],
	cards: [],
	otps: [],
	locked: false,
	hasPotentialMatch: false,
	...over,
});

describe("content: refresh the picker on unlock (issue #20)", () => {
	beforeEach(() => {
		showMatches.mockClear();
		showLocked.mockClear();
		removePicker.mockClear();
		safeSendMessage.mockClear();
		safeRequest.mockClear();
		pickerState.host = null;
		pickerState.anchor = null;
		pendingQueryResponses.length = 0;
		pendingSelectResponses.length = 0;
		document.body.innerHTML = `
			<form>
				<input id="user" type="email" name="email" />
				<input id="pass" type="password" name="password" />
				<button type="submit">Sign in</button>
			</form>`;
		invalidatePageFields();
	});

	it("uses only the latest ordinary query response", () => {
		const user = document.getElementById("user") as HTMLInputElement;
		const pass = document.getElementById("pass") as HTMLInputElement;
		showMatches.mockClear();
		user.focus();
		send({ type: "VAULT_LOCK_STATE", payload: { locked: false } });
		const older = pendingQueryResponses.shift();
		pass.focus();
		send({ type: "VAULT_LOCK_STATE", payload: { locked: false } });
		const newer = pendingQueryResponses.pop();
		newer?.({ ok: true, data: result({ logins: [{ id: "new", name: "New", secondary: "n" }] }) });
		older?.({ ok: true, data: result({ logins: [{ id: "old", name: "Old", secondary: "o" }] }) });
		expect(showMatches.mock.calls.at(-1)?.[1]).toBe(pass);
		expect(showMatches.mock.calls.at(-1)?.[0]).toEqual([
			{ id: "new", name: "New", secondary: "n" },
		]);
	});

	it("replaces the locked row with matches on the anchor field even when focus has left the page", () => {
		const user = document.getElementById("user") as HTMLInputElement;

		// Focus the field and receive a locked query result: the picker shows "Vault locked".
		user.focus();
		// The module persists across this suite; force this case's own direct query.
		send({ type: "VAULT_LOCK_STATE", payload: { locked: false } });
		send({ type: "AUTOFILL_MATCHES", payload: result({ locked: true }) });
		expect(showLocked).toHaveBeenCalledWith(user);

		// Unlock happens off-page (toolbar/pop-out), so the field is no longer focused.
		user.blur();
		expect(document.activeElement).not.toBe(user);
		safeSendMessage.mockClear();
		safeRequest.mockClear();

		// The background broadcasts the unlock. The stale locked row is cleared and a re-query fires
		// against the anchor field, not the (absent) focused field.
		send({ type: "VAULT_LOCK_STATE", payload: { locked: false } });
		expect(removePicker).toHaveBeenCalled();
		expect(safeRequest).toHaveBeenCalledWith(expect.objectContaining({ type: "AUTOFILL_QUERY" }));

		// The fresh matches arrive while nothing is focused: they must still surface on the anchor.
		send({
			type: "AUTOFILL_MATCHES",
			payload: result({ logins: [{ id: "1", name: "Example", secondary: "user@example.com" }] }),
		});
		expect(showMatches).toHaveBeenCalled();
		expect(showMatches.mock.calls.at(-1)?.[1]).toBe(user);
	});

	it("does not resurrect matches on lock when the field is unfocused (hides stale UI)", () => {
		const user = document.getElementById("user") as HTMLInputElement;

		// Matches showing on a focused field...
		user.focus();
		send({
			type: "AUTOFILL_MATCHES",
			payload: result({ logins: [{ id: "1", name: "Example", secondary: "user@example.com" }] }),
		});
		expect(showMatches).toHaveBeenCalled();

		// ...then the vault locks while focus is elsewhere: hide, don't pop "Vault locked" on an idle field.
		user.blur();
		showLocked.mockClear();
		send({ type: "VAULT_LOCK_STATE", payload: { locked: true } });
		expect(removePicker).toHaveBeenCalled();
		expect(showLocked).not.toHaveBeenCalled();
	});

	it("re-surfaces matches after click-to-unlock, even though the click dismissed the picker", () => {
		const user = document.getElementById("user") as HTMLInputElement;

		// Locked: focusing the field shows the "Vault locked" row anchored to it.
		user.focus();
		send({ type: "AUTOFILL_MATCHES", payload: result({ locked: true, hasPotentialMatch: true }) });
		expect(showLocked).toHaveBeenCalledWith(user);

		// The user clicks the locked row: the real picker dismisses its host, then reports the field.
		pickerState.host = null;
		pickerState.anchor = null;
		pendingQueryResponses.length = 0;
		pendingSelectResponses.length = 0;
		unlockCb?.(user);
		expect(safeSendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "POPOUT_OPEN" }));

		// Focus leaves the page for the unlock pop-out; the unlock broadcast arrives with no active host.
		user.blur();
		safeSendMessage.mockClear();
		send({ type: "VAULT_LOCK_STATE", payload: { locked: false } });
		// Previously nothing happened (activeHost() was null); now a re-query fires for the pending field.
		expect(safeRequest).toHaveBeenCalledWith(expect.objectContaining({ type: "AUTOFILL_QUERY" }));

		// The matches arrive while nothing is focused: they surface on the field unlocked from.
		send({
			type: "AUTOFILL_MATCHES",
			payload: result({ logins: [{ id: "1", name: "Example", secondary: "user@example.com" }] }),
		});
		expect(showMatches.mock.calls.at(-1)?.[1]).toBe(user);
	});
});

describe("content: strong-password suggestion on signup", () => {
	beforeEach(() => {
		// jsdom has no layout, so every box is 0x0 and isRendered() would reject the
		// email field -- making this signup form look like one whose account is already
		// identified. Give inputs a real box.
		vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
			width: 200,
			height: 24,
			top: 0,
			left: 0,
			right: 200,
			bottom: 24,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		} as DOMRect);
		showMatches.mockClear();
		removePicker.mockClear();
		safeSendMessage.mockClear();
		safeRequest.mockClear();
		fillPasswordFields.mockClear();
		pickerState.host = null;
		pickerState.anchor = null;
		pendingQueryResponses.length = 0;
		pendingSelectResponses.length = 0;
		document.body.innerHTML = `
			<form>
				<input id="user" type="email" name="email" autocomplete="email" />
				<input id="pass" type="password" name="password" autocomplete="new-password" />
				<button type="submit">Create account</button>
			</form>`;
		invalidatePageFields();
	});

	// The rect spy is global to Element.prototype; the describes below rely on the
	// unlaid-out default, so it must not outlive this one.
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const lastSuggest = () =>
		(showMatches.mock.calls.at(-1)?.[2] as { suggest?: { password: string } } | undefined)?.suggest;

	it("offers a generated password when a signup password field is focused", () => {
		const pass = document.getElementById("pass") as HTMLInputElement;
		pass.focus();
		send({ type: "AUTOFILL_MATCHES", payload: result({ logins: [] }) });
		expect(showMatches.mock.calls.at(-1)?.[1]).toBe(pass);
		expect(lastSuggest()?.password).toEqual(expect.any(String));
	});

	it("shows only the suggestion, not existing logins, on a signup form", () => {
		const pass = document.getElementById("pass") as HTMLInputElement;
		pass.focus();
		// A returning user has a saved login for the site, but a signup form should still show just
		// the suggestion (the new-password token is a strong signal), never the existing match.
		send({
			type: "AUTOFILL_MATCHES",
			payload: result({ logins: [{ id: "1", name: "GitHub", secondary: "jordanavery" }] }),
		});
		const call = showMatches.mock.calls.at(-1);
		expect(call?.[0]).toEqual([]);
		expect(lastSuggest()?.password).toEqual(expect.any(String));
	});

	it("offers the suggestion (not the unlock row) on a signup field while the vault is locked", () => {
		showLocked.mockClear();
		const pass = document.getElementById("pass") as HTMLInputElement;
		pass.focus();
		// Locked, and the user even has a saved login for the site (hasPotentialMatch): a signup field
		// still shows the generated password, since generating one needs no vault.
		send({ type: "AUTOFILL_MATCHES", payload: result({ locked: true, hasPotentialMatch: true }) });
		expect(showLocked).not.toHaveBeenCalled();
		const call = showMatches.mock.calls.at(-1);
		expect(call?.[1]).toBe(pass);
		expect((call?.[2] as { suggest?: unknown })?.suggest).toBeTruthy();
	});

	it("still shows the unlock row on a locked login field (no suggestion)", () => {
		showLocked.mockClear();
		document.body.innerHTML = `
			<form>
				<input id="luser" type="email" name="email" autocomplete="username" />
				<input id="lpass" type="password" name="password" autocomplete="current-password" />
				<button type="submit">Sign in</button>
			</form>`;
		invalidatePageFields();
		const pass = document.getElementById("lpass") as HTMLInputElement;
		pass.focus();
		// The module is shared across this suite, so force a fresh direct query rather
		// than inheriting a cached result from the preceding signup case.
		send({ type: "VAULT_LOCK_STATE", payload: { locked: false } });
		send({ type: "AUTOFILL_MATCHES", payload: result({ locked: true, hasPotentialMatch: true }) });
		expect(showLocked).toHaveBeenCalledWith(pass);
	});

	it("keeps the suggestion across re-renders even after the anchor autocomplete is suppressed", () => {
		const pass = document.getElementById("pass") as HTMLInputElement;
		pass.focus();
		send({ type: "AUTOFILL_MATCHES", payload: result({ logins: [] }) });
		expect(lastSuggest()?.password).toEqual(expect.any(String));
		// The real picker rewrites the anchor field's autocomplete to "off" to suppress native
		// autofill, which would erase the new-password token if the decision were re-evaluated.
		pass.setAttribute("autocomplete", "off");
		// A later query returns a saved login for the site: we must still show the suggestion only.
		send({
			type: "AUTOFILL_MATCHES",
			payload: result({ logins: [{ id: "1", name: "GitHub", secondary: "jordanavery" }] }),
		});
		const call = showMatches.mock.calls.at(-1);
		expect(call?.[0]).toEqual([]);
		expect((call?.[2] as { suggest?: unknown })?.suggest).toBeTruthy();
	});

	it("fills the password and offers to save when the suggestion is used", () => {
		const pass = document.getElementById("pass") as HTMLInputElement;
		const user = document.getElementById("user") as HTMLInputElement;
		user.value = "me@example.com";
		pass.focus();
		send({ type: "AUTOFILL_MATCHES", payload: result({ logins: [] }) });

		onSuggestedCb?.();
		expect(fillPasswordFields).toHaveBeenCalled();
		// A signup (new-password field, no current-password) captures as a NEW login.
		expect(safeSendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "CORNER_PROMPT_CAPTURE",
				payload: expect.objectContaining({ username: "me@example.com", newLogin: true }),
			}),
		);
	});

	it("still captures as a new login after the picker suppresses the anchor autocomplete", () => {
		// Regression: the real picker rewrites the anchor's autocomplete to "off" to
		// suppress the native dropdown, which erases the new-password token. Classifying
		// save-vs-update at pick time read a form that no longer described itself and
		// turned the signup's save into an update. Three e2e tests caught what this
		// suite could not, because the picker is mocked here and never rewrites anything.
		const pass = document.getElementById("pass") as HTMLInputElement;
		const user = document.getElementById("user") as HTMLInputElement;
		user.value = "me@example.com";
		pass.focus();
		send({ type: "AUTOFILL_MATCHES", payload: result({ logins: [] }) });
		pass.setAttribute("autocomplete", "off");

		onSuggestedCb?.();
		expect(safeSendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "CORNER_PROMPT_CAPTURE",
				payload: expect.objectContaining({ newLogin: true }),
			}),
		);
	});

	it("keeps that decision when the user regenerates", () => {
		const pass = document.getElementById("pass") as HTMLInputElement;
		pass.focus();
		send({ type: "AUTOFILL_MATCHES", payload: result({ logins: [] }) });
		pass.setAttribute("autocomplete", "off");
		regenerateCb?.();

		onSuggestedCb?.();
		expect(safeSendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "CORNER_PROMPT_CAPTURE",
				payload: expect.objectContaining({ newLogin: true }),
			}),
		);
	});

	it("captures a change-form suggestion as a rotation, not a new login", () => {
		document.body.innerHTML = `
			<form>
				<input id="cur" type="password" name="current" autocomplete="current-password" />
				<input id="np" type="password" name="new" autocomplete="new-password" />
				<input id="cf" type="password" name="confirm" autocomplete="new-password" />
			</form>`;
		invalidatePageFields();
		const np = document.getElementById("np") as HTMLInputElement;
		np.focus();
		send({
			type: "AUTOFILL_MATCHES",
			payload: result({ logins: [{ id: "1", name: "GitHub", secondary: "jordanavery" }] }),
		});
		onSuggestedCb?.();
		expect(safeSendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "CORNER_PROMPT_CAPTURE",
				payload: expect.objectContaining({ newLogin: false }),
			}),
		);
	});

	it("swaps in a fresh suggestion on regenerate", () => {
		const pass = document.getElementById("pass") as HTMLInputElement;
		pass.focus();
		send({ type: "AUTOFILL_MATCHES", payload: result({ logins: [] }) });
		const first = lastSuggest()?.password;

		regenerateCb?.();
		const second = lastSuggest()?.password;
		expect(second).toEqual(expect.any(String));
		expect(second).not.toBe(first);
	});

	it("does not offer on a plain login field (current-password)", () => {
		document.body.innerHTML = `
			<form>
				<input id="luser" type="email" name="email" />
				<input id="lpass" type="password" name="password" autocomplete="current-password" />
				<button type="submit">Sign in</button>
			</form>`;
		invalidatePageFields();
		const pass = document.getElementById("lpass") as HTMLInputElement;
		pass.focus();
		send({ type: "AUTOFILL_MATCHES", payload: result({ logins: [] }) });
		expect(lastSuggest()).toBeUndefined();
	});
});

describe("content: direct select response binding", () => {
	beforeEach(() => {
		fillForm.mockClear();
		pendingQueryResponses.length = 0;
		pendingSelectResponses.length = 0;
		pickerState.host = null;
		pickerState.anchor = null;
		document.body.innerHTML = `
			<form><input id="user" type="email" name="email" /><input id="pass" type="password" name="password" /></form>`;
		invalidatePageFields();
	});

	it("fills a captured picker anchor from its one direct response", () => {
		const user = document.getElementById("user") as HTMLInputElement;
		user.focus();
		send({
			type: "AUTOFILL_MATCHES",
			payload: result({ logins: [{ id: "1", name: "Example", secondary: "me" }] }),
		});
		pickCb?.("1", false);
		replySelect({
			ok: true,
			data: {
				payload: { kind: "login", username: "me", password: "secret" },
				isAuto: false,
				otpOnly: false,
				sessionGeneration: 0,
			},
		});
		expect(fillForm).toHaveBeenCalledWith("me", "secret", false);
	});

	it("makes a late direct response inert after the anchor is replaced", () => {
		const user = document.getElementById("user") as HTMLInputElement;
		user.focus();
		send({
			type: "AUTOFILL_MATCHES",
			payload: result({ logins: [{ id: "1", name: "Example", secondary: "me" }] }),
		});
		pickCb?.("1", false);
		user.replaceWith(user.cloneNode());
		invalidatePageFields();
		replySelect({
			ok: true,
			data: {
				payload: { kind: "login", username: "me", password: "secret" },
				isAuto: false,
				otpOnly: false,
				sessionGeneration: 0,
			},
		});
		expect(fillForm).not.toHaveBeenCalled();
	});
});

describe("content: deferred direct response cancellation", () => {
	const loginResponse = (over: Record<string, unknown> = {}) => ({
		ok: true,
		data: {
			payload: { kind: "login", username: "me", password: "secret" },
			isAuto: false,
			otpOnly: false,
			sessionGeneration: 0,
			...over,
		},
	});

	function beginPick(target: HTMLInputElement): void {
		target.focus();
		pickerState.host = { contains: () => false };
		pickerState.anchor = target;
		pickCb?.("1", false);
	}

	function scheduleAutoSubmit(
		user: HTMLInputElement,
		pass: HTMLInputElement,
		sessionGeneration = 0,
	): void {
		fillForm.mockReturnValue({ filled: true, passwordField: pass });
		beginPick(user);
		replySelect(
			loginResponse({
				payload: { kind: "login", username: "me", password: "secret", autoSubmit: true },
				sessionGeneration,
			}),
		);
	}

	beforeEach(() => {
		vi.useRealTimers();
		fillForm.mockReset();
		fillForm.mockReturnValue({ filled: true, passwordField: null });
		submitFromField.mockClear();
		pendingQueryResponses.length = 0;
		pendingSelectResponses.length = 0;
		pickerState.host = null;
		pickerState.anchor = null;
		submitRevalidationResponder = null;
		document.body.innerHTML = `
			<form><input id="user" type="email" name="email" /><input id="pass" type="password" name="password" /></form>`;
		invalidatePageFields();
	});

	it("supersedes an earlier selection and consumes only the latest response", () => {
		const user = document.getElementById("user") as HTMLInputElement;
		const pass = document.getElementById("pass") as HTMLInputElement;
		beginPick(user);
		const first = pendingSelectResponses.shift();
		beginPick(pass);
		first?.(loginResponse());
		expect(fillForm).not.toHaveBeenCalled();
		replySelect(loginResponse());
		expect(fillForm).toHaveBeenCalledTimes(1);
	});

	it("rejects malformed replies, lock broadcasts, pagehide, and focus loss", () => {
		const user = document.getElementById("user") as HTMLInputElement;
		const pass = document.getElementById("pass") as HTMLInputElement;
		beginPick(user);
		replySelect({ ok: true });
		expect(fillForm).not.toHaveBeenCalled();

		beginPick(user);
		send({ type: "VAULT_LOCK_STATE", payload: { locked: true } });
		replySelect(loginResponse());
		expect(fillForm).not.toHaveBeenCalled();

		beginPick(user);
		window.dispatchEvent(new Event("pagehide"));
		replySelect(loginResponse());
		expect(fillForm).not.toHaveBeenCalled();

		beginPick(user);
		let focusWasTrusted = false;
		pass.addEventListener("focusin", (event) => {
			focusWasTrusted = event.isTrusted;
		});
		pass.focus();
		expect(focusWasTrusted).toBe(true);
		replySelect(loginResponse());
		expect(fillForm).not.toHaveBeenCalled();
	});

	it("does not let page-generated input cancel a valid response", () => {
		const user = document.getElementById("user") as HTMLInputElement;
		beginPick(user);
		user.dispatchEvent(new Event("input", { bubbles: true }));
		replySelect(loginResponse());
		expect(fillForm).toHaveBeenCalledTimes(1);
	});

	it("binds delayed submit to the exact password field and lock state", () => {
		vi.useFakeTimers();
		const user = document.getElementById("user") as HTMLInputElement;
		const pass = document.getElementById("pass") as HTMLInputElement;
		fillForm.mockReturnValue({ filled: true, passwordField: pass });
		beginPick(user);
		replySelect(
			loginResponse({
				payload: { kind: "login", username: "me", password: "secret", autoSubmit: true },
			}),
		);
		pass.replaceWith(pass.cloneNode());
		vi.advanceTimersByTime(50);
		expect(submitFromField).not.toHaveBeenCalled();

		const replacement = document.getElementById("pass") as HTMLInputElement;
		fillForm.mockReturnValue({ filled: true, passwordField: replacement });
		beginPick(user);
		replySelect(
			loginResponse({
				payload: { kind: "login", username: "me", password: "secret", autoSubmit: true },
			}),
		);
		send({ type: "VAULT_LOCK_STATE", payload: { locked: true } });
		vi.advanceTimersByTime(50);
		expect(submitFromField).not.toHaveBeenCalled();
	});

	it("cancels a scheduled submit on trusted focus after the fill intent is consumed", async () => {
		vi.useFakeTimers();
		const user = document.getElementById("user") as HTMLInputElement;
		const pass = document.getElementById("pass") as HTMLInputElement;
		scheduleAutoSubmit(user, pass);

		let focusWasTrusted = false;
		pass.addEventListener("focusin", (event) => {
			focusWasTrusted = event.isTrusted;
		});
		pass.focus();
		expect(focusWasTrusted).toBe(true);
		await vi.advanceTimersByTimeAsync(50);
		expect(submitFromField).not.toHaveBeenCalled();
	});

	it.each([
		"pointerdown",
		"mousedown",
	] as const)("cancels a scheduled submit on trusted %s after the fill intent is consumed", async (eventType) => {
		vi.useFakeTimers();
		const user = document.getElementById("user") as HTMLInputElement;
		const pass = document.getElementById("pass") as HTMLInputElement;
		scheduleAutoSubmit(user, pass);

		// jsdom never marks constructed pointer/mouse events trusted. Invoke the exact
		// registered production listener with the otherwise-native event shape instead.
		dispatchTrustedInteraction(eventType, pass);
		await vi.advanceTimersByTimeAsync(50);
		expect(submitFromField).not.toHaveBeenCalled();
	});

	it("cancels a scheduled submit on trusted input", async () => {
		vi.useFakeTimers();
		const user = document.getElementById("user") as HTMLInputElement;
		const pass = document.getElementById("pass") as HTMLInputElement;
		scheduleAutoSubmit(user, pass);

		dispatchTrustedInteraction("input", pass);
		await vi.advanceTimersByTimeAsync(50);
		expect(submitFromField).not.toHaveBeenCalled();
	});

	it("preserves a scheduled submit for trusted picker-iframe interaction", async () => {
		vi.useFakeTimers();
		const user = document.getElementById("user") as HTMLInputElement;
		const pass = document.getElementById("pass") as HTMLInputElement;
		scheduleAutoSubmit(user, pass);
		const host = document.createElement("div");
		const iframe = document.createElement("iframe");
		host.appendChild(iframe);
		pickerState.host = host;

		dispatchTrustedInteraction("mousedown", iframe);
		await vi.advanceTimersByTimeAsync(50);
		expect(submitFromField).toHaveBeenCalledWith(pass);
	});

	it("keeps Bramble synthetic input inert after scheduling submit", async () => {
		vi.useFakeTimers();
		const user = document.getElementById("user") as HTMLInputElement;
		const pass = document.getElementById("pass") as HTMLInputElement;
		scheduleAutoSubmit(user, pass);

		pass.dispatchEvent(new Event("input", { bubbles: true }));
		await vi.advanceTimersByTimeAsync(50);
		expect(submitFromField).toHaveBeenCalledWith(pass);
	});

	it.each([
		[
			"pagehide plus BFCache restore",
			() => {
				window.dispatchEvent(new Event("pagehide"));
				const restored = new Event("pageshow");
				Object.defineProperty(restored, "persisted", { value: true });
				window.dispatchEvent(restored);
			},
		],
		["teardown", () => teardownCallback?.()],
	])("cancels scheduled submit on %s", async (_name, cancel) => {
		vi.useFakeTimers();
		const user = document.getElementById("user") as HTMLInputElement;
		const pass = document.getElementById("pass") as HTMLInputElement;
		scheduleAutoSubmit(user, pass);
		cancel();
		await vi.advanceTimersByTimeAsync(50);
		expect(submitFromField).not.toHaveBeenCalled();
	});

	it("cancels scheduled submit when the document hides or its window deactivates", async () => {
		vi.useFakeTimers();
		const user = document.getElementById("user") as HTMLInputElement;
		const pass = document.getElementById("pass") as HTMLInputElement;
		scheduleAutoSubmit(user, pass);
		const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(50);
		expect(submitFromField).not.toHaveBeenCalled();
		visibility.mockRestore();

		scheduleAutoSubmit(user, pass);
		const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
		window.dispatchEvent(new Event("blur"));
		await vi.advanceTimersByTimeAsync(50);
		expect(submitFromField).not.toHaveBeenCalled();
		focus.mockRestore();
	});

	it.each([
		"disabled",
		"readOnly",
		"kind-changed",
	])("cancels scheduled submit when its target is %s", async (state) => {
		vi.useFakeTimers();
		const user = document.getElementById("user") as HTMLInputElement;
		const pass = document.getElementById("pass") as HTMLInputElement;
		scheduleAutoSubmit(user, pass);
		if (state === "disabled") pass.disabled = true;
		else if (state === "readOnly") pass.readOnly = true;
		else pass.type = "text";
		invalidatePageFields();
		await vi.advanceTimersByTimeAsync(50);
		expect(submitFromField).not.toHaveBeenCalled();
	});

	it("suppresses delayed submit when an interactive CAPTCHA appears late", () => {
		vi.useFakeTimers();
		const user = document.getElementById("user") as HTMLInputElement;
		const pass = document.getElementById("pass") as HTMLInputElement;
		fillForm.mockReturnValue({ filled: true, passwordField: pass });
		beginPick(user);
		replySelect(
			loginResponse({
				payload: { kind: "login", username: "me", password: "secret", autoSubmit: true },
			}),
		);
		const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
			width: 100,
			height: 20,
			top: 0,
			left: 0,
			right: 100,
			bottom: 20,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		} as DOMRect);
		const captcha = document.createElement("div");
		captcha.className = "h-captcha";
		document.body.appendChild(captcha);
		vi.advanceTimersByTime(50);
		expect(submitFromField).not.toHaveBeenCalled();
		rect.mockRestore();
	});

	it("fails closed while a background lock transition is held", async () => {
		vi.useFakeTimers();
		let releaseLock: ((response: ReturnType<typeof defaultOffscreen>) => void) | undefined;
		const bg = await loadBackground({
			sessionSeed: { [TEST_VEK_KEY]: "SEED" },
			offscreen: (message) =>
				message.type === "CRYPTO_LOCK"
					? new Promise((resolve) => {
							releaseLock = resolve;
						})
					: defaultOffscreen(message),
		});
		await setAutofillIndex(bg, [
			{
				type: "login",
				id: "login1",
				hostnames: ["example.com"],
				name: "Example",
				username: "me",
				password: "secret",
			},
		]);
		const sender = pageSender("example.com", 1);
		const selected = await bg.send(
			{ type: "AUTOFILL_SELECT", payload: { entryId: "login1" } },
			sender,
		);
		const sessionGeneration = selected.resp.data.sessionGeneration as number;
		const user = document.getElementById("user") as HTMLInputElement;
		const pass = document.getElementById("pass") as HTMLInputElement;
		scheduleAutoSubmit(user, pass, sessionGeneration);
		submitRevalidationResponder = async (message) =>
			(await bg.send({ type: "AUTOFILL_REVALIDATE_SUBMIT", ...message }, sender)).resp;

		const locking = bg.send({ type: "CRYPTO_LOCK" }, extensionSender);
		await vi.advanceTimersByTimeAsync(50);
		expect(releaseLock).toBeTypeOf("function");
		expect(submitFromField).not.toHaveBeenCalled();
		releaseLock?.(defaultOffscreen({ type: "CRYPTO_LOCK" }));
		await locking;
		vi.unstubAllGlobals();
	});
});

// bfcache freezes the DOM as it stands. A picker left open on the way out comes back on
// the return trip showing a match set - and a lock state - from before the trip.
describe("content: leaving the document", () => {
	beforeEach(() => {
		removePicker.mockClear();
		pickerState.host = null;
		pickerState.anchor = null;
		pendingQueryResponses.length = 0;
		document.body.innerHTML = `
			<form>
				<input id="user" type="email" name="email" />
				<input id="pass" type="password" name="password" />
			</form>`;
		invalidatePageFields();
	});

	it("takes an open picker down on pagehide", () => {
		const user = document.getElementById("user") as HTMLInputElement;
		user.focus();
		send({
			type: "AUTOFILL_MATCHES",
			payload: result({ logins: [{ id: "a", name: "A", secondary: "a@example.com" }] }),
		});
		expect(pickerState.host).not.toBeNull();

		window.dispatchEvent(new Event("pagehide"));

		expect(removePicker).toHaveBeenCalled();
		expect(pickerState.host).toBeNull();
	});
});
