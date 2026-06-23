import { Capacitor, registerPlugin } from "@capacitor/core";
import type { AutofillAdapter } from "@core/index";
import { mobileCrypto } from "./crypto";

// System autofill on mobile is the native iOS Credential Provider extension, not the
// webview. This adapter is the main-app side of that bridge: on unlock / every persist
// the core calls setIndex with the decrypted login index; we encrypt each password
// under the VEK and hand the OS provider (service, username, recordId) + the encrypted
// secret via the App Group + ASCredentialIdentityStore (AutofillBridge.swift). The
// extension reads the biometric-gated VEK and decrypts on selection — passwords are
// never written to the App Group in cleartext. Android autofill is a separate service
// (not built yet), so this is iOS-only; on other platforms it is inert.

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
	}): Promise<void>;
	clear(): Promise<void>;
}

const Bridge = registerPlugin<AutofillBridgePlugin>("AutofillBridge");
const isIos = Capacitor.getPlatform() === "ios";

export const mobileAutofill: AutofillAdapter = {
	async setIndex(entries) {
		if (!isIos) return;
		const credentials = [];
		for (const e of entries) {
			if (e.type !== "login" || !e.password) continue;
			// Encrypt under the loaded VEK; the extension AES-unwraps it after a Face ID
			// read of the shared-Keychain VEK (no Argon2id in the extension's memory cap).
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
		await Bridge.sync({ credentials });
	},
	async clearIndex() {
		// Deliberately a no-op on iOS. The autofill bundle holds only VEK-encrypted
		// secrets (safe at rest), and it must survive app lock so the credential
		// provider can still fill while the app is locked (it reads the biometric-gated
		// VEK itself). setIndex overwrites or empties the bundle when entries change.
	},
	async query() {
		// The in-webview UI never serves OS autofill; the native provider does.
		return { logins: [], cards: [], otps: [], locked: true, hasPotentialMatch: false };
	},
	async fetchFill() {
		throw new Error("system autofill is handled by the native iOS provider, not the webview");
	},
};
