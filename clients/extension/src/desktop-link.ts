/// <reference types="chrome" />

// The popup/options side of the desktop link. Every call is a message to the background,
// which owns the native port and the stored keys; no key material or code is handled here.
// See background/desktop-link.ts.

import type { DesktopLinkAdapter, DesktopLinkStatus } from "@core/adapters/desktop-link";
import type { PairingSas } from "@core/sync/pairing-sas";
import { api, disconnectReason } from "./platform-api";

async function dispatch<T = unknown>(type: string, extra?: Record<string, unknown>): Promise<T> {
	const res = await api.runtime.sendMessage({ type, ...extra });
	// The router answers a throw with String(err); the screen wants the words alone.
	if (!res?.ok) throw new Error(String(res?.error ?? `${type} failed`).replace(/^Error: /, ""));
	return res.data as T;
}

/**
 * Whether this browser can talk to the desktop app at all.
 *
 * The link is native messaging, so a build whose manifest does not declare the permission has
 * nothing at either end, and offering to connect would be a settings section whose only outcome
 * is an error. Read from the manifest rather than sniffing the browser.
 *
 * BOTH permission arrays count. Both browsers ask for `nativeMessaging` at connect time rather
 * than at install (see docs/desktop-link-optional-permission.md), so it is declared optional;
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
function openNativeProxy(): { via: string; ready: Promise<void>; close(): void } | null {
	if (typeof api.runtime.connectNative !== "function") return null;

	let native: chrome.runtime.Port;
	try {
		native = api.runtime.connectNative(HOST_NAME);
	} catch {
		// A binding that exists but refuses, e.g. the permission was revoked between the check
		// and here. Nothing to lend.
		return null;
	}
	// Named, so the request it is lent for can say which pipe is its own.
	const via = crypto.randomUUID();
	const relay = api.runtime.connect({ name: `${NATIVE_PROXY_PORT}:${via}` });

	let settle: () => void;
	const ready = new Promise<void>((resolve) => {
		settle = resolve;
	});

	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		native.disconnect();
		relay.disconnect();
	};

	relay.onMessage.addListener(
		(msg: { ready?: boolean; release?: boolean; frame?: Record<string, unknown> }) => {
			if (msg?.ready) return settle();
			// The background is done with it, and an open pipe reads as connected to the app.
			if (msg?.release) return close();
			if (msg?.frame) native.postMessage(msg.frame);
		},
	);
	native.onMessage.addListener((frame) => relay.postMessage({ frame }));
	native.onDisconnect.addListener(() => {
		// Tell the background rather than just going quiet. Chrome reports a missing host, a
		// manifest that does not name this extension, and a host that exited all as the same bare
		// disconnect, so this is the only signal there is.
		const dead = disconnectReason(native);
		try {
			relay.postMessage({ dead });
		} catch {
			// The relay is already gone; the background has its own disconnect handler.
		}
	});
	// Unblock rather than hang if the background never acks (an old worker without this listener).
	setTimeout(() => settle(), 2000);

	return { via, ready, close };
}

/**
 * Run a link request, lending the background a native pipe if it has no way to open one.
 *
 * Asked rather than assumed. Lending unconditionally would open a SECOND connection whenever the
 * background already had one, and the app keys its outbound queue by our static key: the second
 * displaces the first as the target for its pushes, and closing it takes that queue with it, so
 * sync goes quiet with nothing reporting a fault. Lending is only safe when there is nothing to
 * displace, which is exactly when the background says it needs it.
 */
async function withNativeProxy<T>(run: (via?: string) => Promise<T>): Promise<T> {
	// Lend on an unclear answer. Failing to lend is the bug this exists to fix; lending when it
	// was not needed costs one short-lived connection.
	const needed = await dispatch<boolean>("DESKTOP_LINK_TRANSPORT_NEEDED").catch(() => true);
	if (!needed) return run();
	const proxy = openNativeProxy();
	try {
		await proxy?.ready;
		return await run(proxy?.via);
	} finally {
		proxy?.close();
	}
}

/** The port lent for an emoji link: held from start to the answer, and after a link is made for
 * as long as this page is open, as the background's held link. Lent even to a background with a
 * pipe of its own, so a link in progress lives exactly as long as the page running its vault copy:
 * the app forgets its half when this pipe closes. */
let linkProxy: ReturnType<typeof openNativeProxy> = null;

/** The port lent to carry the open vault's link, apart from `linkProxy`: neither may close the
 * other's. */
let lentProxy: ReturnType<typeof openNativeProxy> = null;

/**
 * Carry the worker's link while this page is open, if it cannot open a pipe itself.
 *
 * A worker from before the permission grant has to go idle and be replaced, which takes a minute.
 * Someone who opens a window is looking now, so it lends a pipe at once, and again whenever the
 * worker loses the one it had. See docs/desktop-link-optional-permission.md.
 */
export function lendPipeToWorker(): void {
	const lend = async () => {
		if (!(await dispatch<boolean>("DESKTOP_LINK_PIPE_WANTED").catch(() => false))) return;
		lentProxy?.close();
		const proxy = openNativeProxy();
		lentProxy = proxy;
		await proxy?.ready;
		if (proxy) await dispatch("DESKTOP_LINK_LEND_PIPE", { via: proxy.via }).catch(() => {});
	};
	void lend();
	api.runtime.onMessage.addListener((message: { type?: string }) => {
		if (message?.type === "DESKTOP_LINK_PIPE_LOST") void lend();
	});
}

function releaseLinkProxy(): void {
	linkProxy?.close();
	linkProxy = null;
}

const adapter: DesktopLinkAdapter = {
	status: () => dispatch<DesktopLinkStatus>("DESKTOP_LINK_STATUS"),
	// The code goes straight through to the background and is never stored here.
	pair: (code) =>
		withNativeProxy(async (via) => void (await dispatch("DESKTOP_LINK_PAIR", { code, via }))),
	// The emoji link spans two calls on one pipe, so the lent port stays open past the answer.
	start: async () => {
		linkProxy?.close();
		linkProxy = openNativeProxy();
		await linkProxy?.ready;
		const started = await dispatch<{ id: string; sas: PairingSas } | { legacy: true }>(
			"DESKTOP_LINK_START",
			{ via: linkProxy?.via },
		).catch((e) => {
			releaseLinkProxy();
			throw e;
		});
		if ("legacy" in started) releaseLinkProxy();
		return started;
	},
	cancel: async (id) => {
		try {
			await dispatch("DESKTOP_LINK_CANCEL", { id });
		} finally {
			releaseLinkProxy();
		}
	},
	confirm: async (id, matches) => {
		try {
			await dispatch("DESKTOP_LINK_CONFIRM", { id, matches });
		} catch (e) {
			releaseLinkProxy();
			throw e;
		}
		// Kept while this page is open: a lent pipe is now the background's held link, which
		// carries the vault copy and sync until its worker can open a pipe of its own.
	},
	// The flow ended with this vault holding the desktop's: the pairing is complete.
	attach: (vaultId) => dispatch<boolean>("DESKTOP_LINK_ATTACH", { vaultId }),
	// The flow ended without a vault, so the link goes, and with it the pipe lent for it.
	abandon: async () => {
		try {
			await dispatch("DESKTOP_LINK_ABANDON");
		} finally {
			releaseLinkProxy();
		}
	},
	connect: () => withNativeProxy(() => dispatch<boolean>("DESKTOP_LINK_CONNECT")),
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
	//
	// Lent a transport like pairing, and for the same reason: this runs on the worker that JUST
	// paired, which has no binding of its own. Without it the claim silently answered "no invite"
	// on every first-time pairing, so the browser got the link and never the vault.
	claimSyncInvite: () =>
		withNativeProxy((via) => dispatch<string | null>("DESKTOP_LINK_CLAIM_INVITE", { via })),
	desktopSyncKey: () =>
		withNativeProxy((via) => dispatch<string | null>("DESKTOP_LINK_SYNC_KEY", { via })),
	vaultSummary: () =>
		withNativeProxy((via) =>
			dispatch<{ name: string; empty: boolean; entries: number } | null>(
				"DESKTOP_LINK_VAULT_SUMMARY",
				{ via },
			),
		),
	unlink: () => dispatch<{ remaining: number }>("DESKTOP_LINK_UNLINK"),
	forgetVault: async (vaultId) => {
		await dispatch("DESKTOP_LINK_FORGET_VAULT", { vaultId });
	},
	// Omitted where the permission is required rather than optional, which callers read as
	// already-allowed. See the `permission` docs on DesktopLinkAdapter.
	...(isOptional() ? { permission } : {}),
};

/** Undefined where the browser cannot do it, which is what hides the Settings section. */
export const extensionDesktopLink: DesktopLinkAdapter | undefined = canNativeMessage()
	? adapter
	: undefined;
