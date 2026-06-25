// Adapts the wasm BIP340 exports (base64) to nostr.ts's NostrSigner/Verifier
// (hex wire format). Each sync session uses a fresh ephemeral signing key.

import { base64ToHex, hexToBase64 } from "../../util/bytes";
import type { NostrSigner, NostrVerifier } from "..";
import type { Awaitable } from "./handshake";

/** The wasm nostr exports. nostr_generate_key returns camelCase (#[serde(rename_all)]).
 * Returns are Awaitable so the native plugin (async bridge) satisfies the same shape. */
export interface NostrWasm {
	nostr_generate_key(): Awaitable<{ secretKey: string; publicKey: string }>;
	nostr_sign(secretB64: string, hashB64: string): Awaitable<string>;
	nostr_verify(publicB64: string, hashB64: string, sigB64: string): Awaitable<boolean>;
}

export interface SignerPair {
	signer: NostrSigner;
	verifier: NostrVerifier;
	pubkeyHex: string;
}

export async function makeNostr(wasm: NostrWasm): Promise<SignerPair> {
	const key = await wasm.nostr_generate_key();
	const pubkeyHex = base64ToHex(key.publicKey);
	return {
		pubkeyHex,
		signer: {
			pubkeyHex,
			sign: async (idHex) => base64ToHex(await wasm.nostr_sign(key.secretKey, hexToBase64(idHex))),
		},
		verifier: {
			verify: async (pkHex, idHex, sigHex) =>
				wasm.nostr_verify(hexToBase64(pkHex), hexToBase64(idHex), hexToBase64(sigHex)),
		},
	};
}
