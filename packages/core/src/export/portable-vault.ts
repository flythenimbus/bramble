// Frame a sealed portable vault as a .bramble file, and take one apart again.
//
// The crypto lives in core-rust (`seal_portable_vault`), which returns the pieces rather
// than a finished file so the VLT1 container keeps exactly one implementation: the encode
// and decode below go through vault-format.ts, the same code the real vault uses. A reader
// therefore cannot tell a portable vault from any other .bramble, which is the point: the
// existing restore path already understands it.

import type { CryptoAdapter } from "../adapters/crypto";
import type { EntryData } from "../hooks/useVault";
import type { EntriesPayload } from "../sync";
import { base64ToBytes, bytesToBase64 } from "../util/bytes";
import {
	decodeVaultBlob,
	encodeVaultBlob,
	findPasswordSlot,
	SLOT_KIND_PASSWORD,
	verifierPrefix,
} from "../vault-format";
import type { PortableVaultBlob } from "../wasm";

/**
 * What a portable vault carries. Entries only: no stamps and no tombstones, because the
 * file is a snapshot to be merged into some other vault's history, not a sync participant.
 *
 * Ids are stripped, and that is load-bearing rather than tidiness. `importMany` builds each
 * entry as `{ id, ...data }` with a freshly minted id it has already stamped, so an `id` left
 * inside the data silently overwrites it and the entry arrives carrying a stamp that belongs
 * to a different id. The write then dies on "missing sync stamp for entry <id>". Ids are
 * vault-local anyway: the receiving vault mints its own.
 */
export interface PortableVaultPayload {
	entries: EntryData[];
}

/** Drop the vault-local id from an entry, leaving the content the file is meant to carry. */
function withoutId(entry: EntryData & { id?: string }): EntryData {
	const { id: _id, ...data } = entry;
	return data as EntryData;
}

/** Seal `entries` into .bramble bytes under a password chosen for the file. */
export async function sealPortableVaultFile(
	crypto: Pick<CryptoAdapter, "sealPortableVault">,
	// Takes entries WITH their ids, because that is what the vault holds, and strips them here
	// (see PortableVaultPayload). Narrowing this to EntryData would just move the strip to
	// every caller and invite one to forget.
	entries: readonly (EntryData & { id?: string })[],
	password: string,
): Promise<Uint8Array> {
	if (!crypto.sealPortableVault) throw new Error("Exporting a .bramble isn't available here.");
	const payload: PortableVaultPayload = { entries: entries.map(withoutId) };
	const sealed = await crypto.sealPortableVault({
		entriesJson: JSON.stringify(payload),
		password,
		magicVersion: verifierPrefix(),
	});
	return encodeVaultBlob({
		slots: [
			{
				kind: SLOT_KIND_PASSWORD,
				slotId: base64ToBytes(sealed.slotId),
				salt: base64ToBytes(sealed.salt),
				verifier: base64ToBytes(sealed.verifier),
				wrapIv: base64ToBytes(sealed.wrapIv),
				wrappedVek: base64ToBytes(sealed.wrappedVek),
			},
		],
		entriesIv: base64ToBytes(sealed.entriesIv),
		entriesCiphertext: base64ToBytes(sealed.entriesCiphertext),
	});
}

/** Split .bramble bytes into the pieces the core needs, or null if it isn't one. */
export function readPortableVaultFile(bytes: Uint8Array): PortableVaultBlob | null {
	let blob: ReturnType<typeof decodeVaultBlob>;
	try {
		blob = decodeVaultBlob(bytes);
	} catch {
		return null;
	}
	// A vault with no password slot (security-key only) can't be opened by a typed
	// password, so it isn't readable through this path.
	const slot = findPasswordSlot(blob);
	if (!slot) return null;
	return {
		slotId: bytesToBase64(slot.slotId),
		salt: bytesToBase64(slot.salt),
		verifier: bytesToBase64(slot.verifier),
		wrapIv: bytesToBase64(slot.wrapIv),
		wrappedVek: bytesToBase64(slot.wrappedVek),
		entriesIv: bytesToBase64(blob.entriesIv),
		entriesCiphertext: bytesToBase64(blob.entriesCiphertext),
	};
}

/**
 * The entries in a .bramble, or null for a wrong password. Accepts a full vault backup as
 * well as a portable export: a backup's payload is an `EntriesPayload` of ENCRYPTED entries,
 * which this cannot read, so it reports that distinctly rather than pretending it is empty.
 */
export async function openPortableVaultFile(
	crypto: Pick<CryptoAdapter, "openPortableVault">,
	file: PortableVaultBlob,
	password: string,
): Promise<EntryData[] | null> {
	if (!crypto.openPortableVault) throw new Error("Opening a .bramble isn't available here.");
	const json = await crypto.openPortableVault({
		file,
		password,
		magicVersion: verifierPrefix(),
	});
	if (json === null) return null;
	const parsed = JSON.parse(json) as PortableVaultPayload | EntriesPayload;
	const entries = parsed.entries;
	if (!Array.isArray(entries)) throw new Error("That .bramble file has no entries in it.");
	// A full-vault backup's entries are `{ id, ciphertext, ... }` records still sealed under
	// their own DEKs. Importing those would silently produce garbage entries.
	if (entries.some((e) => "ciphertext" in e)) {
		throw new Error(
			"That's a full vault backup. Restore it from Settings instead, which replaces this device's vault.",
		);
	}
	return entries as EntryData[];
}
