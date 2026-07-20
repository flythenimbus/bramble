import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { SubdomainMatchMode } from "../adapters/autofill";
import type { BiometryType } from "../adapters/biometric";
import { usePlatform } from "../context/PlatformContext";
import {
	decodeVaultBlob,
	type EncryptedEntry,
	encodeVaultBlob,
	findPasswordSlot,
	findRecoverySlots,
	findWebauthnSlots,
	type PasswordSlot,
	type RecoverySlot,
	SLOT_KIND_WEBAUTHN,
	verifierPrefix,
	type WebauthnSlot,
} from "../vault-format";
import { makeVaultScopedStorage, useVaultRegistry } from "./useVaultRegistry";

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

/**
 * A WebAuthn passkey (discoverable credential) Bramble hosts for a relying party
 * in its authenticator role. Stored on the login for the same site; `privateKey`
 * rides the entry's existing DEK-under-VEK encryption like any other field. This
 * is the provider direction (other sites sign in with it), the opposite of the
 * security-key unlock in `vault/webauthn-ceremony.ts`. See docs/passkey-provider.md.
 */
export interface PasskeyCredential {
	/** Base64url random credential id Bramble minted at creation. */
	credentialId: string;
	/** Relying-party id, e.g. "github.com". Matched against hostnames. */
	rpId: string;
	rpName?: string;
	/** Base64url `user.id` from the RP. Required for discoverable credentials. */
	userHandle: string;
	userName?: string;
	userDisplayName?: string;
	/** COSE algorithm identifier; -7 (ES256) by default. */
	alg: number;
	/** Base64url COSE_Key public key the RP verifies against. */
	publicKeyCose: string;
	/** Base64url PKCS#8 private key. Encrypted at rest with the rest of the entry. */
	privateKey: string;
	/** Always 0: synced passkeys must not increment (a regression reads as a clone). */
	signCount: number;
	createdAt: number;
	lastUsedAt?: number;
}

interface BaseEntryData {
	name: string;
	notes?: string;
	customFields?: CustomField[];
	/** Epoch ms the entry was created; backfilled on next edit for legacy entries. */
	createdAt?: number;
	/** Epoch ms of the last edit (not bumped by a use). */
	updatedAt?: number;
	/** Epoch ms of the last use (copy/fill); absent until first used. */
	lastUsedAt?: number;
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
	/** Passkeys Bramble hosts for this site, in its authenticator role. */
	passkeys?: PasskeyCredential[];
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

/** How a joining device unlocks its rebuilt vault: a master password or a security key. */
export type JoinUnlock =
	| { kind: "password"; password: string }
	| { kind: "securityKey"; label?: string };

/** Re-auth for deleting a vault: the master password, or a security-key tap. */
export type DeleteVaultAuth = { password: string } | { securityKey: true };

import {
	DEVICE_ID_KEY,
	decodeEntriesPayload,
	decodePairingCode,
	type EntriesPayload,
	emptyEntriesPayload,
	ensureDeviceId,
	type Hlc,
	type HybridClock,
	makeClock,
} from "../sync";
import { syncKeyFor } from "../sync/sync-keys";
import { base64ToBytes, bytesToBase64 } from "../util/bytes";
import { toAutofillIndex } from "../vault/autofill-index";
import { biometricUnlockFlow, enableBiometricUnlock } from "../vault/biometric-unlock";
import {
	wrapPasswordSlot as buildPasswordSlot,
	wrapRecoverySlot as buildRecoverySlot,
	buildVaultBytes,
} from "../vault/build-vault";
import { createEntryMutations, type VaultEntries } from "../vault/entry-mutations";
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
import { createPrfCredential, getPrfSecret } from "../vault/webauthn-ceremony";
import { useSyncEnrollment } from "./useSyncEnrollment";

export { entryDataSchema };

export interface SecurityKeyMeta {
	slotIdB64: string;
	label: string;
	addedAt: number;
}

const SECURITY_KEY_LABELS_PREF = "pref.securityKeyLabels";

/** Reactive vault state. A change here re-renders components that read it. */
export interface VaultState {
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
	/** A setup-flow join is in progress (created a new vault, now pairing into it). */
	joining: boolean;
	/** The last setup-flow join failure (e.g. password mismatch), or null. */
	joinError: string | null;
	entries: Entry[];
	error: string | null;
	/** A vault exists on disk but its blob couldn't be read/decoded; null when readable. */
	vaultError: string | null;
	/** Platform exposes a device-local biometric gate (mobile). Gates the biometric UI entirely. */
	biometricSupported: boolean;
	/** Biometric hardware is present and enrolled, so enabling can be offered. */
	biometricAvailable: boolean;
	/** A VEK is cached behind the biometric gate on this device. */
	biometricEnabled: boolean;
	/** Enrolled modality, for labelling the unlock UI (Face ID vs Touch ID). */
	biometryType: BiometryType;
}

/** Vault actions. Referentially stable for the provider's lifetime. */
export interface VaultActions {
	unlock(password: string): Promise<void>;
	lock(): Promise<void>;
	/** Creates a new vault (parallel to any existing ones) and returns its initial plaintext recovery code (shown once). */
	createVault(password: string, label?: string): Promise<string>;
	/**
	 * Delete the active vault after re-auth (master password, or a security-key tap). This is the
	 * only in-app path that erases a vault's blob: it re-verifies, then erases the bytes and forgets
	 * the record. Returns false if the credential is wrong (nothing is deleted); throws if the
	 * security-key ceremony errors.
	 */
	deleteVault(auth: DeleteVaultAuth): Promise<boolean>;
	/** Save an encrypted `.bramble` backup of the vault. Rejects where the platform can't save files. */
	exportVault(): Promise<void>;
	addEntry(data: EntryData): Promise<void>;
	importEntries(items: EntryData[]): Promise<void>;
	updateEntry(id: string, data: EntryData): Promise<void>;
	deleteEntry(id: string): Promise<void>;
	/** Record a use (copy/fill): bumps only the entry's `lastUsedAt`. */
	touchEntry(id: string): Promise<void>;
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
	/** Cache the in-memory VEK behind the device biometric gate. Requires the vault unlocked. */
	enableBiometric(): Promise<void>;
	/** Forget the device's biometric-cached VEK. */
	disableBiometric(): Promise<void>;
	/** Biometric-prompt, unwrap the cached VEK, and unlock. Disables itself if the cache is stale. */
	unlockWithBiometric(): Promise<void>;
	/** Re-probe biometric availability + enabled (e.g. when Settings opens). */
	refreshBiometric(): Promise<void>;
	/** Start adding a device: returns a one-time pairing code and listens for the joiner. `password`
	 * is the re-entered master password (Item A) that admission-signs the joiner; omit it (or pass it
	 * for a security-key-only vault, where it's ignored) to enroll without an admission signature. */
	inviteDevice(relayUrl: string, iceUrl?: string, password?: string): Promise<string>;
	/** Join an existing group from a pairing code; rebuilds this device's vault under the chosen unlock method. */
	joinGroup(pairingCode: string, unlock: JoinUnlock): Promise<void>;
	/** Setup-flow join: create a NEW vault from a pairing code (dedups to an existing vault if already
	 * a member), then run the join in that vault's context and unlock into it. Resolves when the join
	 * completes. Drives `joining` / `joinError`. See docs/multiple-vaults.md. */
	startJoin(pairingCode: string, unlock: JoinUnlock): Promise<void>;
	/** Revoke a device from the sync group (roster tombstone); propagates over ongoing sync. */
	removeDevice(deviceId: string): Promise<void>;
}

/** The full vault API: reactive state plus actions. */
export interface UseVault extends VaultState, VaultActions {}

// State and actions ride separate contexts so a pure-action consumer (useVaultActions)
// never re-renders on a state change, and the state value carries only state deps.
const VaultStateContext = createContext<VaultState | null>(null);
const VaultActionsContext = createContext<VaultActions | null>(null);

export function VaultProvider({ children }: { children: ReactNode }) {
	const {
		storage: platformStorage,
		crypto: platformCrypto,
		autofill,
		shell,
		biometric,
	} = usePlatform();
	// The app operates on one vault at a time; bind its id so this provider's blob reads and
	// writes address the active vault. Metadata stays device-global. See useVaultRegistry.
	const {
		activeId,
		ready: registryReady,
		vaults,
		syncKey,
		createRecord,
		dropActiveRecord,
		selectVault,
		refresh: refreshRegistry,
	} = useVaultRegistry();
	const storage = useMemo(
		() => makeVaultScopedStorage(platformStorage, activeId),
		[platformStorage, activeId],
	);
	// Scope crypto to the active vault the same way storage is scoped, so every VEK-scoped op
	// targets the right vault's key in the background's per-vault map. createVault binds
	// explicitly to the NEW id (below), since the active id lags a fresh vault by a render.
	// See docs/multiple-vaults.md "The scoped view adapter, and the create/join binding trap".
	const crypto = useMemo(
		() => (activeId ? (platformCrypto.withVault?.(activeId) ?? platformCrypto) : platformCrypto),
		[platformCrypto, activeId],
	);
	const [hasVault, setHasVault] = useState(false);
	const [isLocked, setIsLocked] = useState(true);
	// Device-local biometric gate (mobile). `available` = hardware present + enrolled;
	// `enabled` = a VEK is cached behind it on this device.
	const [biometricAvailable, setBiometricAvailable] = useState(false);
	const [biometricEnabled, setBiometricEnabled] = useState(false);
	const [biometryType, setBiometryType] = useState<BiometryType>("biometric");
	const [ready, setReady] = useState(false);
	const [entries, setEntries] = useState<Entry[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [webauthnSlots, setWebauthnSlots] = useState<WebauthnSlot[]>([]);
	const [hasPasswordSlot, setHasPasswordSlot] = useState(false);
	const [hasRecoveryCode, setHasRecoveryCode] = useState(false);
	// Set when a vault exists on disk but its blob can't be read/decoded (e.g. an
	// FSA file whose read permission needs a fresh user gesture, or a corrupt blob).
	const [vaultError, setVaultError] = useState<string | null>(null);
	const [securityKeyLabels, setSecurityKeyLabels] = useState<
		Record<string, { label: string; addedAt: number }>
	>({});

	// Latest render's reactive state, mirrored to a ref so action callbacks can read
	// current entries / labels / lock state without listing them as deps. That keeps every
	// action referentially stable (its own context, never re-firing pure-action subscribers).
	// Assigned during render: idempotent, the blessed idiom for a latest-value ref.
	const latestRef = useRef({ entries, securityKeyLabels, isLocked });
	latestRef.current = { entries, securityKeyLabels, isLocked };

	// Sync metadata kept alongside (not on) the user-facing Entry: per-entry HLC
	// stamps and the deletion graveyard. Held in refs because mutations thread
	// the next value explicitly, mirroring the existing entries-rewrite pattern.
	const clockRef = useRef<HybridClock | null>(null);
	const stampsRef = useRef<Map<string, Hlc>>(new Map());
	const tombstonesRef = useRef<Map<string, Hlc>>(new Map());

	/** Lazily load this device's id and build its clock. The device id is per-vault (each vault
	 * is its own sync group with its own roster membership), so read/write it under the active
	 * vault's namespaced key. */
	const ensureClock = useCallback(async (): Promise<HybridClock> => {
		if (!clockRef.current) {
			const id = await ensureDeviceId(
				() => storage.getMeta<string>(syncKey(DEVICE_ID_KEY)),
				(_k, v) => storage.setMeta<string>(syncKey(DEVICE_ID_KEY), v),
			);
			clockRef.current = makeClock(id);
		}
		return clockRef.current;
	}, [storage, syncKey]);

	/** Mint a fresh device id for a (re)join. A device id is stable and persisted, and a tombstoned id
	 * stays dead forever (sticky revocation, B1) — so a device re-added after being revoked must NOT
	 * reuse its old id, or the group's tombstone drops its entry everywhere (it can't see itself and
	 * peers can't see it). Clearing the id + cached clock makes the next ensureClock() generate a new
	 * one, so the joiner enters as a genuinely new member. See docs/p2p-sync-revocation-hardening.md. */
	const rotateDeviceId = useCallback(async (): Promise<void> => {
		await storage.removeMeta(syncKey(DEVICE_ID_KEY));
		clockRef.current = null;
	}, [storage, syncKey]);

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
			setVaultError(null);
		} catch (e) {
			// Don't swallow: a vault that exists but can't be read must surface, not
			// silently degrade to a passwordless/security-key-only unlock screen.
			console.error("[vault] could not read vault for slot metadata:", e);
			setWebauthnSlots([]);
			setHasPasswordSlot(false);
			setHasRecoveryCode(false);
			setSecurityKeyLabels({});
			setVaultError((e as Error).message);
		}
	}, [readDecodedBlob, storage]);

	/** Decrypt all entries and push the autofill index. */
	const loadEntries = useCallback(async () => {
		const { blob } = await readDecodedBlob();
		if (blob.entriesCiphertext.length === 0) {
			stampsRef.current = new Map();
			tombstonesRef.current = new Map();
			setEntries([]);
			await autofill.setIndex([]);
			return;
		}
		const outerJson = await crypto.decryptWithVek(
			bytesToBase64(blob.entriesIv),
			bytesToBase64(blob.entriesCiphertext),
		);
		// The blob decrypted, so the key is right; a decode failure here means the
		// payload shape is from an incompatible (older) format. Surface an actionable
		// message instead of leaking raw decoder/zod internals to the unlock screen.
		let payload: EntriesPayload;
		try {
			payload = decodeEntriesPayload(outerJson);
		} catch (e) {
			console.error("[vault] entries payload failed to decode:", e);
			throw new Error(
				"This vault was created by an incompatible version and can't be opened. Its data format has changed.",
			);
		}
		stampsRef.current = new Map(payload.entries.map((e) => [e.id, e.hlc]));
		tombstonesRef.current = new Map(payload.tombstones.map((t) => [t.id, t.hlc]));
		// Advance this device's clock past every stamp it just read, so the next
		// local write is causally ordered after them.
		const clock = await ensureClock();
		for (const e of payload.entries) clock.witness(e.hlc);
		for (const t of payload.tombstones) clock.witness(t.hlc);
		// One decrypt call for the whole vault: on the extension that is a single
		// offscreen round-trip instead of one per entry (~1s -> a fraction on large
		// vaults). Plaintexts come back in the same order as the entries.
		const plaintexts = await crypto.decryptEntries(
			payload.entries.map((enc) => ({
				ciphertext: enc.ciphertext,
				iv: enc.iv,
				wrappedDek: enc.wrappedDek,
				dekIv: enc.dekIv,
			})),
		);
		const decrypted: Entry[] = payload.entries.map((enc, i) => {
			const data = normalizeEntryData(JSON.parse(plaintexts[i] as string));
			return { id: enc.id, ...data };
		});
		setEntries(decrypted);
		await autofill.setIndex(toAutofillIndex(decrypted));
	}, [readDecodedBlob, crypto, autofill, ensureClock]);

	// On mount (and when the active vault resolves): detect an existing vault handle and
	// whether crypto is already unlocked (popup reopened mid-session). Waits for the registry
	// so `storage` is bound to the active vault before the first detect.
	useEffect(() => {
		if (!registryReady) return;
		let cancelled = false;
		void (async () => {
			try {
				const has = await storage.hasVaultHandle();
				if (cancelled) return;
				setHasVault(has);
				if (!has) return;

				// A pre-namespacing vault is registered lazily by the storage migration that
				// hasVaultHandle just ran. If the registry was still empty when useVaultRegistry read it
				// (a released single-vault user: flat blob, no registry), re-read it now so the vault is
				// selected and `storage`/`crypto` re-bind to its id - otherwise the unlock is mis-scoped.
				// The re-read flips `activeId`, which re-runs this effect with the right scoping.
				if (vaults.length === 0) {
					await refreshRegistry();
					return;
				}

				await refreshSlotMetadata();

				const locked = await crypto.isLocked();
				if (cancelled) return;
				setIsLocked(locked);
				if (locked) return;

				try {
					await loadEntries();
				} catch (e) {
					// Reading the vault failed while unlocked (commonly an FSA file whose
					// read permission needs a gesture on popup reopen). Fall back to the
					// unlock screen, where the unlock click re-grants access, instead of
					// showing a misleading empty list.
					console.error("[vault] loadEntries failed on mount; showing unlock screen:", e);
					if (!cancelled) setIsLocked(true);
					return;
				}
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
	}, [
		registryReady,
		storage,
		crypto,
		loadEntries,
		shell,
		refreshSlotMetadata,
		vaults.length,
		refreshRegistry,
	]);

	// Record which vault is unlocked so the background can target it for sync and a reopened popup
	// can restore it. Only WRITE it while unlocked; never clear it here. The background clears it on
	// lock (clearSession). Clearing it on the initially-locked mount (isLocked starts true, before
	// the VEK hydrates) would wipe the id before useVaultRegistry can restore it, dropping a
	// reopened popup onto the picker instead of the unlocked vault. No-op on mobile (setActiveVault
	// is absent there).
	useEffect(() => {
		if (!isLocked && activeId) void shell.setActiveVault?.(activeId);
	}, [isLocked, activeId, shell]);

	// Reflect a background-initiated lock (auto-lock alarm): drop decrypted state
	// so the guard redirects to the unlock screen.
	useEffect(() => {
		return crypto.onExternalLock(() => {
			stampsRef.current = new Map();
			tombstonesRef.current = new Map();
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
			// Record the active vault BEFORE the unwrap: the background starts sync the moment the
			// unwrap succeeds (session.ts cryptoHandler), and reads this to pick which vault to sync.
			// Awaited so the write lands first; otherwise the first sync targets the previous vault.
			await shell.setActiveVault?.(activeId ?? null);
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
		[readDecodedBlob, crypto, loadEntries, shell, activeId],
	);

	/** Lock the vault: clear the VEK, autofill index, and decrypted state. */
	const lock = useCallback(async () => {
		await crypto.lock();
		await autofill.clearIndex();
		stampsRef.current = new Map();
		tombstonesRef.current = new Map();
		setEntries([]);
		setIsLocked(true);
	}, [crypto, autofill]);

	/** Run a get() assertion over the given slots, returning the PRF secret. */
	// Slot wrapping lives in vault/build-vault (shared with device enrollment); these
	// bind the CryptoAdapter and keep the recovery-code normalization at the edge.
	const wrapPasswordSlot = useCallback(
		(password: string): Promise<PasswordSlot> => buildPasswordSlot(crypto, password),
		[crypto],
	);
	const wrapRecoverySlot = useCallback(
		(code: string): Promise<RecoverySlot> => buildRecoverySlot(crypto, normalizeRecoveryCode(code)),
		[crypto],
	);

	// Finish a security-key unlock once the PRF secret is in hand (from a tap, or from
	// the create() ceremony at security-key enrollment): unwrap the VEK, mark unlocked.
	const finishWebauthnUnlock = useCallback(
		async (slot: WebauthnSlot, hmacSecret: Uint8Array): Promise<void> => {
			// See unlock(): record the active vault before the unwrap so sync-on-unlock targets it.
			await shell.setActiveVault?.(activeId ?? null);
			const ok = await crypto.unwrapVekWebauthn({
				hmacSecretB64: bytesToBase64(hmacSecret),
				slotIdB64: bytesToBase64(slot.slotId),
				verifierB64: bytesToBase64(slot.verifier),
				wrapIvB64: bytesToBase64(slot.wrapIv),
				wrappedVekB64: bytesToBase64(slot.wrappedVek),
				magicVersion: verifierPrefix(),
			});
			if (!ok) throw new Error("Security-key unlock failed (verifier mismatch).");
			await loadEntries();
			setIsLocked(false);
			void shell.flushPendingCornerCapture().catch(() => {});
		},
		[crypto, loadEntries, shell, activeId],
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
		const firstAttempt = await getPrfSecret(slots, firstSalt);
		let used = matchSlotByCredentialId(slots, firstAttempt.rawId);
		if (!used) {
			throw new Error("Authenticator returned an unknown credential.");
		}
		let hmacSecret = firstAttempt.hmacSecret;
		if (needsSaltMismatchRetry(used, firstSalt)) {
			const second = await getPrfSecret([used], used.salt);
			used = matchSlotByCredentialId([used], second.rawId);
			if (!used) throw new Error("Authenticator returned an unknown credential.");
			hmacSecret = second.hmacSecret;
		}

		await finishWebauthnUnlock(used, hmacSecret);
	}, [readDecodedBlob, finishWebauthnUnlock]);

	/**
	 * Prove possession of a registered key (a tap) without touching lock state.
	 * Authorizes sensitive actions on a password-less vault.
	 */
	const verifyWithSecurityKey = useCallback(async (): Promise<boolean> => {
		const { blob } = await readDecodedBlob();
		const slots = findWebauthnSlots(blob);
		if (slots.length === 0) return false;
		try {
			const attempt = await getPrfSecret(slots, slots[0]!.salt);
			return matchSlotByCredentialId(slots, attempt.rawId) !== null;
		} catch {
			return false;
		}
	}, [readDecodedBlob]);

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

			const { credentialId, salt, hmacSecret } = await createPrfCredential(label);

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

			const labels = { ...latestRef.current.securityKeyLabels };
			labels[slotIdB64] = { label: label.trim() || "Security key", addedAt: Date.now() };
			await storage.setMeta(SECURITY_KEY_LABELS_PREF, labels);

			await refreshSlotMetadata();
		},
		[crypto, readDecodedBlob, storage, refreshSlotMetadata],
	);

	/** Remove a security-key slot and its stored label. */
	const revokeSecurityKey = useCallback(
		async (slotIdB64: string) => {
			setError(null);
			const { blob } = await readDecodedBlob();
			const newBlob = removeWebauthnSlot(blob, base64ToBytes(slotIdB64));
			await storage.writeVaultBlob(encodeVaultBlob(newBlob));
			const labels = { ...latestRef.current.securityKeyLabels };
			delete labels[slotIdB64];
			await storage.setMeta(SECURITY_KEY_LABELS_PREF, labels);
			await refreshSlotMetadata();
		},
		[readDecodedBlob, storage, refreshSlotMetadata],
	);

	/** Create a new vault (parallel to any existing ones) with a password slot and an initial recovery slot. */
	const createVault = useCallback(
		async (password: string, label = ""): Promise<string> => {
			setError(null);
			const isFirst = vaults.length === 0;
			// Register the new vault first so its blob is written under its own id, then selected.
			const newId = await createRecord(label);
			// Only the first vault on a device resets sync identity (a clean slate); creating an
			// additional vault must not disturb an existing vault's sync state. Sync state is still
			// device-global until Phase 2 namespaces it per vault. See docs/multiple-vaults.md.
			if (isFirst) await shell.resetSyncState?.();
			// Bind crypto to the NEW vault id explicitly. The ambient `crypto` is still memoized to
			// the previous active id (createRecord only just set the new one via React state), so
			// using it would cache the new vault's VEK under the old id and re-open the original
			// corruption. See docs/multiple-vaults.md "the create/join binding trap".
			const bound = platformCrypto.withVault?.(newId) ?? platformCrypto;
			await bound.generateVek();
			const passwordSlot = await buildPasswordSlot(bound, password);
			const code = makeRecoveryCode();
			const recoverySlot = await buildRecoverySlot(bound, normalizeRecoveryCode(code));
			const bytes = await buildVaultBytes(
				bound,
				[passwordSlot, recoverySlot],
				emptyEntriesPayload(),
			);
			await storage.writeVaultBlob(bytes, newId);
			stampsRef.current = new Map();
			tombstonesRef.current = new Map();
			setHasVault(true);
			setEntries([]);
			setIsLocked(false);
			// Slot metadata + entries are (re)loaded by the mount effect when it re-runs for the
			// newly selected active id, reading via storage rebound to the new vault.
			return code;
		},
		[vaults, createRecord, shell, storage, platformCrypto],
	);

	/** Download an encrypted backup of the vault as a `.bramble` file (the encrypted VLT1
	 * blob, so it is safe at rest and still needs the master password to open). */
	const exportVault = useCallback(async () => {
		if (!shell.exportBytes) throw new Error("Export isn't available here.");
		const bytes = await storage.readVaultBlob();
		const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
		await shell.exportBytes(`bramble-vault-${stamp}.bramble`, bytes, "application/octet-stream");
	}, [shell, storage]);

	/** Re-encrypt all entries with their stamps plus the tombstone list, and write
	 * a new blob; the slot list is unchanged. Stamps come from the caller so a
	 * full rewrite does not re-stamp unchanged entries. */
	// Local entry changes (add/import/update/delete) live behind their own seam:
	// each is a transition that persists and returns the next state, which we
	// commit here. The shared persist primitives also back the sync-enrollment hook.
	const mutations = useMemo(
		() => createEntryMutations({ crypto, storage, autofill, readDecodedBlob, clock: ensureClock }),
		[crypto, storage, autofill, readDecodedBlob, ensureClock],
	);

	// Snapshot the current entry state (latest entries + the stamp/tombstone refs).
	// Reads entries from latestRef so the callback stays stable across entry changes.
	const snapshotEntries = useCallback(
		(): VaultEntries => ({
			entries: latestRef.current.entries,
			stamps: stampsRef.current,
			tombstones: tombstonesRef.current,
		}),
		[],
	);

	// Commit a mutation's next state. Only ever runs after a successful persist,
	// so a failed write leaves entries + refs untouched.
	const commitEntries = useCallback((next: VaultEntries) => {
		stampsRef.current = next.stamps;
		tombstonesRef.current = next.tombstones;
		setEntries(next.entries);
	}, []);

	const addEntry = useCallback(
		async (data: EntryData) => commitEntries(await mutations.add(snapshotEntries(), data)),
		[mutations, snapshotEntries, commitEntries],
	);
	const importEntries = useCallback(
		async (items: EntryData[]) =>
			commitEntries(await mutations.importMany(snapshotEntries(), items)),
		[mutations, snapshotEntries, commitEntries],
	);
	const updateEntry = useCallback(
		async (id: string, data: EntryData) =>
			commitEntries(await mutations.update(snapshotEntries(), id, data)),
		[mutations, snapshotEntries, commitEntries],
	);
	const deleteEntry = useCallback(
		async (id: string) => commitEntries(await mutations.remove(snapshotEntries(), id)),
		[mutations, snapshotEntries, commitEntries],
	);
	const touchEntry = useCallback(
		async (id: string) => commitEntries(await mutations.touch(snapshotEntries(), id)),
		[mutations, snapshotEntries, commitEntries],
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
			// See unlock(): record the active vault before the unwrap so sync-on-unlock targets it.
			await shell.setActiveVault?.(activeId ?? null);
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
		[readDecodedBlob, crypto, loadEntries, shell, activeId],
	);

	// Re-probe the gate's availability + enabled state. Called on mount and whenever the
	// Settings screen opens, so enrolling Face ID / a fingerprint after launch is picked
	// up without a relaunch. Enable/disable update the flags directly too.
	const refreshBiometric = useCallback(async () => {
		if (!biometric) return;
		try {
			const [available, enabled, type] = await Promise.all([
				biometric.isAvailable(),
				// Biometric is keyed per vault; without a selected vault there's nothing to probe.
				activeId ? biometric.isEnabled(activeId) : Promise.resolve(false),
				biometric.biometryType?.() ?? Promise.resolve<BiometryType>("biometric"),
			]);
			setBiometricAvailable(available);
			setBiometricEnabled(enabled);
			setBiometryType(type);
		} catch (e) {
			console.error("[vault] biometric state probe failed:", e);
		}
	}, [biometric, activeId]);

	useEffect(() => {
		void refreshBiometric();
	}, [refreshBiometric]);

	/** Cache the in-memory VEK behind the device biometric gate. Requires the vault unlocked. */
	const enableBiometric = useCallback(async () => {
		if (!biometric) throw new Error("Biometric unlock isn't available on this device.");
		if (latestRef.current.isLocked)
			throw new Error("Unlock the vault before enabling biometric unlock.");
		if (!activeId) throw new Error("No vault is selected.");
		await enableBiometricUnlock(crypto, biometric, activeId);
		setBiometricEnabled(true);
	}, [biometric, crypto, activeId]);

	/** Forget this vault's biometric-cached VEK. */
	const disableBiometric = useCallback(async () => {
		if (!biometric || !activeId) return;
		await biometric.disable(activeId);
		setBiometricEnabled(false);
	}, [biometric, activeId]);

	/** Biometric-prompt, unwrap the cached VEK, and unlock. A stale cache (the VEK no
	 * longer decrypts this vault, e.g. after a reset) disables itself and surfaces a
	 * fall-back-to-password error. */
	const unlockWithBiometric = useCallback(async () => {
		if (!biometric) throw new Error("Biometric unlock isn't available on this device.");
		if (!activeId) throw new Error("No vault is selected.");
		setError(null);
		await biometricUnlockFlow({
			crypto,
			biometric,
			vaultId: activeId,
			loadEntries,
			onStaleCache: () => setBiometricEnabled(false),
		});
		setIsLocked(false);
		void shell.flushPendingCornerCapture().catch(() => {});
	}, [biometric, crypto, loadEntries, shell, activeId]);

	// Device enrollment lives in its own hook; it consumes the shared clock, blob
	// read, unlock, and entries-payload read from here.
	const { inviteDevice, joinGroup, removeDevice } = useSyncEnrollment({
		storage,
		syncKey,
		ensureClock,
		rotateDeviceId,
		readDecodedBlob,
		unlock,
		finishWebauthnUnlock,
		readEntriesPayload: mutations.readEntriesPayload,
	});

	// Setup-flow join: create a NEW vault from a pairing code, then run joinGroup in that vault's
	// context. The join's device identity + blob are active-vault-scoped, so the new vault must be
	// active before joinGroup runs; and the joinGroup captured here still holds the previous active
	// id (the per-vault VEK binding trap), so we defer to an effect that fires once the new vault is
	// active and joinGroup has rebound to it. See docs/multiple-vaults.md.
	const [pendingJoin, setPendingJoin] = useState<{
		code: string;
		method: JoinUnlock;
		targetId: string;
	} | null>(null);
	const [joinError, setJoinError] = useState<string | null>(null);
	const joinResolverRef = useRef<{ resolve: () => void; reject: (e: unknown) => void } | null>(
		null,
	);
	const joinRunningRef = useRef(false);

	const startJoin = useCallback(
		async (pairingCode: string, method: JoinUnlock): Promise<void> => {
			setJoinError(null);
			const code = decodePairingCode(pairingCode.trim()); // validate before creating anything
			// Dedup: if a vault already syncs this group, open it instead of adding a duplicate.
			for (const v of vaults) {
				const g = await storage.getMeta<{ groupKey?: string }>(syncKeyFor("sync.group", v.id));
				if (g?.groupKey === code.groupKey) {
					selectVault(v.id);
					return;
				}
			}
			const newId = await createRecord();
			await shell.setActiveVault?.(newId);
			return new Promise<void>((resolve, reject) => {
				joinResolverRef.current = { resolve, reject };
				setPendingJoin({ code: pairingCode, method, targetId: newId });
			});
		},
		[vaults, storage, createRecord, shell, selectVault],
	);

	// Run the deferred join once the new vault is active (joinGroup is now scoped to it). One-shot.
	useEffect(() => {
		if (
			!pendingJoin ||
			activeId !== pendingJoin.targetId ||
			!registryReady ||
			joinRunningRef.current
		)
			return;
		joinRunningRef.current = true;
		const { code, method } = pendingJoin;
		void (async () => {
			try {
				await joinGroup(code, method); // writes + unlocks the new active vault
				setHasVault(true);
				setPendingJoin(null);
				joinResolverRef.current?.resolve();
			} catch (e) {
				await dropActiveRecord().catch(() => {}); // remove the orphan empty vault
				setPendingJoin(null);
				setJoinError((e as Error).message ?? String(e));
				joinResolverRef.current?.reject(e);
			} finally {
				joinRunningRef.current = false;
				joinResolverRef.current = null;
			}
		})();
	}, [pendingJoin, activeId, registryReady, joinGroup, dropActiveRecord]);

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

	const state = useMemo<VaultState>(
		() => ({
			hasVault,
			isLocked,
			ready,
			joining: pendingJoin !== null,
			joinError,
			entries,
			error,
			vaultError,
			hasWebauthnSlot,
			hasPasswordSlot,
			hasRecoveryCode,
			securityKeys,
			biometricSupported: biometric !== undefined,
			biometricAvailable,
			biometricEnabled,
			biometryType,
		}),
		[
			hasVault,
			isLocked,
			ready,
			pendingJoin,
			joinError,
			entries,
			error,
			vaultError,
			hasWebauthnSlot,
			hasPasswordSlot,
			hasRecoveryCode,
			securityKeys,
			biometric,
			biometricAvailable,
			biometricEnabled,
			biometryType,
		],
	);

	/** Delete the active vault after re-auth. The single in-app path that erases a vault's blob:
	 * verification and deletion are inseparable here, so no caller can delete without re-authing. */
	const deleteVault = useCallback(
		async (auth: DeleteVaultAuth): Promise<boolean> => {
			const ok =
				"password" in auth
					? await verifyMasterPassword(auth.password)
					: await verifyWithSecurityKey();
			if (!ok || !activeId) return false;
			await lock();
			// The only place a vault's (encrypted) bytes are erased, gated on the re-auth above.
			await storage.deleteVaultBlob(activeId).catch(() => {});
			await dropActiveRecord();
			return true;
		},
		[verifyMasterPassword, verifyWithSecurityKey, activeId, lock, storage, dropActiveRecord],
	);

	// Every action is referentially stable (state reads route through latestRef), so this
	// memo builds once: the actions value never changes and useVaultActions never re-renders.
	const actions = useMemo<VaultActions>(
		() => ({
			unlock,
			lock,
			createVault,
			deleteVault,
			exportVault,
			addEntry,
			importEntries,
			updateEntry,
			deleteEntry,
			touchEntry,
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
			enableBiometric,
			disableBiometric,
			unlockWithBiometric,
			refreshBiometric,
			inviteDevice,
			joinGroup,
			startJoin,
			removeDevice,
		}),
		[
			unlock,
			lock,
			createVault,
			deleteVault,
			exportVault,
			addEntry,
			importEntries,
			updateEntry,
			deleteEntry,
			touchEntry,
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
			enableBiometric,
			disableBiometric,
			unlockWithBiometric,
			refreshBiometric,
			inviteDevice,
			joinGroup,
			startJoin,
			removeDevice,
		],
	);

	return (
		<VaultActionsContext.Provider value={actions}>
			<VaultStateContext.Provider value={state}>{children}</VaultStateContext.Provider>
		</VaultActionsContext.Provider>
	);
}

/** Access the reactive vault state (entries, lock status, slot + biometric flags). */
export function useVaultState(): VaultState {
	const ctx = useContext(VaultStateContext);
	if (!ctx) throw new Error("useVaultState called outside VaultProvider");
	return ctx;
}

/**
 * Access the vault actions. Stable for the provider's lifetime, so a component that reads
 * only actions (not state) via this hook won't re-render when vault state changes.
 */
export function useVaultActions(): VaultActions {
	const ctx = useContext(VaultActionsContext);
	if (!ctx) throw new Error("useVaultActions called outside VaultProvider");
	return ctx;
}

/**
 * Access the full vault API (state + actions). Prefer useVaultState / useVaultActions when
 * a component needs only one half. Must be called inside a VaultProvider.
 */
export function useVault(): UseVault {
	return { ...useVaultState(), ...useVaultActions() };
}

export type { EncryptedEntry };
