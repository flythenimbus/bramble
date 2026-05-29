//
//
//
//

export const MAGIC = new Uint8Array([0x56, 0x4c, 0x54, 0x31]);
export const VERSION = 0x02;
export const MAX_SLOTS = 16;

export const LEN_IV = 12;
export const LEN_SALT = 16;
export const LEN_VERIFIER = 32;
export const LEN_SLOT_ID = 16;
export const LEN_WRAP_IV = 12;
// 32-byte VEK + 16-byte GCM tag.
export const LEN_WRAPPED_VEK = 48;
// WebAuthn `hmac-secret` requires a 32-byte salt (CTAP2 spec).
export const LEN_HMAC_SECRET_SALT = 32;

export const SLOT_KIND_PASSWORD = 0x01;
export const SLOT_KIND_WEBAUTHN = 0x02;
export const SLOT_KIND_RECOVERY = 0x03;

const HEADER_FIXED_LEN = MAGIC.length + 1 + 1; // magic + version + slotCount
const TLV_PREFIX_LEN = 1 + 2; // kind + len

export interface PasswordSlot {
	kind: typeof SLOT_KIND_PASSWORD;
	slotId: Uint8Array; // 16 bytes
	salt: Uint8Array; // 16 bytes (Argon2id salt)
	verifier: Uint8Array; // 32 bytes (HMAC-SHA256(KEK, magic||version||slotId))
	wrapIv: Uint8Array; // 12 bytes
	wrappedVek: Uint8Array; // 48 bytes (32-byte VEK + GCM tag)
}

export interface WebauthnSlot {
	kind: typeof SLOT_KIND_WEBAUTHN;
	slotId: Uint8Array; // 16 bytes
	credentialId: Uint8Array; // variable
	salt: Uint8Array; // 32 bytes (hmac-secret salt)
	verifier: Uint8Array; // 32 bytes
	wrapIv: Uint8Array; // 12 bytes
	wrappedVek: Uint8Array; // 48 bytes
}

export interface OpaqueSlot {
	kind: number;
	payload: Uint8Array;
}

export type Slot = PasswordSlot | WebauthnSlot | OpaqueSlot;

export interface EncryptedEntry {
	id: string;
	wrappedDek: string;
	dekIv: string;
	ciphertext: string;
	iv: string;
}

export interface VaultBlob {
	slots: Slot[];
	entriesIv: Uint8Array;
	entriesCiphertext: Uint8Array;
}

export function verifierPrefix(): Uint8Array {
	const out = new Uint8Array(MAGIC.length + 1);
	out.set(MAGIC, 0);
	out[MAGIC.length] = VERSION;
	return out;
}

const PASSWORD_PAYLOAD_LEN = LEN_SLOT_ID + LEN_SALT + LEN_VERIFIER + LEN_WRAP_IV + LEN_WRAPPED_VEK;

function encodePasswordPayload(slot: PasswordSlot): Uint8Array {
	if (slot.slotId.length !== LEN_SLOT_ID) {
		throw new Error(`slotId must be ${LEN_SLOT_ID} bytes, got ${slot.slotId.length}`);
	}
	if (slot.salt.length !== LEN_SALT) {
		throw new Error(`salt must be ${LEN_SALT} bytes, got ${slot.salt.length}`);
	}
	if (slot.verifier.length !== LEN_VERIFIER) {
		throw new Error(`verifier must be ${LEN_VERIFIER} bytes, got ${slot.verifier.length}`);
	}
	if (slot.wrapIv.length !== LEN_WRAP_IV) {
		throw new Error(`wrapIv must be ${LEN_WRAP_IV} bytes, got ${slot.wrapIv.length}`);
	}
	if (slot.wrappedVek.length !== LEN_WRAPPED_VEK) {
		throw new Error(`wrappedVek must be ${LEN_WRAPPED_VEK} bytes, got ${slot.wrappedVek.length}`);
	}
	const out = new Uint8Array(PASSWORD_PAYLOAD_LEN);
	let off = 0;
	out.set(slot.slotId, off);
	off += LEN_SLOT_ID;
	out.set(slot.salt, off);
	off += LEN_SALT;
	out.set(slot.verifier, off);
	off += LEN_VERIFIER;
	out.set(slot.wrapIv, off);
	off += LEN_WRAP_IV;
	out.set(slot.wrappedVek, off);
	return out;
}

function decodePasswordPayload(payload: Uint8Array): PasswordSlot {
	if (payload.length !== PASSWORD_PAYLOAD_LEN) {
		throw new Error(
			`password slot payload must be ${PASSWORD_PAYLOAD_LEN} bytes, got ${payload.length}`,
		);
	}
	let off = 0;
	const slotId = payload.slice(off, off + LEN_SLOT_ID);
	off += LEN_SLOT_ID;
	const salt = payload.slice(off, off + LEN_SALT);
	off += LEN_SALT;
	const verifier = payload.slice(off, off + LEN_VERIFIER);
	off += LEN_VERIFIER;
	const wrapIv = payload.slice(off, off + LEN_WRAP_IV);
	off += LEN_WRAP_IV;
	const wrappedVek = payload.slice(off, off + LEN_WRAPPED_VEK);
	return {
		kind: SLOT_KIND_PASSWORD,
		slotId,
		salt,
		verifier,
		wrapIv,
		wrappedVek,
	};
}

const WEBAUTHN_FIXED_LEN =
	LEN_SLOT_ID + 2 + LEN_HMAC_SECRET_SALT + LEN_VERIFIER + LEN_WRAP_IV + LEN_WRAPPED_VEK;

function encodeWebauthnPayload(slot: WebauthnSlot): Uint8Array {
	if (slot.slotId.length !== LEN_SLOT_ID) {
		throw new Error(`slotId must be ${LEN_SLOT_ID} bytes, got ${slot.slotId.length}`);
	}
	if (slot.credentialId.length === 0 || slot.credentialId.length > 0xffff) {
		throw new Error(
			`credentialId length out of range: ${slot.credentialId.length} (need 1..65535)`,
		);
	}
	if (slot.salt.length !== LEN_HMAC_SECRET_SALT) {
		throw new Error(`salt must be ${LEN_HMAC_SECRET_SALT} bytes, got ${slot.salt.length}`);
	}
	if (slot.verifier.length !== LEN_VERIFIER) {
		throw new Error(`verifier must be ${LEN_VERIFIER} bytes, got ${slot.verifier.length}`);
	}
	if (slot.wrapIv.length !== LEN_WRAP_IV) {
		throw new Error(`wrapIv must be ${LEN_WRAP_IV} bytes, got ${slot.wrapIv.length}`);
	}
	if (slot.wrappedVek.length !== LEN_WRAPPED_VEK) {
		throw new Error(`wrappedVek must be ${LEN_WRAPPED_VEK} bytes, got ${slot.wrappedVek.length}`);
	}
	const out = new Uint8Array(WEBAUTHN_FIXED_LEN + slot.credentialId.length);
	let off = 0;
	out.set(slot.slotId, off);
	off += LEN_SLOT_ID;
	out[off++] = (slot.credentialId.length >> 8) & 0xff;
	out[off++] = slot.credentialId.length & 0xff;
	out.set(slot.credentialId, off);
	off += slot.credentialId.length;
	out.set(slot.salt, off);
	off += LEN_HMAC_SECRET_SALT;
	out.set(slot.verifier, off);
	off += LEN_VERIFIER;
	out.set(slot.wrapIv, off);
	off += LEN_WRAP_IV;
	out.set(slot.wrappedVek, off);
	return out;
}

function decodeWebauthnPayload(payload: Uint8Array): WebauthnSlot {
	if (payload.length < WEBAUTHN_FIXED_LEN + 1) {
		throw new Error(
			`webauthn slot payload too short: ${payload.length} (need at least ${WEBAUTHN_FIXED_LEN + 1})`,
		);
	}
	let off = 0;
	const slotId = payload.slice(off, off + LEN_SLOT_ID);
	off += LEN_SLOT_ID;
	const credIdLen = ((payload[off]! << 8) | payload[off + 1]!) & 0xffff;
	off += 2;
	if (credIdLen === 0) throw new Error("webauthn credentialId length is zero");
	if (
		off + credIdLen + LEN_HMAC_SECRET_SALT + LEN_VERIFIER + LEN_WRAP_IV + LEN_WRAPPED_VEK !==
		payload.length
	) {
		throw new Error(`webauthn slot payload length mismatch (credIdLen=${credIdLen})`);
	}
	const credentialId = payload.slice(off, off + credIdLen);
	off += credIdLen;
	const salt = payload.slice(off, off + LEN_HMAC_SECRET_SALT);
	off += LEN_HMAC_SECRET_SALT;
	const verifier = payload.slice(off, off + LEN_VERIFIER);
	off += LEN_VERIFIER;
	const wrapIv = payload.slice(off, off + LEN_WRAP_IV);
	off += LEN_WRAP_IV;
	const wrappedVek = payload.slice(off, off + LEN_WRAPPED_VEK);
	return {
		kind: SLOT_KIND_WEBAUTHN,
		slotId,
		credentialId,
		salt,
		verifier,
		wrapIv,
		wrappedVek,
	};
}

function encodeSlotPayload(slot: Slot): Uint8Array {
	if (slot.kind === SLOT_KIND_PASSWORD) {
		return encodePasswordPayload(slot as PasswordSlot);
	}
	if (slot.kind === SLOT_KIND_WEBAUTHN) {
		return encodeWebauthnPayload(slot as WebauthnSlot);
	}
	return (slot as OpaqueSlot).payload;
}

function decodeSlotPayload(kind: number, payload: Uint8Array): Slot {
	if (kind === SLOT_KIND_PASSWORD) {
		return decodePasswordPayload(payload);
	}
	if (kind === SLOT_KIND_WEBAUTHN) {
		return decodeWebauthnPayload(payload);
	}
	return { kind, payload };
}

export function encodeVaultBlob(blob: VaultBlob): Uint8Array {
	if (blob.slots.length === 0) {
		throw new Error("vault must have at least one slot");
	}
	if (blob.slots.length > MAX_SLOTS) {
		throw new Error(`vault has ${blob.slots.length} slots (max ${MAX_SLOTS})`);
	}
	if (blob.entriesIv.length !== LEN_IV) {
		throw new Error(`entriesIv must be ${LEN_IV} bytes, got ${blob.entriesIv.length}`);
	}

	const slotPayloads = blob.slots.map(encodeSlotPayload);
	let totalSlotsLen = 0;
	for (const payload of slotPayloads) {
		if (payload.length > 0xffff) {
			throw new Error(`slot payload too large (${payload.length} bytes, max 65535)`);
		}
		totalSlotsLen += TLV_PREFIX_LEN + payload.length;
	}

	const out = new Uint8Array(
		HEADER_FIXED_LEN + totalSlotsLen + LEN_IV + blob.entriesCiphertext.length,
	);
	let off = 0;
	out.set(MAGIC, off);
	off += MAGIC.length;
	out[off++] = VERSION;
	out[off++] = blob.slots.length;
	for (let i = 0; i < blob.slots.length; i++) {
		const slot = blob.slots[i]!;
		const payload = slotPayloads[i]!;
		out[off++] = slot.kind;
		out[off++] = (payload.length >> 8) & 0xff;
		out[off++] = payload.length & 0xff;
		out.set(payload, off);
		off += payload.length;
	}
	out.set(blob.entriesIv, off);
	off += LEN_IV;
	out.set(blob.entriesCiphertext, off);
	return out;
}

export function decodeVaultBlob(bytes: Uint8Array): VaultBlob {
	if (bytes.length < HEADER_FIXED_LEN) {
		throw new Error(
			`vault blob too short: ${bytes.length} bytes (need at least ${HEADER_FIXED_LEN})`,
		);
	}

	for (let i = 0; i < MAGIC.length; i++) {
		if (bytes[i] !== MAGIC[i]) {
			throw new Error("invalid vault magic bytes (not a VLT1 file)");
		}
	}

	const version = bytes[MAGIC.length];
	if (version !== VERSION) {
		throw new Error(`unsupported vault version: ${version} (expected ${VERSION})`);
	}

	const slotCount = bytes[MAGIC.length + 1]!;
	if (slotCount === 0) {
		throw new Error("vault has no slots");
	}
	if (slotCount > MAX_SLOTS) {
		throw new Error(`vault has ${slotCount} slots (max ${MAX_SLOTS})`);
	}

	const slots: Slot[] = [];
	let off = HEADER_FIXED_LEN;
	for (let i = 0; i < slotCount; i++) {
		if (off + TLV_PREFIX_LEN > bytes.length) {
			throw new Error(`slot ${i} truncated (header overruns blob)`);
		}
		const kind = bytes[off++]!;
		const len = ((bytes[off]! << 8) | bytes[off + 1]!) & 0xffff;
		off += 2;
		if (off + len > bytes.length) {
			throw new Error(`slot ${i} truncated (payload overruns blob)`);
		}
		const payload = bytes.slice(off, off + len);
		off += len;
		slots.push(decodeSlotPayload(kind, payload));
	}

	if (off + LEN_IV > bytes.length) {
		throw new Error("vault blob truncated (entries IV overruns blob)");
	}
	const entriesIv = bytes.slice(off, off + LEN_IV);
	off += LEN_IV;
	const entriesCiphertext = bytes.slice(off);

	return { slots, entriesIv, entriesCiphertext };
}

export function findPasswordSlot(blob: VaultBlob): PasswordSlot | null {
	for (const slot of blob.slots) {
		if (slot.kind === SLOT_KIND_PASSWORD) return slot as PasswordSlot;
	}
	return null;
}

export function findWebauthnSlots(blob: VaultBlob): WebauthnSlot[] {
	const out: WebauthnSlot[] = [];
	for (const slot of blob.slots) {
		if (slot.kind === SLOT_KIND_WEBAUTHN) out.push(slot as WebauthnSlot);
	}
	return out;
}
