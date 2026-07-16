/// <reference types="chrome" />

import type { OptionsScreen, PopOutHandoff, ShellAdapter } from "@core/adapters/shell";
import type { Target } from "@core/flags";
import { extractHostname } from "@core/vault/autofill-index";
import { setWebauthnInterceptionPauser } from "@core/vault/webauthn-ceremony";
import { hostnameMatches } from "./dedupe";
import { api } from "./platform-api";
import { ACTIVE_VAULT_SESSION_KEY } from "./session-keys";
import { SyncEventMsgSchema, SyncStatusMsgSchema } from "./sync/messages";

const DETACHED_FLAG = "detached";
// Where the normal popup stashes its current route so a close+reopen (session still
// unlocked) resumes where it was. chrome.storage.session clears on browser restart, so a
// stale route never outlives the session that could unlock into it.
const POPUP_ROUTE_KEY = "popup.route";

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

/** Build target: firefox runs on a moz-extension:// origin, everything else is chromium. */
export const extensionTarget: Target =
	typeof location !== "undefined" && location.protocol === "moz-extension:"
		? "firefox"
		: "chromium";

/** ShellAdapter for the browser-extension platform (options page, pop-out, tab origin, QR scan). */
export const extensionShell: ShellAdapter = {
	appName: manifest.name,
	version: manifest.version,
	async openSetup(screen?: OptionsScreen) {
		// openOptionsPage() can't carry a query string; open a targeted screen as a
		// tab on options.html with ?screen= instead.
		if (screen) {
			await api.tabs.create({ url: api.runtime.getURL(`options.html?screen=${screen}`) });
		} else {
			await api.runtime.openOptionsPage();
		}
		// Close the popup so it doesn't linger behind the setup tab. Chrome closes it on
		// blur; Firefox keeps it open. No-op in the options page (browsers block
		// window.close on a tab the script didn't open).
		window.close();
	},
	// Export a vault backup as a plain download (goes to the browser's download folder). A
	// one-shot write, not a persisted handle, so it has none of the FSA re-permission cost.
	async exportBytes(suggestedName: string, bytes: Uint8Array, mimeType: string) {
		const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
		const url = URL.createObjectURL(blob);
		try {
			const a = document.createElement("a");
			a.href = url;
			a.download = suggestedName;
			document.body.appendChild(a);
			a.click();
			a.remove();
		} finally {
			URL.revokeObjectURL(url);
		}
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
	persistRoute(path: string) {
		// Direct session-storage write from the popup context (no gesture, no background
		// round-trip); best-effort, so a transient failure never blocks navigation.
		void api.storage.session.set({ [POPUP_ROUTE_KEY]: path }).catch(() => {});
	},
	async restoreRoute() {
		try {
			const r = await api.storage.session.get(POPUP_ROUTE_KEY);
			const path = r[POPUP_ROUTE_KEY];
			return typeof path === "string" ? path : null;
		} catch {
			return null;
		}
	},
	isDetached() {
		if (typeof window === "undefined") return false;
		return new URLSearchParams(window.location.search).has(DETACHED_FLAG);
	},
	// One-click backup OAuth runs entirely in the background service worker (see
	// background/backup-connect): launchWebAuthFlow's provider window steals focus and
	// closes this popup, so the flow can't complete here. We just kick it off and surface
	// any error; the background persists the target, visible when the popup reopens.
	async connectBackupOAuth(providerId: string, opts?: { targetId?: string }) {
		const res = (await api.runtime.sendMessage({
			type: "BACKUP_OAUTH_CONNECT",
			payload: { providerId, targetId: opts?.targetId },
		})) as { ok?: boolean; error?: string } | undefined;
		if (!res) throw new Error("No response from Bramble's background (reload the extension?).");
		if (!res.ok) throw new Error(res.error ?? "Sign-in failed.");
	},
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
	async syncSigningPublicKey() {
		const res = (await api.runtime.sendMessage({ type: "SYNC_SIGNING_PUBKEY" })) as
			| { ok: boolean; data?: string; error?: string }
			| undefined;
		if (!res) throw new Error("no response from sync host (reload the extension?)");
		if (!res.ok) throw new Error(res.error ?? "sync host error");
		if (typeof res.data !== "string") throw new Error("signing key response malformed");
		return res.data;
	},
	async signRoster(canonical: string) {
		const res = (await api.runtime.sendMessage({
			type: "SYNC_SIGN_ENTRY",
			payload: { canonical },
		})) as { ok: boolean; data?: string; error?: string } | undefined;
		if (!res) throw new Error("no response from sync host (reload the extension?)");
		if (!res.ok) throw new Error(res.error ?? "sync host error");
		if (typeof res.data !== "string") throw new Error("roster signature response malformed");
		return res.data;
	},
	async syncAdmissionPublicKey(password: string, saltB64: string) {
		const res = (await api.runtime.sendMessage({
			type: "SYNC_ADMISSION_PUBKEY",
			payload: { password, saltB64 },
		})) as { ok: boolean; data?: string; error?: string } | undefined;
		if (!res) throw new Error("no response from sync host (reload the extension?)");
		if (!res.ok) throw new Error(res.error ?? "sync host error");
		if (typeof res.data !== "string") throw new Error("admission key response malformed");
		return res.data;
	},
	async syncAdmissionSign(password: string, saltB64: string, canonical: string) {
		const res = (await api.runtime.sendMessage({
			type: "SYNC_ADMISSION_SIGN",
			payload: { password, saltB64, canonical },
		})) as { ok: boolean; data?: string; error?: string } | undefined;
		if (!res) throw new Error("no response from sync host (reload the extension?)");
		if (!res.ok) throw new Error(res.error ?? "sync host error");
		if (typeof res.data !== "string") throw new Error("admission signature response malformed");
		return res.data;
	},
	async resetSyncState() {
		// Sync identity lives in chrome.storage.local under `sync.*` (group, device keys, relay);
		// drop it all so a newly created vault starts as an un-enrolled device. See useVault.createVault.
		const all = await api.storage.local.get(null);
		const keys = Object.keys(all).filter((k) => k.startsWith("sync."));
		if (keys.length) await api.storage.local.remove(keys);
	},
	setActiveVault(vaultId) {
		// Shared with the background via chrome.storage.session, which reads it to sync the active
		// vault and clears it on lock (background/session.ts). The id is not secret.
		if (vaultId === null) void api.storage.session.remove(ACTIVE_VAULT_SESSION_KEY);
		else void api.storage.session.set({ [ACTIVE_VAULT_SESSION_KEY]: vaultId });
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
