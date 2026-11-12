import { describe, expect, it } from "vitest";
import type { EntryData } from "../hooks/useVault";
import { tagImport } from "./tag-import";
import type { PlacedAttachment } from "./types";

const login = (name: string): EntryData =>
	({ type: "login", name, urls: [], username: "", password: "p" }) as EntryData;
const file = (onto: PlacedAttachment["onto"]): PlacedAttachment =>
	({ onto, name: "f", mime: "text/plain", size: 1 }) as PlacedAttachment;

describe("tagImport (#209)", () => {
	const day = new Date(2026, 10, 9);

	it("tags every imported item", () => {
		const out = tagImport([login("a"), login("b")], [], day);
		expect(out.items.map((i) => i.tags)).toEqual([
			["imported-2026-11-09-0000"],
			["imported-2026-11-09-0000"],
		]);
	});

	// importEntries finds an attachment's entry by identity, so the tagged copy must be the one
	// it points at, or the file would land nowhere.
	it("keeps each attachment on its own entry", () => {
		const a = login("a");
		const b = login("b");
		const out = tagImport([a, b], [file({ item: b }), file({ entryId: "existing" })], day);
		const onto = out.attachments[0]?.onto;
		expect(onto && "item" in onto && out.items.indexOf(onto.item)).toBe(1);
		expect(out.attachments[1]?.onto).toEqual({ entryId: "existing" });
	});
});
