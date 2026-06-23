import { Capacitor, registerPlugin } from "@capacitor/core";
import type { AutofillAdapter } from "@core/index";
import { bytesToBase64 } from "@core/util/bytes";
import { decodeVaultBlob, findPasswordSlot, verifierPrefix } from "@core/vault-format";
import { mobileCrypto } from "./crypto";
import { mobileStorage } from "./storage";

// System autofill on mobile is the native iOS Credential Provider extension, not the
// webview. This adapter is the main-app side of that bridge: on unlock / every persist
// the core calls setIndex with the decrypted login index; we encrypt each password
// under the VEK and hand the OS provider (name, service, username) + the encrypted
// secret via the App Group + ASCredentialIdentityStore (AutofillBridge.swift). We also
// share the password SLOT (non-secret vault-header data: salt + verifier + the
// AES-wrapped VEK) so the extension can unlock itself with the master password when no
// biometric/passcode-cached VEK is available — passwords are never written in cleartext.
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
	sync(o: {
		credentials: {
			recordId: string;
			name: string;
			username: string;
			iv: string;
			ciphertext: string;
			services: string[];
		}[];
		slot?: SlotPayload;
	}): Promise<void>;
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
		const credentials = [];
		for (const e of entries) {
			if (e.type !== "login" || !e.password) continue;
			// Encrypt under the loaded VEK; the extension AES-unwraps it once it has the
			// VEK (from the biometric/passcode cache, or by unlocking with the password).
			const enc = await mobileCrypto.encryptWithVek(e.password);
			credentials.push({
				recordId: e.id,
				name: e.name,
				username: e.username,
				iv: enc.iv,
				ciphertext: enc.ciphertext,
				services: e.hostnames,
			});
		}
		await Bridge.sync({ credentials, slot: await readPasswordSlot() });
	},
	async clearIndex() {
		// Deliberately a no-op on iOS. The autofill bundle holds only VEK-encrypted
		// secrets + the (non-secret) password slot, and it must survive app lock so the
		// credential provider can still fill while the app is locked (it unlocks itself
		// via biometric/passcode or the master password). setIndex overwrites it.
	},
	async query() {
		// The in-webview UI never serves OS autofill; the native provider does.
		return { logins: [], cards: [], otps: [], locked: true, hasPotentialMatch: false };
	},
	async fetchFill() {
		throw new Error("system autofill is handled by the native iOS provider, not the webview");
	},
};
