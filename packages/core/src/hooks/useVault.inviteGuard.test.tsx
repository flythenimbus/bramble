/** @vitest-environment happy-dom */
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "../context/PlatformContext";
import type { RosterPayload } from "../sync";
import { mountVaultActions } from "../test/vault-harness";
import { VAULT_REGISTRY_KEY } from "../vault/vault-registry";
import { UnrecognizedDeviceError } from "./useSyncEnrollment";

afterEach(cleanup);

vi.mock("../vault-format", async (importOriginal) => ({
	...(await importOriginal<typeof import("../vault-format")>()),
	decodeVaultBlob: () => ({
		slots: [],
		entriesIv: new Uint8Array(12),
		entriesCiphertext: new Uint8Array(0),
	}),
	encodeVaultBlob: () => new Uint8Array([1, 2, 3]),
}));

// A joiner copies the inviter's roster. An inviter whose own entry carries a key it no longer
// presents hands every joiner that stale entry, so the pairing works and sync never does: one lost
// key became three broken pairings in a user's report. Inviting refuses until this device rejoins.

const CURRENT_PUB = "Y3VycmVudA==";

function roster(ownPub: string): RosterPayload {
	return {
		devices: [
			{
				id: "device-1",
				publicKey: ownPub,
				label: "This device",
				addedAt: 1,
				hlc: { wall: 1, counter: 0, node: "device-1" },
			},
		],
		revoked: [],
	};
}

function makePlatform(ownPub: string) {
	const storage = {
		hasVaultHandle: vi.fn(async () => true),
		getMeta: vi.fn(async (k: string) => {
			if (k === VAULT_REGISTRY_KEY) return { vaults: [{ id: "v1", label: "", createdAt: 1 }] };
			if (k === "sync.group:v1") return { groupKey: "Z2s=", roster: roster(ownPub) };
			if (k === "sync.deviceId:v1") return "device-1";
			return undefined;
		}),
		setMeta: vi.fn(async () => {}),
		readVaultBlob: vi.fn(async () => new Uint8Array([1])),
		writeVaultBlob: vi.fn(async () => {}),
		restoreVaultFromBackup: vi.fn(async () => false),
	};
	const crypto = {
		isLocked: vi.fn(async () => false),
		onExternalLock: vi.fn(() => () => {}),
		onExternalChange: vi.fn(() => () => {}),
		decryptEntries: vi.fn(async () => []),
		decryptWithVek: vi.fn(async () => JSON.stringify({ entries: [], tombstones: [] })),
	};
	const startEnrollInvite = vi.fn(async () => {});
	const shell = {
		setActiveVault: vi.fn(async () => {}),
		getActiveVault: vi.fn(async () => "v1"),
		flushPendingCornerCapture: vi.fn(async () => {}),
		stopSyncSpike: vi.fn(async () => {}),
		syncDevicePublicKey: vi.fn(async () => CURRENT_PUB),
		onSyncEvent: vi.fn(() => () => {}),
		startEnrollInvite,
	};
	const platform = {
		storage,
		crypto,
		autofill: { clearIndex: vi.fn(async () => {}), setIndex: vi.fn(async () => {}) },
		shell,
		clipboard: {},
	} as unknown as Platform;
	return { platform, startEnrollInvite };
}

async function mount(platform: Platform) {
	const actions = mountVaultActions(platform);
	await act(async () => {});
	await act(async () => {});
	return actions;
}

describe("inviting from this device", () => {
	it("works while the group knows this device by its current key", async () => {
		const { platform, startEnrollInvite } = makePlatform(CURRENT_PUB);
		const actions = await mount(platform);
		await act(async () => {
			await actions().inviteDevice("wss://relay.example");
		});
		expect(startEnrollInvite).toHaveBeenCalledTimes(1);
	});

	it("is refused when its own entry carries a key it no longer has", async () => {
		const { platform, startEnrollInvite } = makePlatform("b2xk");
		const actions = await mount(platform);
		await act(async () => {
			await expect(actions().inviteDevice("wss://relay.example")).rejects.toBeInstanceOf(
				UnrecognizedDeviceError,
			);
		});
		expect(startEnrollInvite).not.toHaveBeenCalled();
	});
});
