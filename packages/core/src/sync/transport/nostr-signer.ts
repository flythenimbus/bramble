// Adapts the wasm BIP340 exports (base64) to nostr.ts's NostrSigner/Verifier
// (hex wire format). Each sync session uses a fresh ephemeral signing key.

import { base64ToHex, hexToBase64, hexToBytes } from "../../util/bytes";
import { sha256Hex } from "../../util/hash";
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

const HOSTED_RELAY_HOST = "bramble-relay.flythenimbus.workers.dev";

function isHostedRelay(relayUrl: string): boolean {
	try {
		return new URL(relayUrl).host === HOSTED_RELAY_HOST;
	} catch {
		return false;
	}
}

export async function makeNostr(wasm: NostrWasm, relayUrl: string): Promise<SignerPair> {
	const key = await wasm.nostr_generate_key();
	const pubkeyHex = base64ToHex(key.publicKey);
	const hosted = isHostedRelay(relayUrl);
	/** What to sign, then the other form a peer may have signed. See docs/p2p-sync.md. */
	const signedForms = async (idHex: string): Promise<[string, string]> => {
		const id = hexToBase64(idHex);
		const hashedId = hexToBase64(await sha256Hex(hexToBytes(idHex)));
		return hosted ? [hashedId, id] : [id, hashedId];
	};
	return {
		pubkeyHex,
		signer: {
			pubkeyHex,
			sign: async (idHex) => {
				const [form] = await signedForms(idHex);
				return base64ToHex(await wasm.nostr_sign(key.secretKey, form));
			},
		},
		verifier: {
			verify: async (pkHex, idHex, sigHex) => {
				const [first, second] = await signedForms(idHex);
				const pk = hexToBase64(pkHex);
				const sig = hexToBase64(sigHex);
				return (await wasm.nostr_verify(pk, first, sig)) || wasm.nostr_verify(pk, second, sig);
			},
		},
	};
}
