/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixture } from "../fixtures/load";

const safeSendMessage = vi.fn();
vi.mock("./lifecycle", () => ({
	safeSendMessage: (m: unknown) => safeSendMessage(m),
	onTeardown: () => {},
}));

const {
	maybeCommitCapture,
	notePasswordEdit,
	onPasswordEnter,
	onSubmit,
	onSubmitControlClick,
	resetCaptureState,
} = await import("./capture");

// jsdom has no layout, so isRendered() would treat every element as 0x0. Give
// them a box; visibility is then driven by display/visibility/opacity alone.
let rectSpy: ReturnType<typeof vi.spyOn>;

function captures(): Array<{ username: string; password: string; newLogin: boolean }> {
	return safeSendMessage.mock.calls
		.map((c) => c[0] as { type: string; payload: never })
		.filter((m) => m.type === "CORNER_PROMPT_CAPTURE")
		.map((m) => m.payload);
}

beforeEach(() => {
	rectSpy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
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
	safeSendMessage.mockClear();
	resetCaptureState();
});

afterEach(() => {
	rectSpy.mockRestore();
	resetCaptureState();
	vi.useRealTimers();
});

// skanetrafiken.se: a Vue SPA with no <form> at all and a `type="button"` login
// control, so neither the submit event nor the 1500ms vanishing-field fallback
// ever fires. See docs/field-detection.md for the captured fixture.
describe("formless SPA login (skanetrafiken fixture)", () => {
	let email: HTMLInputElement;
	let password: HTMLInputElement;
	let submitBtn: HTMLButtonElement;

	beforeEach(() => {
		loadFixture("skanetrafiken-login");
		email = document.getElementById("email") as HTMLInputElement;
		password = document.getElementById("password") as HTMLInputElement;
		// Four elements share id="submit" (the reset-password modals reuse it), so
		// getElementById would hand back a modal's button. Scope to the login form.
		submitBtn = document.querySelector(".st-login-form__actions button") as HTMLButtonElement;
		email.value = "resenar@example.se";
		password.value = "korrekt-häst";
		notePasswordEdit(password);
	});

	it("has no form and a non-submit login button", () => {
		expect(document.querySelectorAll("form")).toHaveLength(0);
		expect(submitBtn.type).toBe("button");
		expect(submitBtn.textContent).toMatch(/Logga in/);
	});

	it("captures once the login goes through and the form is torn down", () => {
		onSubmitControlClick(submitBtn);
		expect(captures()).toHaveLength(0);

		// The SPA swaps the login panel for the account view.
		password.remove();
		maybeCommitCapture();

		expect(captures()).toEqual([
			{ username: "resenar@example.se", password: "korrekt-häst", newLogin: false },
		]);
	});

	it("captures when the panel is hidden rather than removed", () => {
		onSubmitControlClick(submitBtn);
		password.style.display = "none";
		maybeCommitCapture();
		expect(captures()).toHaveLength(1);
	});

	it("does not capture a failed login, where the field stays on screen", () => {
		onSubmitControlClick(submitBtn);
		// Site re-renders with an error; the password field survives.
		maybeCommitCapture();
		maybeCommitCapture();
		expect(captures()).toHaveLength(0);
	});

	it("drops the attempt once the arm window expires", () => {
		vi.useFakeTimers();
		onSubmitControlClick(submitBtn);
		vi.advanceTimersByTime(11_000);
		password.remove();
		maybeCommitCapture();
		expect(captures()).toHaveLength(0);
	});

	it("commits without waiting on the MutationObserver", () => {
		vi.useFakeTimers();
		onSubmitControlClick(submitBtn);
		password.remove();
		// No maybeCommitCapture() call: the armed poll has to find it.
		vi.advanceTimersByTime(300);
		expect(captures()).toHaveLength(1);
	});

	it("emits only once even if the checkpoint runs again", () => {
		onSubmitControlClick(submitBtn);
		password.remove();
		maybeCommitCapture();
		maybeCommitCapture();
		expect(captures()).toHaveLength(1);
	});

	it("re-typing after a failure disarms the stale attempt", () => {
		vi.useFakeTimers();
		onSubmitControlClick(submitBtn);
		// Login failed; the user corrects the password.
		password.value = "rätt-lösenord";
		notePasswordEdit(password);
		vi.advanceTimersByTime(3000);
		password.remove();
		maybeCommitCapture();
		// The stale arm is gone and the 1500ms fallback has expired.
		expect(captures()).toHaveLength(0);
	});

	it("captures the corrected password when the retry succeeds", () => {
		onSubmitControlClick(submitBtn);
		password.value = "rätt-lösenord";
		notePasswordEdit(password);
		onSubmitControlClick(submitBtn);
		password.remove();
		maybeCommitCapture();
		expect(captures()).toEqual([
			{ username: "resenar@example.se", password: "rätt-lösenord", newLogin: false },
		]);
	});

	// These two sit inside the login panel and tear it down when activated, so an
	// arm on either would offer to save a password that was never submitted. Time
	// is advanced past the 1500ms fallback so only the armed path is under test.
	it("does not arm on the 'Visa lösenord' toggle", () => {
		vi.useFakeTimers();
		const toggle = document.getElementById("password-checkbox") as HTMLInputElement;
		onSubmitControlClick(toggle.closest('[role="checkbox"]') as Element);
		vi.advanceTimersByTime(3000);
		password.remove();
		maybeCommitCapture();
		expect(captures()).toHaveLength(0);
	});

	it("does not arm on the 'Glömt lösenord?' pseudo-button", () => {
		vi.useFakeTimers();
		const forgot = [...document.querySelectorAll('[role="button"]')].find((el) =>
			/Glömt lösenord/.test(el.textContent ?? ""),
		);
		expect(forgot).toBeTruthy();
		onSubmitControlClick(forgot as Element);
		vi.advanceTimersByTime(3000);
		password.remove();
		maybeCommitCapture();
		expect(captures()).toHaveLength(0);
	});

	it("does not capture a form the user abandoned without submitting", () => {
		vi.useFakeTimers();
		vi.advanceTimersByTime(3000);
		password.remove();
		maybeCommitCapture();
		expect(captures()).toHaveLength(0);
	});
});

describe("existing submit paths still emit synchronously", () => {
	beforeEach(() => {
		document.body.innerHTML = `
			<form id="f">
				<input id="user" name="username" type="text" autocomplete="username" />
				<input id="pass" name="password" type="password" autocomplete="current-password" />
				<button type="submit">Sign in</button>
			</form>`;
		(document.getElementById("user") as HTMLInputElement).value = "jordanavery";
		const pass = document.getElementById("pass") as HTMLInputElement;
		pass.value = "hunter2";
		notePasswordEdit(pass);
	});

	it("emits on a native form submit, before any navigation", () => {
		onSubmit();
		expect(captures()).toEqual([{ username: "jordanavery", password: "hunter2", newLogin: false }]);
	});

	it("emits from the document-level submit listener", () => {
		document.getElementById("f")?.dispatchEvent(new Event("submit", { bubbles: true }));
		expect(captures()).toHaveLength(1);
	});

	it("emits on Enter inside the password field", () => {
		onPasswordEnter("Enter", document.getElementById("pass"));
		expect(captures()).toHaveLength(1);
	});

	it("ignores other keys", () => {
		onPasswordEnter("a", document.getElementById("pass"));
		expect(captures()).toHaveLength(0);
	});

	it("ignores Enter outside a password field", () => {
		onPasswordEnter("Enter", document.getElementById("user"));
		expect(captures()).toHaveLength(0);
	});

	it("arms on a real submit button too, without double-emitting", () => {
		const btn = document.querySelector("button") as HTMLButtonElement;
		onSubmitControlClick(btn);
		onSubmit();
		document.getElementById("pass")?.remove();
		maybeCommitCapture();
		expect(captures()).toHaveLength(1);
	});
});
