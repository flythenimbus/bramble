import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createTarget, runBackup } from "../backup";
import {
	applyBackupOutcomes,
	type BackupFrequency,
	type BackupSecrets,
	type BackupTargetConfig,
	backupPrefix,
	backupTargetsKeyFor,
	migrateBackupTargetsToVaults,
	targetPrefixFor,
	toProviderConfig,
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

/**
 * Manual cloud backup across the active vault's device-local targets, each with credentials
 * VEK-wrapped. Targets belong to one vault (`backup.targets:<vaultId>`), so configuring a
 * destination in one vault leaves the others alone (issue #49). Scheduling (Phase 1) rides on
 * top of the same targets. Uploads run in this UI context; on the extension a popup fetch
 * reaches any provider via host permissions. See docs/cloud-storage-backups.md.
 */
export function useBackup() {
	const { storage, crypto, shell } = usePlatform();
	// Targets, credentials and snapshots all belong to the vault the user is currently in.
	const { activeId, vaults, ready } = useVaultRegistry();
	const vaultId = activeId ?? vaults[0]?.id;
	const isDefault = vaultId != null && vaultId === vaults[0]?.id;
	const vaultIds = useMemo(() => vaults.map((v) => v.id), [vaults]);
	// undefined = still loading (or no vault resolved yet).
	const [targets, setTargets] = useState<BackupTargetConfig[] | undefined>(undefined);
	const [runningIds, setRunningIds] = useState<ReadonlySet<string>>(() => new Set());

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

	// Live-refresh when a background scheduled backup rewrites the targets (status/lastError),
	// so an open Settings page reflects it without a reopen. No-op where unsupported (mobile).
	useEffect(
		() =>
			vaultId
				? storage.subscribeMeta?.(backupTargetsKeyFor(vaultId), () => void reload())
				: undefined,
		[storage, reload, vaultId],
	);

	const persist = useCallback(
		async (next: BackupTargetConfig[]) => {
			if (!vaultId) return;
			await storage.setMeta(backupTargetsKeyFor(vaultId), next);
			setTargets(next);
		},
		[storage, vaultId],
	);

	const wrap = useCallback(
		async (secrets: BackupSecrets) => {
			const w = await crypto.encryptWithVek(JSON.stringify(secrets));
			return { iv: w.iv, ciphertext: w.ciphertext };
		},
		[crypto],
	);

	const addTarget = useCallback(
		async (input: SaveTargetInput) => {
			if (!input.secrets) throw new Error("Enter your credentials.");
			const target: BackupTargetConfig = {
				id: newId(),
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
				creds: await wrap(input.secrets),
			};
			await persist([...(targets ?? []), target]);
		},
		[wrap, persist, targets],
	);

	const updateTarget = useCallback(
		async (id: string, input: SaveTargetInput) => {
			const list = targets ?? [];
			const cur = list.find((t) => t.id === id);
			if (!cur) return;
			// A new credential pair re-wraps; omitting them keeps the saved ones.
			const creds = input.secrets ? await wrap(input.secrets) : cur.creds;
			const updated: BackupTargetConfig = {
				...cur,
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
		[wrap, persist, targets],
	);

	const setFrequency = useCallback(
		async (id: string, frequency: BackupFrequency) => {
			await persist((targets ?? []).map((t) => (t.id === id ? { ...t, frequency } : t)));
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
			await persist((targets ?? []).filter((t) => t.id !== id));
		},
		[persist, targets],
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
						const secrets = JSON.parse(
							await crypto.decryptWithVek(t.creds.iv, t.creds.ciphertext),
						) as BackupSecrets;
						const bt = createTarget(toProviderConfig(t, secrets));
						const prefix = targetPrefixFor(t, vaultId ?? "", isDefault);
						const r = await runBackup(bt, blob, { prefix, keep: t.keep });
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
			const byId = new Map(results.map((r) => [r.id, r]));
			await persist(applyBackupOutcomes(list, byId, Date.now()));
			setRunningIds(new Set());
		},
		[targets, storage, crypto, persist, vaultId, isDefault],
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
		// Whether this platform can run the OAuth connect at all (extension yes, mobile no).
		oauthAvailable: Boolean(shell.connectBackupOAuth),
	};
}
