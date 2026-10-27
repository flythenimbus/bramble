// A body too large to cross the bridge in one call, written to a file a chunk at a time, for the
// native side to read from: a large backup's upload body, or an exported backup to share.

import { Directory, Filesystem } from "@capacitor/filesystem";
import type { HttpBodySource } from "@core/adapters/http";
import { bytesToBase64 } from "@core/util/bytes";
import { pathFromUri } from "./paths";

/** How much of a body crosses the bridge per append. */
const SPOOL_CHUNK = 4 * 1024 * 1024;

/** Write `body` to `name` in the cache dir. Returns its file:// URI and its plain path. */
export async function spoolToCache(
	name: string,
	body: HttpBodySource,
): Promise<{ uri: string; path: string }> {
	await Filesystem.writeFile({ path: name, data: "", directory: Directory.Cache });
	for (let at = 0; at < body.size; at += SPOOL_CHUNK) {
		const chunk = await body.read(at, Math.min(SPOOL_CHUNK, body.size - at));
		await Filesystem.appendFile({
			path: name,
			data: bytesToBase64(chunk),
			directory: Directory.Cache,
		});
	}
	const { uri } = await Filesystem.getUri({ path: name, directory: Directory.Cache });
	return { uri, path: pathFromUri(uri) };
}

export async function dropSpooled(name: string): Promise<void> {
	await Filesystem.deleteFile({ path: name, directory: Directory.Cache }).catch(() => {});
}
