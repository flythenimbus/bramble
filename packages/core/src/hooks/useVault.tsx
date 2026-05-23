import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import type { SubdomainMatchMode } from "../adapters/autofill";
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

export interface EntryData {
	name: string;
	url: string;
	username: string;
	password: string;
	totp?: string;
	notes?: string;
	breach?: BreachStatus;
	autofillEnabled?: boolean;
	autoSubmit?: boolean;
	subdomainMatch?: SubdomainMatchMode;
}

export interface Entry extends EntryData {
	id: string;
}

export interface UseVault {
	hasVault: boolean;
	isLocked: boolean;
	entries: Entry[];
	error: string | null;
	unlock(password: string): Promise<void>;
	lock(): Promise<void>;
	pickVaultFile(mode: "create" | "open"): Promise<void>;
	createVault(password: string): Promise<void>;
	addEntry(data: EntryData): Promise<void>;
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

function indexEntryFor(entry: Entry) {
	return {
		id: entry.id,
		hostname: extractHostname(entry.url),
		name: entry.name,
		username: entry.username,
		password: entry.password,
		autofillEnabled: entry.autofillEnabled,
		autoSubmit: entry.autoSubmit,
		subdomainMatch: entry.subdomainMatch,
	};
}

export function VaultProvider({ children }: { children: ReactNode }) {
	const { storage, crypto, autofill } = usePlatform();
	const [hasVault, setHasVault] = useState(false);
	const [isLocked, setIsLocked] = useState(true);
	const [entries, setEntries] = useState<Entry[]>([]);
	const [error, setError] = useState<string | null>(null);

	const loadEntries = useCallback(async () => {
		const blobBytes = await storage.readVaultBlob();
		const blob = decodeVaultBlob(blobBytes);
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
				const data: EntryData = JSON.parse(plaintext);
				return { id: enc.id, ...data };
			}),
		);
		setEntries(decrypted);
		// works even when the popup is closed.
		await autofill.setIndex(decrypted.map(indexEntryFor));
	}, [storage, crypto, autofill]);

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
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [storage, crypto, loadEntries]);

	const unlock = useCallback(
		async (password: string) => {
			setError(null);
			let slot: PasswordSlot | null;
			try {
				const blobBytes = await storage.readVaultBlob();
				const blob = decodeVaultBlob(blobBytes);
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
		[storage, crypto, loadEntries],
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

			const currentBytes = await storage.readVaultBlob();
			const current = decodeVaultBlob(currentBytes);
			const newBlob: VaultBlob = {
				slots: current.slots,
				entriesIv: base64ToBytes(iv),
				entriesCiphertext: base64ToBytes(ciphertext),
			};
			await storage.writeVaultBlob(encodeVaultBlob(newBlob));

			await autofill.setIndex(nextEntries.map(indexEntryFor));
		},
		[crypto, storage, autofill],
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
			const blobBytes = await storage.readVaultBlob();
			const blob = decodeVaultBlob(blobBytes);
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
		[crypto, storage],
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
	// before calling this. We hold the old VEK in JS memory and roll back if
	// any step before the disk write fails, so a partial-rotation can't
	// strand the user.
	const changeMasterPassword = useCallback(
		async (newPassword: string) => {
			setError(null);

			const blobBytes = await storage.readVaultBlob();
			const blob = decodeVaultBlob(blobBytes);
			const existing = findPasswordSlot(blob);
			if (!existing) throw new Error("vault has no password slot to rotate");
			if (blob.slots.length !== 1) {
				throw new Error(
					"vault has additional authenticators; multi-slot rotation is not yet supported",
				);
			}

			const oldVekB64 = await crypto.exportVek();
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
				await storage.writeVaultBlob(encodeVaultBlob(newBlob));

				// 4. Refresh the in-memory autofill index so the background SW
				//    keeps serving credentials without a relock.
				await autofill.setIndex(entries.map(indexEntryFor));
			} catch (e) {
				// Restore the previous VEK so the still-on-disk vault is
				// readable again. Without this the user would have to relock
				// and re-enter their current password to recover.
				await crypto.unlockWithVek(oldVekB64);
				throw e;
			}
		},
		[crypto, storage, autofill, entries],
	);

	const value = useMemo<UseVault>(
		() => ({
			hasVault,
			isLocked,
			entries,
			error,
			unlock,
			lock,
			pickVaultFile,
			createVault,
			addEntry,
			updateEntry,
			deleteEntry,
			verifyMasterPassword,
			changeMasterPassword,
		}),
		[
			hasVault,
			isLocked,
			entries,
			error,
			unlock,
			lock,
			pickVaultFile,
			createVault,
			addEntry,
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
