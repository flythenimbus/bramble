/// <reference types="chrome" />

import { sendToOffscreen } from "./offscreen-client";
import { getClipboardSeconds } from "./prefs";
import { type MessageEnvelope, on } from "./router";

const CLIPBOARD_EXPECTED_KEY = "clipboard.expectedHash";
export const CLIPBOARD_ALARM = "vault:clipboard-clear";

async function scheduleClipboardClear(expectedHash: string): Promise<void> {
	const seconds = await getClipboardSeconds();
	try {
		await chrome.storage.session.set({ [CLIPBOARD_EXPECTED_KEY]: expectedHash });
	} catch {}
	void chrome.alarms.create(CLIPBOARD_ALARM, { delayInMinutes: seconds / 60 });
}

export async function runClipboardClear(): Promise<void> {
	let expectedHash: string | undefined;
	try {
		const r = await chrome.storage.session.get(CLIPBOARD_EXPECTED_KEY);
		expectedHash = r[CLIPBOARD_EXPECTED_KEY] as string | undefined;
	} catch {}
	if (!expectedHash) return;
	try {
		await chrome.storage.session.remove([CLIPBOARD_EXPECTED_KEY]);
	} catch {}
	await sendToOffscreen({
		type: "CLIPBOARD_CLEAR",
		payload: { expectedHash },
	}).catch(() => {});
}

async function clipboardScheduleClear(message: any): Promise<MessageEnvelope> {
	const { expectedHash } = (message.payload ?? {}) as { expectedHash?: string };
	if (typeof expectedHash === "string" && expectedHash.length > 0) {
		await scheduleClipboardClear(expectedHash);
	}
	return { ok: true, data: null };
}

on("CLIPBOARD_SCHEDULE_CLEAR", clipboardScheduleClear);
