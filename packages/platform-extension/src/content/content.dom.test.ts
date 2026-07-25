/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invalidatePageFields } from "./field-model";

// Regression for issue #20: unlocking the vault while a "Vault locked" picker is open must
// replace it with suggestions in place, even though unlocking (via the toolbar/pop-out) moves
// focus off the page. The whole render path used to gate on a currently-focused field, so the
// stale locked row survived until the user clicked away and refocused.

// Stateful picker mock mirroring the real facade's host/anchor lifecycle.
const pickerState: { host: object | null; anchor: HTMLInputElement | null } = {
	host: null,
	anchor: null,
};
const showMatches = vi.fn((_matches: unknown, field: HTMLInputElement, _opts?: unknown) => {
	pickerState.host = {};
	pickerState.anchor = field;
});
const showLocked = vi.fn((field: HTMLInputElement) => {
	pickerState.host = {};
	pickerState.anchor = field;
});
const removePicker = vi.fn(() => {
	pickerState.host = null;
	pickerState.anchor = null;
});
// Captured content-side callbacks for the suggested-password row.
let onSuggestedCb: (() => void) | null = null;
let regenerateCb: (() => void) | null = null;
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
		onPick: vi.fn(),
		onUnlockRequest: vi.fn(),
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
vi.mock("./lifecycle", () => ({
	safeSendMessage: (m: unknown) => safeSendMessage(m),
	onTeardown: vi.fn(),
}));
vi.mock("./corner-prompt", () => ({ handleCornerPromptShow: vi.fn(), queryCornerPrompt: vi.fn() }));
vi.mock("./capture", () => ({ maybeEmitSpaSubmit: vi.fn(), onPasswordEnter: vi.fn() }));
const fillPasswordFields = vi.fn(() => true);
vi.mock("./fill", () => ({
	fillCard: vi.fn(),
	fillCustomFields: vi.fn(),
	fillForm: vi.fn(),
	fillOtp: vi.fn(),
	fillPasswordFields,
	submitFromField: vi.fn(),
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

await import("./content");

const send = (message: unknown): void => {
	onMessage?.(message, {}, () => {});
};
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
		pickerState.host = null;
		pickerState.anchor = null;
		document.body.innerHTML = `
			<form>
				<input id="user" type="email" name="email" />
				<input id="pass" type="password" name="password" />
				<button type="submit">Sign in</button>
			</form>`;
		invalidatePageFields();
	});

	it("replaces the locked row with matches on the anchor field even when focus has left the page", () => {
		const user = document.getElementById("user") as HTMLInputElement;

		// Focus the field and receive a locked query result: the picker shows "Vault locked".
		user.focus();
		send({ type: "AUTOFILL_MATCHES", payload: result({ locked: true }) });
		expect(showLocked).toHaveBeenCalledWith(user);

		// Unlock happens off-page (toolbar/pop-out), so the field is no longer focused.
		user.blur();
		expect(document.activeElement).not.toBe(user);
		safeSendMessage.mockClear();

		// The background broadcasts the unlock. The stale locked row is cleared and a re-query fires
		// against the anchor field, not the (absent) focused field.
		send({ type: "VAULT_LOCK_STATE", payload: { locked: false } });
		expect(removePicker).toHaveBeenCalled();
		expect(safeSendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: "AUTOFILL_QUERY" }),
		);

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
});

describe("content: strong-password suggestion on signup", () => {
	beforeEach(() => {
		showMatches.mockClear();
		removePicker.mockClear();
		safeSendMessage.mockClear();
		fillPasswordFields.mockClear();
		pickerState.host = null;
		pickerState.anchor = null;
		document.body.innerHTML = `
			<form>
				<input id="user" type="email" name="email" autocomplete="email" />
				<input id="pass" type="password" name="password" autocomplete="new-password" />
				<button type="submit">Create account</button>
			</form>`;
		invalidatePageFields();
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

	it("fills the password and offers to save when the suggestion is used", () => {
		const pass = document.getElementById("pass") as HTMLInputElement;
		const user = document.getElementById("user") as HTMLInputElement;
		user.value = "me@example.com";
		pass.focus();
		send({ type: "AUTOFILL_MATCHES", payload: result({ logins: [] }) });

		onSuggestedCb?.();
		expect(fillPasswordFields).toHaveBeenCalled();
		expect(safeSendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "CORNER_PROMPT_CAPTURE",
				payload: expect.objectContaining({ username: "me@example.com" }),
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
