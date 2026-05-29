import {
	MAX_SLOTS,
	SLOT_KIND_PASSWORD,
	SLOT_KIND_WEBAUTHN,
	type Slot,
	type VaultBlob,
	type WebauthnSlot,
} from "../vault-format";

// Pure helpers that drive `useVault.registerSecurityKey` and `revokeSecurityKey`.
// Extracted so the slot-mutation policy (last-unlock-method guard, salt-
// mismatch retry decision, append/remove invariants) can be unit-tested
// without rendering React or mocking adapters.

function uint8Equal(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

export function matchSlotByCredentialId(
	slots: WebauthnSlot[],
	rawId: Uint8Array,
): WebauthnSlot | null {
	return slots.find((s) => uint8Equal(s.credentialId, rawId)) ?? null;
}

export function needsSaltMismatchRetry(
	usedSlot: WebauthnSlot,
	saltUsedInFirstCall: Uint8Array,
): boolean {
	return !uint8Equal(usedSlot.salt, saltUsedInFirstCall);
}

// Append a webauthn slot to the blob (immutable). Refuses when the vault
// has hit the on-disk slot ceiling.
export function addWebauthnSlot(blob: VaultBlob, slot: WebauthnSlot): VaultBlob {
	if (blob.slots.length >= MAX_SLOTS) {
		throw new Error(`This vault already has the maximum number of slots (${MAX_SLOTS}).`);
	}
	return { ...blob, slots: [...blob.slots, slot] };
}

// A slot is "usable for unlock" only when this client can decrypt against it.
// Password and webauthn qualify; opaque (recovery / unknown future kinds) do
// not — they exist in the format but no unlock path serves them yet.
function isUnlockable(slot: Slot): boolean {
	return slot.kind === SLOT_KIND_PASSWORD || slot.kind === SLOT_KIND_WEBAUTHN;
}

//   - removing it would leave the vault with no usable unlock mechanism
//     (no password slot and no other webauthn slot).
// The opt-out behavior preserves user safety: someone who only registered
// security keys must register another one (or set a master password) before
// they can revoke the last one.
export function removeWebauthnSlot(blob: VaultBlob, slotId: Uint8Array): VaultBlob {
	const filtered = blob.slots.filter(
		(s) => !(s.kind === SLOT_KIND_WEBAUTHN && uint8Equal((s as WebauthnSlot).slotId, slotId)),
	);
	if (filtered.length === blob.slots.length) {
		throw new Error("Security key not found on this vault.");
	}
	if (!filtered.some(isUnlockable)) {
		throw new Error(
			"Can't remove the last unlock method — register another security key or set a master password first.",
		);
	}
	return { ...blob, slots: filtered };
}
