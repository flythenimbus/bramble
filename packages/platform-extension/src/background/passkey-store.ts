/// <reference types="chrome" />

// Vault IO for the passkey provider: read every decrypted entry (to find passkeys
// for a get), and persist a freshly minted passkey (placement decided by the core
// planPasskeyPlacement). Mirrors corner-prompt's commit path: per-entry encrypt, hlc
// stamp, re-encrypt the outer payload, write or queue. See docs/passkey-provider.md.

import type { PasskeyAssertion, PasskeyRegistration } from "@core/adapters/crypto";
import type { Entry, LoginEntryData } from "@core/hooks/useVault";
import { decodeEntriesPayload } from "@core/sync";
import { normalizeEntryData } from "@core/vault/entry-normalize";
import type { PasskeyPlacement } from "@core/vault/passkey";
import { type EncryptedEntry, encodeVaultBlob, type VaultBlob } from "@core/vault-format";
import { addLoginEntry } from "./autofill-index";
import { sendToOffscreen } from "./offscreen-client";
import { nextStamp } from "./sync-clock";
import {
	broadcastVaultChanged,
	bytesToBase64,
	readAndDecodeVault,
	reencryptOuterWithEntryChange,
	writeOrQueueVault,
} from "./vault-io";

// Passkey crypto runs in the offscreen (the WASM core). The background reaches it via
// sendToOffscreen, NOT the UI-side extensionCrypto adapter (whose chrome.runtime
// messages don't loop back to the background's own listener). Both ops are pure (no VEK).
export async function passkeyMakeCredential(
	rpId: string,
	userVerified: boolean,
): Promise<PasskeyRegistration> {
	const res = await sendToOffscreen({
		type: "CRYPTO_PASSKEY_MAKE",
		payload: { rpId, userVerified },
	});
	if (!res.ok || !res.data) throw new Error(res.error ?? "passkey mint failed");
	return res.data as PasskeyRegistration;
}

export async function passkeyGetAssertion(
	rpId: string,
	privateKeyB64: string,
	clientDataHashB64: string,
	userVerified: boolean,
): Promise<PasskeyAssertion> {
	const res = await sendToOffscreen({
		type: "CRYPTO_PASSKEY_GET",
		payload: { rpId, privateKeyB64, clientDataHashB64, userVerified },
	});
	if (!res.ok || !res.data) throw new Error(res.error ?? "passkey assertion failed");
	return res.data as PasskeyAssertion;
}

/** Decrypt every vault entry, including login `passkeys[]`. Requires the vault unlocked. */
export async function loadDecryptedEntries(): Promise<Entry[]> {
	const blob = await readAndDecodeVault();
	if (blob.entriesCiphertext.length === 0) return [];
	const outer = await sendToOffscreen({
		type: "CRYPTO_DECRYPT_OUTER",
		payload: {
			iv: bytesToBase64(blob.entriesIv),
			ciphertext: bytesToBase64(blob.entriesCiphertext),
		},
	});
	if (!outer.ok || typeof outer.data !== "string") {
		throw new Error(`outer decrypt failed: ${outer.error ?? "no data"}`);
	}
	const entries: Entry[] = [];
	for (const enc of decodeEntriesPayload(outer.data).entries) {
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
		entries.push({ ...normalizeEntryData(JSON.parse(dec.data)), id: enc.id });
	}
	return entries;
}

async function encryptEntry(plaintextJson: string): Promise<Omit<EncryptedEntry, "id" | "hlc">> {
	const resp = await sendToOffscreen({ type: "CRYPTO_ENCRYPT", payload: { plaintextJson } });
	if (!resp.ok || !resp.data) throw new Error(`encrypt entry failed: ${resp.error ?? "no data"}`);
	return resp.data as Omit<EncryptedEntry, "id" | "hlc">;
}

async function writeBlob(
	base: VaultBlob,
	outer: { entriesIv: Uint8Array; entriesCiphertext: Uint8Array; entryCount: number },
): Promise<void> {
	const blob: VaultBlob = {
		slots: base.slots,
		entriesIv: outer.entriesIv,
		entriesCiphertext: outer.entriesCiphertext,
	};
	await writeOrQueueVault(encodeVaultBlob(blob), outer.entryCount);
}

function hostname(u: string): string {
	try {
		return new URL(u).hostname;
	} catch {
		return u;
	}
}

/** Persist a passkey placement: append a new login, or rewrite an existing one's passkeys[]. */
export async function savePlacement(plan: PasskeyPlacement): Promise<void> {
	const base = await readAndDecodeVault();
	if (plan.kind === "create") {
		const enc = await encryptEntry(JSON.stringify(plan.data satisfies LoginEntryData));
		const id = globalThis.crypto.randomUUID();
		const newEnc: EncryptedEntry = { id, ...enc, hlc: await nextStamp() };
		const outer = await reencryptOuterWithEntryChange(base, async (entries) => [
			...entries,
			newEnc,
		]);
		await writeBlob(base, outer);
		// Best-effort: surface the new login for autofill before the next rehydrate.
		await addLoginEntry({
			type: "login",
			id,
			hostnames: plan.data.urls.map(hostname).filter(Boolean),
			name: plan.data.name,
			username: plan.data.username,
			password: plan.data.password,
		});
	} else {
		const outer = await reencryptOuterWithEntryChange(base, async (entries) => {
			const next: EncryptedEntry[] = [];
			for (const e of entries) {
				if (e.id !== plan.entryId) {
					next.push(e);
					continue;
				}
				const dec = await sendToOffscreen({
					type: "CRYPTO_DECRYPT",
					payload: { ciphertext: e.ciphertext, iv: e.iv, wrappedDek: e.wrappedDek, dekIv: e.dekIv },
				});
				if (!dec.ok || typeof dec.data !== "string") {
					throw new Error(`decrypt entry failed: ${dec.error ?? "no data"}`);
				}
				const data = JSON.parse(dec.data);
				data.passkeys = plan.passkeys;
				const reenc = await encryptEntry(JSON.stringify(data));
				next.push({ id: e.id, ...reenc, hlc: await nextStamp() });
			}
			return next;
		});
		await writeBlob(base, outer);
	}
	await broadcastVaultChanged();
}
