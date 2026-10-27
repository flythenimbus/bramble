// Native crypto loader: backs the @core VaultCrypto surface with the in-house
// NativeCrypto Capacitor plugin (the shared Rust core via uniffi), instead of the
// in-webview WASM module. Used on device so the vault works under iOS Lockdown Mode
// (native code needs no JIT) and so the autofill extension shares the same crypto.
// Byte-array args (magicVersion, KDBX files) cross the bridge as base64.

import { registerPlugin } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import type {
	EncryptedPayload,
	PasskeyAssertion,
	PasskeyImportResult,
	PasskeyRegistration,
	PasswordSlotBlob,
	VekEncrypted,
} from "@core/adapters/crypto";
import { bytesToBase64 } from "@core/util/bytes";
import type { PortableVaultBlob, VaultCrypto } from "@core/wasm";
import { pathFromUri } from "./adapters/paths";

type KdbxEntry = {
	strings: { key: string; value: string; protected: boolean }[];
	binaries: { name: string; index: number }[];
};

/**
 * A fresh cache folder for one KeePass import's attachments or one export: among the decrypted
 * copies, which the lock sweeps (see file-presenter.ts), so nothing outlives a session that ends
 * partway. Gives its absolute path, and the call that deletes it.
 */
export async function newKdbxFolder(): Promise<{ path: string; release: () => Promise<void> }> {
	const folder = `open/kdbx-${globalThis.crypto.randomUUID()}`;
	await Filesystem.mkdir({ path: folder, directory: Directory.Cache, recursive: true });
	const { uri } = await Filesystem.getUri({ path: folder, directory: Directory.Cache });
	return {
		path: pathFromUri(uri),
		release: () =>
			Filesystem.rmdir({ path: folder, directory: Directory.Cache, recursive: true }).then(
				() => {},
				() => {},
			),
	};
}

interface SealedFileBlobJs {
	hash: string;
	size: number;
	noncePrefix: string;
	wrappedFek: string;
	fekIv: string;
	metaBlob: string;
	metaIv: string;
}

interface NativeCryptoPlugin {
	// File attachments: PATHS cross this bridge, never file bytes. See docs/file-attachments.md.
	sealFile(o: { srcPath: string; dstPath: string; metaJson: string }): Promise<SealedFileBlobJs>;
	resealFileMeta(o: {
		wrappedFekB64: string;
		fekIvB64: string;
		metaJson: string;
	}): Promise<{ iv: string; ciphertext: string }>;
	openFileMeta(o: {
		wrappedFekB64: string;
		fekIvB64: string;
		metaBlobB64: string;
		metaIvB64: string;
	}): Promise<{ value: string }>;
	openFileToPath(o: {
		wrappedFekB64: string;
		fekIvB64: string;
		noncePrefixB64: string;
		srcPath: string;
		dstPath: string;
	}): Promise<{ value: number }>;
	openFileChunk(o: {
		wrappedFekB64: string;
		fekIvB64: string;
		noncePrefixB64: string;
		srcPath: string;
		index: number;
	}): Promise<{ value: string }>;
	/** A byte range of a file, base64: Capacitor's Filesystem only reads whole files. */
	readFileRange(o: { path: string; offset: number; length: number }): Promise<{ value: string }>;
	isLocked(): Promise<{ value: boolean }>;
	lock(): Promise<void>;
	generateVek(): Promise<{ value: string }>;
	unlockWithVek(o: { vekB64: string }): Promise<void>;
	exportVek(): Promise<{ value: string }>;
	rotateVek(): Promise<{ value: string }>;
	generateSalt(): Promise<{ value: string }>;
	generateSlotId(): Promise<{ value: string }>;
	wrapVekPassword(o: {
		password: string;
		saltB64: string;
		slotIdB64: string;
		magicVersionB64: string;
	}): Promise<PasswordSlotBlob>;
	unwrapVekPassword(o: {
		password: string;
		saltB64: string;
		slotIdB64: string;
		verifierB64: string;
		wrapIvB64: string;
		wrappedVekB64: string;
		magicVersionB64: string;
	}): Promise<{ value: boolean }>;
	verifyPasswordSlot(o: {
		password: string;
		saltB64: string;
		slotIdB64: string;
		verifierB64: string;
		magicVersionB64: string;
	}): Promise<{ value: boolean }>;
	wrapVekWebauthn(o: {
		hmacSecretB64: string;
		slotIdB64: string;
		magicVersionB64: string;
	}): Promise<PasswordSlotBlob>;
	unwrapVekWebauthn(o: {
		hmacSecretB64: string;
		slotIdB64: string;
		verifierB64: string;
		wrapIvB64: string;
		wrappedVekB64: string;
		magicVersionB64: string;
	}): Promise<{ value: boolean }>;
	verifyWebauthnSlot(o: {
		hmacSecretB64: string;
		slotIdB64: string;
		verifierB64: string;
		magicVersionB64: string;
	}): Promise<{ value: boolean }>;
	encryptEntry(o: { plaintextJson: string }): Promise<EncryptedPayload>;
	decryptEntry(o: {
		ciphertext: string;
		iv: string;
		wrappedDek: string;
		dekIv: string;
	}): Promise<{ value: string }>;
	decryptEntries(o: {
		entries: { ciphertext: string; iv: string; wrappedDek: string; dekIv: string }[];
	}): Promise<{ values: (string | null)[] }>;
	encryptWithVek(o: { plaintext: string }): Promise<VekEncrypted>;
	sealPortableVault(o: {
		entriesJson: string;
		password: string;
		magicVersionB64: string;
	}): Promise<PortableVaultBlob>;
	// `value` is null for a wrong password; the bridge drops an undefined, so it is nullable.
	openPortableVault(o: {
		password: string;
		file: PortableVaultBlob;
		magicVersionB64: string;
	}): Promise<{ value: string | null }>;
	decryptWithVek(o: { ivB64: string; ciphertextB64: string }): Promise<{ value: string }>;
	passkeyMakeCredential(o: { rpId: string; userVerified: boolean }): Promise<PasskeyRegistration>;
	passkeyGetAssertion(o: {
		rpId: string;
		privateKeyB64: string;
		alg: number;
		clientDataHashB64: string;
		userVerified: boolean;
	}): Promise<PasskeyAssertion>;
	passkeyImportPkcs8(o: { pkcs8B64: string }): Promise<PasskeyImportResult>;
	openKdbx4(o: {
		fileB64: string;
		password: string;
		keyfileB64?: string;
		/** Absolute folder the attachments are written into, one file each. */
		dir: string;
	}): Promise<{ entries: KdbxEntry[]; attachments: { path: string; size: number }[] }>;
	/** Writes the database to `outPath`, each attachment opened natively from its blob path. */
	saveKdbx4(o: {
		entriesJson: string;
		password: string;
		filesJson: string;
		outPath: string;
	}): Promise<{ value: number }>;

	// --- sync transport: Noise handshake (KK + XXpsk3) + Nostr (BIP340) ---
	handshakeGenerateKeypair(): Promise<{ privateKey: string; publicKey: string }>;
	handshakeStartInitiator(o: {
		localPrivB64: string;
		remotePubB64: string;
	}): Promise<{ sessionId: number; message: string }>;
	handshakeStartResponder(o: {
		localPrivB64: string;
		remotePubB64: string;
	}): Promise<{ value: number }>;
	handshakeEnrollInitiator(o: {
		localPrivB64: string;
		pskB64: string;
	}): Promise<{ sessionId: number; message: string }>;
	handshakeEnrollResponder(o: { localPrivB64: string; pskB64: string }): Promise<{ value: number }>;
	handshakeRead(o: {
		sessionId: number;
		messageB64: string;
	}): Promise<{ message?: string; done: boolean }>;
	handshakeEncrypt(o: { sessionId: number; plaintext: string }): Promise<{ value: string }>;
	handshakeDecrypt(o: { sessionId: number; ciphertextB64: string }): Promise<{ value: string }>;
	handshakeRemoteStatic(o: { sessionId: number }): Promise<{ value: string }>;
	handshakeClose(o: { sessionId: number }): Promise<void>;
	nostrGenerateKey(): Promise<{ secretKey: string; publicKey: string }>;
	nostrPublicKey(o: { secretB64: string }): Promise<{ value: string }>;
	nostrSign(o: { secretB64: string; hashB64: string }): Promise<{ value: string }>;
	nostrVerify(o: {
		publicB64: string;
		hashB64: string;
		sigB64: string;
	}): Promise<{ value: boolean }>;

	// --- roster-entry signing (Ed25519 device keys) + password-authority admission (Item A) ---
	rosterSigGenerateKey(): Promise<{ secretKey: string; publicKey: string }>;
	rosterSigPublicKey(o: { secretB64: string }): Promise<{ value: string }>;
	rosterSign(o: { secretB64: string; message: string }): Promise<{ value: string }>;
	rosterVerify(o: {
		publicB64: string;
		message: string;
		sigB64: string;
	}): Promise<{ value: boolean }>;
	rosterAdmissionPublicKey(o: { password: string; saltB64: string }): Promise<{ value: string }>;
	rosterAdmissionSign(o: {
		password: string;
		saltB64: string;
		message: string;
	}): Promise<{ value: string }>;
}

const Native = registerPlugin<NativeCryptoPlugin>("NativeCrypto");

// VaultCrypto methods are async here (each crosses the bridge); buildCryptoAdapter
// awaits them, so the same adapter serves this and the synchronous WASM module.
const nativeModule: VaultCrypto = {
	is_locked: async () => (await Native.isLocked()).value,
	lock: () => Native.lock(),
	generate_vek: async () => (await Native.generateVek()).value,
	unlock_with_vek: (vekB64) => Native.unlockWithVek({ vekB64 }),
	export_vek: async () => (await Native.exportVek()).value,
	rotate_vek: async () => (await Native.rotateVek()).value,
	generate_salt: async () => (await Native.generateSalt()).value,
	generate_slot_id: async () => (await Native.generateSlotId()).value,

	wrap_vek_password: (password, saltB64, slotIdB64, magicVersion) =>
		Native.wrapVekPassword({
			password,
			saltB64,
			slotIdB64,
			magicVersionB64: bytesToBase64(magicVersion),
		}),
	unwrap_vek_password: async (
		password,
		saltB64,
		slotIdB64,
		verifierB64,
		wrapIvB64,
		wrappedVekB64,
		magicVersion,
	) =>
		(
			await Native.unwrapVekPassword({
				password,
				saltB64,
				slotIdB64,
				verifierB64,
				wrapIvB64,
				wrappedVekB64,
				magicVersionB64: bytesToBase64(magicVersion),
			})
		).value,
	verify_password_slot: async (password, saltB64, slotIdB64, verifierB64, magicVersion) =>
		(
			await Native.verifyPasswordSlot({
				password,
				saltB64,
				slotIdB64,
				verifierB64,
				magicVersionB64: bytesToBase64(magicVersion),
			})
		).value,

	wrap_vek_webauthn: (hmacSecretB64, slotIdB64, magicVersion) =>
		Native.wrapVekWebauthn({
			hmacSecretB64,
			slotIdB64,
			magicVersionB64: bytesToBase64(magicVersion),
		}),
	unwrap_vek_webauthn: async (
		hmacSecretB64,
		slotIdB64,
		verifierB64,
		wrapIvB64,
		wrappedVekB64,
		magicVersion,
	) =>
		(
			await Native.unwrapVekWebauthn({
				hmacSecretB64,
				slotIdB64,
				verifierB64,
				wrapIvB64,
				wrappedVekB64,
				magicVersionB64: bytesToBase64(magicVersion),
			})
		).value,
	verify_webauthn_slot: async (hmacSecretB64, slotIdB64, verifierB64, magicVersion) =>
		(
			await Native.verifyWebauthnSlot({
				hmacSecretB64,
				slotIdB64,
				verifierB64,
				magicVersionB64: bytesToBase64(magicVersion),
			})
		).value,

	encrypt_entry: (plaintextJson) => Native.encryptEntry({ plaintextJson }),
	decrypt_entry: async (ciphertext, iv, wrappedDek, dekIv) =>
		(await Native.decryptEntry({ ciphertext, iv, wrappedDek, dekIv })).value,
	decrypt_entries: async (entries) => (await Native.decryptEntries({ entries })).values,
	encrypt_with_vek: (plaintext) => Native.encryptWithVek({ plaintext }),
	// magicVersion crosses the Capacitor bridge as base64: JSON has no byte arrays.
	seal_portable_vault: (entriesJson, password, magicVersion) =>
		Native.sealPortableVault({
			entriesJson,
			password,
			magicVersionB64: bytesToBase64(magicVersion),
		}),
	open_portable_vault: async (password, file, magicVersion) =>
		(
			await Native.openPortableVault({
				password,
				file,
				magicVersionB64: bytesToBase64(magicVersion),
			})
		).value ?? undefined,
	decrypt_with_vek: async (iv, ciphertext) =>
		(await Native.decryptWithVek({ ivB64: iv, ciphertextB64: ciphertext })).value,

	passkey_make_credential: (rpId, userVerified) =>
		Native.passkeyMakeCredential({ rpId, userVerified }),
	passkey_get_assertion: (rpId, privateKeyB64, alg, clientDataHashB64, userVerified) =>
		Native.passkeyGetAssertion({ rpId, privateKeyB64, alg, clientDataHashB64, userVerified }),
	passkey_import_pkcs8: (pkcs8B64) => Native.passkeyImportPkcs8({ pkcs8B64 }),

	open_kdbx4: async (file, password, keyfile) => {
		const folder = await newKdbxFolder();
		try {
			const opened = await Native.openKdbx4({
				fileB64: bytesToBase64(file),
				password,
				keyfileB64: keyfile ? bytesToBase64(keyfile) : undefined,
				dir: folder.path,
			});
			return { ...opened, release: folder.release };
		} catch (e) {
			await folder.release();
			throw e;
		}
	},
};

/** The file-attachment subset of the plugin, for the FileSealer. Paths cross here, not bytes. */
export const nativeFileCrypto = {
	sealFile: (o: { srcPath: string; dstPath: string; metaJson: string }) => Native.sealFile(o),
	resealFileMeta: (o: { wrappedFekB64: string; fekIvB64: string; metaJson: string }) =>
		Native.resealFileMeta(o),
	openFileMeta: (o: {
		wrappedFekB64: string;
		fekIvB64: string;
		metaBlobB64: string;
		metaIvB64: string;
	}) => Native.openFileMeta(o),
	openFileToPath: (o: {
		wrappedFekB64: string;
		fekIvB64: string;
		noncePrefixB64: string;
		srcPath: string;
		dstPath: string;
	}) => Native.openFileToPath(o),
	openFileChunk: (o: {
		wrappedFekB64: string;
		fekIvB64: string;
		noncePrefixB64: string;
		srcPath: string;
		index: number;
	}) => Native.openFileChunk(o),
	readFileRange: (o: { path: string; offset: number; length: number }) => Native.readFileRange(o),
	saveKdbx4: (o: { entriesJson: string; password: string; filesJson: string; outPath: string }) =>
		Native.saveKdbx4(o),
};
export type NativeFileCrypto = typeof nativeFileCrypto;

export function loadNativeCrypto(): Promise<VaultCrypto> {
	return Promise.resolve(nativeModule);
}

// The sync transport crypto surface (Noise handshake + Nostr + the enrollment vault
// slice), backed natively. Matches the @core transport *Wasm interfaces structurally,
// with each call crossing the Capacitor bridge as a Promise (the transport awaits
// them; on the dev-browser WASM path the same calls are synchronous). Spreads
// nativeModule so export_vek / unlock_with_vek / generate_salt / generate_slot_id /
// wrap_vek_* / encrypt_with_vek (the EnrollWasm CryptoWasm slice) come for free.
export const nativeSyncCrypto = {
	...nativeModule,
	handshake_generate_keypair: () => Native.handshakeGenerateKeypair(),
	handshake_start_initiator: (privB64: string, remotePubB64: string) =>
		Native.handshakeStartInitiator({ localPrivB64: privB64, remotePubB64 }),
	handshake_start_responder: async (privB64: string, remotePubB64: string) =>
		(await Native.handshakeStartResponder({ localPrivB64: privB64, remotePubB64 })).value,
	handshake_enroll_initiator: (privB64: string, pskB64: string) =>
		Native.handshakeEnrollInitiator({ localPrivB64: privB64, pskB64 }),
	handshake_enroll_responder: async (privB64: string, pskB64: string) =>
		(await Native.handshakeEnrollResponder({ localPrivB64: privB64, pskB64 })).value,
	handshake_read: (sessionId: number, messageB64: string) =>
		Native.handshakeRead({ sessionId, messageB64 }),
	handshake_encrypt: async (sessionId: number, plaintext: string) =>
		(await Native.handshakeEncrypt({ sessionId, plaintext })).value,
	handshake_decrypt: async (sessionId: number, ciphertextB64: string) =>
		(await Native.handshakeDecrypt({ sessionId, ciphertextB64 })).value,
	handshake_remote_static: async (sessionId: number) =>
		(await Native.handshakeRemoteStatic({ sessionId })).value,
	handshake_close: (sessionId: number) => Native.handshakeClose({ sessionId }),
	nostr_generate_key: () => Native.nostrGenerateKey(),
	nostr_public_key: async (secretB64: string) => (await Native.nostrPublicKey({ secretB64 })).value,
	nostr_sign: async (secretB64: string, hashB64: string) =>
		(await Native.nostrSign({ secretB64, hashB64 })).value,
	nostr_verify: async (publicB64: string, hashB64: string, sigB64: string) =>
		(await Native.nostrVerify({ publicB64, hashB64, sigB64 })).value,
	// Roster signing + admission (Item A). roster_verify here also activates native
	// consumer verification (verifyRosterEnvelope no longer degrades to pass-through).
	roster_sig_generate_key: () => Native.rosterSigGenerateKey(),
	roster_sig_public_key: async (secretB64: string) =>
		(await Native.rosterSigPublicKey({ secretB64 })).value,
	roster_sign: async (secretB64: string, message: string) =>
		(await Native.rosterSign({ secretB64, message })).value,
	roster_verify: async (publicB64: string, message: string, sigB64: string) =>
		(await Native.rosterVerify({ publicB64, message, sigB64 })).value,
	roster_admission_public_key: async (password: string, saltB64: string) =>
		(await Native.rosterAdmissionPublicKey({ password, saltB64 })).value,
	roster_admission_sign: async (password: string, saltB64: string, message: string) =>
		(await Native.rosterAdmissionSign({ password, saltB64, message })).value,
};

/** The full sync-transport crypto surface (vault crypto + handshake/nostr/roster), as implemented
 * by nativeSyncCrypto. The dev-browser WASM module also exports every op at runtime, though its
 * VaultCrypto type covers only the crypto slice — so sync-manager loads against this composed type. */
export type SyncCrypto = typeof nativeSyncCrypto;
