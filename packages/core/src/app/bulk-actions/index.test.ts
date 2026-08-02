import { i18n } from "@lingui/core";
import { FileDown } from "lucide-react";
import { beforeAll, describe, expect, it } from "vitest";
import type { Platform } from "../../context/PlatformContext";
import type { Entry } from "../../hooks/useVault";
import { availableBulkActions, type BulkAction, isBulkActionEnabled } from "./index";

// Reading any descriptor's `label` goes through i18n._.
beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

const platform = (shell: object, crypto: object) => ({ shell, crypto }) as unknown as Platform;

/** Everything the export action needs: somewhere to write, and a core that can seal. */
const capable = platform({ exportBytes: () => {} }, { sealPortableVault: () => {} });

const login = (id: string): Entry => ({
	id,
	type: "login",
	name: id,
	urls: [],
	username: "u",
	password: "p",
});

describe("availableBulkActions", () => {
	it("offers export where the platform can write a sealed file", () => {
		expect(availableBulkActions(capable).map((a) => a.id)).toContain("export");
	});

	// The one real gate: a platform with no way to write a file cannot offer the action.
	it("hides export without a file-save mechanism", () => {
		const noSave = platform({}, {});
		expect(availableBulkActions(noSave).map((a) => a.id)).not.toContain("export");
	});

	it("keeps delete everywhere, since it needs nothing from the platform", () => {
		expect(availableBulkActions(platform({}, {})).map((a) => a.id)).toEqual(["delete"]);
	});

	it("puts the destructive action last", () => {
		const ids = availableBulkActions(capable).map((a) => a.id);
		expect(ids[ids.length - 1]).toBe("delete");
	});
});

describe("isBulkActionEnabled", () => {
	const [action] = availableBulkActions(capable);

	it("is off for an empty selection whatever the action says", () => {
		if (!action) throw new Error("no actions registered");
		expect(isBulkActionEnabled(action, [])).toBe(false);
	});

	it("is on for a non-empty selection when the action has no opinion", () => {
		if (!action) throw new Error("no actions registered");
		expect(isBulkActionEnabled(action, [login("a")])).toBe(true);
	});

	// A standalone descriptor, not a spread of a registered one: spreading evaluates the
	// `label` getter and freezes it to whatever locale happened to be active.
	it("defers to the action's own predicate", () => {
		const loginsOnly: BulkAction = {
			id: "logins-only",
			label: "Logins only",
			icon: FileDown,
			isEnabled: (entries) => entries.every((e) => e.type === "login"),
			Dialog: () => null,
		};
		expect(isBulkActionEnabled(loginsOnly, [login("a")])).toBe(true);
		expect(isBulkActionEnabled(loginsOnly, [{ id: "n", type: "note", name: "n" }])).toBe(false);
	});
});
