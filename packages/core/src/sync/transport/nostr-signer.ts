// Adapts the wasm BIP340 exports (base64) to nostr.ts's NostrSigner/Verifier
// (hex wire format). Each sync session uses a fresh ephemeral signing key.

import { base64ToHex, hexToBase64 } from "../../util/bytes";
import type { NostrSigner, NostrVerifier } from "..";

/** The wasm nostr exports. nostr_generate_key returns camelCase (#[serde(rename_all)]). */
export interface NostrWasm {
	nostr_generate_key(): { secretKey: string; publicKey: string };
	nostr_sign(secretB64: string, hashB64: string): string;
	nostr_verify(publicB64: string, hashB64: string, sigB64: string): boolean;
}

export interface SignerPair {
	signer: NostrSigner;
	verifier: NostrVerifier;
	pubkeyHex: string;
}

export function makeNostr(wasm: NostrWasm): SignerPair {
	const key = wasm.nostr_generate_key();
	const pubkeyHex = base64ToHex(key.publicKey);
	return {
		pubkeyHex,
		signer: {
			pubkeyHex,
			sign: (idHex) =>
				Promise.resolve(base64ToHex(wasm.nostr_sign(key.secretKey, hexToBase64(idHex)))),
		},
		verifier: {
			verify: (pkHex, idHex, sigHex) =>
				Promise.resolve(
					wasm.nostr_verify(hexToBase64(pkHex), hexToBase64(idHex), hexToBase64(sigHex)),
				),
		},
	};
}
