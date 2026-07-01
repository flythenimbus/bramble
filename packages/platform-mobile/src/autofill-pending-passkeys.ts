import { Capacitor, registerPlugin } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import type { PasskeyCredential } from "@core/hooks/useVault";
import { mobileCrypto } from "./adapters/crypto";

// The main-app side of the passkey REGISTRATION handoff. The native credential provider can mint a
// passkey but can't write the vault, so it stashes each new credential VEK-encrypted and the app
// drains + decrypts them once unlocked, then merges them in (core usePendingPasskeys ->
// planPasskeyPlacement). Two sources, same {iv, ciphertext} shape:
//   iOS     - the shared App Group, via AutofillBridge.consumePendingPasskeys
//   Android - an app-private file written by PendingPasskey.kt (Capacitor Directory.Data)
// See docs/passkey-provider.md.
interface PendingPasskeysPlugin {
	consumePendingPasskeys(): Promise<{ pending: { iv: string; ciphertext: string }[] }>;
}
const Bridge = registerPlugin<PendingPasskeysPlugin>("AutofillBridge");

const ANDROID_FILE = "autofill_pending_passkeys.json";

interface EncryptedPasskey {
	iv: string;
	ciphertext: string;
}

// Drain (and clear) the VEK-encrypted pending credentials from the right per-platform source.
async function drainEncrypted(): Promise<EncryptedPasskey[]> {
	if (Capacitor.getPlatform() === "ios") {
		try {
			return (await Bridge.consumePendingPasskeys()).pending ?? [];
		} catch {
			return []; // method absent (old build) or nothing waiting
		}
	}
	// Android: read + delete the app-private handoff file.
	try {
		await Filesystem.stat({ path: ANDROID_FILE, directory: Directory.Data });
	} catch {
		return []; // nothing waiting
	}
	try {
		const r = await Filesystem.readFile({
			path: ANDROID_FILE,
			directory: Directory.Data,
			encoding: Encoding.UTF8,
		});
		await Filesystem.deleteFile({ path: ANDROID_FILE, directory: Directory.Data }).catch(() => {});
		const arr = JSON.parse(r.data as string);
		return Array.isArray(arr) ? (arr as EncryptedPasskey[]) : [];
	} catch {
		// Corrupt/partial: drop it so it can't wedge every launch.
		await Filesystem.deleteFile({ path: ANDROID_FILE, directory: Directory.Data }).catch(() => {});
		return [];
	}
}

/** Drain + decrypt passkeys the provider minted during sign-in registration (empty when none). */
export async function consumePendingPasskeys(): Promise<PasskeyCredential[]> {
	const out: PasskeyCredential[] = [];
	for (const e of await drainEncrypted()) {
		try {
			out.push(
				JSON.parse(await mobileCrypto.decryptWithVek(e.iv, e.ciphertext)) as PasskeyCredential,
			);
		} catch {
			// Skip an entry we can't decrypt/parse rather than wedging the whole drain.
		}
	}
	return out;
}
