/// <reference types="chrome" />

import type {
	FillPayload,
	IndexEntry,
	LoginIndexEntry,
	MatchSummary,
	QueryResult,
} from "@core/adapters/autofill";
import { parseTotp, totpAt } from "@core/util/totp";
import jsQR from "jsqr";
import { getDomain } from "tldts";

//

const OFFSCREEN_URL = "offscreen.html";

const VEK_KEY = "vault.vek";
const LEGACY_AUTOFILL_INDEX_KEY = "autofill.index";
const HOSTNAMES_KEY = "autofill.knownHostnames";
const CLIPBOARD_EXPECTED_KEY = "clipboard.expectedHash";
const POPOUT_HANDOFF_KEY = "popout.handoff";

const AUTOLOCK_ALARM = "vault:autolock";
const CLIPBOARD_ALARM = "vault:clipboard-clear";

const PREF_AUTOLOCK_MINUTES = "pref.autoLockMinutes";
const PREF_CLIPBOARD_SECONDS = "pref.clipboardClearSeconds";

const DEFAULT_AUTOLOCK_MINUTES = 15;
const DEFAULT_CLIPBOARD_SECONDS = 30;


let autofillIndex: Map<string, IndexEntry> | null = null;
const knownHostnames = new Set<string>();
let cachedVek: string | null = null;
let offscreenHasKey = false;

const hydrationPromise = (async () => {
	try {
		const [sessionResult, localResult] = await Promise.all([
			chrome.storage.session.get([VEK_KEY]),
			chrome.storage.local.get([HOSTNAMES_KEY]),
		]);
		const cached = sessionResult[VEK_KEY];
		if (typeof cached === "string") cachedVek = cached;
		const hostnames = localResult[HOSTNAMES_KEY];
		if (Array.isArray(hostnames)) for (const h of hostnames) knownHostnames.add(h);
		await chrome.storage.session.remove([LEGACY_AUTOFILL_INDEX_KEY]).catch(() => {});
	} catch (e) {
		console.warn("[titanpass:bg] hydration failed", e);
	}
})();

function registrableDomain(hostname: string): string {
	return getDomain(hostname) ?? hostname;
}

// ── Per-entry hostname matching ─────────────────────────────────────────────
// Each entry can opt into a stricter or looser policy than the default
// eTLD+1 collapse. We evaluate the policy when serving findResult to the
// content script.

function hostnameMatches(entry: LoginIndexEntry, pageHostname: string): boolean {
	const entryHost = entry.hostname.toLowerCase();
	const pageHost = pageHostname.toLowerCase();
	switch (entry.subdomainMatch ?? "etld1") {
		case "exact":
			return entryHost === pageHost;
		case "subdomain":
			return pageHost === entryHost || pageHost.endsWith(`.${entryHost}`);
		default:
			return registrableDomain(entryHost) === registrableDomain(pageHost);
	}
}


async function ensureOffscreen(): Promise<void> {
	const existing = await chrome.offscreen.hasDocument?.();
	if (existing) return;
	await chrome.offscreen.createDocument({
		url: OFFSCREEN_URL,
		reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.CLIPBOARD],
		justification: "Hosts the Vault WASM crypto module and clears the clipboard after a copy.",
	});
	offscreenHasKey = false;
}

async function sendToOffscreen(
	message: Record<string, unknown>,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
	await ensureOffscreen();
	const type = message.type as string | undefined;
	const skipKeyInjection =
		type === "CRYPTO_UNWRAP_PASSWORD_SLOT" ||
		type === "CRYPTO_UNLOCK_WITH_VEK" ||
		type === "CRYPTO_GENERATE_VEK" ||
		type === "CLIPBOARD_CLEAR";
	if (cachedVek && !offscreenHasKey && !skipKeyInjection) {
		offscreenHasKey = true;
		await chrome.runtime
			.sendMessage({
				target: "offscreen",
				type: "CRYPTO_UNLOCK_WITH_VEK",
				payload: { vekB64: cachedVek },
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


async function getAutoLockMinutes(): Promise<number> {
	try {
		const r = await chrome.storage.local.get(PREF_AUTOLOCK_MINUTES);
		const v = r[PREF_AUTOLOCK_MINUTES];
		if (typeof v === "number" && v >= 0) return v;
	} catch {}
	return DEFAULT_AUTOLOCK_MINUTES;
}

async function getClipboardSeconds(): Promise<number> {
	try {
		const r = await chrome.storage.local.get(PREF_CLIPBOARD_SECONDS);
		const v = r[PREF_CLIPBOARD_SECONDS];
		if (typeof v === "number" && v > 0) return v;
	} catch {}
	return DEFAULT_CLIPBOARD_SECONDS;
}


async function persistVek(): Promise<void> {
	if (cachedVek === null) return;
	try {
		await chrome.storage.session.set({ [VEK_KEY]: cachedVek });
	} catch (e) {
		console.warn("[titanpass:bg] persistVek failed", e);
	}
}

async function persistKnownHostnames(): Promise<void> {
	try {
		await chrome.storage.local.set({ [HOSTNAMES_KEY]: Array.from(knownHostnames) });
	} catch (e) {
		console.warn("[titanpass:bg] persistKnownHostnames failed", e);
	}
}

async function clearSession(): Promise<void> {
	cachedVek = null;
	autofillIndex = null;
	offscreenHasKey = false;
	try {
		await chrome.storage.session.remove([VEK_KEY, POPOUT_HANDOFF_KEY]);
	} catch {}
	void chrome.alarms.clear(AUTOLOCK_ALARM);
}

async function scheduleAutoLock(): Promise<void> {
	const minutes = await getAutoLockMinutes();
	if (minutes <= 0) {
		void chrome.alarms.clear(AUTOLOCK_ALARM);
		return;
	}
	void chrome.alarms.create(AUTOLOCK_ALARM, { delayInMinutes: minutes });
}

async function exportAndCacheVek(): Promise<void> {
	try {
		const exported = await sendToOffscreen({ type: "CRYPTO_EXPORT_VEK" });
		if (exported.ok && typeof exported.data === "string") {
			cachedVek = exported.data;
			offscreenHasKey = true;
			await persistVek();
		}
	} catch (e) {
		console.warn("[titanpass:bg] export VEK failed", e);
	}
}


async function scheduleClipboardClear(expectedHash: string): Promise<void> {
	const seconds = await getClipboardSeconds();
	try {
		await chrome.storage.session.set({ [CLIPBOARD_EXPECTED_KEY]: expectedHash });
	} catch {}
	void chrome.alarms.create(CLIPBOARD_ALARM, { delayInMinutes: seconds / 60 });
}

async function runClipboardClear(): Promise<void> {
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


function cardSecondary(entry: Extract<IndexEntry, { type: "card" }>): string {
	const last4 = entry.number.replace(/\D/g, "").slice(-4);
	const tail = last4 ? `•••• ${last4}` : "";
	return [entry.brand, tail].filter(Boolean).join(" ");
}

function queryResult(
	hostname: string,
	hasLogin: boolean,
	hasCard: boolean,
	hasOtp: boolean,
): QueryResult {
	if (!autofillIndex || cachedVek === null) {
		const pageDomain = registrableDomain(hostname);
		let hasPotentialMatch = false;
		for (const h of knownHostnames) {
			if (registrableDomain(h) === pageDomain) {
				hasPotentialMatch = true;
				break;
			}
		}
		return { logins: [], cards: [], otps: [], locked: true, hasPotentialMatch };
	}
	const logins: MatchSummary[] = [];
	const cards: MatchSummary[] = [];
	const otps: MatchSummary[] = [];
	for (const entry of autofillIndex.values()) {
		if (entry.type === "login") {
			if (!hostnameMatches(entry, hostname)) continue;
			if (hasLogin) {
				logins.push({
					id: entry.id,
					name: entry.name,
					secondary: entry.username,
					autofillEnabled: entry.autofillEnabled,
					autoSubmit: entry.autoSubmit,
				});
			}
			if (hasOtp && entry.totp) {
				otps.push({
					id: entry.id,
					name: entry.name,
					secondary: entry.username,
					autofillEnabled: entry.autofillEnabled,
				});
			}
		} else if (hasCard) {
			cards.push({ id: entry.id, name: entry.name, secondary: cardSecondary(entry) });
		}
	}
	return { logins, cards, otps, locked: false, hasPotentialMatch: logins.length > 0 };
}

function fetchFill(entryId: string): FillPayload {
	const entry = autofillIndex?.get(entryId);
	if (!entry) throw new Error(`entry not found: ${entryId}`);
	if (entry.type === "login") {
		let totp: string | undefined;
		if (entry.totp) {
			const parsed = parseTotp(entry.totp);
			if (parsed) totp = totpAt(parsed.totp).code;
		}
		return {
			kind: "login",
			username: entry.username,
			password: entry.password,
			totp,
			autoSubmit: entry.autoSubmit,
			customFields: entry.customFields,
		};
	}
	return {
		kind: "card",
		cardholderName: entry.cardholderName,
		number: entry.number,
		expMonth: entry.expMonth,
		expYear: entry.expYear,
		cvv: entry.cvv,
		customFields: entry.customFields,
	};
}


chrome.runtime.onInstalled.addListener(() => {
	void ensureOffscreen();
});

chrome.runtime.onStartup.addListener(() => {
	void ensureOffscreen();
});

async function decodeQrDataUrl(dataUrl: string): Promise<string | null> {
	const blob = await (await fetch(dataUrl)).blob();
	const bitmap = await createImageBitmap(blob);
	const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;
	ctx.drawImage(bitmap, 0, 0);
	bitmap.close();
	const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
	return jsQR(data, width, height)?.data ?? null;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (message?.target === "offscreen") return false;

	const type = message?.type as string | undefined;

	if (typeof type === "string" && type.startsWith("CRYPTO_")) {
		void (async () => {
			await hydrationPromise;
			try {
				const response = await sendToOffscreen(message);
				if (response.ok) {
					if (type === "CRYPTO_GENERATE_VEK") {
						if (typeof response.data === "string") {
							cachedVek = response.data;
							offscreenHasKey = true;
							await persistVek();
						}
						await scheduleAutoLock();
					} else if (type === "CRYPTO_UNWRAP_PASSWORD_SLOT") {
						if (response.data === true) {
							offscreenHasKey = true;
							await scheduleAutoLock();
							await exportAndCacheVek();
						}
					} else if (type === "CRYPTO_ROTATE_VEK") {
						if (typeof response.data === "string") {
							cachedVek = response.data;
							offscreenHasKey = true;
							await persistVek();
						}
					} else if (type === "CRYPTO_UNLOCK_WITH_VEK") {
						const payload = (message.payload ?? {}) as { vekB64?: string };
						if (typeof payload.vekB64 === "string") {
							cachedVek = payload.vekB64;
							offscreenHasKey = true;
							await persistVek();
						}
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
				// Only logins carry a hostname for the locked-state hint registry.
				if (entry.type === "login") knownHostnames.add(entry.hostname);
			}
			await persistKnownHostnames();
			await scheduleAutoLock();
			sendResponse({ ok: true, data: null });
		})();
		return true;
	}

	if (type === "AUTOFILL_CLEAR_INDEX") {
		void (async () => {
			await hydrationPromise;
			autofillIndex = null;
			sendResponse({ ok: true, data: null });
		})();
		return true;
	}

	if (type === "AUTOFILL_FIND") {
		void (async () => {
			await hydrationPromise;
			const { hostname, hasLogin, hasCard, hasOtp } = message.payload as {
				hostname: string;
				hasLogin?: boolean;
				hasCard?: boolean;
				hasOtp?: boolean;
			};
			sendResponse({
				ok: true,
				data: queryResult(hostname, hasLogin !== false, hasCard === true, hasOtp === true),
			});
		})();
		return true;
	}

	if (type === "AUTOFILL_FETCH") {
		void (async () => {
			await hydrationPromise;
			try {
				const { entryId } = message.payload as { entryId: string };
				const data = fetchFill(entryId);
				await scheduleAutoLock();
				sendResponse({ ok: true, data });
			} catch (err) {
				sendResponse({ ok: false, error: String(err) });
			}
		})();
		return true;
	}

	if (type === "AUTOFILL_QUERY") {
		void (async () => {
			await hydrationPromise;
			const tabId = _sender.tab?.id;
			let hostname = "";
			try {
				const src = _sender.origin ?? _sender.url ?? _sender.tab?.url ?? "";
				if (src) hostname = new URL(src).hostname;
			} catch {}
			if (!hostname) {
				sendResponse({ ok: false, error: "no verifiable origin on sender" });
				return;
			}
			const hasLogin = message.hasLogin !== false;
			const hasCard = message.hasCard === true;
			const hasOtp = message.hasOtp === true;
			const result = queryResult(hostname, hasLogin, hasCard, hasOtp);
			// Sliding session: any autofill activity extends the timer.
			if (!result.locked) await scheduleAutoLock();
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
				const { entryId, isAuto, otpOnly } = message.payload as {
					entryId: string;
					isAuto?: boolean;
					otpOnly?: boolean;
				};
				const fill = fetchFill(entryId);
				await scheduleAutoLock();
				if (_sender.tab?.id) {
					await chrome.tabs.sendMessage(_sender.tab.id, {
						type: "AUTOFILL_FILL",
						payload: { ...fill, isAuto: !!isAuto, otpOnly: !!otpOnly },
					});
				}
				sendResponse({ ok: true });
			} catch (err) {
				sendResponse({ ok: false, error: String(err) });
			}
		})();
		return true;
	}

	if (type === "POPOUT_OPEN") {
		void (async () => {
			try {
				const handoff = (message.payload as { handoff?: unknown } | undefined)?.handoff;
				if (handoff) {
					await chrome.storage.session.set({ [POPOUT_HANDOFF_KEY]: handoff });
				} else {
					await chrome.storage.session.remove([POPOUT_HANDOFF_KEY]);
				}
				const WIDTH = 500;
				const HEIGHT = 600;
				const CHROME_INSET = 80;
				let anchor: chrome.windows.Window | undefined;
				if (_sender.tab?.windowId !== undefined) {
					anchor = await chrome.windows.get(_sender.tab.windowId).catch(() => undefined);
				}
				if (!anchor) {
					anchor = await chrome.windows.getCurrent().catch(() => undefined);
				}
				const top = (anchor?.top ?? 0) + CHROME_INSET;
				const left = (anchor?.left ?? 0) + (anchor?.width ?? WIDTH) - WIDTH;
				const created = await chrome.windows.create({
					url: chrome.runtime.getURL("popup.html?detached=1"),
					type: "popup",
					focused: true,
					width: WIDTH,
					height: HEIGHT,
					top,
					left,
				});
				if (created?.id !== undefined) {
					await chrome.windows.update(created.id, {
						state: "normal",
						width: WIDTH,
						height: HEIGHT,
						top,
						left,
					});
				}
				sendResponse({ ok: true });
			} catch (err) {
				sendResponse({ ok: false, error: String(err) });
			}
		})();
		return true;
	}

	if (type === "POPOUT_CONSUME_HANDOFF") {
		void (async () => {
			let handoff: unknown = null;
			try {
				const r = await chrome.storage.session.get(POPOUT_HANDOFF_KEY);
				handoff = r[POPOUT_HANDOFF_KEY] ?? null;
				await chrome.storage.session.remove([POPOUT_HANDOFF_KEY]);
			} catch {}
			sendResponse({ ok: true, data: handoff });
		})();
		return true;
	}

	if (type === "CAPTURE_QR_SCAN") {
		void (async () => {
			try {
				const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
				if (win?.id === undefined) {
					sendResponse({ ok: false, error: "No browser window to capture" });
					return;
				}
				const dataUrl = await chrome.tabs.captureVisibleTab(win.id, { format: "png" });
				const decoded = await decodeQrDataUrl(dataUrl);
				sendResponse({ ok: true, data: decoded });
			} catch (err) {
				sendResponse({ ok: false, error: String(err) });
			}
		})();
		return true;
	}

	if (type === "CLIPBOARD_SCHEDULE_CLEAR") {
		void (async () => {
			const { expectedHash } = (message.payload ?? {}) as { expectedHash?: string };
			if (typeof expectedHash === "string" && expectedHash.length > 0) {
				await scheduleClipboardClear(expectedHash);
			}
			sendResponse({ ok: true, data: null });
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
		return;
	}
	if (alarm.name === CLIPBOARD_ALARM) {
		void runClipboardClear();
		return;
	}
});

chrome.storage.onChanged.addListener((changes, area) => {
	if (area !== "local") return;
	if (changes[PREF_AUTOLOCK_MINUTES] && cachedVek !== null) {
		void scheduleAutoLock();
	}
});
