import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { usePlatform } from "../context/PlatformContext";
import {
	decodeVaultBlob,
	type EncryptedEntry,
	encodeVaultBlob,
	MAGIC,
	VERSION,
} from "../vault-format";

export interface EntryData {
	name: string;
	url: string;
	username: string;
	password: string;
	totp?: string;
	notes?: string;
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
}

const VaultContext = createContext<UseVault | null>(null);

// Verifier input: magic bytes followed by the version byte. The Rust HMAC
// over this is what gets stored in the vault header and compared on unlock.
function verifierInput(): Uint8Array {
	const out = new Uint8Array(MAGIC.length + 1);
	out.set(MAGIC, 0);
	out[MAGIC.length] = VERSION;
	return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
	return diff === 0;
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

export function VaultProvider({ children }: { children: ReactNode }) {
	const { storage, crypto } = usePlatform();
	const [hasVault, setHasVault] = useState(false);
	const [isLocked, setIsLocked] = useState(true);
	const [entries, setEntries] = useState<Entry[]>([]);
	const [error, setError] = useState<string | null>(null);

	const loadEntries = useCallback(async () => {
		const blobBytes = await storage.readVaultBlob();
		const blob = decodeVaultBlob(blobBytes);
		if (blob.entriesCiphertext.length === 0) {
			setEntries([]);
			return;
		}
		const outerJson = await crypto.decryptWithMaster(
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
	}, [storage, crypto]);

	useEffect(() => {
		void (async () => {
			try {
				const has = await storage.hasVaultHandle();
				setHasVault(has);
				const locked = await crypto.isLocked();
				setIsLocked(locked);
				if (has && !locked) await loadEntries();
			} catch (e) {
				setError(String(e));
			}
		})();
	}, [storage, crypto, loadEntries]);

	const unlock = useCallback(
		async (password: string) => {
			setError(null);
			const blobBytes = await storage.readVaultBlob();
			const blob = decodeVaultBlob(blobBytes);
			await crypto.unlock(password, bytesToBase64(blob.salt));
			const computedVerifier = await crypto.verifierFor(verifierInput());
			if (!bytesEqual(computedVerifier, blob.verifier)) {
				await crypto.lock();
				throw new Error("incorrect master password");
			}
			await loadEntries();
			setIsLocked(false);
		},
		[storage, crypto, loadEntries],
	);

	const lock = useCallback(async () => {
		await crypto.lock();
		setEntries([]);
		setIsLocked(true);
	}, [crypto]);

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
			// File selection is the caller's responsibility (use pickVaultFile
			// first if you want FSA-backed storage). If no handle is picked, the
			// storage adapter falls back to chrome.storage.local.
			const saltB64 = await crypto.generateSalt();
			await crypto.unlock(password, saltB64);
			const verifier = await crypto.verifierFor(verifierInput());
			const { iv, ciphertext } = await crypto.encryptWithMaster("[]");
			const blob = encodeVaultBlob({
				salt: base64ToBytes(saltB64),
				verifier,
				entriesIv: base64ToBytes(iv),
				entriesCiphertext: base64ToBytes(ciphertext),
			});
			await storage.writeVaultBlob(blob);
			setHasVault(true);
			setEntries([]);
			setIsLocked(false);
		},
		[storage, crypto],
	);

	// Re-encrypt all entries and write a new vault blob. The salt + verifier
	// stay the same (those are set at vault creation); only the entries IV +
	// outer ciphertext change. Every save re-randomises every DEK / IV — fine
	// for our scale (sub-millisecond per entry).
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
			const { iv, ciphertext } = await crypto.encryptWithMaster(outerJson);

			const currentBytes = await storage.readVaultBlob();
			const current = decodeVaultBlob(currentBytes);
			const newBlob = encodeVaultBlob({
				salt: current.salt,
				verifier: current.verifier,
				entriesIv: base64ToBytes(iv),
				entriesCiphertext: base64ToBytes(ciphertext),
			});
			await storage.writeVaultBlob(newBlob);
		},
		[crypto, storage],
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
