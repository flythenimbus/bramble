/** @vitest-environment happy-dom */
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "../context/PlatformContext";
import { HLC_MAX_DRIFT_MS, type RosterEntry, type RosterPayload } from "../sync";
import { mountVaultActions } from "../test/vault-harness";
import { VAULT_REGISTRY_KEY } from "../vault/vault-registry";

afterEach(cleanup);

// The on-disk byte layout is not under test; the roster is. A decoded stub keeps the mount's
// slot-metadata read from failing, which would leave the provider on the unlock screen.
vi.mock("../vault-format", async (importOriginal) => ({
	...(await importOriginal<typeof import("../vault-format")>()),
	decodeVaultBlob: () => ({
		slots: [],
		entriesIv: new Uint8Array(12),
		entriesCiphertext: new Uint8Array(0),
	}),
	encodeVaultBlob: () => new Uint8Array([1, 2, 3]),
}));

// Phase-1 migration backfill. Roster entries are only signed at create / join / invite, so a device
// enrolled before signing shipped (2026-07-09) carries an unsigned entry forever and the phase-2
// flip (rosterRequireSignatures) would drop its updates. The clock in the doc could never run out on
// its own; this is what makes it finish. See docs/p2p-sync-revocation-hardening.md.

const DEVICE_ID = "device-1";
const OWN_PUB = "b3duLXB1Yg==";
const GROUP_KEY = "sync.group:v1";

/** A roster holding this device plus a peer, with `sig` on ours only when `signed`. */
function roster(signed: boolean, ownWall = 1000): RosterPayload {
	const own: RosterEntry = {
		id: DEVICE_ID,
		publicKey: OWN_PUB,
		label: "This device",
		addedAt: 1,
		hlc: { wall: ownWall, counter: 0, node: DEVICE_ID },
		...(signed ? { sigKey: "b2xkLWtleQ==", sig: "b2xkLXNpZw==" } : {}),
	};
	const peer: RosterEntry = {
		id: "device-2",
		publicKey: "cGVlci1wdWI=",
		label: "Phone",
		addedAt: 2,
		hlc: { wall: 1001, counter: 0, node: "device-2" },
	};
	return { devices: [own, peer], revoked: [] };
}

function makePlatform(
	over: { group?: { groupKey: string; roster: RosterPayload } | null; canSign?: boolean } = {},
) {
	const group = over.group === undefined ? { groupKey: "Z2s=", roster: roster(false) } : over.group;
	const writes: Array<{ key: string; value: unknown }> = [];
	const storage = {
		hasVaultHandle: vi.fn(async () => true),
		getMeta: vi.fn(async (k: string) => {
			if (k === VAULT_REGISTRY_KEY) return { vaults: [{ id: "v1", label: "", createdAt: 1 }] };
			if (k === GROUP_KEY) return group ?? undefined;
			if (k === "sync.deviceId:v1") return DEVICE_ID;
			return undefined;
		}),
		setMeta: vi.fn(async (key: string, value: unknown) => {
			writes.push({ key, value });
		}),
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
	const signRoster = vi.fn(async () => "bmV3LXNpZw==");
	const shell = {
		setActiveVault: vi.fn(async () => {}),
		getActiveVault: vi.fn(async () => "v1"),
		flushPendingCornerCapture: vi.fn(async () => {}),
		stopSyncSpike: vi.fn(async () => {}),
		syncDevicePublicKey: vi.fn(async () => OWN_PUB),
		...(over.canSign === false
			? {}
			: { syncSigningPublicKey: vi.fn(async () => "bmV3LWtleQ=="), signRoster }),
	};
	const platform = {
		storage,
		crypto,
		autofill: { clearIndex: vi.fn(async () => {}), setIndex: vi.fn(async () => {}) },
		shell,
		clipboard: {},
	} as unknown as Platform;
	return { platform, writes, signRoster };
}

/** The roster this run wrote back, or null when it never wrote one. */
function writtenRoster(writes: Array<{ key: string; value: unknown }>): RosterPayload | null {
	const last = writes.filter((w) => w.key === GROUP_KEY).at(-1);
	return last ? (last.value as { roster: RosterPayload }).roster : null;
}

/** Mount unlocked and let the post-unlock effects settle. */
async function mount(platform: Platform): Promise<void> {
	mountVaultActions(platform);
	await act(async () => {});
	await act(async () => {});
}

describe("roster signature backfill", () => {
	it("signs an unsigned own entry on unlock", async () => {
		const { platform, writes, signRoster } = makePlatform();
		await mount(platform);

		const own = writtenRoster(writes)?.devices.find((d) => d.publicKey === OWN_PUB);
		expect(own?.sigKey).toBe("bmV3LWtleQ==");
		expect(own?.sig).toBe("bmV3LXNpZw==");
		expect(signRoster).toHaveBeenCalledTimes(1);
		// Re-stamped, so the signed entry wins the merge against the unsigned one peers hold.
		expect(own?.hlc.wall).toBeGreaterThanOrEqual(1000);
		expect(own?.id).toBe(DEVICE_ID);
	});

	it("leaves the peer's entry alone", async () => {
		const { platform, writes } = makePlatform();
		await mount(platform);

		const peer = writtenRoster(writes)?.devices.find((d) => d.id === "device-2");
		expect(peer?.sigKey).toBeUndefined();
		expect(peer?.hlc.wall).toBe(1001);
	});

	it("is a no-op once the entry is signed", async () => {
		const { platform, writes, signRoster } = makePlatform({
			group: { groupKey: "Z2s=", roster: roster(true) },
		});
		await mount(platform);

		expect(signRoster).not.toHaveBeenCalled();
		expect(writtenRoster(writes)).toBeNull();
	});

	it("does nothing when this device is in no group", async () => {
		const { platform, writes, signRoster } = makePlatform({ group: null });
		await mount(platform);

		expect(signRoster).not.toHaveBeenCalled();
		expect(writtenRoster(writes)).toBeNull();
	});

	it("outruns its own future-dated stamp instead of losing the merge to it", async () => {
		// The clock witnesses ENTRY stamps, never roster ones, so a device whose wall clock ran ahead
		// when it enrolled would otherwise re-stamp BEHIND its own entry: last-writer-wins keeps the
		// unsigned one and the backfill retries-and-loses forever, with nothing to show for it.
		// Within the drift budget, because `witness` deliberately clamps anything past it
		// (HLC_MAX_DRIFT_MS) so a stamp cannot be pinned unreachably far ahead - a stamp that far out
		// is dropped as future-stamped by every peer anyway.
		const ahead = Date.now() + HLC_MAX_DRIFT_MS / 2;
		const { platform, writes } = makePlatform({
			group: { groupKey: "Z2s=", roster: roster(false, ahead) },
		});
		await mount(platform);

		const own = writtenRoster(writes)?.devices.find((d) => d.publicKey === OWN_PUB);
		expect(own?.sigKey).toBe("bmV3LWtleQ==");
		expect(own?.hlc.wall).toBeGreaterThanOrEqual(ahead);
		// Same wall means the counter has to break the tie, or the merge is a coin flip.
		if (own?.hlc.wall === ahead) expect(own.hlc.counter).toBeGreaterThan(0);
	});

	it("does nothing on a host that cannot sign", async () => {
		const { platform, writes } = makePlatform({ canSign: false });
		await mount(platform);

		expect(writtenRoster(writes)).toBeNull();
	});
});
