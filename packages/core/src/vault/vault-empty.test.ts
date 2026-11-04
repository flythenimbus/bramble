import { describe, expect, it } from "vitest";
import { isVaultEmpty, readVaultContents } from "./vault-empty";

const empty = { entryCount: 0, quarantineRaw: null, rosterDevices: 1, hasAliasConfig: false };

describe("isVaultEmpty", () => {
	it("is empty with no entries, nothing set aside, no other device and no alias provider", () => {
		expect(isVaultEmpty(empty)).toBe(true);
	});

	it("is not empty with an entry", () => {
		expect(isVaultEmpty({ ...empty, entryCount: 1 })).toBe(false);
	});

	it("is not empty when another device syncs it, even with no entries", () => {
		expect(isVaultEmpty({ ...empty, rosterDevices: 2 })).toBe(false);
	});

	it("is not empty with a quarantined entry, which is kept forever", () => {
		const raw = JSON.stringify([{ id: "x", quarantinedAt: 1 }]);
		expect(isVaultEmpty({ ...empty, quarantineRaw: raw })).toBe(false);
	});

	it("treats an empty quarantine store as nothing set aside", () => {
		expect(isVaultEmpty({ ...empty, quarantineRaw: "[]" })).toBe(true);
	});

	it("treats an unreadable quarantine store as something set aside", () => {
		expect(isVaultEmpty({ ...empty, quarantineRaw: "not json" })).toBe(false);
	});

	it("is not empty with an alias provider configured", () => {
		expect(isVaultEmpty({ ...empty, hasAliasConfig: true })).toBe(false);
	});
});

describe("readVaultContents", () => {
	function storage(meta: Record<string, unknown>, quarantine: string | null = null) {
		return {
			getMeta: async <T>(k: string) => meta[k] as T | undefined,
			readQuarantine: async () => quarantine,
		};
	}

	it("reads the roster, quarantine and alias config of that vault", async () => {
		const s = storage(
			{
				"sync.group:v1": { roster: { devices: [{ publicKey: "a" }, { publicKey: "b" }] } },
				"alias.config:v1": { provider: "addy" },
			},
			"[]",
		);
		expect(await readVaultContents(s, "v1", 3)).toEqual({
			entryCount: 3,
			quarantineRaw: "[]",
			rosterDevices: 2,
			hasAliasConfig: true,
		});
	});

	it("counts this device alone when the vault syncs with nothing", async () => {
		expect(await readVaultContents(storage({}), "v1", 0)).toEqual({
			entryCount: 0,
			quarantineRaw: null,
			rosterDevices: 1,
			hasAliasConfig: false,
		});
	});
});
