// Test harness for the background service worker. Builds an in-memory mock of
// the chrome.* APIs the background uses, then imports background/index.ts fresh
// (vi.resetModules) so each test gets clean module state. Not a test file (no
// `.test.ts` suffix) so vitest skips it; it is imported by the *.test.ts files.

import { vi } from "vitest";

type AnyMsg = Record<string, any>;

export interface OffscreenResponse {
	ok: boolean;
	data?: unknown;
	error?: string;
}

export interface ChromeMockOptions {
	/** Seed chrome.storage.session before hydration runs (e.g. to start unlocked). */
	sessionSeed?: Record<string, unknown>;
	/** Seed chrome.storage.local before hydration runs. */
	localSeed?: Record<string, unknown>;
	/** Override the fake offscreen crypto responder. */
	offscreen?: (msg: AnyMsg) => OffscreenResponse;
	/** What chrome.windows.getLastFocused resolves to (qr capture). */
	lastFocusedWindow?: { id?: number };
	/** Expose chrome.action.openPopup (Chrome 127+). */
	hasOpenPopup?: boolean;
}

export interface BackgroundHarness {
	chrome: any;
	state: HarnessState;
	/** Dispatch a runtime message; resolves with { handled, resp } when sendResponse fires. */
	send: (message: AnyMsg, sender?: any) => Promise<{ handled: boolean; resp: any }>;
	fireAlarm: (name: string) => void;
	fireCommand: (command: string) => void;
	fireIdle: (state: string) => void;
	fireStorageChanged: (changes: Record<string, unknown>, area: string) => void;
	fireInstalled: () => void;
	fireStartup: () => void;
	/** Drain pending microtasks + timers so async listener work settles. */
	flush: () => Promise<void>;
}

export interface HarnessState {
	session: Record<string, unknown>;
	local: Record<string, unknown>;
	alarms: Record<string, unknown>;
	tabMessages: Array<{ tabId: number; message: AnyMsg }>;
	broadcasts: AnyMsg[];
	offscreenCalls: AnyMsg[];
	windowsCreated: AnyMsg[];
	listeners: Record<string, ((...args: any[]) => any) | undefined>;
}

// Node's URL gives chrome-extension:// an opaque "null" origin, so use an https
// stand-in: isExtensionSender compares sender.origin to the extension's own
// origin by string equality, which is scheme-agnostic.
const EXT_ORIGIN = "https://extension.example";

/** A MessageSender on the extension origin (popup/options/offscreen). */
export const extensionSender = { origin: EXT_ORIGIN };
/** A MessageSender for a content script on `https://<host>` with an optional tab. */
export function pageSender(host: string, tabId?: number): any {
	const sender: any = { origin: `https://${host}`, url: `https://${host}/login` };
	if (tabId !== undefined) sender.tab = { id: tabId, windowId: 1, url: `https://${host}/login` };
	return sender;
}

export function defaultOffscreen(msg: AnyMsg): OffscreenResponse {
	switch (msg.type) {
		case "CRYPTO_GENERATE_VEK":
			return { ok: true, data: "VEK_GENERATED" };
		case "CRYPTO_EXPORT_VEK":
			return { ok: true, data: "VEK_EXPORTED" };
		case "CRYPTO_ROTATE_VEK":
			return { ok: true, data: "VEK_ROTATED" };
		case "CRYPTO_UNWRAP_PASSWORD_SLOT":
			return { ok: true, data: true };
		case "CRYPTO_UNLOCK_WITH_VEK":
			return { ok: true, data: null };
		case "CRYPTO_LOCK":
			return { ok: true, data: null };
		case "CRYPTO_ENCRYPT":
			return { ok: true, data: { ciphertext: "ct", iv: "iv", wrappedDek: "wd", dekIv: "di" } };
		case "CRYPTO_ENCRYPT_OUTER":
			return { ok: true, data: { iv: "outerIv", ciphertext: "outerCt" } };
		case "CRYPTO_DECRYPT_OUTER":
			return { ok: true, data: "[]" };
		case "CRYPTO_DECRYPT":
			return { ok: true, data: "{}" };
		case "CLIPBOARD_CLEAR":
			return { ok: true, data: null };
		default:
			return { ok: false, error: `unhandled offscreen type ${msg.type}` };
	}
}

function makeChrome(opts: ChromeMockOptions): { chrome: any; state: HarnessState } {
	const session: Record<string, unknown> = { ...(opts.sessionSeed ?? {}) };
	const local: Record<string, unknown> = { ...(opts.localSeed ?? {}) };
	const state: HarnessState = {
		session,
		local,
		alarms: {},
		tabMessages: [],
		broadcasts: [],
		offscreenCalls: [],
		windowsCreated: [],
		listeners: {},
	};
	let hasDoc = false;
	const offscreen = opts.offscreen ?? defaultOffscreen;

	const read = (store: Record<string, unknown>, query: unknown): Record<string, unknown> => {
		if (query == null) return { ...store };
		const keys =
			typeof query === "string" ? [query] : Array.isArray(query) ? query : Object.keys(query);
		const out: Record<string, unknown> = {};
		for (const k of keys) if (k in store) out[k] = store[k];
		return out;
	};

	const area = (store: Record<string, unknown>) => ({
		get: vi.fn(async (query?: unknown) => read(store, query ?? null)),
		set: vi.fn(async (obj: Record<string, unknown>) => {
			Object.assign(store, obj);
		}),
		remove: vi.fn(async (keyOrKeys: string | string[]) => {
			const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
			for (const k of keys) delete store[k];
		}),
	});

	const chrome = {
		runtime: {
			id: "testext",
			getURL: (p: string) => `${EXT_ORIGIN}/${p}`,
			getManifest: () => ({ name: "Bramble" }),
			onMessage: {
				addListener: (fn: any) => {
					state.listeners.message = fn;
				},
			},
			onInstalled: {
				addListener: (fn: any) => {
					state.listeners.installed = fn;
				},
			},
			onStartup: {
				addListener: (fn: any) => {
					state.listeners.startup = fn;
				},
			},
			sendMessage: vi.fn(async (msg: AnyMsg) => {
				if (msg && msg.target === "offscreen") {
					state.offscreenCalls.push(msg);
					return offscreen(msg);
				}
				state.broadcasts.push(msg);
				return undefined;
			}),
		},
		storage: {
			session: area(session),
			local: area(local),
			onChanged: {
				addListener: (fn: any) => {
					state.listeners.storageChanged = fn;
				},
			},
		},
		alarms: {
			create: vi.fn((name: string, info: unknown) => {
				state.alarms[name] = info;
			}),
			clear: vi.fn(async (name: string) => {
				const had = name in state.alarms;
				delete state.alarms[name];
				return had;
			}),
			onAlarm: {
				addListener: (fn: any) => {
					state.listeners.alarm = fn;
				},
			},
		},
		offscreen: {
			hasDocument: vi.fn(async () => hasDoc),
			createDocument: vi.fn(async () => {
				hasDoc = true;
			}),
			Reason: { WORKERS: "WORKERS", CLIPBOARD: "CLIPBOARD" },
		},
		tabs: {
			sendMessage: vi.fn(async (tabId: number, message: AnyMsg) => {
				state.tabMessages.push({ tabId, message });
			}),
			captureVisibleTab: vi.fn(async () => "data:image/png;base64,AAAA"),
		},
		windows: {
			create: vi.fn(async (createOpts: AnyMsg) => {
				state.windowsCreated.push(createOpts);
				return { id: 999 };
			}),
			get: vi.fn(async (id: number) => ({ id, top: 0, left: 0, width: 500 })),
			getCurrent: vi.fn(async () => ({ id: 1, top: 0, left: 0, width: 500 })),
			getLastFocused: vi.fn(async () => opts.lastFocusedWindow ?? { id: 7 }),
			update: vi.fn(async () => {}),
		},
		idle: {
			onStateChanged: {
				addListener: (fn: any) => {
					state.listeners.idle = fn;
				},
			},
		},
		commands: {
			onCommand: {
				addListener: (fn: any) => {
					state.listeners.command = fn;
				},
			},
		},
		action: opts.hasOpenPopup ? { openPopup: vi.fn(async () => {}) } : {},
	};

	return { chrome, state };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Stub global chrome, import background/index.ts fresh, and return drivers. */
export async function loadBackground(opts: ChromeMockOptions = {}): Promise<BackgroundHarness> {
	vi.resetModules();
	const { chrome, state } = makeChrome(opts);
	vi.stubGlobal("chrome", chrome);
	await import("./index");

	const send = (message: AnyMsg, sender: any = {}) =>
		new Promise<{ handled: boolean; resp: any }>((resolve) => {
			const dispatch = state.listeners.message;
			if (!dispatch) {
				resolve({ handled: false, resp: undefined });
				return;
			}
			const ret = dispatch(message, sender, (resp: any) => resolve({ handled: true, resp }));
			if (ret !== true) resolve({ handled: false, resp: undefined });
		});

	return {
		chrome,
		state,
		send,
		fireAlarm: (name) => state.listeners.alarm?.({ name }),
		fireCommand: (command) => state.listeners.command?.(command),
		fireIdle: (s) => state.listeners.idle?.(s),
		fireStorageChanged: (changes, area2) => state.listeners.storageChanged?.(changes, area2),
		fireInstalled: () => state.listeners.installed?.(),
		fireStartup: () => state.listeners.startup?.(),
		flush,
	};
}
