/// <reference types="chrome" />

import { api } from "../platform-api";
import { sendToOffscreen } from "./offscreen-client";
import { getClipboardSeconds } from "./prefs";
import { type MessageEnvelope, on } from "./router";

export const CLIPBOARD_ALARM = "vault:clipboard-clear";

async function scheduleClipboardClear(): Promise<void> {
	const seconds = await getClipboardSeconds();
	void api.alarms.create(CLIPBOARD_ALARM, { delayInMinutes: seconds / 60 });
}

/** Wipe the clipboard via the offscreen document (fired by the clear alarm). */
export async function runClipboardClear(): Promise<void> {
	await sendToOffscreen({ type: "CLIPBOARD_CLEAR" }).catch(() => {});
}

async function clipboardScheduleClear(): Promise<MessageEnvelope> {
	await scheduleClipboardClear();
	return { ok: true, data: null };
}

on("CLIPBOARD_SCHEDULE_CLEAR", clipboardScheduleClear);
