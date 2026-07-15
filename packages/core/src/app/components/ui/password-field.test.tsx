/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { PasswordField } from "./password-field";

// useLingui throws without an I18nProvider; an empty catalog falls back to source strings.
beforeAll(() => i18n.loadAndActivate({ locale: "en", messages: {} }));
afterEach(cleanup);

function renderPw() {
	return render(
		<I18nProvider i18n={i18n}>
			<PasswordField label="Master password" defaultValue="hunter2" />
		</I18nProvider>,
	);
}

describe("PasswordField", () => {
	it("masks by default and actually reveals the value on toggle", () => {
		renderPw();
		const input = screen.getByLabelText("Master password") as HTMLInputElement;
		expect(input.type).toBe("password");

		fireEvent.click(screen.getByRole("button", { name: "Show password" }));
		expect(input.type).toBe("text"); // value is genuinely visible, not just relabeled

		fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
		expect(input.type).toBe("password");
	});

	it("suppresses OS autofill and the smart-keyboard traits", () => {
		renderPw();
		const input = screen.getByLabelText("Master password") as HTMLInputElement;
		expect(input.getAttribute("autocomplete")).toBe("off");
		expect(input.getAttribute("autocorrect")).toBe("off");
		expect(input.getAttribute("autocapitalize")).toBe("none");
		expect(input.getAttribute("spellcheck")).toBe("false");
	});

	it("keeps the reveal toggle out of the tab order", () => {
		renderPw();
		expect(screen.getByRole("button", { name: "Show password" }).tabIndex).toBe(-1);
	});
});
