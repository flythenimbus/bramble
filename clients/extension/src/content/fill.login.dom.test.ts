/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";
import { loadFixture } from "../fixtures/load";
import { getPageFields, invalidatePageFields } from "./field-model";
import { fillForm } from "./fill";

const byId = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;

beforeEach(() => {
	document.body.innerHTML = "";
	invalidatePageFields();
});

describe("fillForm: doctolib.de's password step (issue #47)", () => {
	beforeEach(() => {
		loadFixture("doctolib-login-password");
		invalidatePageFields();
	});

	it("fills the visible field, not Keycloak's hidden twin ahead of it", () => {
		const visible = byId("input_:r1:");
		const { filled, passwordField } = fillForm("alice@example.com", "s3cr3t", false, visible);
		expect(filled).toBe(true);
		expect(passwordField).toBe(visible);
		expect(visible.value).toBe("s3cr3t");
		expect(byId("password").value).toBe("");
	});

	it("fills the field the pick came from when the twin is hidden by clipping instead", () => {
		// Clipped, not display:none: visible to CSS, so detection takes the twin, first in DOM order.
		const twin = byId("password");
		twin.className = "";
		twin.style.cssText =
			"position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0);";
		invalidatePageFields();
		expect(getPageFields().login.password).toBe(twin);

		const visible = byId("input_:r1:");
		const { passwordField } = fillForm("alice@example.com", "s3cr3t", false, visible);
		expect(passwordField).toBe(visible);
		expect(visible.value).toBe("s3cr3t");
		expect(twin.value).toBe("");
	});
});

describe("fillForm: the pick's own field", () => {
	beforeEach(() => {
		// Register first and login second, both on screen, as many shops lay them out.
		document.body.innerHTML = `
			<form id="register">
				<input id="reg-email" type="email" name="email" />
				<input id="reg-pass" type="password" name="new_password" />
			</form>
			<form id="login">
				<input id="login-email" type="email" name="login" />
				<input id="login-pass" type="password" name="password" />
			</form>`;
		invalidatePageFields();
	});

	it("fills the login form when the pick came from its password field", () => {
		expect(getPageFields().login.password?.id).toBe("reg-pass");
		fillForm("alice@example.com", "s3cr3t", false, byId("login-pass"));
		expect(byId("login-email").value).toBe("alice@example.com");
		expect(byId("login-pass").value).toBe("s3cr3t");
		expect(byId("reg-email").value).toBe("");
		expect(byId("reg-pass").value).toBe("");
	});

	it("fills the model's pair for a pick on one of its own fields", () => {
		fillForm("alice@example.com", "s3cr3t", false, byId("reg-email"));
		expect(byId("reg-email").value).toBe("alice@example.com");
		expect(byId("reg-pass").value).toBe("s3cr3t");
		expect(byId("login-pass").value).toBe("");
	});
});
