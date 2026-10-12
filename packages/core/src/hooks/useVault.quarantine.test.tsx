/** @vitest-environment happy-dom */
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { VAULT_OPEN_FAILED } from "../adapters/crypto";
import type { Platform } from "../context/PlatformContext";
import { mountVault } from "../test/vault-harness";
import { VAULT_REGISTRY_KEY } from "../vault/vault-registry";

afterEach(cleanup);

// A vault holding entries sealed under another vault's key (a sync crossing) used to refuse to
// open with a raw "aes decrypt: aead::Error". It now opens, setting those entries aside.

const VAULT_ID = "vault-1";

vi.mock("../vault-format", async (importOriginal) => ({
	...(await importOriginal<typeof import("../vault-format")>()),
	decodeVaultBlob: () => ({
		slots: [
			{
				kind: 0x01, // SLOT_KIND_PASSWORD
				slotId: new Uint8Array(16),
				salt: new Uint8Array(16),
				verifier: new Uint8Array(32),
				wrapIv: new Uint8Array(12),
				wrappedVek: new Uint8Array(32),
			},
		],
		entriesIv: new Uint8Array(12),
		entriesCiphertext: new Uint8Array([1]),
	}),
	encodeVaultBlob: () => new Uint8Array([1, 2, 3]),
}));

const hlc = { wall: 1, counter: 0, node: "n" };
const sealed = (id: string) => ({ id, wrappedDek: "w", dekIv: "d", ciphertext: id, iv: "i", hlc });
const PROBE = "probe";

/** Decrypts by ciphertext: `opens` maps the entries that open; the probe opens unless `deviceBroken`. */
const decryptBy =
	(opens: Record<string, string>, deviceBroken = false) =>
	async (ps: { ciphertext: string }[]) =>
		ps.map((p) =>
			p.ciphertext === PROBE ? (deviceBroken ? null : "{}") : (opens[p.ciphertext] ?? null),
		);

function makePlatform(
	entryIds: string[],
	cryptoOver: Record<string, unknown>,
	shellOver: Record<string, unknown> = {},
	{ otherVaults = [] as string[], diskJson }: { otherVaults?: string[]; diskJson?: string } = {},
) {
	const vaults = [VAULT_ID, ...otherVaults].map((id, i) => ({ id, label: "", createdAt: i + 1 }));
	const meta = new Map<string, unknown>([[VAULT_REGISTRY_KEY, { vaults }]]);
	const quarantineIds: (string | undefined)[] = [];
	const writes: Uint8Array[] = [];
	let quarantine: string | null = null;
	let disk = diskJson ?? JSON.stringify({ entries: entryIds.map(sealed), tombstones: [] });
	const platform = {
		target: "chromium",
		storage: {
			getMeta: async (k: string) => meta.get(k),
			setMeta: async (k: string, v: unknown) => void meta.set(k, v),
			removeMeta: async (k: string) => void meta.delete(k),
			hasVault: async () => true,
			readVaultBlob: async () => new Uint8Array([1]),
			writeVaultBlob: async (b: Uint8Array) => void writes.push(b),
			restoreVaultFromBackup: async () => false,
			readQuarantine: async () => quarantine,
			writeQuarantine: async (json: string, id?: string) => {
				quarantineIds.push(id);
				quarantine = json;
			},
		},
		crypto: {
			isLocked: async () => false,
			onExternalLock: () => () => {},
			onExternalChange: () => () => {},
			unwrapVekPassword: async () => true,
			decryptWithVek: async () => disk,
			encryptWithVek: async (plaintext: string) => {
				disk = plaintext;
				return { iv: "AAAAAAAAAAAAAAAA", ciphertext: "AA==" };
			},
			encryptEntry: async () => ({ ciphertext: PROBE, iv: "i", wrappedDek: "w", dekIv: "d" }),
			lock: async () => {},
			...cryptoOver,
		},
		autofill: { clearIndex: async () => {}, setIndex: async () => {} },
		shell: {
			setActiveVault: async () => {},
			onSyncStatus: () => () => {},
			flushPendingCornerCapture: async () => false,
			...shellOver,
		},
		clipboard: {},
	} as unknown as Platform;
	return {
		platform,
		writes,
		quarantined: () => (quarantine === null ? [] : (JSON.parse(quarantine) as unknown[])),
		quarantineIds,
	};
}

async function mounted(platform: Platform) {
	const { actions, state } = mountVault(platform);
	await waitFor(() => expect(actions().unlock).toBeTypeOf("function"));
	return { actions, state };
}

it("opens a vault holding an entry it can't decrypt, and sets that entry aside", async () => {
	const { platform, quarantined } = makePlatform(["mine", "stray"], {
		decryptEntries: decryptBy({ mine: '{"type":"login","name":"Mine"}' }),
	});
	const { actions, state } = await mounted(platform);
	await actions().unlock("pw");
	await waitFor(() => expect(state().isLocked).toBe(false));
	expect(state().entries.map((e) => e.name)).toEqual(["Mine"]);
	expect(quarantined()).toHaveLength(1);
});

it("opens a vault that held only stray entries, empty", async () => {
	const { platform, quarantined } = makePlatform(["stray"], { decryptEntries: decryptBy({}) });
	const { actions, state } = await mounted(platform);
	await actions().unlock("pw");
	await waitFor(() => expect(state().isLocked).toBe(false));
	expect(state().entries).toEqual([]);
	expect(quarantined()).toHaveLength(1);
});

it("changes nothing when this device can't decrypt entries at all", async () => {
	const { platform, writes, quarantined } = makePlatform(["mine"], {
		decryptEntries: decryptBy({}, true),
	});
	const { actions } = await mounted(platform);
	await expect(actions().unlock("pw")).rejects.toThrow(VAULT_OPEN_FAILED);
	expect(writes).toHaveLength(0);
	expect(quarantined()).toEqual([]);
});

it("changes nothing when a readable entry fails to parse", async () => {
	const { platform, writes, quarantined } = makePlatform(["bad", "stray"], {
		decryptEntries: decryptBy({ bad: "{not json" }),
	});
	const { actions } = await mounted(platform);
	await expect(actions().unlock("pw")).rejects.toThrow(VAULT_OPEN_FAILED);
	expect(writes).toHaveLength(0);
	expect(quarantined()).toEqual([]);
});

it("locks again when the vault fails to open, and reports only a vault that opened", async () => {
	const lock = vi.fn(async () => {});
	const notifyVaultOpened = vi.fn();
	const { platform } = makePlatform(
		["mine"],
		{ decryptEntries: decryptBy({}, true), lock },
		{ notifyVaultOpened },
	);
	const { actions } = await mounted(platform);
	await expect(actions().unlock("pw")).rejects.toThrow(VAULT_OPEN_FAILED);
	expect(lock).toHaveBeenCalled();
	expect(notifyVaultOpened).not.toHaveBeenCalled();
});

it("reports the vault that opened, by id", async () => {
	const notifyVaultOpened = vi.fn();
	const { platform } = makePlatform(
		["mine"],
		{ decryptEntries: decryptBy({ mine: '{"type":"login","name":"Mine"}' }) },
		{ notifyVaultOpened },
	);
	const { actions } = await mounted(platform);
	await actions().unlock("pw");
	await waitFor(() => expect(notifyVaultOpened).toHaveBeenCalledWith(VAULT_ID));
});

// The restore screen's first-vault path unlocks a vault it only just created, from a closure that
// has no active vault yet: the quarantine must go to the vault the unlock names.
it("sets stray entries aside for the vault an unlock names, before any vault is selected", async () => {
	const { platform, quarantined, quarantineIds } = makePlatform(
		["mine", "stray"],
		{ decryptEntries: decryptBy({ mine: '{"type":"login","name":"Mine"}' }) },
		{},
		{ otherVaults: ["vault-2"] },
	);
	const { actions, state } = await mounted(platform);
	await actions().unlock("pw", VAULT_ID);
	await waitFor(() => expect(state().isLocked).toBe(false));
	expect(quarantined()).toHaveLength(1);
	expect(quarantineIds).toEqual([VAULT_ID]);
});

it("keeps a permanent, user-facing reason instead of 'try again'", async () => {
	const lock = vi.fn(async () => {});
	const { platform } = makePlatform(
		[],
		{ decryptEntries: decryptBy({}), lock },
		{},
		{ diskJson: '{"not":"an entries payload"}' },
	);
	const { actions } = await mounted(platform);
	await expect(actions().unlock("pw")).rejects.toThrow(/incompatible version/);
	expect(lock).toHaveBeenCalled();
});
