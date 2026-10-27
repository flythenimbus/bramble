import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import type { CryptoAdapter, SavedKdbx, SaveKdbxInput } from "@core/adapters/crypto";
import { buildCryptoAdapter } from "@core/index";
import { base64ToBytes } from "@core/util/bytes";
import { loadNativeCrypto, nativeFileCrypto, newKdbxFolder } from "../native-crypto";
import { loadWasm } from "../wasm-loader";
import { blobDirFor } from "./blob-store";
import { pathFromUri } from "./paths";
import { markLocked, markUnlocked, onExternalChange, onExternalLock } from "./vault-session";

// The method->crypto mapping lives in @core (shared with the extension offscreen).
// On device (iOS + Android) we bind it to the native uniffi plugin (the shared Rust
// core): the autofill provider links the same core, and on iOS native crypto needs no
// JIT so the vault works under Lockdown Mode where WASM fails. A dev browser has no
// native plugin, so it falls back to the in-webview WASM module.
const native = Capacitor.isNativePlatform();
const shared = buildCryptoAdapter(native ? loadNativeCrypto : loadWasm, {
	onUnlocked: markUnlocked,
	onLocked: markLocked,
	onExternalLock,
	onExternalChange,
});

/**
 * A KeePass export written natively: each attachment opened from its blob file, the database
 * written to a cache folder the lock sweeps, and shared from there (see shell.ts). Neither the
 * database nor an attachment crosses the bridge.
 */
async function saveKdbx(input: SaveKdbxInput): Promise<SavedKdbx> {
	const blobs = blobDirFor(input.vaultId);
	const files = [];
	for (const { entry, record, name } of input.files) {
		const { uri } = await Filesystem.getUri({
			path: `${blobs}/${record.hash}`,
			directory: Directory.Data,
		});
		files.push({
			blobPath: pathFromUri(uri),
			wrappedFek: record.wrappedFek,
			fekIv: record.fekIv,
			noncePrefix: record.noncePrefix,
			size: record.size,
			entry,
			name,
		});
	}
	const folder = await newKdbxFolder();
	try {
		const path = `${folder.path}/${input.name}`;
		const { value: size } = await nativeFileCrypto.saveKdbx4({
			entriesJson: JSON.stringify(input.entries),
			password: input.password,
			filesJson: JSON.stringify(files),
			outPath: path,
		});
		return {
			size,
			path,
			read: async (offset, length) =>
				base64ToBytes((await nativeFileCrypto.readFileRange({ path, offset, length })).value),
			release: folder.release,
		};
	} catch (e) {
		await folder.release();
		throw e;
	}
}

// The dev browser's WASM module has a writer of its own, but no blob files to stream from.
export const mobileCrypto: CryptoAdapter = native ? { ...shared, saveKdbx } : shared;
