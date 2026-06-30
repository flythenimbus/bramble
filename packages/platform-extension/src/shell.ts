/// <reference types="chrome" />

import type { OptionsScreen, PopOutHandoff, ShellAdapter } from "@core/adapters/shell";
import { extractHostname } from "@core/vault/autofill-index";
import { setWebauthnInterceptionPauser } from "@core/vault/webauthn-ceremony";
import { hostnameMatches } from "./dedupe";
import { api } from "./platform-api";
import { SyncEventMsgSchema, SyncStatusMsgSchema } from "./sync/messages";

const DETACHED_FLAG = "detached";

// When the passkey provider proxy is attached it intercepts all browser WebAuthn,
// which would hijack Bramble's own security-key (PRF) unlock. Pause it around our
// ceremony by detaching for the duration; best-effort so a messaging hiccup never
// blocks unlock. Runs in the popup/options context (where the ceremony runs). See
// docs/passkey-provider.md.
setWebauthnInterceptionPauser(async (run) => {
	try {
		await api.runtime.sendMessage({ type: "PASSKEY_PROXY_PAUSE" });
	} catch {}
	try {
		return await run();
	} finally {
		try {
			await api.runtime.sendMessage({ type: "PASSKEY_PROXY_RESUME" });
		} catch {}
	}
});

const manifest = api.runtime.getManifest();

/** ShellAdapter for the browser-extension platform (options page, pop-out, tab origin, QR scan). */
export const extensionShell: ShellAdapter = {
	appName: manifest.name,
	version: manifest.version,
	async openSetup(screen?: OptionsScreen) {
		// openOptionsPage() can't carry a query string; open a targeted screen as a
		// tab on options.html with ?screen= instead.
		if (screen) {
			await api.tabs.create({ url: api.runtime.getURL(`options.html?screen=${screen}`) });
			return;
		}
		await api.runtime.openOptionsPage();
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
			const [tab] = await api.tabs.query({ active: true, currentWindow: true });
			if (!tab?.url) return null;
			const url = new URL(tab.url);
			if (url.protocol !== "http:" && url.protocol !== "https:") return null;
			return url.origin;
		} catch {
			return null;
		}
	},
	async matchCurrentTab(logins) {
		const origin = await this.getCurrentTabOrigin();
		if (!origin) return [];
		const host = new URL(origin).hostname;
		return logins
			.filter((l) => {
				const hostnames = l.urls.map(extractHostname).filter((h) => h.length > 0);
				return hostnameMatches({ hostnames, subdomainMatch: l.subdomainMatch }, host);
			})
			.map((l) => l.id);
	},
	async popOut(handoff?: PopOutHandoff) {
		// Background SW owns window creation (so the content script can request it
		// too) and stashes the handoff in chrome.storage.session for the new window.
		// Wait for the window before closing this popup.
		await api.runtime.sendMessage({ type: "POPOUT_OPEN", payload: { handoff } });
		window.close();
	},
	async consumeHandoff() {
		const res = (await api.runtime.sendMessage({ type: "POPOUT_CONSUME_HANDOFF" })) as
			| { ok: boolean; data?: PopOutHandoff | null }
			| undefined;
		return res?.data ?? null;
	},
	isDetached() {
		if (typeof window === "undefined") return false;
		return new URLSearchParams(window.location.search).has(DETACHED_FLAG);
	},
	supportsPopOut: true,
	// Extension QR scan captures the active tab, not a camera; no camera-scan UI.
	supportsCameraScan: false,
	supportsSecurityKeys: true,
	supportsSaveCapture: true,
	supportsPasskeyProvider: true,
	async setPasskeyProviderEnabled(enabled: boolean) {
		await api.runtime.sendMessage({
			type: "PASSKEY_PROVIDER_SET_ENABLED",
			payload: { enabled },
		});
	},
	onPasskeySaved(callback) {
		const handler = (msg: { type?: string; payload?: unknown } | undefined) => {
			if (msg?.type === "PASSKEY_SAVED" && msg.payload) {
				callback(msg.payload as Parameters<typeof callback>[0]);
			}
		};
		api.runtime.onMessage.addListener(handler);
		return () => api.runtime.onMessage.removeListener(handler);
	},
	async flushPendingCornerCapture() {
		const res = (await api.runtime.sendMessage({ type: "CORNER_FLUSH_HANDOFF" })) as
			| { ok: boolean; data?: boolean }
			| undefined;
		return res?.ok === true && res.data === true;
	},
	async scanQrFromActiveTab() {
		// Background SW captures and decodes the visible tab; the screenshot never
		// leaves it, only the decoded string crosses back.
		const res = (await api.runtime.sendMessage({ type: "CAPTURE_QR_SCAN" })) as
			| { ok: boolean; data?: string | null }
			| undefined;
		return res?.ok ? (res.data ?? null) : null;
	},
	async stopSyncSpike() {
		await api.runtime.sendMessage({ type: "SYNC_DISCONNECT" });
	},
	onSyncStatus(callback: (status: string) => void) {
		const handler = (msg: { type?: string; payload?: unknown } | undefined) => {
			if (msg?.type !== "SYNC_STATUS") return;
			const parsed = SyncStatusMsgSchema.safeParse(msg.payload);
			if (parsed.success) callback(parsed.data.status);
		};
		api.runtime.onMessage.addListener(handler);
		return () => api.runtime.onMessage.removeListener(handler);
	},
	async syncDevicePublicKey() {
		const res = (await api.runtime.sendMessage({ type: "SYNC_DEVICE_PUBKEY" })) as
			| { ok: boolean; data?: string; error?: string }
			| undefined;
		if (!res) throw new Error("no response from sync host (reload the extension?)");
		if (!res.ok) throw new Error(res.error ?? "sync host error");
		if (typeof res.data !== "string") throw new Error("device key response malformed");
		return res.data;
	},
	async startEnrollInvite(opts) {
		await syncStart("SYNC_ENROLL_INVITE", opts);
	},
	async startEnrollJoin(opts) {
		await syncStart("SYNC_ENROLL_JOIN", opts);
	},
	onSyncEvent(callback) {
		const handler = (msg: { type?: string; payload?: unknown } | undefined) => {
			if (msg?.type !== "SYNC_EVENT") return;
			const parsed = SyncEventMsgSchema.safeParse(msg.payload);
			if (parsed.success) callback(parsed.data);
		};
		api.runtime.onMessage.addListener(handler);
		return () => api.runtime.onMessage.removeListener(handler);
	},
};

/** Start a sync host in the offscreen; throw the background's error so the UI can show it. */
async function syncStart(type: string, payload: unknown): Promise<void> {
	const res = (await api.runtime.sendMessage({ type, payload })) as
		| { ok?: boolean; error?: string }
		| undefined;
	if (res && res.ok === false) throw new Error(res.error ?? `${type} failed`);
}
