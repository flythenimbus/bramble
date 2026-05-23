/// <reference types="chrome" />
import { getDomain } from "tldts";
import type { Credentials, FindResult, IndexEntry, MatchSummary } from "@core/adapters/autofill";

// state: decrypted autofill index, cached master key, hostname registry,
// next CRYPTO_* forward), we silently re-inject the master key into it.
//
//   chrome.storage.session — master key + decrypted index. In-memory, wiped
//     on browser restart. Survives SW restart and offscreen restart.
//   chrome.storage.local   — known hostnames only. Persisted to disk so the
//     "Vault locked" hint can surface before the user has unlocked again.

const OFFSCREEN_URL = "offscreen.html";

const MASTER_KEY_KEY = "vault.masterKey";
const AUTOFILL_INDEX_KEY = "autofill.index";
const HOSTNAMES_KEY = "autofill.knownHostnames";

const AUTOLOCK_ALARM = "vault:autolock";
const SESSION_TIMEOUT_MINUTES = 15;


let autofillIndex: Map<string, IndexEntry> | null = null;
const knownHostnames = new Set<string>();
let cachedMasterKey: string | null = null;
// Tracks whether we've already re-injected the cached key into this offscreen
let offscreenHasKey = false;

const hydrationPromise = (async () => {
	try {
		const [sessionResult, localResult] = await Promise.all([
			chrome.storage.session.get([MASTER_KEY_KEY, AUTOFILL_INDEX_KEY]),
			chrome.storage.local.get([HOSTNAMES_KEY]),
		]);
		const cachedKey = sessionResult[MASTER_KEY_KEY];
		if (typeof cachedKey === "string") cachedMasterKey = cachedKey;
		const cachedIndex = sessionResult[AUTOFILL_INDEX_KEY];
		if (Array.isArray(cachedIndex)) {
			autofillIndex = new Map();
			for (const entry of cachedIndex) autofillIndex.set(entry.id, entry);
		}
		const hostnames = localResult[HOSTNAMES_KEY];
		if (Array.isArray(hostnames)) for (const h of hostnames) knownHostnames.add(h);
	} catch (e) {
		console.warn("[titanpass:bg] hydration failed", e);
	}
})();

function registrableDomain(hostname: string): string {
	return getDomain(hostname) ?? hostname;
}


async function ensureOffscreen(): Promise<void> {
	const existing = await chrome.offscreen.hasDocument?.();
	if (existing) return;
	await chrome.offscreen.createDocument({
		url: OFFSCREEN_URL,
		reasons: [chrome.offscreen.Reason.WORKERS],
		justification: "Hosts the Vault WASM crypto module.",
	});
	offscreenHasKey = false;
}

async function sendToOffscreen(
	message: Record<string, unknown>,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
	await ensureOffscreen();
	// If we have a cached key and the offscreen doesn't, push it in first so
	// downstream operations see an unlocked WASM. Skip for the unlock messages
	// themselves to avoid an infinite loop.
	const type = message.type as string | undefined;
	if (
		cachedMasterKey &&
		!offscreenHasKey &&
		type !== "CRYPTO_UNLOCK" &&
		type !== "CRYPTO_UNLOCK_WITH_KEY"
	) {
		offscreenHasKey = true;
		await chrome.runtime
			.sendMessage({
				target: "offscreen",
				type: "CRYPTO_UNLOCK_WITH_KEY",
				payload: { keyB64: cachedMasterKey },
			})
			.catch(() => {
				offscreenHasKey = false;
			});
	}
	const response = (await chrome.runtime.sendMessage({ ...message, target: "offscreen" })) as
		| { ok: boolean; data?: unknown; error?: string }
		| undefined;
	return response ?? { ok: false, error: "no response from offscreen" };
}


async function persistMasterKey(): Promise<void> {
	if (cachedMasterKey === null) return;
	try {
		await chrome.storage.session.set({ [MASTER_KEY_KEY]: cachedMasterKey });
	} catch (e) {
		console.warn("[titanpass:bg] persistMasterKey failed", e);
	}
}

async function persistAutofillIndex(): Promise<void> {
	if (!autofillIndex) return;
	try {
		await Promise.all([
			chrome.storage.session.set({
				[AUTOFILL_INDEX_KEY]: Array.from(autofillIndex.values()),
			}),
			chrome.storage.local.set({ [HOSTNAMES_KEY]: Array.from(knownHostnames) }),
		]);
	} catch (e) {
		console.warn("[titanpass:bg] persistAutofillIndex failed", e);
	}
}

async function clearSession(): Promise<void> {
	cachedMasterKey = null;
	autofillIndex = null;
	offscreenHasKey = false;
	try {
		await chrome.storage.session.remove([MASTER_KEY_KEY, AUTOFILL_INDEX_KEY]);
	} catch {}
	void chrome.alarms.clear(AUTOLOCK_ALARM);
}

function scheduleAutoLock(): void {
	void chrome.alarms.create(AUTOLOCK_ALARM, { delayInMinutes: SESSION_TIMEOUT_MINUTES });
}

async function exportAndCacheMasterKey(): Promise<void> {
	try {
		const exported = await sendToOffscreen({ type: "CRYPTO_EXPORT_KEY" });
		if (exported.ok && typeof exported.data === "string") {
			cachedMasterKey = exported.data;
			offscreenHasKey = true;
			await persistMasterKey();
		}
	} catch (e) {
		console.warn("[titanpass:bg] export master key failed", e);
	}
}


function findResult(hostname: string): FindResult {
	const pageDomain = registrableDomain(hostname);
	if (!autofillIndex || cachedMasterKey === null) {
		let hasPotentialMatch = false;
		for (const h of knownHostnames) {
			if (registrableDomain(h) === pageDomain) {
				hasPotentialMatch = true;
				break;
			}
		}
		return { matches: [], locked: true, hasPotentialMatch };
	}
	const matches: MatchSummary[] = [];
	for (const entry of autofillIndex.values()) {
		if (registrableDomain(entry.hostname) === pageDomain) {
			matches.push({ id: entry.id, name: entry.name, username: entry.username });
		}
	}
	return { matches, locked: false, hasPotentialMatch: matches.length > 0 };
}

function fetchCredentials(entryId: string): Credentials {
	const entry = autofillIndex?.get(entryId);
	if (!entry) throw new Error(`entry not found: ${entryId}`);
	return { username: entry.username, password: entry.password };
}


chrome.runtime.onInstalled.addListener(() => {
	void ensureOffscreen();
});

chrome.runtime.onStartup.addListener(() => {
	void ensureOffscreen();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (message?.target === "offscreen") return false;

	const type = message?.type as string | undefined;

	if (typeof type === "string" && type.startsWith("CRYPTO_")) {
		void (async () => {
			await hydrationPromise;
			try {
				const response = await sendToOffscreen(message);
				if (response.ok) {
					// Post-success bookkeeping for the unlock / lock messages.
					if (type === "CRYPTO_UNLOCK") {
						offscreenHasKey = true;
						scheduleAutoLock();
						await exportAndCacheMasterKey();
					} else if (type === "CRYPTO_LOCK") {
						await clearSession();
					}
				}
				sendResponse(response);
			} catch (err) {
				sendResponse({ ok: false, error: String(err) });
			}
		})();
		return true;
	}

	if (type === "AUTOFILL_SET_INDEX") {
		void (async () => {
			await hydrationPromise;
			const entries = message.payload as IndexEntry[];
			autofillIndex = new Map();
			knownHostnames.clear();
			for (const entry of entries) {
				autofillIndex.set(entry.id, entry);
				knownHostnames.add(entry.hostname);
			}
			await persistAutofillIndex();
			scheduleAutoLock();
			sendResponse({ ok: true, data: null });
		})();
		return true;
	}

	if (type === "AUTOFILL_CLEAR_INDEX") {
		void (async () => {
			await hydrationPromise;
			autofillIndex = null;
			try {
				await chrome.storage.session.remove([AUTOFILL_INDEX_KEY]);
			} catch {}
			sendResponse({ ok: true, data: null });
		})();
		return true;
	}

	if (type === "AUTOFILL_FIND") {
		void (async () => {
			await hydrationPromise;
			const { hostname } = message.payload as { hostname: string };
			sendResponse({ ok: true, data: findResult(hostname) });
		})();
		return true;
	}

	if (type === "AUTOFILL_FETCH") {
		void (async () => {
			await hydrationPromise;
			try {
				const { entryId } = message.payload as { entryId: string };
				const data = fetchCredentials(entryId);
				scheduleAutoLock();
				sendResponse({ ok: true, data });
			} catch (err) {
				sendResponse({ ok: false, error: String(err) });
			}
		})();
		return true;
	}

	// everything we need in background.
	if (type === "AUTOFILL_QUERY") {
		void (async () => {
			await hydrationPromise;
			const tabId = _sender.tab?.id;
			const hostname = message.hostname as string;
			const result = findResult(hostname);
			// Sliding session: any autofill activity extends the timer.
			if (!result.locked) scheduleAutoLock();
			if (tabId !== undefined) {
				await chrome.tabs
					.sendMessage(tabId, { type: "AUTOFILL_MATCHES", payload: result })
					.catch(() => {});
			}
			sendResponse({ ok: true });
		})();
		return true;
	}

	if (type === "AUTOFILL_SELECT") {
		void (async () => {
			await hydrationPromise;
			try {
				const { entryId, isAuto } = message.payload as {
					entryId: string;
					isAuto?: boolean;
				};
				const credentials = fetchCredentials(entryId);
				scheduleAutoLock();
				if (_sender.tab?.id) {
					// overwrite unconditionally (explicit user pick).
					await chrome.tabs.sendMessage(_sender.tab.id, {
						type: "AUTOFILL_FILL",
						payload: { ...credentials, isAuto: !!isAuto },
					});
				}
				sendResponse({ ok: true });
			} catch (err) {
				sendResponse({ ok: false, error: String(err) });
			}
		})();
		return true;
	}

	return false;
});

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === AUTOLOCK_ALARM) {
		void (async () => {
			await clearSession();
			await sendToOffscreen({ type: "CRYPTO_LOCK" }).catch(() => {});
		})();
	}
});
