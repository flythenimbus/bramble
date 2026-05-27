import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { z } from "zod";
import type { IndexEntry, SubdomainMatchMode } from "../adapters/autofill";
import { usePlatform } from "../context/PlatformContext";
import {
	decodeVaultBlob,
	type EncryptedEntry,
	encodeVaultBlob,
	findPasswordSlot,
	type PasswordSlot,
	SLOT_KIND_PASSWORD,
	type VaultBlob,
	verifierPrefix,
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

// Runtime mirror of EntryData, kept beside the type so drift is obvious: the
// `z.ZodType<EntryData>` annotation makes the compiler fail here if the schema
// and the hand-written union diverge. Used to validate entries decrypted from
// disk (below) and every entry the importer produces (see import/), so nothing
// malformed reaches the rest of the app.
const customFieldSchema = z.object({
	key: z.string(),
	value: z.string(),
	hidden: z.boolean().optional(),
});

const baseEntryFields = {
	name: z.string(),
	notes: z.string().optional(),
	customFields: z.array(customFieldSchema).optional(),
};

export const entryDataSchema: z.ZodType<EntryData> = z.discriminatedUnion("type", [
	z.object({
		...baseEntryFields,
		type: z.literal("login"),
		urls: z.array(z.string()),
		username: z.string(),
		password: z.string(),
		totp: z.string().optional(),
		breach: z.object({ leaked: z.boolean(), checkedAt: z.number() }).optional(),
		autofillEnabled: z.boolean().optional(),
		autoSubmit: z.boolean().optional(),
		subdomainMatch: z.enum(["etld1", "exact", "subdomain"]).optional(),
	}),
	z.object({
		...baseEntryFields,
		type: z.literal("card"),
		cardholderName: z.string(),
		number: z.string(),
		brand: z.string().optional(),
		expMonth: z.string(),
		expYear: z.string(),
		cvv: z.string(),
	}),
	z.object({ ...baseEntryFields, type: z.literal("note") }),
	z.object({
		...baseEntryFields,
		type: z.literal("ssh-key"),
		publicKey: z.string(),
		privateKey: z.string(),
		passphrase: z.string().optional(),
		keyType: z.string().optional(),
	}),
]);

function normalizeEntryData(raw: Record<string, unknown>): EntryData {
	const candidate: Record<string, unknown> = raw.type ? { ...raw } : { type: "login", ...raw };
	if (candidate.type === "login" && !Array.isArray(candidate.urls)) {
		const legacy = typeof candidate.url === "string" ? candidate.url : "";
		candidate.urls = legacy ? [legacy] : [];
		delete candidate.url;
	}
	if (!entryDataSchema.safeParse(candidate).success) {
		const type = typeof candidate?.type === "string" ? candidate.type : "<missing>";
		const keys = Object.keys(candidate ?? {})
			.sort()
			.join(",");
		console.error(`[vault] decrypted entry has an unexpected shape (type=${type}, keys=${keys})`);
	}
	return candidate as unknown as EntryData;
}

export interface UseVault {
	hasVault: boolean;
	isLocked: boolean;
	ready: boolean;
	entries: Entry[];
	error: string | null;
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
	const { storage, crypto, autofill } = usePlatform();
	const [hasVault, setHasVault] = useState(false);
	const [isLocked, setIsLocked] = useState(true);
	const [ready, setReady] = useState(false);
	const [entries, setEntries] = useState<Entry[]>([]);
	const [error, setError] = useState<string | null>(null);

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

	const loadEntries = useCallback(async () => {
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
	}, [readDecodedBlob, crypto, autofill]);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const has = await storage.hasVaultHandle();
				if (cancelled) return;
				setHasVault(has);
				if (!has) return;

				const locked = await crypto.isLocked();
				if (cancelled) return;
				setIsLocked(locked);
				if (locked) return;

				await loadEntries();
			} catch (e) {
				if (!cancelled) setError(String(e));
			} finally {
				if (!cancelled) setReady(true);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [storage, crypto, loadEntries]);

	useEffect(() => {
		return crypto.onExternalLock(() => {
			setEntries([]);
			setIsLocked(true);
		});
	}, [crypto]);

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
		},
		[readDecodedBlob, crypto, loadEntries],
	);

	const lock = useCallback(async () => {
		await crypto.lock();
		await autofill.clearIndex();
		setEntries([]);
		setIsLocked(true);
	}, [crypto, autofill]);

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

	const value = useMemo<UseVault>(
		() => ({
			hasVault,
			isLocked,
			ready,
			entries,
			error,
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
		}),
		[
			hasVault,
			isLocked,
			ready,
			entries,
			error,
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
