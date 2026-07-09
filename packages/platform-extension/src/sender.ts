/// <reference types="chrome" />

import { api } from "./platform-api";

// chrome-extension://<id>, computed once. Extension pages (background SW / offscreen /
// popup / options) message from here; a content script messages from the page origin.
const EXTENSION_ORIGIN = new URL(api.runtime.getURL("")).origin;

/**
 * True only for an extension-context sender, never a content script. Fail-safe both
 * ways: sender.tab (set for content scripts, never for extension pages) is the reliable
 * reject signal; an extension sender whose origin/url is unexpectedly absent still passes
 * via the same-extension id fallback, so a legit caller is never locked out. See
 * docs/sec-audit-7726.md (A3).
 */
export function isExtensionSender(sender: chrome.runtime.MessageSender): boolean {
	if (sender.tab) return false;
	const src = sender.origin ?? sender.url ?? "";
	if (src) return src === EXTENSION_ORIGIN || src.startsWith(`${EXTENSION_ORIGIN}/`);
	return sender.id === api.runtime.id;
}
