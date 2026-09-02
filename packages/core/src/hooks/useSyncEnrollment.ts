import { useCallback, useRef } from "react";
import type { ShellAdapter } from "../adapters/shell";
import type { StorageAdapter } from "../adapters/storage";
import { usePlatform } from "../context/PlatformContext";
import {
	addDevice,
	canonicalRosterEntry,
	decodePairingCode,
	type EntriesPayload,
	emptyRoster,
	encodePairingCode,
	type HybridClock,
	INVITE_TTL_MS,
	pairingCodeExpired,
	type RosterEntry,
	RosterEntrySchema,
	type RosterPayload,
	randomKeyB64,
	revokeDevice,
	signRosterEntry,
} from "../sync";
import { base64ToBytes, bytesToBase64 } from "../util/bytes";
import { defaultDeviceLabel } from "../util/device-label";
import { createPrfCredential } from "../vault/webauthn-ceremony";
import {
	findPasswordSlot,
	findRecoverySlots,
	findWebauthnSlots,
	type PasswordSlot,
	type VaultBlob,
	type WebauthnSlot,
} from "../vault-format";
import type { JoinUnlock, UseVault } from "./useVault";

/** Sign this device's own roster entry when the host is signing-capable (Item A); otherwise return
 * it unsigned (verify-if-present tolerates that during the phase-1 rollout). */
async function signOwnEntry(shell: ShellAdapter, entry: RosterEntry): Promise<RosterEntry> {
	if (!shell.syncSigningPublicKey || !shell.signRoster) return entry;
	const sigKey = await shell.syncSigningPublicKey();
	return signRosterEntry(entry, sigKey, shell.signRoster);
}

/** What the inviter needs, after re-entering the master password, to admission-sign a joiner's entry
 * (Item A rogue-injection close): the password + this device's password-slot salt (to re-derive the
 * admission signing key transiently) and this device's id (the `admission.by`). Held only for the
 * duration of one invite. Null when the device can't admit (security-key-only, or host without
 * password-authority admission). See docs/p2p-sync-revocation-hardening.md. */
interface AdmissionContext {
	password: string;
	saltB64: string;
	adminId: string;
}

/** Attach an `admission` (this device's password-derived signature over the joiner's canonical entry)
 * so peers can verify a NEW id was admitted by a live member. No-op when the inviter can't admit;
 * the entry is then tolerated only through the phase-1 rollout. */
async function admissionSign(
	shell: ShellAdapter,
	admit: AdmissionContext | null,
	entry: RosterEntry,
): Promise<RosterEntry> {
	if (!admit || !shell.syncAdmissionSign) return entry;
	const sig = await shell.syncAdmissionSign(
		admit.password,
		admit.saltB64,
		canonicalRosterEntry(entry),
	);
	return { ...entry, admission: { by: admit.adminId, sig } };
}

/** Shared vault internals the enrollment ops need from VaultProvider. */
export interface SyncEnrollmentDeps {
	/** Storage bound to the active vault: its blob methods address the active vault, and its
	 * metadata passes through. Combined with `syncKey`, that scopes enrollment to the active vault. */
	storage: StorageAdapter;
	/** Namespace a flat sync key (e.g. `syncKey("sync.group")`) to the active vault. See useVaultRegistry. */
	syncKey: (flatKey: string) => string;
	ensureClock: () => Promise<HybridClock>;
	/** Mint a fresh device id (clears the persisted id + cached clock). Called before a join so a
	 * re-added device never reuses an id that may be tombstoned in the group (B1). */
	rotateDeviceId: () => Promise<void>;
	readDecodedBlob: () => Promise<{ blob: VaultBlob }>;
	unlock: (password: string) => Promise<void>;
	/** Finish a security-key unlock with an in-hand PRF secret (no extra tap). */
	finishWebauthnUnlock: (slot: WebauthnSlot, hmacSecret: Uint8Array) => Promise<void>;
	/** Decrypt the on-disk entries payload (the inviter ships it in the bundle). */
	readEntriesPayload: () => Promise<EntriesPayload>;
}

type SyncEnrollment = Pick<UseVault, "inviteDevice" | "joinGroup" | "removeDevice"> & {
	/** Phase-1 migration backfill; internal, not part of the public vault API. */
	ensureOwnEntrySigned: () => Promise<void>;
};

/**
 * Device enrollment (create group / invite / join), lifted out of VaultProvider.
 * Owns its enrollment-listener ref; the shared clock, blob read, unlock, and
 * entries-payload read are passed in. See docs/p2p-sync.md.
 */
export function useSyncEnrollment(deps: SyncEnrollmentDeps): SyncEnrollment {
	const {
		storage,
		syncKey,
		ensureClock,
		rotateDeviceId,
		readDecodedBlob,
		unlock,
		finishWebauthnUnlock,
		readEntriesPayload,
	} = deps;
	const { shell } = usePlatform();
	// Unsubscribe for the inviter's enrolled-device listener (adds the joiner to the roster).
	const enrollUnsubRef = useRef<(() => void) | null>(null);

	// The group key is stable (the room + the group identity); generated once with a
	// roster seeded by this device, then reused. This vault's VEK is the group VEK.
	const ensureGroup = useCallback(async (): Promise<string> => {
		const existing = await storage.getMeta<{ groupKey: string }>(syncKey("sync.group"));
		if (existing?.groupKey) return existing.groupKey;
		const inviterPub = await shell.syncDevicePublicKey();
		const clock = await ensureClock();
		const hlc = clock.send();
		const groupKey = randomKeyB64();
		const entry = await signOwnEntry(shell, {
			id: hlc.node,
			publicKey: inviterPub,
			label: shell.deviceLabel?.() ?? defaultDeviceLabel(),
			addedAt: Date.now(),
			hlc,
		});
		const roster = addDevice(emptyRoster(), entry);
		await storage.setMeta(syncKey("sync.group"), { groupKey, roster });
		return groupKey;
	}, [storage, syncKey, shell, ensureClock]);

	/**
	 * Merge an updated own-entry into the stored roster, re-reading it first.
	 *
	 * The read-modify-write window spans a signing round trip to the host, and the background's
	 * roster merge writes the same key. Writing back a snapshot taken before that trip drops
	 * whatever landed in between (a peer's entry, a revocation), since the merge can only keep what
	 * is in one of its two inputs. Re-reading closes all but an instant of that. It does NOT protect
	 * a concurrent change to THIS entry, which is last-writer-wins and needs re-signing over the new
	 * body; see ensureOwnEntrySigned, the one path where that race is worth the extra round trip.
	 */
	const mergeOwnEntry = useCallback(
		async (entry: RosterEntry): Promise<void> => {
			const fresh = await storage.getMeta<{ groupKey: string; roster: RosterPayload }>(
				syncKey("sync.group"),
			);
			if (!fresh) return; // the group went away underneath us (disconnected mid-flight)
			await storage.setMeta(syncKey("sync.group"), {
				groupKey: fresh.groupKey,
				roster: addDevice(fresh.roster, entry),
			});
		},
		[storage, syncKey],
	);

	// Publish this device's admission key on its own roster entry, derived from the re-entered master
	// password + this device's password-slot salt (Item A rogue-injection close), and return the
	// context to admission-sign the joiner. The admissionKey is deterministic from (password, salt),
	// so a repeat invite re-derives the same value and is a no-op. Returns null when this device can't
	// admit: no password re-entered, no password slot (security-key-only), or a host without
	// password-authority admission — the joiner's new id is then tolerated only through phase 1.
	const publishAdmissionKey = useCallback(
		async (
			inviterPub: string,
			password: string | undefined,
			pwSlot: PasswordSlot | null,
		): Promise<AdmissionContext | null> => {
			if (!password || !pwSlot || !shell.syncAdmissionPublicKey || !shell.syncAdmissionSign)
				return null;
			const saltB64 = bytesToBase64(pwSlot.salt);
			const admissionKey = await shell.syncAdmissionPublicKey(password, saltB64);
			const group = await storage.getMeta<{ groupKey: string; roster: RosterPayload }>(
				syncKey("sync.group"),
			);
			const own = group?.roster.devices.find((d) => d.publicKey === inviterPub);
			if (!group || !own) return null;
			// Re-stamp + re-sign our own entry so the added admissionKey wins the merge (the signature
			// covers it via canonicalRosterEntry). Skipped when already published (deterministic key).
			if (own.admissionKey !== admissionKey) {
				const hlc = (await ensureClock()).send();
				const updated = await signOwnEntry(shell, { ...own, admissionKey, hlc });
				await mergeOwnEntry(updated);
			}
			return { password, saltB64, adminId: own.id };
		},
		[shell, storage, syncKey, ensureClock, mergeOwnEntry],
	);

	/**
	 * Backfill this device's roster signature (Item A phase-1 migration). A device enrolled before
	 * signing shipped (2026-07-09) carries an unsigned entry, and nothing else ever re-signs it:
	 * entries are only signed at create/join/invite, so a group that has not paired since stays
	 * unsigned forever and the phase-2 flip would drop its updates. Re-stamp + re-sign once, and let
	 * the ordinary broadcast carry it. Idempotent: a no-op the moment the entry has a `sigKey`.
	 * See docs/p2p-sync-revocation-hardening.md.
	 */
	const ensureOwnEntrySigned = useCallback(async (): Promise<void> => {
		if (!shell.syncSigningPublicKey || !shell.signRoster) return; // host can't sign
		const readGroup = () =>
			storage.getMeta<{ groupKey: string; roster: RosterPayload }>(syncKey("sync.group"));
		// Resolved lazily, AFTER the group check: syncDevicePublicKey generates and persists a Noise
		// keypair when the device has none, so asking eagerly would write sync identity onto every
		// vault that never syncs, on every unlock.
		let pub: string | null = null;
		// Twice, because signing is a round trip to the host and the entry can change under us in
		// that window (an invite publishing an `admissionKey` on this same entry). A signature covers
		// the entry BODY, so a stale body cannot be written back with the new signature grafted on,
		// and the merge is per-entry last-writer-wins, so a fresher read does not save it either:
		// the only correct answer is to sign what is actually there. One retry, then leave it for the
		// next unlock.
		for (let attempt = 0; attempt < 2; attempt++) {
			const group = await readGroup();
			if (!group) return; // not enrolled in a group: nothing to sign
			pub ??= await shell.syncDevicePublicKey();
			const own = group.roster.devices.find((d) => d.publicKey === pub);
			if (!own || own.sigKey) return;
			// Witness before stamping: the clock only ever sees ENTRY stamps (useVault loadEntries),
			// never roster ones, so on a device whose wall clock ran ahead when it enrolled a fresh
			// send() can land BEHIND its own entry. The merge is last-writer-wins, so the unsigned
			// entry would win and the backfill would retry-and-lose on every unlock, invisibly.
			const clock = await ensureClock();
			clock.witness(own.hlc);
			const signed = await signOwnEntry(shell, { ...own, hlc: clock.send() });
			if (!signed.sigKey) return; // host declined to sign; leave the entry as it was
			const fresh = await readGroup();
			const current = fresh?.roster.devices.find((d) => d.publicKey === pub);
			if (!fresh || !current) return;
			if (canonicalRosterEntry(current) === canonicalRosterEntry(own)) {
				await storage.setMeta(syncKey("sync.group"), {
					groupKey: fresh.groupKey,
					roster: addDevice(fresh.roster, signed),
				});
				return;
			}
		}
	}, [shell, storage, syncKey, ensureClock]);

	// Generate a fresh one-time pairing code and start listening for a device to join.
	// The code carries no vault secrets directly, but its PSK is what authenticates a
	// joiner, so anyone holding it while this invite is live can be handed the vault.
	// The invite is short-lived, single-use, and gated on the user confirming the SAS.
	const inviteDevice = useCallback(
		async (relayUrl: string, iceUrl?: string, password?: string): Promise<string> => {
			// Persist + propagate (via the pairing code) both relays so a joiner adopts them.
			await storage.setMeta("sync.relay", relayUrl);
			await storage.setMeta("sync.iceUrl", iceUrl ?? "");
			const groupKey = await ensureGroup();
			const inviterPub = await shell.syncDevicePublicKey();
			const psk = randomKeyB64();
			const entries = await readEntriesPayload();
			const { blob } = await readDecodedBlob();
			// Ship our password-slot verifier so the joiner can PROVE its typed password
			// matches this device's. Omitted when this device unlocks by security key only.
			const pwSlot = findPasswordSlot(blob);
			const passwordCheck = pwSlot
				? {
						saltB64: bytesToBase64(pwSlot.salt),
						slotIdB64: bytesToBase64(pwSlot.slotId),
						verifierB64: bytesToBase64(pwSlot.verifier),
					}
				: undefined;
			// Forward our recovery slot(s) so the joiner shares this group's recovery code (they wrap
			// the same VEK). Empty when this device has no recovery code.
			const recoverySlots = findRecoverySlots(blob).map((s) => ({
				saltB64: bytesToBase64(s.salt),
				slotIdB64: bytesToBase64(s.slotId),
				verifierB64: bytesToBase64(s.verifier),
				wrapIvB64: bytesToBase64(s.wrapIv),
				wrappedVekB64: bytesToBase64(s.wrappedVek),
			}));
			// Publish this device's admission key (from the re-entered password) and keep the context to
			// admission-sign the joiner. Reads the group AFTER this, so `roster` ships the admissionKey.
			const admit = await publishAdmissionKey(inviterPub, password, pwSlot);
			const group = await storage.getMeta<{ roster: RosterPayload }>(syncKey("sync.group"));
			const roster = group?.roster ?? emptyRoster();
			// When the device finishes joining, admission-sign then add its entry to ours (symmetric rosters).
			enrollUnsubRef.current?.();
			enrollUnsubRef.current = shell.onSyncEvent((ev) => {
				if (ev.kind !== "enrolled" || !ev.entryJson) return;
				let entry: RosterEntry;
				try {
					entry = RosterEntrySchema.parse(JSON.parse(ev.entryJson));
				} catch {
					return; // ignore a malformed enrolled-event payload
				}
				void (async () => {
					const admitted = await admissionSign(shell, admit, entry);
					const cur = await storage.getMeta<{ groupKey: string; roster: RosterPayload }>(
						syncKey("sync.group"),
					);
					if (!cur) return;
					await storage.setMeta(syncKey("sync.group"), {
						groupKey: cur.groupKey,
						roster: addDevice(cur.roster, admitted),
					});
					enrollUnsubRef.current?.();
					enrollUnsubRef.current = null;
				})();
			});
			// Stamped BEFORE the host arms its own timer, so the deadline the joiner and the UI
			// count down to always falls at or before the inviter's local one. Never after: the
			// window shown must not outlive the window enforced.
			const exp = Date.now() + INVITE_TTL_MS;
			await shell.startEnrollInvite({
				relayUrl,
				iceUrl,
				groupKeyB64: groupKey,
				psk,
				roster,
				entries,
				passwordCheck,
				recoverySlots,
				// Let the sync HOST admission-sign + roster the joiner itself; the enrolled-event handler
				// above does the same, but the host is reliable when the popup has closed (Firefox).
				admission: admit ?? undefined,
			});
			// Omit iceUrl from the code when empty (the joiner then derives it from the relay).
			return encodePairingCode({
				v: 1,
				groupKey,
				inviterPub,
				psk,
				relay: relayUrl,
				iceUrl: iceUrl || undefined,
				exp,
			});
		},
		[
			ensureGroup,
			shell,
			storage,
			syncKey,
			readEntriesPayload,
			readDecodedBlob,
			publishAdmissionKey,
		],
	);

	// Join from a pairing code: the offscreen runs the handshake and rebuilds the
	// vault around the shared VEK, then hands back the (VEK-wrapped) blob. We add
	// this device to the roster, write the blob, and unlock with the new password.
	const joinGroup = useCallback(
		async (pairingCode: string, method: JoinUnlock): Promise<void> => {
			const code = decodePairingCode(pairingCode.trim()); // validate before any prompt
			// Refuse a stale code up front, before a security-key tap or a device-id rotation. The
			// inviter has already torn its side down by now, so proceeding would just hang.
			if (pairingCodeExpired(code)) {
				throw new Error("That pairing code has expired. Generate a new one and try again.");
			}
			// Security-key path: run the PRF create() ceremony FIRST, on this click's
			// fresh user activation, before any await can spend it. One tap; we keep the
			// secret so the offscreen can wrap a webauthn slot and we finish the local
			// unlock without a second tap.
			const cred =
				method.kind === "webauthnKey"
					? await createPrfCredential(method.label ?? "", {
							kind: method.keyKind ?? "platform",
						})
					: undefined;
			// Enter the group as a fresh device: mint a new id first, so a device re-added after being
			// revoked doesn't reuse its old (now-tombstoned) id, which would be dropped everywhere.
			await rotateDeviceId();
			// Build our roster entry up front so we can hand it to the inviter in the ack.
			const ownPub = await shell.syncDevicePublicKey();
			const clock = await ensureClock();
			const hlc = clock.send();
			const ownEntry = await signOwnEntry(shell, {
				id: hlc.node,
				publicKey: ownPub,
				label: shell.deviceLabel?.() ?? defaultDeviceLabel(),
				addedAt: Date.now(),
				hlc,
			});

			const joined = new Promise<{ vaultBlobB64: string; roster: RosterPayload }>(
				(resolve, reject) => {
					const off = shell.onSyncEvent((ev) => {
						if (ev.kind === "joined" && ev.vaultBlobB64 && ev.roster) {
							off();
							resolve({ vaultBlobB64: ev.vaultBlobB64, roster: ev.roster });
						} else if (ev.kind === "join-error") {
							off();
							reject(new Error(ev.message || "Join failed."));
						}
					});
				},
			);
			await shell.startEnrollJoin({
				relayUrl: code.relay,
				iceUrl: code.iceUrl,
				groupKeyB64: code.groupKey,
				psk: code.psk,
				inviterPub: code.inviterPub,
				ownEntry,
				...(cred
					? {
							webauthn: {
								hmacSecretB64: bytesToBase64(cred.hmacSecret),
								credentialIdB64: bytesToBase64(cred.credentialId),
								saltB64: bytesToBase64(cred.salt),
							},
						}
					: { password: method.kind === "password" ? method.password : "" }),
			});
			let vaultBlobB64: string;
			let roster: RosterPayload;
			try {
				({ vaultBlobB64, roster } = await joined);
			} catch (e) {
				// A recoverable failure (e.g. password mismatch): halt the enrollment host so a
				// retry starts clean, then surface the reason to the caller.
				await shell.stopSyncSpike().catch(() => {});
				throw e;
			}
			await storage.writeVaultBlob(base64ToBytes(vaultBlobB64));
			await storage.setMeta(syncKey("sync.group"), {
				groupKey: code.groupKey,
				roster: addDevice(roster, ownEntry),
			});
			await storage.setMeta("sync.relay", code.relay); // background uses this for ongoing sync
			await storage.setMeta("sync.iceUrl", code.iceUrl ?? ""); // adopt the inviter's TURN endpoint
			await shell.stopSyncSpike();

			if (cred) {
				// Unlock with the secret already in hand (the slot the offscreen just minted).
				const { blob } = await readDecodedBlob();
				const slot = findWebauthnSlots(blob)[0];
				if (!slot) throw new Error("Joined vault has no security-key slot.");
				await finishWebauthnUnlock(slot, cred.hmacSecret);
			} else if (method.kind === "password") {
				await unlock(method.password);
			}
		},
		[
			shell,
			storage,
			syncKey,
			ensureClock,
			rotateDeviceId,
			unlock,
			finishWebauthnUnlock,
			readDecodedBlob,
		],
	);

	// Revoke a device: a roster tombstone that ongoing sync gossips to peers (so it
	// drops everywhere), then propagates back. Not a remote wipe — see docs/p2p-sync.md.
	const removeDevice = useCallback(
		async (deviceId: string): Promise<void> => {
			const group = await storage.getMeta<{ groupKey: string; roster: RosterPayload }>(
				syncKey("sync.group"),
			);
			if (!group) return;
			const hlc = (await ensureClock()).send();
			await storage.setMeta(syncKey("sync.group"), {
				groupKey: group.groupKey,
				roster: revokeDevice(group.roster, deviceId, hlc),
			});
		},
		[storage, syncKey, ensureClock],
	);

	return { inviteDevice, joinGroup, removeDevice, ensureOwnEntrySigned };
}
