/// <reference types="chrome" />

import type {
	CornerPromptPayload,
	CornerPromptResponse,
	FillPayload,
	IndexEntry,
	LoginIndexEntry,
	MatchSummary,
	QueryResult,
	SaveLoginPrompt,
	UpdateLoginPrompt,
} from "@core/adapters/autofill";
import { parseTotp, totpAt } from "@core/util/totp";
import { normalizeEntryData } from "@core/vault/entry-normalize";
import {
	decodeVaultBlob,
	type EncryptedEntry,
	encodeVaultBlob,
	type VaultBlob,
} from "@core/vault-format";
import jsQR from "jsqr";
import {
	type DedupeOutcome,
	dedupeCapture as dedupeCaptureFn,
	hostnameMatches,
	registrableDomain,
} from "./dedupe";
import { extensionStorage, PENDING_BLOB_KEY } from "./storage";

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
const PREF_OFFER_TO_SAVE = "pref.offerToSave";
const PREF_NEVER_SAVE_SITES = "pref.neverSaveSites";

const DEFAULT_AUTOLOCK_MINUTES = 15;
const DEFAULT_CLIPBOARD_SECONDS = 30;
const DEFAULT_OFFER_TO_SAVE = true;

const CAPTURE_KEY_PREFIX = "capture.pending.";
const CORNER_HANDOFF_KEY = "cornerPrompt.handoff";

interface PendingCapture {
	promptId: string;
	etld1: string;
	hostname: string;
	username: string;
	password: string;
	capturedAt: number;
}

interface CornerHandoff {
	intent: "save" | "update";
	capture: PendingCapture;
	chosenEntryId?: string;
}


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
		const all = await chrome.storage.session.get(null);
		const toRemove: string[] = [VEK_KEY, POPOUT_HANDOFF_KEY, CORNER_HANDOFF_KEY];
		for (const key of Object.keys(all)) {
			if (key.startsWith(CAPTURE_KEY_PREFIX)) toRemove.push(key);
		}
		await chrome.storage.session.remove(toRemove);
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


async function getOfferToSavePref(): Promise<boolean> {
	try {
		const r = await chrome.storage.local.get(PREF_OFFER_TO_SAVE);
		const v = r[PREF_OFFER_TO_SAVE];
		if (typeof v === "boolean") return v;
	} catch {}
	return DEFAULT_OFFER_TO_SAVE;
}

async function getNeverSaveSites(): Promise<Set<string>> {
	try {
		const r = await chrome.storage.local.get(PREF_NEVER_SAVE_SITES);
		const v = r[PREF_NEVER_SAVE_SITES];
		if (Array.isArray(v)) return new Set(v.filter((s): s is string => typeof s === "string"));
	} catch {}
	return new Set();
}

async function appendNeverSaveSite(etld1: string): Promise<void> {
	const current = await getNeverSaveSites();
	if (current.has(etld1)) return;
	current.add(etld1);
	await chrome.storage.local.set({ [PREF_NEVER_SAVE_SITES]: Array.from(current) });
}

function captureStashKey(etld1: string): string {
	return CAPTURE_KEY_PREFIX + etld1;
}

async function readPendingCapture(etld1: string): Promise<PendingCapture | null> {
	try {
		const key = captureStashKey(etld1);
		const r = await chrome.storage.session.get(key);
		const v = r[key] as PendingCapture | undefined;
		return v ?? null;
	} catch {
		return null;
	}
}

async function writePendingCapture(capture: PendingCapture): Promise<void> {
	await chrome.storage.session.set({ [captureStashKey(capture.etld1)]: capture });
}

async function clearPendingCapture(etld1: string): Promise<void> {
	await chrome.storage.session.remove(captureStashKey(etld1));
}

function dedupeCapture(hostname: string, username: string, password: string): DedupeOutcome {
	return dedupeCaptureFn(autofillIndex, hostname, username, password);
}

function buildCornerPayload(
	capture: PendingCapture,
	outcome: DedupeOutcome,
	locked: boolean,
): CornerPromptPayload | null {
	if (outcome.kind === "exact") return null;
	if (outcome.kind === "save") {
		const payload: SaveLoginPrompt = {
			kind: "save-login",
			promptId: capture.promptId,
			hostname: capture.hostname,
			locked,
			username: capture.username,
			password: capture.password,
		};
		return payload;
	}
	const payload: UpdateLoginPrompt = {
		kind: "update-login",
		promptId: capture.promptId,
		hostname: capture.hostname,
		locked,
		candidates: outcome.candidates.map((c) => ({
			id: c.id,
			name: c.name,
			username: c.username,
		})),
		newPassword: capture.password,
	};
	return payload;
}

function vaultLocked(): boolean {
	return cachedVek === null;
}

async function hydrateAutofillIndexFromDisk(): Promise<boolean> {
	if (autofillIndex !== null) return true;
	if (cachedVek === null) return false;
	try {
		const blob = await readAndDecodeVault();
		if (blob.entriesCiphertext.length === 0) {
			autofillIndex = new Map();
			return true;
		}
		const outerResp = await sendToOffscreen({
			type: "CRYPTO_DECRYPT_OUTER",
			payload: {
				iv: bytesToBase64(blob.entriesIv),
				ciphertext: bytesToBase64(blob.entriesCiphertext),
			},
		});
		if (!outerResp.ok || typeof outerResp.data !== "string") return false;
		const encryptedEntries = JSON.parse(outerResp.data) as EncryptedEntry[];
		const newIndex = new Map<string, IndexEntry>();
		for (const enc of encryptedEntries) {
			const dec = await sendToOffscreen({
				type: "CRYPTO_DECRYPT",
				payload: {
					ciphertext: enc.ciphertext,
					iv: enc.iv,
					wrappedDek: enc.wrappedDek,
					dekIv: enc.dekIv,
				},
			});
			if (!dec.ok || typeof dec.data !== "string") continue;
			const data = normalizeEntryData(JSON.parse(dec.data));
			const customFields =
				data.customFields?.filter((f) => f.value).map((f) => ({ key: f.key, value: f.value })) ??
				undefined;
			const projectedCustomFields =
				customFields && customFields.length > 0 ? customFields : undefined;
			if (data.type === "login") {
				const hostnames: string[] = [];
				for (const u of data.urls) {
					if (!u) continue;
					try {
						hostnames.push(new URL(u).hostname);
					} catch {
						hostnames.push(u);
					}
				}
				newIndex.set(enc.id, {
					type: "login",
					id: enc.id,
					hostnames,
					name: data.name,
					username: data.username,
					password: data.password,
					totp: data.totp,
					customFields: projectedCustomFields,
					autofillEnabled: data.autofillEnabled,
					autoSubmit: data.autoSubmit,
					subdomainMatch: data.subdomainMatch,
				});
				for (const h of hostnames) knownHostnames.add(h);
			} else if (data.type === "card") {
				newIndex.set(enc.id, {
					type: "card",
					id: enc.id,
					name: data.name,
					brand: data.brand,
					cardholderName: data.cardholderName,
					number: data.number,
					expMonth: data.expMonth,
					expYear: data.expYear,
					cvv: data.cvv,
					customFields: projectedCustomFields,
				});
			}
		}
		autofillIndex = newIndex;
		await persistKnownHostnames();
		return true;
	} catch (e) {
		console.warn("[titanpass:bg] hydrateAutofillIndexFromDisk failed", e);
		return false;
	}
}

async function broadcastVaultChanged(): Promise<void> {
	try {
		await chrome.runtime.sendMessage({ type: "VAULT_CHANGED_EXTERNAL" });
	} catch {}
}

async function reencryptOuterWithEntryChange(
	currentBlob: VaultBlob,
	mutate: (entries: EncryptedEntry[]) => Promise<EncryptedEntry[]>,
): Promise<{ entriesIv: Uint8Array; entriesCiphertext: Uint8Array; entryCount: number }> {
	let entries: EncryptedEntry[];
	if (currentBlob.entriesCiphertext.length === 0) {
		entries = [];
	} else {
		const decrypted = await sendToOffscreen({
			type: "CRYPTO_DECRYPT_OUTER",
			payload: {
				iv: bytesToBase64(currentBlob.entriesIv),
				ciphertext: bytesToBase64(currentBlob.entriesCiphertext),
			},
		});
		if (!decrypted.ok || typeof decrypted.data !== "string") {
			throw new Error(`outer decrypt failed: ${decrypted.error ?? "no data"}`);
		}
		entries = JSON.parse(decrypted.data) as EncryptedEntry[];
	}
	const mutated = await mutate(entries);
	const json = JSON.stringify(mutated);
	const encrypted = await sendToOffscreen({
		type: "CRYPTO_ENCRYPT_OUTER",
		payload: { plaintext: json },
	});
	if (!encrypted.ok || !encrypted.data || typeof encrypted.data !== "object") {
		throw new Error(`outer encrypt failed: ${encrypted.error ?? "no data"}`);
	}
	const { iv, ciphertext } = encrypted.data as { iv: string; ciphertext: string };
	return {
		entriesIv: base64ToBytes(iv),
		entriesCiphertext: base64ToBytes(ciphertext),
		entryCount: mutated.length,
	};
}

function bytesToBase64(bytes: Uint8Array): string {
	let s = "";
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] ?? 0);
	return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
	const s = atob(b64);
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	return out;
}

async function writeOrQueueVault(blob: Uint8Array, entryCount: number): Promise<void> {
	const canWrite = await extensionStorage.canWriteFromBackground();
	if (canWrite) {
		await extensionStorage.writeVaultBlob(blob);
		return;
	}
	await chrome.storage.session.set({
		[PENDING_BLOB_KEY]: {
			blobB64: bytesToBase64(blob),
			entryCount,
			queuedAt: Date.now(),
		},
	});
}

function newLoginPlaintext(capture: PendingCapture, editedUsername?: string): string {
	const username = editedUsername ?? capture.username;
	return JSON.stringify({
		type: "login",
		name: capture.hostname,
		urls: [`https://${capture.hostname}`],
		username,
		password: capture.password,
	});
}

async function commitCornerSave(
	capture: PendingCapture,
	editedUsername: string | undefined,
): Promise<void> {
	const blob = await readAndDecodeVault();
	const plaintext = newLoginPlaintext(capture, editedUsername);
	const encryptedEntryResp = await sendToOffscreen({
		type: "CRYPTO_ENCRYPT",
		payload: { plaintextJson: plaintext },
	});
	if (!encryptedEntryResp.ok || !encryptedEntryResp.data) {
		throw new Error(`encrypt new entry failed: ${encryptedEntryResp.error ?? "no data"}`);
	}
	const encEntry = encryptedEntryResp.data as Omit<EncryptedEntry, "id">;
	const id = globalThis.crypto.randomUUID();
	const newEnc: EncryptedEntry = { id, ...encEntry };
	const outer = await reencryptOuterWithEntryChange(blob, async (entries) => [...entries, newEnc]);
	const newBlob: VaultBlob = {
		slots: blob.slots,
		entriesIv: outer.entriesIv,
		entriesCiphertext: outer.entriesCiphertext,
	};
	await writeOrQueueVault(encodeVaultBlob(newBlob), outer.entryCount);

	if (autofillIndex) {
		const username = editedUsername ?? capture.username;
		const newIndexEntry: LoginIndexEntry = {
			type: "login",
			id,
			hostnames: [capture.hostname],
			name: capture.hostname,
			username,
			password: capture.password,
		};
		autofillIndex.set(id, newIndexEntry);
		knownHostnames.add(capture.hostname);
		await persistKnownHostnames();
	}
	await broadcastVaultChanged();
}

async function commitCornerUpdate(capture: PendingCapture, chosenEntryId: string): Promise<void> {
	const indexEntry = autofillIndex?.get(chosenEntryId);
	if (!indexEntry || indexEntry.type !== "login") {
		throw new Error(`update target not in index: ${chosenEntryId}`);
	}
	const blob = await readAndDecodeVault();
	const outer = await reencryptOuterWithEntryChange(blob, async (entries) => {
		const next: EncryptedEntry[] = [];
		for (const enc of entries) {
			if (enc.id !== chosenEntryId) {
				next.push(enc);
				continue;
			}
			const dec = await sendToOffscreen({
				type: "CRYPTO_DECRYPT",
				payload: {
					ciphertext: enc.ciphertext,
					iv: enc.iv,
					wrappedDek: enc.wrappedDek,
					dekIv: enc.dekIv,
				},
			});
			if (!dec.ok || typeof dec.data !== "string") {
				throw new Error(`decrypt entry failed: ${dec.error ?? "no data"}`);
			}
			const parsed = JSON.parse(dec.data);
			parsed.username = capture.username;
			parsed.password = capture.password;
			const reenc = await sendToOffscreen({
				type: "CRYPTO_ENCRYPT",
				payload: { plaintextJson: JSON.stringify(parsed) },
			});
			if (!reenc.ok || !reenc.data) {
				throw new Error(`reencrypt entry failed: ${reenc.error ?? "no data"}`);
			}
			const fresh = reenc.data as Omit<EncryptedEntry, "id">;
			next.push({ id: enc.id, ...fresh });
		}
		return next;
	});
	const newBlob: VaultBlob = {
		slots: blob.slots,
		entriesIv: outer.entriesIv,
		entriesCiphertext: outer.entriesCiphertext,
	};
	await writeOrQueueVault(encodeVaultBlob(newBlob), outer.entryCount);
	autofillIndex?.set(chosenEntryId, {
		...indexEntry,
		username: capture.username,
		password: capture.password,
	});
	await broadcastVaultChanged();
}

async function readAndDecodeVault(): Promise<VaultBlob> {
	const bytes = await extensionStorage.readVaultBlob();
	return decodeVaultBlob(bytes);
}

async function dispatchCornerPromptForCapture(
	capture: PendingCapture,
	tabId: number | undefined,
): Promise<CornerPromptPayload | null> {
	const offerToSave = await getOfferToSavePref();
	if (!offerToSave) return null;
	const muted = await getNeverSaveSites();
	if (muted.has(capture.etld1)) return null;

	await hydrateAutofillIndexFromDisk();
	const locked = vaultLocked();
	const outcome = dedupeCapture(capture.hostname, capture.username, capture.password);
	const payload = buildCornerPayload(capture, outcome, locked);
	if (!payload) {
		await clearPendingCapture(capture.etld1);
		return null;
	}
	await writePendingCapture(capture);
	if (tabId !== undefined) {
		await chrome.tabs.sendMessage(tabId, { type: "CORNER_PROMPT_SHOW", payload }).catch(() => {});
	}
	return payload;
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
				if (entry.type === "login") {
					for (const h of entry.hostnames) knownHostnames.add(h);
				}
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
			await hydrateAutofillIndexFromDisk();
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
			await hydrateAutofillIndexFromDisk();
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
			await hydrateAutofillIndexFromDisk();
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

	if (type === "CORNER_PROMPT_CAPTURE") {
		void (async () => {
			await hydrationPromise;
			try {
				let hostname = "";
				try {
					const src = _sender.origin ?? _sender.url ?? _sender.tab?.url ?? "";
					if (src) hostname = new URL(src).hostname;
				} catch {}
				if (!hostname) {
					sendResponse({ ok: false, error: "no verifiable origin on sender" });
					return;
				}
				const { username, password } = message.payload as {
					username: string;
					password: string;
				};
				if (!password) {
					sendResponse({ ok: true, data: null });
					return;
				}
				const etld1 = registrableDomain(hostname);
				const capture: PendingCapture = {
					promptId: globalThis.crypto.randomUUID(),
					etld1,
					hostname,
					username,
					password,
					capturedAt: Date.now(),
				};
				const dispatched = await dispatchCornerPromptForCapture(capture, _sender.tab?.id);
				sendResponse({ ok: true, data: dispatched });
			} catch (err) {
				sendResponse({ ok: false, error: String(err) });
			}
		})();
		return true;
	}

	if (type === "CORNER_PROMPT_QUERY") {
		void (async () => {
			await hydrationPromise;
			let hostname = "";
			try {
				const src = _sender.origin ?? _sender.url ?? _sender.tab?.url ?? "";
				if (src) hostname = new URL(src).hostname;
			} catch {}
			if (!hostname) {
				sendResponse({ ok: true, data: null });
				return;
			}
			const offerToSave = await getOfferToSavePref();
			if (!offerToSave) {
				sendResponse({ ok: true, data: null });
				return;
			}
			const etld1 = registrableDomain(hostname);
			const capture = await readPendingCapture(etld1);
			if (!capture) {
				sendResponse({ ok: true, data: null });
				return;
			}
			await hydrateAutofillIndexFromDisk();
			const locked = vaultLocked();
			const outcome = dedupeCapture(capture.hostname, capture.username, capture.password);
			const payload = buildCornerPayload(capture, outcome, locked);
			if (!payload) {
				await clearPendingCapture(etld1);
				sendResponse({ ok: true, data: null });
				return;
			}
			sendResponse({ ok: true, data: payload });
		})();
		return true;
	}

	if (type === "CORNER_PROMPT_RESPONSE") {
		void (async () => {
			await hydrationPromise;
			try {
				const response = message.payload as CornerPromptResponse;
				let hostname = "";
				try {
					const src = _sender.origin ?? _sender.url ?? _sender.tab?.url ?? "";
					if (src) hostname = new URL(src).hostname;
				} catch {}
				const etld1 = hostname ? registrableDomain(hostname) : "";
				const capture = etld1 ? await readPendingCapture(etld1) : null;
				if (!capture || capture.promptId !== response.promptId) {
					if (response.action === "never" && etld1) await appendNeverSaveSite(etld1);
					if (etld1) await clearPendingCapture(etld1);
					sendResponse({ ok: true, data: null });
					return;
				}

				if (response.action === "dismiss") {
					await clearPendingCapture(etld1);
					sendResponse({ ok: true, data: null });
					return;
				}
				if (response.action === "never") {
					await appendNeverSaveSite(etld1);
					await clearPendingCapture(etld1);
					sendResponse({ ok: true, data: null });
					return;
				}
				if (response.action === "save-unlock-first") {
					if (!vaultLocked()) {
						await hydrateAutofillIndexFromDisk();
						const outcome = dedupeCapture(capture.hostname, capture.username, capture.password);
						try {
							if (outcome.kind === "exact") {
								// no-op
							} else if (
								outcome.kind === "update" &&
								(response.chosenEntryId || outcome.candidates.length === 1)
							) {
								const targetId = response.chosenEntryId ?? outcome.candidates[0]!.id;
								await commitCornerUpdate(capture, targetId);
							} else {
								await commitCornerSave(capture, undefined);
							}
						} finally {
							await clearPendingCapture(etld1);
						}
						sendResponse({ ok: true, data: null });
						return;
					}
					const handoff: CornerHandoff = {
						intent: response.chosenEntryId ? "update" : "save",
						capture,
						chosenEntryId: response.chosenEntryId,
					};
					await chrome.storage.session.set({ [CORNER_HANDOFF_KEY]: handoff });
					try {
						const openPopupFn = (chrome.action as unknown as { openPopup?: () => Promise<void> })
							.openPopup;
						if (typeof openPopupFn === "function") {
							await openPopupFn.call(chrome.action);
						} else {
							throw new Error("openPopup unavailable");
						}
					} catch {
						try {
							await chrome.windows.create({
								url: chrome.runtime.getURL("popup.html?detached=1"),
								type: "popup",
								focused: true,
								width: 500,
								height: 600,
							});
						} catch {}
					}
					sendResponse({ ok: true, data: null });
					return;
				}
				if (response.action === "save") {
					await hydrateAutofillIndexFromDisk();
					const editedCapture: PendingCapture = response.editedUsername
						? { ...capture, username: response.editedUsername }
						: capture;
					const outcome = dedupeCapture(
						editedCapture.hostname,
						editedCapture.username,
						editedCapture.password,
					);
					try {
						if (outcome.kind === "exact") {
							// no-op
						} else if (outcome.kind === "update" && outcome.candidates.length === 1) {
							await commitCornerUpdate(editedCapture, outcome.candidates[0]!.id);
						} else {
							await commitCornerSave(editedCapture, undefined);
						}
					} finally {
						await clearPendingCapture(etld1);
					}
					sendResponse({ ok: true, data: null });
					return;
				}
				if (response.action === "update") {
					if (!response.chosenEntryId) {
						sendResponse({ ok: false, error: "update missing chosenEntryId" });
						return;
					}
					await hydrateAutofillIndexFromDisk();
					try {
						await commitCornerUpdate(capture, response.chosenEntryId);
					} finally {
						await clearPendingCapture(etld1);
					}
					sendResponse({ ok: true, data: null });
					return;
				}
				sendResponse({ ok: false, error: `unknown action: ${response.action}` });
			} catch (err) {
				console.error("[titanpass:bg] CORNER_PROMPT_RESPONSE failed", err);
				sendResponse({ ok: false, error: String(err) });
			}
		})();
		return true;
	}

	if (type === "CORNER_FLUSH_HANDOFF") {
		void (async () => {
			await hydrationPromise;
			try {
				const r = await chrome.storage.session.get(CORNER_HANDOFF_KEY);
				const handoff = r[CORNER_HANDOFF_KEY] as CornerHandoff | undefined;
				if (!handoff) {
					sendResponse({ ok: true, data: false });
					return;
				}
				await chrome.storage.session.remove(CORNER_HANDOFF_KEY);
				await hydrateAutofillIndexFromDisk();
				if (vaultLocked()) {
					sendResponse({ ok: false, error: "vault still locked" });
					return;
				}
				const outcome = dedupeCapture(
					handoff.capture.hostname,
					handoff.capture.username,
					handoff.capture.password,
				);
				try {
					if (outcome.kind === "exact") {
						// no-op
					} else if (outcome.kind === "update") {
						const targetId = handoff.chosenEntryId ?? outcome.candidates[0]?.id;
						if (!targetId) throw new Error("no update target");
						await commitCornerUpdate(handoff.capture, targetId);
					} else {
						await commitCornerSave(handoff.capture, undefined);
					}
				} finally {
					await clearPendingCapture(handoff.capture.etld1);
				}
				sendResponse({ ok: true, data: true });
			} catch (err) {
				console.error("[titanpass:bg] CORNER_FLUSH_HANDOFF failed", err);
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

chrome.commands?.onCommand.addListener((command) => {
	if (command !== "lock-vault") return;
	void (async () => {
		await clearSession();
		await sendToOffscreen({ type: "CRYPTO_LOCK" }).catch(() => {});
	})();
});

chrome.idle?.onStateChanged.addListener((state) => {
	if (state !== "locked") return;
	if (cachedVek === null) return;
	void (async () => {
		await clearSession();
		await sendToOffscreen({ type: "CRYPTO_LOCK" }).catch(() => {});
	})();
});

chrome.storage.onChanged.addListener((changes, area) => {
	if (area !== "local") return;
	if (changes[PREF_AUTOLOCK_MINUTES] && cachedVek !== null) {
		void scheduleAutoLock();
	}
});
