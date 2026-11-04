// The browser link's SAS: the emoji both the desktop app and the extension show while linking.
// Derived from the Noise XX handshake hash, which binds both static keys and both ephemerals, so a
// relaying attacker cannot make the two screens agree. See docs/desktop-link-onboarding.md.

import { base64ToBytes } from "../util/bytes";
import { type PairingSas, sasFromBits } from "./pairing-sas";

const LINK_SAS_INFO = "bramble/link/sas/v1";

const buf = (b: Uint8Array): BufferSource => b as BufferSource;

export async function linkSas(handshakeHashB64: string): Promise<PairingSas> {
	const base = await crypto.subtle.importKey(
		"raw",
		buf(base64ToBytes(handshakeHashB64)),
		"HKDF",
		false,
		["deriveBits"],
	);
	const bits = await crypto.subtle.deriveBits(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: buf(new Uint8Array()),
			info: buf(new TextEncoder().encode(LINK_SAS_INFO)),
		},
		base,
		64,
	);
	return sasFromBits(new Uint8Array(bits));
}
