/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it } from "vitest";
import { parsePageFields } from "./detection";
import { getPageFields, invalidatePageFields } from "./field-model";

function loadHTML(html: string): void {
	document.body.innerHTML = html;
	invalidatePageFields(); // reset the module-level cache between cases
}

const LOGIN = `
	<form>
		<input type="text" name="email" autocomplete="username" />
		<input type="password" autocomplete="current-password" />
	</form>`;

describe("parsePageFields", () => {
	beforeEach(() => loadHTML(LOGIN));

	it("composes login, card, and otp into one model", () => {
		const m = parsePageFields();
		expect(m.login.username).not.toBeNull();
		expect(m.login.password).not.toBeNull();
		expect(m.card.number).toBeNull();
		expect(m.otp).toHaveLength(0);
	});
});

describe("getPageFields cache", () => {
	beforeEach(() => loadHTML(LOGIN));

	it("returns the same model across reads while the DOM is unchanged", () => {
		const a = getPageFields();
		const b = getPageFields();
		expect(b).toBe(a); // cached, not re-parsed
	});

	it("re-parses after invalidatePageFields", () => {
		const a = getPageFields();
		invalidatePageFields();
		const b = getPageFields();
		expect(b).not.toBe(a);
	});

	it("re-parses when a referenced field has left the document", () => {
		const a = getPageFields();
		expect(a.login.password).not.toBeNull();
		// Drop the field without invalidating: simulates an SPA re-render before the
		// MutationObserver callback runs. The staleness guard must catch it.
		a.login.password!.remove();
		const b = getPageFields();
		expect(b).not.toBe(a);
		expect(b.login.password).toBeNull();
	});
});
