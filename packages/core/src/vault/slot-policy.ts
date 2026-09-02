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
import type { WebauthnKeyKind } from "./webauthn-ceremony";

// Pure slot-mutation policy for unlock methods.
// Invariant B: a vault must always keep at least one primary unlock method
// (password or security key); recovery codes are backups only.

function uint8Equal(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

// recovery codes are not a primary unlock method (invariant B)
function isPrimaryUnlock(slot: Slot): boolean {
	return slot.kind === SLOT_KIND_PASSWORD || slot.kind === SLOT_KIND_WEBAUTHN;
}

function withSlotLimit(blob: VaultBlob): VaultBlob {
	if (blob.slots.length > MAX_SLOTS) {
		throw new Error(`This vault already has the maximum number of slots (${MAX_SLOTS}).`);
	}
	return blob;
}

/** Find the registered slot the user tapped, by matching the authenticator `rawId`. */
export function matchSlotByCredentialId(
	slots: WebauthnSlot[],
	rawId: Uint8Array,
): WebauthnSlot | null {
	return slots.find((s) => uint8Equal(s.credentialId, rawId)) ?? null;
}

/** True if the tapped key's salt differs from the one used in the first get(), needing a retry. */
export function needsSaltMismatchRetry(
	usedSlot: WebauthnSlot,
	saltUsedInFirstCall: Uint8Array,
): boolean {
	return !uint8Equal(usedSlot.salt, saltUsedInFirstCall);
}

/** Append a security-key slot. Refuses at the slot ceiling. */
/** Local, non-secret display data for a slot. Kept out of the vault file. */
export interface StoredKeyLabel {
	label: string;
	addedAt: number;
	kind?: WebauthnKeyKind;
	synced?: boolean;
}

export interface WebauthnKeyMeta {
	slotIdB64: string;
	label: string;
	addedAt: number;
	kind: WebauthnKeyKind;
	synced: boolean;
}

/**
 * Pair each webauthn slot with its locally stored label.
 *
 * Two sources of missing data, both normal and neither an error: entries written before the
 * platform path existed carry no `kind`, and a slot registered on ANOTHER device has no local
 * entry at all, because labels never travel with the vault file. Both fall back to the only
 * kind that used to exist, so an unknown slot reads as a security key rather than claiming to
 * be a synced platform credential it might not be.
 */
export function describeWebauthnKeys(
	slots: { slotId: Uint8Array }[],
	labels: Record<string, StoredKeyLabel>,
	toB64: (b: Uint8Array) => string,
): WebauthnKeyMeta[] {
	return slots.map((slot) => {
		const slotIdB64 = toB64(slot.slotId);
		const meta = labels[slotIdB64];
		return {
			slotIdB64,
			label: meta?.label ?? "Security key",
			addedAt: meta?.addedAt ?? 0,
			kind: meta?.kind ?? "securityKey",
			synced: meta?.synced ?? false,
		};
	});
}

export function addWebauthnSlot(blob: VaultBlob, slot: WebauthnSlot): VaultBlob {
	return withSlotLimit({ ...blob, slots: [...blob.slots, slot] });
}

/** Remove a security-key slot by slotId. Refuses if absent or if it would leave no primary unlock method. */
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

/** Add or re-wrap the password slot (covers first-time enable and password change). */
export function upsertPasswordSlot(blob: VaultBlob, slot: PasswordSlot): VaultBlob {
	const others = blob.slots.filter((s) => s.kind !== SLOT_KIND_PASSWORD);
	return withSlotLimit({ ...blob, slots: [...others, slot] });
}

/** Remove the password slot. Refuses if absent or if it would leave no primary unlock method (invariant B). */
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

/** Add or replace the recovery slot (a vault holds at most one). */
export function upsertRecoverySlot(blob: VaultBlob, slot: RecoverySlot): VaultBlob {
	const others = blob.slots.filter((s) => s.kind !== SLOT_KIND_RECOVERY);
	return withSlotLimit({ ...blob, slots: [...others, slot] });
}
