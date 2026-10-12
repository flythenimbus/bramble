/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VAULT_OPEN_FAILED } from "../../adapters/crypto";
import { ISSUES_URL } from "../repo";
import { CryptoErrorText } from "./CryptoErrorText";

afterEach(cleanup);

// An empty catalog resolves every id to its source string, which is what these assertions read.
i18n.load("en", {});
i18n.activate("en");
const show = (message: string) =>
	render(
		<I18nProvider i18n={i18n}>
			<CryptoErrorText message={message} />
		</I18nProvider>,
	);

describe("CryptoErrorText", () => {
	it("asks for a report on a vault that didn't open, linking the issue tracker", () => {
		const { container } = show(VAULT_OPEN_FAILED);
		expect(container.textContent).toBe(
			"Bramble couldn't open this vault right now. Please report this error in our issue tracker.",
		);
		const link = screen.getByRole("link", { name: "our issue tracker" });
		expect(link.getAttribute("href")).toBe(ISSUES_URL);
		expect(link.getAttribute("target")).toBe("_blank");
	});

	it("maps a raw crypto failure like any other unlock error", () => {
		const { container } = show("Error: aes decrypt: aead::Error");
		expect(container.textContent).toBe("Something went wrong. Please try again.");
		expect(screen.queryByRole("link")).toBeNull();
	});

	it("shows copy already written for users as is", () => {
		const { container } = show("Incorrect master password");
		expect(container.textContent).toBe("Incorrect master password");
	});
});
