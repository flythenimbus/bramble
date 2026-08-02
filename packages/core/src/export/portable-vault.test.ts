import { describe, expect, it, vi } from "vitest";
import type { EntryData } from "../hooks/useVault";
import type { PortableVaultBlob } from "../wasm";
import {
	openPortableVaultFile,
	readPortableVaultFile,
	sealPortableVaultFile,
} from "./portable-vault";

// The crypto is pinned natively (core-rust portable_vault_tests). What these cover is the
// TS half: that the sealed pieces survive a trip through the real VLT1 encoder and come
// back byte-identical, so a file this writes is one the reader can take apart.

const b64 = (n: number, len: number) => btoa(String.fromCharCode(...new Uint8Array(len).fill(n)));

const sealed: PortableVaultBlob = {
	slotId: b64(0x10, 16),
	salt: b64(0x20, 16),
	verifier: b64(0x30, 32),
	wrapIv: b64(0x40, 12),
	wrappedVek: b64(0x50, 48),
	entriesIv: b64(0x60, 12),
	entriesCiphertext: b64(0x70, 64),
};

const login = (name: string): EntryData => ({
	type: "login",
	name,
	urls: [],
	username: "u",
	password: "p",
});

function fakeCrypto() {
	return {
		sealPortableVault: vi.fn(async (_input: { entriesJson: string; password: string }) => sealed),
		openPortableVault: vi.fn(async () => JSON.stringify({ entries: [login("a")] })),
	};
}

describe("sealPortableVaultFile", () => {
	it("frames the sealed pieces so the reader gets them back unchanged", async () => {
		const crypto = fakeCrypto();
		const bytes = await sealPortableVaultFile(crypto, [login("a")], "file-pw");
		expect(readPortableVaultFile(bytes)).toEqual(sealed);
	});

	it("hands the core the entries as JSON, with the file password", async () => {
		const crypto = fakeCrypto();
		await sealPortableVaultFile(crypto, [login("a"), login("b")], "file-pw");
		const arg = crypto.sealPortableVault.mock.calls[0]?.[0];
		if (!arg) throw new Error("the core was never asked to seal anything");
		expect(arg.password).toBe("file-pw");
		expect(JSON.parse(arg.entriesJson).entries).toHaveLength(2);
	});

	// importMany builds `{ id, ...data }` over an id it has already stamped, so an id left in
	// the payload overwrites it and the write dies on "missing sync stamp for entry <id>".
	it("strips vault-local ids, which would collide with the ones the importer mints", async () => {
		const crypto = fakeCrypto();
		await sealPortableVaultFile(crypto, [{ ...login("a"), id: "vault-local" }], "pw");
		const arg = crypto.sealPortableVault.mock.calls[0]?.[0];
		if (!arg) throw new Error("the core was never asked to seal anything");
		expect(JSON.parse(arg.entriesJson).entries[0]).not.toHaveProperty("id");
	});

	it("refuses where the platform has no sealing call", async () => {
		await expect(sealPortableVaultFile({}, [login("a")], "pw")).rejects.toThrow(/isn't available/);
	});
});

describe("readPortableVaultFile", () => {
	it("returns null for bytes that aren't a vault blob", () => {
		expect(readPortableVaultFile(new Uint8Array([1, 2, 3, 4]))).toBeNull();
	});
});

describe("openPortableVaultFile", () => {
	it("returns the entries the core decrypted", async () => {
		const crypto = fakeCrypto();
		const entries = await openPortableVaultFile(crypto, sealed, "pw");
		expect(entries?.map((e) => e.name)).toEqual(["a"]);
	});

	// null, not a throw, so the dialog can say "wrong password" rather than "corrupt file".
	it("returns null for a wrong password", async () => {
		const crypto = { openPortableVault: vi.fn(async () => null) };
		expect(await openPortableVaultFile(crypto, sealed, "wrong")).toBeNull();
	});

	// A full backup decrypts fine but its entries are still sealed under per-entry DEKs.
	// Importing them would write entries whose every field is ciphertext.
	it("refuses a full vault backup rather than importing ciphertext", async () => {
		const crypto = {
			openPortableVault: vi.fn(async () =>
				JSON.stringify({ entries: [{ id: "a", ciphertext: "x", iv: "y" }] }),
			),
		};
		await expect(openPortableVaultFile(crypto, sealed, "pw")).rejects.toThrow(/full vault backup/);
	});
});
