import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import type { IndexEntry, SubdomainMatchMode } from "../adapters/autofill";
import { usePlatform } from "../context/PlatformContext";
import {
	decodeVaultBlob,
	type EncryptedEntry,
	encodeVaultBlob,
	findPasswordSlot,
	findRecoverySlots,
	findWebauthnSlots,
	LEN_HMAC_SECRET_SALT,
	LEN_SLOT_ID,
	type PasswordSlot,
	type RecoverySlot,
	SLOT_KIND_PASSWORD,
	SLOT_KIND_RECOVERY,
	SLOT_KIND_WEBAUTHN,
	type VaultBlob,
	verifierPrefix,
	type WebauthnSlot,
} from "../vault-format";

export interface BreachStatus {
	leaked: boolean;
	checkedAt: number;
}

export type EntryType = "login" | "card" | "note" | "ssh-key";

/** A user-defined extra field, available on every entry type. */
export interface CustomField {
	key: string;
	value: string;
	hidden?: boolean;
}

interface BaseEntryData {
	name: string;
	notes?: string;
	customFields?: CustomField[];
}

/**
 * A website credential: the only entry kind that feeds the autofill index and
 * breach checks. `urls` covers every site the same credentials work on (legacy
 * single-`url` vaults are migrated by `normalizeEntryData` on first read).
 */
export interface LoginEntryData extends BaseEntryData {
	type: "login";
	urls: string[];
	username: string;
	password: string;
	totp?: string;
	breach?: BreachStatus;
	autofillEnabled?: boolean;
	autoSubmit?: boolean;
	subdomainMatch?: SubdomainMatchMode;
}

export interface CardEntryData extends BaseEntryData {
	type: "card";
	cardholderName: string;
	number: string;
	brand?: string;
	expMonth: string;
	expYear: string;
	cvv: string;
}

export interface NoteEntryData extends BaseEntryData {
	type: "note";
}

/** An SSH key pair. Stored and copied only, never autofilled. */
export interface SshKeyEntryData extends BaseEntryData {
	type: "ssh-key";
	publicKey: string;
	privateKey: string;
	passphrase?: string;
	keyType?: string;
}

export type EntryData = LoginEntryData | CardEntryData | NoteEntryData | SshKeyEntryData;

export type Entry = EntryData & { id: string };
export type LoginEntry = LoginEntryData & { id: string };
export type CardEntry = CardEntryData & { id: string };
export type SshKeyEntry = SshKeyEntryData & { id: string };

/** Narrows `EntryData`/`Entry` to logins (autofill, breach are login-only). */
export function isLogin<T extends EntryData>(entry: T): entry is Extract<T, LoginEntryData> {
	return entry.type === "login";
}

import { entryDataSchema, normalizeEntryData } from "../vault/entry-normalize";
import {
	generateRecoveryCode as makeRecoveryCode,
	normalizeRecoveryCode,
} from "../vault/recovery-code";
import {
	addWebauthnSlot,
	matchSlotByCredentialId,
	needsSaltMismatchRetry,
	removePasswordSlot,
	removeWebauthnSlot,
	upsertPasswordSlot,
	upsertRecoverySlot,
} from "../vault/slot-policy";

export { entryDataSchema };

export interface SecurityKeyMeta {
	slotIdB64: string;
	label: string;
	addedAt: number;
}

const SECURITY_KEY_LABELS_PREF = "pref.securityKeyLabels";

export interface UseVault {
	hasVault: boolean;
	isLocked: boolean;
	/** Vault has at least one webauthn slot (gates the "Use security key" button). */
	hasWebauthnSlot: boolean;
	/** Vault has a master-password slot. False for a security-key-only vault. */
	hasPasswordSlot: boolean;
	/** Vault has a recovery code on file. False for pre-recovery-code vaults. */
	hasRecoveryCode: boolean;
	/** Webauthn slots joined with their stored labels, for Settings. */
	securityKeys: SecurityKeyMeta[];
	/** False until mount-time hydration resolves; route guards gate on this. */
	ready: boolean;
	entries: Entry[];
	error: string | null;
	/** Vault changes queued to disk but not yet flushed. 0 for the chrome.storage backend. */
	pendingSyncCount: number;
	unlock(password: string): Promise<void>;
	lock(): Promise<void>;
	pickVaultFile(mode: "create" | "open"): Promise<void>;
	/** Creates the vault and returns its initial plaintext recovery code (shown once). */
	createVault(password: string): Promise<string>;
	addEntry(data: EntryData): Promise<void>;
	importEntries(items: EntryData[]): Promise<void>;
	updateEntry(id: string, data: EntryData): Promise<void>;
	deleteEntry(id: string): Promise<void>;
	verifyMasterPassword(password: string): Promise<boolean>;
	/** Prove possession of a registered key (a tap) without changing lock state. */
	verifyWithSecurityKey(): Promise<boolean>;
	changeMasterPassword(newPassword: string): Promise<void>;
	/** Set (or re-enable) the master password by re-wrapping the in-memory VEK. */
	setMasterPassword(password: string): Promise<void>;
	/** Remove the master-password slot. Requires a security key (invariant B). */
	disableMasterPassword(): Promise<void>;
	unlockWithSecurityKey(): Promise<void>;
	registerSecurityKey(label: string): Promise<void>;
	revokeSecurityKey(slotIdB64: string): Promise<void>;
	/** Generate (or reset) the recovery code; returns the plaintext to show once. */
	generateRecoveryCode(): Promise<string>;
	unlockWithRecoveryCode(code: string): Promise<void>;
}

const VaultContext = createContext<UseVault | null>(null);

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

function extractHostname(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

function autofillCustomFields(fields: CustomField[] | undefined) {
	if (!fields) return undefined;
	const out = fields.filter((f) => f.value).map((f) => ({ key: f.key, value: f.value }));
	return out.length > 0 ? out : undefined;
}

function loginIndexEntry(entry: LoginEntry): IndexEntry {
	const hostnames = entry.urls.map(extractHostname).filter((h): h is string => h.length > 0);
	return {
		type: "login",
		id: entry.id,
		hostnames,
		name: entry.name,
		username: entry.username,
		password: entry.password,
		totp: entry.totp,
		customFields: autofillCustomFields(entry.customFields),
		autofillEnabled: entry.autofillEnabled,
		autoSubmit: entry.autoSubmit,
		subdomainMatch: entry.subdomainMatch,
	};
}

function cardIndexEntry(entry: CardEntry): IndexEntry {
	return {
		type: "card",
		id: entry.id,
		name: entry.name,
		brand: entry.brand,
		cardholderName: entry.cardholderName,
		number: entry.number,
		expMonth: entry.expMonth,
		expYear: entry.expYear,
		cvv: entry.cvv,
		customFields: autofillCustomFields(entry.customFields),
	};
}

/** Project logins and cards into the autofill index (notes/ssh keys excluded). */
function toAutofillIndex(entries: Entry[]): IndexEntry[] {
	const out: IndexEntry[] = [];
	for (const entry of entries) {
		if (entry.type === "login") out.push(loginIndexEntry(entry));
		else if (entry.type === "card") out.push(cardIndexEntry(entry));
	}
	return out;
}

export function VaultProvider({ children }: { children: ReactNode }) {
	const { storage, crypto, autofill, shell } = usePlatform();
	const [hasVault, setHasVault] = useState(false);
	const [isLocked, setIsLocked] = useState(true);
	const [ready, setReady] = useState(false);
	const [entries, setEntries] = useState<Entry[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [pendingSyncCount, setPendingSyncCount] = useState(0);
	const [webauthnSlots, setWebauthnSlots] = useState<WebauthnSlot[]>([]);
	const [hasPasswordSlot, setHasPasswordSlot] = useState(false);
	const [hasRecoveryCode, setHasRecoveryCode] = useState(false);
	const [securityKeyLabels, setSecurityKeyLabels] = useState<
		Record<string, { label: string; addedAt: number }>
	>({});

	const refreshPendingSyncCount = useCallback(async () => {
		try {
			setPendingSyncCount(await storage.getPendingFlushCount());
		} catch {
			setPendingSyncCount(0);
		}
	}, [storage]);

	/** Read+decode the vault, falling back to the backup snapshot on decode failure. */
	const readDecodedBlob = useCallback(async () => {
		const tryDecode = async () => {
			const bytes = await storage.readVaultBlob();
			return { bytes, blob: decodeVaultBlob(bytes) };
		};
		try {
			return await tryDecode();
		} catch (firstError) {
			const restored = await storage.restoreVaultFromBackup().catch(() => false);
			if (!restored) throw firstError;
			console.warn("[vault] live vault file failed to decode; restored from backup snapshot");
			return tryDecode();
		}
	}, [storage]);

	const refreshSlotMetadata = useCallback(async () => {
		try {
			const [{ blob }, stored] = await Promise.all([
				readDecodedBlob(),
				storage.getMeta<Record<string, { label: string; addedAt: number }>>(
					SECURITY_KEY_LABELS_PREF,
				),
			]);
			setWebauthnSlots(findWebauthnSlots(blob));
			setHasPasswordSlot(findPasswordSlot(blob) !== null);
			setHasRecoveryCode(findRecoverySlots(blob).length > 0);
			setSecurityKeyLabels(stored ?? {});
		} catch {
			setWebauthnSlots([]);
			setHasPasswordSlot(false);
			setHasRecoveryCode(false);
			setSecurityKeyLabels({});
		}
	}, [readDecodedBlob, storage]);

	/** Decrypt all entries and push the autofill index. */
	const loadEntries = useCallback(async () => {
		// Flush before the read so the decoded blob reflects any background-queued
		// corner-prompt write (FSA backend only).
		await storage.flushPendingVaultBlob().catch(() => {});
		await refreshPendingSyncCount();
		const { blob } = await readDecodedBlob();
		if (blob.entriesCiphertext.length === 0) {
			setEntries([]);
			await autofill.setIndex([]);
			return;
		}
		const outerJson = await crypto.decryptWithVek(
			bytesToBase64(blob.entriesIv),
			bytesToBase64(blob.entriesCiphertext),
		);
		const encryptedEntries: EncryptedEntry[] = JSON.parse(outerJson);
		const decrypted: Entry[] = await Promise.all(
			encryptedEntries.map(async (enc) => {
				const plaintext = await crypto.decryptEntry({
					ciphertext: enc.ciphertext,
					iv: enc.iv,
					wrappedDek: enc.wrappedDek,
					dekIv: enc.dekIv,
				});
				const data = normalizeEntryData(JSON.parse(plaintext));
				return { id: enc.id, ...data };
			}),
		);
		setEntries(decrypted);
		await autofill.setIndex(toAutofillIndex(decrypted));
	}, [readDecodedBlob, crypto, autofill, storage, refreshPendingSyncCount]);

	// On mount: detect an existing vault handle and whether crypto is already
	// unlocked (popup reopened mid-session).
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const has = await storage.hasVaultHandle();
				if (cancelled) return;
				setHasVault(has);
				if (!has) return;

				await refreshSlotMetadata();

				const locked = await crypto.isLocked();
				if (cancelled) return;
				setIsLocked(locked);
				if (locked) return;

				await loadEntries();
				// Session-resume: unlock() won't fire, so commit any parked handoff here.
				void shell.flushPendingCornerCapture().catch(() => {});
			} catch (e) {
				if (!cancelled) setError(String(e));
			} finally {
				if (!cancelled) setReady(true);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [storage, crypto, loadEntries, shell, refreshSlotMetadata]);

	// Reflect a background-initiated lock (auto-lock alarm): drop decrypted state
	// so the guard redirects to the unlock screen.
	useEffect(() => {
		return crypto.onExternalLock(() => {
			setEntries([]);
			setIsLocked(true);
		});
	}, [crypto]);

	// Re-decrypt when the background commits a vault write (corner-prompt path)
	// outside this context, keeping in-memory entries in sync with disk.
	useEffect(() => {
		return crypto.onExternalChange(() => {
			void loadEntries().catch(() => {});
		});
	}, [crypto, loadEntries]);

	/** Unlock with the master password, decrypt entries, and clear lock state. */
	const unlock = useCallback(
		async (password: string) => {
			setError(null);
			// Read failures collapse to one generic message; raw decoder errors leak
			// format internals and aren't actionable for end users.
			let slot: PasswordSlot | null;
			try {
				const { blob } = await readDecodedBlob();
				slot = findPasswordSlot(blob);
			} catch (e) {
				console.error("[vault] failed to read vault blob:", e);
				throw new Error("Couldn't open this vault. The file may be missing or unreadable.");
			}
			if (!slot) throw new Error("This vault has no password set.");
			const ok = await crypto.unwrapVekPassword({
				password,
				saltB64: bytesToBase64(slot.salt),
				slotIdB64: bytesToBase64(slot.slotId),
				verifierB64: bytesToBase64(slot.verifier),
				wrapIvB64: bytesToBase64(slot.wrapIv),
				wrappedVekB64: bytesToBase64(slot.wrappedVek),
				magicVersion: verifierPrefix(),
			});
			if (!ok) throw new Error("Incorrect master password");
			await loadEntries();
			setIsLocked(false);
			// Commit any corner-prompt capture parked while locked, now that the VEK is live.
			void shell.flushPendingCornerCapture().catch(() => {});
		},
		[readDecodedBlob, crypto, loadEntries, shell],
	);

	/** Lock the vault: clear the VEK, autofill index, and decrypted state. */
	const lock = useCallback(async () => {
		await crypto.lock();
		await autofill.clearIndex();
		setEntries([]);
		setIsLocked(true);
	}, [crypto, autofill]);

	/** Run a get() assertion over the given slots, returning the PRF secret. */
	const callGetWithSalt = useCallback(
		async (
			allowCredentials: WebauthnSlot[],
			salt: Uint8Array,
		): Promise<{ rawId: Uint8Array; hmacSecret: Uint8Array }> => {
			const challenge = new Uint8Array(32);
			globalThis.crypto.getRandomValues(challenge);
			// Chromium drops raw hmacGetSecret on get() and only honors prf, which
			// isn't in lib.dom.d.ts, so the options object is cast.
			const publicKey = {
				challenge: challenge as BufferSource,
				allowCredentials: allowCredentials.map((s) => ({
					type: "public-key",
					id: s.credentialId as BufferSource,
				})),
				userVerification: "preferred",
				extensions: { prf: { eval: { first: salt as BufferSource } } },
			} as unknown as PublicKeyCredentialRequestOptions;
			const credential = (await navigator.credentials.get({
				publicKey,
			})) as PublicKeyCredential | null;
			if (!credential) throw new Error("Authenticator returned no credential.");
			const ext = credential.getClientExtensionResults() as {
				prf?: { results?: { first?: ArrayBuffer } };
			};
			const first = ext.prf?.results?.first;
			if (!first) {
				throw new Error(
					"This authenticator didn't return a PRF secret. Try a YubiKey 5+ or Windows Hello.",
				);
			}
			return {
				rawId: new Uint8Array(credential.rawId),
				hmacSecret: new Uint8Array(first),
			};
		},
		[],
	);

	/** Wrap the in-memory VEK under a freshly-salted password KEK. */
	const wrapPasswordSlot = useCallback(
		async (password: string): Promise<PasswordSlot> => {
			const saltB64 = await crypto.generateSalt();
			const slotIdB64 = await crypto.generateSlotId();
			const wrapped = await crypto.wrapVekPassword({
				password,
				saltB64,
				slotIdB64,
				magicVersion: verifierPrefix(),
			});
			return {
				kind: SLOT_KIND_PASSWORD,
				slotId: base64ToBytes(slotIdB64),
				salt: base64ToBytes(saltB64),
				verifier: base64ToBytes(wrapped.verifier),
				wrapIv: base64ToBytes(wrapped.wrapIv),
				wrappedVek: base64ToBytes(wrapped.wrappedVek),
			};
		},
		[crypto],
	);

	/** Wrap the in-memory VEK under a recovery code (reuses the password KDF). */
	const wrapRecoverySlot = useCallback(
		async (code: string): Promise<RecoverySlot> => {
			const saltB64 = await crypto.generateSalt();
			const slotIdB64 = await crypto.generateSlotId();
			const wrapped = await crypto.wrapVekPassword({
				password: normalizeRecoveryCode(code),
				saltB64,
				slotIdB64,
				magicVersion: verifierPrefix(),
			});
			return {
				kind: SLOT_KIND_RECOVERY,
				slotId: base64ToBytes(slotIdB64),
				salt: base64ToBytes(saltB64),
				verifier: base64ToBytes(wrapped.verifier),
				wrapIv: base64ToBytes(wrapped.wrapIv),
				wrappedVek: base64ToBytes(wrapped.wrappedVek),
			};
		},
		[crypto],
	);

	/** Unlock via a registered security key (one tap, two if the salt mismatches). */
	const unlockWithSecurityKey = useCallback(async () => {
		setError(null);
		let slots: WebauthnSlot[];
		try {
			const { blob } = await readDecodedBlob();
			slots = findWebauthnSlots(blob);
		} catch (e) {
			console.error("[vault] failed to read vault blob:", e);
			throw new Error("Couldn't open this vault. The file may be missing or unreadable.");
		}
		if (slots.length === 0) {
			throw new Error("No security key registered on this vault.");
		}

		// First tap uses slot[0]'s salt; if a different credential with a
		// different salt is tapped, re-ask narrowed to it with its own salt.
		const firstSalt = slots[0]!.salt;
		const firstAttempt = await callGetWithSalt(slots, firstSalt);
		let used = matchSlotByCredentialId(slots, firstAttempt.rawId);
		if (!used) {
			throw new Error("Authenticator returned an unknown credential.");
		}
		let hmacSecret = firstAttempt.hmacSecret;
		if (needsSaltMismatchRetry(used, firstSalt)) {
			const second = await callGetWithSalt([used], used.salt);
			used = matchSlotByCredentialId([used], second.rawId);
			if (!used) throw new Error("Authenticator returned an unknown credential.");
			hmacSecret = second.hmacSecret;
		}

		const ok = await crypto.unwrapVekWebauthn({
			hmacSecretB64: bytesToBase64(hmacSecret),
			slotIdB64: bytesToBase64(used.slotId),
			verifierB64: bytesToBase64(used.verifier),
			wrapIvB64: bytesToBase64(used.wrapIv),
			wrappedVekB64: bytesToBase64(used.wrappedVek),
			magicVersion: verifierPrefix(),
		});
		if (!ok) {
			throw new Error("Security-key unlock failed (verifier mismatch).");
		}
		await loadEntries();
		setIsLocked(false);
		void shell.flushPendingCornerCapture().catch(() => {});
	}, [readDecodedBlob, callGetWithSalt, crypto, loadEntries, shell]);

	/**
	 * Prove possession of a registered key (a tap) without touching lock state.
	 * Authorizes sensitive actions on a password-less vault.
	 */
	const verifyWithSecurityKey = useCallback(async (): Promise<boolean> => {
		const { blob } = await readDecodedBlob();
		const slots = findWebauthnSlots(blob);
		if (slots.length === 0) return false;
		try {
			const attempt = await callGetWithSalt(slots, slots[0]!.salt);
			return matchSlotByCredentialId(slots, attempt.rawId) !== null;
		} catch {
			return false;
		}
	}, [readDecodedBlob, callGetWithSalt]);

	/**
	 * Register a new security key against the unlocked vault. Requires the vault
	 * to be unlocked (wraps the in-memory VEK). Usually two taps: create() then a
	 * get() to read the PRF secret, unless the key supports one-tap hmac-secret-mc.
	 */
	const registerSecurityKey = useCallback(
		async (label: string) => {
			setError(null);
			if (await crypto.isLocked()) {
				throw new Error("Unlock the vault before adding a security key.");
			}
			const { blob } = await readDecodedBlob();

			// Pick the PRF salt up front so the authenticator can evaluate it during
			// create(); capable keys then return the secret there (no second tap).
			const challenge = new Uint8Array(32);
			globalThis.crypto.getRandomValues(challenge);
			const userId = new Uint8Array(16);
			globalThis.crypto.getRandomValues(userId);
			const salt = new Uint8Array(LEN_HMAC_SECRET_SALT);
			globalThis.crypto.getRandomValues(salt);
			let credentialId: Uint8Array;
			let hmacSecret: Uint8Array;
			try {
				const created = (await navigator.credentials.create({
					publicKey: {
						challenge: challenge as BufferSource,
						rp: { name: "Vault" },
						user: {
							id: userId as BufferSource,
							name: "vault@local",
							displayName: label || "Vault",
						},
						pubKeyCredParams: [
							{ type: "public-key", alg: -7 }, // ES256
							{ type: "public-key", alg: -257 }, // RS256
						],
						authenticatorSelection: {
							userVerification: "preferred",
							// Non-discoverable: the unlock handle lives in our vault file.
							residentKey: "discouraged",
						},
						attestation: "none",
						// prf is the web channel for hmac-secret (Chromium ignores raw
						// hmacCreateSecret/hmacGetSecret). Eval now for a possible one-tap register.
						extensions: {
							prf: { eval: { first: salt as BufferSource } },
						} as unknown as AuthenticationExtensionsClientInputs,
					},
				})) as PublicKeyCredential | null;
				if (!created) throw new Error("Authenticator returned no credential.");
				credentialId = new Uint8Array(created.rawId);

				// Prefer the secret from create(); else get() with the same salt. PRF
				// is deterministic, so the value matches and the persisted slot unlocks.
				const createdExt = created.getClientExtensionResults() as {
					prf?: { results?: { first?: ArrayBuffer } };
				};
				const evaluated = createdExt.prf?.results?.first;
				if (evaluated) {
					hmacSecret = new Uint8Array(evaluated);
				} else {
					const probe: WebauthnSlot = {
						kind: SLOT_KIND_WEBAUTHN,
						slotId: new Uint8Array(LEN_SLOT_ID),
						credentialId,
						salt,
						verifier: new Uint8Array(),
						wrapIv: new Uint8Array(),
						wrappedVek: new Uint8Array(),
					};
					hmacSecret = (await callGetWithSalt([probe], salt)).hmacSecret;
				}
			} catch (e) {
				if ((e as { name?: string })?.name === "NotAllowedError") {
					throw new Error(
						"Registration was cancelled or timed out. Adding a security key takes two taps: one to create the key, then a second to unlock its secret. Please try again and complete both prompts.",
					);
				}
				throw e;
			}

			const slotIdB64 = await crypto.generateSlotId();
			const wrapped = await crypto.wrapVekWebauthn({
				hmacSecretB64: bytesToBase64(hmacSecret),
				slotIdB64,
				magicVersion: verifierPrefix(),
			});
			const slot: WebauthnSlot = {
				kind: SLOT_KIND_WEBAUTHN,
				slotId: base64ToBytes(slotIdB64),
				credentialId,
				salt,
				verifier: base64ToBytes(wrapped.verifier),
				wrapIv: base64ToBytes(wrapped.wrapIv),
				wrappedVek: base64ToBytes(wrapped.wrappedVek),
			};

			const newBlob = addWebauthnSlot(blob, slot);
			await storage.writeVaultBlob(encodeVaultBlob(newBlob));

			const labels = { ...securityKeyLabels };
			labels[slotIdB64] = { label: label.trim() || "Security key", addedAt: Date.now() };
			await storage.setMeta(SECURITY_KEY_LABELS_PREF, labels);

			await refreshSlotMetadata();
		},
		[crypto, readDecodedBlob, storage, securityKeyLabels, refreshSlotMetadata, callGetWithSalt],
	);

	/** Remove a security-key slot and its stored label. */
	const revokeSecurityKey = useCallback(
		async (slotIdB64: string) => {
			setError(null);
			const { blob } = await readDecodedBlob();
			const newBlob = removeWebauthnSlot(blob, base64ToBytes(slotIdB64));
			await storage.writeVaultBlob(encodeVaultBlob(newBlob));
			const labels = { ...securityKeyLabels };
			delete labels[slotIdB64];
			await storage.setMeta(SECURITY_KEY_LABELS_PREF, labels);
			await refreshSlotMetadata();
		},
		[readDecodedBlob, storage, securityKeyLabels, refreshSlotMetadata],
	);

	/** Prompt the user to pick a vault file to create or open. */
	const pickVaultFile = useCallback(
		async (mode: "create" | "open") => {
			setError(null);
			await storage.selectVaultFile(mode);
			setHasVault(await storage.hasVaultHandle());
		},
		[storage],
	);

	/** Create a new vault with a password slot and an initial recovery slot. */
	const createVault = useCallback(
		async (password: string): Promise<string> => {
			setError(null);
			await crypto.generateVek();
			const passwordSlot = await wrapPasswordSlot(password);
			const code = makeRecoveryCode();
			const recoverySlot = await wrapRecoverySlot(code);
			const { iv, ciphertext } = await crypto.encryptWithVek("[]");

			const blob: VaultBlob = {
				slots: [passwordSlot, recoverySlot],
				entriesIv: base64ToBytes(iv),
				entriesCiphertext: base64ToBytes(ciphertext),
			};
			await storage.writeVaultBlob(encodeVaultBlob(blob));
			setHasVault(true);
			setEntries([]);
			setIsLocked(false);
			await refreshSlotMetadata();
			return code;
		},
		[storage, crypto, wrapPasswordSlot, wrapRecoverySlot, refreshSlotMetadata],
	);

	/** Re-encrypt all entries and write a new blob; the slot list is unchanged. */
	const persistEntries = useCallback(
		async (nextEntries: Entry[]) => {
			const encryptedEntries: EncryptedEntry[] = await Promise.all(
				nextEntries.map(async (entry) => {
					const { id, ...data } = entry;
					const enc = await crypto.encryptEntry(JSON.stringify(data));
					return {
						id,
						wrappedDek: enc.wrappedDek,
						dekIv: enc.dekIv,
						ciphertext: enc.ciphertext,
						iv: enc.iv,
					};
				}),
			);
			const outerJson = JSON.stringify(encryptedEntries);
			const { iv, ciphertext } = await crypto.encryptWithVek(outerJson);

			const { blob: current } = await readDecodedBlob();
			const newBlob: VaultBlob = {
				slots: current.slots,
				entriesIv: base64ToBytes(iv),
				entriesCiphertext: base64ToBytes(ciphertext),
			};
			await storage.writeVaultBlob(encodeVaultBlob(newBlob));

			await autofill.setIndex(toAutofillIndex(nextEntries));
		},
		[crypto, storage, autofill, readDecodedBlob],
	);

	/** Add one entry and persist. */
	const addEntry = useCallback(
		async (data: EntryData) => {
			const newEntry: Entry = { id: globalThis.crypto.randomUUID(), ...data };
			const next = [...entries, newEntry];
			await persistEntries(next);
			setEntries(next);
		},
		[entries, persistEntries],
	);

	/** Bulk-add imported entries in a single encrypt-and-write (one disk write, not N). */
	const importEntries = useCallback(
		async (items: EntryData[]) => {
			const withIds: Entry[] = items.map((data) => ({
				id: globalThis.crypto.randomUUID(),
				...data,
			}));
			const next = [...entries, ...withIds];
			await persistEntries(next);
			setEntries(next);
		},
		[entries, persistEntries],
	);

	/** Replace one entry by id and persist. */
	const updateEntry = useCallback(
		async (id: string, data: EntryData) => {
			const next = entries.map((e) => (e.id === id ? { id, ...data } : e));
			await persistEntries(next);
			setEntries(next);
		},
		[entries, persistEntries],
	);

	/** Delete one entry by id and persist. */
	const deleteEntry = useCallback(
		async (id: string) => {
			const next = entries.filter((e) => e.id !== id);
			await persistEntries(next);
			setEntries(next);
		},
		[entries, persistEntries],
	);

	/** Check a password against the slot verifier without unlocking. */
	const verifyMasterPassword = useCallback(
		async (password: string) => {
			const { blob } = await readDecodedBlob();
			const slot = findPasswordSlot(blob);
			if (!slot) return false;
			return crypto.verifyPasswordSlot({
				password,
				saltB64: bytesToBase64(slot.salt),
				slotIdB64: bytesToBase64(slot.slotId),
				verifierB64: bytesToBase64(slot.verifier),
				magicVersion: verifierPrefix(),
			});
		},
		[crypto, readDecodedBlob],
	);

	/**
	 * Re-wrap the in-memory VEK under `password` as the vault's single password
	 * slot. Shared core of set, re-enable, and change. Does NOT rotate the VEK
	 * (other slots depend on it), only the password KEK + verifier. The written
	 * slot is verified post-write and the file rolled back on failure.
	 */
	const writeMasterPasswordSlot = useCallback(
		async (password: string) => {
			const { blob } = await readDecodedBlob();
			const slot = await wrapPasswordSlot(password);
			const newBlob = upsertPasswordSlot(blob, slot);
			await storage.writeVaultBlob(encodeVaultBlob(newBlob));
			try {
				const { blob: written } = await readDecodedBlob();
				const writtenSlot = findPasswordSlot(written);
				const ok =
					writtenSlot != null &&
					(await crypto.verifyPasswordSlot({
						password,
						saltB64: bytesToBase64(writtenSlot.salt),
						slotIdB64: bytesToBase64(writtenSlot.slotId),
						verifierB64: bytesToBase64(writtenSlot.verifier),
						magicVersion: verifierPrefix(),
					}));
				if (!ok) throw new Error("password slot failed post-write verify");
			} catch {
				await storage.restoreVaultFromBackup().catch(() => false);
				throw new Error("Couldn't save the master password. Please try again.");
			}
			await refreshSlotMetadata();
		},
		[readDecodedBlob, wrapPasswordSlot, storage, crypto, refreshSlotMetadata],
	);

	/** Change the master password. Requires the vault unlocked; does not rotate the VEK. */
	const changeMasterPassword = useCallback(
		async (newPassword: string) => {
			setError(null);
			if (await crypto.isLocked()) {
				throw new Error("Unlock the vault before changing the master password.");
			}
			const { blob } = await readDecodedBlob();
			if (!findPasswordSlot(blob)) {
				throw new Error("This vault has no master password to change.");
			}
			await writeMasterPasswordSlot(newPassword);
		},
		[crypto, readDecodedBlob, writeMasterPasswordSlot],
	);

	/** Set (or re-enable) the master password. Requires the vault unlocked. */
	const setMasterPassword = useCallback(
		async (password: string) => {
			setError(null);
			if (await crypto.isLocked()) {
				throw new Error("Unlock the vault before setting a master password.");
			}
			await writeMasterPasswordSlot(password);
		},
		[crypto, writeMasterPasswordSlot],
	);

	/** Remove the master-password slot. Requires the vault unlocked and a security key (invariant B). */
	const disableMasterPassword = useCallback(async () => {
		setError(null);
		if (await crypto.isLocked()) {
			throw new Error("Unlock the vault before disabling the master password.");
		}
		const { blob } = await readDecodedBlob();
		// Throws (invariant B) if no security key remains to unlock with.
		const newBlob = removePasswordSlot(blob);
		await storage.writeVaultBlob(encodeVaultBlob(newBlob));
		await refreshSlotMetadata();
	}, [crypto, readDecodedBlob, storage, refreshSlotMetadata]);

	/** Generate (or reset) the recovery code. Requires the vault unlocked; returns the plaintext once. */
	const generateRecoveryCode = useCallback(async (): Promise<string> => {
		setError(null);
		if (await crypto.isLocked()) {
			throw new Error("Unlock the vault before generating a recovery code.");
		}
		const { blob } = await readDecodedBlob();
		const code = makeRecoveryCode();
		const slot = await wrapRecoverySlot(code);
		const newBlob = upsertRecoverySlot(blob, slot);
		await storage.writeVaultBlob(encodeVaultBlob(newBlob));
		await refreshSlotMetadata();
		return code;
	}, [crypto, readDecodedBlob, wrapRecoverySlot, storage, refreshSlotMetadata]);

	/** Unlock by trying the code against every recovery slot. */
	const unlockWithRecoveryCode = useCallback(
		async (code: string) => {
			setError(null);
			let slots: RecoverySlot[];
			try {
				const { blob } = await readDecodedBlob();
				slots = findRecoverySlots(blob);
			} catch (e) {
				console.error("[vault] failed to read vault blob:", e);
				throw new Error("Couldn't open this vault. The file may be missing or unreadable.");
			}
			if (slots.length === 0) throw new Error("This vault has no recovery code.");
			const normalized = normalizeRecoveryCode(code);
			let opened = false;
			for (const slot of slots) {
				const ok = await crypto.unwrapVekPassword({
					password: normalized,
					saltB64: bytesToBase64(slot.salt),
					slotIdB64: bytesToBase64(slot.slotId),
					verifierB64: bytesToBase64(slot.verifier),
					wrapIvB64: bytesToBase64(slot.wrapIv),
					wrappedVekB64: bytesToBase64(slot.wrappedVek),
					magicVersion: verifierPrefix(),
				});
				if (ok) {
					opened = true;
					break;
				}
			}
			if (!opened) throw new Error("Incorrect recovery code");
			await loadEntries();
			setIsLocked(false);
			void shell.flushPendingCornerCapture().catch(() => {});
		},
		[readDecodedBlob, crypto, loadEntries, shell],
	);

	const hasWebauthnSlot = webauthnSlots.length > 0;
	const securityKeys = useMemo<SecurityKeyMeta[]>(
		() =>
			webauthnSlots.map((slot) => {
				const slotIdB64 = bytesToBase64(slot.slotId);
				const meta = securityKeyLabels[slotIdB64];
				return {
					slotIdB64,
					label: meta?.label ?? "Security key",
					addedAt: meta?.addedAt ?? 0,
				};
			}),
		[webauthnSlots, securityKeyLabels],
	);

	const value = useMemo<UseVault>(
		() => ({
			hasVault,
			isLocked,
			ready,
			entries,
			error,
			pendingSyncCount,
			hasWebauthnSlot,
			hasPasswordSlot,
			hasRecoveryCode,
			securityKeys,
			unlock,
			lock,
			pickVaultFile,
			createVault,
			addEntry,
			importEntries,
			updateEntry,
			deleteEntry,
			verifyMasterPassword,
			verifyWithSecurityKey,
			changeMasterPassword,
			setMasterPassword,
			disableMasterPassword,
			unlockWithSecurityKey,
			registerSecurityKey,
			revokeSecurityKey,
			generateRecoveryCode,
			unlockWithRecoveryCode,
		}),
		[
			hasVault,
			isLocked,
			ready,
			entries,
			error,
			pendingSyncCount,
			hasWebauthnSlot,
			hasPasswordSlot,
			hasRecoveryCode,
			securityKeys,
			unlock,
			lock,
			pickVaultFile,
			createVault,
			addEntry,
			importEntries,
			updateEntry,
			deleteEntry,
			verifyMasterPassword,
			verifyWithSecurityKey,
			changeMasterPassword,
			setMasterPassword,
			disableMasterPassword,
			unlockWithSecurityKey,
			registerSecurityKey,
			revokeSecurityKey,
			generateRecoveryCode,
			unlockWithRecoveryCode,
		],
	);

	return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

/** Access the vault API. Must be called inside a VaultProvider. */
export function useVault(): UseVault {
	const ctx = useContext(VaultContext);
	if (!ctx) throw new Error("useVault called outside VaultProvider");
	return ctx;
}

export type { EncryptedEntry };
