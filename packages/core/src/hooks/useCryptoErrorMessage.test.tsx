/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { VAULT_OPEN_FAILED } from "../adapters/crypto";
import { useCryptoErrorMessage } from "./useCryptoErrorMessage";

// An empty catalog resolves every id to its source string, which is what these assertions read.
i18n.load("en", {});
i18n.activate("en");
const wrapper = ({ children }: { children: ReactNode }) => (
	<I18nProvider i18n={i18n}>{children}</I18nProvider>
);
const message = (e: unknown) =>
	renderHook(() => useCryptoErrorMessage(), { wrapper }).result.current(e);

describe("useCryptoErrorMessage", () => {
	// Plain text for screens that can only show a string; CryptoErrorText renders the linked form.
	it("asks for a report on a vault that didn't open", () => {
		expect(message(new Error(VAULT_OPEN_FAILED))).toBe(
			"Bramble couldn't open this vault right now. Please report this error in our issue tracker.",
		);
	});

	it.each(["Error: aes decrypt: aead::Error", "aes encrypt: aead::Error"])(
		"never shows a raw crypto failure (%s)",
		(raw) => {
			expect(message(new Error(raw))).toBe("Something went wrong. Please try again.");
		},
	);

	it("leaves copy that is already written for users alone", () => {
		expect(message(new Error("Incorrect master password"))).toBe("Incorrect master password");
	});
});
