/// <reference types="chrome" />

// The popup/options side of the desktop link. Every call is a message to the background,
// which owns the native port and the stored keys; no key material or code is handled here.
// See background/desktop-link.ts.

import type { DesktopLinkAdapter, DesktopLinkStatus } from "@core/adapters/desktop-link";
import { api } from "./platform-api";

async function dispatch<T = unknown>(type: string, extra?: Record<string, unknown>): Promise<T> {
	const res = await api.runtime.sendMessage({ type, ...extra });
	if (!res?.ok) throw new Error(res?.error ?? `${type} failed`);
	return res.data as T;
}

/**
 * Whether this browser can talk to the desktop app at all.
 *
 * The link is native messaging, and only the Chromium manifest asks for the permission: the
 * desktop app writes Chromium-shaped host manifests (`allowed_origins`) into Chromium support
 * directories, and Firefox wants `allowed_extensions` in a Mozilla one. So on Firefox there is
 * nothing at either end, and offering to connect would be a settings section whose only outcome
 * is an error.
 *
 * Read from the manifest rather than sniffing the browser, so this turns itself on the day
 * Firefox support is added rather than needing to be remembered.
 *
 * BOTH permission arrays count. Chromium asks for `nativeMessaging` at connect time rather than
 * at install (see docs/desktop-link-optional-permission.md), so it is declared optional there;
 * declaring it required again must keep working.
 *
 * This answers "could this browser ever do it", not "may it right now". That second question is
 * `permission.granted()`, and it is the only honest test of it: `typeof connectNative` goes stale
 * in both directions across a grant or a revoke, so it is never evidence of a permission.
 */
const canNativeMessage = (): boolean => {
	try {
		const manifest = api.runtime.getManifest();
		const declared = [...(manifest.permissions ?? []), ...(manifest.optional_permissions ?? [])];
		return declared.includes("nativeMessaging");
	} catch {
		return false;
	}
};

const NATIVE_MESSAGING = { permissions: ["nativeMessaging"] };

/**
 * Whether the permission is ours to ask for, rather than one we already hold.
 *
 * Only the optional declaration gets a runtime question. A build that lists it as required holds
 * it from install, and `permissions.remove` refuses to give a required permission back, so
 * offering the controls there would produce a Reconnect button that can never be needed and a
 * drop that silently fails.
 */
const isOptional = (): boolean => {
	try {
		return (api.runtime.getManifest().optional_permissions ?? []).includes("nativeMessaging");
	} catch {
		return false;
	}
};

/** Runs in the page, never through the background: `permissions.request` needs a user gesture,
 * and a service worker has none to offer. */
const permission = {
	granted: () => api.permissions.contains(NATIVE_MESSAGING),
	request: () => api.permissions.request(NATIVE_MESSAGING),
	drop: async () => {
		await api.permissions.remove(NATIVE_MESSAGING);
	},
};

/** Must match `NATIVE_PROXY_PORT` in ./background/desktop-link.ts. */
const NATIVE_PROXY_PORT = "link-native-proxy";

/** Must match `HOST_NAME` in ./background/desktop-link.ts. */
const HOST_NAME = "app.bramble.desktop";

/**
 * Lend the background a native pipe this context can open and it cannot.
 *
 * Chromium fixes a context's API bindings when the context is created, so the worker that was
 * running when the user granted `nativeMessaging` never gains `connectNative`, and the open
 * pairing window is itself what stops it restarting to pick it up. This page was created after
 * the grant, so it has the binding; it forwards frames and reads none of them. The keys, the
 * handshake and the storage write all stay in the background.
 *
 * Null when this context has no binding either, which means the grant has not happened or this
 * page predates it. The caller then pairs the ordinary way and the background decides.
 */
function openNativeProxy(): { ready: Promise<void>; close(): void } | null {
	if (typeof api.runtime.connectNative !== "function") return null;

	let native: chrome.runtime.Port;
	try {
		native = api.runtime.connectNative(HOST_NAME);
	} catch {
		// A binding that exists but refuses, e.g. the permission was revoked between the check
		// and here. Nothing to lend.
		return null;
	}
	const relay = api.runtime.connect({ name: NATIVE_PROXY_PORT });

	let settle: () => void;
	const ready = new Promise<void>((resolve) => {
		settle = resolve;
	});

	relay.onMessage.addListener((msg: { ready?: boolean; frame?: Record<string, unknown> }) => {
		if (msg?.ready) return settle();
		if (msg?.frame) native.postMessage(msg.frame);
	});
	native.onMessage.addListener((frame) => relay.postMessage({ frame }));
	native.onDisconnect.addListener(() => {
		// Tell the background rather than just going quiet. Chrome reports a missing host, a
		// manifest that does not name this extension, and a host that exited all as the same bare
		// disconnect, so this is the only signal there is.
		const dead = api.runtime.lastError?.message ?? "disconnected";
		try {
			relay.postMessage({ dead });
		} catch {
			// The relay is already gone; the background has its own disconnect handler.
		}
	});
	// Unblock rather than hang if the background never acks (an old worker without this listener).
	setTimeout(() => settle(), 2000);

	return {
		ready,
		close: () => {
			native.disconnect();
			relay.disconnect();
		},
	};
}

const adapter: DesktopLinkAdapter = {
	status: () => dispatch<DesktopLinkStatus>("DESKTOP_LINK_STATUS"),
	// The code goes straight through to the background and is never stored here. The native pipe
	// is lent for the duration and torn down either way; see openNativeProxy.
	pair: async (code) => {
		const proxy = openNativeProxy();
		try {
			await proxy?.ready;
			await dispatch("DESKTOP_LINK_PAIR", { code });
		} finally {
			proxy?.close();
		}
	},
	connect: () => dispatch<boolean>("DESKTOP_LINK_CONNECT"),
	query: async (hostname) => {
		const answer = await dispatch<{ ok: boolean; error?: string; matches?: unknown[] }>(
			"DESKTOP_LINK_QUERY",
			{ hostname },
		);
		if (!answer.ok) throw new Error(answer.error ?? "query failed");
		return (answer.matches ?? []) as { id: string; name: string; secondary: string }[];
	},
	// The invite the app armed when the user clicked Connect. Null rather than an error when
	// there is none: the app arms one only while its dialog is open, and a version that predates
	// this arms none at all, so "no invite" is an ordinary answer and not a fault.
	claimSyncInvite: () => dispatch<string | null>("DESKTOP_LINK_CLAIM_INVITE"),
	desktopSyncKey: () => dispatch<string | null>("DESKTOP_LINK_SYNC_KEY"),
	unlink: async () => {
		await dispatch("DESKTOP_LINK_UNLINK");
	},
	// Omitted where the permission is required rather than optional, which callers read as
	// already-allowed. See the `permission` docs on DesktopLinkAdapter.
	...(isOptional() ? { permission } : {}),
};

/** Undefined where the browser cannot do it, which is what hides the Settings section. */
export const extensionDesktopLink: DesktopLinkAdapter | undefined = canNativeMessage()
	? adapter
	: undefined;
