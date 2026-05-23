/// <reference types="chrome" />
import type { ShellAdapter } from "@core/adapters/shell";

const DETACHED_FLAG = "detached";

export const extensionShell: ShellAdapter = {
	async openSetup() {
		await chrome.runtime.openOptionsPage();
	},
	hasFilePicker() {
		if (typeof window === "undefined") return false;
		return (
			typeof window.showSaveFilePicker === "function" &&
			typeof window.showOpenFilePicker === "function"
		);
	},
	async getCurrentTabOrigin() {
		try {
			const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
			if (!tab?.url) return null;
			const url = new URL(tab.url);
			if (url.protocol !== "http:" && url.protocol !== "https:") return null;
			return url.origin;
		} catch {
			return null;
		}
	},
	async popOut() {
		// "vault locked" hint can request the same flow. Wait for the new
		// window to be created before closing the popup.
		await chrome.runtime.sendMessage({ type: "POPOUT_OPEN" });
		window.close();
	},
	isDetached() {
		if (typeof window === "undefined") return false;
		return new URLSearchParams(window.location.search).has(DETACHED_FLAG);
	},
};
