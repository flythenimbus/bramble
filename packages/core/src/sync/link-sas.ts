// The browser link's SAS: the emoji both the desktop app and the extension show while linking.
// Derived from the Noise XX handshake hash, which binds both static keys and both ephemerals, so a
// relaying attacker cannot make the two screens agree. See docs/desktop-link-onboarding.md.

import { base64ToBytes, bytesToBase64 } from "../util/bytes";
import { type PairingSas, sasFromBits } from "./pairing-sas";

const LINK_SAS_INFO = "bramble/link/sas/v1";
const LINK_SAS_INPUT = "bramble/link/sas-input/v1";

/**
 * What the link emoji derive from: the handshake hash and both sides' nonces. The browser commits
 * to its nonce before seeing the desktop's, so a relay in the middle cannot steer the two screens
 * to the same emoji. Must match `sas_material` in the desktop's socket.rs byte for byte.
 */
export async function linkSasMaterial(
	handshakeHashB64: string,
	desktopNonceB64: string,
	browserNonceB64: string,
): Promise<string> {
	const parts = [
		new TextEncoder().encode(LINK_SAS_INPUT),
		base64ToBytes(handshakeHashB64),
		base64ToBytes(desktopNonceB64),
		base64ToBytes(browserNonceB64),
	];
	const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		joined.set(p, at);
		at += p.length;
	}
	return bytesToBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", buf(joined))));
}

/** The browser's commitment to its nonce: SHA-256 of it, base64. */
export async function linkNonceCommit(nonceB64: string): Promise<string> {
	return bytesToBase64(
		new Uint8Array(await crypto.subtle.digest("SHA-256", buf(base64ToBytes(nonceB64)))),
	);
}

const buf = (b: Uint8Array): BufferSource => b as BufferSource;

export async function linkSas(materialB64: string): Promise<PairingSas> {
	const base = await crypto.subtle.importKey(
		"raw",
		buf(base64ToBytes(materialB64)),
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
