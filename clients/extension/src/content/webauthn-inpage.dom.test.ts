// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Firefox MAIN-world override, when the bridge never answers. Falling back to the native
// authenticator is right for a get, which saves nothing; for a create the background may still be
// saving a passkey, so a fallback would leave one in the vault the site never registered.

const createOptions = {
	publicKey: {
		rp: { id: "example.com" },
		user: { id: new Uint8Array([1]), name: "ada", displayName: "Ada" },
		challenge: new Uint8Array([2]),
		pubKeyCredParams: [{ type: "public-key", alg: -7 }],
	},
} as unknown as CredentialCreationOptions;

const getOptions = {
	publicKey: { rpId: "example.com", challenge: new Uint8Array([2]) },
} as unknown as CredentialRequestOptions;

/** Install the override over spy natives; returns the spies (the override replaces the methods). */
async function install() {
	const native = { create: vi.fn(async () => null), get: vi.fn(async () => null) };
	Object.defineProperty(navigator, "credentials", { configurable: true, value: { ...native } });
	await import("./webauthn-inpage");
	return native;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetModules();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("webauthn-inpage when the bridge never answers", () => {
	it("fails a create instead of handing it to the native authenticator", async () => {
		const native = await install();
		const outcome = navigator.credentials.create(createOptions).then(
			() => "resolved",
			(e: DOMException) => e.name,
		);
		await vi.advanceTimersByTimeAsync(181_000);
		expect(await outcome).toBe("NotAllowedError");
		expect(native.create).not.toHaveBeenCalled();
	});

	it("falls back to the native authenticator for a get", async () => {
		const native = await install();
		const outcome = navigator.credentials.get(getOptions);
		await vi.advanceTimersByTimeAsync(181_000);
		await outcome;
		expect(native.get).toHaveBeenCalledTimes(1);
	});
});

describe("webauthn-inpage capability answers", () => {
	const LINUX = {
		conditionalGet: true,
		passkeyPlatformAuthenticator: false,
		userVerifyingPlatformAuthenticator: false,
	};

	let stopAnswering = () => {};
	function answer(result: unknown) {
		const onMsg = (ev: MessageEvent) => {
			if (ev.data?.__bramble_pk !== "req" || ev.data.method !== "isUvpaa") return;
			const data = { __bramble_pk: "res", id: ev.data.id, result };
			window.dispatchEvent(new MessageEvent("message", { source: window, data }));
		};
		window.addEventListener("message", onMsg);
		stopAnswering = () => window.removeEventListener("message", onMsg);
	}

	beforeEach(() => {
		// jsdom delivers postMessage on a real timer.
		vi.useRealTimers();
		vi.stubGlobal("PublicKeyCredential", {
			isUserVerifyingPlatformAuthenticatorAvailable: async () => false,
			getClientCapabilities: async () => ({ ...LINUX }),
		});
	});
	afterEach(() => stopAnswering());

	it("reports a platform authenticator where the provider serves the page", async () => {
		answer({ isUvpaa: true });
		await install();
		expect(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()).toBe(true);
		const capabilities = await PublicKeyCredential.getClientCapabilities();
		expect(capabilities).toEqual({
			...LINUX,
			passkeyPlatformAuthenticator: true,
			userVerifyingPlatformAuthenticator: true,
		});
	});

	it.each([
		["the provider will not serve the page", { isUvpaa: false }],
		["the bridge cannot reach the background", { passthrough: true }],
	])("gives the browser's own answers when %s", async (_why, result) => {
		answer(result);
		await install();
		expect(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()).toBe(false);
		expect(await PublicKeyCredential.getClientCapabilities()).toEqual(LINUX);
	});

	it("gives the browser's own answer when the bridge never answers", async () => {
		vi.useFakeTimers();
		await install();
		const outcome = PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
		await vi.advanceTimersByTimeAsync(5_001);
		expect(await outcome).toBe(false);
	});
});
