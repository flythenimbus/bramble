import { type BackupTargetConfig, backupTargetsKeyFor } from "@core/backup/config";
import { VAULT_REGISTRY_KEY } from "@core/vault/vault-registry";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A lock mid-run is the normal case on mobile: auto-lock fires when the app is backgrounded. This
// drives the REAL core runner rather than a mock, because the trap is in how the two meet: the
// runner re-reads the target list after uploading and saves a merged copy, so a read that
// answered "nothing" once locked, paired with a save that still wrote, would delete every target.

const h = vi.hoisted(() => ({
	meta: new Map<string, unknown>(),
	stateListeners: [] as ((locked: boolean) => void)[],
	/** Called inside the upload, i.e. after the credential was unwrapped. */
	duringUpload: () => {},
	uploads: 0,
}));

vi.mock("@capacitor/app", () => ({
	App: { addListener: async () => ({ remove: () => {} }) },
}));
vi.mock("./adapters/vault-session", () => ({
	onVaultStateChange: (cb: (locked: boolean) => void) => {
		h.stateListeners.push(cb);
		return () => {};
	},
}));
// A real, empty vault: a backup is made only when the vault's attachment list can be read, and
// an empty one reads as "none" without a key.
vi.mock("./adapters/storage", async () => {
	const f = await import("@core/vault-format");
	const zeros = (n: number) => new Uint8Array(n);
	const vault = f.encodeVaultBlob({
		slots: [
			{
				kind: f.SLOT_KIND_PASSWORD,
				slotId: zeros(f.LEN_SLOT_ID),
				salt: zeros(f.LEN_SALT),
				verifier: zeros(f.LEN_VERIFIER),
				wrapIv: zeros(f.LEN_WRAP_IV),
				wrappedVek: zeros(f.LEN_WRAPPED_VEK),
			},
		],
		entriesIv: zeros(f.LEN_IV),
		entriesCiphertext: zeros(0),
	});
	return {
		mobileStorage: {
			getMeta: async (key: string) => h.meta.get(key),
			setMeta: async (key: string, value: unknown) => void h.meta.set(key, value),
			readVaultBlob: async () => vault,
		},
	};
});
vi.mock("./adapters/crypto", () => ({
	mobileCrypto: { decryptWithVek: async () => JSON.stringify({ username: "u", password: "p" }) },
}));
vi.mock("./adapters/http", () => ({ mobileHttp: { send: async () => ({}) } }));
// An empty in-memory attachment store: the runner plans each vault's backup, and planning may
// list the store, which on the real adapter is Capacitor's filesystem and never answers here.
vi.mock("./adapters/files", async () => {
	const { memoryBlobStore } = await import("@core/test/memory-blob-store");
	const { store } = memoryBlobStore();
	return { mobileFiles: { forVault: () => ({ blobs: store }), deleteVault: async () => {} } };
});
// Only the network is faked; the runner, the due logic and the outcome folding are all real.
vi.mock("@core/backup", async (importOriginal) => ({
	...(await importOriginal<typeof import("@core/backup")>()),
	runBackup: async () => {
		h.duringUpload();
		h.uploads += 1;
		return { key: "k", hash: "h", uploaded: 3, prunedKeys: [] };
	},
}));

const { mobileBackupActivity, runDueBackups, startBackupRuns } = await import("./backup");

const TARGETS_KEY = backupTargetsKeyFor("v1");
const target = (id: string): BackupTargetConfig =>
	({
		id,
		providerId: "nextcloud",
		provider: "webdav",
		serverUrl: "https://dav.example/",
		frequency: "daily",
		keep: 3,
		creds: { iv: "i", ciphertext: "c" },
	}) as unknown as BackupTargetConfig;

const setLocked = (locked: boolean) => {
	for (const cb of h.stateListeners) cb(locked);
};

beforeEach(() => {
	h.meta = new Map<string, unknown>([
		[VAULT_REGISTRY_KEY, { vaults: [{ id: "v1", label: "", createdAt: 1 }] }],
		[TARGETS_KEY, [target("t1"), target("t2")]],
	]);
	h.stateListeners = [];
	h.uploads = 0;
	h.duringUpload = () => {};
	startBackupRuns();
});

const saved = () => h.meta.get(TARGETS_KEY) as BackupTargetConfig[];

/** Unlocking starts a run on its own (that is the feature), so tests unlock and then wait for the
 * run they triggered to record its outcome, rather than calling the runner a second time. */
async function unlockAndSettle(): Promise<void> {
	setLocked(false);
	await vi.waitFor(() => {
		if (!saved().some((t) => t.lastBackupAt != null || t.lastError != null))
			throw new Error("run not done");
	});
}

describe("a lock in the middle of a backup run", () => {
	beforeEach(() => {
		// The lock arrives while the first upload is in flight, as it does when the app is left.
		h.duringUpload = () => setLocked(true);
	});

	it("never deletes the target list", async () => {
		await unlockAndSettle();
		expect(
			saved()
				.map((t) => t.id)
				.sort(),
		).toEqual(["t1", "t2"]);
	});

	it("records the upload that finished after the lock", async () => {
		await unlockAndSettle();
		const done = saved().filter((t) => t.lastBackupAt != null);
		expect(done).toHaveLength(1);
		expect(done[0]?.lastError).toBeUndefined();
	});

	// The second target needed its credential unwrapped after the lock, and there is no key to do
	// it with. It is left due, untouched and error-free, for the next open to pick up.
	it("starts nothing new after the lock, and leaves the rest due without an error", async () => {
		await unlockAndSettle();
		expect(h.uploads).toBe(1);
		const pending = saved().filter((t) => t.lastBackupAt == null);
		expect(pending).toHaveLength(1);
		expect(pending[0]?.lastError).toBeUndefined();
	});

	it("does not start a run at all while locked", async () => {
		setLocked(true);
		await runDueBackups();
		expect(h.uploads).toBe(0);
	});
});

// What the settings screen shows while an automatic run is going: the target being uploaded, and
// nothing once it is done, whether it succeeded or not.
describe("activity", () => {
	it("reports the target while it uploads and clears it after", async () => {
		const seen: string[][] = [];
		const off = mobileBackupActivity.subscribe((ids) => seen.push([...ids]));
		let during: string[] = [];
		h.duringUpload = () => {
			during = seen.at(-1) ?? [];
		};
		await unlockAndSettle();
		off();
		expect(during).toHaveLength(1);
		expect(seen.at(-1)).toEqual([]);
	});
});
