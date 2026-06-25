import { useCallback, useRef } from "react";
import { usePlatform } from "../context/PlatformContext";
import {
	addDevice,
	decodePairingCode,
	type EntriesPayload,
	emptyRoster,
	encodePairingCode,
	type HybridClock,
	type RosterEntry,
	RosterEntrySchema,
	type RosterPayload,
	randomKeyB64,
	revokeDevice,
} from "../sync";
import { base64ToBytes, bytesToBase64 } from "../util/bytes";
import { defaultDeviceLabel } from "../util/device-label";
import { createPrfCredential } from "../vault/webauthn-ceremony";
import { findWebauthnSlots, type VaultBlob, type WebauthnSlot } from "../vault-format";
import type { JoinUnlock, UseVault } from "./useVault";

/** Shared vault internals the enrollment ops need from VaultProvider. */
export interface SyncEnrollmentDeps {
	ensureClock: () => Promise<HybridClock>;
	readDecodedBlob: () => Promise<{ blob: VaultBlob }>;
	unlock: (password: string) => Promise<void>;
	/** Finish a security-key unlock with an in-hand PRF secret (no extra tap). */
	finishWebauthnUnlock: (slot: WebauthnSlot, hmacSecret: Uint8Array) => Promise<void>;
	/** Decrypt the on-disk entries payload (the inviter ships it in the bundle). */
	readEntriesPayload: () => Promise<EntriesPayload>;
}

type SyncEnrollment = Pick<UseVault, "inviteDevice" | "joinGroup" | "removeDevice">;

/**
 * Device enrollment (create group / invite / join), lifted out of VaultProvider.
 * Owns its enrollment-listener ref; the shared clock, blob read, unlock, and
 * entries-payload read are passed in. See docs/p2p-sync.md.
 */
export function useSyncEnrollment(deps: SyncEnrollmentDeps): SyncEnrollment {
	const { ensureClock, readDecodedBlob, unlock, finishWebauthnUnlock, readEntriesPayload } = deps;
	const { storage, shell } = usePlatform();
	// Unsubscribe for the inviter's enrolled-device listener (adds the joiner to the roster).
	const enrollUnsubRef = useRef<(() => void) | null>(null);

	// The group key is stable (the room + the group identity); generated once with a
	// roster seeded by this device, then reused. This vault's VEK is the group VEK.
	const ensureGroup = useCallback(async (): Promise<string> => {
		const existing = await storage.getMeta<{ groupKey: string }>("sync.group");
		if (existing?.groupKey) return existing.groupKey;
		const inviterPub = await shell.syncDevicePublicKey();
		const clock = await ensureClock();
		const hlc = clock.send();
		const groupKey = randomKeyB64();
		const roster = addDevice(emptyRoster(), {
			id: hlc.node,
			publicKey: inviterPub,
			label: defaultDeviceLabel(),
			addedAt: Date.now(),
			hlc,
		});
		await storage.setMeta("sync.group", { groupKey, roster });
		return groupKey;
	}, [storage, shell, ensureClock]);

	// Generate a fresh one-time pairing code and start listening for a device to
	// join. The code carries no vault secrets (groupKey + our pubkey + PSK + relay).
	const inviteDevice = useCallback(
		async (relayUrl: string, iceUrl?: string): Promise<string> => {
			await storage.requestVaultAccess(); // grant FSA permission within this click gesture
			// Persist + propagate (via the pairing code) both relays so a joiner adopts them.
			await storage.setMeta("sync.relay", relayUrl);
			await storage.setMeta("sync.iceUrl", iceUrl ?? "");
			const groupKey = await ensureGroup();
			const inviterPub = await shell.syncDevicePublicKey();
			const psk = randomKeyB64();
			const group = await storage.getMeta<{ roster: RosterPayload }>("sync.group");
			const roster = group?.roster ?? emptyRoster();
			const entries = await readEntriesPayload();
			// When the device finishes joining, add its roster entry to ours (symmetric rosters).
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
					const cur = await storage.getMeta<{ groupKey: string; roster: RosterPayload }>(
						"sync.group",
					);
					if (!cur) return;
					await storage.setMeta("sync.group", {
						groupKey: cur.groupKey,
						roster: addDevice(cur.roster, entry),
					});
					enrollUnsubRef.current?.();
					enrollUnsubRef.current = null;
				})();
			});
			await shell.startEnrollInvite({
				relayUrl,
				iceUrl,
				groupKeyB64: groupKey,
				psk,
				roster,
				entries,
			});
			// Omit iceUrl from the code when empty (the joiner then derives it from the relay).
			return encodePairingCode({
				v: 1,
				groupKey,
				inviterPub,
				psk,
				relay: relayUrl,
				iceUrl: iceUrl || undefined,
			});
		},
		[ensureGroup, shell, storage, readEntriesPayload],
	);

	// Join from a pairing code: the offscreen runs the handshake and rebuilds the
	// vault around the shared VEK, then hands back the (VEK-wrapped) blob. We add
	// this device to the roster, write the blob, and unlock with the new password.
	const joinGroup = useCallback(
		async (pairingCode: string, method: JoinUnlock): Promise<void> => {
			const code = decodePairingCode(pairingCode.trim()); // validate before any prompt
			// Security-key path: run the PRF create() ceremony FIRST, on this click's
			// fresh user activation, before any await can spend it. One tap; we keep the
			// secret so the offscreen can wrap a webauthn slot and we finish the local
			// unlock without a second tap.
			const cred =
				method.kind === "securityKey" ? await createPrfCredential(method.label ?? "") : undefined;
			await storage.requestVaultAccess(); // grant FSA permission (no-op on local storage)
			// Build our roster entry up front so we can hand it to the inviter in the ack.
			const ownPub = await shell.syncDevicePublicKey();
			const clock = await ensureClock();
			const hlc = clock.send();
			const ownEntry: RosterEntry = {
				id: hlc.node,
				publicKey: ownPub,
				label: defaultDeviceLabel(),
				addedAt: Date.now(),
				hlc,
			};

			const joined = new Promise<{ vaultBlobB64: string; roster: RosterPayload }>((resolve) => {
				const off = shell.onSyncEvent((ev) => {
					if (ev.kind === "joined" && ev.vaultBlobB64 && ev.roster) {
						off();
						resolve({ vaultBlobB64: ev.vaultBlobB64, roster: ev.roster });
					}
				});
			});
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
			const { vaultBlobB64, roster } = await joined;
			await storage.writeVaultBlob(base64ToBytes(vaultBlobB64));
			await storage.setMeta("sync.group", {
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
		[shell, storage, ensureClock, unlock, finishWebauthnUnlock, readDecodedBlob],
	);

	// Revoke a device: a roster tombstone that ongoing sync gossips to peers (so it
	// drops everywhere), then propagates back. Not a remote wipe — see docs/p2p-sync.md.
	const removeDevice = useCallback(
		async (deviceId: string): Promise<void> => {
			const group = await storage.getMeta<{ groupKey: string; roster: RosterPayload }>(
				"sync.group",
			);
			if (!group) return;
			const hlc = (await ensureClock()).send();
			await storage.setMeta("sync.group", {
				groupKey: group.groupKey,
				roster: revokeDevice(group.roster, deviceId, hlc),
			});
		},
		[storage, ensureClock],
	);

	return { inviteDevice, joinGroup, removeDevice };
}
