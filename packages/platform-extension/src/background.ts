/// <reference types="chrome" />

const OFFSCREEN_URL = "offscreen.html";

async function ensureOffscreen(): Promise<void> {
	const existing = await chrome.offscreen.hasDocument?.();
	if (existing) return;
	await chrome.offscreen.createDocument({
		url: OFFSCREEN_URL,
		reasons: [chrome.offscreen.Reason.WORKERS],
		justification: "Hosts the Vault WASM crypto module and master key.",
	});
}

chrome.runtime.onInstalled.addListener(() => {
	void ensureOffscreen();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	// TODO: route messages between popup / content scripts / offscreen.
	// Auto-lock alarms and clipboard-clear alarms are handled here too.
	void ensureOffscreen().then(() => {
		sendResponse({ ok: false, error: `TODO: route ${message?.type ?? "?"}` });
	});
	return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === "vault:autolock") {
		// TODO: tell offscreen to lock.
	} else if (alarm.name === "vault:clipboard-clear") {
		// TODO: clear clipboard via offscreen.
	}
});
