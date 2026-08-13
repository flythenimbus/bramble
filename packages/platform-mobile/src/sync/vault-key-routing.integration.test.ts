import { existsSync, readFileSync } from "node:fs";
import type { CryptoAdapter } from "@core/adapters/crypto";
import { buildCryptoAdapter } from "@core/adapters/crypto-wasm";
import type { StorageAdapter } from "@core/adapters/storage";
import { emptyEntriesPayload } from "@core/sync/entries-payload";
import { bytesToBase64 } from "@core/util/bytes";
import { buildVaultBytes, wrapPasswordSlot } from "@core/vault/build-vault";
import { createEntriesBlobStore } from "@core/vault/entries-blob";
import { decryptEntriesOrRecover } from "@core/vault/recover-entries";
import { decodeVaultBlob, findPasswordSlot, verifierPrefix } from "@core/vault-format";
import type { VaultCrypto } from "@core/wasm";
import { beforeAll, describe, expect, it } from "vitest";

// Integration test for issue #27, with REAL crypto and no mocks below the storage line.
//
// The unit tests around this fix stub decryptWithVek, so they verify the fix's mechanism but
// could never have found the defect. This loads the actual WASM module, which holds ONE
// process-global VEK slot exactly as mobile's Rust core does: generate_vek() for a second vault
// orphans the first vault's ciphertext in-process, reproducing `aes decrypt: aead::Error` for
// real. That makes the corruption itself reproducible here, not just its symptoms.
//
// What is real: the crypto, the vault format, slot wrap/unwrap (Argon2id), the entries-blob
// store, and the recovery path. What is faked: the filesystem (in-memory) and the network.

const WASM_DIR = `${process.cwd()}/../platform-extension/public/wasm`;

let wasm: VaultCrypto;
let crypto: CryptoAdapter;

beforeAll(async () => {
	if (!existsSync(`${WASM_DIR}/vault_crypto.js`))
		throw new Error(`no WASM at ${WASM_DIR} (gitignored artifact): run \`pnpm run wasm:build\``);
	const mod = await import(`${WASM_DIR}/vault_crypto.js`);
	await mod.default({ module_or_path: readFileSync(`${WASM_DIR}/vault_crypto_bg.wasm`) });
	wasm = mod as unknown as VaultCrypto;
	crypto = buildCryptoAdapter(async () => wasm);
}, 30_000);

/** In-memory stand-in for the mobile storage adapter: one blob + one .bak per vault id. */
function memoryStorage() {
	const blobs = new Map<string, Uint8Array>();
	const baks = new Map<string, Uint8Array>();
	const storage = {
		readVaultBlob: async (vaultId?: string) => {
			const b = blobs.get(vaultId ?? "");
			if (!b) throw new Error(`no blob for ${vaultId}`);
			return b;
		},
		writeVaultBlob: async (blob: Uint8Array, vaultId?: string) => {
			if (!vaultId) throw new Error("writeVaultBlob: no vault id"); // mirrors the real refusal
			const prev = blobs.get(vaultId);
			if (prev) baks.set(vaultId, prev); // snapshot before truncating, like the real adapter
			blobs.set(vaultId, blob);
		},
		readVaultBackup: async (vaultId?: string) => baks.get(vaultId ?? "") ?? null,
		restoreVaultFromBackup: async (vaultId?: string) => {
			const bak = baks.get(vaultId ?? "");
			if (!bak) return false;
			blobs.set(vaultId ?? "", bak);
			return true;
		},
	};
	return { storage, blobs, baks };
}

/** Build a real vault: fresh VEK, a password slot wrapping it, entries sealed under it. */
async function createVault(password: string) {
	const vek = await crypto.generateVek(); // swaps the global slot, exactly like the app
	const slot = await wrapPasswordSlot(crypto, password);
	const bytes = await buildVaultBytes(crypto, [slot], emptyEntriesPayload());
	return { vek, bytes };
}

/** The real unlock: unwrap the password slot, then decrypt the entries payload. */
async function unlock(bytes: Uint8Array, password: string) {
	const blob = decodeVaultBlob(bytes);
	const slot = findPasswordSlot(blob);
	if (!slot) throw new Error("no password slot");
	const ok = await crypto.unwrapVekPassword({
		password,
		saltB64: bytesToBase64(slot.salt),
		slotIdB64: bytesToBase64(slot.slotId),
		verifierB64: bytesToBase64(slot.verifier),
		wrapIvB64: bytesToBase64(slot.wrapIv),
		wrappedVekB64: bytesToBase64(slot.wrappedVek),
		magicVersion: verifierPrefix(),
	});
	// A false here is a WRONG PASSWORD (the HMAC verifier failed). A throw from the decrypt
	// below is the issue-#27 signature: right password, entries under a different key.
	if (!ok) throw new Error("Incorrect master password");
	return crypto.decryptWithVek(
		bytesToBase64(blob.entriesIv),
		bytesToBase64(blob.entriesCiphertext),
	);
}

const PW_A = "vault-a-master-pw";
const PW_B = "vault-b-master-pw";

describe("the hazard is real in this harness", () => {
	it("a second vault's generateVek orphans the first vault's ciphertext", async () => {
		// Guards the test itself: if this ever stops throwing, the harness no longer shares one
		// global key and every assertion below would pass vacuously.
		const a = await createVault(PW_A);
		const sealedUnderA = await crypto.encryptWithVek("secret");

		await crypto.generateVek(); // vault B

		await expect(crypto.decryptWithVek(sealedUnderA.iv, sealedUnderA.ciphertext)).rejects.toThrow(
			/aead|decrypt/i,
		);
		// And vault A's own file is still fine — nothing has written to it yet.
		await expect(unlock(a.bytes, PW_A)).resolves.toBeTruthy();
	}, 30_000);
});

describe("issue #27: a merge must not seal into a vault whose slots wrap another key", () => {
	it("the guard refuses the mis-keyed write, and vault A still unlocks afterwards", async () => {
		const { storage, blobs } = memoryStorage();
		const a = await createVault(PW_A);
		blobs.set("A", a.bytes);
		const before = blobs.get("A");

		// A store pinned to vault A, as the fixed sync manager builds it.
		const store = createEntriesBlobStore({
			crypto,
			storage: {
				writeVaultBlob: async (blob) => storage.writeVaultBlob(blob, "A"),
			} as Pick<StorageAdapter, "writeVaultBlob">,
			readDecodedBlob: async () => ({ blob: decodeVaultBlob(await storage.readVaultBlob("A")) }),
			verifyVekBeforeWrite: true,
		});

		// The corruption trigger: another vault's key is now loaded globally.
		await crypto.generateVek();

		await expect(store.writeEntriesBlob(emptyEntriesPayload())).rejects.toThrow(
			/doesn't match this vault's existing entries/i,
		);

		// The file is byte-identical and the real password still opens it. This is the assertion
		// the whole fix exists for.
		expect(blobs.get("A")).toEqual(before);
		await expect(unlock(a.bytes, PW_A)).resolves.toBeTruthy();
	}, 60_000);

	it("without the guard, the same sequence bricks the vault under BOTH credentials", async () => {
		// The bug, demonstrated. Not a regression guard — it pins WHY the guard has to exist, and
		// proves this harness can actually produce the reported failure.
		const { storage, blobs } = memoryStorage();
		const a = await createVault(PW_A);
		blobs.set("A", a.bytes);

		const unguarded = createEntriesBlobStore({
			crypto,
			storage: {
				writeVaultBlob: async (blob) => storage.writeVaultBlob(blob, "A"),
			} as Pick<StorageAdapter, "writeVaultBlob">,
			readDecodedBlob: async () => ({ blob: decodeVaultBlob(await storage.readVaultBlob("A")) }),
		});

		await crypto.generateVek(); // vault B's key is loaded
		await unguarded.writeEntriesBlob(emptyEntriesPayload()); // seals under B into A's file

		const corrupted = blobs.get("A");
		if (!corrupted) throw new Error("expected a blob");
		// The password is ACCEPTED (the verifier passes) and the decrypt then fails — precisely
		// what the reporter saw, and why a recovery code was no help either.
		await expect(unlock(corrupted, PW_A)).rejects.toThrow(/aead|decrypt/i);
		await expect(unlock(corrupted, PW_A)).rejects.not.toThrow(/Incorrect master password/);
	}, 60_000);
});

describe("issue #27 recovery: un-bricking from the pre-write snapshot", () => {
	it("restores a vault the live key can't open, using the snapshot taken before the bad write", async () => {
		const { storage, blobs, baks } = memoryStorage();
		const a = await createVault(PW_A);
		blobs.set("A", a.bytes);

		// Damage it exactly as the bug did, which also leaves a good .bak behind.
		const unguarded = createEntriesBlobStore({
			crypto,
			storage: {
				writeVaultBlob: async (blob) => storage.writeVaultBlob(blob, "A"),
			} as Pick<StorageAdapter, "writeVaultBlob">,
			readDecodedBlob: async () => ({ blob: decodeVaultBlob(await storage.readVaultBlob("A")) }),
		});
		await crypto.generateVek();
		await unguarded.writeEntriesBlob(emptyEntriesPayload());
		expect(baks.get("A")).toEqual(a.bytes); // the good copy survived

		// Unlock A for real: the slot unwrap loads VEK_A, then the entries fail.
		const live = decodeVaultBlob(blobs.get("A")!);
		const slot = findPasswordSlot(live)!;
		await crypto.unwrapVekPassword({
			password: PW_A,
			saltB64: bytesToBase64(slot.salt),
			slotIdB64: bytesToBase64(slot.slotId),
			verifierB64: bytesToBase64(slot.verifier),
			wrapIvB64: bytesToBase64(slot.wrapIv),
			wrappedVekB64: bytesToBase64(slot.wrappedVek),
			magicVersion: verifierPrefix(),
		});

		const payload = await decryptEntriesOrRecover(
			{
				crypto,
				storage: {
					readVaultBackup: () => storage.readVaultBackup("A"),
					restoreVaultFromBackup: () => storage.restoreVaultFromBackup("A"),
				},
			},
			live,
		);

		expect(JSON.parse(payload)).toEqual(emptyEntriesPayload());
		// The live file was replaced with the verified snapshot, so a plain unlock works now.
		await expect(unlock(blobs.get("A")!, PW_A)).resolves.toBeTruthy();
	}, 60_000);

	it("leaves a damaged vault untouched when the snapshot is no better", async () => {
		const { storage, blobs, baks } = memoryStorage();
		const a = await createVault(PW_A);
		blobs.set("A", a.bytes);
		// A snapshot from a DIFFERENT vault: decodes fine, but its entries need another key.
		const b = await createVault(PW_B);
		baks.set("A", b.bytes);

		const live = decodeVaultBlob(blobs.get("A")!);
		const slot = findPasswordSlot(live)!;
		await crypto.unwrapVekPassword({
			password: PW_A,
			saltB64: bytesToBase64(slot.salt),
			slotIdB64: bytesToBase64(slot.slotId),
			verifierB64: bytesToBase64(slot.verifier),
			wrapIvB64: bytesToBase64(slot.wrapIv),
			wrappedVekB64: bytesToBase64(slot.wrappedVek),
			magicVersion: verifierPrefix(),
		});
		// Corrupt the live copy AFTER unlocking, so the live key is A's but the entries aren't.
		const damaged = decodeVaultBlob(b.bytes);
		const stitched = {
			...live,
			entriesIv: damaged.entriesIv,
			entriesCiphertext: damaged.entriesCiphertext,
		};

		await expect(
			decryptEntriesOrRecover(
				{
					crypto,
					storage: {
						readVaultBackup: () => storage.readVaultBackup("A"),
						restoreVaultFromBackup: () => storage.restoreVaultFromBackup("A"),
					},
				},
				stitched,
			),
		).rejects.toThrow(/aead|decrypt/i);

		// Nothing was swapped in: the live file is still what it was.
		expect(blobs.get("A")).toEqual(a.bytes);
	}, 60_000);
});
