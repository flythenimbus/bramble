/// <reference types="chrome" />

import { api } from "./platform-api";

// chrome-extension://<id>, computed once. Extension pages (background SW / offscreen /
// popup / options) message from here; a content script messages from the page origin.
const EXTENSION_ORIGIN = new URL(api.runtime.getURL("")).origin;

/**
 * True only for an extension-context sender (background SW / offscreen / popup / options /
 * popout), never a content script. The origin is the authoritative discriminator: a content
 * script carries the page origin, while every extension page carries the extension origin -
 * even a popout or options page hosted in a tab (so sender.tab must NOT be used to reject).
 * Falls back to the same-extension id, tab-free, only when origin and url are both absent, so
 * a legit caller is never locked out. See docs/sec-audit-7726.md (A3).
 */
export function isExtensionSender(sender: chrome.runtime.MessageSender): boolean {
	const src = sender.origin ?? sender.url ?? "";
	if (src) return src === EXTENSION_ORIGIN || src.startsWith(`${EXTENSION_ORIGIN}/`);
	return sender.id === api.runtime.id && !sender.tab;
}
