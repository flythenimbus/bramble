/// <reference types="chrome" />

import type {
	FillPayload,
	IndexEntry,
	LoginIndexEntry,
	MatchSummary,
	QueryResult,
} from "@core/adapters/autofill";
import { parseTotp, totpAt } from "@core/util/totp";
import { normalizeEntryData } from "@core/vault/entry-normalize";
import type { EncryptedEntry } from "@core/vault-format";
import {
	type DedupeOutcome,
	dedupeCapture as dedupeCaptureFn,
	hostnameMatches,
	registrableDomain,
} from "../dedupe";
import { api } from "../platform-api";
import { isExtensionSender } from "../sender";
import { sendToOffscreen } from "./offscreen-client";
import { type MessageEnvelope, on } from "./router";
import { scheduleAutoLock, vaultLocked } from "./session";
import { bytesToBase64, readAndDecodeVault } from "./vault-io";

const HOSTNAMES_KEY = "autofill.knownHostnames";

// In-memory caches. The decrypted autofill index is never persisted (plaintext
// secrets); it stays null after a SW restart until the popup re-pushes it via
// AUTOFILL_SET_INDEX or it is rebuilt from disk while the VEK is cached.
let autofillIndex: Map<string, IndexEntry> | null = null;
const knownHostnames = new Set<string>();

// Load the persisted hostname registry so the locked-state hint survives SW
// restarts. Awaited (with the session hydration) before any handler runs.
export const indexHydration = (async () => {
	try {
		const r = await api.storage.local.get([HOSTNAMES_KEY]);
		const hostnames = r[HOSTNAMES_KEY];
		if (Array.isArray(hostnames)) for (const h of hostnames) knownHostnames.add(h);
	} catch (e) {
		console.warn("[titanpass:bg] hostname hydration failed", e);
	}
})();

/** Persist the hostname registry so the locked-state hint survives SW restarts. */
async function persistKnownHostnames(): Promise<void> {
	try {
		await api.storage.local.set({ [HOSTNAMES_KEY]: Array.from(knownHostnames) });
	} catch (e) {
		console.warn("[titanpass:bg] persistKnownHostnames failed", e);
	}
}

/** Drop the in-memory index (called on lock). */
export function clearIndex(): void {
	autofillIndex = null;
}

/** The index entry for `id`, or undefined when the index is absent/missing it. */
export function getIndexEntry(id: string): IndexEntry | undefined {
	return autofillIndex?.get(id);
}

/** Insert a freshly-saved login into the live index and register its hostnames. */
export async function addLoginEntry(entry: LoginIndexEntry): Promise<void> {
	if (!autofillIndex) return;
	autofillIndex.set(entry.id, entry);
	for (const h of entry.hostnames) knownHostnames.add(h);
	await persistKnownHostnames();
}

/** Overwrite a login's cached username/password after a corner-prompt update. */
export function updateLoginCredentials(id: string, username: string, password: string): void {
	const entry = autofillIndex?.get(id);
	if (entry && entry.type === "login") {
		autofillIndex?.set(id, { ...entry, username, password });
	}
}

/** Classify a captured credential against the live index (null index degrades to save). */
export function dedupeCapture(hostname: string, username: string, password: string): DedupeOutcome {
	return dedupeCaptureFn(autofillIndex, hostname, username, password);
}

/** Masked card label for the dropdown, e.g. "Visa •••• 1234". */
function cardSecondary(entry: Extract<IndexEntry, { type: "card" }>): string {
	const last4 = entry.number.replace(/\D/g, "").slice(-4);
	const tail = last4 ? `•••• ${last4}` : "";
	return [entry.brand, tail].filter(Boolean).join(" ");
}

/** Build the autofill match list for a hostname, or a locked result if no VEK. */
function queryResult(
	hostname: string,
	hasLogin: boolean,
	hasCard: boolean,
	hasOtp: boolean,
): QueryResult {
	if (!autofillIndex || vaultLocked()) {
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
			// Cards are not hostname-scoped: offered on any payment form (see docs/autofill.md).
			cards.push({ id: entry.id, name: entry.name, secondary: cardSecondary(entry) });
		}
	}
	return { logins, cards, otps, locked: false, hasPotentialMatch: logins.length > 0 };
}

/** Resolve an entry to its fill payload. TOTP is computed live; the seed never ships. */
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

/** Verified page hostname for a content-script sender, or "" when none can be derived. */
function senderHostname(sender: chrome.runtime.MessageSender): string {
	try {
		const src = sender.origin ?? sender.url ?? sender.tab?.url ?? "";
		if (src) return new URL(src).hostname;
	} catch {}
	return "";
}

/** A login may be filled only on a page its hostname matches; cards are site-agnostic. See docs/autofill.md. */
function authorizeFill(entryId: string, pageHostname: string): void {
	const entry = autofillIndex?.get(entryId);
	if (entry?.type === "login" && !hostnameMatches(entry, pageHostname)) {
		throw new Error("entry is not offered on this origin");
	}
}

/** Rebuild autofillIndex from disk when the SW idle-killed it but the VEK is cached. Idempotent. */
export async function hydrateAutofillIndexFromDisk(): Promise<boolean> {
	if (autofillIndex !== null) return true;
	if (vaultLocked()) return false;
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
			// Notes / ssh-keys are not autofillable.
		}
		autofillIndex = newIndex;
		await persistKnownHostnames();
		return true;
	} catch (e) {
		console.warn("[titanpass:bg] hydrateAutofillIndexFromDisk failed", e);
		return false;
	}
}

// --- Handlers ---

async function autofillSetIndex(message: any): Promise<MessageEnvelope> {
	const entries = message.payload as IndexEntry[];
	autofillIndex = new Map();
	knownHostnames.clear();
	for (const entry of entries) {
		autofillIndex.set(entry.id, entry);
		// Register every hostname a login covers so the locked-state hint lights up on all of them.
		if (entry.type === "login") {
			for (const h of entry.hostnames) knownHostnames.add(h);
		}
	}
	await persistKnownHostnames();
	await scheduleAutoLock();
	return { ok: true, data: null };
}

async function autofillClearIndex(): Promise<MessageEnvelope> {
	autofillIndex = null;
	return { ok: true, data: null };
}

async function autofillFind(
	message: any,
	sender: chrome.runtime.MessageSender,
): Promise<MessageEnvelope> {
	// Adapter path trusts the body's hostname; restrict to extension pages.
	if (!isExtensionSender(sender)) return { ok: false, error: "forbidden" };
	await hydrateAutofillIndexFromDisk();
	const { hostname, hasLogin, hasCard, hasOtp } = message.payload as {
		hostname: string;
		hasLogin?: boolean;
		hasCard?: boolean;
		hasOtp?: boolean;
	};
	return {
		ok: true,
		data: queryResult(hostname, hasLogin !== false, hasCard === true, hasOtp === true),
	};
}

async function autofillFetch(
	message: any,
	sender: chrome.runtime.MessageSender,
): Promise<MessageEnvelope> {
	// Unscoped secret fetch by id: extension pages only (see autofillFind).
	if (!isExtensionSender(sender)) return { ok: false, error: "forbidden" };
	await hydrateAutofillIndexFromDisk();
	const { entryId } = message.payload as { entryId: string };
	const data = fetchFill(entryId);
	await scheduleAutoLock();
	return { ok: true, data };
}

async function autofillQuery(
	message: any,
	sender: chrome.runtime.MessageSender,
): Promise<MessageEnvelope> {
	const tabId = sender.tab?.id;
	// Hostname is derived from the verified sender, never the message body.
	const hostname = senderHostname(sender);
	if (!hostname) return { ok: false, error: "no verifiable origin on sender" };
	await hydrateAutofillIndexFromDisk();
	const hasLogin = message.hasLogin !== false;
	const hasCard = message.hasCard === true;
	const hasOtp = message.hasOtp === true;
	const result = queryResult(hostname, hasLogin, hasCard, hasOtp);
	// Sliding session: any autofill activity extends the timer.
	if (!result.locked) await scheduleAutoLock();
	// Reply only to the frame that queried; never broadcast the match list to sibling
	// frames (a page can host a co-resident cross-origin iframe running this same script).
	if (tabId !== undefined && sender.frameId !== undefined) {
		await api.tabs
			.sendMessage(
				tabId,
				{ type: "AUTOFILL_MATCHES", payload: result },
				{ frameId: sender.frameId },
			)
			.catch(() => {});
	}
	return { ok: true };
}

async function autofillSelect(
	message: any,
	sender: chrome.runtime.MessageSender,
): Promise<MessageEnvelope> {
	const { entryId, isAuto, otpOnly } = message.payload as {
		entryId: string;
		isAuto?: boolean;
		otpOnly?: boolean;
	};
	// Re-check the login against the verified page origin.
	authorizeFill(entryId, senderHostname(sender));
	const fill = fetchFill(entryId);
	await scheduleAutoLock();
	// Deliver the decrypted secret ONLY to the frame that requested (and was authorized
	// for) this pick. Broadcasting to the tab would hand the credential/card to every
	// frame, including a co-resident cross-origin iframe. Fail closed if no frame id.
	if (sender.tab?.id !== undefined && sender.frameId !== undefined) {
		// Echo isAuto (auto-retry vs explicit pick) and otpOnly (fill only the OTP field).
		await api.tabs.sendMessage(
			sender.tab.id,
			{ type: "AUTOFILL_FILL", payload: { ...fill, isAuto: !!isAuto, otpOnly: !!otpOnly } },
			{ frameId: sender.frameId },
		);
	}
	return { ok: true };
}

on("AUTOFILL_SET_INDEX", autofillSetIndex);
on("AUTOFILL_CLEAR_INDEX", autofillClearIndex);
on("AUTOFILL_FIND", autofillFind);
on("AUTOFILL_FETCH", autofillFetch);
on("AUTOFILL_QUERY", autofillQuery);
on("AUTOFILL_SELECT", autofillSelect);
