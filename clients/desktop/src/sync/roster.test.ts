import type { VaultRegistry } from "@core/vault/vault-registry";
import { VAULT_REGISTRY_KEY } from "@core/vault/vault-registry";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Issue #27, ported to the desktop: every crypto op runs against ONE process-global VEK in the
// Rust shell, so a merge that resolves its target vault at write time can seal entries under
// vault B's key into vault A's file. Slots and entries then disagree and NEITHER the master
// password nor the recovery code opens it. These tests pin the routing half of the fix: a session
// is bound to one vault id for its lifetime, and a merge belonging to a torn-down session must
// not write at all.
//
// Desktop has more room for this to happen than mobile does, not less: the process outlives the
// window, so a session can still be running with no UI on screen at all.

const h = vi.hoisted(() => ({
	meta: new Map<string, unknown>(),
	blobWrites: [] as { vaultId: string | undefined }[],
	rosterOpts: null as Record<string, (...a: never[]) => unknown> | null,
	/** Every session started, in order: one per transport. */
	starts: [] as Record<string, unknown>[],
	sessionStops: 0,
	/** The file session's options, and what was done to it. */
	blobStarts: [] as Record<string, unknown>[],
	blobStops: 0,
	blobPokes: 0,
	stateListener: null as ((locked: boolean) => void) | null,
	// Swapped per test to drive what a "merge" does.
	applyRemote: async (_port: unknown, _payload: unknown, _opts?: unknown): Promise<void> => {},
	/** Links the app was asked to end, and whether it should refuse the next one. */
	ended: [] as { linkKey: string; vaultId: string }[],
	endFails: false,
	/** What the Rust side answers to "is the vault locked?". */
	locked: true,
}));

vi.mock("./link-peers", async (importOriginal) => ({
	...(await importOriginal<typeof import("./link-peers")>()),
	pinLink: () => {},
	endLink: async (linkKey: string, vaultId: string) => {
		if (h.endFails) {
			h.endFails = false;
			throw new Error("the app didn't answer");
		}
		h.ended.push({ linkKey, vaultId });
	},
}));

vi.mock("@core/index", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@core/index")>();
	return {
		...actual,
		// Pass the deps straight through so a test can reach the session's pinned store.
		createVaultSyncPort: (deps: unknown) => deps,
		applyRemotePayload: (port: unknown, payload: unknown, opts?: unknown) =>
			h.applyRemote(port, payload, opts),
	};
});

// The on-disk byte layout is not what's under test; routing is. Mocked at @core/vault-format
// because entries-blob.ts imports it relatively, so mocking @core/index would miss it.
vi.mock("@core/vault-format", async (importOriginal) => ({
	...(await importOriginal<typeof import("@core/vault-format")>()),
	decodeVaultBlob: () => ({
		slots: [],
		entriesIv: new Uint8Array(12),
		entriesCiphertext: new Uint8Array(),
	}),
	encodeVaultBlob: () => new Uint8Array([1, 2, 3]),
}));

vi.mock("@core/sync/transport/roster-sync", () => ({
	startRosterSync: async (opts: Record<string, (...a: never[]) => unknown>) => {
		h.starts.push(opts);
		// The relay session is started first; its callbacks are the ones these tests drive. Both
		// sessions share one apply chain, so either would do.
		h.rosterOpts ??= opts;
		return {
			stop: () => {
				h.sessionStops++;
			},
		};
	},
}));

vi.mock("@core/sync/transport/blob-sync", () => ({
	startBlobSync: async (opts: Record<string, unknown>) => {
		h.blobStarts.push(opts);
		return {
			stop: () => {
				h.blobStops++;
			},
			poke: () => {
				h.blobPokes++;
			},
		};
	},
	wantedFromPayload: () => [],
}));

// Which store the file session is handed is the assertion, so each vault's is just its id.
vi.mock("../adapters/files", () => ({
	desktopFiles: { forVault: (vaultId: string) => ({ blobs: { vaultId } }) },
}));

vi.mock("../adapters/storage", () => ({
	desktopStorage: {
		getMeta: async (k: string) => h.meta.get(k),
		setMeta: async (k: string, v: unknown) => {
			h.meta.set(k, v);
		},
		removeMeta: async (k: string) => {
			h.meta.delete(k);
		},
		readVaultBlob: async () => new Uint8Array([9]),
		writeVaultBlob: async (_blob: Uint8Array, vaultId?: string) => {
			h.blobWrites.push({ vaultId });
		},
	},
}));

vi.mock("../adapters/crypto", () => ({
	desktopCrypto: {
		encryptWithVek: async () => ({ iv: "AAAA", ciphertext: "BBBB" }),
		decryptWithVek: async () => JSON.stringify({ entries: [], tombstones: [] }),
		isLocked: async () => h.locked,
	},
}));

vi.mock("../adapters/vault-session", () => ({
	notifyExternalChange: () => {},
	onVaultStateChange: (cb: (locked: boolean) => void) => {
		h.stateListener = cb;
		return () => {};
	},
}));

// Both keypairs come from the OS credential store over Tauri IPC, which does not exist here.
// Returning a stored pair keeps startRoster off the generation path, which isn't what's under test.
vi.mock("./keys", () => ({
	deviceKeypair: async () => ({ privateKey: "p", publicKey: "P" }),
	// Published on unlock so a paired browser can ask which device this is. Best effort, and
	// nothing here depends on it.
	publishSyncIdentity: async () => {},
}));
vi.mock("../sync-crypto", () => ({ desktopSyncCrypto: {} }));

/** A schema-valid empty remote payload; decodeEntriesPayload is the real one. */
const PAYLOAD = JSON.stringify({ entries: [], tombstones: [] });

const VAULT_A = "vault-a";
const VAULT_B = "vault-b";
const registry = (...ids: string[]): VaultRegistry => ({
	vaults: ids.map((id) => ({ id, label: id, createdAt: 1 })),
});

/** Enrol `vaultId` in a group so startRoster gets past its guards. */
function enrol(vaultId: string) {
	h.meta.set(`sync.group:${vaultId}`, { groupKey: "k", roster: { entries: [] } });
}

/** The live session's callbacks, asserted present. */
function opts(): { pushRemotePayload: (json: string) => Promise<void> } {
	if (!h.rosterOpts) throw new Error("no roster session started");
	return h.rosterOpts as unknown as { pushRemotePayload: (json: string) => Promise<void> };
}

async function loadRoster() {
	vi.resetModules();
	return import("./roster");
}

/** Start a session for the active vault by reporting "unlocked". */
async function startSession(mod: Awaited<ReturnType<typeof loadRoster>>) {
	mod.initRosterSync();
	h.stateListener?.(false);
	await vi.waitFor(() => expect(h.rosterOpts).not.toBeNull());
}

// Pay the module graph's transform + import cost once, in a hook, rather than letting it land on
// whichever test happens to call loadRoster() first: `vi.resetModules()` clears the module
// registry but not the transform cache, so that first call is far slower than its siblings and is
// charged against its own timeout. Safe to warm: the module's top level only declares state, and
// beforeEach wipes everything this touches in `h` before any test runs.
beforeAll(async () => {
	await import("./roster");
});

beforeEach(() => {
	h.meta.clear();
	h.blobWrites.length = 0;
	h.rosterOpts = null;
	h.starts.length = 0;
	h.sessionStops = 0;
	h.blobStarts.length = 0;
	h.blobStops = 0;
	h.blobPokes = 0;
	h.stateListener = null;
	h.applyRemote = async () => {};
	h.ended.length = 0;
	h.endFails = false;
	h.locked = true;
	vi.stubGlobal("crypto", { randomUUID: () => "id", getRandomValues: (a: Uint8Array) => a });
});

describe("session vault binding", () => {
	it("writes a merge to the vault the session started on, even if the active vault flips mid-merge", async () => {
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A, VAULT_B));
		h.meta.set("active-vault", VAULT_A);
		enrol(VAULT_A);
		const mod = await loadRoster();
		await startSession(mod);

		// The merge flips the active vault under the session's feet, then writes: the shape of the
		// original corruption. The write must still land in vault A.
		h.applyRemote = async (port) => {
			h.meta.set("active-vault", VAULT_B);
			await (
				port as { store: { writeEntriesBlob: (p: unknown) => Promise<void> } }
			).store.writeEntriesBlob({ entries: [], tombstones: [] });
		};
		await opts().pushRemotePayload(PAYLOAD);

		expect(h.blobWrites).toEqual([{ vaultId: VAULT_A }]);
	});

	it("checks incoming entries with the vault's crypto and remembers refusals for the session", async () => {
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A));
		h.meta.set("active-vault", VAULT_A);
		enrol(VAULT_A);
		const mod = await loadRoster();
		await startSession(mod);
		const seen: { crypto: unknown; rejected: unknown }[] = [];
		h.applyRemote = async (port, _payload, mergeOpts) => {
			seen.push({
				crypto: (port as { crypto?: unknown }).crypto,
				rejected: (mergeOpts as { rejected?: unknown } | undefined)?.rejected,
			});
		};
		await opts().pushRemotePayload(PAYLOAD);
		await opts().pushRemotePayload(PAYLOAD);
		expect(seen[0]?.crypto).toBeDefined();
		expect(seen[0]?.rejected).toBeInstanceOf(Set);
		expect(seen[1]?.rejected).toBe(seen[0]?.rejected);
	});

	it("never writes with an unresolved vault id", async () => {
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A, VAULT_B));
		h.meta.set("active-vault", VAULT_A);
		enrol(VAULT_A);
		const mod = await loadRoster();
		await startSession(mod);

		h.applyRemote = async (port) => {
			await (
				port as { store: { writeEntriesBlob: (p: unknown) => Promise<void> } }
			).store.writeEntriesBlob({ entries: [], tombstones: [] });
		};
		await opts().pushRemotePayload(PAYLOAD);

		// An id-less write lands in the shell's DEFAULT_VAULT_ID file, which is the other half of
		// the bug; the pinned store must always pass one explicitly.
		expect(h.blobWrites.every((w) => w.vaultId !== undefined)).toBe(true);
	});
});

describe("retargetActiveVault", () => {
	it("stops the session and drops a merge queued behind the switch", async () => {
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A, VAULT_B));
		h.meta.set("active-vault", VAULT_A);
		enrol(VAULT_A);
		const mod = await loadRoster();
		await startSession(mod);

		// Hold one merge open so a retarget lands while the next is queued.
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let secondRan = false;
		h.applyRemote = async () => {
			await gate;
		};
		const first = opts().pushRemotePayload(PAYLOAD);

		h.applyRemote = async () => {
			secondRan = true;
		};
		const second = opts().pushRemotePayload(PAYLOAD);

		await mod.retargetActiveVault(VAULT_B);
		release();
		await Promise.all([first, second]);

		expect(h.sessionStops).toBeGreaterThan(0);
		// The queued merge belonged to the vault we left; it must be dropped, not applied.
		expect(secondRan).toBe(false);
	});

	it("is a no-op when the target is already the session's vault", async () => {
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A));
		h.meta.set("active-vault", VAULT_A);
		enrol(VAULT_A);
		const mod = await loadRoster();
		await startSession(mod);

		await mod.retargetActiveVault(VAULT_A);

		expect(h.sessionStops).toBe(0);
	});
});

describe("the relay", () => {
	it("uses the hosted one when the saved setting is blank", async () => {
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A));
		h.meta.set("active-vault", VAULT_A);
		enrol(VAULT_A);
		h.meta.set("sync.relay", "");
		await startSession(await loadRoster());

		expect(h.starts[0]?.relayUrl).toBe("wss://bramble-relay.flythenimbus.workers.dev");
	});
});

describe("transports", () => {
	it("runs one session over the relay and one over the browser link", async () => {
		// Two sessions rather than one: a phone is only reachable through the relay, and a browser
		// on this machine is reachable without it, including with no network at all.
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A));
		h.meta.set("active-vault", VAULT_A);
		enrol(VAULT_A);
		const mod = await loadRoster();
		await startSession(mod);

		expect(h.starts).toHaveLength(2);
		expect(h.starts.filter((o) => o.peerSource === undefined)).toHaveLength(1);
		expect(h.starts.filter((o) => o.peerSource !== undefined)).toHaveLength(1);
	});
});

describe("the file session", () => {
	it("holds the session's own vault's files, and stops with sync", async () => {
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A, VAULT_B));
		h.meta.set("active-vault", VAULT_A);
		enrol(VAULT_A);
		const mod = await loadRoster();
		await startSession(mod);
		await vi.waitFor(() => expect(h.blobStarts).toHaveLength(1));

		expect(h.blobStarts[0]?.blobs).toEqual({ vaultId: VAULT_A });
		// The relay path is on (phones), and the browser link is a path beside it.
		expect(h.blobStarts[0]?.relay).toBeUndefined();
		expect(h.blobStarts[0]?.localSources).toHaveLength(1);

		await mod.retargetActiveVault(VAULT_B);
		expect(h.blobStops).toBe(1);
	});

	it("looks again for attachments after every merge", async () => {
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A));
		h.meta.set("active-vault", VAULT_A);
		enrol(VAULT_A);
		const mod = await loadRoster();
		await startSession(mod);
		await vi.waitFor(() => expect(h.blobStarts).toHaveLength(1));

		await opts().pushRemotePayload(PAYLOAD);
		expect(h.blobPokes).toBe(1);
	});
});

describe("activeVaultId resolution", () => {
	it("starts no session when several vaults are registered and none is recorded active", async () => {
		// Guessing vaults[0] here points sync at a vault the user is not in.
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A, VAULT_B));
		enrol(VAULT_A);
		const mod = await loadRoster();
		mod.initRosterSync();
		h.stateListener?.(false);
		await new Promise((r) => setTimeout(r, 0));

		expect(h.rosterOpts).toBeNull();
	});

	it("falls back to the only vault there is", async () => {
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A));
		enrol(VAULT_A);
		const mod = await loadRoster();
		await startSession(mod);

		expect(h.rosterOpts).not.toBeNull();
	});
});

describe("lock state", () => {
	it("stops the session on lock and starts a fresh one on the next unlock", async () => {
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A));
		h.meta.set("active-vault", VAULT_A);
		enrol(VAULT_A);
		const mod = await loadRoster();
		await startSession(mod);

		// While locked the VEK is gone from the Rust process, so a merge could not decrypt. Both
		// transports stop: a lock is about the key, not about how peers are reached.
		h.stateListener?.(true);
		expect(h.sessionStops).toBe(2);

		h.rosterOpts = null;
		h.stateListener?.(false);
		await vi.waitFor(() => expect(h.rosterOpts).not.toBeNull());
	});
});

// Issue #230: what an unlock does, without having to lock first.
describe("sync now", () => {
	async function running() {
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A));
		h.meta.set("active-vault", VAULT_A);
		enrol(VAULT_A);
		const mod = await loadRoster();
		await startSession(mod);
		await vi.waitFor(() => expect(h.blobStarts).toHaveLength(1));
		h.locked = false;
		return mod;
	}

	it("drops every session and starts a fresh set", async () => {
		const mod = await running();
		await mod.restartRosterSync();

		expect(h.sessionStops).toBe(2);
		expect(h.blobStops).toBe(1);
		expect(h.starts).toHaveLength(4);
		expect(h.blobStarts).toHaveLength(2);
	});

	it("touches nothing while the vault is locked", async () => {
		const mod = await running();
		h.locked = true;

		await expect(mod.restartRosterSync()).rejects.toThrow("the vault is locked");
		expect(h.sessionStops).toBe(0);
		expect(h.starts).toHaveLength(2);
	});

	it("restarts a start that is still under way, rather than leaving it be", async () => {
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A));
		h.meta.set("active-vault", VAULT_A);
		enrol(VAULT_A);
		const mod = await loadRoster();
		mod.initRosterSync();
		h.locked = false;
		h.stateListener?.(false);
		await mod.restartRosterSync();

		expect(h.sessionStops).toBe(2);
		expect(h.starts).toHaveLength(4);
		expect(h.blobStarts).toHaveLength(2);
	});
});

describe("a window that opens onto an unlocked vault", () => {
	// The VEK lives in the Rust process, which outlives the window. On Wayland closing the window
	// destroys it and the tray builds a new one (lifetime.rs), so the new window finds the vault
	// already unlocked and never sees an unlock event: sync stayed off until a lock and unlock (#228).
	it("starts sync without waiting for an unlock", async () => {
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A));
		h.meta.set("active-vault", VAULT_A);
		enrol(VAULT_A);
		h.locked = false;
		const mod = await loadRoster();
		mod.initRosterSync();

		await vi.waitFor(() => expect(h.rosterOpts).not.toBeNull());
	});

	it("starts nothing while the vault is locked", async () => {
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A));
		h.meta.set("active-vault", VAULT_A);
		enrol(VAULT_A);
		const mod = await loadRoster();
		mod.initRosterSync();
		await new Promise((r) => setTimeout(r, 0));

		expect(h.rosterOpts).toBeNull();
	});

	it("starts one set of sessions when an unlock lands during that check", async () => {
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A));
		h.meta.set("active-vault", VAULT_A);
		enrol(VAULT_A);
		h.locked = false;
		const mod = await loadRoster();
		mod.initRosterSync();
		h.stateListener?.(false);
		await vi.waitFor(() => expect(h.blobStarts.length).toBeGreaterThan(0));
		await new Promise((r) => setTimeout(r, 50));

		// One relay session and one link session, not two of each with the first pair orphaned.
		expect(h.starts).toHaveLength(2);
		expect(h.blobStarts).toHaveLength(1);
	});
});

describe("a browser removed from the roster", () => {
	const wall = Date.now() - 1000;
	const member = (id: string, publicKey: string) => ({
		id,
		publicKey,
		label: id,
		addedAt: 1,
		hlc: { wall, counter: 0, node: id },
	});
	const laptop = member("laptop", "P");
	const browser = member("browser", "browserpub");
	const tombstone = (id: string) => ({ id, hlc: { wall: wall + 1, counter: 0, node: "laptop" } });
	const setRoster = (vaultId: string, roster: unknown) =>
		h.meta.set(`sync.group:${vaultId}`, { groupKey: "k", roster });

	/** A session for `vaultId`, with its browser having passed sync's check over the link. */
	async function linked(vaultId = VAULT_A) {
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A, VAULT_B));
		h.meta.set("active-vault", vaultId);
		setRoster(vaultId, { devices: [laptop, browser], revoked: [] });
		const mod = await loadRoster();
		await startSession(mod);
		const linkSession = h.starts[1] as unknown as {
			onAuthenticated: (pub: string, linkKey: string) => void;
		};
		linkSession.onAuthenticated("browserpub", "linkkey");
		await vi.waitFor(() => expect(h.meta.get(`link.keys:${vaultId}`)).toBeDefined());
		return mod;
	}

	it("loses its link when another device's removal arrives", async () => {
		await linked();
		const session = h.starts[0] as unknown as { pushRemoteRoster: (json: string) => Promise<void> };
		await session.pushRemoteRoster(
			JSON.stringify({ devices: [], revoked: [tombstone("browser")] }),
		);
		expect(h.ended).toEqual([{ linkKey: "linkkey", vaultId: VAULT_A }]);
	});

	it("loses its link when it is removed here", async () => {
		const mod = await linked();
		setRoster(VAULT_A, { devices: [laptop, browser], revoked: [tombstone("browser")] });
		await mod.endRemovedLinks(VAULT_A);
		expect(h.ended).toEqual([{ linkKey: "linkkey", vaultId: VAULT_A }]);
	});

	it("ends it once, even when asked again", async () => {
		const mod = await linked();
		setRoster(VAULT_A, { devices: [laptop], revoked: [tombstone("browser")] });
		await mod.endRemovedLinks(VAULT_A);
		await mod.endRemovedLinks(VAULT_A);
		expect(h.ended).toHaveLength(1);
	});

	it("loses it at the next start, if the app was closed when the removal landed", async () => {
		await linked();
		setRoster(VAULT_A, { devices: [laptop], revoked: [tombstone("browser")] });
		h.rosterOpts = null;
		h.starts.length = 0;
		await startSession(await loadRoster());
		await vi.waitFor(() => expect(h.ended).toHaveLength(1));
	});

	it("is tried again next time if the app couldn't end it", async () => {
		const mod = await linked();
		setRoster(VAULT_A, { devices: [laptop], revoked: [tombstone("browser")] });
		h.endFails = true;
		await mod.endRemovedLinks(VAULT_A);
		expect(h.ended).toEqual([]);
		await mod.endRemovedLinks(VAULT_A);
		expect(h.ended).toEqual([{ linkKey: "linkkey", vaultId: VAULT_A }]);
	});

	it("keeps its link while it is still in the roster", async () => {
		const mod = await linked();
		await mod.endRemovedLinks(VAULT_A);
		expect(h.ended).toEqual([]);
	});

	it("keeps it when re-added under a new id with the same key", async () => {
		const mod = await linked();
		setRoster(VAULT_A, {
			devices: [laptop, member("browser-2", "browserpub")],
			revoked: [tombstone("browser")],
		});
		await mod.endRemovedLinks(VAULT_A);
		expect(h.ended).toEqual([]);
	});

	it("keeps it when this device left the group and started a new one", async () => {
		// Missing from the roster isn't removal: only a tombstone says someone removed it.
		const mod = await linked();
		setRoster(VAULT_A, { devices: [laptop], revoked: [] });
		await mod.endRemovedLinks(VAULT_A);
		expect(h.ended).toEqual([]);
	});

	it("leaves another vault's list alone", async () => {
		const mod = await linked(VAULT_A);
		setRoster(VAULT_B, { devices: [laptop], revoked: [tombstone("browser")] });
		await mod.endRemovedLinks(VAULT_B);
		expect(h.ended).toEqual([]);
	});

	it("is one of the open vault's sync devices while it is in the roster", async () => {
		const mod = await linked();
		expect(await mod.syncingLinkKeys()).toEqual(["linkkey"]);
	});

	it("isn't once the roster removes it", async () => {
		const mod = await linked();
		setRoster(VAULT_A, { devices: [laptop], revoked: [tombstone("browser")] });
		expect(await mod.syncingLinkKeys()).toEqual([]);
	});

	it("isn't the sync device of another vault that is open now", async () => {
		const mod = await linked(VAULT_A);
		h.meta.set("active-vault", VAULT_B);
		setRoster(VAULT_B, { devices: [laptop, browser], revoked: [] });
		expect(await mod.syncingLinkKeys()).toEqual([]);
	});

	it("tells Settings when it is first seen syncing over its link", async () => {
		h.meta.set(VAULT_REGISTRY_KEY, registry(VAULT_A, VAULT_B));
		h.meta.set("active-vault", VAULT_A);
		setRoster(VAULT_A, { devices: [laptop, browser], revoked: [] });
		const mod = await loadRoster();
		const kinds: string[] = [];
		(await import("./bus")).onSyncEvent((e) => kinds.push(e.kind));
		await startSession(mod);
		const linkSession = h.starts[1] as unknown as {
			onAuthenticated: (pub: string, linkKey: string) => void;
		};
		linkSession.onAuthenticated("browserpub", "linkkey");
		await vi.waitFor(() => expect(kinds).toContain("roster"));
		const seen = kinds.filter((k) => k === "roster").length;
		linkSession.onAuthenticated("browserpub", "linkkey");
		await new Promise((r) => setTimeout(r, 20));
		expect(kinds.filter((k) => k === "roster")).toHaveLength(seen);
	});

	it("does nothing for a removed device that never synced over the link", async () => {
		const mod = await linked();
		setRoster(VAULT_A, {
			devices: [laptop, browser, member("phone", "phonepub")],
			revoked: [tombstone("phone")],
		});
		await mod.endRemovedLinks(VAULT_A);
		expect(h.ended).toEqual([]);
	});
});

describe("addToLocalRoster", () => {
	const member = (id: string, publicKey: string) => ({
		id,
		publicKey,
		label: id,
		addedAt: 1,
		hlc: { wall: 1, counter: 0, node: id },
	});

	it("does not let a joiner take a member's id under another key", async () => {
		const laptop = member("laptop", "laptoppub");
		h.meta.set(`sync.group:${VAULT_A}`, {
			groupKey: "k",
			roster: { devices: [laptop], revoked: [] },
		});
		const mod = await loadRoster();

		await mod.addToLocalRoster(VAULT_A, {
			...member("laptop", "attackerpub"),
			hlc: { wall: 9, counter: 0, node: "x" },
		});
		await mod.addToLocalRoster(VAULT_A, member("phone", "phonepub"));

		const group = h.meta.get(`sync.group:${VAULT_A}`) as {
			roster: { devices: { publicKey: string }[] };
		};
		expect(group.roster.devices.map((d) => d.publicKey).sort()).toEqual(["laptoppub", "phonepub"]);
	});
});
