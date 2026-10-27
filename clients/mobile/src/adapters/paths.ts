// Capacitor hands out `file://` URIs; the native core opens plain paths.

/**
 * A plain filesystem path from a Capacitor `file://` URI, for Rust's std::fs. Decoded, because
 * the URI is percent-encoded: a file name with a space would otherwise reach Rust as `%20`.
 * Without a trailing slash, because iOS answers a path that does not exist yet as a folder, and
 * a file about to be written there would then be opened as one.
 */
export function pathFromUri(uri: string): string {
	return decodeURIComponent(uri.replace(/^file:\/\//, "")).replace(/(.)\/+$/, "$1");
}

/** The `file://` URI the share sheet takes, for a path the native core wrote. */
export function uriFromPath(path: string): string {
	return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
}
