// CryptoAdapter backed by the Rust process, not WASM. Every call is a Tauri command over
// IPC; the VEK lives in the shell and never enters this webview, which is the whole reason
// the desktop app is a Rust binary. See docs/desktop-port.md.
//
// The core's structs already serialize camelCase, so the command results land in the shapes
// @core/adapters/crypto declares and need no mapping.

import type {
	CryptoAdapter,
	EncryptedPayload,
	KdbxRawEntry,
	OpenKdbxInput,
	PasskeyAssertion,
	PasskeyImportResult,
	PasskeyRegistration,
	PasswordSlotBlob,
	SaveKdbxInput,
	UnwrapPasswordSlotInput,
	UnwrapWebauthnSlotInput,
	VekEncrypted,
	VerifyPasswordSlotInput,
	VerifyWebauthnSlotInput,
	WrapPasswordSlotInput,
	WrapWebauthnSlotInput,
} from "@core/adapters/crypto";
import { bytesToBase64 } from "@core/util/bytes";
import { invoke } from "@tauri-apps/api/core";
import { rawBytes } from "./files";
import { markLocked, markUnlocked, onExternalChange, onExternalLock } from "./vault-session";

/**
 * `magicVersion` is a Uint8Array in the adapter contract; Tauri's IPC is JSON, and the
 * command signature takes `Vec<u8>`, so it rides as a plain number array.
 */
function bytes(v: Uint8Array): number[] {
	return Array.from(v);
}

/** Phase 0 gaps. These throw rather than silently no-op so a wired-up UI fails loudly. */
function notWired(what: string): never {
	throw new Error(`${what} is not wired on desktop yet`);
}

export const desktopCrypto: CryptoAdapter = {
	// Single-process, single active vault for now, so there is no per-vault VEK map to
	// bind to (the extension needs one because its background serves every open view).
	// See docs/multiple-vaults.md "Per-vault VEK".

	// Every path that leaves the VEK loaded reports the transition, and only after the Rust
	// side confirms: roster sync runs on this signal, and a merge cannot decrypt anything
	// while locked. buildCryptoAdapter fires the same four for the platforms built on it;
	// this adapter is hand-written, so the four are marked individually. See ./vault-session.
	generateVek: async () => {
		const vek = await invoke<string>("crypto_generate_vek");
		markUnlocked();
		return vek;
	},
	unlockWithVek: async (vekB64) => {
		await invoke<void>("crypto_unlock_with_vek", { vekB64 });
		markUnlocked();
	},
	exportVek: () => invoke<string>("crypto_export_vek"),
	rotateVek: () => invoke<string>("crypto_rotate_vek"),
	lock: async () => {
		await invoke<void>("crypto_lock");
		markLocked();
	},
	isLocked: () => invoke<boolean>("crypto_is_locked"),

	// Sync merges write entries out of band, so the open list has to be told. A lock from
	// outside this webview (the spotlight window, an idle timeout in the shell) does not exist
	// yet; when it does it will emit a Tauri event that calls markLocked.
	onExternalLock,
	onExternalChange,

	generateSalt: () => invoke<string>("crypto_generate_salt"),
	generateSlotId: () => invoke<string>("crypto_generate_slot_id"),

	wrapVekPassword: (input: WrapPasswordSlotInput) =>
		invoke<PasswordSlotBlob>("crypto_wrap_vek_password", {
			password: input.password,
			saltB64: input.saltB64,
			slotIdB64: input.slotIdB64,
			magicVersion: bytes(input.magicVersion),
		}),
	// The ordinary unlock: a wrong password returns false rather than throwing, so the
	// transition is reported on the result, not on the call completing.
	unwrapVekPassword: async (input: UnwrapPasswordSlotInput) => {
		const ok = await invoke<boolean>("crypto_unwrap_vek_password", {
			password: input.password,
			saltB64: input.saltB64,
			slotIdB64: input.slotIdB64,
			verifierB64: input.verifierB64,
			wrapIvB64: input.wrapIvB64,
			wrappedVekB64: input.wrappedVekB64,
			magicVersion: bytes(input.magicVersion),
		});
		if (ok) markUnlocked();
		return ok;
	},
	verifyPasswordSlot: (input: VerifyPasswordSlotInput) =>
		invoke<boolean>("crypto_verify_password_slot", {
			password: input.password,
			saltB64: input.saltB64,
			slotIdB64: input.slotIdB64,
			verifierB64: input.verifierB64,
			magicVersion: bytes(input.magicVersion),
		}),

	// Wired because the core calls cost nothing, but `securityKeys` is off for desktop in
	// flags.ts: the webview has no usable WebAuthn, so nothing can produce an hmac-secret
	// until there is a native CTAP path.
	wrapVekWebauthn: (input: WrapWebauthnSlotInput) =>
		invoke<PasswordSlotBlob>("crypto_wrap_vek_webauthn", {
			hmacSecretB64: input.hmacSecretB64,
			slotIdB64: input.slotIdB64,
			magicVersion: bytes(input.magicVersion),
		}),
	unwrapVekWebauthn: async (input: UnwrapWebauthnSlotInput) => {
		const ok = await invoke<boolean>("crypto_unwrap_vek_webauthn", {
			hmacSecretB64: input.hmacSecretB64,
			slotIdB64: input.slotIdB64,
			verifierB64: input.verifierB64,
			wrapIvB64: input.wrapIvB64,
			wrappedVekB64: input.wrappedVekB64,
			magicVersion: bytes(input.magicVersion),
		});
		if (ok) markUnlocked();
		return ok;
	},
	verifyWebauthnSlot: (input: VerifyWebauthnSlotInput) =>
		invoke<boolean>("crypto_verify_webauthn_slot", {
			hmacSecretB64: input.hmacSecretB64,
			slotIdB64: input.slotIdB64,
			verifierB64: input.verifierB64,
			magicVersion: bytes(input.magicVersion),
		}),

	encryptEntry: (plaintextJson) =>
		invoke<EncryptedPayload>("crypto_encrypt_entry", { plaintextJson }),
	decryptEntry: (payload) => invoke<string>("crypto_decrypt_entry", { payload }),
	// One IPC round trip for the whole vault, not one per entry.
	decryptEntries: (payloads) => invoke<(string | null)[]>("crypto_decrypt_entries", { payloads }),
	encryptWithVek: (plaintext) => invoke<VekEncrypted>("crypto_encrypt_with_vek", { plaintext }),
	decryptWithVek: (iv, ciphertext) => invoke<string>("crypto_decrypt_with_vek", { iv, ciphertext }),
	mailboxId: (groupKeyB64) => invoke<string>("crypto_mailbox_id", { groupKeyB64 }),
	mailboxSeal: (groupKeyB64, aad, plaintext) =>
		invoke<string>("crypto_mailbox_seal", { groupKeyB64, aad, plaintext }),
	mailboxOpen: (groupKeyB64, aad, sealedB64) =>
		invoke<string>("crypto_mailbox_open", { groupKeyB64, aad, sealedB64 }),

	// Passkey PROVIDER (mint/assert for other sites) stays unwired, and not just for effort:
	// a Tauri webview has no WebAuthn surface to intercept and no OS registration, so there is
	// nothing here to serve. macOS gets it through an ASCredentialProviderExtension instead,
	// which is Swift calling this same core. See docs/macos-credential-provider.md.
	passkeyMakeCredential: (): Promise<PasskeyRegistration> => notWired("Passkey provider"),
	passkeyGetAssertion: (): Promise<PasskeyAssertion> => notWired("Passkey assertion"),

	// Importing them is a different question, and the answer is yes: desktop is a full sync
	// peer, so a passkey dropped here never reaches the user's phone or browser either.
	passkeyImportPkcs8: (pkcs8B64) =>
		invoke<PasskeyImportResult>("crypto_passkey_import_pkcs8", { pkcs8B64 }),

	// Rejects with a bare KDBX_* code string (Tauri rejects with the command's error, not an
	// Error object); `kdbxErrorMessage` reads either.
	//
	// The shell unpacks the attachments into a folder among the decrypted copies (swept on lock),
	// so the sealer reads each from a path and none crosses back into the webview.
	async openKdbx(input: OpenKdbxInput) {
		const opened = await invoke<{
			entries: KdbxRawEntry[];
			attachments: { path: string; size: number }[];
			dir: string;
		}>("crypto_open_kdbx", {
			fileB64: bytesToBase64(input.file),
			password: input.password,
			keyfileB64: input.keyfile ? bytesToBase64(input.keyfile) : undefined,
		});
		return {
			entries: opened.entries,
			attachments: opened.attachments.map(({ path, size }) => ({
				source: { kind: "path" as const, path, size },
				size,
			})),
			release: () => invoke<void>("files_discard_kdbx", { dir: opened.dir }),
		};
	},

	// The shell writes the database to a folder among the decrypted copies, opening each
	// attachment from the store there, and the save dialog's path gets a copy of that file:
	// neither the database nor an attachment crosses into the webview.
	async saveKdbx(input: SaveKdbxInput) {
		const saved = await invoke<{ path: string; size: number; dir: string }>("files_save_kdbx", {
			vaultId: input.vaultId,
			name: input.name,
			entries: input.entries,
			password: input.password,
			files: input.files.map(({ entry, record, name }) => ({
				entry,
				name,
				hash: record.hash,
				size: record.size,
				wrappedFek: record.wrappedFek,
				fekIv: record.fekIv,
				noncePrefix: record.noncePrefix,
			})),
		});
		return {
			size: saved.size,
			path: saved.path,
			read: (offset: number, length: number) =>
				rawBytes("files_read_kdbx", { path: saved.path, offset, length }),
			release: () => invoke<void>("files_discard_kdbx", { dir: saved.dir }),
		};
	},
};
