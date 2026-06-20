import { describe, expect, it, vi } from "vitest";
import type { VaultCrypto } from "../wasm";
import { buildCryptoAdapter } from "./crypto-wasm";

// A fake wasm module: each method records its args and returns a marker so we can
// assert the adapter maps method -> wasm call with the right positional args. Stays
// strongly typed (a record of vi mocks) so `.mock` is visible; cast to VaultCrypto
// only when handing it to buildCryptoAdapter.
function fakeWasm() {
	return {
		is_locked: vi.fn(() => false),
		lock: vi.fn(),
		generate_vek: vi.fn(() => "vek"),
		unlock_with_vek: vi.fn(),
		export_vek: vi.fn(() => "exported"),
		rotate_vek: vi.fn(() => "rotated"),
		generate_salt: vi.fn(() => "salt"),
		generate_slot_id: vi.fn(() => "slot"),
		wrap_vek_password: vi.fn(() => ({ verifier: "v", wrapIv: "wi", wrappedVek: "wv" })),
		unwrap_vek_password: vi.fn(() => true),
		verify_password_slot: vi.fn(() => true),
		wrap_vek_webauthn: vi.fn(() => ({ verifier: "v", wrapIv: "wi", wrappedVek: "wv" })),
		unwrap_vek_webauthn: vi.fn(() => true),
		verify_webauthn_slot: vi.fn(() => true),
		encrypt_entry: vi.fn(() => ({ ciphertext: "c", iv: "i", wrappedDek: "wd", dekIv: "di" })),
		decrypt_entry: vi.fn(() => "plain"),
		encrypt_with_vek: vi.fn(() => ({ iv: "i", ciphertext: "c" })),
		decrypt_with_vek: vi.fn(() => "plain"),
		open_kdbx4: vi.fn((_file: Uint8Array, _password: string, _keyfile?: Uint8Array) => [
			{ strings: [] },
		]),
	};
}

const asWasm = (w: ReturnType<typeof fakeWasm>) => async () => w as unknown as VaultCrypto;

describe("buildCryptoAdapter", () => {
	const magicVersion = new Uint8Array([1, 0]);

	it("maps each method onto the wasm call with positional args", async () => {
		const wasm = fakeWasm();
		const a = buildCryptoAdapter(asWasm(wasm));

		expect(await a.generateVek()).toBe("vek");
		expect(await a.exportVek()).toBe("exported");
		expect(await a.rotateVek()).toBe("rotated");
		expect(await a.isLocked()).toBe(false);
		await a.unlockWithVek("v");
		expect(wasm.unlock_with_vek).toHaveBeenCalledWith("v");

		await a.wrapVekPassword({ password: "p", saltB64: "s", slotIdB64: "id", magicVersion });
		expect(wasm.wrap_vek_password).toHaveBeenCalledWith("p", "s", "id", magicVersion);

		await a.unwrapVekPassword({
			password: "p",
			saltB64: "s",
			slotIdB64: "id",
			verifierB64: "ver",
			wrapIvB64: "wi",
			wrappedVekB64: "wv",
			magicVersion,
		});
		expect(wasm.unwrap_vek_password).toHaveBeenCalledWith(
			"p",
			"s",
			"id",
			"ver",
			"wi",
			"wv",
			magicVersion,
		);

		await a.decryptEntry({ ciphertext: "c", iv: "i", wrappedDek: "wd", dekIv: "di" });
		expect(wasm.decrypt_entry).toHaveBeenCalledWith("c", "i", "wd", "di");
		await a.decryptWithVek("iv", "ct");
		expect(wasm.decrypt_with_vek).toHaveBeenCalledWith("iv", "ct");
	});

	it("decodes base64 inputs for openKdbx", async () => {
		const wasm = fakeWasm();
		const a = buildCryptoAdapter(asWasm(wasm));
		await a.openKdbx({ fileB64: "AAAA", password: "pw", keyfileB64: "AQID" });
		const call = wasm.open_kdbx4.mock.calls[0];
		if (!call) throw new Error("open_kdbx4 was not called");
		const [file, password, keyfile] = call;
		expect(file).toBeInstanceOf(Uint8Array);
		expect(password).toBe("pw");
		expect(keyfile).toBeInstanceOf(Uint8Array);
	});

	it("fires onUnlocked on unlock paths and onLocked on lock", async () => {
		const onUnlocked = vi.fn();
		const onLocked = vi.fn();
		const wasm = fakeWasm();
		const a = buildCryptoAdapter(asWasm(wasm), { onUnlocked, onLocked });

		await a.generateVek();
		await a.unlockWithVek("v");
		await a.unwrapVekPassword({
			password: "p",
			saltB64: "s",
			slotIdB64: "id",
			verifierB64: "ver",
			wrapIvB64: "wi",
			wrappedVekB64: "wv",
			magicVersion,
		});
		expect(onUnlocked).toHaveBeenCalledTimes(3);

		await a.lock();
		expect(onLocked).toHaveBeenCalledTimes(1);
	});

	it("does NOT fire onUnlocked when an unwrap fails (wrong password)", async () => {
		const onUnlocked = vi.fn();
		const wasm = fakeWasm();
		wasm.unwrap_vek_password = vi.fn(() => false);
		const a = buildCryptoAdapter(asWasm(wasm), { onUnlocked });
		const ok = await a.unwrapVekPassword({
			password: "wrong",
			saltB64: "s",
			slotIdB64: "id",
			verifierB64: "ver",
			wrapIvB64: "wi",
			wrappedVekB64: "wv",
			magicVersion,
		});
		expect(ok).toBe(false);
		expect(onUnlocked).not.toHaveBeenCalled();
	});

	it("verify* does not load the VEK, so it never fires onUnlocked", async () => {
		const onUnlocked = vi.fn();
		const wasm = fakeWasm();
		const a = buildCryptoAdapter(asWasm(wasm), { onUnlocked });
		await a.verifyPasswordSlot({
			password: "p",
			saltB64: "s",
			slotIdB64: "id",
			verifierB64: "ver",
			magicVersion,
		});
		expect(onUnlocked).not.toHaveBeenCalled();
	});
});
