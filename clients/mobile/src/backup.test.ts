import type { BackupTargetConfig } from "@core/backup/config";
import type { ScheduledBackupDeps, VaultBackup } from "@core/backup/run";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Opportunistic backups. What is worth pinning is not the orchestration (that is @core's, and
// tested there) but the two things this file decides: that a run only happens with the vault
// open, and that the transport it builds signs here and sends natively.

const h = vi.hoisted(() => ({
	/** Lock listeners registered via onVaultStateChange. */
	stateListeners: [] as ((locked: boolean) => void)[],
	/** Capacitor App "resume" listeners. */
	resumeListeners: [] as (() => void)[],
	/** Deps the core runner was handed, so the test can drive them directly. */
	deps: null as ScheduledBackupDeps | null,
	runs: 0,
	targetsFor: {} as Record<string, unknown[]>,
	vaults: [{ id: "v1", isDefault: true }],
	decryptOk: true,
	createdWith: [] as { cfg: unknown; transport: unknown }[],
	signingCalls: [] as { cfg: unknown; send: unknown }[],
	/** Bodies runBackup was handed, to check what actually went up. */
	uploaded: [] as { size: number; read(o: number, l: number): Promise<Uint8Array> }[],
	/** When set, a decrypt of this ciphertext returns `payloadJson` (the vault's entries), and
	 * any other decrypt is a credential. */
	payloadCt: null as string | null,
	payloadJson: "",
	blobs: null as unknown,
}));

vi.mock("@capacitor/app", () => ({
	App: {
		addListener: async (name: string, cb: () => void) => {
			if (name === "resume") h.resumeListeners.push(cb);
			return { remove: () => {} };
		},
	},
}));

vi.mock("./adapters/vault-session", () => ({
	onVaultStateChange: (cb: (locked: boolean) => void) => {
		h.stateListeners.push(cb);
		return () => {};
	},
}));

vi.mock("./adapters/storage", () => ({
	mobileStorage: {
		getMeta: async (key: string) =>
			key.startsWith("backup.targets:")
				? (h.targetsFor[key.slice("backup.targets:".length)] ?? [])
				: { vaults: h.vaults },
		setMeta: async () => {},
		readVaultBlob: async () => new Uint8Array([1, 2, 3]),
	},
}));

vi.mock("./adapters/crypto", () => ({
	mobileCrypto: {
		decryptWithVek: async (_iv: string, ct: string) => {
			if (!h.decryptOk) throw new Error("aead::Error");
			if (h.payloadCt !== null && ct === h.payloadCt) return h.payloadJson;
			return JSON.stringify({ username: "u", password: "p" });
		},
	},
}));

vi.mock("./adapters/http", () => ({ mobileHttp: { send: async () => ({}) } }));

vi.mock("./adapters/files", () => ({
	mobileFiles: { forVault: () => ({ blobs: h.blobs }), deleteVault: async () => {} },
}));

vi.mock("@core/backup", () => ({
	sha256Hex: async () => "hash",
	createTarget: (cfg: unknown, transport: unknown) => {
		h.createdWith.push({ cfg, transport });
		return {};
	},
	signingTransport: (cfg: unknown, send: unknown) => {
		h.signingCalls.push({ cfg, send });
		return { send: async () => ({}) };
	},
	runBackup: async (
		_target: unknown,
		body: { size: number; read(o: number, l: number): Promise<Uint8Array> },
	) => {
		h.runs += 1;
		h.uploaded.push(body);
		return { hash: "hash" };
	},
}));

vi.mock("@core/backup/run", async (importOriginal) => ({
	...(await importOriginal<typeof import("@core/backup/run")>()),
	runScheduledBackups: async (deps: ScheduledBackupDeps) => {
		h.deps = deps;
		// Drive the parts this file owns, in the order the real runner does.
		for (const v of await deps.listVaults()) await deps.loadTargets(v.id);
		return { attempted: 0, succeeded: [], failed: [], skipped: 0 };
	},
}));

const { runDueBackups, startBackupRuns } = await import("./backup");

beforeEach(() => {
	h.stateListeners = [];
	h.resumeListeners = [];
	h.deps = null;
	h.runs = 0;
	h.decryptOk = true;
	h.createdWith = [];
	h.signingCalls = [];
	h.uploaded = [];
	h.payloadCt = null;
	h.blobs = null;
});

async function sha256(bytes: Uint8Array | string): Promise<string> {
	const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
	const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const VAULT: VaultBackup = { id: "v1", blob: new Uint8Array(), isDefault: true };
const TARGET = {
	id: "t1",
	provider: "webdav",
	keep: 3,
	serverUrl: "https://d.example/",
	frequency: "daily",
	creds: { iv: "i", ciphertext: "c" },
} as unknown as BackupTargetConfig;

const unlock = () => {
	for (const cb of h.stateListeners) cb(false);
};
const lock = () => {
	for (const cb of h.stateListeners) cb(true);
};

describe("mobile backup runs", () => {
	// The VEK is what a run needs, and while locked there isn't one. Running anyway would mean
	// decrypting against a key that is supposed to be gone.
	it("does nothing while the vault is locked", async () => {
		startBackupRuns();
		lock();
		await runDueBackups();
		expect(h.deps).toBeNull();
	});

	it("runs when the vault is unlocked", async () => {
		startBackupRuns();
		unlock();
		await runDueBackups();
		expect(h.deps).not.toBeNull();
	});

	// There is no background scheduler on either OS, so these two moments are the only ones.
	it("runs on unlock without being asked", async () => {
		startBackupRuns();
		expect(h.stateListeners).toHaveLength(1);
		unlock();
		await Promise.resolve();
		expect(h.deps).not.toBeNull();
	});

	it("listens for resume as well as unlock", () => {
		startBackupRuns();
		expect(h.resumeListeners).toHaveLength(1);
	});

	it("ignores a resume that arrives while locked", async () => {
		startBackupRuns();
		lock();
		for (const cb of h.resumeListeners) cb();
		await Promise.resolve();
		expect(h.deps).toBeNull();
	});

	// Auto-lock fires when the app is backgrounded, so a lock mid-run is normal. Nothing new starts
	// once locked, but what is already in hand is finished and recorded; backup.lock.test.ts drives
	// the real runner through it. Here: exactly which steps are gated.
	it("gates only starting a run and unwrapping a credential once locked", async () => {
		startBackupRuns();
		unlock();
		await runDueBackups();
		const deps = h.deps;
		if (!deps) throw new Error("the runner was never called");

		lock();
		expect(await deps.listVaults()).toEqual([]);
		expect(await deps.decryptSecrets("v1", { iv: "i", ciphertext: "c" })).toBeNull();
		// Reads, the hash and the save all still work, so a finished upload can be recorded...
		expect(await deps.loadTargets("v1")).toEqual([]);
		// A vault without attachments is fingerprinted by its own hash, as it always was.
		expect(await deps.hashVault(VAULT)).toBe(await sha256(VAULT.blob));
		// ...and an upload whose credential was already unwrapped is allowed to finish.
		await deps.upload("v1", TARGET, { username: "u", password: "p" }, VAULT);
		expect(h.runs).toBe(1);
	});

	// A target wrapped under another vault's key. Nothing is wrong with the run, so it is a skip
	// rather than a failure the user has to interpret.
	it("treats an unopenable credential as a skip, not an error", async () => {
		startBackupRuns();
		unlock();
		await runDueBackups();
		h.decryptOk = false;
		expect(await h.deps?.decryptSecrets("v1", { iv: "i", ciphertext: "c" })).toBeNull();
	});

	// The whole reason mobile can do this at all: signed here with the secret just unwrapped,
	// sent over the native transport, because the WebView cannot reach a provider.
	it("builds a target that signs here and sends over the native transport", async () => {
		startBackupRuns();
		unlock();
		await runDueBackups();
		await h.deps?.upload("v1", TARGET, { username: "u", password: "p" }, VAULT);
		expect(h.signingCalls).toHaveLength(1);
		expect(h.createdWith[0]?.transport).toBeDefined();
		expect(h.runs).toBe(1);
	});
});

describe("mobile backups carry the unlocked vault's attachments", () => {
	async function vaultWithAttachment() {
		const { fileRecord, fill, testVaultBytes } = await import("@core/test/vault-fixtures");
		const { bytesToBase64 } = await import("@core/util/bytes");
		const { memoryBlobStore } = await import("@core/test/memory-blob-store");
		const attachment = fill(80, 7);
		const hash = await sha256(attachment);
		const ciphertext = fill(40, 3);
		const blob = testVaultBytes(ciphertext);
		h.payloadCt = bytesToBase64(ciphertext);
		h.payloadJson = JSON.stringify({
			entries: [],
			tombstones: [],
			files: [fileRecord({ hash, size: attachment.length })],
		});
		const { store } = memoryBlobStore();
		await store.put(hash, attachment);
		h.blobs = store;
		return { vault: { id: "v1", blob, isDefault: true } as VaultBackup, attachment, hash };
	}

	it("uploads one archive holding the vault and its attachment", async () => {
		const { openBackup, restoreAttachments } = await import("@core/backup/archive");
		const { memoryBlobStore } = await import("@core/test/memory-blob-store");
		const { vault, attachment, hash } = await vaultWithAttachment();
		startBackupRuns();
		unlock();
		await runDueBackups();
		const deps = h.deps;
		if (!deps) throw new Error("the runner was never called");

		expect(await deps.blocked?.(vault)).toBeUndefined();
		await deps.upload("v1", TARGET, { username: "u", password: "p" }, vault);
		const body = h.uploaded[0];
		if (!body) throw new Error("nothing was uploaded");
		const read = await openBackup(body);
		if (read.kind !== "archive") throw new Error("expected an archive");
		expect(read.vault).toEqual(vault.blob);
		const back = memoryBlobStore().store;
		await restoreAttachments(back, body, read.attachments);
		expect(await back.read(hash)).toEqual(attachment);
		// Fingerprinted with the attachment, so a target that holds only the vault reruns.
		expect(await deps.hashVault(vault)).not.toBe(await sha256(vault.blob));
	});

	// Another vault's key cannot open the payload, and nothing remembers this vault's list: what
	// a complete backup holds is unknown, so it waits instead of going up without its files.
	it("waits, rather than back up the vault alone, when its payload will not open", async () => {
		const { vault } = await vaultWithAttachment();
		h.decryptOk = false;
		startBackupRuns();
		unlock();
		await runDueBackups();
		expect(await h.deps?.blocked?.(vault)).toEqual({ reason: "locked" });
		await expect(
			h.deps?.upload("v1", TARGET, { username: "u", password: "p" }, vault),
		).rejects.toThrow(/locked/);
		expect(h.uploaded).toHaveLength(0);
	});
});
