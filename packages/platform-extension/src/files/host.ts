// The crypto host's half of extension attachments: seal a picked file, or open one, between
// IndexedDB and the wasm streams. Runs where the wasm does (the offscreen document on Chrome, the
// event page on Firefox), so the only messages are a handoff key in and a few hundred bytes of
// record out. See docs/file-attachments.md.
//
// The VEK is loaded and the stream constructed in one synchronous section, and never needed
// again: the stream holds only the file's own content key. That is what lets these await
// IndexedDB between chunks without breaking the host's atomicity rule, since another op loading
// its vault's key into the slot mid-file changes nothing here. See docs/multiple-vaults.md.

import type { SealedFile } from "@core/vault/file-mutations";
import type { CryptoSaveKdbx } from "../crypto/messages";
import { idbBlobBackend, publishStagedAs, putHandoff, readHandoff } from "./idb";

/** Plaintext bytes per sealed chunk. Mirrors core-rust's files::CHUNK_LEN. */
export const CHUNK_LEN = 256 * 1024;

interface SealStream {
	seal_next(plaintext: Uint8Array, isLast: boolean): Uint8Array;
	finish(): SealedFile;
	free(): void;
}

interface OpenStream {
	plaintext_len(): number;
	next_range(): Float64Array | undefined;
	open_next(sealed: Uint8Array): Uint8Array;
	free(): void;
}

/** The slice of the wasm module these need. */
export interface FileWasm {
	unlock_with_vek(vekB64: string): void;
	FileSealStream: new (metaJson: string) => SealStream;
	FileOpenStream: new (
		wrappedFek: string,
		fekIv: string,
		noncePrefix: string,
		sealedLen: number,
	) => OpenStream;
}

/** Seal the file parked under `handoff` into the vault's store. Returns its record fields. */
export async function sealFromHandoff(
	w: FileWasm,
	p: { vaultId: string; handoff: string; metaJson: string; vekB64: string },
): Promise<SealedFile> {
	const file = await readHandoff(p.handoff);
	if (!file) throw new Error("the file to attach is no longer staged");

	w.unlock_with_vek(p.vekB64);
	const stream = new w.FileSealStream(p.metaJson);
	const backend = idbBlobBackend(p.vaultId);
	// The hash is only known at the end, so the sealed bytes stage under a key of their own.
	const staging = `seal-${globalThis.crypto.randomUUID()}`;
	try {
		// A Blob read back from IndexedDB is a copy, so its length cannot change under the loop
		// and deciding the last chunk from it is safe.
		const count = Math.max(1, Math.ceil(file.size / CHUNK_LEN));
		for (let i = 0; i < count; i++) {
			const slice = file.slice(i * CHUNK_LEN, (i + 1) * CHUNK_LEN);
			const plain = new Uint8Array(await slice.arrayBuffer());
			const sealed = stream.seal_next(plain, i === count - 1);
			plain.fill(0);
			await backend.appendStaged(staging, sealed);
		}
		const sealed = stream.finish();
		await publishStagedAs(p.vaultId, staging, sealed.hash);
		return sealed;
	} catch (e) {
		await backend.discardStaged(staging).catch(() => {});
		throw e;
	} finally {
		stream.free();
	}
}

/** Decrypt one attachment into a handoff for the view to save. Returns the handoff key. */
export async function openToHandoff(
	w: FileWasm,
	p: {
		vaultId: string;
		hash: string;
		wrappedFek: string;
		fekIv: string;
		noncePrefix: string;
		vekB64: string;
	},
): Promise<string> {
	const backend = idbBlobBackend(p.vaultId);
	const size = await backend.size(p.hash);
	if (size === null) throw new Error("this attachment's file isn't on this device yet");

	w.unlock_with_vek(p.vekB64);
	const stream = new w.FileOpenStream(p.wrappedFek, p.fekIv, p.noncePrefix, size);
	const parts: Uint8Array[] = [];
	try {
		for (let range = stream.next_range(); range; range = stream.next_range()) {
			const [offset, length] = range as unknown as [number, number];
			parts.push(stream.open_next(await backend.read(p.hash, offset, length)));
		}
	} finally {
		stream.free();
	}
	// Octet-stream whatever the file is: a blob URL of this origin that a browser rendered rather
	// than saved would run with the extension's privileges.
	return putHandoff(new Blob(parts as BlobPart[], { type: "application/octet-stream" }));
}

interface KdbxWriterStream {
	begin_binary(len: number): number;
	write_binary(bytes: Uint8Array): void;
	take(): Uint8Array;
	finish(entries: unknown): Uint8Array;
	free(): void;
}

/** The slice of the wasm module a KeePass export needs. */
export interface KdbxWasm extends FileWasm {
	KdbxWriter: new (password: string) => KdbxWriterStream;
}

/**
 * Write a KeePass database holding `entries` and every attachment in `files`, into a handoff
 * for the view to save. Returns the handoff key.
 *
 * Whole or not at all, as a backup is: every attachment must be here at its recorded size
 * before a byte is written. The file is then built front to back, attachments first as the
 * format orders them, each opened chunk by chunk straight into the writer, and what the writer
 * has ready is handed to a Blob as it goes, so neither the file nor any attachment is held.
 */
export async function saveKdbxToHandoff(w: KdbxWasm, p: CryptoSaveKdbx): Promise<string> {
	const backend = idbBlobBackend(p.vaultId);
	for (const f of p.files) {
		if ((await backend.size(f.hash)) !== f.size) {
			throw new Error("an attachment hasn't reached this device yet");
		}
	}

	const writer = new w.KdbxWriter(p.password);
	const opened: { entry: number; hash: string; name: string; stream: OpenStream }[] = [];
	try {
		// Every stream keyed in this one synchronous section: the VEK is not needed after it, so
		// awaiting between chunks below cannot pick up another vault's.
		w.unlock_with_vek(p.vekB64);
		for (const f of p.files) {
			opened.push({
				entry: f.entry,
				hash: f.hash,
				name: f.name,
				stream: new w.FileOpenStream(f.wrappedFek, f.fekIv, f.noncePrefix, f.size),
			});
		}

		const parts: Blob[] = [];
		const drain = () => {
			const ready = writer.take();
			if (ready.length > 0) parts.push(new Blob([ready as BlobPart]));
		};
		drain();
		const refs = new Map<number, { name: string; index: number }[]>();
		for (const o of opened) {
			const index = writer.begin_binary(o.stream.plaintext_len());
			for (let range = o.stream.next_range(); range; range = o.stream.next_range()) {
				const [offset, length] = range as unknown as [number, number];
				const plain = o.stream.open_next(await backend.read(o.hash, offset, length));
				writer.write_binary(plain);
				plain.fill(0);
				drain();
			}
			refs.set(o.entry, [...(refs.get(o.entry) ?? []), { name: o.name, index }]);
		}
		const entries = p.entries.map((e, i) => ({ ...e, binaries: refs.get(i) ?? [] }));
		parts.push(new Blob([writer.finish(entries) as BlobPart]));
		return putHandoff(new Blob(parts, { type: "application/octet-stream" }));
	} finally {
		for (const o of opened) o.stream.free();
		writer.free();
	}
}
