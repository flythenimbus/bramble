import { useLingui } from "@lingui/react/macro";
import { useCallback } from "react";
import { CRYPTO_PERSISTENCE_FAILED, CRYPTO_SESSION_CHANGED } from "../adapters/crypto";

/**
 * Turn a rejected crypto operation into copy worth showing a user.
 *
 * The background rejects key-lifecycle races with a stable code (see `CRYPTO_SESSION_CHANGED`),
 * which the platform adapters surface verbatim as an Error message. Screens used to render that
 * straight into a form field, so losing an unlock race showed internal wording, untranslated.
 * Unknown messages pass through unchanged: this maps the codes it knows and nothing else.
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
			return message;
		},
		[t],
	);
}
