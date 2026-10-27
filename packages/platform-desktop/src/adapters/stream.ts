// Bodies too large for one IPC call, written into a sink the shell opened (src-tauri/src/stream.rs):
// a large backup's upload body, or an exported backup file.

import type { HttpBodySource } from "@core/adapters/http";
import { invoke } from "@tauri-apps/api/core";

/** How much of a streamed body crosses per IPC call. */
const STREAM_CHUNK = 4 * 1024 * 1024;

/**
 * Stream a body source into a sink the shell opened, then finish it. Raw IPC, a chunk at a time,
 * and each write waits until the shell has room, so memory here stays at one chunk. Aborted on
 * any failure, so the shell is never left holding a half-written upload or file.
 */
export async function streamInto<T>(id: number, body: HttpBodySource): Promise<T> {
	try {
		for (let at = 0; at < body.size; at += STREAM_CHUNK) {
			const chunk = await body.read(at, Math.min(STREAM_CHUNK, body.size - at));
			await invoke<void>("stream_write", chunk, { headers: { "x-stream-id": String(id) } });
		}
		return await invoke<T>("stream_finish", { id });
	} catch (e) {
		await invoke<void>("stream_abort", { id }).catch(() => {});
		throw e;
	}
}
