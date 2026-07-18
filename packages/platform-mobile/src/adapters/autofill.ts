import { Capacitor, registerPlugin } from "@capacitor/core";
import { Device } from "@capacitor/device";
import { PREF_AUTOFILL_QUICKTYPE } from "@core/hooks/usePrefs";
import type { AutofillAdapter } from "@core/index";
import { bytesToBase64 } from "@core/util/bytes";
import { decodeVaultBlob, findPasswordSlot, verifierPrefix } from "@core/vault-format";
import { ACTIVE_VAULT_KEY } from "../sync/sync-manager";
import { mobileCrypto } from "./crypto";
import { mobileStorage } from "./storage";

// System autofill on mobile is the native iOS Credential Provider extension, not the
// webview. This adapter is the main-app side of that bridge. To keep Bramble's "nothing
// readable without authenticating" guarantee, the ENTIRE login list (names, usernames,
// passwords) is encrypted under the VEK before it is written to the shared App Group, so
// the extension reveals nothing until the user unlocks it. We also share the password
// SLOT (non-secret vault-header data: salt + verifier + the AES-wrapped VEK) so the
// extension can unlock itself with the master password. No cleartext entry data reaches
// the App Group. The OS QuickType identity store (usernames + domains, no passwords) is
// populated ONLY when the user opts into keyboard suggestions; off by default since those
// identities surface before auth. Android autofill is a separate service (not built yet).

interface SlotPayload {
	saltB64: string;
	slotIdB64: string;
	verifierB64: string;
	wrapIvB64: string;
	wrappedVekB64: string;
	magicVersionB64: string;
}

// A QuickType identity (cleartext): what the OS shows in the keyboard suggestion bar.
// Sent only when the user opts into QuickType; carries no password.
interface QuickTypeIdentity {
	recordId: string;
	username: string;
	service: string;
}

// A passkey identity registered with the OS so it offers Bramble for that site's passkey
// sign-in. All fields are non-secret metadata (the private key never leaves the encrypted
// bundle); `credentialId`/`userHandle` are STANDARD base64 (as stored, what the OS wants
// as Data). Unlike QuickType this is not opt-in: the OS cannot route a passkey get() to a
// provider whose identities it doesn't know, so registering them is required for passkeys.
interface PasskeyIdentity {
	credentialId: string;
	rpId: string;
	userName: string;
	userHandle: string;
}

// One stored passkey inside the (VEK-encrypted) passkey bundle the extension decrypts to
// assert. `privateKey` is the only secret; everything is STANDARD base64 (as stored), which
// the native side and the Rust core both consume verbatim.
interface StoredPasskey extends PasskeyIdentity {
	privateKey: string;
}

interface AutofillBridgePlugin {
	// `iv`/`ciphertext` are encryptWithVek over the JSON login list (see AutofillEntry).
	// `identities`, when present and non-empty, populate the OS QuickType bar; an empty
	// (or omitted) list clears it. `passkeyIv`/`passkeyCiphertext` are encryptWithVek over
	// the JSON passkey list; `passkeyIdentities` register them with the OS credential store.
	sync(o: {
		iv: string;
		ciphertext: string;
		slot?: SlotPayload;
		identities?: QuickTypeIdentity[];
		passkeyIv?: string;
		passkeyCiphertext?: string;
		passkeyIdentities?: PasskeyIdentity[];
	}): Promise<void>;
	clear(): Promise<void>;
	setKeepUnlocked(o: { minutes: number }): Promise<void>;
}

// Normalize a stored hostname to a bare registrable host for QuickType matching
// (lowercase, drop a leading "www."), mirroring the extension's normalizeHost.
function normalizeHost(h: string): string {
	const s = h.trim().toLowerCase();
	return s.startsWith("www.") ? s.slice(4) : s;
}

const Bridge = registerPlugin<AutofillBridgePlugin>("AutofillBridge");
const isIos = Capacitor.getPlatform() === "ios";

// The password slot from the ACTIVE vault's header, so the extension can run Argon2id and
// unwrap the VEK from the master password. Must be the active vault: setIndex pushes the
// active vault's entries (encrypted under its VEK), so the slot the extension derives the
// VEK from has to belong to the same vault, else master-password unlock yields the wrong
// VEK and can't decrypt the bundle. (readVaultBlob(undefined) falls back to the first/only
// vault, matching sync-manager's activeVaultId.) Non-secret (the wrappedVek stays
// AES-encrypted). Returns undefined for a passwordless vault or an unreadable blob.
async function readPasswordSlot(): Promise<SlotPayload | undefined> {
	try {
		const activeId = await mobileStorage.getMeta<string>(ACTIVE_VAULT_KEY);
		const slot = findPasswordSlot(decodeVaultBlob(await mobileStorage.readVaultBlob(activeId)));
		if (!slot) return undefined;
		return {
			saltB64: bytesToBase64(slot.salt),
			slotIdB64: bytesToBase64(slot.slotId),
			verifierB64: bytesToBase64(slot.verifier),
			wrapIvB64: bytesToBase64(slot.wrapIv),
			wrappedVekB64: bytesToBase64(slot.wrappedVek),
			magicVersionB64: bytesToBase64(verifierPrefix()),
		};
	} catch {
		return undefined;
	}
}

export const mobileAutofill: AutofillAdapter = {
	async setIndex(entries) {
		if (!isIos) return;
		const list = [];
		const passkeys: StoredPasskey[] = [];
		for (const e of entries) {
			if (e.type !== "login") continue;
			if (e.password) {
				list.push({
					recordId: e.id,
					name: e.name,
					username: e.username,
					password: e.password,
					services: e.hostnames,
				});
			}
			// A login can hold passkeys even with no password (a passkey-only account).
			for (const p of e.passkeys ?? []) {
				passkeys.push({
					credentialId: p.credentialId,
					rpId: p.rpId,
					userName: p.userName ?? "",
					userHandle: p.userHandle,
					privateKey: p.privateKey,
				});
			}
		}
		// Encrypt the whole list under the VEK. The extension can read no entry data
		// (names, usernames, passwords) until the user authenticates and it can decrypt
		// this. Nothing about the vault is in the App Group in cleartext.
		const enc = await mobileCrypto.encryptWithVek(JSON.stringify(list));
		// Passkeys ride a second VEK-encrypted blob (private keys never at rest in clear).
		const encPk = await mobileCrypto.encryptWithVek(JSON.stringify(passkeys));
		// QuickType identities (cleartext usernames + domains) are sent ONLY when the user
		// opted in; otherwise the list is empty and the bridge clears the OS store.
		const quickType = (await mobileStorage.getMeta<boolean>(PREF_AUTOFILL_QUICKTYPE)) === true;
		const identities: QuickTypeIdentity[] = quickType
			? list.flatMap((c) =>
					c.username
						? c.services
								.map(normalizeHost)
								.filter((s) => s.length > 0)
								.map((service) => ({ recordId: c.recordId, username: c.username, service }))
						: [],
				)
			: [];
		// Passkey identities are NOT gated on QuickType: the OS can't route a passkey
		// sign-in to a provider whose credentials it hasn't been told about. Metadata only.
		const passkeyIdentities: PasskeyIdentity[] = passkeys.map((p) => ({
			credentialId: p.credentialId,
			rpId: p.rpId,
			userName: p.userName,
			userHandle: p.userHandle,
		}));
		await Bridge.sync({
			iv: enc.iv,
			ciphertext: enc.ciphertext,
			slot: await readPasswordSlot(),
			identities,
			passkeyIv: encPk.iv,
			passkeyCiphertext: encPk.ciphertext,
			passkeyIdentities,
		});
	},
	async clearIndex() {
		// Deliberately a no-op on iOS. The bundle is VEK-encrypted (unreadable at rest)
		// and must survive app lock so the provider can still unlock + fill on its own.
		// setIndex overwrites it when entries change.
	},
	async setKeepUnlocked(minutes) {
		// How long the autofill extension may stay unlocked without re-auth. minutes=0
		// disables it and clears any live session. iOS-only.
		if (!isIos) return;
		await Bridge.setKeepUnlocked({ minutes });
	},
	async inlineSuggestionsAvailable() {
		// Show the "Keyboard suggestions" toggle wherever the OS can render inline autofill: always on
		// iOS (QuickType), and on Android 11+ (API 30, where the inline API exists). We no longer gate
		// it on a runtime keyboard probe - that hid the toggle until you'd autofilled once, and stayed
		// hidden if the probe missed the keyboard's request (github #19). If the active keyboard can't
		// render inline the toggle is simply inert, which is far better than being undiscoverable.
		if (isIos) return true;
		try {
			return ((await Device.getInfo()).androidSDKVersion ?? 0) >= 30;
		} catch {
			return true;
		}
	},
	async query() {
		// The in-webview UI never serves OS autofill; the native provider does.
		return { logins: [], cards: [], otps: [], locked: true, hasPotentialMatch: false };
	},
	async fetchFill() {
		throw new Error("system autofill is handled by the native iOS provider, not the webview");
	},
};
