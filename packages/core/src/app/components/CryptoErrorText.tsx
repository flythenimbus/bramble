import { Trans } from "@lingui/react/macro";
import { VAULT_OPEN_FAILED } from "../../adapters/crypto";
import { useCryptoErrorMessage } from "../../hooks/useCryptoErrorMessage";
import { ISSUES_URL } from "../repo";

/**
 * An unlock or restore error, rendered for the user. Takes the raw error message, not mapped
 * text: a vault that failed to open links to the issue tracker, and anything else goes through
 * useCryptoErrorMessage.
 */
export function CryptoErrorText({ message }: { message: string }) {
	const cryptoError = useCryptoErrorMessage();
	if (!message.startsWith(VAULT_OPEN_FAILED)) return <>{cryptoError(message)}</>;
	return (
		<Trans>
			Bramble couldn't open this vault right now. Please report this error in{" "}
			<a href={ISSUES_URL} target="_blank" rel="noreferrer noopener" className="underline">
				our issue tracker
			</a>
			.
		</Trans>
	);
}
