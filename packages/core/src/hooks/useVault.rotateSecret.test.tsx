/** @vitest-environment happy-dom */
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "../context/PlatformContext";
import { mountVaultActions } from "../test/vault-harness";
import { VAULT_REGISTRY_KEY } from "../vault/vault-registry";

afterEach(cleanup);

// Rotating the vault key is the one operation here that can leave a vault nobody can open: the old
// key is replaced in memory, so anything not re-sealed before that becomes unreadable, and the
// slots and the entries have to end up in the SAME file. These pin the ordering and the rollback,
// which is where an unrecoverable bug would live rather than in the crypto itself.

const b64 = (n: number) => btoa(String.fromCharCode(...new Uint8Array(n).fill(7)));

// The on-disk byte layout is not under test; routing and ordering are. Held in a module variable
// the mock reads, so each harness can seed the slots it wants.
let blobForRead: unknown = null;

vi.mock("../vault-format", async (importOriginal) => ({
	...(await importOriginal<typeof import("../vault-format")>()),
	decodeVaultBlob: () => blobForRead,
	encodeVaultBlob: () => new Uint8Array([1, 2, 3]),
}));

interface Harness {
	platform: Platform;
	writes: number;
	restores: number;
	locks: number;
	rotated: number;
	/** Ordered log, so "sealed before written" is assertable rather than assumed. */
	steps: string[];
}

function makePlatform(over: { failVerify?: boolean; failWrite?: boolean } = {}): Harness {
	const h: Harness = {
		platform: null as unknown as Platform,
		writes: 0,
		restores: 0,
		locks: 0,
		rotated: 0,
		steps: [],
	};
	const registry = { vaults: [{ id: "v1", label: "", createdAt: 1 }] };
	// A blob with one password slot and some entries ciphertext, which is all rotation reads.
	const blob = {
		slots: [
			{
				kind: 1,
				slotId: new Uint8Array(16).fill(1),
				salt: new Uint8Array(16).fill(2),
				verifier: new Uint8Array(32).fill(3),
				wrapIv: new Uint8Array(12).fill(4),
				wrappedVek: new Uint8Array(48).fill(5),
			},
		],
		entriesIv: new Uint8Array(12).fill(6),
		entriesCiphertext: new Uint8Array(32).fill(7),
	};
	const storage = {
		hasVaultHandle: vi.fn(async () => true),
		getMeta: vi.fn(async (k: string) => (k === VAULT_REGISTRY_KEY ? registry : undefined)),
		setMeta: vi.fn(async () => {}),
		readVaultBlob: vi.fn(async () => new Uint8Array([1])),
		writeVaultBlob: vi.fn(async () => {
			h.writes++;
			h.steps.push("write");
			if (over.failWrite) throw new Error("disk full");
		}),
		restoreVaultFromBackup: vi.fn(async () => {
			h.restores++;
			h.steps.push("restore");
			return true;
		}),
	};
	const crypto = {
		isLocked: vi.fn(async () => false),
		onExternalLock: vi.fn(() => () => {}),
		onExternalChange: vi.fn(() => () => {}),
		// The same call verifies the password up front AND the slot after writing, so failing it
		// outright would never get as far as a write. Pass the pre-flight, fail the post-write one.
		verifyPasswordSlot: vi.fn(async () => {
			if (!over.failVerify) return true;
			return !h.steps.includes("write");
		}),
		rotateVek: vi.fn(async () => {
			h.rotated++;
			h.steps.push("rotate");
			return b64(32);
		}),
		lock: vi.fn(async () => {
			h.locks++;
			h.steps.push("lock");
		}),
		generateSalt: vi.fn(async () => b64(16)),
		generateSlotId: vi.fn(async () => b64(16)),
		wrapVekPassword: vi.fn(async () => ({
			verifier: b64(32),
			wrapIv: b64(12),
			wrappedVek: b64(48),
		})),
		encryptEntry: vi.fn(async () => ({
			ciphertext: b64(16),
			iv: b64(12),
			wrappedDek: b64(48),
			dekIv: b64(12),
		})),
		encryptWithVek: vi.fn(async () => {
			h.steps.push("seal");
			return { iv: b64(12), ciphertext: b64(32) };
		}),
		decryptWithVek: vi.fn(async () => JSON.stringify({ entries: [], tombstones: [] })),
		decryptEntries: vi.fn(async () => []),
	};
	h.platform = {
		storage,
		crypto,
		autofill: { clearIndex: vi.fn(async () => {}), setIndex: vi.fn(async () => {}) },
		shell: {
			setActiveVault: vi.fn(async () => {}),
			getActiveVault: vi.fn(async () => "v1"),
			flushPendingCornerCapture: vi.fn(async () => {}),
			stopSyncSpike: vi.fn(async () => {}),
		},
		clipboard: {},
	} as unknown as Platform;
	blobForRead = blob;
	return h;
}

async function actions(h: Harness) {
	const get = mountVaultActions(h.platform);
	await act(async () => {});
	return get;
}

describe("rotateSecret", () => {
	it("re-seals the entries BEFORE the single write, and writes once", async () => {
		// Order is the correctness argument: the new key exists only in memory, so the entries have
		// to be re-sealed under it and land in the same file as the new slots. Two writes would
		// leave a vault whose slots open with the new key and whose entries only open with the old,
		// with the backup already spent on the first.
		const h = makePlatform();
		const get = await actions(h);

		await act(async () => {
			await get()
				.rotateSecret("hunter2")
				.catch(() => {});
		});

		expect(h.rotated).toBe(1);
		expect(h.writes).toBe(1);
		expect(h.steps.indexOf("rotate")).toBeLessThan(h.steps.indexOf("seal"));
		expect(h.steps.indexOf("seal")).toBeLessThan(h.steps.indexOf("write"));
	});

	it("returns a fresh recovery code, because the old one can no longer work", async () => {
		const h = makePlatform();
		const get = await actions(h);

		let code = "";
		await act(async () => {
			code = await get().rotateSecret("hunter2");
		});

		expect(code.length).toBeGreaterThan(0);
	});

	it("restores and locks when the written vault does not verify", async () => {
		// The dangerous failure: a file on disk that cannot be opened. Restoring is half of the
		// recovery; locking is the other half, because the key held in memory is the new one and
		// the restored file knows nothing about it.
		const h = makePlatform({ failVerify: true });
		const get = await actions(h);

		await act(async () => {
			await expect(get().rotateSecret("hunter2")).rejects.toThrow(/nothing was changed/i);
		});

		expect(h.restores).toBe(1);
		expect(h.locks).toBe(1);
	});

	it("restores when the write itself fails", async () => {
		const h = makePlatform({ failWrite: true });
		const get = await actions(h);

		await act(async () => {
			await expect(get().rotateSecret("hunter2")).rejects.toThrow(/nothing was changed/i);
		});

		expect(h.restores).toBe(1);
		expect(h.locks).toBe(1);
	});

	it("refuses a wrong password without touching the key", async () => {
		const h = makePlatform();
		h.platform.crypto.verifyPasswordSlot = vi.fn(async () => false);
		const get = await actions(h);

		await act(async () => {
			await expect(get().rotateSecret("wrong")).rejects.toThrow(/incorrect/i);
		});

		expect(h.rotated).toBe(0);
		expect(h.writes).toBe(0);
	});
});
