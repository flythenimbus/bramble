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
		// Anchor the detached window to the top-right of the currently-focused
		// browser window's content area. The 80px y-offset approximates the
		// title-bar + tab-strip height so the popup tucks under the chrome,
		// not over it. Chrome has no API to query exact frame insets.
		const WIDTH = 500;
		const HEIGHT = 600;
		const CHROME_INSET = 80;
		const current = await chrome.windows.getCurrent().catch(() => undefined);
		const browserTop = current?.top ?? 0;
		const browserLeft = current?.left ?? 0;
		const browserWidth = current?.width ?? WIDTH;
		const top = browserTop + CHROME_INSET;
		const left = browserLeft + browserWidth - WIDTH;
		const created = await chrome.windows.create({
			url: chrome.runtime.getURL(`popup.html?${DETACHED_FLAG}=1`),
			type: "popup",
			focused: true,
			width: WIDTH,
			height: HEIGHT,
			top,
			left,
		});
		// Some Chrome builds ignore width/height/state at create time for popup
		// windows. Re-assert them via update().
		if (created?.id !== undefined) {
			await chrome.windows.update(created.id, {
				state: "normal",
				width: WIDTH,
				height: HEIGHT,
				top,
				left,
			});
		}
		window.close();
	},
	isDetached() {
		if (typeof window === "undefined") return false;
		return new URLSearchParams(window.location.search).has(DETACHED_FLAG);
	},
};
