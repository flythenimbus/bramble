// Where ciphertext lives: a directory on the self-hosted server, R2 on the hosted one. Keys are built
// only from validated ids, never from raw input.

export interface BodyStore {
	/** With `sha256`, refuses (HashMismatchError) and stores nothing unless the bytes hash to it. */
	put(
		key: string,
		body: ReadableStream<Uint8Array> | Uint8Array,
		opts?: { sha256?: string },
	): Promise<void>;
	get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>;
	/** Deleting a missing key is not an error. */
	delete(key: string): Promise<void>;
	keys(): AsyncIterable<{ key: string; modifiedAt: number }>;
}

export class HashMismatchError extends Error {
	constructor() {
		super("body does not match its declared sha256");
		this.name = "HashMismatchError";
	}
}

export const messageKey = (mailboxId: string, id: string) => `m/${mailboxId}/${id}`;
export const blobKey = (mailboxId: string, hash: string) => `b/${mailboxId}/${hash}`;
