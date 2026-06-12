/// <reference types="chrome" />

// Strict-monochrome toolbar icon that follows the OS colour scheme. Chrome has
// no declarative per-theme action icon (Firefox's theme_icons is ignored here),
// and the service worker can't read prefers-color-scheme, so the offscreen
// document detects the scheme and reports it via THEME_ICON_SET; we swap the
// action icon to the matching monochrome variant.

import { type MessageEnvelope, on } from "./router";

// Keyed by OS scheme, not ink colour: dark mode shows the white mark; light
// mode shows the near-black mark (the manifest's static default_icon).
const LIGHT_ICONS = { 16: "icons/icon-16.png", 32: "icons/icon-32.png" };
const DARK_ICONS = { 16: "icons/icon-16-dark.png", 32: "icons/icon-32-dark.png" };

async function setThemeIcon(message: unknown): Promise<MessageEnvelope> {
	const dark = (message as { payload?: { dark?: boolean } })?.payload?.dark;
	if (typeof dark !== "boolean") return { ok: false, error: "missing dark flag" };
	await chrome.action.setIcon({ path: dark ? DARK_ICONS : LIGHT_ICONS });
	return { ok: true };
}

on("THEME_ICON_SET", setThemeIcon);
