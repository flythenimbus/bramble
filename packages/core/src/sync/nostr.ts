// Nostr signaling codec: build, sign, and verify the ephemeral events that carry
// WebRTC SDP/ICE between peers via a relay. The relay sees only ciphertext: the
// payload is encrypted under the group key and addressed by a room id derived
// from it. secp256k1 signing is injected (the wasm nostr_* exports), so this
// module is platform-free and testable. See docs/p2p-sync.md.

import { base64ToBytes, bytesToBase64, bytesToHex } from "../util/bytes";
import { sha256Hex } from "../util/hash";

const EPHEMERAL_KIND = 20000;
const ROOM_LABEL = "bramble/signal";
const ROOM_TAG = "d";

// Domain-separation contexts so the room-id MAC key and the signaling AES key are
// independent subkeys of the group key, never the same raw bytes fed to two
// primitives.
const ROOM_KDF_INFO = "bramble/room-id";
const SIGNAL_KDF_INFO = "bramble/signal-key";

export interface NostrEvent {
	id: string;
	pubkey: string;
	created_at: number;
	kind: number;
	tags: string[][];
	content: string;
	sig: string;
}

export interface NostrFilter {
	kinds?: number[];
	authors?: string[];
	[tag: `#${string}`]: string[] | undefined;
}

/** Signs the 32-byte event id with the group's Nostr key (schnorr, hex out). */
export interface NostrSigner {
	pubkeyHex: string;
	sign(eventIdHex: string): Promise<string>;
}

/** Verifies a schnorr signature over an event id. */
export interface NostrVerifier {
	verify(pubkeyHex: string, eventIdHex: string, sigHex: string): Promise<boolean>;
}

// crypto.subtle wants BufferSource; our Uint8Arrays are ArrayBufferLike-backed,
// which newer TS lib.dom types reject without a cast.
const buf = (b: Uint8Array): BufferSource => b as BufferSource;

/** Derive a 32-byte subkey from the group key via HKDF-SHA256 under a context info
 * string, so distinct uses (room id vs signaling) never share raw key bytes. */
async function deriveSubkey(groupKey: Uint8Array, info: string): Promise<Uint8Array> {
	const base = await crypto.subtle.importKey("raw", buf(groupKey), "HKDF", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: new Uint8Array(0),
			info: buf(new TextEncoder().encode(info)),
		},
		base,
		256,
	);
	return new Uint8Array(bits);
}

/** The NIP-01 canonical serialization an event id is the sha256 of. */
export function serializeForId(e: Omit<NostrEvent, "id" | "sig">): string {
	return JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]);
}

/** The event id: sha256 of the canonical serialization, lowercase hex. */
export function computeEventId(e: Omit<NostrEvent, "id" | "sig">): Promise<string> {
	return sha256Hex(new TextEncoder().encode(serializeForId(e)));
}

/** Room id = HMAC-SHA256(k_room, label[:epoch]), hex, where k_room is an HKDF subkey of
 * the group key. Unguessable without the group key. Distinct labels give distinct rooms so
 * enrollment and ongoing sync don't collide. Passing an epoch rotates the room over time so
 * a relay can't link a group's activity across epochs (see docs/firefox-port.md). */
export async function deriveRoomId(
	groupKey: Uint8Array,
	label = ROOM_LABEL,
	epoch?: number,
): Promise<string> {
	const macKey = await deriveSubkey(groupKey, ROOM_KDF_INFO);
	const key = await crypto.subtle.importKey(
		"raw",
		buf(macKey),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const message = epoch === undefined ? label : `${label}:${epoch}`;
	const mac = await crypto.subtle.sign("HMAC", key, buf(new TextEncoder().encode(message)));
	return bytesToHex(new Uint8Array(mac));
}

/** Encrypt a signaling payload under an HKDF signaling subkey of the group key
 * (AES-256-GCM); returns base64 iv||ct. */
export async function encryptSignal(groupKey: Uint8Array, plaintext: string): Promise<string> {
	const aesKey = await deriveSubkey(groupKey, SIGNAL_KDF_INFO);
	const key = await crypto.subtle.importKey("raw", buf(aesKey), "AES-GCM", false, ["encrypt"]);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv: buf(iv) },
			key,
			buf(new TextEncoder().encode(plaintext)),
		),
	);
	const packed = new Uint8Array(iv.length + ct.length);
	packed.set(iv);
	packed.set(ct, iv.length);
	return bytesToBase64(packed);
}

/** Decrypt a base64 iv||ct signaling payload under the signaling subkey of the group key. */
export async function decryptSignal(groupKey: Uint8Array, b64: string): Promise<string> {
	const packed = base64ToBytes(b64);
	const iv = packed.slice(0, 12);
	const ct = packed.slice(12);
	const aesKey = await deriveSubkey(groupKey, SIGNAL_KDF_INFO);
	const key = await crypto.subtle.importKey("raw", buf(aesKey), "AES-GCM", false, ["decrypt"]);
	const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(iv) }, key, buf(ct));
	return new TextDecoder().decode(pt);
}

/** Build a signed ephemeral signaling event carrying `content` to `room`. */
export async function buildSignalEvent(
	signer: NostrSigner,
	room: string,
	content: string,
	createdAt: number,
): Promise<NostrEvent> {
	const base = {
		pubkey: signer.pubkeyHex,
		created_at: createdAt,
		kind: EPHEMERAL_KIND,
		tags: [[ROOM_TAG, room]],
		content,
	};
	const id = await computeEventId(base);
	const sig = await signer.sign(id);
	return { ...base, id, sig };
}

/** Verify an event's id matches its contents and its signature is valid. */
export async function verifyEvent(verifier: NostrVerifier, e: NostrEvent): Promise<boolean> {
	if ((await computeEventId(e)) !== e.id) return false;
	return verifier.verify(e.pubkey, e.id, e.sig);
}

/** The REQ filter that subscribes to one or more rooms' signaling events (the relay
 * matches a multi-value tag filter, so current+previous epoch rooms ride one REQ). */
export function signalFilter(rooms: string | string[]): NostrFilter {
	return { kinds: [EPHEMERAL_KIND], [`#${ROOM_TAG}`]: Array.isArray(rooms) ? rooms : [rooms] };
}
