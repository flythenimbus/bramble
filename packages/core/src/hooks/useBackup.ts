import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createTarget, runBackup } from "../backup";
import {
	applyBackupOutcomes,
	type BackupFrequency,
	type BackupSecrets,
	type BackupTargetConfig,
	backupPrefix,
	backupTargetsKeyFor,
	clearBackoff,
	credsAreOsHeld,
	FOREIGN_CREDS_ERROR,
	keyVaultIdFor,
	migrateBackupTargetsToVaults,
	type TargetCreds,
	targetPrefixFor,
	toProviderConfig,
	type WrappedCreds,
} from "../backup/config";
import type { OAuthProviderId } from "../backup/oauth";
import { usePlatform } from "../context/PlatformContext";
import { useVaultRegistry } from "./useVaultRegistry";

export interface SaveTargetInput {
	providerId: string;
	provider: "s3" | "webdav" | "dropbox";
	endpoint?: string;
	region?: string;
	bucket?: string;
	prefix?: string;
	serverUrl?: string;
	path?: string;
	keep?: number; // snapshots to retain (keep-last-N); defaults to 30
	secrets?: BackupSecrets; // omit on edit to keep the saved credentials
}

const newId = () => globalThis.crypto.randomUUID();

// Placeholder secret fields for a target whose credentials the OS holds: its transport
// authenticates, so nothing reads these. toProviderConfig still needs the shape.
const EMPTY_SECRETS = { username: "", password: "" } as const;

/** The single origin a target's credentials belong to, or null when it has no usable one. */
function originOf(t: {
	provider: BackupTargetConfig["provider"];
	endpoint?: string;
	serverUrl?: string;
}): string | null {
	const raw = t.provider === "s3" ? t.endpoint : t.serverUrl;
	try {
		return raw ? new URL(raw).origin : null;
	} catch {
		return null;
	}
}

/**
 * Manual cloud backup across the active vault's device-local targets, each with credentials
 * VEK-wrapped. Targets belong to one vault (`backup.targets:<vaultId>`), so configuring a
 * destination in one vault leaves the others alone (issue #49). Scheduling (Phase 1) rides on
 * top of the same targets. Uploads run in this UI context; on the extension a popup fetch
 * reaches any provider via host permissions. See docs/cloud-storage-backups.md.
 */
export function useBackup() {
	const { storage, crypto, shell, backupCreds } = usePlatform();
	// Targets, credentials and snapshots all belong to the vault the user is currently in.
	const { activeId, vaults, ready } = useVaultRegistry();
	const vaultId = activeId ?? vaults[0]?.id;
	const isDefault = vaultId != null && vaultId === vaults[0]?.id;
	const vaultIds = useMemo(() => vaults.map((v) => v.id), [vaults]);
	// undefined = still loading (or no vault resolved yet).
	const [targets, setTargets] = useState<BackupTargetConfig[] | undefined>(undefined);
	const [runningIds, setRunningIds] = useState<ReadonlySet<string>>(() => new Set());
	// Whether this device can keep a schedule while the vault is locked. Not a setting and not a
	// question: the platform picks the best store it has, and this is only the consequence, which
	// the UI states as behaviour. `noStore` is the one case with a remedy worth offering.
	const [unattended, setUnattended] = useState(false);
	const [noStore, setNoStore] = useState(false);

	useEffect(() => {
		let live = true;
		void (async () => {
			const status = backupCreds
				? await backupCreds.status().catch(() => ({ unattended: false }))
				: { unattended: false };
			if (!live) return;
			setUnattended(status.unattended);
			setNoStore(Boolean(backupCreds) && !status.unattended);
		})();
		return () => {
			live = false;
		};
	}, [backupCreds]);

	// The migration is one-shot per storage, not per read: without this every live-refresh from a
	// background write would re-probe the (by then absent) global keys.
	const migrated = useRef(false);

	const reload = useCallback(async () => {
		if (!ready || !vaultId) return;
		if (!migrated.current) {
			// Hand a pre-per-vault device-global list to every registered vault, once.
			await migrateBackupTargetsToVaults(storage, vaultIds, newId);
			migrated.current = true;
		}
		setTargets((await storage.getMeta<BackupTargetConfig[]>(backupTargetsKeyFor(vaultId))) ?? []);
	}, [storage, ready, vaultId, vaultIds]);

	useEffect(() => {
		void reload();
	}, [reload]);

	const persist = useCallback(
		async (next: BackupTargetConfig[]) => {
			if (!vaultId) return;
			await storage.setMeta(backupTargetsKeyFor(vaultId), next);
			setTargets(next);
		},
		[storage, vaultId],
	);

	// Climb the ladder for targets that were saved when there was nowhere better to put their
	// credentials. Removing the user's choice is what makes this possible: there is no preference
	// to respect, only a best available place, so a target saved on a machine with no credential
	// store moves into one the first time this vault is open while a store answers. The plaintext
	// is in hand anyway (the VEK is right here), so nothing is asked and nothing is shown.
	const upgrading = useRef(false);
	useEffect(() => {
		if (!unattended || !backupCreds || !vaultId || !targets?.length) return;
		const stale = targets.filter((t) => !credsAreOsHeld(t.creds));
		if (stale.length === 0 || upgrading.current) return;
		upgrading.current = true;
		void (async () => {
			try {
				const moved = new Map<string, TargetCreds>();
				for (const t of stale) {
					const origin = originOf(t);
					if (!origin) continue;
					try {
						const secrets = JSON.parse(
							await crypto.decryptWithVek(
								(t.creds as WrappedCreds).iv,
								(t.creds as WrappedCreds).ciphertext,
							),
						) as BackupSecrets;
						await backupCreds.save(vaultId, t.id, secrets, origin);
						moved.set(t.id, { wrap: "os" });
					} catch {
						// A credential that will not unwrap (wrapped under another vault's key, from
						// the device-global era) stays where it is and keeps working as it does.
					}
				}
				if (moved.size > 0) {
					await persist(
						targets.map((t) => (moved.has(t.id) ? { ...t, creds: moved.get(t.id)! } : t)),
					);
				}
			} finally {
				upgrading.current = false;
			}
		})();
	}, [unattended, backupCreds, vaultId, targets, crypto, persist]);

	// Live-refresh when a background scheduled backup rewrites the targets (status/lastError),
	// so an open Settings page reflects it without a reopen. No-op where unsupported (mobile).
	useEffect(
		() =>
			vaultId
				? storage.subscribeMeta?.(backupTargetsKeyFor(vaultId), () => void reload())
				: undefined,
		[storage, reload, vaultId],
	);

	// Where a target's credentials go. The desktop hands them to the OS credential store, which
	// is what lets its scheduler honour a vault's timer while that vault is locked; everywhere
	// else (and on a desktop with no usable store) they are wrapped under the vault key, so a
	// backup can only run while it is unlocked. See adapters/backup-creds.ts.
	const sealFor = useCallback(
		async (
			targetId: string,
			secrets: BackupSecrets,
			input: SaveTargetInput,
		): Promise<TargetCreds> => {
			// The origin the credential is being handed over FOR. A target with no usable one has
			// nothing to pin against, so it takes the vault-key path instead of a looser store.
			const origin = originOf(input);
			if (origin && vaultId && backupCreds && (await backupCreds.status()).unattended) {
				await backupCreds.save(vaultId, targetId, secrets, origin);
				return { wrap: "os" };
			}
			const w = await crypto.encryptWithVek(JSON.stringify(secrets));
			return { iv: w.iv, ciphertext: w.ciphertext };
		},
		[crypto, backupCreds, vaultId],
	);

	const addTarget = useCallback(
		async (input: SaveTargetInput) => {
			if (!input.secrets) throw new Error("Enter your credentials.");
			const id = newId();
			const target: BackupTargetConfig = {
				id,
				providerId: input.providerId,
				provider: input.provider,
				endpoint: input.endpoint,
				region: input.region,
				bucket: input.bucket,
				prefix: input.prefix,
				serverUrl: input.serverUrl,
				path: input.path,
				frequency: "daily",
				keep: input.keep ?? 30,
				creds: await sealFor(id, input.secrets, input),
			};
			await persist([...(targets ?? []), target]);
		},
		[sealFor, persist, targets],
	);

	const updateTarget = useCallback(
		async (id: string, input: SaveTargetInput) => {
			const list = targets ?? [];
			const cur = list.find((t) => t.id === id);
			if (!cur) return;
			// A new credential pair re-seals; omitting them keeps the saved ones.
			const creds = input.secrets ? await sealFor(id, input.secrets, input) : cur.creds;
			// clearBackoff first: an edit is usually the fix for whatever was failing, and a
			// corrected credential that sits out the accumulated backoff looks like it did not work.
			const updated: BackupTargetConfig = {
				...clearBackoff(cur),
				providerId: input.providerId,
				provider: input.provider,
				endpoint: input.endpoint,
				region: input.region,
				bucket: input.bucket,
				prefix: input.prefix,
				serverUrl: input.serverUrl,
				path: input.path,
				keep: input.keep ?? cur.keep,
				creds,
			};
			// Picking a folder makes this vault's choice explicit, so the target stops deriving one
			// from the old shared layout. Any other edit leaves it alone: silently dropping the
			// suffix would move a non-default vault's snapshots on top of the default vault's.
			if (cur.sharedFolder && backupPrefix(updated) !== backupPrefix(cur)) {
				updated.sharedFolder = undefined;
			}
			await persist(list.map((t) => (t.id === id ? updated : t)));
		},
		[sealFor, persist, targets],
	);

	const setFrequency = useCallback(
		async (id: string, frequency: BackupFrequency) => {
			// Also clears the backoff: reaching for the frequency of a failing target is the other
			// way a user says "try this again", and off -> daily should not wait one out.
			await persist(
				(targets ?? []).map((t) => (t.id === id ? { ...clearBackoff(t), frequency } : t)),
			);
		},
		[persist, targets],
	);

	// Connect a one-click OAuth provider. The extension runs the whole flow (interactive
	// sign-in, token exchange, VEK-wrap, persist) in its background service worker so it
	// survives the popup closing when the provider window steals focus; we just trigger it
	// and reload. `targetId` reconnects an existing target instead of adding one.
	const connectOAuth = useCallback(
		async (oauthId: OAuthProviderId, opts?: { targetId?: string }) => {
			if (!shell.connectBackupOAuth) throw new Error("One-click sign-in isn't available here.");
			await shell.connectBackupOAuth(oauthId, opts);
			await reload();
		},
		[shell, reload],
	);

	const removeTarget = useCallback(
		async (id: string) => {
			// Erase the OS-held credential too, or it outlives the target that named it.
			if (vaultId) await backupCreds?.remove(vaultId, id).catch(() => {});
			await persist((targets ?? []).filter((t) => t.id !== id));
		},
		[persist, targets, backupCreds, vaultId],
	);

	// Back up to one target (id given) or all of them. Reads the vault blob once and
	// runs the targets concurrently; each records its own success/failure.
	const backupNow = useCallback(
		async (id?: string) => {
			const list = targets ?? [];
			const toRun = id ? list.filter((t) => t.id === id) : list;
			if (toRun.length === 0) return;
			// This vault's own targets: read its blob and place snapshots in its own folder,
			// matching where scheduled backups put this vault.
			const blob = await storage.readVaultBlob(vaultId);
			setRunningIds(new Set(toRun.map((t) => t.id)));
			const results = await Promise.all(
				toRun.map(async (t) => {
					try {
						// OS-held credentials never come back here: the platform's transport
						// authenticates in its own process (desktop). Otherwise unwrap with the VEK.
						const creds = t.creds;
						// A failure here is one specific thing often enough to be worth naming: the
						// credential belongs to another vault (the device-global list put one target
						// in every vault, sealed under whichever entered it). The scheduled runner
						// works around that by trying the other unlocked vaults' keys, which this
						// path cannot reach, so it reports the situation instead of surfacing
						// `aes decrypt: aead::Error` to somebody who can do nothing with it.
						let secrets: BackupSecrets;
						if (credsAreOsHeld(creds)) {
							secrets = EMPTY_SECRETS;
						} else {
							try {
								secrets = JSON.parse(
									await crypto.decryptWithVek(creds.iv, creds.ciphertext),
								) as BackupSecrets;
							} catch {
								throw new Error(FOREIGN_CREDS_ERROR);
							}
						}
						// Which transport, if any. Where the platform cannot reach a provider from
						// this process at all (the desktop's webview has no CORS grant), BOTH cases
						// have to route through it: the stored-credential one, and the one where we
						// just unwrapped the secret ourselves. Undefined here means the platform can
						// simply fetch, which is the extension and mobile.
						const bt = createTarget(
							toProviderConfig(t, secrets),
							credsAreOsHeld(creds) && vaultId
								? backupCreds?.transport(vaultId, t)
								: backupCreds?.transportWithSecrets(t, secrets),
						);
						const prefix = targetPrefixFor(t, vaultId ?? "", isDefault);
						const r = await runBackup(bt, blob, {
							prefix,
							keep: t.keep,
							vaultId: keyVaultIdFor(t, vaultId ?? ""),
						});
						return {
							id: t.id,
							hash: r.hash as string | undefined,
							error: undefined as string | undefined,
						};
					} catch (e) {
						return { id: t.id, hash: undefined, error: (e as Error).message };
					}
				}),
			);
			// Re-read before folding, as the scheduled runner does: an upload takes a while, and
			// the list can have changed under it (a target removed here, or run state stamped by
			// the scheduler). Folding into the pre-run copy would put the stale one back, and
			// would resurrect a target whose credentials have already been erased.
			const byId = new Map(results.map((r) => [r.id, r]));
			const latest = vaultId
				? ((await storage.getMeta<BackupTargetConfig[]>(backupTargetsKeyFor(vaultId))) ?? list)
				: list;
			await persist(applyBackupOutcomes(latest, byId, Date.now()));
			setRunningIds(new Set());
		},
		[targets, storage, crypto, persist, vaultId, isDefault, backupCreds],
	);

	// The folder this vault's snapshots actually land in for a target, so the UI can show a
	// migrated target's derived folder instead of the (different) one in its config.
	const folderFor = useCallback(
		(t: BackupTargetConfig) => targetPrefixFor(t, vaultId ?? "", isDefault),
		[vaultId, isDefault],
	);

	return {
		targets,
		runningIds,
		addTarget,
		updateTarget,
		setFrequency,
		removeTarget,
		backupNow,
		connectOAuth,
		folderFor,
		/** Several vaults exist, so the UI should say which one these targets belong to. */
		multiVault: vaults.length > 1,
		/** New credentials go to the OS credential store, so backups run while locked (desktop). */
		/** This device can keep a schedule while the vault is locked. */
		unattended,
		/** ...and it cannot, because nothing here can hold a credential outside the vault. The one
		 * degraded case with a remedy, so the UI offers it instead of a warning. */
		noStore,
		/** Whether this target in particular backs up on schedule, or waits for an unlock. */
		runsWhileLocked: (t: BackupTargetConfig) => credsAreOsHeld(t.creds),
		// Whether this platform can run the OAuth connect at all (extension yes, mobile no).
		oauthAvailable: Boolean(shell.connectBackupOAuth),
	};
}
