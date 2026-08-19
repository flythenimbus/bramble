/// <reference types="chrome" />

import type {
	FillPayload,
	IndexEntry,
	LoginIndexEntry,
	MatchSummary,
	QueryResult,
} from "@core/adapters/autofill";
import { decodeEntriesPayload } from "@core/sync";
import { parseTotp, totpAt } from "@core/util/totp";
import { extractHostname } from "@core/vault/autofill-index";
import { normalizeEntryData } from "@core/vault/entry-normalize";
import {
	type DedupeOutcome,
	dedupeCapture as dedupeCaptureFn,
	hostnameMatches,
	registrableDomain,
} from "../dedupe";
import { api } from "../platform-api";
import { isExtensionSender } from "../sender";
import {
	type DesktopFill,
	linkIsHeld,
	onDesktopFillRequest,
	reportActiveTab,
} from "./desktop-link";
import { sendToOffscreen } from "./offscreen-client";
import { type MessageEnvelope, on } from "./router";
import {
	type AutofillSessionCapability,
	type AutofillSessionOwner,
	autofillSessionCapabilityIsCurrent,
	autofillSessionIsCurrent,
	autofillSessionIsStable,
	autofillSessionOwner,
	autofillSessionOwnerIsCurrent,
	autofillSessionSnapshot,
	scheduleAutoLock,
	vaultLocked,
} from "./session";
import { bytesToBase64, readAndDecodeVault } from "./vault-io";

const HOSTNAMES_KEY = "autofill.knownHostnames";

// In-memory caches. The decrypted autofill index is never persisted (plaintext
// secrets); it stays null after a SW restart until the popup re-pushes it via
// AUTOFILL_SET_INDEX or it is rebuilt from disk while the VEK is cached. Its
// owner is as important as its contents: an older async rebuild must never be
// usable (or publishable) after a lock/unlock or active-vault replacement.
type AutofillIndexCache = Readonly<{
	owner: AutofillSessionOwner;
	entries: Map<string, IndexEntry>;
}>;

let autofillIndex: AutofillIndexCache | null = null;
let cacheRevision = 0;
let hydrationInFlight: Readonly<{
	owner: AutofillSessionOwner;
	revision: number;
	promise: Promise<boolean>;
}> | null = null;
const knownHostnames = new Set<string>();

function sameOwner(left: AutofillSessionOwner, right: AutofillSessionOwner): boolean {
	return (
		left.vaultId === right.vaultId &&
		left.generation === right.generation &&
		left.token === right.token
	);
}

/** The live index only if it belongs to the current unlocked vault/key session. */
function currentIndex(): Map<string, IndexEntry> | null {
	const owner = autofillSessionOwner();
	if (owner && autofillIndex && sameOwner(autofillIndex.owner, owner)) return autofillIndex.entries;
	// Drop stale plaintext as soon as it is observed. Incrementing revision also prevents an
	// older hydration from publishing after a clear or active-vault transition.
	if (autofillIndex) {
		autofillIndex = null;
		cacheRevision++;
	}
	return null;
}

function publishIndex(
	owner: AutofillSessionOwner,
	revision: number,
	entries: Map<string, IndexEntry>,
): boolean {
	if (cacheRevision !== revision || !autofillSessionOwnerIsCurrent(owner)) return false;
	autofillIndex = { owner, entries };
	return true;
}

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
	cacheRevision++;
}

/** The index entry for `id`, or undefined when the index is absent/missing it. */
export function getIndexEntry(id: string): IndexEntry | undefined {
	return currentIndex()?.get(id);
}

/** Insert a freshly-saved login into the live index and register its hostnames. */
export async function addLoginEntry(entry: LoginIndexEntry): Promise<void> {
	const index = currentIndex();
	if (!index) return;
	index.set(entry.id, entry);
	for (const h of entry.hostnames) knownHostnames.add(h);
	await persistKnownHostnames();
}

/** Overwrite a login's cached username/password after a corner-prompt update. */
export function updateLoginCredentials(id: string, username: string, password: string): void {
	const index = currentIndex();
	const entry = index?.get(id);
	if (entry && entry.type === "login") {
		index?.set(id, { ...entry, username, password });
	}
}

/** Classify a captured credential against the live index (null index degrades to save). */
export function dedupeCapture(hostname: string, username: string, password: string): DedupeOutcome {
	return dedupeCaptureFn(currentIndex(), hostname, username, password);
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
	const index = currentIndex();
	if (!index || vaultLocked()) {
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
	for (const entry of index.values()) {
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

/**
 * The live code for an authenticator key, or undefined when there is no key or it will not
 * parse. Every path that fills a one-time code goes through this: what an index holds is the
 * seed, and the only part of it a page may ever see is the digits it is standing in for.
 */
function liveTotpCode(key: string | null | undefined): string | undefined {
	const parsed = parseTotp(key);
	return parsed ? totpAt(parsed.totp).code : undefined;
}

/** Resolve an entry to its fill payload. TOTP is computed live; the seed never ships. */
function fetchFill(entryId: string): FillPayload {
	const entry = currentIndex()?.get(entryId);
	if (!entry) throw new Error(`entry not found: ${entryId}`);
	if (entry.type === "login") {
		return {
			kind: "login",
			username: entry.username,
			password: entry.password,
			totp: liveTotpCode(entry.totp),
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

/** Content-script-only requests must have a browser-verified page sender. */
function pageSenderHostname(sender: chrome.runtime.MessageSender): string | null {
	if (isExtensionSender(sender) || sender.tab?.id === undefined) return null;
	const hostname = senderHostname(sender);
	return hostname || null;
}

function validQueryFlags(message: any): boolean {
	return ["hasLogin", "hasCard", "hasOtp"].every(
		(key) => !(key in message) || typeof message[key] === "boolean",
	);
}

function validSelectPayload(payload: unknown): payload is {
	entryId: string;
	isAuto?: boolean;
	otpOnly?: boolean;
} {
	if (!payload || typeof payload !== "object") return false;
	const p = payload as Record<string, unknown>;
	return (
		typeof p.entryId === "string" &&
		p.entryId.length > 0 &&
		p.entryId.length <= 256 &&
		(p.isAuto === undefined || typeof p.isAuto === "boolean") &&
		(p.otpOnly === undefined || typeof p.otpOnly === "boolean")
	);
}

function validSessionCapability(value: unknown): value is AutofillSessionCapability {
	if (!value || typeof value !== "object") return false;
	const capability = value as Record<string, unknown>;
	return (
		typeof capability.vaultId === "string" &&
		capability.vaultId.length > 0 &&
		capability.vaultId.length <= 256 &&
		typeof capability.token === "string" &&
		capability.token.length > 0 &&
		capability.token.length <= 256
	);
}

function validSetIndexPayload(payload: unknown): payload is {
	entries: IndexEntry[];
	owner: AutofillSessionCapability;
} {
	if (!payload || typeof payload !== "object") return false;
	const value = payload as Record<string, unknown>;
	return Array.isArray(value.entries) && validSessionCapability(value.owner);
}

function validClearIndexPayload(payload: unknown): payload is { owner: AutofillSessionCapability } {
	if (!payload || typeof payload !== "object") return false;
	return validSessionCapability((payload as Record<string, unknown>).owner);
}

/** A login may be filled only on a page its hostname matches; cards are site-agnostic. See docs/autofill.md. */
function authorizeFill(entryId: string, pageHostname: string): void {
	const entry = currentIndex()?.get(entryId);
	if (entry?.type === "login" && !hostnameMatches(entry, pageHostname)) {
		throw new Error("entry is not offered on this origin");
	}
}

/** Build and publish one index only if its vault/key session still owns the cache. */
async function hydrateIndexForOwner(
	owner: AutofillSessionOwner,
	revision: number,
): Promise<boolean> {
	try {
		const blob = await readAndDecodeVault(owner.vaultId);
		const discoveredHostnames = new Set<string>();
		if (blob.entriesCiphertext.length === 0) {
			return publishIndex(owner, revision, new Map());
		}
		const outerResp = await sendToOffscreen({
			type: "CRYPTO_DECRYPT_OUTER",
			vaultId: owner.vaultId,
			payload: {
				iv: bytesToBase64(blob.entriesIv),
				ciphertext: bytesToBase64(blob.entriesCiphertext),
			},
		});
		if (!outerResp.ok || typeof outerResp.data !== "string") return false;
		// The outer payload is `{entries, tombstones}` (see core/sync/entries-payload); parsing it
		// as a bare array threw and left the index null, so every query answered "vault locked".
		const { entries: encryptedEntries } = decodeEntriesPayload(outerResp.data);
		const newIndex = new Map<string, IndexEntry>();
		for (const enc of encryptedEntries) {
			const dec = await sendToOffscreen({
				type: "CRYPTO_DECRYPT",
				vaultId: owner.vaultId,
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
				// Shares extractHostname with the popup's projection so the two can't
				// drift; in particular both must drop app URIs rather than index a
				// package name as a hostname.
				const hostnames = data.urls
					.filter((u): u is string => !!u)
					.map(extractHostname)
					.filter((h) => h.length > 0);
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
				for (const h of hostnames) discoveredHostnames.add(h);
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
		if (!publishIndex(owner, revision, newIndex)) return false;
		for (const hostname of discoveredHostnames) knownHostnames.add(hostname);
		await persistKnownHostnames();
		// A transition while persisting host hints makes this result unavailable to callers; the
		// next reader will discard the no-longer-owned plaintext index.
		return autofillSessionOwnerIsCurrent(owner);
	} catch (e) {
		console.warn("[titanpass:bg] hydrateAutofillIndexFromDisk failed", e);
		return false;
	}
}

/** Rebuild the current session's index after an SW restart. Concurrent readers share one build. */
export async function hydrateAutofillIndexFromDisk(): Promise<boolean> {
	const owner = autofillSessionOwner();
	if (!owner) return false;
	if (currentIndex() !== null) return true;
	const revision = cacheRevision;
	if (
		hydrationInFlight &&
		hydrationInFlight.revision === revision &&
		sameOwner(hydrationInFlight.owner, owner)
	) {
		return hydrationInFlight.promise;
	}
	const promise = hydrateIndexForOwner(owner, revision).finally(() => {
		if (hydrationInFlight?.promise === promise) hydrationInFlight = null;
	});
	hydrationInFlight = { owner, revision, promise };
	return promise;
}

// --- Handlers ---

async function autofillSetIndex(
	message: any,
	sender: chrome.runtime.MessageSender,
): Promise<MessageEnvelope> {
	if (!isExtensionSender(sender)) return { ok: false, error: "forbidden" };
	if (!validSetIndexPayload(message.payload)) return { ok: false, error: "invalid_request" };
	const { entries, owner: capability } = message.payload;
	if (!autofillSessionCapabilityIsCurrent(capability)) {
		return { ok: false, error: "unavailable" };
	}
	const owner = autofillSessionOwner();
	if (!owner || owner.vaultId !== capability.vaultId || owner.token !== capability.token) {
		return { ok: false, error: "unavailable" };
	}
	const index = new Map<string, IndexEntry>();
	knownHostnames.clear();
	for (const entry of entries) {
		index.set(entry.id, entry);
		// Register every hostname a login covers so the locked-state hint lights up on all of them.
		if (entry.type === "login") {
			for (const h of entry.hostnames) knownHostnames.add(h);
		}
	}
	cacheRevision++;
	autofillIndex = { owner, entries: index };
	await persistKnownHostnames();
	await scheduleAutoLock();
	return autofillSessionOwnerIsCurrent(owner) && autofillSessionCapabilityIsCurrent(capability)
		? { ok: true, data: null }
		: { ok: false, error: "unavailable" };
}

async function autofillClearIndex(
	message: any,
	sender: chrome.runtime.MessageSender,
): Promise<MessageEnvelope> {
	if (!isExtensionSender(sender)) return { ok: false, error: "forbidden" };
	// Lock is intentionally idempotent: crypto.lock zeroizes first, so the view can no longer
	// acquire a capability for its follow-up cache cleanup. An ownerless clear is safe only then;
	// while unlocked every clear remains capability-bound to reject stale ABA messages.
	if (message.payload === undefined && vaultLocked()) {
		clearIndex();
		return { ok: true, data: null };
	}
	if (!validClearIndexPayload(message.payload)) return { ok: false, error: "invalid_request" };
	if (!autofillSessionCapabilityIsCurrent(message.payload.owner)) {
		return { ok: false, error: "unavailable" };
	}
	clearIndex();
	return { ok: true, data: null };
}

async function autofillFind(
	message: any,
	sender: chrome.runtime.MessageSender,
): Promise<MessageEnvelope> {
	// Adapter path trusts the body's hostname; restrict to extension pages.
	if (!isExtensionSender(sender)) return { ok: false, error: "forbidden" };
	const owner = autofillSessionOwner();
	// A locked view may receive only the non-secret locked-state hint. It must not become an
	// unlocked summary request if an unlock races its hydration await.
	if (!owner) {
		return vaultLocked()
			? {
					ok: true,
					data: queryResult(
						(message.payload as { hostname: string }).hostname,
						(message.payload as { hasLogin?: boolean }).hasLogin !== false,
						(message.payload as { hasCard?: boolean }).hasCard === true,
						(message.payload as { hasOtp?: boolean }).hasOtp === true,
					),
				}
			: { ok: false, error: "unavailable" };
	}
	await hydrateAutofillIndexFromDisk();
	const { hostname, hasLogin, hasCard, hasOtp } = message.payload as {
		hostname: string;
		hasLogin?: boolean;
		hasCard?: boolean;
		hasOtp?: boolean;
	};
	if (!autofillSessionOwnerIsCurrent(owner)) return { ok: false, error: "unavailable" };
	const result = queryResult(hostname, hasLogin !== false, hasCard === true, hasOtp === true);
	if (result.locked) return { ok: true, data: result };
	await scheduleAutoLock();
	if (!autofillSessionOwnerIsCurrent(owner)) return { ok: false, error: "unavailable" };
	// Construct the summary after the final await/check, matching the secret-fetch ordering.
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
	const owner = autofillSessionOwner();
	if (!owner) return { ok: false, error: "unavailable" };
	await hydrateAutofillIndexFromDisk();
	await scheduleAutoLock();
	if (!autofillSessionOwnerIsCurrent(owner)) return { ok: false, error: "unavailable" };
	// Build plaintext only after every await and the final session-ownership check.
	const { entryId } = message.payload as { entryId: string };
	return { ok: true, data: fetchFill(entryId) };
}

async function autofillQuery(
	message: any,
	sender: chrome.runtime.MessageSender,
): Promise<MessageEnvelope> {
	const hostname = pageSenderHostname(sender);
	if (!validQueryFlags(message)) return { ok: false, error: "invalid_request" };
	// Hostname is derived from the verified sender, never the message body. The result
	// returns through this request's response channel; it is never tab/frame-addressed.
	if (!hostname) return { ok: false, error: "forbidden" };
	const generation = autofillSessionSnapshot();
	try {
		await hydrateAutofillIndexFromDisk();
		const hasLogin = message.hasLogin !== false;
		const hasCard = message.hasCard === true;
		const hasOtp = message.hasOtp === true;
		const result = queryResult(hostname, hasLogin, hasCard, hasOtp);
		// Sliding session: any autofill activity extends the timer.
		if (!result.locked) await scheduleAutoLock();
		if (!autofillSessionIsStable(generation)) return { ok: false, error: "unavailable" };
		return { ok: true, data: result };
	} catch {
		return { ok: false, error: "unavailable" };
	}
}

async function autofillSelect(
	message: any,
	sender: chrome.runtime.MessageSender,
): Promise<MessageEnvelope> {
	const hostname = pageSenderHostname(sender);
	if (!validSelectPayload(message.payload)) {
		return { ok: false, error: "invalid_request" };
	}
	if (!hostname) return { ok: false, error: "forbidden" };
	const generation = autofillSessionSnapshot();
	// A request that began while locked (or a transition was already underway) must
	// never become eligible merely because an unlock completes during its await.
	if (!autofillSessionIsCurrent(generation)) return { ok: false, error: "unavailable" };
	try {
		await hydrateAutofillIndexFromDisk();
		await scheduleAutoLock();
		// Do every authorization and plaintext operation synchronously after the last await.
		if (!autofillSessionIsCurrent(generation)) return { ok: false, error: "unavailable" };
		authorizeFill(message.payload.entryId, hostname);
		const payload = fetchFill(message.payload.entryId);
		return {
			ok: true,
			data: {
				payload,
				isAuto: !!message.payload.isAuto,
				otpOnly: !!message.payload.otpOnly,
				sessionGeneration: generation,
			},
		};
	} catch {
		// Do not expose entry ids, values, or implementation errors to a page sender.
		return { ok: false, error: "unavailable" };
	}
}

async function autofillRevalidateSubmit(
	message: any,
	sender: chrome.runtime.MessageSender,
): Promise<MessageEnvelope> {
	if (!pageSenderHostname(sender)) return { ok: false, error: "forbidden" };
	const generation = message.sessionGeneration;
	if (!Number.isSafeInteger(generation) || generation < 0) {
		return { ok: false, error: "invalid_request" };
	}
	return autofillSessionIsCurrent(generation)
		? { ok: true, data: { sessionGeneration: generation } }
		: { ok: false, error: "unavailable" };
}

on("AUTOFILL_SET_INDEX", autofillSetIndex);
/**
 * A fill the desktop app is doing on this browser's behalf: pass it to the page in front of the
 * user and keep no copy.
 *
 * The credential comes from the app, not from this browser's index, which is the point: a locked
 * browser cannot read its own vault, and the whole reason the link exists is that the user should
 * not have to unlock twice. The app authorized it — the user chose the entry there, and the app
 * checked it against the page this browser reported.
 *
 * Sent to the top frame only. A form inside an iframe will not be filled this way, which is the
 * conservative direction: better a fill that does not happen than one aimed at a frame nobody
 * asked about.
 */
async function fillFromDesktop(fill: DesktopFill): Promise<void> {
	const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
	if (tab?.id === undefined) {
		console.warn("[bramble:link] fill: no active tab to fill");
		return;
	}
	// The app sends the authenticator KEY, the same seed its own index holds, and the code is
	// computed here rather than there: this is where the one TOTP implementation lives. Passing
	// the key through would type the seed itself into the page's one-time-code field.
	const totp = liveTotpCode(fill.totpKey);
	if (fill.totpKey && !totp) console.warn("[bramble:link] fill: unusable authenticator key");
	const reply = await api.tabs
		.sendMessage(
			tab.id,
			{
				type: "DESKTOP_FILL",
				payload: { username: fill.username, password: fill.password, totp },
			},
			{ frameId: 0 },
		)
		.catch((e) => {
			// No content script on this page (a settings tab, the store, a PDF), or one orphaned by
			// an extension reload, which keeps running but can no longer answer.
			console.warn("[bramble:link] fill: the page did not answer:", e);
			return undefined;
		});
	if (reply && reply.ok !== true) console.warn("[bramble:link] fill declined:", reply);
}

onDesktopFillRequest((fill) => {
	// Caught rather than left to become an unhandled rejection, which is how the first version of
	// this could fail with nothing in the console at all.
	void fillFromDesktop(fill).catch((e) => console.warn("[bramble:link] fill failed:", e));
});

/** Keep the desktop app told which page this browser is on, so its panel can name the target. */
function watchActiveTab(): void {
	const report = async () => {
		// Checked first so a browser with no desktop app does not query tabs on every switch just to
		// find there is nowhere to send the answer.
		if (!linkIsHeld()) return;
		const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
		let hostname = "";
		try {
			hostname = tab?.url ? new URL(tab.url).hostname : "";
		} catch {
			// A tab URL we cannot parse (about:, chrome://) is not a fill target.
		}
		await reportActiveTab(hostname);
	};
	// Optional, not assumed. Naming the fill target is a convenience, so a host that does not
	// expose tab events should lose the label rather than fail to load the background at all.
	api.tabs.onActivated?.addListener(() => void report());
	api.tabs.onUpdated?.addListener((_id, change) => {
		if (change.url) void report();
	});
	void report();
}

watchActiveTab();

on("AUTOFILL_CLEAR_INDEX", autofillClearIndex);
on("AUTOFILL_FIND", autofillFind);
on("AUTOFILL_FETCH", autofillFetch);
on("AUTOFILL_QUERY", autofillQuery);
on("AUTOFILL_SELECT", autofillSelect);
on("AUTOFILL_REVALIDATE_SUBMIT", autofillRevalidateSubmit);
