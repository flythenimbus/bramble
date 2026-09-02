import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createPrfCredential,
	getPrfSecret,
	getPrfSecretAcrossRpIds,
	rpIdFor,
	setWebauthnInterceptionPauser,
	setWebauthnRpId,
	unlockRpIdOrder,
	webauthnUnlockPossible,
} from "./webauthn-ceremony";

const RAW_ID = new Uint8Array([1, 2, 3, 4]).buffer;
const SECRET = new Uint8Array(32).fill(7).buffer;

/** authData is 32 bytes rpIdHash then flags; BS (0x10) marks a synced credential. */
function authData(flags: number): ArrayBuffer {
	const bytes = new Uint8Array(37);
	bytes[32] = flags;
	return bytes.buffer;
}

type ExtResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };

function credential(ext: ExtResults, flags = 0) {
	return {
		rawId: RAW_ID,
		response: { getAuthenticatorData: () => authData(flags) },
		getClientExtensionResults: () => ext,
	};
}

function stubCredentials(over: { create?: unknown; get?: unknown } = {}) {
	const create = vi.fn(async () => credential({ prf: { results: { first: SECRET } } }));
	const get = vi.fn(async () => credential({ prf: { results: { first: SECRET } } }));
	const api = { create: over.create ?? create, get: over.get ?? get };
	vi.stubGlobal("navigator", { credentials: api });
	return api as { create: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
}

/** The options object handed to navigator.credentials.create/get on the nth call. */
function publicKeyArg(fn: ReturnType<typeof vi.fn>, call = 0) {
	return (fn.mock.calls[call]![0] as any).publicKey;
}

afterEach(() => {
	vi.unstubAllGlobals();
	setWebauthnInterceptionPauser((run) => run());
	setWebauthnRpId(undefined);
});

describe("createPrfCredential ceremony options", () => {
	it("makes a platform key discoverable and user-verified, which Apple Passwords requires", async () => {
		const api = stubCredentials();
		await createPrfCredential("Touch ID", { kind: "platform" });

		expect(publicKeyArg(api.create).authenticatorSelection).toEqual({
			authenticatorAttachment: "platform",
			residentKey: "required",
			userVerification: "required",
		});
	});

	it("keeps a security key non-discoverable so it does not burn a resident slot", async () => {
		const api = stubCredentials();
		await createPrfCredential("YubiKey", { kind: "securityKey" });

		const selection = publicKeyArg(api.create).authenticatorSelection;
		expect(selection.residentKey).toBe("discouraged");
		expect(selection.authenticatorAttachment).toBeUndefined();
	});

	it("defaults to the security-key options, so existing callers are unchanged", async () => {
		const api = stubCredentials();
		await createPrfCredential("YubiKey");

		expect(publicKeyArg(api.create).authenticatorSelection.residentKey).toBe("discouraged");
	});
});

describe("explicit rpID (Firefox)", () => {
	it("sets rp.id on create and carries it into the fallback get", async () => {
		// No PRF at create forces the second ceremony, which must target the same rpID.
		const create = vi.fn(async () => credential({ prf: { enabled: true } }));
		const api = stubCredentials({ create });
		await createPrfCredential("Touch ID", { kind: "platform", rpId: "bramble.sh" });

		expect(publicKeyArg(api.create).rp).toEqual({ name: "Vault", id: "bramble.sh" });
		expect(publicKeyArg(api.get).rpId).toBe("bramble.sh");
	});

	it("omits rp.id entirely on Chromium, which must keep its implicit extension rpID", async () => {
		const api = stubCredentials();
		await createPrfCredential("Touch ID", { kind: "platform" });

		expect(publicKeyArg(api.create).rp).toEqual({ name: "Vault" });
		expect("rpId" in publicKeyArg(api.create)).toBe(false);
	});

	it("uses the rpID the platform installed, so callers do not thread it", async () => {
		const api = stubCredentials();
		setWebauthnRpId("bramble.sh");
		await createPrfCredential("Touch ID", { kind: "platform" });

		expect(publicKeyArg(api.create).rp).toEqual({ name: "Vault", id: "bramble.sh" });
	});

	it("leaves security keys on the implicit rpID even once a shared one is installed", async () => {
		// Moving them would invalidate every already-registered key, and buys nothing: Firefox
		// has no PRF for external keys, so there is no roaming to gain.
		const api = stubCredentials();
		setWebauthnRpId("bramble.sh");
		await createPrfCredential("YubiKey", { kind: "securityKey" });

		expect(publicKeyArg(api.create).rp).toEqual({ name: "Vault" });
	});

	it("translates an old browser's refusal without naming only one of them", async () => {
		const create = vi.fn(async () => {
			throw Object.assign(new Error("The operation is insecure."), { name: "SecurityError" });
		});
		stubCredentials({ create });
		setWebauthnRpId("bramble.sh");

		await expect(createPrfCredential("Touch ID", { kind: "platform" })).rejects.toThrow(
			/Chrome 122 or Firefox 150/,
		);
	});

	it("lets a SecurityError through untranslated on Chromium, where no rpID is in play", async () => {
		const create = vi.fn(async () => {
			throw Object.assign(new Error("The operation is insecure."), { name: "SecurityError" });
		});
		stubCredentials({ create });

		await expect(createPrfCredential("Touch ID", { kind: "platform" })).rejects.toThrow(
			/operation is insecure/,
		);
	});

	it("passes rpId through getPrfSecret for unlock", async () => {
		const api = stubCredentials();
		await getPrfSecret([{ credentialId: new Uint8Array([9]) }], new Uint8Array(32), {
			rpId: "bramble.sh",
		});

		expect(publicKeyArg(api.get).rpId).toBe("bramble.sh");
	});
});

describe("providers that cannot unlock the vault", () => {
	it("fails immediately when the provider reports prf disabled, without asking for a second tap", async () => {
		const create = vi.fn(async () => credential({ prf: { enabled: false } }));
		const api = stubCredentials({ create });

		await expect(createPrfCredential("Touch ID", { kind: "platform" })).rejects.toThrow(
			/choose iCloud Keychain or Windows Hello/,
		);
		expect(api.get).not.toHaveBeenCalled();
	});

	it("names the security-key remedy on the security-key path", async () => {
		const create = vi.fn(async () => credential({ prf: { enabled: false } }));
		stubCredentials({ create });

		await expect(createPrfCredential("YubiKey", { kind: "securityKey" })).rejects.toThrow(
			/YubiKey 5\+/,
		);
	});

	it("still takes a second tap when create is merely silent about prf", async () => {
		// An older key that ignores eval-at-create says nothing, rather than enabled: false.
		const create = vi.fn(async () => credential({}));
		const api = stubCredentials({ create });

		const result = await createPrfCredential("YubiKey", { kind: "securityKey" });
		expect(api.get).toHaveBeenCalledOnce();
		expect(result.hmacSecret).toEqual(new Uint8Array(SECRET));
	});
});

describe("cancellation copy", () => {
	it("does not tell a platform user about two taps, because registering is one", async () => {
		const create = vi.fn(async () => {
			throw Object.assign(new Error("cancelled"), { name: "NotAllowedError" });
		});
		stubCredentials({ create });

		await expect(createPrfCredential("Touch ID", { kind: "platform" })).rejects.toThrow(
			/cancelled or timed out\. Please try again\./,
		);
	});

	it("explains the two taps on the security-key path", async () => {
		const create = vi.fn(async () => {
			throw Object.assign(new Error("cancelled"), { name: "NotAllowedError" });
		});
		stubCredentials({ create });

		await expect(createPrfCredential("YubiKey", { kind: "securityKey" })).rejects.toThrow(
			/takes two taps/,
		);
	});
});

describe("synced flag", () => {
	it("reports a backed-up credential as synced (Apple Passwords)", async () => {
		const create = vi.fn(async () => credential({ prf: { results: { first: SECRET } } }, 0x10));
		stubCredentials({ create });

		expect((await createPrfCredential("Touch ID", { kind: "platform" })).synced).toBe(true);
	});

	it("reports a device-bound credential as not synced (Windows Hello)", async () => {
		const create = vi.fn(async () => credential({ prf: { results: { first: SECRET } } }, 0x00));
		stubCredentials({ create });

		expect((await createPrfCredential("Touch ID", { kind: "platform" })).synced).toBe(false);
	});

	it("does not claim synced when the response cannot report authenticator data", async () => {
		const create = vi.fn(async () => ({
			rawId: RAW_ID,
			response: {},
			getClientExtensionResults: () => ({ prf: { results: { first: SECRET } } }),
		}));
		stubCredentials({ create });

		expect((await createPrfCredential("Touch ID", { kind: "platform" })).synced).toBe(false);
	});
});

describe("passkey-provider interception", () => {
	it("runs both ceremonies inside the pauser, or the extension eats its own request", async () => {
		// Skipping this is why the spike first read as "no PRF support": an attached proxy
		// rejects an extension-originated request with "no resolvable tab origin".
		const create = vi.fn(async () => credential({ prf: { enabled: true } }));
		stubCredentials({ create });
		const order: string[] = [];
		setWebauthnInterceptionPauser(async (run) => {
			order.push("pause");
			try {
				return await run();
			} finally {
				order.push("resume");
			}
		});

		await createPrfCredential("Touch ID", { kind: "platform", rpId: "bramble.sh" });

		expect(order).toEqual(["pause", "resume", "pause", "resume"]);
	});
});

describe("unlock failures across browsers", () => {
	it("explains that keys are per browser when nothing matched", async () => {
		// A vault synced between Chrome and Firefox holds slots under two different rpIDs, so
		// the local authenticator can match none of them. WebAuthn reports that identically to
		// a dismissed prompt, so the message has to cover both.
		const get = vi.fn(async () => {
			throw Object.assign(new Error(""), { name: "NotAllowedError" });
		});
		stubCredentials({ get });

		await expect(
			getPrfSecret([{ credentialId: new Uint8Array([9]) }], new Uint8Array(32), {
				forUnlock: true,
			}),
		).rejects.toThrow(/registered per browser/);
	});

	it("leaves registration's fallback get alone, where a refusal means something else", async () => {
		// The credential was created moments earlier, so it will match; a NotAllowedError here
		// is a real cancellation and must not be dressed up as a cross-browser problem.
		const get = vi.fn(async () => {
			throw Object.assign(new Error("cancelled"), { name: "NotAllowedError" });
		});
		stubCredentials({ get });

		await expect(
			getPrfSecret([{ credentialId: new Uint8Array([9]) }], new Uint8Array(32)),
		).rejects.toThrow(/^cancelled$/);
	});

	it("treats a null credential on unlock the same way", async () => {
		const get = vi.fn(async () => null);
		stubCredentials({ get });

		await expect(
			getPrfSecret([{ credentialId: new Uint8Array([9]) }], new Uint8Array(32), {
				forUnlock: true,
			}),
		).rejects.toThrow(/registered per browser/);
	});
});

describe("rpID selection", () => {
	it("routes platform keys to the shared rpID and security keys to the implicit one", () => {
		setWebauthnRpId("bramble.sh");
		expect(rpIdFor("platform")).toBe("bramble.sh");
		expect(rpIdFor("securityKey")).toBeUndefined();
	});

	it("tries the platform rpID first when this device registered a platform key", () => {
		setWebauthnRpId("bramble.sh");
		expect(unlockRpIdOrder(true)).toEqual(["bramble.sh", undefined]);
	});

	it("tries the implicit rpID first otherwise, so existing security-key users keep one prompt", () => {
		setWebauthnRpId("bramble.sh");
		expect(unlockRpIdOrder(false)).toEqual([undefined, "bramble.sh"]);
	});

	it("never offers Firefox an rpID it is refused outright", () => {
		// Firefox rejects its own moz-extension:// origin as an RP with SecurityError - a hard
		// refusal, not a miss - so offering it is not a cheap wrong guess. It has no security keys
		// registered under an implicit rpID either, so there is nothing to lose by dropping it.
		setWebauthnRpId("bramble.sh", { implicitUsable: false });
		expect(unlockRpIdOrder(true)).toEqual(["bramble.sh"]);
		expect(unlockRpIdOrder(false)).toEqual(["bramble.sh"]);
	});

	it("still offers the implicit rpID where it works, for existing security keys", () => {
		setWebauthnRpId("bramble.sh", { implicitUsable: true });
		expect(unlockRpIdOrder(false)).toEqual([undefined, "bramble.sh"]);
	});

	it("falls back to the implicit rpID when no explicit one is installed", () => {
		// Otherwise a platform that installs nothing would be left with an empty candidate list
		// and could never unlock at all.
		setWebauthnRpId(undefined, { implicitUsable: false });
		expect(unlockRpIdOrder(true)).toEqual([undefined]);
	});

	it("never prompts twice for the same rpID when none is installed", () => {
		// Mobile and desktop install nothing; both entries would collapse to undefined.
		setWebauthnRpId(undefined);
		expect(unlockRpIdOrder(true)).toEqual([undefined]);
		expect(unlockRpIdOrder(false)).toEqual([undefined]);
	});
});

describe("unlocking across both rpIDs", () => {
	const ALLOW = [{ credentialId: new Uint8Array([9]) }];
	const SALT = new Uint8Array(32);
	const notAllowed = () => Object.assign(new Error(""), { name: "NotAllowedError" });

	/** get() that only answers for one rpID, as a real authenticator does. */
	function getForRpId(match: string | undefined) {
		return vi.fn(async (arg: { publicKey: { rpId?: string } }) => {
			if (arg.publicKey.rpId !== match) throw notAllowed();
			return credential({ prf: { results: { first: SECRET } } });
		});
	}

	it("falls through to the second rpID and reports which one worked", async () => {
		const get = getForRpId("bramble.sh");
		stubCredentials({ get });

		const r = await getPrfSecretAcrossRpIds(ALLOW, SALT, [undefined, "bramble.sh"]);
		expect(r.rpId).toBe("bramble.sh");
		expect(get).toHaveBeenCalledTimes(2);
	});

	it("stops at the first rpID that answers, so a single-kind vault costs one prompt", async () => {
		const get = getForRpId(undefined);
		stubCredentials({ get });

		const r = await getPrfSecretAcrossRpIds(ALLOW, SALT, [undefined, "bramble.sh"]);
		expect(r.rpId).toBeUndefined();
		expect(get).toHaveBeenCalledOnce();
	});

	it("does not blame the user for an intermediate miss", async () => {
		// The first rpID failing means "no credential here", not "you dismissed it". Surfacing
		// that would accuse the user of cancelling a prompt they are about to be shown.
		const get = getForRpId("bramble.sh");
		stubCredentials({ get });

		await getPrfSecretAcrossRpIds(ALLOW, SALT, [undefined, "bramble.sh"]);
		const firstCall = get.mock.calls[0]![0] as { publicKey: { rpId?: string } };
		expect(firstCall.publicKey.rpId).toBeUndefined();
	});

	it("reports the cross-browser message only once every rpID has been tried", async () => {
		const get = vi.fn(async () => {
			throw notAllowed();
		});
		stubCredentials({ get });

		await expect(getPrfSecretAcrossRpIds(ALLOW, SALT, [undefined, "bramble.sh"])).rejects.toThrow(
			/registered per browser/,
		);
		expect(get).toHaveBeenCalledTimes(2);
	});

	it("rethrows a real fault immediately instead of burning the second prompt on it", async () => {
		// A detached passkey proxy or a dead authenticator is not "wrong rpID"; retrying would
		// show a second doomed prompt and then hide the actual cause behind the generic message.
		const get = vi.fn(async () => {
			throw Object.assign(new Error("proxy detached"), { name: "InvalidStateError" });
		});
		stubCredentials({ get });

		await expect(getPrfSecretAcrossRpIds(ALLOW, SALT, [undefined, "bramble.sh"])).rejects.toThrow(
			/proxy detached/,
		);
		expect(get).toHaveBeenCalledOnce();
	});

	it("handles a single candidate, which is every non-extension platform", async () => {
		const get = getForRpId(undefined);
		stubCredentials({ get });

		const r = await getPrfSecretAcrossRpIds(ALLOW, SALT, [undefined]);
		expect(r.rpId).toBeUndefined();
	});
});

describe("whether webauthn unlock is offerable at all", () => {
	it("is off when no rpID is usable, so old Firefox hides instead of failing", () => {
		// Firefox refuses its own moz-extension:// origin as an RP, and only learned to claim one
		// from host_permissions in 150. The manifest supports 128+, so those users exist and would
		// otherwise get "The operation is insecure" on every tap. The shell installs no rpID there.
		setWebauthnRpId(undefined, { implicitUsable: false });
		expect(webauthnUnlockPossible()).toBe(false);
	});

	it("is on for Firefox 150+, which can claim the shared rpID", () => {
		setWebauthnRpId("bramble.sh", { implicitUsable: false });
		expect(webauthnUnlockPossible()).toBe(true);
	});

	it("is on for Chromium, whose implicit rpID works even with no explicit one", () => {
		setWebauthnRpId(undefined, { implicitUsable: true });
		expect(webauthnUnlockPossible()).toBe(true);
	});
});
