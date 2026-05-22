/// <reference types="chrome" />
import type { ShellAdapter } from "@core/adapters/shell";

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
};
