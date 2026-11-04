// Combining this browser's vault into the desktop app's: what to carry, and where it lands.
// Collected while the old vault is still open (only one vault's key is loaded at a time), placed
// against the desktop's vault once it has arrived. See docs/desktop-link-onboarding.md "Combine".

import type { VaultFiles } from "../adapters/files";
import type { Entry, EntryData } from "../hooks/useVault";
import type { PlacedAttachment } from "../import/types";
import type { FileRecord } from "../sync/entries-payload";
import { splitAlreadyImported } from "./entry-identity";
import type { FileSource } from "./file-mutations";

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

export interface Placed {
	items: EntryData[];
	attachments: PlacedAttachment[];
	/** Look-alikes of entries the desktop vault holds, kept back for "Copy them anyway". */
	heldBack: { items: EntryData[]; attachments: PlacedAttachment[] };
}

/** Place a carry against the desktop vault's entries, with the import's two-tier dedup. */
export function placeCarry(existing: readonly Entry[], carry: Carry): Placed {
	const split = splitAlreadyImported(existing, carry.items);
	const fresh = new Set(split.fresh);
	const held = new Set(split.likelyDuplicates);
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
		if (fresh.has(f.entry)) attachments.push(placed({ item: f.entry }));
		else if (held.has(f.entry)) heldAttachments.push(placed({ item: f.entry }));
		else {
			// A dropped duplicate: its files go to the entry it matched.
			const same = split.sameAs.get(f.entry);
			if (typeof same === "string") attachments.push(placed({ entryId: same }));
			else if (same) attachments.push(placed({ item: same }));
		}
	}
	return {
		items: split.fresh,
		attachments,
		heldBack: { items: split.likelyDuplicates, attachments: heldAttachments },
	};
}
