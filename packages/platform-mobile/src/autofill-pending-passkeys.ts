import { registerPlugin } from "@capacitor/core";
import type { PasskeyCredential } from "@core/hooks/useVault";
import { mobileCrypto } from "./adapters/crypto";

// The main-app side of the passkey REGISTRATION handoff. The native credential provider can
// mint a passkey but can't write the vault, so it stashes each new credential VEK-encrypted in
// the shared App Group (CredentialProviderViewController.stashPendingPasskey); here we drain
// and decrypt them once the vault is unlocked, and the app merges them in (planPasskeyPlacement).
// iOS only: Android's provider writes directly via its own handoff. See docs/passkey-provider.md.
interface PendingPasskeysPlugin {
	consumePendingPasskeys(): Promise<{ pending: { iv: string; ciphertext: string }[] }>;
}
const Bridge = registerPlugin<PendingPasskeysPlugin>("AutofillBridge");

/** Drain + decrypt passkeys the provider minted during sign-in registration (empty when none). */
export async function consumePendingPasskeys(): Promise<PasskeyCredential[]> {
	let pending: { iv: string; ciphertext: string }[];
	try {
		({ pending } = await Bridge.consumePendingPasskeys());
	} catch {
		return []; // method absent (old build) or nothing waiting
	}
	const out: PasskeyCredential[] = [];
	for (const e of pending ?? []) {
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
