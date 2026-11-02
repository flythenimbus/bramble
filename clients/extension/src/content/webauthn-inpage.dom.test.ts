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
