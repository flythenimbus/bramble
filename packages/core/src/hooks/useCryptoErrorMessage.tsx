import { useLingui } from "@lingui/react/macro";
import { useCallback } from "react";
import {
	CRYPTO_PERSISTENCE_FAILED,
	CRYPTO_SESSION_CHANGED,
	VAULT_OPEN_FAILED,
} from "../adapters/crypto";

// AES-GCM failures as the Rust core words them. Never worth showing: they read as data loss.
const RAW_CRYPTO_ERROR = /aead::Error|\baes (?:en|de)crypt\b/;

/**
 * Turn a rejected crypto operation into copy worth showing a user.
 *
 * The background rejects key-lifecycle races with a stable code (see `CRYPTO_SESSION_CHANGED`),
 * which the platform adapters surface verbatim as an Error message. Screens used to render that
 * straight into a form field, so losing an unlock race showed internal wording, untranslated.
 * Unknown messages pass through unchanged, except a failed open and raw crypto internals, which
 * map to calm copy.
 */
export function useCryptoErrorMessage(): (error: unknown) => string {
	const { t } = useLingui();
	return useCallback(
		(error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			// Both are transient and the remedy is the same, but they differ in what happened:
			// one lost a race, the other could not write to this device's key storage.
			if (message.startsWith(CRYPTO_SESSION_CHANGED)) {
				return t`The vault was locked or switched while that was in progress. Try again.`;
			}
			if (message.startsWith(CRYPTO_PERSISTENCE_FAILED)) {
				return t`Bramble couldn't safely update this device's key storage, so the vault stayed locked. Try again.`;
			}
			// Only unlock throws this. Screens that can render a link use CryptoErrorText instead.
			if (message.startsWith(VAULT_OPEN_FAILED)) {
				return t`Bramble couldn't open this vault right now. Please report this error in our issue tracker.`;
			}
			// Setup and password changes share this hook: keep raw crypto internals off every screen.
			if (RAW_CRYPTO_ERROR.test(message)) {
				return t`Something went wrong. Please try again.`;
			}
			return message;
		},
		[t],
	);
}
