/// <reference types="chrome" />
import { api } from "./content-api";

// The origins a document served from this extension can report. A content script
// cannot just use runtime.getURL(): under Chromium's manifest `use_dynamic_url` that
// returns a per-session GUID origin, while the document it loads reports the static
// `chrome-extension://<id>`. Both belong to us, so both are accepted; nothing else is.
// See docs/autofill.md.

/** Origins the picker UI may legitimately speak from. Never widen this to a bare scheme check. */
export function extensionOrigins(): ReadonlySet<string> {
	const origins = new Set<string>();
	try {
		const url = api.runtime.getURL("");
		if (url) origins.add(new URL(url).origin);
	} catch {
		// Orphaned content script; the caller's origin check simply matches nothing.
	}
	try {
		const id = api.runtime?.id;
		const scheme = new URL(api.runtime.getURL("")).protocol;
		// Firefox's runtime.id is the addon id, not the moz-extension uuid, so this
		// candidate is inert there rather than wrong: it matches no real origin.
		if (id && scheme) origins.add(`${scheme}//${id}`);
	} catch {
		// As above.
	}
	return origins;
}

/** True when `origin` is one of this extension's own document origins. */
export function isExtensionOrigin(origin: string, origins = extensionOrigins()): boolean {
	return origin.length > 0 && origins.has(origin);
}
