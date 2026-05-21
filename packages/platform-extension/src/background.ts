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

async function forwardToOffscreen(message: Record<string, unknown>): Promise<unknown> {
	await ensureOffscreen();
	return chrome.runtime.sendMessage({ ...message, target: "offscreen" });
}

chrome.runtime.onInstalled.addListener(() => {
	void ensureOffscreen();
});

chrome.runtime.onStartup.addListener(() => {
	void ensureOffscreen();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	// Messages already targeted at offscreen are not for us.
	if (message?.target === "offscreen") return false;

	const type = message?.type;
	if (typeof type === "string" && type.startsWith("CRYPTO_")) {
		forwardToOffscreen(message)
			.then((response) => sendResponse(response))
			.catch((err) => sendResponse({ ok: false, error: String(err) }));
		return true; // async response
	}

	return false;
});

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === "vault:autolock") {
		void forwardToOffscreen({ type: "CRYPTO_LOCK" });
	} else if (alarm.name === "vault:clipboard-clear") {
		// TODO: clear clipboard via offscreen.
	}
});
