/// <reference types="chrome" />

import type {
	CornerPromptPayload,
	CornerPromptResponse,
	LoginIndexEntry,
	SaveLoginPrompt,
	UpdateLoginPrompt,
} from "@core/adapters/autofill";
import { type EncryptedEntry, encodeVaultBlob, type VaultBlob } from "@core/vault-format";
import { type DedupeOutcome, hostnameMatches, registrableDomain } from "../dedupe";
import { api } from "../platform-api";
import {
	addLoginEntry,
	dedupeCapture,
	getIndexEntry,
	hydrateAutofillIndexFromDisk,
	updateLoginCredentials,
} from "./autofill-index";
import { sendToOffscreen } from "./offscreen-client";
import { appendNeverSaveSite, getNeverSaveSites, getOfferToSavePref } from "./prefs";
import { type MessageEnvelope, on } from "./router";
import { vaultLocked } from "./session";
import { nextStamp } from "./sync-clock";
import {
	broadcastVaultChanged,
	readAndDecodeVault,
	reencryptOuterWithEntryChange,
	writeVault,
} from "./vault-io";

// Session stash for an in-flight capture, keyed one per eTLD+1.
export const CAPTURE_KEY_PREFIX = "capture.pending.";
// Plaintext captured credentials: wiped on lock alongside the capture stash.
export const CORNER_HANDOFF_KEY = "cornerPrompt.handoff";

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

function captureStashKey(etld1: string): string {
	return CAPTURE_KEY_PREFIX + etld1;
}

async function readPendingCapture(etld1: string): Promise<PendingCapture | null> {
	try {
		const key = captureStashKey(etld1);
		const r = await api.storage.session.get(key);
		const v = r[key] as PendingCapture | undefined;
		return v ?? null;
	} catch {
		return null;
	}
}

async function writePendingCapture(capture: PendingCapture): Promise<void> {
	await api.storage.session.set({ [captureStashKey(capture.etld1)]: capture });
}

async function clearPendingCapture(etld1: string): Promise<void> {
	await api.storage.session.remove(captureStashKey(etld1));
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

/** Encrypt and append a new login from a corner-prompt capture, updating index and disk. */
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
	const encEntry = encryptedEntryResp.data as Omit<EncryptedEntry, "id" | "hlc">;
	const id = globalThis.crypto.randomUUID();
	const newEnc: EncryptedEntry = { id, ...encEntry, hlc: await nextStamp() };
	const outer = await reencryptOuterWithEntryChange(blob, async (entries) => [...entries, newEnc]);
	const newBlob: VaultBlob = {
		slots: blob.slots,
		entriesIv: outer.entriesIv,
		entriesCiphertext: outer.entriesCiphertext,
	};
	await writeVault(encodeVaultBlob(newBlob));

	const username = editedUsername ?? capture.username;
	await addLoginEntry({
		type: "login",
		id,
		hostnames: [capture.hostname],
		name: capture.hostname,
		username,
		password: capture.password,
	} satisfies LoginIndexEntry);
	await broadcastVaultChanged();
}

/** Overwrite an existing login's username and password with a captured credential. */
async function commitCornerUpdate(capture: PendingCapture, chosenEntryId: string): Promise<void> {
	const indexEntry = getIndexEntry(chosenEntryId);
	if (indexEntry?.type !== "login") {
		throw new Error(`update target not in index: ${chosenEntryId}`);
	}
	// Parity with authorizeFill: only overwrite a login the captured hostname matches, so a
	// capture on site A can never be written into site B's entry. See docs/sec-audit-7726.md (A4).
	if (!hostnameMatches(indexEntry, capture.hostname)) {
		throw new Error("update target is not offered on this origin");
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
			const fresh = reenc.data as Omit<EncryptedEntry, "id" | "hlc">;
			next.push({ id: enc.id, ...fresh, hlc: await nextStamp() });
		}
		return next;
	});
	const newBlob: VaultBlob = {
		slots: blob.slots,
		entriesIv: outer.entriesIv,
		entriesCiphertext: outer.entriesCiphertext,
	};
	await writeVault(encodeVaultBlob(newBlob));
	updateLoginCredentials(chosenEntryId, capture.username, capture.password);
	await broadcastVaultChanged();
}

/** Dedupe a capture and, if it warrants a prompt, stash it and show the corner card. */
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
		// SPA path: if the page navigated away, the next load's CORNER_PROMPT_QUERY picks up the stash.
		// Target the top frame (where the corner card renders) so the captured password never
		// reaches a sub-frame's content script.
		await api.tabs
			.sendMessage(tabId, { type: "CORNER_PROMPT_SHOW", payload }, { frameId: 0 })
			.catch(() => {});
	}
	return payload;
}

// --- Handlers ---

async function cornerPromptCapture(
	message: any,
	sender: chrome.runtime.MessageSender,
): Promise<MessageEnvelope> {
	// Hostname is derived from the verified sender, never the message body.
	let hostname = "";
	try {
		const src = sender.origin ?? sender.url ?? sender.tab?.url ?? "";
		if (src) hostname = new URL(src).hostname;
	} catch {}
	if (!hostname) return { ok: false, error: "no verifiable origin on sender" };
	const { username, password } = message.payload as {
		username: string;
		password: string;
	};
	if (!password) return { ok: true, data: null };
	const etld1 = registrableDomain(hostname);
	const capture: PendingCapture = {
		promptId: globalThis.crypto.randomUUID(),
		etld1,
		hostname,
		username,
		password,
		capturedAt: Date.now(),
	};
	const dispatched = await dispatchCornerPromptForCapture(capture, sender.tab?.id);
	return { ok: true, data: dispatched };
}

async function cornerPromptQuery(
	_message: any,
	sender: chrome.runtime.MessageSender,
): Promise<MessageEnvelope> {
	// Page-load poll: surface a capture stashed by a previous page that navigated away.
	let hostname = "";
	try {
		const src = sender.origin ?? sender.url ?? sender.tab?.url ?? "";
		if (src) hostname = new URL(src).hostname;
	} catch {}
	if (!hostname) return { ok: true, data: null };
	const offerToSave = await getOfferToSavePref();
	if (!offerToSave) return { ok: true, data: null };
	const etld1 = registrableDomain(hostname);
	const capture = await readPendingCapture(etld1);
	if (!capture) return { ok: true, data: null };
	// Re-run dedupe against the current index (hydrate first, else every
	// recurring entry would mis-label as a fresh save).
	await hydrateAutofillIndexFromDisk();
	const locked = vaultLocked();
	const outcome = dedupeCapture(capture.hostname, capture.username, capture.password);
	const payload = buildCornerPayload(capture, outcome, locked);
	if (!payload) {
		await clearPendingCapture(etld1);
		return { ok: true, data: null };
	}
	return { ok: true, data: payload };
}

async function cornerPromptResponse(
	message: any,
	sender: chrome.runtime.MessageSender,
): Promise<MessageEnvelope> {
	try {
		const response = message.payload as CornerPromptResponse;
		// Hostname (and stash key) from the verified sender; promptId guards
		// against a stale prompt committing across an unlock cycle.
		let hostname = "";
		try {
			const src = sender.origin ?? sender.url ?? sender.tab?.url ?? "";
			if (src) hostname = new URL(src).hostname;
		} catch {}
		const etld1 = hostname ? registrableDomain(hostname) : "";
		const capture = etld1 ? await readPendingCapture(etld1) : null;
		if (!capture || capture.promptId !== response.promptId) {
			// Stale or missing prompt: honor dismiss/never but commit nothing.
			if (response.action === "never" && etld1) await appendNeverSaveSite(etld1);
			if (etld1) await clearPendingCapture(etld1);
			return { ok: true, data: null };
		}

		if (response.action === "dismiss") {
			await clearPendingCapture(etld1);
			return { ok: true, data: null };
		}
		if (response.action === "never") {
			await appendNeverSaveSite(etld1);
			await clearPendingCapture(etld1);
			return { ok: true, data: null };
		}
		if (response.action === "save-unlock-first") {
			// Fast path: if already unlocked, commit directly instead of routing through the popup.
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
				return { ok: true, data: null };
			}
			const handoff: CornerHandoff = {
				intent: response.chosenEntryId ? "update" : "save",
				capture,
				chosenEntryId: response.chosenEntryId,
			};
			await api.storage.session.set({ [CORNER_HANDOFF_KEY]: handoff });
			try {
				// chrome.action.openPopup is Chrome 127+; fall back to a detached window.
				const openPopupFn = (api.action as { openPopup?: () => Promise<void> }).openPopup;
				if (typeof openPopupFn === "function") {
					await openPopupFn.call(api.action);
				} else {
					throw new Error("openPopup unavailable");
				}
			} catch {
				try {
					await api.windows.create({
						url: api.runtime.getURL("popup.html?detached=1"),
						type: "popup",
						focused: true,
						width: 500,
						height: 600,
					});
				} catch {}
			}
			return { ok: true, data: null };
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
					// Unambiguous match upgrades to update; multiple candidates means user chose Save.
					await commitCornerUpdate(editedCapture, outcome.candidates[0]!.id);
				} else {
					await commitCornerSave(editedCapture, undefined);
				}
			} finally {
				// Always clear, else a lingering stash re-surfaces the card on every reload.
				await clearPendingCapture(etld1);
			}
			return { ok: true, data: null };
		}
		if (response.action === "update") {
			if (!response.chosenEntryId) {
				return { ok: false, error: "update missing chosenEntryId" };
			}
			await hydrateAutofillIndexFromDisk();
			try {
				await commitCornerUpdate(capture, response.chosenEntryId);
			} finally {
				await clearPendingCapture(etld1);
			}
			return { ok: true, data: null };
		}
		return { ok: false, error: `unknown action: ${response.action}` };
	} catch (err) {
		console.error("[titanpass:bg] CORNER_PROMPT_RESPONSE failed", err);
		return { ok: false, error: String(err) };
	}
}

async function cornerFlushHandoff(): Promise<MessageEnvelope> {
	// Popup signals a post-unlock flush of a parked corner-prompt handoff;
	// commit here so unlocked and unlock-first flows share one encrypt path.
	try {
		const r = await api.storage.session.get(CORNER_HANDOFF_KEY);
		const handoff = r[CORNER_HANDOFF_KEY] as CornerHandoff | undefined;
		if (!handoff) {
			return { ok: true, data: false };
		}
		// Clear first so a racing duplicate flush cannot double-write.
		await api.storage.session.remove(CORNER_HANDOFF_KEY);
		await hydrateAutofillIndexFromDisk();
		if (vaultLocked()) {
			return { ok: false, error: "vault still locked" };
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
		return { ok: true, data: true };
	} catch (err) {
		console.error("[titanpass:bg] CORNER_FLUSH_HANDOFF failed", err);
		return { ok: false, error: String(err) };
	}
}

on("CORNER_PROMPT_CAPTURE", cornerPromptCapture);
on("CORNER_PROMPT_QUERY", cornerPromptQuery);
on("CORNER_PROMPT_RESPONSE", cornerPromptResponse);
on("CORNER_FLUSH_HANDOFF", cornerFlushHandoff);
