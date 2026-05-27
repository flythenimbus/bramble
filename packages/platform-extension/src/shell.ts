/// <reference types="chrome" />
import type { OptionsScreen, PopOutHandoff, ShellAdapter } from "@core/adapters/shell";

const DETACHED_FLAG = "detached";

export const extensionShell: ShellAdapter = {
	// chrome.runtime.getManifest is synchronous and available in every
	// extension context (popup, options, offscreen), so we resolve once at
	// module load.
	version: chrome.runtime.getManifest().version,
	async openSetup(screen?: OptionsScreen) {
		if (screen) {
			await chrome.tabs.create({ url: chrome.runtime.getURL(`options.html?screen=${screen}`) });
			return;
		}
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
	async popOut(handoff?: PopOutHandoff) {
		await chrome.runtime.sendMessage({ type: "POPOUT_OPEN", payload: { handoff } });
		window.close();
	},
	async consumeHandoff() {
		const res = (await chrome.runtime.sendMessage({ type: "POPOUT_CONSUME_HANDOFF" })) as
			| { ok: boolean; data?: PopOutHandoff | null }
			| undefined;
		return res?.data ?? null;
	},
	isDetached() {
		if (typeof window === "undefined") return false;
		return new URLSearchParams(window.location.search).has(DETACHED_FLAG);
	},
	async scanQrFromActiveTab() {
		const res = (await chrome.runtime.sendMessage({ type: "CAPTURE_QR_SCAN" })) as
			| { ok: boolean; data?: string | null }
			| undefined;
		return res?.ok ? (res.data ?? null) : null;
	},
};
