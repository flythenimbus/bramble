/** @vitest-environment happy-dom */
import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "../context/PlatformContext";
import type { RosterPayload } from "../sync";
import { mountVaultActions } from "../test/vault-harness";
import { VAULT_REGISTRY_KEY } from "../vault/vault-registry";
import { SLOT_KIND_PASSWORD } from "../vault-format";
import { MasterPasswordRequiredError, UnrecognizedDeviceError } from "./useSyncEnrollment";

const PASSWORD_SLOT = {
	kind: SLOT_KIND_PASSWORD,
	slotId: new Uint8Array(16),
	salt: new Uint8Array(16),
	verifier: new Uint8Array(32),
	wrapIv: new Uint8Array(12),
	wrappedVek: new Uint8Array(48),
};
const h = vi.hoisted(() => ({ slots: [] as object[] }));

afterEach(cleanup);
beforeEach(() => {
	h.slots = [PASSWORD_SLOT];
});

vi.mock("../vault-format", async (importOriginal) => ({
	...(await importOriginal<typeof import("../vault-format")>()),
	decodeVaultBlob: () => ({
		slots: h.slots,
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
	const syncListeners: ((ev: { kind: string; entryJson?: string }) => void)[] = [];
	const shell = {
		setActiveVault: vi.fn(async () => {}),
		getActiveVault: vi.fn(async () => "v1"),
		flushPendingCornerCapture: vi.fn(async () => {}),
		stopSyncSpike: vi.fn(async () => {}),
		syncDevicePublicKey: vi.fn(async () => CURRENT_PUB),
		onSyncEvent: vi.fn((cb: (ev: { kind: string; entryJson?: string }) => void) => {
			syncListeners.push(cb);
			return () => {};
		}),
		startEnrollInvite,
	};
	const platform = {
		storage,
		crypto,
		autofill: { clearIndex: vi.fn(async () => {}), setIndex: vi.fn(async () => {}) },
		shell,
		clipboard: {},
	} as unknown as Platform;
	const enrolled = (entry: object) => {
		for (const cb of syncListeners) cb({ kind: "enrolled", entryJson: JSON.stringify(entry) });
	};
	return { platform, startEnrollInvite, setMeta: storage.setMeta, enrolled };
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
			await actions().inviteDevice("wss://relay.example", undefined, "master password");
		});
		expect(startEnrollInvite).toHaveBeenCalledTimes(1);
	});

	it("is refused when its own entry carries a key it no longer has", async () => {
		const { platform, startEnrollInvite } = makePlatform("b2xk");
		const actions = await mount(platform);
		await act(async () => {
			await expect(
				actions().inviteDevice("wss://relay.example", undefined, "master password"),
			).rejects.toBeInstanceOf(UnrecognizedDeviceError);
		});
		expect(startEnrollInvite).not.toHaveBeenCalled();
	});
});

describe("inviting needs a master password", () => {
	// Pairing hands over the vault, and the re-entered password is what admission-signs the joiner.
	// A vault unlocked by keys alone has no password to sign with, so it may not pair at all.
	it("is refused on a vault with no master password, before touching any sync state", async () => {
		h.slots = [];
		const { platform, startEnrollInvite, setMeta } = makePlatform(CURRENT_PUB);
		const actions = await mount(platform);
		setMeta.mockClear();
		await act(async () => {
			await expect(
				actions().inviteDevice("wss://relay.example", undefined, "anything"),
			).rejects.toBeInstanceOf(MasterPasswordRequiredError);
		});
		expect(startEnrollInvite).not.toHaveBeenCalled();
		expect(setMeta).not.toHaveBeenCalled();
	});

	it("is refused when the password was not re-entered", async () => {
		const { platform, startEnrollInvite } = makePlatform(CURRENT_PUB);
		const actions = await mount(platform);
		await act(async () => {
			await expect(
				actions().inviteDevice("wss://relay.example", undefined, ""),
			).rejects.toBeInstanceOf(MasterPasswordRequiredError);
		});
		expect(startEnrollInvite).not.toHaveBeenCalled();
	});
});

describe("adding the device that joined", () => {
	const joiner = (id: string) => ({
		id,
		publicKey: "am9pbmVy",
		label: "Joiner",
		addedAt: 2,
		hlc: { wall: 2, counter: 0, node: id },
	});
	const groupWrites = (setMeta: ReturnType<typeof vi.fn>) =>
		setMeta.mock.calls.filter(([k]) => k === "sync.group:v1") as [
			string,
			{ roster: RosterPayload },
		][];

	it("does not let it take this device's id under its own key", async () => {
		const { platform, setMeta, enrolled } = makePlatform(CURRENT_PUB);
		const actions = await mount(platform);
		await act(async () => {
			await actions().inviteDevice("wss://relay.example", undefined, "master password");
		});
		setMeta.mockClear();

		await act(async () => enrolled(joiner("device-1")));
		expect(groupWrites(setMeta)).toEqual([]);

		await act(async () => enrolled(joiner("device-2")));
		const ids = groupWrites(setMeta)
			.at(-1)?.[1]
			.roster.devices.map((d) => d.id);
		expect(ids?.sort()).toEqual(["device-1", "device-2"]);
	});
});
