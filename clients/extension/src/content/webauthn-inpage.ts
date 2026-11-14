// Firefox passkey provider: the MAIN-world override. Firefox has no
// chrome.webAuthenticationProxy, so we patch navigator.credentials.create/get in the
// page's own realm (world: "MAIN", run_at: document_start) and forward each request to the
// background via the isolated bridge (webauthn-bridge.ts). Runs before page scripts so we
// win the reference. See docs/firefox-port.md.
//
// This runs in the page realm and is NOT a trust boundary: the rpId-binding origin is
// derived in the background from the browser-set message sender, not from anything here.
// Kept dependency-light (only the flat codec) so the content bundle stays a single file.

import {
	buildCreateCredential,
	buildGetCredential,
	serializeCreateOptions,
	serializeGetOptions,
} from "./webauthn-inpage-codec";

type Passthrough = { passthrough: true };
type TransportResult =
	| Passthrough
	| { error: { name: string; message: string } }
	| { responseJson: string };

// Safety only: the background bounds a whole ceremony to 150 s (webauthn-provider.ts); this is the
// backstop for a wedged bridge so create()/get() never hangs forever.
const ROUNDTRIP_TIMEOUT_MS = 180_000;

const CAPABILITY_TIMEOUT_MS = 5_000;

/** Post the request to the isolated bridge and await its reply (or a transport failure). */
function roundtrip<R = TransportResult>(
	method: "create" | "get" | "isUvpaa",
	payload: unknown,
	timeoutMs = ROUNDTRIP_TIMEOUT_MS,
): Promise<R | Passthrough> {
	return new Promise((resolve, reject) => {
		const id = crypto.randomUUID();
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("passkey transport timeout"));
		}, timeoutMs);
		function onMsg(ev: MessageEvent) {
			if (ev.source !== window) return;
			const d = ev.data as { __bramble_pk?: string; id?: string; result?: R } | null;
			if (!d) return;
			if (d.__bramble_pk !== "res" || d.id !== id) return;
			cleanup();
			resolve(d.result ?? { passthrough: true });
		}
		function cleanup() {
			clearTimeout(timer);
			window.removeEventListener("message", onMsg);
		}
		window.addEventListener("message", onMsg);
		window.postMessage({ __bramble_pk: "req", id, method, payload }, location.origin);
	});
}

// Intercept only where we can bind the origin ourselves: the top frame, or a same-origin
// child. Cross-origin child frames (top.location throws) are deferred to the native
// authenticator, which correctly enforces the WebAuthn permissions policy we can't read.
function canIntercept(): boolean {
	try {
		if (window.top === window) return true;
		return window.top != null && location.origin === window.top.location.origin;
	} catch {
		return false;
	}
}

async function providerServes(): Promise<boolean> {
	if (!canIntercept()) return false;
	try {
		const result = await roundtrip<{ isUvpaa: boolean }>("isUvpaa", null, CAPABILITY_TIMEOUT_MS);
		return "isUvpaa" in result && result.isUvpaa;
	} catch {
		return false;
	}
}

function patchCapabilities(): void {
	const pkc = globalThis.PublicKeyCredential;
	if (typeof pkc?.isUserVerifyingPlatformAuthenticatorAvailable !== "function") return;
	const nativeUvpaa = pkc.isUserVerifyingPlatformAuthenticatorAvailable.bind(pkc);
	Object.defineProperty(pkc, "isUserVerifyingPlatformAuthenticatorAvailable", {
		configurable: true,
		writable: true,
		value: async () => (await nativeUvpaa()) || (await providerServes()),
	});
	if (typeof pkc.getClientCapabilities !== "function") return;
	const nativeCapabilities = pkc.getClientCapabilities.bind(pkc);
	Object.defineProperty(pkc, "getClientCapabilities", {
		configurable: true,
		writable: true,
		value: async () => {
			const capabilities = await nativeCapabilities();
			if (!(await providerServes())) return capabilities;
			return {
				...capabilities,
				passkeyPlatformAuthenticator: true,
				userVerifyingPlatformAuthenticator: true,
			};
		},
	});
}

function install(): void {
	const creds = navigator.credentials;
	if (!creds || typeof creds.create !== "function" || typeof creds.get !== "function") return;
	const nativeCreate = creds.create.bind(creds);
	const nativeGet = creds.get.bind(creds);

	const createOverride = async (
		options?: CredentialCreationOptions,
	): Promise<Credential | null> => {
		if (!options?.publicKey || !canIntercept()) return nativeCreate(options);
		let result: TransportResult;
		try {
			result = await roundtrip("create", serializeCreateOptions(options.publicKey));
		} catch {
			// No answer within the backstop. The background may still be saving a passkey, so a
			// native fallback could leave one the site never registered: fail instead.
			throw new DOMException(
				"The operation either timed out or was not allowed.",
				"NotAllowedError",
			);
		}
		if ("passthrough" in result) return nativeCreate(options);
		if ("error" in result) throw new DOMException(result.error.message, result.error.name);
		// A passkey may already be persisted; do NOT fall back to native here (double-prompt).
		try {
			return buildCreateCredential(JSON.parse(result.responseJson));
		} catch {
			throw new DOMException("passkey response could not be built", "NotAllowedError");
		}
	};

	const getOverride = async (options?: CredentialRequestOptions): Promise<Credential | null> => {
		// Conditional mediation (passkey autofill in the field dropdown) is out of v1 scope.
		if (!options?.publicKey || options.mediation === "conditional" || !canIntercept())
			return nativeGet(options);
		let result: TransportResult;
		try {
			result = await roundtrip("get", serializeGetOptions(options.publicKey));
		} catch {
			return nativeGet(options);
		}
		if ("passthrough" in result) return nativeGet(options);
		if ("error" in result) throw new DOMException(result.error.message, result.error.name);
		try {
			return buildGetCredential(JSON.parse(result.responseJson));
		} catch {
			throw new DOMException("passkey response could not be built", "NotAllowedError");
		}
	};

	try {
		// defineProperty (not assignment) so a wedged descriptor throws here and we degrade
		// to the native behaviour rather than half-patching.
		Object.defineProperty(creds, "create", {
			configurable: true,
			writable: true,
			value: createOverride,
		});
		Object.defineProperty(creds, "get", {
			configurable: true,
			writable: true,
			value: getOverride,
		});
		patchCapabilities();
	} catch {
		// A frozen credentials container: leave the native methods in place.
	}
}

install();
