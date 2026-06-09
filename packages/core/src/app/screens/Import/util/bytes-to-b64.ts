/** Base64-encode bytes for chrome.runtime messaging (which can't carry a Uint8Array). */
export function bytesToB64(bytes: Uint8Array): string {
	let bin = "";
	// Chunk so a large file doesn't overflow String.fromCharCode's argument stack.
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(bin);
}
