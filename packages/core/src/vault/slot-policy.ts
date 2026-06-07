import {
	MAX_SLOTS,
	type PasswordSlot,
	type RecoverySlot,
	SLOT_KIND_PASSWORD,
	SLOT_KIND_RECOVERY,
	SLOT_KIND_WEBAUTHN,
	type Slot,
	type VaultBlob,
	type WebauthnSlot,
} from "../vault-format";

//

function uint8Equal(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

function isPrimaryUnlock(slot: Slot): boolean {
	return slot.kind === SLOT_KIND_PASSWORD || slot.kind === SLOT_KIND_WEBAUTHN;
}

function withSlotLimit(blob: VaultBlob): VaultBlob {
	if (blob.slots.length > MAX_SLOTS) {
		throw new Error(`This vault already has the maximum number of slots (${MAX_SLOTS}).`);
	}
	return blob;
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

export function addWebauthnSlot(blob: VaultBlob, slot: WebauthnSlot): VaultBlob {
	return withSlotLimit({ ...blob, slots: [...blob.slots, slot] });
}

export function removeWebauthnSlot(blob: VaultBlob, slotId: Uint8Array): VaultBlob {
	const filtered = blob.slots.filter(
		(s) => !(s.kind === SLOT_KIND_WEBAUTHN && uint8Equal((s as WebauthnSlot).slotId, slotId)),
	);
	if (filtered.length === blob.slots.length) {
		throw new Error("Security key not found on this vault.");
	}
	if (!filtered.some(isPrimaryUnlock)) {
		throw new Error(
			"Can't remove the last unlock method. Register another security key or set a master password first.",
		);
	}
	return { ...blob, slots: filtered };
}


export function upsertPasswordSlot(blob: VaultBlob, slot: PasswordSlot): VaultBlob {
	const others = blob.slots.filter((s) => s.kind !== SLOT_KIND_PASSWORD);
	return withSlotLimit({ ...blob, slots: [...others, slot] });
}

export function removePasswordSlot(blob: VaultBlob): VaultBlob {
	if (!blob.slots.some((s) => s.kind === SLOT_KIND_PASSWORD)) {
		throw new Error("This vault has no master password to disable.");
	}
	const filtered = blob.slots.filter((s) => s.kind !== SLOT_KIND_PASSWORD);
	if (!filtered.some(isPrimaryUnlock)) {
		throw new Error(
			"Can't disable the master password. Register a security key first so you can still unlock.",
		);
	}
	return { ...blob, slots: filtered };
}


export function upsertRecoverySlot(blob: VaultBlob, slot: RecoverySlot): VaultBlob {
	const others = blob.slots.filter((s) => s.kind !== SLOT_KIND_RECOVERY);
	return withSlotLimit({ ...blob, slots: [...others, slot] });
}
