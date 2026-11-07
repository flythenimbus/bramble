// Combining this browser's vault into the desktop app's: what to carry, and where it lands.
// Collected while the old vault is still open (only one vault's key is loaded at a time), placed
// against the desktop's vault once it has arrived. See docs/desktop-link-onboarding.md "Combine".

import type { CryptoAdapter } from "../adapters/crypto";
import type { VaultFiles } from "../adapters/files";
import { type BackupTargetConfig, credsAreOsHeld } from "../backup/config";
import type { Entry, EntryData } from "../hooks/useVault";
import type { PlacedAttachment } from "../import/types";
import type { FileRecord } from "../sync/entries-payload";
import { entryContentKey, splitAlreadyImported } from "./entry-identity";
import type { FileSource } from "./file-mutations";
import { foldedPasswordChangelog } from "./password-changelog";
import { normalizeTags, tagKey, tagsEqual } from "./tags";

/** One attachment carried across, on the carried entry it belongs to. */
export interface CarriedFile {
	entry: EntryData;
	name: string;
	mime: string;
	source: FileSource;
	size: number;
}

export interface Carry {
	items: EntryData[];
	files: CarriedFile[];
	/** Files that could not be carried: unreadable here, or on no entry. Never silently zero. */
	uncarried: number;
}

/** Read everything out of the open vault, before the switch to the desktop's. */
export async function collectCarry(
	entries: readonly Entry[],
	records: readonly FileRecord[],
	files: Pick<VaultFiles, "stage"> | null,
): Promise<Carry> {
	const byId = new Map<string, EntryData>();
	const items = entries.map(({ id, ...data }) => {
		const item = data as EntryData;
		byId.set(id, item);
		return item;
	});
	const carried: CarriedFile[] = [];
	let uncarried = 0;
	for (const record of records) {
		const entry = record.entryId === undefined ? undefined : byId.get(record.entryId);
		if (!entry || !files?.stage) {
			uncarried++;
			continue;
		}
		try {
			carried.push({ entry, ...(await files.stage(record)) });
		} catch {
			uncarried++;
		}
	}
	return { items, files: carried, uncarried };
}

/** A copy of an entry the vault holds that brings something the entry lacks. */
export interface MatchedCopy {
	id: string;
	copy: EntryData;
}

export interface Placed {
	items: EntryData[];
	attachments: PlacedAttachment[];
	/** Look-alikes of entries the desktop vault holds, kept back for "Copy them anyway". */
	heldBack: { items: EntryData[]; attachments: PlacedAttachment[] };
	/** Copies of entries the desktop vault holds, to fold into them. */
	matched: MatchedCopy[];
	/** Copies whose tags would not all fit on the entry they matched. */
	tagsLeftOver: number;
}

/**
 * `entry` with what a copy of it holds besides: its tags, its old passwords, and being in use. An
 * entry archived on one side only comes back, since hiding a login in use is worse than showing an
 * archived one. The entry itself when the copy adds nothing, whatever its dates say.
 */
export function foldCarriedCopy<T extends EntryData>(entry: T, copy: EntryData): T {
	let next: EntryData = entry;
	const tags = normalizeTags([...(entry.tags ?? []), ...(copy.tags ?? [])]);
	// By key, or a stored spelling the normalizer would change reads as a change.
	const known = new Set((entry.tags ?? []).map(tagKey));
	const addsTags = (copy.tags ?? []).some((t) => !known.has(tagKey(t)));
	if (addsTags && !tagsEqual(entry.tags, tags)) next = { ...next, tags };
	if (entry.archivedAt !== undefined && copy.archivedAt === undefined) {
		const { archivedAt: _archivedAt, ...active } = next;
		next = active as EntryData;
	}
	if (next.type === "login" && copy.type === "login") {
		const { password, passwordChangelog: log = [] } = next;
		const addsRows = (copy.passwordChangelog ?? []).some(
			(r) => r.value !== password && !log.some((row) => row.value === r.value),
		);
		const folded = addsRows ? foldedPasswordChangelog(next, [copy], 0) : undefined;
		if (folded && JSON.stringify(folded) !== JSON.stringify(log)) {
			next = { ...next, passwordChangelog: folded };
		}
	}
	return next as T;
}

/** Whether `entry` carries every tag of `copy`. */
const holdsTagsOf = (entry: EntryData, copy: EntryData): boolean => {
	const held = new Set((entry.tags ?? []).map(tagKey));
	return (normalizeTags(copy.tags) ?? []).every((t) => held.has(tagKey(t)));
};

/** Place a carry against the desktop vault's entries, with the import's two-tier dedup. */
export function placeCarry(existing: readonly Entry[], carry: Carry): Placed {
	const split = splitAlreadyImported(existing, carry.items);
	const held = new Set(split.likelyDuplicates);
	const folded = new Map(existing.map((e): [string, EntryData] => [e.id, e]));
	const kept = new Map<EntryData, EntryData>();
	const matched: MatchedCopy[] = [];
	let tagsLeftOver = 0;
	for (const [copy, same] of split.sameAs) {
		const into = (
			typeof same === "string" ? folded.get(same) : (kept.get(same) ?? same)
		) as EntryData;
		const next = foldCarriedCopy(into, copy);
		if (!holdsTagsOf(next, copy)) tagsLeftOver++;
		if (typeof same !== "string") {
			kept.set(same, next);
		} else if (next !== into) {
			folded.set(same, next);
			matched.push({ id: same, copy });
		}
	}
	// Copies inside the carry fold into the object files and items below point at.
	const final = (item: EntryData) => kept.get(item) ?? item;

	const attachments: PlacedAttachment[] = [];
	const heldAttachments: PlacedAttachment[] = [];
	for (const f of carry.files) {
		const placed = (onto: PlacedAttachment["onto"]): PlacedAttachment => ({
			onto,
			name: f.name,
			mime: f.mime,
			source: f.source,
			size: f.size,
		});
		// A dropped copy's files go to the entry it matched.
		const same = split.sameAs.get(f.entry);
		if (typeof same === "string") {
			attachments.push(placed({ entryId: same }));
			continue;
		}
		const item = same ?? f.entry;
		(held.has(item) ? heldAttachments : attachments).push(placed({ item: final(item) }));
	}
	return {
		items: split.fresh.map(final),
		attachments,
		heldBack: { items: split.likelyDuplicates.map(final), attachments: heldAttachments },
		matched,
		tagsLeftOver,
	};
}

/** The carried items, less the look-alikes left out and any copy of them, which share their content. */
export function withoutHeldBack(
	items: readonly EntryData[],
	heldBack: readonly EntryData[],
): EntryData[] {
	const held = new Set(heldBack.map(entryContentKey));
	return items.filter((item) => !held.has(entryContentKey(item)));
}

/** What removing a vault needs to know about the copy made of it. */
export interface CopiedOut {
	/** The vault's bytes when the copy began. */
	blob: Uint8Array;
	items: readonly EntryData[];
	/** The hash of each file the copy stored. */
	fileHashes: readonly string[];
	/** The synced settings the copy wrote. */
	settings?: readonly string[];
}

/** A backup target read out of the open vault, its secrets opened to seal under the next key. */
export interface CarriedTarget {
	target: Omit<BackupTargetConfig, "creds">;
	secrets: string;
}

/**
 * Read a vault's backup targets for carrying, before the switch takes its key away. Without their
 * history, which is the old vault's, and with no inherited folder, so snapshots are stamped with
 * the new vault and pruning can't reach the old one's. `unreadable` counts the ones this can't
 * carry: a target from the old device-global list can be sealed under a sibling vault's key and
 * still work there, and a timeout looks the same as a wrong key, so these are said, never dropped
 * quietly.
 */
export async function readCarriedTargets(
	list: readonly BackupTargetConfig[] | null | undefined,
	crypto: Pick<CryptoAdapter, "decryptWithVek">,
): Promise<{ targets: CarriedTarget[]; unreadable: number }> {
	const targets: CarriedTarget[] = [];
	let unreadable = 0;
	for (const entry of list ?? []) {
		const { creds, lastBackupAt, lastVaultHash, lastError, waiting, failures, failedAt, ...rest } =
			entry;
		const { sharedFolder: _sharedFolder, ...target } = rest;
		if (credsAreOsHeld(creds)) {
			unreadable++;
			continue;
		}
		try {
			targets.push({ target, secrets: await crypto.decryptWithVek(creds.iv, creds.ciphertext) });
		} catch {
			unreadable++;
		}
	}
	return { targets, unreadable };
}

/** Seal carried targets under the key of the vault they land in. */
export function sealCarriedTargets(
	carried: readonly CarriedTarget[],
	crypto: Pick<CryptoAdapter, "encryptWithVek">,
): Promise<BackupTargetConfig[]> {
	return Promise.all(
		carried.map(async ({ target, secrets }) => {
			const { iv, ciphertext } = await crypto.encryptWithVek(secrets);
			return { ...target, creds: { iv, ciphertext } };
		}),
	);
}

/** Longer than a background merge takes from reading the disk to writing it back. */
export const MERGE_SETTLE_MS = 1000;

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Whether `entries` hold every carried item, with everything it held. */
export function holdsCarried(entries: readonly EntryData[], items: readonly EntryData[]): boolean {
	const byContent = new Map<string, EntryData[]>();
	for (const e of entries) {
		const key = entryContentKey(e);
		byContent.set(key, [...(byContent.get(key) ?? []), e]);
	}
	return items.every((item) =>
		(byContent.get(entryContentKey(item)) ?? []).some((e) => foldCarriedCopy(e, item) === e),
	);
}
