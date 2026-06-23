import { Capacitor, registerPlugin } from "@capacitor/core";
import type { AutofillAdapter } from "@core/index";
import { bytesToBase64 } from "@core/util/bytes";
import { decodeVaultBlob, findPasswordSlot, verifierPrefix } from "@core/vault-format";
import { mobileCrypto } from "./crypto";
import { mobileStorage } from "./storage";

// System autofill on mobile is the native iOS Credential Provider extension, not the
// webview. This adapter is the main-app side of that bridge. To keep Bramble's "nothing
// readable without authenticating" guarantee, the ENTIRE login list (names, usernames,
// passwords) is encrypted under the VEK before it is written to the shared App Group, so
// the extension reveals nothing until the user unlocks it. We also share the password
// SLOT (non-secret vault-header data: salt + verifier + the AES-wrapped VEK) so the
// extension can unlock itself with the master password. No cleartext entry data and no
// ASCredentialIdentityStore (which would leak usernames in QuickType before auth).
// Android autofill is a separate service (not built yet), so this is iOS-only.

interface SlotPayload {
	saltB64: string;
	slotIdB64: string;
	verifierB64: string;
	wrapIvB64: string;
	wrappedVekB64: string;
	magicVersionB64: string;
}

interface AutofillBridgePlugin {
	// `iv`/`ciphertext` are encryptWithVek over the JSON login list (see AutofillEntry).
	sync(o: { iv: string; ciphertext: string; slot?: SlotPayload }): Promise<void>;
	clear(): Promise<void>;
}

const Bridge = registerPlugin<AutofillBridgePlugin>("AutofillBridge");
const isIos = Capacitor.getPlatform() === "ios";

// The primary password slot from the vault header, so the extension can run Argon2id
// and unwrap the VEK from the master password. Non-secret (the wrappedVek stays
// AES-encrypted). Returns undefined for a passwordless vault or an unreadable blob.
async function readPasswordSlot(): Promise<SlotPayload | undefined> {
	try {
		const slot = findPasswordSlot(decodeVaultBlob(await mobileStorage.readVaultBlob()));
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
		for (const e of entries) {
			if (e.type !== "login" || !e.password) continue;
			list.push({
				recordId: e.id,
				name: e.name,
				username: e.username,
				password: e.password,
				services: e.hostnames,
			});
		}
		// Encrypt the whole list under the VEK. The extension can read no entry data
		// (names, usernames, passwords) until the user authenticates and it can decrypt
		// this. Nothing about the vault is in the App Group in cleartext.
		const enc = await mobileCrypto.encryptWithVek(JSON.stringify(list));
		await Bridge.sync({ iv: enc.iv, ciphertext: enc.ciphertext, slot: await readPasswordSlot() });
	},
	async clearIndex() {
		// Deliberately a no-op on iOS. The bundle is VEK-encrypted (unreadable at rest)
		// and must survive app lock so the provider can still unlock + fill on its own.
		// setIndex overwrites it when entries change.
	},
	async query() {
		// The in-webview UI never serves OS autofill; the native provider does.
		return { logins: [], cards: [], otps: [], locked: true, hasPotentialMatch: false };
	},
	async fetchFill() {
		throw new Error("system autofill is handled by the native iOS provider, not the webview");
	},
};
