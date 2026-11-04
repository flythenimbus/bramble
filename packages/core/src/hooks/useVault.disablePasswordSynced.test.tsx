/** @vitest-environment happy-dom */
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "../context/PlatformContext";
import { mountVaultActions } from "../test/vault-harness";
import { VAULT_REGISTRY_KEY } from "../vault/vault-registry";
import { SLOT_KIND_PASSWORD, SLOT_KIND_WEBAUTHN } from "../vault-format";

// Pairing requires a master password, and a synced vault may pair again at any time, so a vault in
// a sync group keeps its password: turning it off means leaving sync first.

afterEach(cleanup);

vi.mock("../vault-format", async (importOriginal) => ({
	...(await importOriginal<typeof import("../vault-format")>()),
	decodeVaultBlob: () => ({
		slots: [
			{
				kind: SLOT_KIND_PASSWORD,
				slotId: new Uint8Array(16),
				salt: new Uint8Array(16),
				verifier: new Uint8Array(32),
				wrapIv: new Uint8Array(12),
				wrappedVek: new Uint8Array(48),
			},
			{
				kind: SLOT_KIND_WEBAUTHN,
				slotId: new Uint8Array(16).fill(1),
				credentialId: new Uint8Array([1]),
				salt: new Uint8Array(32),
				verifier: new Uint8Array(32),
				wrapIv: new Uint8Array(12),
				wrappedVek: new Uint8Array(48),
			},
		],
		entriesIv: new Uint8Array(12),
		entriesCiphertext: new Uint8Array(0),
	}),
	encodeVaultBlob: () => new Uint8Array([1, 2, 3]),
}));

function makePlatform(group: unknown) {
	const storage = {
		hasVaultHandle: vi.fn(async () => true),
		getMeta: vi.fn(async (k: string) => {
			if (k === VAULT_REGISTRY_KEY) return { vaults: [{ id: "v1", label: "", createdAt: 1 }] };
			if (k === "sync.group:v1") return group;
			return undefined;
		}),
		setMeta: vi.fn(async () => {}),
		readVaultBlob: vi.fn(async () => new Uint8Array([1])),
		writeVaultBlob: vi.fn(async () => {}),
		restoreVaultFromBackup: vi.fn(async () => false),
	};
	const platform = {
		storage,
		crypto: {
			isLocked: vi.fn(async () => false),
			onExternalLock: vi.fn(() => () => {}),
			onExternalChange: vi.fn(() => () => {}),
			decryptEntries: vi.fn(async () => []),
		},
		autofill: { clearIndex: vi.fn(async () => {}), setIndex: vi.fn(async () => {}) },
		shell: {
			setActiveVault: vi.fn(async () => {}),
			getActiveVault: vi.fn(async () => "v1"),
			flushPendingCornerCapture: vi.fn(async () => {}),
		},
		clipboard: {},
	} as unknown as Platform;
	return { platform, writeVaultBlob: storage.writeVaultBlob };
}

async function mount(platform: Platform) {
	const actions = mountVaultActions(platform);
	await act(async () => {});
	await act(async () => {});
	return actions;
}

describe("turning the master password off", () => {
	it("is refused while the vault is in a sync group, and the vault is left as it was", async () => {
		const { platform, writeVaultBlob } = makePlatform({ groupKey: "Z2s=", roster: {} });
		const actions = await mount(platform);
		await act(async () => {
			await expect(actions().disableMasterPassword()).rejects.toThrow(/Disconnect .* from sync/);
		});
		expect(writeVaultBlob).not.toHaveBeenCalled();
	});

	it("is allowed on a vault that does not sync", async () => {
		const { platform, writeVaultBlob } = makePlatform(undefined);
		const actions = await mount(platform);
		await act(async () => {
			await actions().disableMasterPassword();
		});
		expect(writeVaultBlob).toHaveBeenCalledTimes(1);
	});
});
