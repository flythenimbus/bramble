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
	findWebauthnSlots,
	LEN_HMAC_SECRET_SALT,
	LEN_SLOT_ID,
	type PasswordSlot,
	SLOT_KIND_PASSWORD,
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

//
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

export function isLogin<T extends EntryData>(entry: T): entry is Extract<T, LoginEntryData> {
	return entry.type === "login";
}

import { entryDataSchema, normalizeEntryData } from "../vault/entry-normalize";
import {
	addWebauthnSlot,
	matchSlotByCredentialId,
	needsSaltMismatchRetry,
	removeWebauthnSlot,
} from "../vault/security-key-slots";

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
	hasWebauthnSlot: boolean;
	securityKeys: SecurityKeyMeta[];
	ready: boolean;
	entries: Entry[];
	error: string | null;
	pendingSyncCount: number;
	unlock(password: string): Promise<void>;
	lock(): Promise<void>;
	pickVaultFile(mode: "create" | "open"): Promise<void>;
	createVault(password: string): Promise<void>;
	addEntry(data: EntryData): Promise<void>;
	importEntries(items: EntryData[]): Promise<void>;
	updateEntry(id: string, data: EntryData): Promise<void>;
	deleteEntry(id: string): Promise<void>;
	verifyMasterPassword(password: string): Promise<boolean>;
	changeMasterPassword(newPassword: string): Promise<void>;
	unlockWithSecurityKey(): Promise<void>;
	registerSecurityKey(label: string): Promise<void>;
	revokeSecurityKey(slotIdB64: string): Promise<void>;
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
			setSecurityKeyLabels(stored ?? {});
		} catch {
			setWebauthnSlots([]);
			setSecurityKeyLabels({});
		}
	}, [readDecodedBlob, storage]);

	const loadEntries = useCallback(async () => {
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

	useEffect(() => {
		return crypto.onExternalLock(() => {
			setEntries([]);
			setIsLocked(true);
		});
	}, [crypto]);

	useEffect(() => {
		return crypto.onExternalChange(() => {
			void loadEntries().catch(() => {});
		});
	}, [crypto, loadEntries]);

	const unlock = useCallback(
		async (password: string) => {
			setError(null);
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
			void shell.flushPendingCornerCapture().catch(() => {});
		},
		[readDecodedBlob, crypto, loadEntries, shell],
	);

	const lock = useCallback(async () => {
		await crypto.lock();
		await autofill.clearIndex();
		setEntries([]);
		setIsLocked(true);
	}, [crypto, autofill]);


	const callGetWithSalt = useCallback(
		async (
			allowCredentials: WebauthnSlot[],
			salt: Uint8Array,
		): Promise<{ rawId: Uint8Array; hmacSecret: Uint8Array }> => {
			const challenge = new Uint8Array(32);
			globalThis.crypto.getRandomValues(challenge);
			// `hmacGetSecret` isn't in lib.dom.d.ts's `AuthenticationExtensionsClientInputs`;
			// cast the options object so TS doesn't reject the field.
			const publicKey = {
				challenge: challenge as BufferSource,
				allowCredentials: allowCredentials.map((s) => ({
					type: "public-key",
					id: s.credentialId as BufferSource,
				})),
				userVerification: "preferred",
				extensions: { hmacGetSecret: { salt1: salt as BufferSource } },
			} as unknown as PublicKeyCredentialRequestOptions;
			const credential = (await navigator.credentials.get({
				publicKey,
			})) as PublicKeyCredential | null;
			if (!credential) throw new Error("Authenticator returned no credential.");
			const ext = credential.getClientExtensionResults() as {
				hmacGetSecret?: { output1?: ArrayBuffer };
			};
			const out1 = ext.hmacGetSecret?.output1;
			if (!out1) {
				throw new Error(
					"This authenticator didn't return an hmac-secret. Try a YubiKey 5+ or Windows Hello.",
				);
			}
			return {
				rawId: new Uint8Array(credential.rawId),
				hmacSecret: new Uint8Array(out1),
			};
		},
		[],
	);

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

	const registerSecurityKey = useCallback(
		async (label: string) => {
			setError(null);
			if (await crypto.isLocked()) {
				throw new Error("Unlock the vault before adding a security key.");
			}
			const { blob } = await readDecodedBlob();

			// Step 1: create() — register a credential with hmacCreateSecret.
			const challenge = new Uint8Array(32);
			globalThis.crypto.getRandomValues(challenge);
			const userId = new Uint8Array(16);
			globalThis.crypto.getRandomValues(userId);
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
						residentKey: "discouraged",
					},
					attestation: "none",
					extensions: { hmacCreateSecret: true },
				},
			})) as PublicKeyCredential | null;
			if (!created) throw new Error("Authenticator returned no credential.");
			const createdExt = created.getClientExtensionResults() as {
				hmacCreateSecret?: boolean;
			};
			if (createdExt.hmacCreateSecret !== true) {
				throw new Error(
					"This authenticator doesn't support hmac-secret. Try a YubiKey 5+ or Windows Hello.",
				);
			}

			// Step 2: generate a fresh 32-byte salt for this slot, then get()
			// to retrieve the actual secret. (The create() response confirms
			// support; only get() returns the secret.)
			const credentialId = new Uint8Array(created.rawId);
			const salt = new Uint8Array(LEN_HMAC_SECRET_SALT);
			globalThis.crypto.getRandomValues(salt);
			const { hmacSecret } = await callGetWithSalt(
				[
					{
						kind: SLOT_KIND_WEBAUTHN,
						slotId: new Uint8Array(LEN_SLOT_ID),
						credentialId,
						salt,
						verifier: new Uint8Array(),
						wrapIv: new Uint8Array(),
						wrappedVek: new Uint8Array(),
					},
				],
				salt,
			);

			// Step 3: wrap the VEK under a KEK derived from the secret.
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

	const pickVaultFile = useCallback(
		async (mode: "create" | "open") => {
			setError(null);
			await storage.selectVaultFile(mode);
			setHasVault(await storage.hasVaultHandle());
		},
		[storage],
	);

	const createVault = useCallback(
		async (password: string) => {
			setError(null);
			await crypto.generateVek();
			// 2. Wrap the VEK under the password — produces the initial
			//    password slot. Salt and slotId are fresh per slot.
			const saltB64 = await crypto.generateSalt();
			const slotIdB64 = await crypto.generateSlotId();
			const wrapped = await crypto.wrapVekPassword({
				password,
				saltB64,
				slotIdB64,
				magicVersion: verifierPrefix(),
			});
			const { iv, ciphertext } = await crypto.encryptWithVek("[]");

			const slot: PasswordSlot = {
				kind: SLOT_KIND_PASSWORD,
				slotId: base64ToBytes(slotIdB64),
				salt: base64ToBytes(saltB64),
				verifier: base64ToBytes(wrapped.verifier),
				wrapIv: base64ToBytes(wrapped.wrapIv),
				wrappedVek: base64ToBytes(wrapped.wrappedVek),
			};
			const blob: VaultBlob = {
				slots: [slot],
				entriesIv: base64ToBytes(iv),
				entriesCiphertext: base64ToBytes(ciphertext),
			};
			await storage.writeVaultBlob(encodeVaultBlob(blob));
			setHasVault(true);
			setEntries([]);
			setIsLocked(false);
		},
		[storage, crypto],
	);

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

	const addEntry = useCallback(
		async (data: EntryData) => {
			const newEntry: Entry = { id: globalThis.crypto.randomUUID(), ...data };
			const next = [...entries, newEntry];
			await persistEntries(next);
			setEntries(next);
		},
		[entries, persistEntries],
	);

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

	const updateEntry = useCallback(
		async (id: string, data: EntryData) => {
			const next = entries.map((e) => (e.id === id ? { id, ...data } : e));
			await persistEntries(next);
			setEntries(next);
		},
		[entries, persistEntries],
	);

	const deleteEntry = useCallback(
		async (id: string) => {
			const next = entries.filter((e) => e.id !== id);
			await persistEntries(next);
			setEntries(next);
		},
		[entries, persistEntries],
	);

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

	// Full rotation on password change. The VEK itself is rotated, every
	// entry is re-encrypted under a fresh DEK + IV (so any leaked old VEK or
	// old DEK cannot decrypt new ciphertext), the outer entries blob is
	// re-encrypted, and the password slot is re-wrapped under the new VEK.
	//
	// Today's vaults only have a single password slot. When we add WebAuthn /
	// recovery slots, each existing authenticator will need to be presented
	// during rotation so we can re-wrap the new VEK under its KEK — until
	// that UI exists we refuse to rotate vaults with extra slots rather than
	// silently dropping them.
	//
	// Caller (Settings) is responsible for verifying the current password
	// before calling this. Atomicity from the user's perspective is enforced
	// by reading the written blob back, decoding it, and *decrypting it under
	// the new VEK* before reporting success. If any of those fail we restore
	// the on-disk backup snapshot taken by `writeVaultBlob` and revert the
	// in-memory VEK so the still-on-disk vault is openable under the OLD
	// password — i.e. the rotation never half-applied.
	const changeMasterPassword = useCallback(
		async (newPassword: string) => {
			setError(null);

			const { blob } = await readDecodedBlob();
			const existing = findPasswordSlot(blob);
			if (!existing) throw new Error("vault has no password slot to rotate");
			// Rotation re-encrypts everything under a fresh VEK, which would
			// invalidate every other slot's wrappedVek. For webauthn slots
			// we'd have to re-prompt the user to tap each registered key,
			// which is unacceptable UX; for now refuse and tell the user to
			// remove security keys first.
			if (findWebauthnSlots(blob).length > 0) {
				throw new Error(
					"Remove all security keys first — rotating the master password will invalidate them.",
				);
			}
			if (blob.slots.length !== 1) {
				throw new Error(
					"vault has additional authenticators; multi-slot rotation is not yet supported",
				);
			}

			const oldVekB64 = await crypto.exportVek();
			let didWrite = false;
			try {
				// 1. Rotate the VEK. From here on every encrypt uses the new key;
				//    every decrypt against old ciphertext will fail.
				await crypto.rotateVek();

				// 2. Re-encrypt every entry under the new VEK. encryptEntry
				//    generates a fresh DEK + content IV + dek-wrap IV per call,
				//    so no piece of cryptographic material survives the rotation.
				const encryptedEntries: EncryptedEntry[] = await Promise.all(
					entries.map(async (entry) => {
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
				const outerJson = encryptedEntries.length === 0 ? "[]" : JSON.stringify(encryptedEntries);
				const { iv: outerIv, ciphertext: outerCt } = await crypto.encryptWithVek(outerJson);

				// 3. Wrap the new VEK under the new password's KEK (new salt,
				//    same slotId so the slot's identity is stable).
				const newSaltB64 = await crypto.generateSalt();
				const wrapped = await crypto.wrapVekPassword({
					password: newPassword,
					saltB64: newSaltB64,
					slotIdB64: bytesToBase64(existing.slotId),
					magicVersion: verifierPrefix(),
				});

				const newSlot: PasswordSlot = {
					kind: SLOT_KIND_PASSWORD,
					slotId: existing.slotId,
					salt: base64ToBytes(newSaltB64),
					verifier: base64ToBytes(wrapped.verifier),
					wrapIv: base64ToBytes(wrapped.wrapIv),
					wrappedVek: base64ToBytes(wrapped.wrappedVek),
				};
				const newBlob: VaultBlob = {
					slots: [newSlot],
					entriesIv: base64ToBytes(outerIv),
					entriesCiphertext: base64ToBytes(outerCt),
				};
				// 4. Persist. `writeVaultBlob` snapshots the previous bytes to
				//    a backup key first, so steps 5/6 can roll back to the old
				//    vault if anything is wrong with what we just wrote.
				await storage.writeVaultBlob(encodeVaultBlob(newBlob));
				didWrite = true;

				// 5. Verify the persisted bytes decode cleanly.
				const writtenBytes = await storage.readVaultBlob();
				const writtenBlob = decodeVaultBlob(writtenBytes);

				// 6. Verify the persisted bytes decrypt under the newly-loaded
				//    VEK. A non-empty entries blob is the strongest signal;
				//    for an empty vault, attempt to unwrap the new slot under
				//    the new password as the equivalent end-to-end check.
				if (writtenBlob.entriesCiphertext.length > 0) {
					await crypto.decryptWithVek(
						bytesToBase64(writtenBlob.entriesIv),
						bytesToBase64(writtenBlob.entriesCiphertext),
					);
				} else {
					const writtenSlot = findPasswordSlot(writtenBlob);
					if (!writtenSlot) throw new Error("rotated blob has no password slot");
					const ok = await crypto.verifyPasswordSlot({
						password: newPassword,
						saltB64: bytesToBase64(writtenSlot.salt),
						slotIdB64: bytesToBase64(writtenSlot.slotId),
						verifierB64: bytesToBase64(writtenSlot.verifier),
						magicVersion: verifierPrefix(),
					});
					if (!ok) throw new Error("rotated blob slot fails new-password verify");
				}

				// 7. Refresh the in-memory autofill index so the background SW
				//    keeps serving credentials without a relock.
				await autofill.setIndex(toAutofillIndex(entries));
			} catch (e) {
				// If the write completed but verification failed, the on-disk
				// blob is the new-but-broken one. Roll the file back to the
				// backup snapshot taken inside writeVaultBlob, then restore
				// the previous VEK so the recovered file is openable under
				// the OLD password. The user sees "rotation failed; try
				// again" — never an unreadable vault.
				if (didWrite) {
					await storage.restoreVaultFromBackup().catch(() => false);
				}
				await crypto.unlockWithVek(oldVekB64);
				throw e;
			}
		},
		[crypto, storage, autofill, entries, readDecodedBlob],
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
			changeMasterPassword,
			unlockWithSecurityKey,
			registerSecurityKey,
			revokeSecurityKey,
		}),
		[
			hasVault,
			isLocked,
			ready,
			entries,
			error,
			pendingSyncCount,
			hasWebauthnSlot,
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
			changeMasterPassword,
			unlockWithSecurityKey,
			registerSecurityKey,
			revokeSecurityKey,
		],
	);

	return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

export function useVault(): UseVault {
	const ctx = useContext(VaultContext);
	if (!ctx) throw new Error("useVault called outside VaultProvider");
	return ctx;
}

export type { EncryptedEntry };
