import type { EntryData } from "../hooks/useVault";
import { withImportTag } from "../vault/tags";
import type { PlacedAttachment } from "./types";

/** Tag what an import creates (#209), keeping each attachment on the copy of its entry. */
export function tagImport(
	items: readonly EntryData[],
	attachments: readonly PlacedAttachment[],
	now: Date,
): { items: EntryData[]; attachments: PlacedAttachment[] } {
	const tagged = withImportTag(items, now);
	const copyOf = new Map(items.map((item, i) => [item, tagged[i] ?? item]));
	return {
		items: tagged,
		attachments: attachments.map((a) =>
			"item" in a.onto ? { ...a, onto: { item: copyOf.get(a.onto.item) ?? a.onto.item } } : a,
		),
	};
}
