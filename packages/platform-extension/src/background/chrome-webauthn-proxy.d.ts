// Ambient declaration for chrome.webAuthenticationProxy: @types/chrome@0.0.270 predates
// this MV3 API. Shapes mirror the Chrome reference (verified June 2026). Drop this file
// once the installed @types/chrome ships the namespace. See docs/passkey-provider.md.

declare namespace chrome.webAuthenticationProxy {
	interface CreateRequest {
		requestId: number;
		/** PublicKeyCredentialCreationOptions, JSON-serialized (parseCreationOptionsFromJSON shape). */
		requestDetailsJson: string;
	}
	interface GetRequest {
		requestId: number;
		/** PublicKeyCredentialRequestOptions, JSON-serialized (parseRequestOptionsFromJSON shape). */
		requestDetailsJson: string;
	}
	interface IsUvpaaRequest {
		requestId: number;
	}
	interface DOMExceptionDetails {
		name: string;
		message: string;
	}
	interface CreateResponseDetails {
		requestId: number;
		error?: DOMExceptionDetails;
		/** PublicKeyCredential.toJSON() of the new credential. */
		responseJson?: string;
	}
	interface GetResponseDetails {
		requestId: number;
		error?: DOMExceptionDetails;
		/** PublicKeyCredential.toJSON() of the assertion. */
		responseJson?: string;
	}
	interface IsUvpaaResponseDetails {
		requestId: number;
		isUvpaa: boolean;
	}

	function attach(): Promise<string | undefined>;
	function detach(): Promise<string | undefined>;
	function completeCreateRequest(details: CreateResponseDetails): Promise<void>;
	function completeGetRequest(details: GetResponseDetails): Promise<void>;
	function completeIsUvpaaRequest(details: IsUvpaaResponseDetails): void;

	const onCreateRequest: chrome.events.Event<(requestInfo: CreateRequest) => void>;
	const onGetRequest: chrome.events.Event<(requestInfo: GetRequest) => void>;
	const onIsUvpaaRequest: chrome.events.Event<(requestInfo: IsUvpaaRequest) => void>;
	const onRequestCanceled: chrome.events.Event<(requestId: number) => void>;
}
